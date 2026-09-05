'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const DAY = 86400000;
const NOW = Date.parse('2026-09-05T12:00:00Z');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-cache-'));
  const store = new UsageStore(path.join(directory, 'test.sqlite'), directory);
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(directory, `test.sqlite${suffix}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  store.updateSettings({ currency: 'USD' });
  return store;
}
function event(store, key = 'one', at = NOW, tokens = 100000) {
  store.recordUsageEvent({ eventKey: key, sourceId: 'claude', model: 'claude-fable-5',
    occurredAt: new Date(at).toISOString(), inputTokens: tokens });
}
function costs(store, now = NOW, days = 7, settings = store.getSettings()) {
  return store.getCostAnalytics(days, settings, now);
}

test('unchanged analytics survive forecast time changes and selected-period switches', t => {
  const store = fixture(t);
  event(store);
  const first = costs(store);
  assert.equal(costs(store, NOW + 21000), first);
  costs(store, NOW, 30);
  assert.equal(costs(store, NOW + 22000), first);
  assert.equal(first.actual, 1);
});

test('cache tracks the inclusive rolling boundary exactly and handles clock rollback', t => {
  const store = fixture(t);
  event(store, 'boundary', NOW - 7 * DAY);
  assert.equal(costs(store).actual, 1);
  assert.equal(costs(store, NOW + 1).actual, 0);
  assert.equal(costs(store, NOW - 1).actual, 1);
});

test('local updates, price edits, currency and conversion changes cannot reuse stale costs', t => {
  const store = fixture(t);
  event(store);
  assert.equal(costs(store).actual, 1);
  event(store, 'one', NOW, 200000);
  assert.equal(costs(store).actual, 2);
  store.updatePrice({ model: 'claude-fable-5', inputUsdPerMillion: 20,
    cacheWriteUsdPerMillion: 25, cacheWrite1hUsdPerMillion: 40, cacheReadUsdPerMillion: 2, outputUsdPerMillion: 100 });
  assert.equal(costs(store).actual, 4);
  const gbp = costs(store, NOW, 7, { currency: 'GBP', usdToCurrency: 0.5 });
  assert.equal(gbp.actual, 2);
  assert.equal(gbp.currency, 'GBP');
  assert.equal(costs(store, NOW, 7, { currency: 'GBP', usdToCurrency: 0.75 }).actual, 3);
});

test('a collector connection updating existing rows invalidates cached analytics', t => {
  const store = fixture(t);
  event(store);
  assert.equal(costs(store).actual, 1);
  const writer = new DatabaseSync(store.databasePath);
  try { writer.exec('UPDATE usage_events SET input_tokens = 300000'); } finally { writer.close(); }
  assert.equal(costs(store).actual, 3);
});

test('transaction rollback never leaves uncommitted totals in the cache', t => {
  const store = fixture(t);
  event(store);
  assert.equal(costs(store).actual, 1);
  assert.throws(() => store.transaction(() => {
    event(store, 'two');
    assert.equal(costs(store).actual, 2);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(costs(store).actual, 1);
});

test('empty caches notice new records and imported exports', t => {
  const store = fixture(t);
  assert.equal(costs(store).actual, 0);
  store.restoreFromExport({ schemaVersion: 1, usageEvents: [{ event_key: 'imported', source_id: 'claude',
    model: 'claude-fable-5', occurred_at: new Date(NOW).toISOString(), input_tokens: 100000 }] });
  assert.equal(costs(store).actual, 1);
});

test('legacy and explicit TTL records retain matching per-category token and cost totals', t => {
  const store = fixture(t);
  for (const [key, total, five, hour] of [['legacy', 100000, 0, 0], ['hour', 200000, 0, 200000], ['five', 50000, 50000, 0]]) {
    store.recordUsageEvent({ eventKey: key, sourceId: 'claude', model: 'claude-fable-5',
      occurredAt: new Date(NOW).toISOString(), cacheWriteInputTokens: total,
      cacheWrite5mInputTokens: five, cacheWrite1hInputTokens: hour });
  }
  const row = costs(store).byModel[0];
  assert.equal(row.cacheWrite5mInputTokens, 150000);
  assert.equal(row.cacheWrite1hInputTokens, 200000);
  assert.equal(row.costBreakdown.cacheWrite5m, 1.875);
  assert.equal(row.costBreakdown.cacheWrite1h, 4);
  assert.equal(new Set(costs(store).sessions.map(session => session.sessionId)).size, 3);
});

function reading(store, { sourceId = 'claude-fable', bucketId = 'fable_seven_day', at = NOW - 1000, reset = NOW + DAY, used = 30 } = {}) {
  store.recordObservation({ sourceId, bucketId, observedAt: new Date(at).toISOString(),
    resetsAt: new Date(reset).toISOString(), usedPercent: used, remainingPercent: 100 - used,
    windowMinutes: 10080, provenance: 'official' });
}
function cycles(store, now = NOW, settings = store.getSettings(), sourceId = 'claude-fable', bucketId = 'fable_seven_day') {
  return store.getCycleHistory(sourceId, { bucketId }, settings, 8, now);
}

test('unchanged cycle history is cached while current events, reset boundaries and clock rollback stay exact', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'past', NOW - 1000);
  event(store, 'future', NOW + 5000);
  const first = cycles(store);
  assert.equal(first[0].cost, 1);
  assert.equal(cycles(store, NOW + 5000), first, 'the upper event boundary is exclusive');
  assert.equal(cycles(store, NOW + 5001)[0].cost, 2);
  assert.equal(cycles(store, NOW + DAY - 1)[0].current, true);
  assert.equal(cycles(store, NOW + DAY)[0].current, false);
  assert.equal(cycles(store, NOW - 1001)[0].cost, 0);
  assert.equal(cycles(store, NOW - 1001)[0].current, true);
  assert.deepEqual(cycles(store), store.buildCycleHistory('claude-fable', { bucketId: 'fable_seven_day' }, store.getSettings(), 8, NOW));
});

test('cycle history invalidates for local events, observations, prices and currency conversion', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  const first = cycles(store);
  assert.equal(cycles(store, NOW + 21000), first);
  event(store, 'one', NOW - 1000, 200000);
  assert.equal(cycles(store)[0].cost, 2);
  reading(store, { used: 60 });
  assert.equal(cycles(store)[0].peakUsedPercent, 60);
  store.updatePrice({ model: 'claude-fable-5', inputUsdPerMillion: 20,
    cacheWriteUsdPerMillion: 25, cacheWrite1hUsdPerMillion: 40, cacheReadUsdPerMillion: 2, outputUsdPerMillion: 100 });
  assert.equal(cycles(store)[0].cost, 4);
  assert.equal(cycles(store, NOW, { currency: 'GBP', usdToCurrency: 0.5 })[0].cost, 2);
  store.updateSettings({ currency: 'GBP', usdToCurrency: 0.75 });
  assert.equal(cycles(store)[0].cost, 3);
});

test('collector commits invalidate cycle and full-session caches even when row IDs are unchanged', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  assert.equal(cycles(store)[0].cost, 1);
  assert.equal(store.getSessionPage({}, NOW).rows[0].cost, 1);
  const writer = new DatabaseSync(store.databasePath);
  try { writer.exec('UPDATE usage_events SET input_tokens = 300000; UPDATE quota_observations SET used_percent = 75'); }
  finally { writer.close(); }
  assert.equal(cycles(store)[0].cost, 3);
  assert.equal(cycles(store)[0].peakUsedPercent, 75);
  assert.equal(store.getSessionPage({}, NOW).rows[0].cost, 3);
});

test('transactional cycle reads bypass caches and rolled-back data cannot survive', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  assert.equal(cycles(store)[0].cost, 1);
  assert.throws(() => store.transaction(() => {
    event(store, 'two', NOW - 500);
    reading(store, { used: 90 });
    assert.equal(cycles(store)[0].cost, 2);
    assert.equal(cycles(store)[0].peakUsedPercent, 90);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(cycles(store)[0].cost, 1);
  assert.equal(cycles(store)[0].peakUsedPercent, 30);
});

test('cycle cache is bounded, keeps model scopes separate and notices restored history', t => {
  const store = fixture(t);
  assert.deepEqual(cycles(store), []);
  store.restoreFromExport({ schemaVersion: 1, observations: [{ source_id: 'claude-fable', bucket_id: 'fable_seven_day',
    observed_at: new Date(NOW - 1000).toISOString(), resets_at: new Date(NOW + DAY).toISOString(),
    used_percent: 30, remaining_percent: 70, window_minutes: 10080, provenance: 'official' }] });
  assert.equal(cycles(store).length, 1);
  reading(store, { sourceId: 'claude', bucketId: 'seven_day' });
  event(store, 'fable', NOW - 1000);
  store.recordUsageEvent({ eventKey: 'opus', sourceId: 'claude', model: 'claude-opus-5',
    occurredAt: new Date(NOW - 1000).toISOString(), inputTokens: 200000 });
  assert.equal(cycles(store)[0].tokens, 100000);
  assert.equal(cycles(store, NOW, store.getSettings(), 'claude', 'seven_day')[0].tokens, 300000);
  for (let rate = 1; rate <= 20; rate += 1) cycles(store, NOW, { currency: 'USD', usdToCurrency: rate });
  assert.equal(store.cycleHistoryCache.size, 12);
});
