'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerIpc } = require('../electron/ipc-handlers.cjs');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { createDatabaseQueue } = require('../electron/maintenance-host.cjs');

// Run the actual IPC registration against a real SQLite store while replacing
// Electron's window and the network collector with controlled boundaries.
function fixture(t, refreshClaudeOnly) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-manual-review-'));
  const store = new UsageStore(path.join(root, 'db.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map(), published = [], logs = [];
  registerIpc({
    handleIpc: (channel, handler) => handlers.set(channel, handler), store, databaseJobs: createDatabaseQueue(),
    invalidateSnapshot() {}, snapshot: () => store.getDashboardSnapshot(), refreshClaudeOnly,
    publishAfterWrite: (value, options) => { if (options?.push !== false) published.push(value); }, log: (value) => logs.push(value),
  });
  return { store, published, logs, save: (sourceId) => handlers.get('dashboard:add-manual-observation')({}, {
    sourceId, usedPercent: 25, resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
  }) };
}

test('a saved manual Claude reading returns before a slow refresh and remains saved if it fails', async (t) => {
  let rejectRefresh;
  const refresh = new Promise((_, reject) => { rejectRefresh = reject; });
  const { save, store, published, logs } = fixture(t, () => refresh);
  const saved = await save('claude');
  assert.equal(saved.quotas.claude.usedPercent, 25);
  assert.equal(published.length, 0);
  rejectRefresh(new Error('Provider offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(logs[0], /Provider offline/);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 1);
});

test('a manual Codex save does not depend on the Claude collector', async (t) => {
  let calls = 0;
  const { save } = fixture(t, async () => { calls++; });
  assert.equal((await save('codex')).quotas.codex.usedPercent, 25);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});
