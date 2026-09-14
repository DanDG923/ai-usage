'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAllowanceScaler, isAllowanceChangeList, normalizeAllowanceChanges,
} = require('../electron/allowance-changes.cjs');
const { deriveFableEstimate } = require('../electron/claude-collector.cjs');
const { forecastQuota } = require('../electron/forecast.cjs');
const { UsageStore } = require('../electron/store.cjs');
const { estimateTokenCapacity } = require('../electron/token-capacity.cjs');

const HOUR = 3_600_000;
const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
const local = (day, hour = 0, month = 8) => new Date(2026, month, day, hour).getTime();
const RESET = local(14, 9);
const row = (observedAt, usedPercent, overrides = {}) => ({
  sourceId: 'claude', bucketId: 'seven_day', observedAt, usedPercent, remainingPercent: 100 - usedPercent,
  resetsAt: RESET, windowMinutes: 10_080, provenance: 'official', ...overrides,
});
// Two boosted points per half day for five days, then the boost ends early on
// the 13th: the next reading is the old 20 points expressed as 30 of the
// smaller allowance, plus three points of real use.
const BOOST_ENDED_AT = new Date(local(13, 6)).toISOString();
const boostWeek = () => [
  ...Array.from({ length: 11 }, (_, index) => row(local(8) + index * 12 * HOUR, index * 2)),
  row(local(13, 12), 33),
];
const change = (overrides = {}) => ({ source: 'claude', at: BOOST_ENDED_AT, previousAllowancePercent: 150, ...overrides });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-allowance-changes-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'backups'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

test('a scaler multiplies readings before each change for its source family and compounds changes', () => {
  assert.equal(createAllowanceScaler([], 'claude'), null);
  assert.equal(createAllowanceScaler([change({ source: 'codex' })], 'claude'), null, 'another subscription is untouched');
  const claude = createAllowanceScaler([change()], 'claude');
  assert.equal(claude(local(13, 5)), 1.5);
  assert.equal(claude(local(13, 6)), 1, 'the change instant itself is on the new allowance');
  assert.equal(createAllowanceScaler([change()], 'claude-fable')(local(12)), 1.5, 'Fable shares the Claude pool');
  const compounded = createAllowanceScaler([
    change({ at: new Date(local(1)).toISOString(), previousAllowancePercent: 50 }),
    change(),
  ], 'claude');
  assert.equal(compounded(local(0, 12)), 0.75, 'half of the second allowance, which was 150% of the current one');
  assert.equal(compounded(local(5)), 1.5);
  assert.equal(compounded(local(13, 7)), 1);
});

test('changes are validated as complete records and stored sorted without duplicates', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  assert.ok(isAllowanceChangeList([change()], now));
  assert.ok(isAllowanceChangeList([], now));
  for (const invalid of [null, change(), [null], [{ ...change(), extra: 1 }], [{ source: 'claude', at: BOOST_ENDED_AT }],
    [change({ source: 'fable' })], [change({ previousAllowancePercent: 100 })], [change({ previousAllowancePercent: 0 })],
    [change({ previousAllowancePercent: 10_001 })], [change({ previousAllowancePercent: '150' })],
    [change({ at: '2026-09-13' })], [change({ at: '2026-09-13T06:00:00+01:00' })], [change({ at: '2019-12-31T00:00:00.000Z' })],
    [change({ at: new Date(now + 6 * 60_000).toISOString() })], Array(25).fill(change())]) {
    assert.equal(isAllowanceChangeList(invalid, now), false, JSON.stringify(invalid).slice(0, 80));
  }
  assert.ok(isAllowanceChangeList([change({ at: new Date(now + 60_000).toISOString() })], now), 'clock skew of a few minutes is tolerated');
  const later = change({ at: new Date(local(13, 8)).toISOString(), previousAllowancePercent: 120 });
  assert.deepEqual(normalizeAllowanceChanges([later, change(), change({ source: 'codex' }), change()]),
    [change(), change({ source: 'codex' }), later]);
});

