'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const { forecastQuota, deriveLearningSamples } = require('../../electron/forecast.cjs');
const { iso } = require('../helpers/time.cjs');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SKEW = 5 * 60_000;
const NOW = Date.parse('2026-09-01T12:00:00Z');
const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
const observation = (observedAt = NOW, resetsAt = NOW + 7 * DAY) => ({
  observedAt: iso(observedAt), resetsAt: iso(resetsAt),
  usedPercent: 10, remainingPercent: 90, windowMinutes: 10_080,
});
const exported = (row, bucket = 'weekly') => ({
  source_id: 'codex', bucket_id: bucket, observed_at: row.observedAt, resets_at: row.resetsAt,
  used_percent: row.usedPercent, remaining_percent: row.remainingPercent,
  window_minutes: row.windowMinutes, provenance: 'official',
});

test('forecast rejects an unsupported horizon rather than expanding or truncating it', () => {
  const result = forecastQuota([observation(NOW, NOW + 32 * DAY)], { now: NOW, schedule });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(result.series.expected, []);
  assert.equal(result.expectedRemaining, null);
});

test('future buckets are skipped on restore while legitimate history remains', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-quota-time-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const future = Date.parse('2099-12-01T00:00:00Z');
    const malicious = Array.from({ length: 50 }, (_, i) => exported(observation(future, future + DAY), `future-${i}`));
    const result = store.restoreFromExport({ schemaVersion: 1, observations: [
      ...malicious, exported(observation()),
      exported(observation(NOW - 120 * DAY, NOW - 113 * DAY), 'dormant'),
    ] });
    assert.equal(result.skipped, 50);
    assert.equal(result.observations, 2);
    const quota = store.getDashboardSnapshot(30, NOW).quotas.codex;
    assert.equal(quota.windows.length, 2);
    assert.equal(quota.windows.find((row) => row.bucketId === 'dormant').forecast.expired, true);
    assert.notEqual(quota.windows.find((row) => row.bucketId === 'weekly').forecast.state, 'unknown');
  } finally { store.close(); }
});

test('already persisted future rows cannot poison snapshots before or after reopening', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-quota-reopen-'));
  const databasePath = path.join(root, 'test.sqlite');
  const backups = path.join(root, 'Backups');
  let store = new UsageStore(databasePath, backups);
  try {
    store.restoreFromExport({ schemaVersion: 1, observations: [
      exported(observation()), exported(observation(NOW - 120 * DAY, NOW - 113 * DAY), 'dormant'),
    ] });
    // Bypass ingestion to model data accepted by an older application version.
    const insert = store.db.prepare(`INSERT INTO quota_observations
      (source_id, bucket_id, observed_at, resets_at, used_percent, remaining_percent, window_minutes, provenance)
      VALUES ('codex', ?, ?, ?, 10, 90, 10080, 'official')`);
    const future = Date.parse('2099-12-01T00:00:00Z');
    for (const bucket of ['weekly', 'dormant', ...Array.from({ length: 50 }, (_, i) => `future-${i}`)]) {
      insert.run(bucket, iso(future), iso(future + DAY));
    }
    // Also exclude malformed intervals/window lengths already stored locally.
    insert.run('invalid-reset', iso(NOW), iso(future));
    insert.run('invalid-window', iso(NOW), iso(NOW + DAY));
    store.db.prepare("UPDATE quota_observations SET window_minutes = 999999999 WHERE bucket_id = 'invalid-window'").run();
    for (let pass = 0; pass < 2; pass += 1) {
      const quota = store.getDashboardSnapshot(30, NOW).quotas.codex;
      assert.deepEqual(quota.windows.map((row) => row.bucketId).sort(), ['dormant', 'weekly']);
      assert.equal(quota.windows.find((row) => row.bucketId === 'dormant').forecast.expired, true);
      assert.equal(quota.windows.find((row) => row.bucketId === 'weekly').observedAt, iso(NOW));
      if (pass === 0) { store.close(); store = new UsageStore(databasePath, backups); }
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM quota_observations').get().n, 56);
  } finally { store.close(); }
});

