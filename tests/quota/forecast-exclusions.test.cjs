'use strict';
require('../setup.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveLearningSamples, forecastQuota } = require('../../electron/forecast.cjs');
const { UsageStore } = require('../../electron/store.cjs');

const HOUR = 3_600_000;
const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
const local = (day, hour = 0, month = 8) => new Date(2026, month, day, hour).getTime();
const row = (observedAt, usedPercent, resetsAt = local(10), windowMinutes = 10_080) => ({
  observedAt, usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes, provenance: 'official',
});
const unusualDay = () => [
  [3, 0, 0], [3, 12, 1], [4, 0, 2], [4, 12, 32], [5, 0, 62],
  [5, 12, 63], [6, 0, 64], [6, 12, 65], [7, 0, 66], [7, 12, 67],
].map(([day, hour, used]) => row(local(day, hour), used));

test('ignoring a busy day removes its learning and cumulative anchor burn without changing actual quota', () => {
  const observations = unusualDay();
  const options = { now: local(7, 12), schedule };
  const original = forecastQuota(observations, options);
  const ignored = forecastQuota(observations, { ...options, excludedDates: ['2026-09-04'] });
  assert.ok(ignored.expectedRemaining > original.expectedRemaining + 10);
  assert.ok(ignored.heavyRemaining > original.heavyRemaining);
  assert.ok(Math.abs(ignored.windowPace - 7 / 84) < 1e-10, 'only clean usage and clean elapsed exposure anchor the pace');
  assert.equal(ignored.estimatedCurrentRemaining, 33);
  assert.deepEqual(ignored.series.observed, original.series.observed);
  assert.equal(ignored.series.expected[0].remaining, 33);
  assert.equal(ignored.activeHoursLeft, original.activeHoursLeft);
  const samples = deriveLearningSamples(observations, schedule, options.now, ['2026-09-04']);
  assert.equal(samples.reduce((sum, sample) => sum + sample.delta, 0), 7);
  assert.ok(samples.every((sample) => sample.dailyDeltas.every((entry) => entry.day !== '2026-09-04')));
  assert.equal(ignored.learnedDays, 4);
  assert.deepEqual(forecastQuota(observations, { ...options, excludedDates: [] }), original, 'removal restores the original forecast');
});

test('a quiet ignored day cannot dilute a following burst through the smoothing span', () => {
  const observations = [row(local(3, 12), 0), row(local(4, 12), 0), row(local(5, 0), 0), row(local(5, 1), 2)];
  const samples = deriveLearningSamples(observations, schedule, local(5, 1), ['2026-09-04']);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].rate, 2);
  assert.equal(samples[0].coveredHours, 1);
  assert.deepEqual(samples[0].dailyDeltas, [{ day: '2026-09-05', delta: 2 }]);
});

test('sparse intervals across an excluded day are discarded without redistributing their usage', () => {
  const observations = [row(local(3, 12), 0), row(local(5, 12), 60), row(local(5, 13), 61)];
  const options = { now: local(5, 13), schedule, excludedDates: ['2026-09-04'] };
  const forecast = forecastQuota(observations, options);
  assert.equal(forecast.windowPace, 1);
  assert.equal(deriveLearningSamples(observations, schedule, options.now, options.excludedDates)
    .reduce((sum, sample) => sum + sample.delta, 0), 1);
  const noCleanEvidence = forecastQuota(observations.slice(0, 2), { ...options, now: local(5, 12) });
  assert.equal(noCleanEvidence.windowPace, null);
  assert.equal(noCleanEvidence.learnedSamples, 0);
  assert.equal(noCleanEvidence.estimatedCurrentRemaining, 40);
});

