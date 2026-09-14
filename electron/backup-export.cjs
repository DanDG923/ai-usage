'use strict';
const fs = require('node:fs');
const { gzipSync, gunzipSync } = require('node:zlib');
const MAX_RESTORE_BYTES = 64 * 1024 * 1024;

// Concatenated gzip members are a standard gzip stream. Keeping each member
// bounded avoids both V8's maximum string length and retaining the ledger.
function writeExport(filePath, database, settings) {
  const fd = fs.openSync(filePath, 'wx');
  let pending = '';
  const flush = () => {
    if (!pending) return;
    const bytes = gzipSync(Buffer.from(pending));
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    pending = '';
  };
  const write = (text) => { pending += text; if (pending.length >= 256 * 1024) flush(); };
  try {
    write(`{"schemaVersion":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"settings":${JSON.stringify(settings)}`);
    for (const [key, table] of Object.entries({ sources: 'sources', observations: 'quota_observations',
      usageEvents: 'usage_events', desktopEstimates: 'desktop_chat_estimates', dailyUsage: 'account_daily_usage', prices: 'price_catalog' })) {
      write(`,${JSON.stringify(key)}:[`);
      let first = true;
      for (const row of database.prepare(`SELECT * FROM ${table}`).iterate()) {
        write(`${first ? '' : ','}${JSON.stringify(row)}`);
        first = false;
      }
      write(']');
    }
    write('}'); flush(); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function readExport(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('That backup file could not be found.');
  if (fs.statSync(filePath).size > MAX_RESTORE_BYTES) throw new Error('This export exceeds the 64 MB restore limit. Use its paired SQLite backup for large-history recovery.');
  try {
    const bytes = fs.readFileSync(filePath);
    const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_RESTORE_BYTES }) : bytes;
    return JSON.parse(decoded.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('This export exceeds the 64 MB restore limit. Use its paired SQLite backup for large-history recovery.');
    throw new Error('That file is not a readable AI Usage export.');
  }
}
module.exports = { writeExport, readExport, MAX_RESTORE_BYTES };
