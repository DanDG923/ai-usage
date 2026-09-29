'use strict';
require('./setup.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveLearningSamples, forecastQuota, percentile } = require('../electron/forecast.cjs');

test('percentile interpolates a distribution', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([], 0.8), 0);
});

test('learned high usage produces a lower heavy projection', () => {
  const reset = '2026-08-31T21:00:00.000Z';
  const observations = [
    ['2026-08-24T08:00:00.000Z', 2],
    ['2026-08-24T12:00:00.000Z', 8],
    ['2026-08-25T08:00:00.000Z', 12],
    ['2026-08-25T12:00:00.000Z', 19],
    ['2026-08-26T08:00:00.000Z', 23],
    ['2026-08-26T12:00:00.000Z', 31],
    ['2026-08-27T08:00:00.000Z', 35],
    ['2026-08-27T12:00:00.000Z', 44],
    ['2026-08-28T08:00:00.000Z', 49],
  ].map(([observedAt, usedPercent]) => ({
    observedAt,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: reset,
    provenance: 'official',
  }));
  const result = forecastQuota(observations, {
    now: '2026-08-28T08:00:00.000Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 },
  });
  assert.ok(result.learnedSamples >= 8);
  assert.ok(result.heavyRemaining <= result.expectedRemaining);
  assert.ok(result.confidence > 0.4);
});

function heavyHistoryRow(observedAt, usedPercent, resetsAt, windowMinutes = 10_080) {
  return { observedAt, usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes, provenance: 'official' };
}

for (const phase of ['active', 'off-schedule']) {
  test(`one busy day in sparse ${phase} history does not set the whole week's heavy pace`, () => {
    const hour = 3_600_000;
    const reset = new Date(2026, 8, 7).getTime();
    const observations = [
      heavyHistoryRow(reset - 48 * hour, 0, reset),
      heavyHistoryRow(reset - 24 * hour, 2, reset),
      heavyHistoryRow(reset, 18, reset),
      heavyHistoryRow(reset, 0, reset + 168 * hour),
      heavyHistoryRow(reset + 12 * hour, 2, reset + 168 * hour),
    ];
    const result = forecastQuota(observations, {
      now: reset + 12 * hour,
      schedule: { activeDays: phase === 'active' ? [0, 1, 2, 3, 4, 5, 6] : [], startHour: 0, endHour: 24 },
    });
    // Two days (2% then 16%) do not establish a repeating busy-week pattern.
    // Previously the upper daily percentile left only about 28% in both phases.
    assert.ok(result.heavyRemaining > (phase === 'active' ? 50 : 35), `heavy ${result.heavyRemaining}`);
    assert.ok(result.heavyRemaining < result.expectedRemaining, 'heavier use must still reduce the buffer');
    for (let index = 0; index < result.series.heavy.length; index += 1) {
      const point = result.series.heavy[index];
      assert.ok(point.remaining <= result.series.expected[index].remaining);
      assert.ok(point.remaining >= 0 && point.remaining <= 100);
      if (index) assert.ok(point.remaining <= result.series.heavy[index - 1].remaining);
    }
  });
}

test('a week of repeated busy days keeps the heavier case close to exhaustion', () => {
  const hour = 3_600_000;
  const reset = new Date(2026, 8, 7).getTime();
  const observations = [];
  for (let day = 0; day < 7; day += 1) {
    const start = reset - (7 - day) * 24 * hour;
    // Distinct daily cycles keep the history realistic without exceeding 100%.
    const used = day === 0 ? 2 : 16;
    observations.push(
      heavyHistoryRow(start, 0, start + 24 * hour, 1440),
      heavyHistoryRow(start + 22 * hour, used, start + 24 * hour, 1440),
      heavyHistoryRow(start + 24 * hour, used, start + 24 * hour, 1440),
    );
  }
  observations.push(
    heavyHistoryRow(reset, 0, reset + 168 * hour),
    heavyHistoryRow(reset + 12 * hour, 2, reset + 168 * hour),
  );
  const result = forecastQuota(observations, {
    now: reset + 12 * hour,
    schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
  });
  assert.ok(result.expectedRemaining > 20, `expected ${result.expectedRemaining}`);
  // Six busy days out of six justify a heavier week well below the expected
  // path, but the heavier case no longer assumes the busiest day repeats for
  // every remaining day, so a fresh week is not written off before it starts.
  assert.ok(result.heavyRemaining > 0 && result.heavyRemaining < 20, `heavy ${result.heavyRemaining}`);
  assert.ok(result.heavyRemaining < result.expectedRemaining - 10, 'heavier use must still reduce the buffer');
  assert.equal(result.heavyExhaustsAt, null);
});

