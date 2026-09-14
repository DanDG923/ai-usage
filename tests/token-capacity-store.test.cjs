'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-07T12:00:00Z');

function fixture(t, sourceId = 'codex', bucketId = 'codex:weekly') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-token-capacity-'));
  const store = new UsageStore(path.join(directory, 'usage.sqlite'), directory);
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(directory, `usage.sqlite${suffix}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  for (let index = 0; index < 4; index++) {
    store.recordObservation({ sourceId, bucketId, observedAt: new Date(NOW - (3 - index) * 12 * HOUR).toISOString(),
      resetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString(), usedPercent: 10 + index * 10,
      remainingPercent: 90 - index * 10, windowMinutes: 10080, provenance: 'official',
      metadata: sourceId === 'codex' ? { limitId: 'codex' } : { scope: sourceId === 'claude-fable' ? 'model' : 'overall' } });
    if (index < 3) store.recordUsageEvent({ eventKey: `usage-${index}`, sourceId: sourceId === 'claude-fable' ? 'claude' : sourceId,
      model: sourceId === 'codex' ? 'gpt-5.6-sol' : 'claude-fable-5',
      occurredAt: new Date(NOW - (2.5 - index) * 12 * HOUR).toISOString(), inputTokens: 900_000,
      cachedInputTokens: sourceId === 'codex' ? 200_000 : 0, outputTokens: 100_000, reasoningOutputTokens: 50_000 });
  }
  return store;
}

const capacity = (store, now = NOW, settings = store.getSettings(), sourceId = 'codex') => store.getQuota(sourceId, settings, now).tokenCapacity;

test('weekly capacity reaches snapshots independently of the Costs period and five-hour forecast', t => {
  const store = fixture(t);
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:five-hour', observedAt: new Date(NOW).toISOString(),
    resetsAt: new Date(NOW + HOUR).toISOString(), usedPercent: 90, remainingPercent: 10, windowMinutes: 300, provenance: 'official' });
  const result = capacity(store);
  assert.equal(result.status, 'available');
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.equal(result.remainingTokens, 6_000_000);
  assert.equal(result.remainingAsOf, new Date(NOW).toISOString());
  assert.equal(store.getQuota('codex', store.getSettings(), NOW).windows.find(w => w.windowMinutes === 300).tokenCapacity, null);
  assert.deepEqual(store.getDashboardSnapshot(7, NOW).quotas.codex.tokenCapacity, result);
  assert.deepEqual(store.getDashboardSnapshot(365, NOW).quotas.codex.tokenCapacity, result);
});

test('status, cursor, prices and unrelated source writes keep capacity cached', t => {
  const store = fixture(t);
  const original = capacity(store);
  store.setSourceStatus('codex', 'connected', 'Synthetic refresh');
  store.markImportedFile('synthetic.jsonl', 1, 1, {});
  store.db.exec('UPDATE price_catalog SET input_usd_per_million = input_usd_per_million + 1');
  store.recordUsageEvent({ eventKey: 'unrelated', sourceId: 'claude', model: 'claude-opus-5', occurredAt: new Date(NOW).toISOString(), inputTokens: 999 });
  assert.equal(capacity(store, NOW + 1), original);
  // Nothing time-driven changes for hours, so the ledger is not re-read on a clock.
  assert.equal(capacity(store, NOW + 6 * HOUR), original);
});

test('usage and official observations invalidate across SQLite connections', t => {
  const store = fixture(t);
  const original = capacity(store);
  const writer = new DatabaseSync(store.databasePath);
  try {
    writer.exec('UPDATE usage_events SET input_tokens = input_tokens * 2, output_tokens = output_tokens * 2');
    const changed = capacity(store);
    assert.notEqual(changed, original);
    assert.equal(changed.weeklyTokens, 20_000_000);
    writer.prepare('UPDATE quota_observations SET used_percent = 50, remaining_percent = 50 WHERE observed_at = ?').run(new Date(NOW).toISOString());
    assert.notEqual(capacity(store), changed);
    assert.equal(capacity(store).remainingTokens, capacity(store).weeklyTokens / 2);
  } finally { writer.close(); }
});

test('ignored dates update learning immediately, survive reopen and leave observed consumption intact', t => {
  const store = fixture(t);
  const before = capacity(store);
  store.updateSettings({ forecastExcludedDates: ['2026-09-06'] });
  assert.notEqual(capacity(store).status, 'available');
  assert.equal(store.getQuota('codex', store.getSettings(), NOW).usedPercent, 40);
  const reopened = new UsageStore(store.databasePath, path.dirname(store.databasePath));
  try { assert.notEqual(capacity(reopened).status, 'available'); } finally { reopened.close(); }
  store.updateSettings({ forecastExcludedDates: [] });
  assert.deepEqual(capacity(store), before);
});

test('rolled-back reads never poison the committed capacity or evidence cache', t => {
  const store = fixture(t);
  const before = capacity(store);
  assert.throws(() => store.transaction(() => {
    store.db.exec('UPDATE usage_events SET input_tokens = input_tokens * 2, output_tokens = output_tokens * 2');
    assert.equal(capacity(store).weeklyTokens, 20_000_000);
    throw new Error('rollback synthetic write');
  }), /rollback synthetic/);
  assert.equal(capacity(store), before);
});

test('Fable weekly capacity uses matching Claude ledger events and ignores other Claude models', t => {
  const store = fixture(t, 'claude-fable', 'fable_seven_day');
  store.recordUsageEvent({ eventKey: 'other-model', sourceId: 'claude', model: 'claude-opus-5', occurredAt: new Date(NOW - HOUR).toISOString(), inputTokens: 99_000_000 });
  const result = capacity(store, NOW, store.getSettings(), 'claude-fable');
  assert.equal(result.status, 'available');
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.deepEqual(result.modelMix, [{ model: 'claude-fable-5', share: 1 }]);
});

test('current remaining estimate expires exactly at reset and clock rollback restores it', t => {
  const store = fixture(t);
  // Keep enough calibration history while making the most recent reading fresh at reset.
  const reset = NOW + 30_000;
  store.db.prepare('UPDATE quota_observations SET resets_at = ?').run(new Date(reset).toISOString());
  const before = capacity(store, reset - 1);
  assert.equal(before.remainingTokens, 6_000_000);
  assert.equal(capacity(store, reset).remainingTokens, null);
  assert.equal(capacity(store, reset - 1).remainingTokens, before.remainingTokens);
});

test('a future observation becomes eligible exactly on time without a database write', t => {
  const store = fixture(t);
  const future = NOW + 20_000;
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:weekly', observedAt: new Date(future).toISOString(),
    resetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString(), usedPercent: 41, remainingPercent: 59, windowMinutes: 10080,
    provenance: 'official', metadata: { limitId: 'codex' } });
  assert.equal(capacity(store, future - 1).remainingTokens, 6_000_000);
  const arrived = capacity(store, future);
  assert.equal(arrived.remainingAsOf, new Date(future).toISOString());
  assert.equal(arrived.remainingTokens, arrived.weeklyTokens * 0.59);
});
