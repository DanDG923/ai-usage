'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createProcessHost } = require('./process-host.cjs');
const { CLOSE_REQUEST } = require('./process-protocol.cjs');

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

/**
 * @param {object} options
 * @param {string} options.databasePath
 * @param {string} options.backupDirectory
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.idleTimeoutMs]
 * @param {() => number} [options.now]
 * @param {(modulePath: string, options: import('node:worker_threads').WorkerOptions) => Worker} [options.createWorker]
 * @param {(message: string) => void} [options.onLog]
 */
function createMaintenanceHost({
  databasePath, backupDirectory, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, now = Date.now,
  createWorker = (modulePath, options) => new Worker(modulePath, options),
  onLog = /** @type {(message: string) => void} */ (() => {}),
}) {
  let previewHeldUntil = 0;

  const host = createProcessHost({
    name: 'Maintenance worker',
    spawn: () => createWorker(path.join(__dirname, 'maintenance-service.cjs'), {
      workerData: { databasePath, backupDirectory },
    }),
    listen(worker, events) {
      worker.on('message', events.reply);
      worker.on('error', events.failed);
      worker.on('exit', events.exited);
    },
    // Worker ports do not have a browser target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    send: (worker, message) => worker.postMessage(message),
    stop: (worker) => { void worker.terminate?.(); },
    log: onLog,
    errors: {
      timedOut: (type) => new Error(`Storage maintenance did not respond in time (${type}).`),
      exited: (code) => new Error(`Storage maintenance stopped unexpectedly (code ${code}).`),
      stopped: () => new Error('Storage maintenance was stopped.'),
      closing: () => new Error('AI Usage is closing; storage maintenance is unavailable.'),
      failed: 'Storage maintenance failed.',
    },
    // Close is serialised behind active jobs by the worker itself and is
    // bounded by the caller's shutdown deadline, so it carries no timer.
    requestTimeoutMs: (type) => (type === CLOSE_REQUEST || !(requestTimeoutMs > 0) ? null : requestTimeoutMs),
    unrefRequestTimers: true,
    // A request that never answers is a wedged worker: every later refresh
    // waits behind the exclusive queue for it. Drop the worker so the next
    // request starts a fresh one; SQLite rolls back whatever it was writing.
    // Every job the worker had fails with that timeout.
    onTimeout: 'abandon',
    spawnFailure: 'reject',
    idleTimeoutMs,
    retireGraceMs: RETIRE_TIMEOUT_MS,
    // The worker exits by itself once its store is closed.
    stopOnCloseReply: false,
    retireHoldMs: () => previewHeldUntil - now(),
    onReply(type, ok) {
      // A preview keeps its worker until it is imported, cancelled or expires.
      // A failed import leaves it in place for another try.
      if (type === 'preview-desktop-export' && ok) previewHeldUntil = now() + PREVIEW_HOLD_MS;
      if (type === 'cancel-desktop-export' || (type === 'import-desktop-export' && ok)) previewHeldUntil = 0;
    },
    // The preview lived in the worker that has gone.
    onChildGone() { previewHeldUntil = 0; },
  });

  // Close never terminates a running restore or backup just because the user
  // closes the app: the worker answers it after its active jobs.
  return { request: host.request, close: host.close, get running() { return host.running; } };
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
  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
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