test('a stale reading projects the same heavier reset balance whenever it is viewed', () => {
  // The square-root margin is measured from the reading, not from the moment
  // of the refresh, so catching up to now and projecting onward form one
  // continuous curve. Merely advancing the clock cannot move the reset value.
  const hour = 3_600_000;
  const observedAt = Date.UTC(2026, 8, 5, 12);
  const observations = [heavyHistoryRow(new Date(observedAt).toISOString(), 0, new Date(observedAt + 168 * hour).toISOString())];
  const options = { fallbackRate: 0.3, schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 } };
  const results = [0, 3, 6].map((day) => forecastQuota(observations, { ...options, now: observedAt + day * 24 * hour }));
  for (const result of results) {
    assert.ok(Math.abs(result.expectedRemaining - results[0].expectedRemaining) < 1e-6, `expected ${result.expectedRemaining}`);
    assert.ok(Math.abs(result.heavyRemaining - results[0].heavyRemaining) < 1e-6, `heavy ${result.heavyRemaining} vs ${results[0].heavyRemaining}`);
    assert.ok(result.heavyRemaining < result.expectedRemaining);
  }
});

test('a fresh weekly window after a mixed week is not projected to exhaust under heavier use', () => {
  // Mirrors a live report: seven days of learned daily use ranging from
  // near-idle to about 14%, then an early reset to a full allowance with seven
  // days ahead. The heavier case previously repeated the busiest learned day
  // for every remaining day and reached zero at the reset.
  const hour = 3_600_000;
  const reset = new Date(2026, 8, 12, 12).getTime();
  const observations = [];
  const dailyUse = [2, 14, 11, 3, 9, 1, 7];
  dailyUse.forEach((used, day) => {
    const start = reset - (7 - day) * 24 * hour;
    observations.push(
      heavyHistoryRow(start, 0, start + 24 * hour, 1440),
      heavyHistoryRow(start + 12 * hour, used, start + 24 * hour, 1440),
      heavyHistoryRow(start + 24 * hour, used, start + 24 * hour, 1440),
    );
  });
  observations.push(
    heavyHistoryRow(reset, 0, reset + 168 * hour),
    heavyHistoryRow(reset + 0.25 * hour, 0, reset + 168 * hour),
  );
  const result = forecastQuota(observations, {
    now: reset + 0.25 * hour,
    schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 },
  });
  assert.ok(result.expectedRemaining > 40, `expected ${result.expectedRemaining}`);
  assert.ok(result.heavyRemaining > 20, `heavy ${result.heavyRemaining}`);
  assert.equal(result.heavyExhaustsAt, null);
  assert.equal(result.state, 'safe');
  // The margin above the expected path grows with the square root of elapsed
  // days after the first day: one busy day counts in full, seven do not.
  const margin = (index) => result.series.expected.at(index).remaining - result.series.heavy.at(index).remaining;
  const day = margin(24);
  const week = margin(-1);
  assert.ok(day > 0);
  assert.ok(week > 2 * day && week < 3 * day, `week ${week} vs day ${day}`);
  for (let index = 1; index < result.series.heavy.length; index += 1) {
    assert.ok(result.series.heavy[index].remaining <= result.series.heavy[index - 1].remaining);
    assert.ok(result.series.heavy[index].remaining <= result.series.expected[index].remaining);
  }
});

test('empty history is explicitly unknown', () => {
  const result = forecastQuota([]);
  assert.equal(result.state, 'unknown');
  assert.equal(result.expectedRemaining, null);
  assert.equal(result.workingPace, 0);
  assert.equal(result.windowPace, null);
});

test('usage entirely outside active hours is learned at elapsed-time pace', () => {
  const observations = [
    { observedAt: '2026-08-28T22:00:00Z', usedPercent: 10, resetsAt: '2026-09-04T12:00:00Z', provenance: 'official' },
    { observedAt: '2026-08-29T06:00:00Z', usedPercent: 15, resetsAt: '2026-09-04T12:00:00Z', provenance: 'official' },
  ];
  const samples = deriveLearningSamples(observations, { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 }, Date.parse('2026-08-29T07:00:00Z'));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].phase, 'off-schedule');
  assert.equal(samples[0].rate, 0.625);
});

test('one late off-schedule step cannot consume every future off-schedule hour', () => {
  // Exact minimal reproduction from the live weekly Codex window. A global
  // reset announcement motivated the user to spend heavily, but that external
  // announcement is context only and is not forecast input. The final +1
  // happened just after the configured 22:00 active-hours boundary.
  // That one short event must not allocate all 13% of otherwise unlocalised
  // window usage to off-schedule time or repeat its burst rate every night.
  const observations = [
    {
      observedAt: '2026-08-30T21:17:55.107Z', usedPercent: 12, remainingPercent: 88,
      resetsAt: '2026-09-05T22:22:28.000Z', windowMinutes: 10_080, provenance: 'local-official',
    },
    {
      observedAt: '2026-08-30T21:33:43.164Z', usedPercent: 13, remainingPercent: 87,
      resetsAt: '2026-09-05T22:22:28.000Z', windowMinutes: 10_080, provenance: 'official',
    },
  ];
  const result = forecastQuota(observations, {
    now: '2026-08-30T21:33:43.961Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 22 },
    fallbackRate: 0.35,
    paceRiskThreshold: 1.2,
    hardLimitThreshold: 90,
  });
  assert.equal(result.activeHoursLeft, 84);
  assert.ok(result.safePace > 0.5, `safe pace ${result.safePace}`);
  assert.ok(result.expectedRemaining > 5, `expected ${result.expectedRemaining}`);
  assert.notEqual(result.state, 'critical');
});

