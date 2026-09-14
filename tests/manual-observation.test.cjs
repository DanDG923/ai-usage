'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
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
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const registration = source.slice(source.indexOf('function registerIpc()'), source.indexOf('\nfunction publishUpdateStatus('));
  vm.runInNewContext(`${registration}\nregisterIpc();`, {
    handleIpc: (channel, handler) => handlers.set(channel, handler), store, databaseJobs: createDatabaseQueue(),
    invalidateSnapshot() {}, snapshot: () => store.getDashboardSnapshot(), refreshClaudeOnly,
    publishAfterWrite: (value) => published.push(value), log: (value) => logs.push(value),
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
  assert.equal(published.length, 1);
  rejectRefresh(new Error('Provider offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(logs[0], /Provider offline/);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 1);
});

test('a manual Codex save does not depend on the Claude collector', async (t) => {
  const { save } = fixture(t, () => assert.fail('Codex does not need a Claude refresh'));
  assert.equal((await save('codex')).quotas.codex.usedPercent, 25);
});
