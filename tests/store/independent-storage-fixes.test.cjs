'use strict';
require('../setup.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../../electron/store.cjs');
const DAY = 86400000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-independent-storage-'));
  const database = path.join(root, 'db.sqlite');
  const backups = path.join(root, 'Backups');
  const stores = [];
  const open = () => { const store = new UsageStore(database, backups); stores.push(store); return store; };
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* Already closed for recovery. */ } }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store: open(), open, database, backups };
}

test('scheduled backup after corruption preserves and restores completed unregistered recovery files', (t) => {
  const { store, open, database } = fixture(t);
  store.recordUsageEvent({ eventKey: 'recovery-history', sourceId: 'codex', model: 'gpt-5.6-sol',
    occurredAt: '2026-09-01T12:00:00.000Z', inputTokens: 777 });
  const saved = store.createBackup();
  const originalBytes = Object.values(saved).map((file) => fs.readFileSync(file));
  store.close();
  for (const file of Object.values(saved)) fs.utimesSync(file, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
  fs.writeFileSync(database, 'synthetic corrupt database');
  const recovered = open();
  assert.ok(recovered.recoveredFrom);
  assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 0);
  assert.ok(recovered.maybeCreateScheduledBackup());
  Object.values(saved).forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originalBytes[index]));
  recovered.restoreFromBackup(saved.exportPath);
  assert.equal(recovered.prepare("SELECT input_tokens FROM usage_events WHERE event_key = 'recovery-history'").get().input_tokens, 777);
});

test('backup sweep removes only old owned partials and preserves recent, completed and unrelated files', (t) => {
  const { store, backups } = fixture(t);
  const stem = 'ai-usage-2026-09-01T12-00-00-000Z-12345678-1234-1234-1234-123456789abc';
  const names = [`${stem}.sqlite.partial`, `${stem}.aiusage.json.gz.partial`,
    `${stem}.sqlite`, `${stem}.aiusage.json.gz`, 'unrelated.sqlite.partial',
    'ai-usage-2026-09-02T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite.partial'];
  for (const [index, name] of names.entries()) {
    const file = path.join(backups, name);
    fs.writeFileSync(file, 'synthetic');
    if (index !== names.length - 1) fs.utimesSync(file, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
  }
  store.sweepPartialBackups();
  assert.deepEqual(fs.readdirSync(backups).sort(), names.slice(2).sort());
});

function fableReadings(store, alternate = true) {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const observation = (sourceId, bucketId, hour, usedPercent, provenance) => store.recordObservation({
    sourceId, bucketId, observedAt: new Date(now + hour * 3600000).toISOString(),
    resetsAt: '2026-09-18T00:00:00.000Z', usedPercent, remainingPercent: 100 - usedPercent,
    windowMinutes: 10080, planType: 'max', provenance,
  });
  observation('claude', 'seven_day', -4, 10, 'official-claude-usage');
  observation('claude-fable', 'fable_seven_day', -3, 20, 'manual-official');
  observation('claude', 'seven_day', -2, 20, 'official-claude-usage');
  if (alternate) observation('claude-fable', 'fable:seven_day_fable', -1, 25, 'official-claude-usage');
  return now;
}

test('alternate official Fable bucket leaves complete forecasts and renders actual provider views', async (t) => {
  const { store } = fixture(t);
  const now = fableReadings(store);
  const snapshot = store.getDashboardSnapshot(30, now);
  const quota = snapshot.quotas.fable;
  assert.equal(quota.bucketId, 'fable:seven_day_fable');
  assert.equal(quota.windows.length, 2);
  assert.ok(quota.windows.every((window) => window.forecast && typeof window.forecast.expired === 'boolean'));
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..', '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { providerViews } = await server.ssrLoadModule('/src/provider-view.ts');
    assert.doesNotThrow(() => providerViews(snapshot));
  } finally { await server.close(); }
});

test('available Fable projection replaces the canonical manual window without learning its discarded forecast', (t) => {
  const { store } = fixture(t);
  const now = fableReadings(store, false);
  const learned = store.learnedForecast;
  store.learnedForecast = function (source, bucket, ...args) {
    assert.ok(source !== 'claude-fable' || bucket !== 'fable_seven_day', 'discarded canonical forecast was calculated');
    return learned.call(this, source, bucket, ...args);
  };
  const quota = store.getQuota('claude-fable', store.getSettings(), now);
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.provenance, 'derived-tokens');
  assert.ok(quota.forecast);
});