test('positive usage against a zero safe budget is reported as over pace', () => {
  const observations = [
    ['2026-08-30T12:00:00Z', 10],
    ['2026-08-30T20:00:00Z', 20],
    ['2026-08-30T23:00:00Z', 95],
  ].map(([observedAt, usedPercent]) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: '2026-09-01T22:00:00Z', provenance: 'official',
  }));
  const result = forecastQuota(observations, {
    now: '2026-08-30T23:00:00Z',
    schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 },
    fallbackRate: 0.35,
    paceRiskThreshold: 1.2,
  });
  assert.equal(result.safePace, 0);
  assert.ok(result.recentPace > 0);
  assert.ok(result.paceRatio > 1.2, `pace ratio ${result.paceRatio}`);
});

test('configured alert thresholds control forecast state', () => {
  const observation = [{ observedAt: '2026-08-29T08:00:00Z', usedPercent: 85, remainingPercent: 15, resetsAt: '2026-08-29T10:00:00Z', provenance: 'official' }];
  const base = { now: '2026-08-29T08:00:00Z', schedule: { activeDays: [6], startHour: 8, endHour: 18 }, fallbackRate: 0.1, paceRiskThreshold: 10 };
  assert.equal(forecastQuota(observation, { ...base, hardLimitThreshold: 90 }).state, 'safe');
  assert.equal(forecastQuota(observation, { ...base, hardLimitThreshold: 80 }).state, 'watch');
});

test('mixed schedule intervals are not attributed wholly to active time', () => {
  const observations = [
    { observedAt: '2026-08-28T22:00:00Z', usedPercent: 10, resetsAt: '2026-09-04T12:00:00Z', provenance: 'official' },
    { observedAt: '2026-08-29T09:00:00Z', usedPercent: 20, resetsAt: '2026-09-04T12:00:00Z', provenance: 'official' },
  ];
  const samples = deriveLearningSamples(observations, { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 }, Date.parse('2026-08-29T09:00:00Z'));
  assert.equal(samples.length, 2);
  assert.deepEqual(new Set(samples.map((sample) => sample.phase)), new Set(['active', 'off-schedule']));
  for (const sample of samples) assert.ok(Math.abs(sample.rate - 10 / 11) < 1e-9);
});

test('dense unchanged polling does not manufacture high confidence', () => {
  const reset = '2026-09-04T12:00:00Z';
  const start = Date.parse('2026-08-29T08:00:00Z');
  const observations = Array.from({ length: 601 }, (_, index) => ({
    observedAt: new Date(start + index * 60_000).toISOString(), usedPercent: 10,
    remainingPercent: 90, resetsAt: reset, provenance: 'official-statusline',
  }));
  const result = forecastQuota(observations, { now: '2026-08-29T18:00:00Z', schedule: { activeDays: [6], startHour: 8, endHour: 18 } });
  assert.ok(result.learnedSamples <= 2);
  assert.ok(result.confidence < 0.4);
});

test('an unchanged off-schedule poll cannot switch inferred future burn on', () => {
  const current = {
    observedAt: '2026-08-30T22:33:43.000Z', usedPercent: 13, remainingPercent: 87,
    resetsAt: '2026-09-05T22:22:28.000Z', windowMinutes: 10_080, provenance: 'official',
  };
  const prior = { ...current, observedAt: '2026-08-30T21:33:43.000Z' };
  const options = {
    now: current.observedAt,
    schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 },
  };
  const single = forecastQuota([current], options);
  const polled = forecastQuota([prior, current], options);
  assert.ok(Math.abs(single.safePace - polled.safePace) < 1e-12);
  assert.ok(Math.abs(single.expectedRemaining - polled.expectedRemaining) < 1e-12,
    `single ${single.expectedRemaining}, polled ${polled.expectedRemaining}`);
});

test('stale observations are projected forward before reset forecasting', () => {
  const result = forecastQuota([{
    observedAt: '2026-08-28T08:00:00Z', usedPercent: 10, remainingPercent: 90,
    resetsAt: '2026-08-30T18:00:00Z', provenance: 'official',
  }], {
    now: '2026-08-29T08:00:00Z', fallbackRate: 1,
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 },
  });
  assert.equal(result.currentIsEstimated, true);
  assert.equal(result.estimatedCurrentRemaining, 80);
  assert.equal(result.expectedRemaining, 61);
  assert.equal(result.staleHours, 24);
});