test('a recorded change rescales earlier readings so the step at the change is not learned as a burst', () => {
  const observations = boostWeek();
  const options = { now: local(13, 12), schedule };
  const original = forecastQuota(observations, options);
  const rescaled = forecastQuota(observations, { ...options, allowanceChanges: [change()] });
  assert.equal(rescaled.series.observed[0].remaining, 100);
  assert.equal(rescaled.series.observed[10].remaining, 70, 'twenty boosted points are thirty of the current allowance');
  assert.equal(rescaled.series.observed[11].remaining, 67, 'readings after the change are taken as they are');
  assert.equal(rescaled.estimatedCurrentRemaining, 67);
  assert.equal(rescaled.learnedSamples, original.learnedSamples);
  assert.ok(rescaled.workingPace < original.workingPace / 2,
    `the thirteen-point step is three points of use once rescaled (${rescaled.workingPace} vs ${original.workingPace})`);
  // Expressed in today's allowance the earlier days were six points each, so
  // the heavier case is built from those days rather than from the step.
  assert.ok(rescaled.heavyRemaining < 100 && Math.abs(rescaled.heavyRemaining - original.heavyRemaining) < 5,
    `heavier-use evidence comes from real days either way (${rescaled.heavyRemaining} vs ${original.heavyRemaining})`);
  assert.deepEqual(forecastQuota(observations, { ...options, allowanceChanges: [change({ source: 'codex' })] }), original,
    'a change for another subscription leaves the forecast untouched');
  assert.deepEqual(forecastQuota(observations, { ...options, allowanceChanges: [] }), original);
  const anonymous = observations.map(({ sourceId: _sourceId, ...rest }) => rest);
  assert.deepEqual(forecastQuota(anonymous, { ...options, allowanceChanges: [change()] }), original,
    'rows without a source cannot be matched to a change');
  assert.deepEqual(forecastQuota(anonymous, { ...options, allowanceChanges: [change()], sourceId: 'claude' }), rescaled,
    'the caller may name the source for the whole history');
});

