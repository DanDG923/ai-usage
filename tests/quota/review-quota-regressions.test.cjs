'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const os = require('node:os');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const { primaryWindow } = require('../../electron/notifications.cjs');
const { estimateTokenCapacity } = require('../../electron/token-capacity.cjs');

const HOUR = 3_600_000;
const WEEK = 168 * HOUR;
const NOW = Date.parse('2026-09-09T12:00:00Z');
const iso = (at) => new Date(at).toISOString();
function fixture(t) {
  const store = new UsageStore(':memory:', os.tmpdir());
  t.after(() => store.close());
  store.updateSettings({ currency: 'USD' });
  return store;
}
function reading(store, at, reset, used, overrides = {}) {
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:primary', bucketName: 'Weekly',
    observedAt: iso(at), resetsAt: iso(reset), usedPercent: used, windowMinutes: 10080,
    provenance: 'official', metadata: { limitId: 'codex' }, ...overrides });
}
function usage(store, at, tokens, model = 'gpt-6-astra') {
  store.recordUsageEvent({ eventKey: `${at}:${model}`, sourceId: 'codex', model,
    occurredAt: iso(at), inputTokens: tokens });
}
function cycles(store, now = NOW) {
  return store.getCycleHistory('codex', { bucketId: 'codex:primary' }, store.getSettings(), 8, now);
}

test('early reset closes the superseded cycle and assigns boundary tokens only to the new cycle', t => {
  const store = fixture(t);
  const resetAt = NOW - HOUR;
  reading(store, NOW - 2 * HOUR, NOW + 24 * HOUR, 80);
  usage(store, NOW - 3 * HOUR, 1000);
  const before = cycles(store);
  reading(store, resetAt, resetAt + WEEK, 0);
  usage(store, resetAt, 2000);
  usage(store, NOW - HOUR / 2, 4000);
  const observations = store.prepare('SELECT * FROM quota_observations ORDER BY id').all();
  const history = cycles(store);
  assert.notEqual(history, before);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(row => row.current), [true, false]);
  assert.deepEqual(history.map(row => row.tokens), [6000, 1000]);
  assert.equal(history[1].endsAt, iso(resetAt));
  assert.equal(history[1].resetsAt, iso(NOW + 24 * HOUR), 'retain the reported scheduled reset');
  assert.equal(history.reduce((sum, row) => sum + row.tokens, 0), store.getCostAnalytics(30, store.getSettings(), NOW).totalTokens);
  assert.equal(cycles(store, NOW + 1), history, 'unchanged results remain cached');
  assert.deepEqual(store.prepare('SELECT * FROM quota_observations ORDER BY id').all(), observations);
});

test('idle rolling reset readings merge into the pinned cycle without erasing a prior used cycle', t => {
  const store = fixture(t);
  const started = NOW - 24 * HOUR;
  reading(store, started - 2 * HOUR, NOW + 24 * HOUR, 80);
  reading(store, started, started + WEEK, 0);
  reading(store, started + 3 * 60_000, started + WEEK + 3 * 60_000, 0);
  reading(store, started + 14 * 60_000, started + WEEK + 12 * 60_000, 1);
  reading(store, NOW - HOUR, started + WEEK + 12 * 60_000, 10);
  usage(store, started - HOUR, 1000);
  usage(store, started + 13 * 60_000, 2000);
  const history = cycles(store);
  assert.equal(history.length, 2);
  assert.equal(history[0].readings, 4);
  assert.equal(history[0].peakUsedPercent, 10);
  assert.equal(history[0].resetsAt, iso(started + WEEK + 12 * 60_000));
  assert.deepEqual(history.map(row => row.current), [true, false]);
  assert.deepEqual(history.map(row => row.tokens), [2000, 1000]);
});

test('ordinary nonoverlapping cycles and idle cycles separated by a full week stay separate', t => {
  const store = fixture(t);
  const start = NOW - WEEK - HOUR;
  reading(store, start, start + WEEK, 0);
  reading(store, NOW - HOUR, NOW - HOUR + WEEK, 0);
  usage(store, NOW - 2 * HOUR, 1000);
  usage(store, NOW - HOUR, 2000);
  const history = cycles(store);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(row => row.tokens), [2000, 1000]);
  assert.deepEqual(history.map(row => row.current), [true, false]);
});

for (const bucketId of ['codex:primary', 'codex:secondary']) {
  test(`manual weekly reading keeps ${bucketId} primary when Spark and a short main window exist`, t => {
    const store = fixture(t);
    const reset = NOW + 24 * HOUR;
    reading(store, NOW - 2 * HOUR, reset, 60, { bucketId });
    reading(store, NOW - 2 * HOUR, NOW + HOUR, 10, {
      bucketId: bucketId === 'codex:primary' ? 'codex:secondary' : 'codex:primary', windowMinutes: 300,
    });
    reading(store, NOW - 2 * HOUR, NOW + 6 * 24 * HOUR, 0, {
      bucketId: 'codex_bengalfox:secondary', metadata: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark' },
    });
    reading(store, NOW - HOUR, reset, 61, { bucketId: store.getManualBucketId('codex'),
      provenance: 'manual-official', metadata: { note: 'Manual reading', sharedWithOverall: false } });
    const snapshot = store.getDashboardSnapshot(30, NOW);
    assert.equal(snapshot.quotas.codex.bucketId, bucketId);
    assert.equal(primaryWindow(snapshot.quotas.codex).bucketId, bucketId);
    assert.equal(snapshot.cycles.codex[0].resetsAt, iso(reset));
    assert.equal(snapshot.cycles.codex[0].peakUsedPercent, 61);
  });
}

test('Spark activity cannot change main Codex token-capacity calibration or remaining tokens', () => {
  const input = { sourceId: 'codex', bucketId: 'codex:primary', nowMs: NOW,
    observations: [0, 1, 2, 3].map(index => ({ source_id: 'codex', bucket_id: 'codex:primary',
      observed_at: iso(NOW - (3 - index) * 12 * HOUR), resets_at: iso(NOW + 72 * HOUR),
      used_percent: 10 + index * 10, remaining_percent: 90 - index * 10, window_minutes: 10080,
      provenance: 'official', metadata_json: '{"limitId":"codex"}' })),
    events: [0, 1, 2].map(index => ({ source_id: 'codex', model: 'gpt-6-astra',
      occurred_at: iso(NOW - (2.5 - index) * 12 * HOUR), input_tokens: 100000 })),
  };
  const baseline = estimateTokenCapacity(input);
  assert.equal(baseline.weeklyTokens, 1000000);
  for (const model of ['gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark', 'gpt-5.3-codex-spark-20260901']) {
    const spark = input.events.map(event => ({ ...event, model, input_tokens: 900000 }));
    assert.deepEqual(estimateTokenCapacity({ ...input, events: [...input.events, ...spark] }), baseline);
    assert.equal(estimateTokenCapacity({ ...input, events: spark }).weeklyTokens, null);
  }
});