test('expired allowance windows are unknown rather than safe', () => {
  const result = forecastQuota([{
    observedAt: '2026-08-27T08:00:00Z', usedPercent: 20, remainingPercent: 80,
    resetsAt: '2026-08-28T08:00:00Z', provenance: 'official',
  }], { now: '2026-08-29T08:00:00Z' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.expired, true);
  assert.equal(result.expectedRemaining, null);
});

test('a short burst in a mostly idle window is not extrapolated to exhaustion', () => {
  // Mirrors real Codex data: a weekly window nearly two days old with 7% used,
  // observed only during a three-hour working burst polling every minute.
  const reset = '2026-09-03T19:00:00.000Z';
  const start = Date.parse('2026-08-29T13:00:00Z');
  const observations = Array.from({ length: 181 }, (_, index) => {
    const usedPercent = 2 + Math.min(5, Math.floor(index / 36) + (index >= 170 ? 1 : 0));
    return {
      observedAt: new Date(start + index * 60_000).toISOString(),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: reset,
      windowMinutes: 10_080,
      provenance: 'official',
    };
  });
  const result = forecastQuota(observations, {
    now: '2026-08-29T16:00:00Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 },
  });
  assert.ok(result.windowPace != null && result.windowPace < 0.25);
  assert.ok(Number.isFinite(result.workingPace));
  assert.ok(result.workingPace > result.recentPace);
  assert.ok(result.expectedRemaining > 50, `expected ${result.expectedRemaining}`);
  assert.ok(result.heavyRemaining > 25, `heavy ${result.heavyRemaining}`);
  assert.ok(['safe', 'watch'].includes(result.state), `state ${result.state}`);
});

test('the window anchor measures evidence up to the reading, not to now', () => {
  // A single stale reading gives the anchor no usage-over-time evidence, so it
  // must stay out of the projection instead of claiming a zero rate.
  const result = forecastQuota([{
    observedAt: '2026-08-28T08:00:00Z', usedPercent: 10, remainingPercent: 90,
    resetsAt: '2026-08-30T18:00:00Z', provenance: 'official',
  }], {
    now: '2026-08-29T08:00:00Z', fallbackRate: 1,
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 },
  });
  assert.equal(result.windowPace, null);
  assert.equal(result.estimatedCurrentRemaining, 80);
});

test('repeated overnight use is not counted again as future active-hour use', () => {
  const reset = '2026-09-03T06:00:00Z';
  const observations = [
    ['2026-08-27T22:00:00Z', 0],
    ['2026-08-28T06:00:00Z', 10],
    ['2026-08-28T22:00:00Z', 10],
    ['2026-08-29T06:00:00Z', 20],
  ].map(([observedAt, usedPercent]) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: reset, windowMinutes: 10_080, provenance: 'official',
  }));
  const schedule = { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 };
  const samples = deriveLearningSamples(observations, schedule, Date.parse('2026-08-29T06:00:00Z'));
  const changedActiveDelta = samples
    .filter((sample) => sample.changed && sample.phase === 'active')
    .reduce((sum, sample) => sum + sample.delta, 0);
  const result = forecastQuota(observations, {
    now: '2026-08-29T06:00:00Z', schedule, fallbackRate: 0.01,
  });
  assert.ok(Math.abs(changedActiveDelta) < 1e-9, `active delta ${changedActiveDelta}`);
  assert.ok(result.expectedRemaining > 15 && result.expectedRemaining < 45, `expected ${result.expectedRemaining}`);
  assert.ok(result.heavyRemaining > 0, `heavy ${result.heavyRemaining}`);
  assert.notEqual(result.state, 'critical');
});

test('sparse multi-day observations are allocated across local days for the heavy scenario', () => {
  const observations = [
    ['2026-01-01T08:00:00Z', 0],
    ['2026-01-03T08:00:00Z', 10],
    ['2026-01-05T08:00:00Z', 20],
  ].map(([observedAt, usedPercent]) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: '2026-01-06T08:00:00Z', provenance: 'official',
  }));
  const result = forecastQuota(observations, {
    now: '2026-01-05T08:00:00Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 },
  });
  assert.ok(Math.abs(result.expectedRemaining - 75) < 0.15, `expected ${result.expectedRemaining}`);
  assert.ok(result.heavyRemaining > 73.5 && result.heavyRemaining < 74.3, `heavy ${result.heavyRemaining}`);
});

test('same-window percentage jitter cannot count the same increase repeatedly', () => {
  const start = Date.parse('2026-01-02T10:00:00Z');
  const observations = [4, 5, 4, 5, 4, 5].map((usedPercent, index) => ({
    observedAt: new Date(start + index * 10_000).toISOString(),
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: '2026-01-09T10:00:00Z',
    windowMinutes: 10_080,
    provenance: 'official',
  }));
  const samples = deriveLearningSamples(
    observations,
    { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 },
    start + 50_000,
  );
  const sampleDelta = samples.reduce((sum, sample) => sum + sample.delta, 0);
  const dailyDelta = samples.reduce((sum, sample) => sum
    + sample.dailyDeltas.reduce((daySum, entry) => daySum + entry.delta, 0), 0);
  assert.ok(Math.abs(sampleDelta - 1) < 1e-9, `sample delta ${sampleDelta}`);
  assert.ok(Math.abs(dailyDelta - 1) < 1e-9, `daily delta ${dailyDelta}`);
});

