'use strict';

const fs = require('node:fs');

// Local transcripts are append-only logs that grow for hours. Reading the whole
// file on every refresh made the main process re-parse megabytes per session
// every fifteen minutes. This reads only what was appended since the recorded
// byte cursor, and only whole lines: a line still being written is left for
// the next refresh. A file that shrank, or was rewritten in place at the same
// size, starts again from byte zero.
function planIncrementalRead(previous, stat) {
  if (!previous) return { startOffset: 0, resumed: false };
  const unchanged = previous.modified_ms === stat.mtimeMs && previous.size_bytes === stat.size;
  if (unchanged) return null;
  const rewrittenAtSameSize = previous.size_bytes === stat.size && previous.modified_ms !== stat.mtimeMs;
  const shrank = stat.size < previous.size_bytes;
  if (rewrittenAtSameSize || shrank) return { startOffset: 0, resumed: false };
  return { startOffset: previous.size_bytes, resumed: true };
}

function readCompleteLines(filePath, startOffset, size) {
  const length = Math.max(0, size - startOffset);
  if (length === 0) return { lines: [], consumedBytes: 0 };
  const fd = fs.openSync(filePath, 'r');
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, buffer, read, length - read, startOffset + read);
      if (count === 0) break;
      read += count;
    }
    buffer = buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  const finalNewline = buffer.lastIndexOf(0x0a);
  if (finalNewline < 0) return { lines: [], consumedBytes: 0 };
  const consumedBytes = finalNewline + 1;
  const text = buffer.subarray(0, consumedBytes).toString('utf8').replace(/^\uFEFF/, '');
  return { lines: text.split(/\r?\n/).filter(Boolean), consumedBytes };
}

module.exports = { planIncrementalRead, readCompleteLines };
