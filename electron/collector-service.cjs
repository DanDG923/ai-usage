'use strict';

// The collectors run here, in a utility process, so a slow transcript scan or a
// wedged provider call never blocks the main process that owns the window,
// the tray, and every IPC handler. This process opens its own connection to
// the same SQLite file; WAL mode and the busy timeout make the two connections
// safe together, and the main process simply reads after it is told to.

const { UsageStore } = require('./store.cjs');
const { refreshCodex } = require('./codex-collector.cjs');
const { refreshClaude } = require('./claude-collector.cjs');
const { runCollectors } = require('./collector-runner.cjs');
const { CLAUDE, CODEX } = require('./providers.mjs');

/** @typedef {import('./store.cjs').Store} Store */
/** @typedef {import('./providers.mjs').CollectorId} CollectorId */

/**
 * Where the collectors read and write. The host passes this to the process
 * as its one argument.
 *
 * @typedef {object} CollectorConfig
 * @property {string} databasePath
 * @property {string} backupDirectory
 * @property {string} inboxPath the status-line helper's inbox
 * @property {string | null} [claudeCodeReadingsDirectory] where the Claude Code mod leaves its readings
 */

// The protocol between the host and this process is the shared one: a request
// carries an id; its reply carries the same id and either a result or an
// error message.
/** @typedef {import('./process-protocol.cjs').RequestEnvelope} RequestEnvelope */
/** @typedef {import('./process-protocol.cjs').ReplyEnvelope} ReplyEnvelope */

/**
 * A request as the service handles it: its type, with the payload's fields
 * beside it.
 *
 * @typedef {{ type: string, readPlanUsage?: boolean }} CollectorRequest
 */

/**
 * One collector's outcome as it crosses to the main process: what
 * Promise.allSettled reports, with a failure reduced to its message.
 *
 * @typedef {{ status: 'fulfilled', value: Record<string, unknown> } | { status: 'rejected', reason: { message: string } }} SettledOutcome
 */

/**
 * A collection waiting for its turn, and the options it will start with.
 *
 * @typedef {{ options: { readPlanUsage: boolean }, promise: Promise<Record<string, unknown>> }} QueuedRun
 */

/**
 * @param {PromiseSettledResult<Record<string, unknown>>} entry
 * @returns {SettledOutcome}
 */
function serializeSettled(entry) {
  if (entry.status === 'fulfilled') return { status: 'fulfilled', value: entry.value };
  const reason = entry.reason;
  return {
    status: 'rejected',
    reason: { message: reason instanceof Error ? reason.message : String(reason || 'Unknown local error.') },
  };
}

/**
 * @param {object} config
 * @param {string} config.databasePath
 * @param {string} config.backupDirectory
 * @param {string} config.inboxPath
 * @param {string | null} [config.claudeCodeReadingsDirectory]
 * @param {{ codex: typeof refreshCodex, claude: typeof refreshClaude }} [config.collectors]
 * @param {(database: string, backups: string) => Store} [config.openStore]
 */