test('live writes and restore share the inclusive five-minute observation tolerance', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-quota-skew-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const row = observation(NOW + SKEW, NOW + SKEW + 31 * DAY);
    row.windowMinutes = 31 * 24 * 60;
    store.recordObservation({ ...row, sourceId: 'codex', bucketId: 'live' });
    assert.throws(() => store.recordObservation({ ...row, observedAt: iso(NOW + SKEW + 1), sourceId: 'codex', bucketId: 'bad' }), /future/i);
    const result = store.restoreFromExport({ schemaVersion: 1, observations: [
      exported(row, 'import'), exported({ ...row, observedAt: iso(NOW + SKEW + 1) }, 'bad'),
    ] });
    assert.equal(result.observations, 1);
    assert.equal(result.skipped, 1);
    assert.equal(store.getQuota('codex', store.getSettings(), NOW).windows.length, 2);
  } finally { store.close(); }
});

test('malformed latest rows do not hide the latest valid dormant quota', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const store = new UsageStore(':memory:', os.tmpdir());
  try {
    const valid = observation(NOW - 120 * DAY, NOW - 113 * DAY);
    store.recordObservation({ ...valid, sourceId: 'codex', bucketId: 'dormant' });
    const insert = store.db.prepare(`INSERT INTO quota_observations
      (source_id, bucket_id, observed_at, resets_at, used_percent, remaining_percent, window_minutes, provenance)
      VALUES ('codex', 'dormant', ?, ?, 10, 90, ?, 'official')`);
    for (const [observed, reset, window] of [
      [NOW - 100 * DAY, NOW + DAY, 10080],
      [NOW - DAY, NOW, 999999999],
      [NOW, NOW + 32 * DAY, 10080],
    ]) {
      insert.run(iso(observed), iso(reset), window);
      const quota = store.getQuota('codex', store.getSettings(), NOW);
      assert.equal(quota.windows.length, 1);
      assert.equal(quota.windows[0].observedAt, valid.observedAt);
      assert.equal(quota.windows[0].forecast.expired, true);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM quota_observations').get().n, 4);
  } finally { store.close(); }
});

test('direct forecasting excludes distant dates, invalid windows and equivalent timestamp forms', () => {
  const future = Date.parse('2099-12-01T00:00:00Z');
  for (const row of [
    observation(future, future + DAY),
    { ...exported(observation(future, future + DAY)), observed_at: '2099-12-01T01:00:00+01:00' },
    { ...observation(), windowMinutes: 999999999 },
    { ...observation(), windowMinutes: Infinity },
    { ...observation(), resetsAt: 'not a date' },
    observation(NOW - 1000 * DAY, NOW + DAY),
    { ...observation(future, future + DAY), usedPercent: 100, remainingPercent: 0 },
  ]) {
    assert.equal(forecastQuota([row], { now: NOW, schedule }).state, 'unknown');
    assert.deepEqual(forecastQuota([observation(), row], { now: NOW, schedule }), forecastQuota([observation()], { now: NOW, schedule }));
  }
  assert.equal(forecastQuota([observation()], { now: 'invalid' }).state, 'unknown');
});

test('learning cannot expand an idle rolling window across decades of valid historical dates', () => {
  const ancient = { ...observation(NOW - 2000 * DAY, NOW - 1993 * DAY), usedPercent: 0, remainingPercent: 100 };
  const recent = { ...observation(), usedPercent: 0, remainingPercent: 100 };
  assert.deepEqual(deriveLearningSamples([ancient, recent], schedule, NOW), []);
  assert.deepEqual(forecastQuota([ancient, recent], { now: NOW, schedule }), forecastQuota([recent], { now: NOW, schedule }));
});

