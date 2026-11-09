'use strict';

// Main-process side of the collector utility process: spawns it on demand,
// correlates replies by id, and fails every in-flight request if the child
// dies so a refresh can never hang on a process that is no longer there.

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** @typedef {import('electron').UtilityProcess} UtilityProcess */
/** @typedef {import('electron').ForkOptions} ForkOptions */
/** @typedef {import('./collector-service.cjs').CollectorMessage} CollectorMessage */
/** @typedef {import('./collector-service.cjs').CollectorReply} CollectorReply */
/** @typedef {import('./collector-service.cjs').SettledOutcome} SettledOutcome */

/**
 * A request waiting for its reply, and the child it was sent to.
 *
 * @typedef {object} PendingRequest
 * @property {(result: unknown) => void} resolve
 * @property {(error: unknown) => void} reject
 * @property {NodeJS.Timeout} timer
 * @property {UtilityProcess} child
 */

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
  /** @type {UtilityProcess | null} */
  let child = null;
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  let nextId = 1;
  /** @type {Map<number, PendingRequest>} */
  const pending = new Map();
  // Children asked to close: the id of that request, and the timer that
  // ends a child which does not answer it.
  /** @type {Map<UtilityProcess, { id: number, timer: NodeJS.Timeout }>} */
  const retiring = new Map();

  /** @param {UtilityProcess} target */
  function finishRetirement(target) {
    clearTimeout(retiring.get(target)?.timer);
    retiring.delete(target);
    try { target.kill(); } catch { /* Already gone. */ }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!child || pending.size || !(idleTimeoutMs > 0)) return;
    const target = child;
    idleTimer = setTimeout(() => {
      if (child !== target || pending.size) return;
      // Detach before asking it to close: a new refresh gets a fresh child,
      // never a connection which is already being closed. No work is pending.
      child = null;
      const id = nextId++;
      const timer = setTimeout(() => finishRetirement(target), 5_000);
      timer.unref?.();
      retiring.set(target, { id, timer });
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        target.postMessage({ id, type: 'close', payload: {} });
      } catch { finishRetirement(target); }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // Fail the in-flight requests of one child (or of every child when no
  // owner is given). A recycled child's late exit event must not reject a
  // request that was already registered against its replacement.
  /**
   * @param {Error} error
   * @param {UtilityProcess | null} [owner]
   */
  function failAll(error, owner = /** @type {UtilityProcess | null} */ (null)) {
    for (const [id, entry] of pending) {
      if (owner && entry.child !== owner) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  }

  function spawn() {
    const spawned = fork(modulePath, [JSON.stringify(config)], { serviceName: 'AI Usage collectors', ...forkOptions });
    spawned.on('message', (/** @type {CollectorReply} */ message) => {
      if (retiring.get(spawned)?.id === message?.id) {
        finishRetirement(spawned);
        return;
      }
      const entry = pending.get(message?.id);
      if (!entry || entry.child !== spawned) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error?.message || 'Collector request failed.'));
      scheduleIdle();
    });
    // A fatal V8 error (such as running out of memory) is reported here before
    // the exit below fails the child's requests. An EventEmitter 'error' with no
    // listener would throw in the main process instead.
    spawned.on('error', (type, location) => {
      onLog(`Collector process error: ${type}${location ? ` at ${location}` : ''}.`);
    });
    spawned.on('exit', (code) => {
      if (child === spawned) child = null;
      clearTimeout(retiring.get(spawned)?.timer);
      retiring.delete(spawned);
      onLog(`Collector process exited with code ${code}.`);
      failAll(new Error(`The collector process stopped unexpectedly (code ${code}).`), spawned);
    });
    child = spawned;
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} [payload]
   * @returns {Promise<any>} the reply's result, whose shape depends on the type
   */
  function request(type, payload = {}) {
    clearTimeout(idleTimer);
    if (!child) spawn();
    // spawn() has just set it if it was empty.
    const target = /** @type {UtilityProcess} */ (child);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for the collector process (${type}).`));
        // A request that never answers is a stuck child; recycle it.
        if (child === target) stop();
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, child: target });
      try {
        // A UtilityProcess port, not a window: there is no target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        target.postMessage({ id, type, payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
        scheduleIdle();
      }
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    for (const target of retiring.keys()) finishRetirement(target);
    const current = child;
    child = null;
    if (!current) return;
    try { current.kill(); } catch { /* Already gone. */ }
    failAll(new Error('The collector process was stopped.'), current);
  }

  return {
    // Claude plan usage is read only when the caller explicitly asks; a
    // Claude-only refresh never reads it.
    refreshAll: ({ readPlanUsage = false } = {}) => request('refresh-all', { readPlanUsage: readPlanUsage === true }),
    refreshClaude: () => request('refresh-claude', { readPlanUsage: false }),
    request,
    stop,
    get running() { return Boolean(child); },
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
