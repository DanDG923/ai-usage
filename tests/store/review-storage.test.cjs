'use strict';
require('../setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-review-storage-'));
  const store = new UsageStore(path.join(root, 'db.sqlite'), path.join(root, 'Backups'));
  t.after(() => { if (store.db.isOpen) store.close(); });
  return store;
}
const at = '2026-09-01T12:00:00.000Z';

test('invalid token subsets cannot overwrite a good ledger row or enter through restore', (t) => {
  const store = fixture(t);
  const base = { eventKey: 'valid', sourceId: 'codex', occurredAt: at, inputTokens: 100, cachedInputTokens: 20 };
  store.recordUsageEvent(base);
  const original = store.prepare('SELECT * FROM usage_events').all();
  for (const fields of [{ cachedInputTokens: 101 }, { inputTokens: false }, { inputTokens: '' }, { inputTokens: [] },
    { cacheWriteInputTokens: 10, cacheWrite5mInputTokens: 8, cacheWrite1hInputTokens: 8 }]) {
    assert.throws(() => store.recordUsageEvent({ ...base, ...fields }), /token|Cache write/);
    assert.deepEqual(store.prepare('SELECT * FROM usage_events').all(), original);
  }
  const result = store.restoreFromExport({ schemaVersion: 1, usageEvents: [
    { ...original[0], event_key: 'bad-cache', cached_input_tokens: 101 },
    { ...original[0], event_key: 'bad-ttl', cache_write_input_tokens: 10, cache_write_5m_input_tokens: 8, cache_write_1h_input_tokens: 8 },
    { ...original[0], event_key: 'good-copy' },
  ] });
  assert.equal(result.skipped, 2);
  assert.equal(result.usageEvents, 1);
});

test('a partially specified cache duration infers only the remaining five-minute tokens', (t) => {
  const store = fixture(t);
  store.recordUsageEvent({ eventKey: 'ttl', sourceId: 'claude', occurredAt: at, model: 'claude-fable-5',
    cacheWriteInputTokens: 300, cacheWrite1hInputTokens: 200 });
  const saved = store.prepare('SELECT * FROM usage_events').get();
  assert.equal(saved.cache_write_5m_input_tokens, 100);
  assert.equal(saved.cache_write_1h_input_tokens, 200);
  assert.equal(store.calculateCost(saved).actualUsd, 0.00525);
});
const cases = [
  ['usage_events', 'event_key', 'usageEvents', (key) => ({ event_key: key, source_id: 'codex', occurred_at: at, input_tokens: 10 })],
  ['quota_observations', 'bucket_id', 'observations', (key) => ({ source_id: 'codex', bucket_id: key,
    observed_at: at, resets_at: '2026-09-05T12:00:00.000Z', used_percent: 10, window_minutes: 10080 })],
  ['account_daily_usage', 'usage_date', 'dailyUsage', (key) => ({ source_id: 'codex', usage_date: key, tokens: 10 })],
  ['price_catalog', 'model', 'prices', (key) => ({ model: key, input_usd_per_million: 1,
    cache_write_usd_per_million: 1, cache_read_usd_per_million: 1, output_usd_per_million: 1 })],
];
for (const [table, key, field, row] of cases) {
  for (const action of ['ROLLBACK', 'ABORT']) {
    test(`restore propagates SQLite ${action} in ${table} without partial writes`, (t) => {
      const store = fixture(t);
      const ids = field === 'dailyUsage' ? ['2026-08-01', '2026-08-02', '2026-08-03'] : ['first', 'fault', 'last'];
      const before = store.prepare(`SELECT * FROM ${table}`).all();
      const settings = store.getSettings();
      store.db.exec(`CREATE TRIGGER inject_restore_failure BEFORE INSERT ON ${table}
        WHEN NEW.${key} = '${ids[1]}' BEGIN SELECT RAISE(${action}, 'injected restore failure'); END`);
      assert.throws(() => store.restoreFromExport({ schemaVersion: 1, settings: { theme: 'light' },
        [field]: ids.map(row) }), /injected restore failure/);
      assert.deepEqual(store.prepare(`SELECT * FROM ${table}`).all(), before);
      assert.deepEqual(store.getSettings(), settings);
      assert.equal(store.db.isTransaction, false);
    });
  }
}

