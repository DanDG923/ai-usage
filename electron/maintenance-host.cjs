'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// Restores and desktop imports are bounded by the 64 MB export cap; a backup
// of a large ledger onto a slow disk is the longest legitimate job.
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
// An idle worker holds its own store connection and code, about 19 MiB, for
// work that comes a few times a day. It is released like an idle collector.
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// The worker keeps a desktop import preview for 30 minutes; releasing it
// earlier would lose a preview the user is still reviewing.
const PREVIEW_HOLD_MS = 30 * 60_000;
// A released worker closes its store and exits; one that does not is ended.
const RETIRE_TIMEOUT_MS = 10_000;

function createMaintenanceHost({
  databasePath, backupDirectory, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, now = Date.now,
  createWorker = (modulePath, options) => new Worker(modulePath, options),
}) {
  /** @type {any} */
  let worker = null;
  let closing = false;
  let closePromise;
  let nextId = 1;
  let idleTimer;
  let previewHeldUntil = 0;
  const pending = new Map();
  // Released workers still closing their store, and when each has exited.
  const retiring = new Map();
  const busy = (target) => [...pending.values()].some((entry) => entry.worker === target);

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!worker || closing || busy(worker) || !(idleTimeoutMs > 0)) return;
    idleTimer = setTimeout(retire, Math.max(idleTimeoutMs, previewHeldUntil - now()));
    idleTimer.unref?.();
  }

  // Detach first, so a request made while it closes gets a fresh worker. It
  // has nothing in flight: SQLite sees an ordinary close.
  function retire() {
    const target = worker;
    if (!target || closing || busy(target)) return;
    if (previewHeldUntil > now()) {
      scheduleIdle();
      return;
    }
    worker = null;
    const stop = setTimeout(() => { try { void target.terminate?.(); } catch { /* Already gone. */ } }, RETIRE_TIMEOUT_MS);
    stop.unref?.();
    retiring.set(target, new Promise((/** @type {(value?: void) => void} */ resolve) => {
      if (typeof target.once !== 'function') resolve();
      else target.once('exit', resolve);
    }).then(() => {
      clearTimeout(stop);
      retiring.delete(target);
    }));
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      target.postMessage({ id: nextId++, type: 'close' });
    } catch {
      clearTimeout(stop);
      try { void target.terminate?.(); } catch { /* Already gone. */ }
    }
  }

  function failPending(owner, error) {
    for (const [id, entry] of pending) {
      if (entry.worker !== owner) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  // A request that never answers is a wedged worker: every later refresh
  // waits behind the exclusive queue for it. Drop the worker so the next
  // request starts a fresh one; SQLite rolls back whatever it was writing.
  function abandon(target, reason) {
    if (worker === target) {
      worker = null;
      previewHeldUntil = 0;
    }
    failPending(target, reason);
    try { void target.terminate?.(); } catch { /* Already gone. */ }
  }

  function getWorker() {
    if (worker) return worker;
    const spawned = createWorker(path.join(__dirname, 'maintenance-service.cjs'), {
      workerData: { databasePath, backupDirectory },
    });
    spawned.on('message', (message) => {
      const entry = pending.get(message?.id);
      if (!entry || entry.worker !== spawned) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      // A preview keeps its worker until it is imported, cancelled or expires.
      // A failed import leaves it in place for another try.
      if (entry.type === 'preview-desktop-export' && message.ok) previewHeldUntil = now() + PREVIEW_HOLD_MS;
      if (entry.type === 'cancel-desktop-export' || (entry.type === 'import-desktop-export' && message.ok)) previewHeldUntil = 0;
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error?.message || 'Storage maintenance failed.'));
      if (worker === spawned) scheduleIdle();
    });
    spawned.on('error', (error) => {
      if (worker === spawned) {
        worker = null;
        previewHeldUntil = 0;
      }
      failPending(spawned, error);
    });
    spawned.on('exit', (code) => {
      if (worker === spawned) {
        worker = null;
        previewHeldUntil = 0;
      }
      failPending(spawned, new Error(`Storage maintenance stopped unexpectedly (code ${code}).`));
    });
    worker = spawned;
    return spawned;
  }

  function request(type, payload = {}) {
    if (closing && type !== 'close') return Promise.reject(new Error('AI Usage is closing; storage maintenance is unavailable.'));
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      const target = getWorker();
      const id = nextId++;
      // Close is serialised behind active jobs by the worker itself and is
      // bounded by the caller's shutdown deadline, so it carries no timer.
      const timer = type === 'close' || !(requestTimeoutMs > 0) ? null : setTimeout(() => {
        if (!pending.has(id)) return;
        abandon(target, new Error(`Storage maintenance did not respond in time (${type}).`));
      }, requestTimeoutMs);
      timer?.unref?.();
      pending.set(id, { resolve, reject, worker: target, timer, type });
      try {
        // Worker ports do not have a browser target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        target.postMessage({ id, type, payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer ?? undefined);
        reject(error);
      }
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(idleTimer);
    // The worker serializes this behind active jobs. Never terminate a
    // running restore or backup just because the user closes the app. A
    // released worker still closing its store is waited for as well.
    const closed = worker ? request('close') : Promise.resolve({ closed: true });
    closePromise = Promise.all([closed, ...retiring.values()]).then(([result]) => result);
    return closePromise;
  }

  return { request, close, get running() { return Boolean(worker); } };
}