test('five-hour, weekly and maximum windows retain their true reset and strict series budget', () => {
  for (const duration of [5 * HOUR, 7 * DAY, 31 * DAY]) {
    for (const remaining of [90, 0]) {
      const row = { ...observation(NOW + SKEW, NOW + SKEW + duration),
        windowMinutes: duration / 60_000, usedPercent: 100 - remaining, remainingPercent: remaining };
      const result = forecastQuota([row], { now: NOW, schedule });
      assert.notEqual(result.state, 'unknown');
      for (const series of [result.series.expected, result.series.heavy]) {
        assert.equal(series.length, Math.ceil((duration + SKEW) / HOUR) + 1);
        assert.ok(series.length <= 746);
        assert.equal(series.at(-1).at, NOW + SKEW + duration);
      }
      assert.ok(Number.isFinite(result.expectedRemaining));
    }
  }
});

test('cycle history skips stored rows that the quota card already rejects', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const store = new UsageStore(':memory:', os.tmpdir());
  try {
    store.recordObservation({ ...observation(NOW - 8 * DAY, NOW - DAY), usedPercent: 40, remainingPercent: 60, sourceId: 'codex', bucketId: 'weekly' });
    store.recordObservation({ ...observation(NOW - DAY + HOUR, NOW + 6 * DAY), sourceId: 'codex', bucketId: 'weekly' });
    // Bypass ingestion to model rows an older application version accepted.
    const insert = store.db.prepare(`INSERT INTO quota_observations
      (source_id, bucket_id, observed_at, resets_at, used_percent, remaining_percent, window_minutes, provenance)
      VALUES ('codex', 'weekly', ?, ?, 95, 5, ?, 'official')`);
    for (const [observed, reset, window] of [
      [NOW - 10 * HOUR, NOW + 89 * DAY, 10080],
      [NOW + SKEW + 1, NOW + 3 * DAY, 10080],
      [NOW - 11 * HOUR, NOW - 11 * HOUR - SKEW - 1, 10080],
      [NOW - 12 * HOUR, NOW + 2 * DAY, 999999999],
      [NOW - 13 * HOUR, NOW + 3 * DAY, 2.5],
    ]) insert.run(iso(observed), iso(reset), window);
    const quota = store.getQuota('codex', store.getSettings(), NOW);
    const cycles = store.getCycleHistory('codex', quota, store.getSettings(), 8, NOW);
    assert.deepEqual(cycles.map((row) => [row.resetsAt, row.peakUsedPercent, row.current]), [
      [iso(NOW + 6 * DAY), 10, true],
      [iso(NOW - DAY), 40, false],
    ]);
    // Exactly at the ingest limits a row still counts, as it does for the card.
    insert.run(iso(NOW + SKEW), iso(NOW + SKEW + 31 * DAY), 31 * 24 * 60);
    const edge = store.getCycleHistory('codex', quota, store.getSettings(), 8, NOW + 1);
    assert.equal(edge[0].resetsAt, iso(NOW + SKEW + 31 * DAY));
  } finally { store.close(); }
});

test('cached cycle history admits a stored future row once the clock reaches it', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const store = new UsageStore(':memory:', os.tmpdir());
  try {
    store.recordObservation({ ...observation(NOW - DAY, NOW + 6 * DAY), sourceId: 'codex', bucketId: 'weekly' });
    // A clock that ran ahead and was then corrected leaves a row observed in the future.
    store.db.prepare(`INSERT INTO quota_observations
      (source_id, bucket_id, observed_at, resets_at, used_percent, remaining_percent, window_minutes, provenance)
      VALUES ('codex', 'weekly', ?, ?, 30, 70, 10080, 'official')`).run(iso(NOW + SKEW + HOUR), iso(NOW + 8 * DAY));
    const quota = store.getQuota('codex', store.getSettings(), NOW);
    const resets = (nowMs) => store.getCycleHistory('codex', quota, store.getSettings(), 8, nowMs).map((row) => row.resetsAt);
    assert.deepEqual(resets(NOW), [iso(NOW + 6 * DAY)]);
    assert.deepEqual(resets(NOW + HOUR - 1), [iso(NOW + 6 * DAY)]);
    assert.deepEqual(resets(NOW + HOUR), [iso(NOW + 8 * DAY), iso(NOW + 6 * DAY)]);
  } finally { store.close(); }
});