test('backup restores custom prices over fresh seeds, then protects restored prices across restart', (t) => {
  const source = fixture(t);
  const target = fixture(t);
  source.updatePrice({ model: 'gpt-5.6-sol', inputUsdPerMillion: 123, cacheWriteUsdPerMillion: 5,
    cacheWrite1hUsdPerMillion: 5, cacheReadUsdPerMillion: 0.4, outputUsdPerMillion: 20 });
  const saved = source.createBackup();
  assert.equal(target.restoreFromBackup(saved.exportPath).prices, 1);
  assert.equal(target.resolvePrice('gpt-5.6-sol').input_usd_per_million, 123);
  target.close();
  const reopened = new UsageStore(target.databasePath, target.backupDirectory);
  t.after(() => reopened.close());
  source.updatePrice({ model: 'gpt-5.6-sol', inputUsdPerMillion: 456, cacheWriteUsdPerMillion: 5,
    cacheWrite1hUsdPerMillion: 5, cacheReadUsdPerMillion: 0.4, outputUsdPerMillion: 20 });
  assert.equal(reopened.restoreFromExport({ schemaVersion: 1, prices: source.getPriceCatalog() }).prices, 0);
  assert.equal(reopened.resolvePrice('gpt-5.6-sol').input_usd_per_million, 123);
});

test('legacy catalogue migration preserves ownership of every existing row', (t) => {
  const original = fixture(t);
  original.db.exec('ALTER TABLE price_catalog DROP COLUMN is_seed');
  original.close();
  const reopened = new UsageStore(original.databasePath, original.backupDirectory);
  t.after(() => reopened.close());
  const price = reopened.resolvePrice('gpt-5.6-sol');
  reopened.restoreFromExport({ schemaVersion: 1, prices: [{ ...price, input_usd_per_million: 123 }] });
  assert.equal(reopened.resolvePrice('gpt-5.6-sol').input_usd_per_million, 4);
});

test('partial Claude transcript failures retain good scan times and reach the refresh warning', async (t) => {
  const store = fixture(t);
  const saved = { ...process.env };
  const root = path.dirname(store.databasePath);
  Object.assign(process.env, { USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    CLAUDE_CONFIG_DIR: path.join(root, '.claude'), PATH: '' });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const previousSuccess = '2026-08-01T12:00:00.000Z';
  store.prepare("UPDATE sources SET last_success_at = ? WHERE id IN ('claude', 'claude-fable')").run(previousSuccess);
  const { refreshClaude } = require('../../electron/claude-collector.cjs');
  const resets_at = new Date(Date.now() + 86400000).toISOString();
  // Updated deliberately: plan usage is read only on an explicit user refresh now,
  // so this SDK-path test asks for one (readPlanUsage: true).
  const result = await refreshClaude(store, path.join(root, 'missing-inbox.jsonl'), {
    readPlanUsage: true,
    usagePort: { read: async () => ({ subscription_type: 'max', rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 10, resets_at },
        model_scoped: [{ display_name: 'Fable', utilization: 20, resets_at }] } }) },
    activityReader: { import: async () => ({ filesFound: 1, usageEvents: 0, readErrors: 1, lastReadError: 'EACCES' }) },
  });
  assert.match(result.warning, /1 transcript file.*EACCES.*retried/);
  assert.notEqual(result.fableTracking.health.activitySource, 'current');
  for (const row of store.prepare("SELECT status, last_success_at FROM sources WHERE id IN ('claude', 'claude-fable')").all()) {
    assert.equal(row.status, 'degraded');
    assert.equal(row.last_success_at, previousSuccess);
  }
  assert.equal(store.getQuota('claude').usedPercent, 10, 'successful provider evidence remains available');
});
