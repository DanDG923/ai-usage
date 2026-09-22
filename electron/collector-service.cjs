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

function serializeSettled(entry) {
  if (entry.status === 'fulfilled') return { status: 'fulfilled', value: entry.value };
  const reason = entry.reason;
  return {
    status: 'rejected',
    reason: { message: reason instanceof Error ? reason.message : String(reason || 'Unknown local error.') },
  };
}

function createCollectorService({
  databasePath,
  backupDirectory,
  inboxPath,
  collectors = { codex: refreshCodex, claude: refreshClaude },
  openStore = (database, backups) => new UsageStore(database, backups),
}) {
  let store = null;
  const getStore = () => (store ??= openStore(databasePath, backupDirectory));

  // Requests arrive concurrently (a scheduled refresh-all can overlap a manual
  // observation's refresh-claude), but each source's collector must not run
  // against itself: two SDK control queries and two transcript scans over the
  // same files at once waste work and race on the cursor. Sources share a
  // lane; waiting requests for the same source share their result.
  let queue = Promise.resolve();
  const pending = { codex: null, claude: null };
  function queued(source, run) {
    // Coalesce waiting requests, but preserve one follow-up when a request
    // arrives during an active scan. Serial sources prevent a synchronous
    // transcript import from starving another provider's initialization timer.
    if (pending[source]) return pending[source];
    const start = () => { pending[source] = null; return run(); };
    const next = queue.then(start, start);
    pending[source] = next;
    queue = next.then(() => undefined, () => undefined);
    return next;
  }
  const runCodex = () => queued('codex', () => collectors.codex(getStore()));
  const runClaude = () => queued('claude', () => collectors.claude(getStore(), inboxPath));

  async function handle(request) {
    switch (request?.type) {
      case 'refresh-all': {
        const outcomes = await runCollectors({ codex: runCodex, claude: runClaude });
        return { codex: serializeSettled(outcomes.codex), claude: serializeSettled(outcomes.claude) };
      }
      case 'refresh-claude': {
        const outcomes = await runCollectors({ claude: runClaude });
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
function serveParentPort(port, service) {
  port.on('message', async (event) => {
    const { id, type, payload } = event?.data || {};
    try {
      const result = await service.handle({ type, ...payload });
      port.postMessage({ id, ok: true, result });
    } catch (error) {
      port.postMessage({ id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  if (typeof port.start === 'function') port.start();
}

if (process.parentPort) {
  let config = {};
  try {
    config = JSON.parse(process.argv[2] || '{}');
  } catch {
    config = {};
  }
  serveParentPort(process.parentPort, createCollectorService(config));
}

module.exports = { createCollectorService, serializeSettled, serveParentPort };
