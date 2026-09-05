'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createMaintenanceHost({ databasePath, backupDirectory, createWorker = (modulePath, options) => new Worker(modulePath, options) }) {
  let worker = null;
  let closing = false;
  let closePromise;
  let nextId = 1;
  const pending = new Map();

  function failPending(owner, error) {
    for (const [id, entry] of pending) {
      if (entry.worker !== owner) continue;
      pending.delete(id);
      entry.reject(error);
    }
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
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error?.message || 'Storage maintenance failed.'));
    });
    spawned.on('error', (error) => {
      if (worker === spawned) worker = null;
      failPending(spawned, error);
    });
    spawned.on('exit', (code) => {
      if (worker === spawned) worker = null;
      failPending(spawned, new Error(`Storage maintenance stopped unexpectedly (code ${code}).`));
    });
    worker = spawned;
    return spawned;
  }

  function request(type, payload = {}) {
    if (closing && type !== 'close') return Promise.reject(new Error('AI Usage is closing; storage maintenance is unavailable.'));
    return new Promise((resolve, reject) => {
      const target = getWorker();
      const id = nextId++;
      pending.set(id, { resolve, reject, worker: target });
      try {
        // Worker ports do not have a browser target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        target.postMessage({ id, type, payload });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    // The worker serializes this behind active jobs. Never terminate a
    // running restore or backup just because the user closes the app.
    closePromise = worker ? request('close') : Promise.resolve({ closed: true });
    return closePromise;
  }

  return { request, close, get running() { return Boolean(worker); } };
}

// Writers must not contend with a long worker restore on the main thread:
// SQLite's busy timeout is synchronous. Dashboard reads remain available.
function createDatabaseQueue() {
  let queue = Promise.resolve();
  let maintenanceQueue = Promise.resolve();
  let exclusiveCount = 0;
  let closing = false;
  const collections = new Set();
  const closingError = () => new Error('AI Usage is closing; changes cannot be saved.');
  function enqueue(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }
  return {
    run(operation) {
      return closing ? Promise.reject(closingError()) : enqueue(operation);
    },
    async collect(operation) {
      if (closing) throw closingError();
      // Completion decrements the count while this awaits the latest queue.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (exclusiveCount) await maintenanceQueue;
      if (closing) throw closingError();
      const next = Promise.resolve().then(operation);
      collections.add(next);
      try { return await next; } finally { collections.delete(next); }
    },
    exclusive(operation) {
      if (closing) return Promise.reject(closingError());
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
    close() {
      closing = true;
      return Promise.allSettled([maintenanceQueue, ...collections]).then(() => queue);
    },
  };
}

module.exports = { createMaintenanceHost, createDatabaseQueue };
