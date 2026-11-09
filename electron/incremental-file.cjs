'use strict';

const fs = require('node:fs');

class IncrementalReadError extends Error {
  /** @param {NodeJS.ErrnoException} error What the file system reported. */
  constructor(error) {
    super(error.message, { cause: error });
    this.name = 'IncrementalReadError';
    this.code = error.code;
  }
}

// Local transcripts are append-only logs that grow for hours. Reading the whole
// file on every refresh made the main process re-parse megabytes per session
// every fifteen minutes. This reads only what was appended since the recorded
// byte cursor, and only whole lines: a line still being written is left for
// the next refresh. A file that shrank, or was rewritten in place at the same
// size, starts again from byte zero.
/**
 * @param {Pick<import('./types').ImportedFileRow, 'modified_ms' | 'size_bytes'> | null | undefined} previous How far the file had been read, if it has been seen before.
 * @param {Pick<import('node:fs').Stats, 'mtimeMs' | 'size'>} stat The file as it is now.
 */
function planIncrementalRead(previous, stat) {
  if (!previous) return { startOffset: 0, resumed: false };
  const unchanged = previous.modified_ms === stat.mtimeMs && previous.size_bytes === stat.size;
  if (unchanged) return null;
  const rewrittenAtSameSize = previous.size_bytes === stat.size && previous.modified_ms !== stat.mtimeMs;
  const shrank = stat.size < previous.size_bytes;
  if (rewrittenAtSameSize || shrank) return { startOffset: 0, resumed: false };
  return { startOffset: previous.size_bytes, resumed: true };
}

/**
 * @param {string} filePath
 * @param {number} startOffset The byte to start reading from.
 * @param {number} size The file's size in bytes when the read was planned.
 * @param {{ chunkBytes?: number, streaming?: boolean }} [options]
 */
function readCompleteLines(filePath, startOffset, size, { chunkBytes = 1024 * 1024, streaming = false } = {}) {
  const length = Math.max(0, size - startOffset);
  if (length === 0) return { lines: [], consumedBytes: 0 };
  // Open eagerly so access failures retain the caller's per-file diagnostics.
  fs.closeSync(fs.openSync(filePath, 'r'));
  let consumedBytes = 0;
  function* scan() {
    try {
      let fd;
      let pending = [];
      consumedBytes = 0;
      let read = 0;
      try {
        fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(Math.min(length, chunkBytes));
        while (read < length) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - read), startOffset + read);
          if (count === 0) break;
          let cursor = 0;
          for (let newline = buffer.indexOf(0x0a, cursor); newline >= 0 && newline < count; newline = buffer.indexOf(0x0a, cursor)) {
            const part = buffer.subarray(cursor, newline);
            const bytes = pending.length ? Buffer.concat([...pending, part]) : part;
            const line = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r$/, '');
            if (line) yield line;
            pending = [];
            cursor = newline + 1;
            consumedBytes = read + cursor;
          }
          if (cursor < count) pending.push(Buffer.from(buffer.subarray(cursor, count)));
          read += count;
        }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    } catch (error) {
      // Iteration happens after the caller opens its file transaction. Tag
      // only reader failures so collectors can retry this file without
      // mistaking a database failure for an unreadable transcript.
      throw new IncrementalReadError(/** @type {NodeJS.ErrnoException} */ (error));
    }
  }
  const iterable = { [Symbol.iterator]: scan };
  if (streaming) return { lines: iterable, get consumedBytes() { return consumedBytes; } };
  const lines = [...iterable];
  return { lines, consumedBytes };
}

module.exports = { IncrementalReadError, planIncrementalRead, readCompleteLines };