function createCollectorService({
  databasePath,
  backupDirectory,
  inboxPath,
  claudeCodeReadingsDirectory = /** @type {string | null} */ (null),
  collectors = { codex: refreshCodex, claude: refreshClaude },
  openStore = (database, backups) => new UsageStore(database, backups),
}) {
  /** @type {Store | null} */
  let store = null;
  const getStore = () => (store ??= openStore(databasePath, backupDirectory));

  // Requests arrive concurrently (a scheduled refresh-all can overlap a manual
  // observation's refresh-claude), but each source's collector must not run
  // against itself: two SDK control queries and two transcript scans over the
  // same files at once waste work and race on the cursor. Sources share a
  // lane; waiting requests for the same source share their result.
  //
  // One entry per collector the provider registry names. The two collectors
  // are started by hand below because they are not alike: only Claude's takes
  // the status-line inbox, and only Claude's reads plan usage, and then only
  // when a person asked for it.
  let queue = Promise.resolve();
  /** @type {Record<CollectorId, QueuedRun | null>} */
  const pending = { codex: null, claude: null };
  /**
   * @param {CollectorId} source
   * @param {(options: { readPlanUsage: boolean }) => Promise<Record<string, unknown>>} run
   * @param {{ readPlanUsage?: boolean }} [options]
   */
  function queued(source, run, { readPlanUsage = false } = {}) {
    // Coalesce waiting requests, but preserve one follow-up when a request
    // arrives during an active scan. Serial sources prevent a synchronous
    // transcript import from starving another provider's initialization timer.
    const waiting = pending[source];
    if (waiting) {
      // A run that has not started yet reads its options when it starts, so a
      // user's request to read plan usage is never swallowed by an automatic
      // run it joins. A run already executing is never changed.
      if (readPlanUsage === true) waiting.options.readPlanUsage = true;
      return waiting.promise;
    }
    // The promise is set two lines down, once `start` exists to be queued.
    const entry = { options: { readPlanUsage: readPlanUsage === true }, promise: /** @type {QueuedRun['promise']} */ (/** @type {unknown} */ (null)) };
    const start = () => { pending[source] = null; return run({ ...entry.options }); };
    entry.promise = queue.then(start, start);
    pending[source] = entry;
    queue = entry.promise.then(() => undefined, () => undefined);
    return entry.promise;
  }
  const runCodex = () => queued(CODEX.collector, () => collectors.codex(getStore()));
  /** @param {boolean} readPlanUsage */
  const runClaude = (readPlanUsage) => queued(
    CLAUDE.collector,
    (options) => collectors.claude(getStore(), inboxPath, { readPlanUsage: options.readPlanUsage, claudeCodeReadingsDirectory }),
    { readPlanUsage },
  );

  /** @param {CollectorRequest} request */
  async function handle(request) {
    switch (request?.type) {
      case 'refresh-all': {
        // Only an explicit user refresh sets this; anything else is false.
        const readPlanUsage = request.readPlanUsage === true;
        const outcomes = await runCollectors({ codex: runCodex, claude: () => runClaude(readPlanUsage) });
        return { codex: serializeSettled(outcomes.codex), claude: serializeSettled(outcomes.claude) };
      }
      case 'refresh-claude': {
        // A Claude-only refresh follows a local change and never reads plan usage.
        const outcomes = await runCollectors({ claude: () => runClaude(false) });
        return { claude: serializeSettled(outcomes.claude) };
      }
      case 'ping':
        return { ok: true };
      case 'close':
        await queue;
        close();
        return { closed: true };
      default:
        throw new Error(`Unknown collector request: ${String(request?.type)}`);
    }
  }

  function close() {
    if (!store) return;
    try { store.close(); } catch { /* A closed handle is the goal either way. */ }
    store = null;
  }

  return { handle, close };
}

// Wire a service to Electron's parent port. Each request carries an id; each
// reply carries the same id and either a structured-clone-safe result or a
// plain error message.
/**
 * @param {import('electron').ParentPort & { start?: () => void }} port Electron's parent port, or a stand-in that has to be started
 * @param {{ handle: (request: CollectorRequest) => Promise<unknown> }} service
 */
function serveParentPort(port, service) {
  /** @param {ReplyEnvelope} reply */
  const answer = (reply) => port.postMessage(reply);
  port.on('message', async (event) => {
    // The host in this app wrote the message; handle() refuses a type it does not know.
    const { id, type, payload } = /** @type {RequestEnvelope} */ (event?.data || {});
    try {
      // The type is written last: a field of the payload never chooses the operation.
      const result = await service.handle({ ...payload, type });
      answer({ id, ok: true, result });
    } catch (error) {
      answer({ id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  if (typeof port.start === 'function') port.start();
}

if (process.parentPort) {
  /** @type {any} What the host passed: paths only, checked by the service. */
  let config = {};
  try {
    config = JSON.parse(process.argv[2] || '{}');
  } catch {
    config = {};
  }
  serveParentPort(process.parentPort, createCollectorService(config));
}

module.exports = { createCollectorService, serializeSettled, serveParentPort };