test('token capacity rescales earlier intervals to the current allowance and says so', () => {
  const NOW = local(13, 12);
  const iso = (at) => new Date(at).toISOString();
  const observation = (at, used) => ({ source_id: 'claude', bucket_id: 'seven_day', observed_at: iso(at), resets_at: iso(RESET),
    window_minutes: 10_080, used_percent: used, remaining_percent: 100 - used, provenance: 'official', plan_type: 'max', metadata_json: '{}' });
  const event = (at, tokens) => ({ source_id: 'claude', occurred_at: iso(at), model: 'claude-opus-5', input_tokens: tokens,
    cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
  // Fifteen million tokens per hundred boosted points is ten million per
  // hundred of the allowance in force now; the boost ends between the third
  // and fourth readings, where one million tokens moves the figure by ten.
  const input = { sourceId: 'claude', bucketId: 'seven_day', nowMs: NOW,
    observations: [[0, 0], [1, 10], [2, 20], [3, 30], [5, 55]].map(([hour, used]) => observation(NOW - (5 - hour) * HOUR, used)),
    events: [[1, 1_500_000], [2, 1_500_000], [3, 1_500_000], [5, 1_000_000]].map(([hour, tokens]) => event(NOW - (5 - hour) * HOUR, tokens)) };
  const original = estimateTokenCapacity(input);
  assert.equal(original.weeklyTokens, 15_000_000, 'without the change the boosted intervals set the headline');
  const rescaled = estimateTokenCapacity({ ...input, allowanceChanges: [change({ at: iso(NOW - 1.5 * HOUR) })] });
  assert.equal(rescaled.status, 'available');
  assert.equal(rescaled.weeklyTokens, 10_000_000);
  assert.equal(rescaled.intervals, 4);
  assert.equal(rescaled.observedPercent, 55);
  assert.equal(rescaled.remainingTokens, 4_500_000);
  assert.ok(rescaled.warnings.some((warning) => /rescaled to the current allowance/.test(warning)));
  assert.ok(!original.warnings.some((warning) => /rescaled/.test(warning)));
  assert.deepEqual(estimateTokenCapacity({ ...input, allowanceChanges: [change({ source: 'codex', at: iso(NOW - 1.5 * HOUR) })] }), original);
  // A plan upgrade renames the plan at the same moment. Without a recorded
  // change the earlier plan's readings are discarded; with one they were
  // rescaled and remain calibration evidence.
  const upgraded = { ...input, observations: input.observations.map((reading, index) => ({ ...reading, plan_type: index < 4 ? 'pro' : 'max' })) };
  const restarted = estimateTokenCapacity(upgraded);
  assert.equal(restarted.status, 'learning');
  assert.ok(restarted.warnings.some((warning) => /different plan/.test(warning)));
  const carried = estimateTokenCapacity({ ...upgraded, allowanceChanges: [change({ at: iso(NOW - 1.5 * HOUR) })] });
  assert.equal(carried.status, 'available');
  assert.equal(carried.weeklyTokens, 10_000_000);
  assert.equal(carried.intervals, 4);
  assert.ok(!carried.warnings.some((warning) => /different plan/.test(warning)));
  // A status-line or manual reading between the last old-plan reading and
  // the change names no plan; the recorded change still explains the transition.
  const planless = { ...upgraded, observations: upgraded.observations.map((reading, index) => (index === 3 ? { ...reading, plan_type: null } : reading)) };
  assert.equal(estimateTokenCapacity(planless).status, 'learning');
  const carriedAcrossPlanless = estimateTokenCapacity({ ...planless, allowanceChanges: [change({ at: iso(NOW - 1.5 * HOUR) })] });
  assert.equal(carriedAcrossPlanless.status, 'available');
  assert.equal(carriedAcrossPlanless.weeklyTokens, 10_000_000);
  assert.equal(carriedAcrossPlanless.intervals, 4);
});

test('the store validates, normalizes, persists and applies allowance changes to forecasts and capacity', (t) => {
  const store = fixture(t);
  store.updateSettings({ activeStartHour: 0, activeEndHour: 24 });
  assert.deepEqual(store.getSettings().allowanceChanges, []);
  for (const invalid of [null, change(), [change({ previousAllowancePercent: 100 })], [{ ...change(), note: 'boost' }]]) {
    assert.throws(() => store.updateSettings({ theme: 'light', allowanceChanges: invalid }), /Invalid value for allowanceChanges/);
    assert.equal(store.getSettings().theme, 'system');
  }
  for (const entry of boostWeek()) {
    store.recordObservation({ ...entry, observedAt: new Date(entry.observedAt).toISOString(), resetsAt: new Date(RESET).toISOString(),
      bucketName: 'Weekly', planType: 'max', provenance: 'official-statusline', confidence: 1 });
  }
  store.recordUsageEvent({ eventKey: 'boost-week', sourceId: 'claude', occurredAt: new Date(local(13, 9)).toISOString(),
    model: 'claude-opus-5', inputTokens: 300_000, outputTokens: 0 });
  const now = local(13, 12);
  const original = store.getQuota('claude', store.getSettings(), now);
  const observations = store.prepare('SELECT * FROM quota_observations').all();
  const later = change({ at: new Date(local(13, 8)).toISOString(), previousAllowancePercent: 120 });
  assert.deepEqual(store.updateSettings({ allowanceChanges: [later, change(), change()] }).allowanceChanges, [change(), later]);
  store.updateSettings({ allowanceChanges: [change()] });
  const rescaled = store.getQuota('claude', store.getSettings(), now);
  assert.equal(rescaled.usedPercent, 33, 'the provider reading on the card is untouched');
  assert.equal(rescaled.forecast.series.observed[10].remaining, 70);
  assert.equal(original.forecast.series.observed[10].remaining, 80);
  assert.ok(rescaled.forecast.heavyRemaining > original.forecast.heavyRemaining);
  assert.ok(rescaled.tokenCapacity.warnings.some((warning) => /rescaled/.test(warning)), 'capacity is re-estimated for the new setting');
  assert.ok(!original.tokenCapacity.warnings.some((warning) => /rescaled/.test(warning)));
  assert.deepEqual(store.prepare('SELECT * FROM quota_observations').all(), observations, 'history is never rewritten');
  const reopened = new UsageStore(store.databasePath, store.backupDirectory);
  try { assert.deepEqual(reopened.getSettings().allowanceChanges, [change()]); }
  finally { reopened.close(); }
  const payload = JSON.parse(fs.readFileSync(store.createBackup().exportPath, 'utf8'));
  const target = fixture(t);
  target.restoreFromExport(payload);
  assert.deepEqual(target.getSettings().allowanceChanges, [change()]);
  const rejected = target.restoreFromExport({ schemaVersion: 1, settings: { allowanceChanges: [change({ source: 'fable' })] } });
  assert.equal(rejected.skipped, 1);
  assert.deepEqual(target.getSettings().allowanceChanges, [change()]);
  store.updateSettings({ allowanceChanges: [] });
  assert.deepEqual(store.getQuota('claude', store.getSettings(), now).forecast, original.forecast);
});

test('the derived Fable estimate reads overall steps in the current allowance', (t) => {
  const OVERALL_RESET = '2026-09-02T00:00:00.000Z';
  const overall = (observedAt, usedPercent) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: OVERALL_RESET, windowMinutes: 10_080, planType: 'max', provenance: 'official-statusline', confidence: 1, metadata: {},
  });
  const store = fixture(t);
  overall('2026-08-28T12:00:00.000Z', 10);
  store.recordUsageEvent({ eventKey: 'fable-step', sourceId: 'claude', occurredAt: '2026-08-28T18:00:00.000Z', sessionId: 'fable',
    model: 'claude-fable-5', inputTokens: 4_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, metadata: {} });
  // The boost ends overnight: ten boosted points become fifteen, and the
  // Fable session adds ten more of the current allowance.
  overall('2026-08-29T12:00:00.000Z', 25);
  const nowMs = Date.parse('2026-08-29T13:00:00Z');
  const naive = deriveFableEstimate(store, nowMs);
  assert.equal(naive.derived, true);
  assert.ok(Math.abs(naive.usedPercent - 30) < 0.01, `without the change the whole step is Fable use (${naive.usedPercent})`);
  store.updateSettings({ allowanceChanges: [change({ at: '2026-08-29T00:00:00.000Z' })] });
  const adjusted = deriveFableEstimate(store, nowMs);
  assert.equal(adjusted.derived, true);
  assert.ok(Math.abs(adjusted.usedPercent - 20) < 0.01, `only the ten real points move Fable, doubled for its half cap (${adjusted.usedPercent})`);
});
