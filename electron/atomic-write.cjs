'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Windows can hold a file that was only just closed (antivirus, the search
// indexer, a sync client), or one that another program has open, so moving
// the new file into place is retried briefly. The waits are short because
// this runs in the main process.
const BUSY_FILE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_WAIT_MS = 50;

/** @param {number} milliseconds */
function pause(milliseconds) {
  // Where blocking is not allowed, the next attempt simply follows at once.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); } catch { /* No wait. */ }
}

// Replaces a file's contents in one step: the text is written to a temporary
// file beside it, flushed to disk, and renamed over it. A crash or power loss
// part-way leaves the old file whole, never a truncated one. Renaming over an
// existing file replaces it on Windows as it does elsewhere.
//
// The file keeps its permissions, and a link is written through, not
// replaced. If the rename is still refused after the retries, the file is
// rewritten in place as it was before this existed: a holder that refuses a
// rename often still allows a write, and the change must not be lost to it.
/**
 * @param {string} filePath
 * @param {string} text
 * @param {{ rename?: typeof fs.renameSync, wait?: (milliseconds: number) => void }} [options] replaceable for tests
 */
function writeFileAtomically(filePath, text, { rename = fs.renameSync, wait = pause } = {}) {
  let target = filePath;
  /** @type {number | null} */
  let mode = null;
  try {
    target = fs.realpathSync(filePath);
    mode = fs.statSync(target).mode & 0o777;
  } catch { /* A new file: created where it was asked for, with the default permissions. */ }
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'w');
    try {
      // Opening applies the process's mask, so the mode is set afterwards.
      if (mode !== null) fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(temporary, target);
        break;
      } catch (error) {
        const busy = BUSY_FILE_CODES.has(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? '');
        if (!busy) throw error;
        if (attempt >= RENAME_ATTEMPTS) {
          fs.writeFileSync(target, text, 'utf8');
          break;
        }
        wait(RENAME_WAIT_MS * attempt);
      }
    }
  } finally {
    // Gone already when it was renamed into place.
    try { fs.unlinkSync(temporary); } catch { /* Nothing to remove. */ }
  }
  // The rename itself is only durable once the folder is flushed. Windows
  // does not let a folder be opened for this, and does not need it.
  try {
    const directory = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch { /* Not supported here. */ }
}

module.exports = { writeFileAtomically };
