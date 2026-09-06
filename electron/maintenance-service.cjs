'use strict';

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { UsageStore } = require('./store.cjs');
const { randomUUID } = require('node:crypto');
const { readDesktopExport, saveDesktopEstimates } = require('./desktop-estimates.cjs');

// All large reads, JSON conversion, SQLite copying and file writes stay in
// this worker. Only small results cross the port back to the window process.
function createMaintenanceService({ databasePath, backupDirectory, openStore = (database, backups) => new UsageStore(database, backups) }) {
  let store;
  let closed = false;
  let queue = Promise.resolve();
  let desktopPreview = null;

  async function run(request) {
    if (closed) throw new Error('Storage maintenance has closed.');
    if (request.type === 'close') {
      closed = true;
      store?.close();
      store = null;
      desktopPreview = null;
      return { closed: true };
    }
    if (request.type === 'ping') return { ok: true };
    store ??= openStore(databasePath, backupDirectory);
    switch (request.type) {
      case 'preview-desktop-export': {
        desktopPreview = null;
        const parsed = readDesktopExport(request.filePath);
        desktopPreview = { id: randomUUID(), rows: parsed.rows, expiresAt: Date.now() + 30 * 60_000 };
        return { id: desktopPreview.id, ...parsed.summary };
      }
      case 'cancel-desktop-export':
        if (desktopPreview?.id === request.previewId) desktopPreview = null;
        return { cancelled: true };
      case 'import-desktop-export': {
        if (!desktopPreview || desktopPreview.id !== request.previewId || Date.now() > desktopPreview.expiresAt) {
          desktopPreview = null;
          throw new Error('The import preview expired. Choose your export again.');
        }
        const result = saveDesktopEstimates(store, desktopPreview.rows, request.assumedModel ?? null);
        desktopPreview = null;
        return result;
      }
      case 'clear-desktop-estimates': {
        const safetyBackup = store.createBackup();
        const removed = store.prepare('DELETE FROM desktop_chat_estimates').run().changes;
        return { removed, safetyBackup };
      }
      case 'create-backup':
        return store.createBackup();
      case 'scheduled-backup':
        return store.maybeCreateScheduledBackup();
      case 'restore-backup': {
        // Read first: retention can otherwise remove the selected export
        // while making its safety backup. Protect it from pruning as well.
        const payload = store.readExport(request.filePath);
        const safetyBackup = store.createBackup({ keep: request.filePath });
        const result = store.restoreFromExport(payload);
        return { result, safetyBackup };
      }
      case 'export-csv': {
        const exported = store.exportLedgerCsv(request.days);
        fs.writeFileSync(request.filePath, exported.csv, 'utf8');
        return { filePath: request.filePath, rows: exported.rows, days: request.days };
      }
      default:
        throw new Error(`Unknown storage request: ${String(request.type)}`);
    }
  }

  function handle(request) {
    const next = queue.then(() => run(request));
    queue = next.catch(() => {});
    return next;
  }

  return { handle };
}

if (parentPort) {
  const service = createMaintenanceService(workerData);
  parentPort.on('message', async ({ id, type, payload }) => {
    try {
      const result = await service.handle({ ...payload, type });
      // Worker ports do not have a browser target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      parentPort.postMessage({ id, ok: true, result });
      if (type === 'close') parentPort.close();
    } catch (error) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      parentPort.postMessage({ id, ok: false, error: { message: error?.message || String(error) } });
    }
  });
}

module.exports = { createMaintenanceService };
