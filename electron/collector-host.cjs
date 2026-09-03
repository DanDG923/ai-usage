'use strict';

// Main-process side of the collector utility process: spawns it on demand,
// correlates replies by id, and fails every in-flight request if the child
// dies so a refresh can never hang on a process that is no longer there.

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

function createCollectorHost({ fork, modulePath, config, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, onLog = () => {} }) {
  let child = null;
  let nextId = 1;
  const pending = new Map();

  // Fail the in-flight requests of one child (or of every child when no
  // owner is given). A recycled child's late exit event must not reject a
  // request that was already registered against its replacement.
  function failAll(error, owner = null) {
    for (const [id, entry] of pending) {
      if (owner && entry.child !== owner) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  }

  function spawn() {
    const spawned = fork(modulePath, [JSON.stringify(config)], { serviceName: 'AI Usage collectors' });
    spawned.on('message', (message) => {
      const entry = pending.get(message?.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error?.message || 'Collector request failed.'));
    });
    spawned.on('exit', (code) => {
      if (child === spawned) child = null;
      onLog(`Collector process exited with code ${code}.`);
      failAll(new Error(`The collector process stopped unexpectedly (code ${code}).`), spawned);
    });
    child = spawned;
  }

  function request(type, payload = {}) {
    if (!child) spawn();
    const target = child;
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
      }
    });
  }

  function stop() {
    const current = child;
    child = null;
    if (!current) return;
    try { current.kill(); } catch { /* Already gone. */ }
    failAll(new Error('The collector process was stopped.'), current);
  }

  return {
    refreshAll: () => request('refresh-all'),
    refreshClaude: () => request('refresh-claude'),
    request,
    stop,
    get running() { return Boolean(child); },
  };
}

// The same surface over an in-process service, for environments without
// utility processes (tests, or AI_USAGE_INLINE_COLLECTORS=1 for debugging).
function createInlineCollectorHost(service) {
  return {
    refreshAll: () => service.handle({ type: 'refresh-all' }),
    refreshClaude: () => service.handle({ type: 'refresh-claude' }),
    request: (type, payload = {}) => service.handle({ type, ...payload }),
    stop: () => service.close(),
    get running() { return true; },
  };
}

module.exports = { createCollectorHost, createInlineCollectorHost };