test('percentage jitter after an ignored day cannot relearn already-counted usage', () => {
  const observations = [row(local(4, 12), 60), row(local(5, 0), 59), row(local(5, 1), 60), row(local(5, 2), 61)];
  const options = { now: local(5, 2), schedule, excludedDates: ['2026-09-04'] };
  const samples = deriveLearningSamples(observations, schedule, options.now, options.excludedDates);
  assert.equal(samples.reduce((sum, sample) => sum + sample.delta, 0), 1);
  assert.equal(forecastQuota(observations, options).windowPace, 0.5);
});

test('excluded off-schedule usage cannot reappear in the night-time budget or heavy scenario', () => {
  const observations = unusualDay();
  const options = { now: local(7, 12), schedule: { ...schedule, activeDays: [] } };
  const original = forecastQuota(observations, options);
  const ignored = forecastQuota(observations, { ...options, excludedDates: ['2026-09-04'] });
  assert.ok(ignored.expectedRemaining > original.expectedRemaining + 10);
  assert.ok(ignored.heavyRemaining > original.heavyRemaining);
  assert.equal(ignored.estimatedCurrentRemaining, 33);
});

test('prior-window anchors also exclude a busy day after the allowance resets', () => {
  const priorReset = local(7);
  const observations = unusualDay().filter((entry) => entry.observedAt <= priorReset)
    .map((entry) => ({ ...entry, resetsAt: priorReset }));
  observations.push(row(priorReset, 0, local(14)));
  const options = { now: priorReset, schedule };
  const original = forecastQuota(observations, options);
  const ignored = forecastQuota(observations, { ...options, excludedDates: ['2026-09-04'] });
  assert.equal(ignored.estimatedCurrentRemaining, 100);
  assert.equal(ignored.windowPace, null);
  assert.ok(ignored.recentPace < original.recentPace / 3);
  assert.ok(ignored.expectedRemaining > original.expectedRemaining + 20);
});

test('excluding today or a future date never shortens future working hours', () => {
  const observations = unusualDay();
  const options = { now: local(7, 12), schedule };
  const original = forecastQuota(observations, options);
  for (const excludedDates of [['2026-09-07'], ['2026-09-08']]) {
    const ignored = forecastQuota(observations, { ...options, excludedDates });
    assert.equal(ignored.activeHoursLeft, original.activeHoursLeft);
    assert.equal(ignored.series.expected.at(-1).at, original.series.expected.at(-1).at);
    assert.deepEqual(ignored.series.observed, original.series.observed);
    assert.equal(ignored.estimatedCurrentRemaining, 33);
  }
});

test('unrelated old and future exclusions preserve the complete forecast including confidence', () => {
  const observations = [row(local(3, 12), 0), row(local(5, 12), 2)];
  const options = { now: local(5, 12), schedule };
  const original = forecastQuota(observations, options);
  assert.equal(original.learnedDays, 1);
  for (const excludedDates of [['2020-01-01'], ['2026-09-09'], ['2020-01-01', '2026-09-09']]) {
    assert.deepEqual(forecastQuota(observations, { ...options, excludedDates }), original);
  }
});