// Writers must not contend with a long worker restore on the main thread:
// SQLite's busy timeout is synchronous. Dashboard reads remain available.
function createDatabaseQueue() {
  /** @type {Promise<any>} */
  let queue = Promise.resolve();
  /** @type {Promise<any>} */
  let maintenanceQueue = Promise.resolve();
  let exclusiveCount = 0;
  let closing = false;
  const collections = new Set();
  let paused = false;
  const closingError = () => new Error('AI Usage is closing; changes cannot be saved.');
  function enqueue(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }
  return {
    /**
     * @template T
     * @param {() => T | Promise<T>} operation
     * @returns {Promise<T>}
     */
    run(operation) {
      return closing || paused ? Promise.reject(closingError()) : enqueue(operation);
    },
    /**
     * @template T
     * @param {() => T | Promise<T>} operation
     * @returns {Promise<T>}
     */
    async collect(operation) {
      if (closing || paused) throw closingError();
      // Completion decrements the count while this awaits the latest queue.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (exclusiveCount) await maintenanceQueue;
      if (closing || paused) throw closingError();
      const next = Promise.resolve().then(operation);
      collections.add(next);
      try { return await next; } finally { collections.delete(next); }
    },
    /**
     * @template T
     * @param {() => T | Promise<T>} operation
     * @returns {Promise<T>}
     */
    exclusive(operation) {
      if (closing || paused) return Promise.reject(closingError());
      exclusiveCount += 1;
      const next = maintenanceQueue.then(async () => {
        // Wait for provider reads outside the write queue, so editing settings
        // still works while a provider takes its time. New collections wait.
        await Promise.allSettled(collections);
        return enqueue(operation);
      }).finally(() => { exclusiveCount -= 1; });
      maintenanceQueue = next.catch(() => {});
      return next;
    },
    /**
     * @template T
     * @param {() => T | Promise<T>} operation
     * @returns {Promise<T>}
     */
    async prepareToClose(operation) {
      if (closing || paused) throw closingError();
      paused = true;
      try {
        await Promise.allSettled([maintenanceQueue, ...collections]);
        await queue;
        return await operation();
      } catch (error) {
        paused = false;
        throw error;
      }
    },
    close() {
      closing = true;
      return Promise.allSettled([maintenanceQueue, ...collections]).then(() => queue);
    },
  };
}

module.exports = { createMaintenanceHost, createDatabaseQueue };