test('a clear official replenishment re-anchors before its reset timestamp changes', () => {
  const reset = '2026-09-05T22:00:00.000Z';
  const observations = [
    ['2026-08-30T08:00:00.000Z', 10],
    ['2026-08-30T09:00:00.000Z', 13],
    // The allowance has actually been replenished, but the provider still
    // reports the old scheduled reset timestamp on this first reading.
    ['2026-08-30T10:00:00.000Z', 0],
    ['2026-08-30T11:00:00.000Z', 1],
  ].map(([observedAt, usedPercent]) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: reset, windowMinutes: 10_080, provenance: 'official',
  }));
  const result = forecastQuota(observations, {
    now: '2026-08-30T11:00:00.000Z',
    schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
  });
  assert.deepEqual(result.series.observed.map((point) => point.remaining), [100, 99]);
  assert.ok(Math.abs(result.windowPace - 1) < 1e-9, `window pace ${result.windowPace}`);
});

test('a locally derived correction is not mistaken for a provider replenishment', () => {
  const reset = '2026-09-05T22:00:00.000Z';
  const observations = [
    ['2026-08-30T08:00:00.000Z', 13],
    ['2026-08-30T09:00:00.000Z', 0],
    ['2026-08-30T10:00:00.000Z', 1],
  ].map(([observedAt, usedPercent]) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: reset, windowMinutes: 10_080, provenance: 'derived-tokens',
  }));
  const result = forecastQuota(observations, {
    now: '2026-08-30T10:00:00.000Z',
    schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
  });
  assert.deepEqual(result.series.observed.map((point) => point.remaining), [87, 100, 99]);
});

