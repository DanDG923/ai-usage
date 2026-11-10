'use strict';
require('../setup.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveLearningSamples, forecastQuota } = require('../../electron/forecast.cjs');

const HOUR = 3_600_000;
const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
const local = (day, hour = 0, minute = 0, month = 8) => new Date(2026, month, day, hour, minute).getTime();
const row = (observedAt, usedPercent, resetsAt = local(8)) => ({
  observedAt, usedPercent, remainingPercent: 100 - usedPercent, resetsAt,
  windowMinutes: 10_080, provenance: 'official', sourceId: 'codex', bucketId: 'codex:weekly',
});
function fixture({ heavy = 30, current = true } = {}) {
  const observations = [0, 2, 4, 6, 6 + heavy].map((used, index) => row(local(index + 1), used));
  observations.push(row(local(5, 0, 15), 0, local(12, 0, 15)));
  if (current) observations.push(row(local(5, 12, 15), 1, local(12, 0, 15)));
  return { observations, options: { now: observations.at(-1).observedAt, schedule } };
}
// The existing forecast accepts generic official-prefixed provenance. This
// heuristic requires an explicitly supported source. Using an unrecognized
// official prefix preserves ordinary cycle grouping while suppressing only the
// new adjustment; all sample weights change by the same constant.
const unqualified = (rows) => rows.map((entry) => ({ ...entry, provenance: 'official-unrecognized' }));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test('a proven early reset reduces a heavy previous day to quarter influence and retains actual usage', () => {
  const { observations, options } = fixture();
  const before = structuredClone(observations);
  const adjusted = forecastQuota(observations, options);
  const ordinary = forecastQuota(unqualified(observations), options);
  assert.deepEqual(adjusted.resetAdjustment, {
    resetAt: new Date(local(5, 0, 15)).toISOString(), dates: ['2026-09-04'], weight: 0.25,
  });
  assert.ok(adjusted.expectedRemaining > ordinary.expectedRemaining + 15);
  assert.ok(adjusted.recentPace < ordinary.recentPace * 0.6, 'prior cumulative anchor and recent momentum both respect the adjustment');
  close(adjusted.heavyRemaining, ordinary.heavyRemaining, 'the heavier case retains the full workload');
  assert.equal(adjusted.estimatedCurrentRemaining, 99);
  assert.equal(adjusted.series.expected[0].remaining, 99);
  assert.deepEqual(adjusted.series.observed, ordinary.series.observed);
  assert.equal(adjusted.activeHoursLeft, ordinary.activeHoursLeft);
  assert.deepEqual(observations, before, 'quota inputs are never mutated');
  close(deriveLearningSamples(observations, schedule, options.now).reduce((sum, sample) => sum + sample.delta, 0), 37, 'all observed usage remains in learning evidence');
});

test('a fresh cycle cannot relearn the busy day through its prior anchor or a recent-only subset', () => {
  const { observations, options } = fixture({ current: false });
  const adjusted = forecastQuota(observations, options);
  const ordinary = forecastQuota(unqualified(observations), options);
  assert.ok(adjusted.resetAdjustment);
  assert.equal(adjusted.windowPace, null);
  assert.equal(adjusted.estimatedCurrentRemaining, 100);
  assert.ok(adjusted.workingPace < ordinary.workingPace * 0.4, 'weighting must not cancel when every recent sample is the busy day');
  assert.ok(adjusted.recentPace < ordinary.recentPace * 0.55);
  assert.ok(adjusted.expectedRemaining > ordinary.expectedRemaining + 25);
});

test('weighting the heavy day preserves known quiet window exposure before the first reading', () => {
  const observations = [0, 1, 2, 3].map((used, index) => row(local(29 + index, 0, 0, 7), used, local(3)));
  observations.push(row(local(6), 0), row(local(7), 40), row(local(7, 0, 10), 0));
  const options = { now: local(7, 0, 10), schedule };
  const adjusted = forecastQuota(observations, options);
  const ordinary = forecastQuota(unqualified(observations), options);
  assert.deepEqual(adjusted.resetAdjustment?.dates, ['2026-09-06']);
  assert.ok(adjusted.recentPace < ordinary.recentPace, 'quarter weighting cannot discard five known quiet days and inflate prior pace');
  assert.ok(adjusted.expectedRemaining > ordinary.expectedRemaining);
  assert.equal(adjusted.estimatedCurrentRemaining, 100);
});

test('the adjustment keeps a heavy-case warning and consistent curves', () => {
  const { observations, options } = fixture({ heavy: 65 });
  const adjusted = forecastQuota(observations, options);
  const ordinary = forecastQuota(unqualified(observations), options);
  assert.ok(adjusted.resetAdjustment);
  assert.ok(adjusted.expectedRemaining > 0);
  // The heavier case keeps the complete workload: the adjustment never makes
  // it more optimistic, and one 65% day leaves it under the watch margin.
  assert.ok(ordinary.heavyRemaining < 10, `heavy ${ordinary.heavyRemaining}`);
  close(adjusted.heavyRemaining, ordinary.heavyRemaining, 'the heavier case retains the full workload');
  assert.equal(adjusted.heavyExhaustsAt, ordinary.heavyExhaustsAt);
  assert.equal(adjusted.state, 'watch');
  assert.equal(adjusted.exhaustsAt, null);
  adjusted.series.heavy.forEach((point, index) => assert.ok(point.remaining <= adjusted.series.expected[index].remaining));
});

test('explicitly ignored dates take precedence and never become automatic reset adjustments', () => {
  const { observations, options } = fixture();
  const adjusted = forecastQuota(observations, options);
  const excludedOptions = { ...options, excludedDates: ['2026-09-04'] };
  const ignored = forecastQuota(observations, excludedOptions);
  assert.equal(ignored.resetAdjustment, undefined);
  assert.ok(ignored.expectedRemaining > adjusted.expectedRemaining);
  assert.deepEqual(ignored.series.observed, adjusted.series.observed);
  assert.equal(ignored.estimatedCurrentRemaining, 99);
  close(ignored.expectedRemaining, forecastQuota(unqualified(observations), excludedOptions).expectedRemaining, 'explicit exclusion is the only adjustment');
  assert.equal(forecastQuota(observations, { ...options, excludedDates: ['2026-09-02'] }).resetAdjustment, undefined,
    'an ignored baseline day cannot supply the third independent day');
});

test('a heavy day without a reset retains its ordinary forecast influence', () => {
  const { observations } = fixture();
  const prior = observations.slice(0, 5);
  const options = { now: prior.at(-1).observedAt, schedule };
  const ordinary = forecastQuota(prior, options);
  assert.equal(ordinary.resetAdjustment, undefined);
  close(ordinary.expectedRemaining, forecastQuota(unqualified(prior), options).expectedRemaining, 'normal heavy usage remains unchanged');
});

test('a normal scheduled reset does not trigger heavy-day adjustment', () => {
  const { observations, options } = fixture();
  const scheduled = observations.map((entry, index) => index < 5 ? { ...entry, resetsAt: local(5, 0, 15) } : entry);
  const forecast = forecastQuota(scheduled, options);
  assert.equal(forecast.resetAdjustment, undefined);
  close(forecast.expectedRemaining, forecastQuota(unqualified(scheduled), options).expectedRemaining, 'scheduled-reset forecast is unchanged');
});

test('a moved reset timestamp alone, small corrections, and dormant gaps do not establish replenishment', () => {
  const { observations, options } = fixture();
  for (const floor of [3, 20, 36]) {
    const modified = observations.map((entry, index) => index >= 5
      ? { ...entry, usedPercent: floor + (index - 5), remainingPercent: 100 - floor - (index - 5) } : entry);
    assert.equal(forecastQuota(modified, options).resetAdjustment, undefined);
  }
  const tiny = fixture({ heavy: 12 });
  assert.equal(forecastQuota(tiny.observations, tiny.options).resetAdjustment, undefined);
  const dormant = observations.map((entry, index) => index >= 5 ? { ...entry, observedAt: entry.observedAt + 8 * HOUR } : entry);
  assert.equal(forecastQuota(dormant, { ...options, now: dormant.at(-1).observedAt }).resetAdjustment, undefined);
});

test('only explicit supported provider provenance can establish an early reset and its baseline', () => {
  const { observations, options } = fixture();
  for (const provenance of [undefined, 'derived-tokens', 'official-unrecognized', 'estimated']) {
    const modified = observations.map((entry) => ({ ...entry, provenance }));
    assert.equal(forecastQuota(modified, options).resetAdjustment, undefined);
  }
  for (const provenance of ['official', 'local-official', 'manual-official', 'official-statusline', 'official-claude-usage']) {
    assert.ok(forecastQuota(observations.map((entry) => ({ ...entry, provenance })), options).resetAdjustment);
  }
  const unprovenBaseline = observations.map((entry, index) => index < 4 ? { ...entry, provenance: undefined } : entry);
  assert.equal(forecastQuota(unprovenBaseline, options).resetAdjustment, undefined);
});

test('new or mixed buckets and different window lengths cannot supply comparable reset evidence', () => {
  const { observations, options } = fixture();
  for (const change of [{ bucketId: 'other:weekly' }, { sourceId: 'claude' }, { windowMinutes: 300 }]) {
    const modified = observations.map((entry, index) => index >= 5 ? { ...entry, ...change } : entry);
    assert.equal(forecastQuota(modified, options).resetAdjustment, undefined);
  }
  assert.equal(forecastQuota(observations.map((entry) => ({ ...entry, bucketId: undefined })), options).resetAdjustment, undefined);
  assert.equal(forecastQuota(observations.map((entry) => ({ ...entry, sourceId: undefined })), options).resetAdjustment, undefined);
  assert.equal(forecastQuota(observations.slice(-2), options).resetAdjustment, undefined);
});

test('thin history and normal-use days before early resets stay conservative', () => {
  const { observations, options } = fixture();
  assert.equal(forecastQuota(observations.slice(1), options).resetAdjustment, undefined);
  const normalDays = observations.map((entry, index) => index < 5
    ? { ...entry, usedPercent: index * 10, remainingPercent: 100 - index * 10 } : entry);
  assert.equal(forecastQuota(normalDays, options).resetAdjustment, undefined);
});

test('sparse gaps spanning dates cannot manufacture a localized heavy day or daily baseline', () => {
  const observations = [0, 2, 4, 6].map((used, index) => row(local(index + 1), used));
  observations.push(row(local(6), 66), row(local(6, 0, 15), 0, local(13, 0, 15)), row(local(6, 12, 15), 1, local(13, 0, 15)));
  const options = { now: local(6, 12, 15), schedule };
  assert.equal(forecastQuota(observations, options).resetAdjustment, undefined, 'a two-day jump does not locate usage on the preceding day');
  const sparseBaseline = [row(local(1), 0), row(local(4), 6), row(local(5), 36),
    row(local(5, 0, 15), 0, local(12, 0, 15)), row(local(5, 12, 15), 1, local(12, 0, 15))];
  assert.equal(forecastQuota(sparseBaseline, { ...options, now: local(5, 12, 15) }).resetAdjustment, undefined,
    'one multiday interval is not three independent normal days');
});

test('a replenishment before the provider updates its reset time keeps the new cycle separate', () => {
  const { observations, options } = fixture();
  const delayed = observations.map((entry) => ({ ...entry, resetsAt: local(8) }));
  const forecast = forecastQuota(delayed, options);
  assert.ok(forecast.resetAdjustment);
  assert.equal(forecast.series.observed.length, 2);
  assert.equal(forecast.series.observed[0].remaining, 100);
  assert.equal(forecast.estimatedCurrentRemaining, 99);
  close(forecast.windowPace, 1 / 12, 'the new window starts at the observed replenishment');
  close(deriveLearningSamples(delayed, schedule, options.now).reduce((sum, sample) => sum + sample.delta, 0), 37, 'usage is not reconstructed across the reset');
});

test('off-schedule day budgets weight consumption and calendar exposure together', () => {
  const { observations, options } = fixture();
  const offOptions = { ...options, schedule: { ...schedule, activeDays: [] } };
  const forecast = forecastQuota(observations, offOptions);
  const ordinary = forecastQuota(unqualified(observations), offOptions);
  assert.ok(forecast.resetAdjustment);
  const weightedUsage = 2 + 2 + 2 + 30 * 0.25 + 1;
  const weightedDays = 1 + 1 + 1 + 0.25 + 1;
  close(forecast.expectedRemaining, 99 - weightedUsage / (weightedDays * 24) * 156, 'normal daily pace uses quarter exposure, not a free low-usage day');
  close(forecast.heavyRemaining, ordinary.heavyRemaining, 'full off-schedule workload remains in heavy case');
});

for (const [month, day, hours] of [[2, 29, 23], [9, 25, 25]]) {
  test(`previous-day detection follows the ${hours}-hour Europe/London DST day`, () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Europe/London';
    try {
      const start = local(day - 3, 0, 0, month);
      const reset = start + 7 * 24 * HOUR;
      const observations = [0, 2, 4, 6, 36].map((used, index) => row(local(day - 3 + index, 0, 0, month), used, reset));
      const early = local(day + 1, 0, 15, month);
      observations.push(row(early, 0, early + 7 * 24 * HOUR), row(early + 12 * HOUR, 1, early + 7 * 24 * HOUR));
      const forecast = forecastQuota(observations, { now: early + 12 * HOUR, schedule });
      assert.equal((local(day + 1, 0, 0, month) - local(day, 0, 0, month)) / HOUR, hours);
      assert.deepEqual(forecast.resetAdjustment?.dates, [`2026-${String(month + 1).padStart(2, '0')}-${day}`]);
      assert.equal(forecast.estimatedCurrentRemaining, 99);
      assert.equal(forecast.series.observed.length, 2);
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });
}

test('multiple early resets retain distinct adjusted days once each and keep current usage intact', () => {
  const { observations } = fixture({ current: false });
  for (const [day, used] of [[6, 2], [7, 4], [8, 6], [9, 8], [10, 38]]) observations.push(row(local(day), used, local(12, 0, 15)));
  observations.push(row(local(10, 0, 15), 0, local(17, 0, 15)), row(local(10, 12, 15), 1, local(17, 0, 15)));
  const options = { now: local(10, 12, 15), schedule };
  const forecast = forecastQuota(observations, options);
  assert.deepEqual(forecast.resetAdjustment, { resetAt: new Date(local(10, 0, 15)).toISOString(),
    dates: ['2026-09-04', '2026-09-09'], weight: 0.25 });
  assert.equal(forecast.estimatedCurrentRemaining, 99);
  assert.equal(forecast.series.observed.length, 2);
  const ignored = forecastQuota(observations, { ...options, excludedDates: ['2026-09-04'] });
  assert.deepEqual(ignored.resetAdjustment?.dates, ['2026-09-09']);
  assert.ok(forecast.expectedRemaining > forecastQuota(unqualified(observations), options).expectedRemaining);
});