for (const [month, day, hours] of [[2, 29, 23], [9, 25, 25]]) {
  test(`exclusions follow the ${hours}-hour Europe/London local day across DST`, () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Europe/London';
    try {
      const start = local(day, 0, month);
      const end = local(day + 1, 0, month);
      assert.equal((end - start) / HOUR, hours);
      const reset = end + 24 * HOUR;
      const observations = [row(start - HOUR, 0, reset), row(start, 1, reset),
        row(end, 51, reset), row(end + HOUR, 52, reset)];
      const excludedDates = [`2026-${String(month + 1).padStart(2, '0')}-${day}`];
      const samples = deriveLearningSamples(observations, schedule, end + HOUR, excludedDates);
      assert.equal(samples.reduce((sum, sample) => sum + sample.delta, 0), 2);
      assert.equal(samples.reduce((sum, sample) => sum + sample.coveredHours, 0), 2);
      assert.ok(samples.every((sample) => sample.dailyDeltas.every((entry) => entry.day !== excludedDates[0])));
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-forecast-exclusions-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'backups'));
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ai-usage-forecast-exclusions-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

test('excluded dates validate atomically and are stored as unique sorted calendar dates', (t) => {
  const store = fixture(t);
  assert.deepEqual(store.getSettings().forecastExcludedDates, []);
  const dates = ['2026-09-04', '2024-02-29', '2026-09-04'];
  assert.deepEqual(store.updateSettings({ forecastExcludedDates: dates }).forecastExcludedDates, ['2024-02-29', '2026-09-04']);
  for (const invalid of [null, '2026-09-04', ['2026-02-29'], ['2026-02-30'], ['2026-9-04'],
    ['2019-12-31'], ['2101-01-01'], ['2026-09-04T00:00:00Z'], Array(367).fill('2026-09-04')]) {
    assert.throws(() => store.updateSettings({ theme: 'light', forecastExcludedDates: invalid }), /Invalid value for forecastExcludedDates/);
    assert.equal(store.getSettings().theme, 'system');
  }
});

test('exclusions survive reopen and backup restore while quota observations and ledger stay intact', (t) => {
  const store = fixture(t);
  store.updateSettings({ activeStartHour: 0, activeEndHour: 24 });
  for (const entry of unusualDay()) store.recordObservation({ ...entry, sourceId: 'codex', bucketId: 'codex:weekly' });
  store.recordUsageEvent({ eventKey: 'excluded-day-event', sourceId: 'codex', occurredAt: new Date(local(4, 12)).toISOString(),
    model: 'gpt-5.6-sol', inputTokens: 100_000, outputTokens: 1000 });
  const now = local(7, 12);
  const original = store.getQuota('codex', store.getSettings(), now);
  const costs = store.getCostAnalytics(30, store.getSettings(), now);
  const ledger = store.exportLedgerCsv(30, now);
  const observations = store.prepare('SELECT * FROM quota_observations').all();
  store.updateSettings({ forecastExcludedDates: ['2026-09-04'] });
  const ignored = store.getQuota('codex', store.getSettings(), now);
  assert.ok(ignored.forecast.expectedRemaining > original.forecast.expectedRemaining);
  assert.equal(ignored.remainingPercent, original.remainingPercent);
  assert.deepEqual(store.getCostAnalytics(30, store.getSettings(), now), costs);
  assert.deepEqual(store.exportLedgerCsv(30, now), ledger);
  assert.deepEqual(store.prepare('SELECT * FROM quota_observations').all(), observations);
  const reopened = new UsageStore(store.databasePath, store.backupDirectory);
  try { assert.deepEqual(reopened.getSettings().forecastExcludedDates, ['2026-09-04']); }
  finally { reopened.close(); }
  const payload = store.readExport(store.createBackup().exportPath);
  const target = fixture(t);
  target.restoreFromExport(payload);
  assert.deepEqual(target.getSettings().forecastExcludedDates, ['2026-09-04']);
  assert.deepEqual(target.getCostAnalytics(30, target.getSettings(), now), costs);
  assert.equal(target.getQuota('codex', target.getSettings(), now).forecast.expectedRemaining, ignored.forecast.expectedRemaining);
  store.updateSettings({ forecastExcludedDates: [] });
  assert.deepEqual(store.getQuota('codex', store.getSettings(), now).forecast, original.forecast);
});

test('restore rejects invalid date lists and normalizes accepted lists', (t) => {
  const store = fixture(t);
  const invalid = store.restoreFromExport({ schemaVersion: 1, settings: { forecastExcludedDates: ['2026-02-30'] } });
  assert.equal(invalid.skipped, 1);
  assert.deepEqual(store.getSettings().forecastExcludedDates, []);
  store.restoreFromExport({ schemaVersion: 1, settings: { forecastExcludedDates: ['2026-09-05', '2026-09-04', '2026-09-05'] } });
  assert.deepEqual(store.getSettings().forecastExcludedDates, ['2026-09-04', '2026-09-05']);
});