test('off-schedule daily pace uses inactive-day hours in its duty cycle', () => {
  const observations = [
    { observedAt: '2026-01-03T00:00:00Z', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-01-04T00:00:00Z', provenance: 'official' },
    { observedAt: '2026-01-04T00:00:00Z', usedPercent: 10, remainingPercent: 90, resetsAt: '2026-01-04T00:00:00Z', provenance: 'official' },
    { observedAt: '2026-01-04T01:00:00Z', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-01-05T07:00:00Z', provenance: 'official' },
  ];
  const result = forecastQuota(observations, {
    now: '2026-01-04T01:00:00Z',
    schedule: { activeDays: [1], startHour: 8, endHour: 18 },
  });
  assert.equal(result.activeHoursLeft, 0);
  assert.ok(Math.abs(result.expectedRemaining - 87.5) < 1e-9, `expected ${result.expectedRemaining}`);
});

test('off-schedule duty cycles use the 23-hour spring-forward day', () => {
  const observations = [
    { observedAt: '2026-03-29T00:00:00Z', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-03-29T23:00:00Z', provenance: 'official' },
    { observedAt: '2026-03-29T23:00:00Z', usedPercent: 23, remainingPercent: 77, resetsAt: '2026-03-29T23:00:00Z', provenance: 'official' },
    { observedAt: '2026-03-30T00:00:00Z', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-03-30T23:00:00Z', provenance: 'official' },
  ];
  const result = forecastQuota(observations, {
    now: '2026-03-30T00:00:00Z',
    schedule: { activeDays: [2], startHour: 8, endHour: 18 },
  });
  assert.equal(result.activeHoursLeft, 0);
  assert.ok(Math.abs(result.expectedRemaining - 77) < 1e-9, `expected ${result.expectedRemaining}`);
});

test('a quiet day adds off-schedule capacity only for the hours its readings cover', () => {
  // One weekly window: a 4% burst on the first night, three days without use,
  // then a small change this morning. Two polls ten minutes apart are not a
  // fully observed quiet day, so they must not dilute the night pace the way
  // days polled around the clock rightly do.
  const reset = '2026-09-21T08:00:00.000Z';
  const row = (observedAt, usedPercent) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: reset, provenance: 'official',
  });
  const brief = ['15', '16', '17'].flatMap((day) => [row(`2026-09-${day}T22:00:00Z`, 14), row(`2026-09-${day}T22:10:00Z`, 14)]);
  const polled = [];
  for (let at = Date.parse('2026-09-15T00:00:00Z'); at < Date.parse('2026-09-18T00:00:00Z'); at += 30 * 60_000) {
    polled.push(row(new Date(at).toISOString(), 14));
  }
  // The store always compacts unchanged readings; a day polled throughout
  // must still count as observed once it is compacted.
  for (const compactReadings of [false, true]) {
    const [unobserved, briefly, throughout] = [[], brief, polled].map((quiet) => forecastQuota([
      row('2026-09-14T08:00:00Z', 10), row('2026-09-14T22:00:00Z', 10), row('2026-09-14T22:30:00Z', 14),
      ...quiet,
      row('2026-09-18T08:50:00Z', 14), row('2026-09-18T09:00:00Z', 20),
    ], { now: '2026-09-18T09:00:00Z', schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 22 }, compactReadings }).expectedRemaining);
    assert.ok(briefly - unobserved < 0.5, `compact ${compactReadings}: brief polls ${briefly} vs unobserved ${unobserved}`);
    assert.ok(throughout - unobserved > 2, `compact ${compactReadings}: polled quiet days ${throughout} vs unobserved ${unobserved}`);
  }
});

test('a fresh window after a reset inherits the prior window pace', () => {
  // Mirrors the real failure: the old window burned 9% over a week (observed
  // only during a three-hour burst), then the allowance reset. The new window
  // must inherit the old window's average pace, not the burst rate.
  const priorReset = '2026-08-29T21:00:00.000Z';
  const burstStart = Date.parse('2026-08-29T13:00:00Z');
  const observations = Array.from({ length: 19 }, (_, index) => {
    const usedPercent = 2 + Math.floor(index * 7 / 18);
    return {
      observedAt: new Date(burstStart + index * 10 * 60_000).toISOString(),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: priorReset,
      windowMinutes: 10_080,
      provenance: 'official',
    };
  });
  observations.push({
    observedAt: '2026-08-29T21:28:00.000Z', usedPercent: 0, remainingPercent: 100,
    resetsAt: '2026-09-05T21:28:00.000Z', windowMinutes: 10_080, provenance: 'official',
  });
  const result = forecastQuota(observations, {
    now: '2026-08-29T22:00:00Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 },
  });
  assert.equal(result.windowPace, null);
  assert.notEqual(result.state, 'critical');
  assert.ok(result.expectedRemaining > 20, `expected ${result.expectedRemaining}`);
  assert.ok(result.heavyRemaining > 5, `heavy ${result.heavyRemaining}`);
});

test('prior window off-schedule use is not projected twice after a reset', () => {
  // The old window burned 35% entirely between 23:00 and 04:00 local, 5% a
  // night for seven nights, and nothing during the 08:00-22:00 schedule. After
  // the reset the fresh window inherits the old window's pace. That pace must
  // be the scheduled share only, because the projection adds off-schedule use
  // separately; a whole-window average would spend those 35 points twice.
  const priorReset = Date.parse('2026-08-30T09:00:00Z');
  const priorStart = priorReset - 7 * 24 * 3_600_000;
  const observations = [];
  let used = 0;
  for (let at = priorStart; at < priorReset; at += 3_600_000) {
    const localHour = new Date(at).getHours();
    if (localHour >= 23 || localHour < 4) used += 1;
    observations.push({
      observedAt: new Date(at).toISOString(), usedPercent: used, remainingPercent: 100 - used,
      resetsAt: new Date(priorReset).toISOString(), windowMinutes: 10_080, provenance: 'official',
    });
  }
  assert.equal(used, 35);
  observations.push({
    observedAt: '2026-08-30T09:05:00.000Z', usedPercent: 0, remainingPercent: 100,
    resetsAt: '2026-09-06T09:05:00.000Z', windowMinutes: 10_080, provenance: 'official',
  });
  const result = forecastQuota(observations, {
    now: '2026-08-30T10:00:00Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 22 },
  });
  // Roughly last week again (35 points), not last week plus its nights repeated.
  assert.ok(result.expectedRemaining > 55, `expected ${result.expectedRemaining}`);
  assert.ok(result.expectedRemaining < 75, `expected ${result.expectedRemaining}`);
  assert.ok(result.recentPace < 0.15, `recent pace ${result.recentPace}`);
});

test('accumulated idle reset drift does not inflate the learned rate', () => {
  // An idle window rolls its reset forward ~1:1 with elapsed time. A fixed
  // 60s tolerance against the last change point breaks after one idle minute,
  // collapsing the smoothing span so the next +5% learns as hundreds of %/h.
  const start = Date.parse('2026-08-29T10:00:00Z');
  const observations = Array.from({ length: 31 }, (_, index) => {
    const observedAt = start + index * 60_000;
    return {
      observedAt: new Date(observedAt).toISOString(),
      usedPercent: index === 30 ? 15 : 10,
      remainingPercent: index === 30 ? 85 : 90,
      resetsAt: new Date(observedAt + 7 * 24 * 3_600_000).toISOString(),
      windowMinutes: 10_080,
      provenance: 'official',
    };
  });
  const samples = deriveLearningSamples(observations, { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 }, Date.parse('2026-08-29T10:31:00Z'));
  assert.ok(samples.length >= 1);
  for (const sample of samples) {
    assert.ok(sample.rate <= 12, `rate ${sample.rate} learned from drift-collapsed span`);
  }
});

test('a remaining-only first reading does not poison the prior window pace', () => {
  // A source reporting only remaining_percent must fall back to 100-remaining
  // for the window start, not zero — otherwise a window that merely started at
  // 50% used is learned as if all 52% were consumed inside it.
  const priorReset = '2026-08-29T20:00:00.000Z';
  const observations = [
    { observedAt: '2026-08-29T08:00:00Z', remainingPercent: 50, resetsAt: priorReset, provenance: 'official' },
    { observedAt: '2026-08-29T13:00:00Z', usedPercent: 51, remainingPercent: 49, resetsAt: priorReset, provenance: 'official' },
    { observedAt: '2026-08-29T18:00:00Z', usedPercent: 52, remainingPercent: 48, resetsAt: priorReset, provenance: 'official' },
    {
      observedAt: '2026-08-29T21:00:00.000Z', usedPercent: 0, remainingPercent: 100,
      resetsAt: '2026-09-05T21:00:00.000Z', windowMinutes: 10_080, provenance: 'official',
    },
  ];
  const result = forecastQuota(observations, {
    now: '2026-08-29T22:00:00Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 },
  });
  assert.notEqual(result.state, 'critical');
  assert.ok(result.expectedRemaining > 40, `expected ${result.expectedRemaining}`);
});

test('backward percentage jitter degrades the window anchor instead of discarding it', () => {
  // 5.0% → 4.9% on the latest reading of a near-idle window should read as
  // "pace ≈ 0", not null out the anchor and hand control to burst rates.
  const reset = '2026-09-04T12:00:00.000Z';
  const observations = [
    { observedAt: '2026-08-28T20:00:00Z', usedPercent: 5, remainingPercent: 95, resetsAt: reset, provenance: 'official' },
    { observedAt: '2026-08-29T16:00:00Z', usedPercent: 4.9, remainingPercent: 95.1, resetsAt: reset, provenance: 'official' },
  ];
  const result = forecastQuota(observations, {
    now: '2026-08-29T16:30:00Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 },
  });
  assert.ok(result.windowPace != null, 'window anchor was discarded');
  assert.ok(result.windowPace < 0.05, `windowPace ${result.windowPace}`);
});

test('a dormant window cluster cannot steal rows from the live window', () => {
  // Two consecutive five-hour windows in one day: the morning cluster's
  // tolerance must not grow with elapsed time until it swallows afternoon
  // rows and corrupts the observed series and anchors.
  const schedule = { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 };
  const observations = [];
  for (let index = 0; index <= 6; index += 1) {
    observations.push({
      observedAt: new Date(Date.parse('2026-08-29T05:00:00Z') + index * 30 * 60_000).toISOString(),
      usedPercent: 10 + index * 5, remainingPercent: 90 - index * 5,
      resetsAt: '2026-08-29T10:00:00.000Z', windowMinutes: 300, provenance: 'official',
    });
  }
  const afternoon = Array.from({ length: 10 }, (_, index) => ({
    observedAt: new Date(Date.parse('2026-08-29T11:00:00Z') + index * 33 * 60_000).toISOString(),
    usedPercent: 5 + index * 3, remainingPercent: 95 - index * 3,
    resetsAt: '2026-08-29T16:00:00.000Z', windowMinutes: 300, provenance: 'official',
  }));
  observations.push(...afternoon);
  const result = forecastQuota(observations, { now: '2026-08-29T15:57:00Z', schedule });
  assert.equal(result.series.observed.length, afternoon.length, 'live window lost or gained rows');
  assert.equal(result.series.observed[0].at, Date.parse('2026-08-29T11:00:00Z'));
});

test('distinct short windows across an offline gap stay separate and keep learning', () => {
  // Window A ends at 40% used (reset 23:00); the app is closed; window B
  // (reset 04:30) is observed from 02:00. Merging them would let A's
  // high-water mark classify all of B's genuine increases as jitter.
  const schedule = { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 };
  const observations = [];
  for (let index = 0; index <= 5; index += 1) {
    observations.push({
      observedAt: new Date(Date.parse('2026-08-28T15:00:00Z') + index * 60 * 60_000).toISOString(),
      usedPercent: 10 + index * 6, remainingPercent: 90 - index * 6,
      resetsAt: '2026-08-28T23:00:00.000Z', windowMinutes: 300, provenance: 'official',
    });
  }
  const fresh = Array.from({ length: 4 }, (_, index) => ({
    observedAt: new Date(Date.parse('2026-08-29T02:00:00Z') + index * 20 * 60_000).toISOString(),
    usedPercent: 5 + index * 5, remainingPercent: 95 - index * 5,
    resetsAt: '2026-08-29T04:30:00.000Z', windowMinutes: 300, provenance: 'official',
  }));
  observations.push(...fresh);
  const samples = deriveLearningSamples(observations, schedule, Date.parse('2026-08-29T03:00:00Z'));
  const freshSamples = samples.filter((sample) => sample.observedAt >= Date.parse('2026-08-29T02:00:00Z'));
  assert.ok(freshSamples.some((sample) => sample.changed), 'fresh window increases were suppressed as jitter');
  const result = forecastQuota(observations, { now: '2026-08-29T03:00:00Z', schedule });
  assert.equal(result.series.observed.length, fresh.length, 'windows were merged');
});

test('an idle rolling window survives a long offline gap as one window', () => {
  // While unused, the reset rolls forward 1:1 with elapsed time — even a 30h
  // offline gap matches the rolling signature and must not split the window.
  const rows = [
    { observedAt: '2026-08-27T12:00:00Z', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-09-03T12:00:00.000Z', windowMinutes: 10_080, provenance: 'official' },
    { observedAt: '2026-08-28T18:00:00Z', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-09-04T18:00:10.000Z', windowMinutes: 10_080, provenance: 'official' },
  ];
  const result = forecastQuota(rows, { now: '2026-08-28T18:30:00Z', schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 0, endHour: 24 } });
  assert.equal(result.series.observed.length, 2, 'rolling idle window was split');
});

test('small reset timestamp drift remains in the observed chart cycle', () => {
  const result = forecastQuota([
    { observedAt: '2026-08-29T08:00:00Z', usedPercent: 10, remainingPercent: 90, resetsAt: '2026-09-04T12:00:00Z', provenance: 'official' },
    { observedAt: '2026-08-29T09:00:00Z', usedPercent: 11, remainingPercent: 89, resetsAt: '2026-09-04T12:00:02Z', provenance: 'official' },
  ], { now: '2026-08-29T09:00:00Z' });
  assert.equal(result.series.observed.length, 2);
});

test('a fresh window\'s first late-evening burst is not extrapolated across every remaining night', () => {
  // Mirrors the live weekly Codex window on 7 September 2026 (Europe/London):
  // reset at 08:39, quiet all day, then 19% spent between 22:09 and 23:28,
  // the last 9% of it after the 22:00 active-hours boundary. With only an
  // hour of elapsed off-schedule exposure, that burst is not a night rate.
  const reset = '2026-09-14T07:40:08.000Z';
  const row = (observedAt, usedPercent) => ({
    observedAt, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: reset,
    windowMinutes: 10_080, provenance: 'official',
  });
  const observations = [row('2026-09-07T07:39:07Z', 0), row('2026-09-07T07:45:32Z', 1), row('2026-09-07T14:39:27Z', 2)];
  const burstStart = Date.parse('2026-09-07T20:09:34Z');
  for (let step = 0; step < 20; step += 1) {
    observations.push(row(new Date(burstStart + step * 4 * 60_000).toISOString(), 3 + step));
  }
  observations.push(row('2026-09-07T21:28:24Z', 22), row('2026-09-07T22:09:11Z', 22));
  const now = '2026-09-07T22:11:58Z';
  const result = forecastQuota(observations, {
    now, schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 22 },
    fallbackRate: 0.35, paceRiskThreshold: 1.2, hardLimitThreshold: 90,
  });
  const nextMorning = Date.parse('2026-09-08T07:00:00Z');
  const atMorning = result.series.expected.find((point) => point.at >= nextMorning);
  assert.ok(atMorning && atMorning.remaining > 60, `overnight remaining ${atMorning?.remaining}`);
  assert.ok(result.exhaustsAt == null || Date.parse(result.exhaustsAt) - Date.parse(now) > 36 * 3_600_000,
    `exhausts ${result.exhaustsAt}`);
  // A day of real spending at this rate still cannot last the week; the
  // warning is kept, only its overnight cliff is removed.
  assert.ok(result.expectedRemaining < 50, `expected ${result.expectedRemaining}`);
  assert.ok(['risk', 'critical'].includes(result.state), `state ${result.state}`);
});

test('exhaustion time is interpolated inside the hour from the unclamped projection', () => {
  const { exhaustionTime } = require('../electron/forecast.cjs');
  const hour = 3_600_000;
  // 2% left and projected to end the hour at -8%: the crossing is 12 minutes in.
  assert.equal(exhaustionTime([{ at: 0, remaining: 2 }, { at: hour, remaining: 0, projected: -8 }]), new Date(hour * 0.2).toISOString());
  // A series without projections can only snap to the first zero sample.
  assert.equal(exhaustionTime([{ at: 0, remaining: 2 }, { at: hour, remaining: 0 }]), new Date(hour).toISOString());
  // Already empty at the start: the run-out is the first sample.
  assert.equal(exhaustionTime([{ at: 0, remaining: 0 }, { at: hour, remaining: 0, projected: -5 }]), new Date(0).toISOString());
  assert.equal(exhaustionTime([{ at: 0, remaining: 40 }, { at: hour, remaining: 30, projected: 30 }]), null);
});

test('a forecast that runs out mid-hour reports the run-out inside that hour, not at its end', () => {
  const reset = '2026-09-03T21:00:00.000Z';
  const observations = [];
  // Four days of steady 24%-a-day consumption; 95% used with three days left.
  for (let day = 0; day < 4; day += 1) {
    for (const [hour, used] of [[8, 5 + day * 24], [12, 13 + day * 24], [16, 21 + day * 24], [18, 24 + day * 24]]) {
      observations.push({
        observedAt: `2026-08-${28 + day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
        usedPercent: Math.min(used, 95), remainingPercent: 100 - Math.min(used, 95), resetsAt: reset, provenance: 'official',
      });
    }
  }
  const result = forecastQuota(observations, {
    now: '2026-08-31T18:00:00.000Z',
    schedule: { activeDays: [1, 2, 3, 4, 5, 6, 0], startHour: 8, endHour: 18 },
  });
  const expected = result.series.expected;
  const zero = expected.findIndex((point, index) => index > 0 && point.remaining <= 0);
  assert.ok(zero > 0, `the projection should run out before the reset; ended at ${result.expectedRemaining}`);
  assert.ok(expected[zero].projected < 0, 'the first zero sample keeps its unclamped projection');
  const runOut = Date.parse(result.exhaustsAt);
  assert.ok(runOut > expected[zero - 1].at && runOut < expected[zero].at,
    `${result.exhaustsAt} should fall strictly inside the hour ending ${new Date(expected[zero].at).toISOString()}`);
  for (const point of result.series.heavy) assert.equal(typeof point.projected, 'number');
});
