'use strict';

// Main-process side of the collector utility process: spawns it on demand,
// correlates replies by id, and fails every in-flight request if the child
// dies so a refresh can never hang on a process that is no longer there.
// The protocol itself is the shared one in process-host.cjs; this module says
// how a utility process is started, reached and stopped.

const { createProcessHost } = require('./process-host.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// A released child closes its store and answers; one that does not is ended.
const RETIRE_TIMEOUT_MS = 5_000;

/** @typedef {import('electron').UtilityProcess} UtilityProcess */
/** @typedef {import('electron').ForkOptions} ForkOptions */
/** @typedef {import('./collector-service.cjs').SettledOutcome} SettledOutcome */

/**
 * What the main process holds: the collectors, wherever they run.
 *
 * @typedef {object} CollectorHost
 * @property {(options?: { readPlanUsage?: boolean }) => Promise<{ codex: SettledOutcome, claude: SettledOutcome }>} refreshAll
 * @property {() => Promise<{ claude: SettledOutcome }>} refreshClaude
 * @property {(type: string, payload?: Record<string, unknown>) => Promise<any>} request resolves with the reply's result, whose shape depends on the type
 * @property {() => void} stop
 * @property {boolean} running
 */

/**
 * @param {object} options
 * @param {(modulePath: string, args: string[], options: ForkOptions) => UtilityProcess} options.fork
 * @param {string} options.modulePath
 * @param {import('./collector-service.cjs').CollectorConfig} options.config
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.idleTimeoutMs]
 * @param {ForkOptions} [options.forkOptions]
 * @param {(message: string) => void} [options.onLog]
 * @returns {CollectorHost}
 */
function createCollectorHost({ fork, modulePath, config, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, forkOptions = {}, onLog = /** @type {(message: string) => void} */ (() => {}) }) {
  const host = createProcessHost({
    name: 'Collector process',
    spawn: () => fork(modulePath, [JSON.stringify(config)], { serviceName: 'AI Usage collectors', ...forkOptions }),
    listen(child, events) {
      child.on('message', events.reply);
      // A fatal V8 error (such as running out of memory) is reported here before
      // the exit below fails the child's requests. An EventEmitter 'error' with no
      // listener would throw in the main process instead.
      child.on('error', (type, location) => {
        onLog(`Collector process error: ${type}${location ? ` at ${location}` : ''}.`);
      });
      child.on('exit', events.exited);
    },
    // A UtilityProcess port, not a window: there is no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    send: (child, message) => child.postMessage(message),
    stop: (child) => { child.kill(); },
    log: onLog,
    exitLog: (code) => `Collector process exited with code ${code}.`,
    errors: {
      timedOut: (type) => new Error(`Timed out waiting for the collector process (${type}).`),
      exited: (code) => new Error(`The collector process stopped unexpectedly (code ${code}).`),
      stopped: () => new Error('The collector process was stopped.'),
      closing: () => new Error('The collector process is closing.'),
      failed: 'Collector request failed.',
    },
    // Every request is timed, a close asked for by a caller included, and a
    // request still waiting keeps its timer alive.
    requestTimeoutMs: () => requestTimeoutMs,
    unrefRequestTimers: false,
    // The request that was not answered fails as timed out; the child is then
    // stopped, which fails its other requests as stopped.
    onTimeout: 'stop',
    spawnFailure: 'throw',
    idleAfterSendFailure: true,
    idleTimeoutMs,
    retireGraceMs: RETIRE_TIMEOUT_MS,
    // The utility process does not exit once its store is closed, so it is
    // ended as soon as it says the store is closed.
    stopOnCloseReply: true,
    retirePayload: {},
  });

  return {
    // Claude plan usage is read only when the caller explicitly asks; a
    // Claude-only refresh never reads it.
    refreshAll: ({ readPlanUsage = false } = {}) => host.request('refresh-all', { readPlanUsage: readPlanUsage === true }),
    refreshClaude: () => host.request('refresh-claude', { readPlanUsage: false }),
    request: host.request,
    stop: host.stop,
    get running() { return host.running; },
  };
}

// The same surface over an in-process service, for environments without
// utility processes (tests, or AI_USAGE_INLINE_COLLECTORS=1 for debugging).
/**
 * @param {ReturnType<typeof import('./collector-service.cjs').createCollectorService>} service
 * @returns {CollectorHost}
 */
function createInlineCollectorHost(service) {
  return {
    // handle() is typed with the result of every request. It answers
    // refresh-all with both outcomes and refresh-claude with Claude's.
    refreshAll: ({ readPlanUsage = false } = {}) => /** @type {ReturnType<CollectorHost['refreshAll']>} */ (service.handle({ type: 'refresh-all', readPlanUsage: readPlanUsage === true })),
    refreshClaude: () => /** @type {ReturnType<CollectorHost['refreshClaude']>} */ (service.handle({ type: 'refresh-claude', readPlanUsage: false })),
    request: (type, payload = {}) => service.handle({ type, ...payload }),
    stop: () => service.close(),
    get running() { return true; },
  };
}

module.exports = { createCollectorHost, createInlineCollectorHost };
