'use strict';

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { UsageStore } = require('./store.cjs');
const { randomUUID } = require('node:crypto');
const { readDesktopExport, saveDesktopEstimates } = require('./desktop-estimates.cjs');

// Windows can hold a file that was only just closed (antivirus, the search
// indexer, OneDrive syncing Documents), so moving it into place is retried
// for a few seconds before the error is reported.
const BUSY_FILE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/**
 * @param {string} from
 * @param {string} to
 * @param {number} [attempts]
 */
async function replaceFile(from, to, attempts = 8) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !BUSY_FILE_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** @typedef {import('./store.cjs').Store} Store */

/**
 * The protocol between the host and this worker. A request carries an id; its
 * reply carries the same id and either a result or an error message.
 *
 * @typedef {{ id: number, type: string, payload?: Record<string, unknown> }} MaintenanceMessage
 * @typedef {{ id: number, ok: boolean, result?: unknown, error?: { message?: string } }} MaintenanceReply
 */

/**
 * A request as the service runs it: its type, with the payload's fields
 * beside it. Each type names the fields it needs.
 *
 * @typedef {{ type: 'close' | 'ping' | 'clear-desktop-estimates' | 'scheduled-backup' }
 *   | { type: 'preview-desktop-export', filePath: string }
 *   | { type: 'cancel-desktop-export', previewId: string }
 *   | { type: 'import-desktop-export', previewId: string, assumedModel?: string | null }
 *   | { type: 'create-backup', exportJson?: boolean }
 *   | { type: 'restore-backup', filePath: string }
 *   | { type: 'export-csv', filePath: string, days: number }} MaintenanceJob
 */

// All large reads, JSON conversion, SQLite copying and file writes stay in
// this worker. Only small results cross the port back to the window process.
/**
 * @param {object} options
 * @param {string} options.databasePath
 * @param {string} options.backupDirectory
 * @param {(database: string, backups: string) => Store} [options.openStore]
 */
function createMaintenanceService({ databasePath, backupDirectory, openStore = (database, backups) => new UsageStore(database, backups) }) {
  /** @type {Store | null | undefined} */
  let store;
  let closed = false;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {{ id: string, rows: ReturnType<typeof readDesktopExport>['rows'], expiresAt: number } | null} */
  let desktopPreview = null;

  /** @param {MaintenanceJob} request */
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
        return store.createBackup({ exportJson: request.exportJson !== false });
      case 'scheduled-backup':
        return store.maybeCreateScheduledBackup();
      case 'restore-backup': {
        // Read first: retention can otherwise remove the selected export
        // while making its safety backup. Protect it from pruning as well.
        // A SQLite backup is read as the merge runs, so it stays open until then.
        const payload = store.readExport(request.filePath);
        try {
          const safetyBackup = store.createBackup({ keep: request.filePath });
          const result = store.restoreFromExport(payload);
          return { result, safetyBackup };
        } finally { payload.close?.(); }
      }
      case 'export-csv': {
        // Streamed beside the chosen file and moved into place once complete,
        // so a failed export never leaves a truncated file under that name.
        const partial = `${request.filePath}.partial`;
        let exported;
        try {
          const descriptor = fs.openSync(partial, 'w');
          try {
            exported = store.exportLedgerCsv(request.days, Date.now(), (text) => {
              const bytes = Buffer.from(text, 'utf8');
              for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(descriptor, bytes, offset);
            });
          } finally { fs.closeSync(descriptor); }
          await replaceFile(partial, request.filePath);
        } catch (error) {
          try { fs.unlinkSync(partial); } catch { /* Never created, or already moved. */ }
          throw error;
        }
        return { filePath: request.filePath, rows: exported.rows, days: request.days };
      }
      default:
        // Reached only by a type the list above does not have.
        throw new Error(`Unknown storage request: ${String(/** @type {{ type: unknown }} */ (request).type)}`);
    }
  }

  /** @param {MaintenanceJob} request */
  function handle(request) {
    const next = queue.then(() => run(request));
    queue = next.catch(() => {});
    return next;
  }

  return { handle };
}

if (parentPort) {
  const port = parentPort;
  const service = createMaintenanceService(workerData);
  port.on('message', async (/** @type {MaintenanceMessage} */ { id, type, payload }) => {
    try {
      // The host in this app wrote the message; run() refuses a type it does not know.
      const result = await service.handle(/** @type {MaintenanceJob} */ ({ ...payload, type }));
      // Worker ports do not have a browser target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      port.postMessage({ id, ok: true, result });
      if (type === 'close') port.close();
    } catch (error) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      port.postMessage({ id, ok: false, error: { message: error?.message || String(error) } });
    }
  });
}

module.exports = { createMaintenanceService };
