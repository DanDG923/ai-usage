'use strict';

// Usage stores for tests: one in a fresh temporary folder that is closed when
// the callback returns, and one in memory that is closed after the test.
// Temporary folders start with "ai-usage-", so tests/setup.cjs removes them
// when the process exits.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../../electron/store.cjs');

// Runs run(store) synchronously and closes the store before returning.
function withTempStore(prefix, run) {
  if (!prefix.startsWith('ai-usage-')) throw new Error(`temporary store prefix ${prefix} must start with ai-usage-`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try { return run(store); } finally { store.close(); }
}

// An in-memory store closed after the test t, with settings applied if given.
// Its backup folder is its own, never the system temp directory itself.
function memoryStore(t, settings) {
  const store = new UsageStore(':memory:', fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-memory-store-')));
  t.after(() => store.close());
  if (settings) store.updateSettings(settings);
  return store;
}

module.exports = { withTempStore, memoryStore };
