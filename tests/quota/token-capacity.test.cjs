'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { estimateTokenCapacity, LOOKBACK_MS, STALENESS_MS } = require('../../electron/token-capacity.cjs');
const { iso } = require('../helpers/time.cjs');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-07T12:00:00Z');
function observation(at, used, overrides = {}) {
  return { source_id: 'codex', bucket_id: 'codex:weekly', observed_at: iso(at),
    resets_at: iso(NOW + 4 * DAY), window_minutes: 10080, used_percent: used,
    remaining_percent: 100 - used, provenance: 'official', plan_type: 'pro', metadata_json: '{}', ...overrides };
}
function event(at, tokens = 1_000_000, overrides = {}) {
  return { source_id: 'codex', occurred_at: iso(at), model: 'gpt-5.6-sol',
    input_tokens: tokens, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, ...overrides };
}
function fixture(overrides = {}) {
  return { sourceId: 'codex', bucketId: 'codex:weekly', nowMs: NOW,
    observations: [0, 1, 2, 3].map((index) => observation(NOW - (3 - index) * HOUR, 10 + index * 10)),
    events: [0, 1, 2].map((index) => event(NOW - (2 - index) * HOUR)), ...overrides };
}
function assertMix(value) {
  assert.ok(Math.abs(value.modelMix.reduce((sum, model) => sum + model.share, 0) - 1) < 1e-10);
  assert.ok(Math.abs(Object.values(value.tokenMix).reduce((sum, share) => sum + share, 0) - 1) < 1e-10);
  assert.ok(Object.values(value.tokenMix).every((share) => share >= 0 && share <= 1));
}

test('three observed quota movements produce a rounded weekly range and dated remaining capacity', () => {
  const result = estimateTokenCapacity(fixture());
  assert.equal(result.status, 'available');
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.deepEqual(result.weeklyRange, { low: 7_500_000, high: 13_000_000 });
  assert.equal(result.remainingTokens, 6_000_000);
  assert.equal(result.remainingAsOf, iso(NOW));
  assert.equal(result.calibratedAt, iso(NOW));
  assert.equal(result.intervals, 3);
  assert.equal(result.cycles, 1);
  assert.equal(result.observedPercent, 30);
  assert.equal(result.confidence, 'low');
  assert.ok(result.warnings.some((warning) => /other devices/.test(warning)));
  assertMix(result);
});

test('matching (before, after] includes same-timestamp ending tokens exactly once', () => {
  const input = fixture();
  input.events.unshift(event(NOW - 3 * HOUR, 99_000_000));
  input.events.push(event(NOW + 1, 99_000_000));
  assert.deepEqual(estimateTokenCapacity(input), estimateTokenCapacity(fixture()));
});

test('unchanged percentages and small rounded steps retain all tokens until a useful delta is observed', () => {
  const percentages = [10, 10, 11, 12, 15, 15, 17, 20, 21, 21, 25];
  const start = NOW - 10 * HOUR;
  const input = fixture({ observations: percentages.map((used, index) => observation(start + index * HOUR, used)),
    events: percentages.slice(1).map((_, index) => event(start + (index + 1) * HOUR, index < 4 ? 250_000 : 1_000_000 / 3)) });
  // Whole numbers: the two three-reading intervals each total one million.
  for (let index = 4; index < 10; index += 1) input.events[index].input_tokens = (index === 6 || index === 9) ? 333_334 : 333_333;
  const result = estimateTokenCapacity(input);
  assert.equal(result.status, 'available');
  assert.equal(result.intervals, 3);
  assert.equal(result.observedPercent, 15);
  assert.equal(result.weeklyTokens, 20_000_000);
});

test('tiny rounded changes and one large interval never imply a precise capacity', () => {
  for (const percentages of [[10, 10, 10, 10], [10, 10.1, 10.2, 10.3], [0, 0, 0, 80]]) {
    const input = fixture();
    input.observations = percentages.map((used, index) => observation(NOW - (3 - index) * HOUR, used));
    const result = estimateTokenCapacity(input);
    assert.equal(result.status, 'learning');
    assert.equal(result.weeklyTokens, null);
    assert.equal(result.weeklyRange, null);
    assert.equal(result.remainingTokens, null);
  }
});

test('Codex cache reads and reasoning stay subsets; Claude cache categories stay additive', () => {
  const codex = fixture();
  codex.events = codex.events.map((row) => ({ ...row, input_tokens: 600_000, cached_input_tokens: 200_000,
    cache_write_input_tokens: 100_000, cache_write_5m_input_tokens: 100_000, cache_write_1h_input_tokens: 0,
    output_tokens: 300_000, reasoning_output_tokens: 250_000 }));
  const codexResult = estimateTokenCapacity(codex);
  assert.equal(codexResult.weeklyTokens, 10_000_000);
  assert.deepEqual(codexResult.tokenMix, { input: 0.4, cacheRead: 0.2, cacheWrite: 0.1, output: 0.3 });
  const claude = { ...codex, sourceId: 'claude', bucketId: 'seven_day',
    observations: codex.observations.map((row) => ({ ...row, source_id: 'claude', bucket_id: 'seven_day',
      provenance: 'official-claude-usage', metadata_json: '{"scope":"overall","model":"claude-opus-5"}' })),
    events: codex.events.map((row) => ({ ...row, source_id: 'claude', model: 'claude-sonnet-5', input_tokens: 400_000,
      cache_write_5m_input_tokens: 20_000, cache_write_1h_input_tokens: 80_000 })) };
  const claudeResult = estimateTokenCapacity(claude);
  assert.equal(claudeResult.weeklyTokens, 10_000_000);
  assert.deepEqual(claudeResult.tokenMix, codexResult.tokenMix);
  assert.equal(claudeResult.modelMix[0].model, 'claude-sonnet-5', 'active status-line model never filters an overall window');
});

for (const [sourceId, bucketId, model] of [
  ['claude-fable', 'fable_seven_day', 'claude-fable-5'],
  ['claude-fable', 'fable:seven_day_fable', 'claude-fable-5'],
  ['claude', 'seven_day_opus', 'claude-opus-5'],
  ['claude', 'seven_day_sonnet', 'claude-sonnet-5'],
  ['claude', 'model_scoped:claude%20opus', 'claude-opus-5'],
  ['claude', 'model_scoped:claude-opus-5', 'claude-opus-5-20260901'],
  ['claude', 'model_scoped:claude-haiku-5-5', 'claude-haiku-5-5-20261007'],
  ['claude', 'model_scoped:claude-sonnet-5-5', 'claude-sonnet-5-5'],
  ['claude', 'model_scoped:claude-fable-5-2', 'claude-fable-5-2'],
]) {
  test(`known weekly scope ${sourceId}/${bucketId} uses only its matching Claude model family`, () => {
    const input = fixture({ sourceId, bucketId });
    input.observations = input.observations.map((row) => ({ ...row, source_id: sourceId, bucket_id: bucketId,
      metadata_json: '{"scope":"model"}', provenance: 'official-claude-usage' }));
    input.events = input.events.flatMap((row) => [
      { ...row, source_id: 'claude', model },
      { ...row, source_id: 'claude', model: 'claude-haiku-4-5', input_tokens: 99_000_000 },
      { ...row, source_id: 'claude', model: 'not-claude-fable-5', input_tokens: 99_000_000 },
    ]);
    const result = estimateTokenCapacity(input);
    assert.equal(result.weeklyTokens, 10_000_000);
    assert.deepEqual(result.modelMix, [{ model, share: 1 }]);
  });
}

test('unknown model scopes, OAuth pools and nonweekly windows are unavailable', () => {
  for (const [sourceId, bucketId] of [['claude', 'seven_day_oauth_apps'], ['claude', 'model_scoped:research%20model'],
    ['claude', 'model_scoped:Opus%205'], ['codex', 'gpt-6-astra:weekly'], ['claude-fable', 'fable:unknown']]) {
    const input = fixture({ sourceId, bucketId });
    input.observations = input.observations.map((row) => ({ ...row, source_id: sourceId, bucket_id: bucketId }));
    assert.equal(estimateTokenCapacity(input).status, 'unavailable');
  }
  const short = fixture();
  short.observations = short.observations.map((row) => ({ ...row, window_minutes: 300 }));
  assert.equal(estimateTokenCapacity(short).status, 'unavailable');
  const wrongScope = fixture();
  wrongScope.observations = wrongScope.observations.map((row) => ({ ...row, metadata_json: '{"limitId":"another-limit"}' }));
  assert.equal(estimateTokenCapacity(wrongScope).status, 'unavailable');
});

test('only explicitly recognized official provenance can calibrate or provide remaining capacity', () => {
  for (const provenance of ['derived-tokens', 'official-looking-invented', 'estimated']) {
    const input = fixture();
    input.observations = input.observations.map((row) => ({ ...row, provenance }));
    assert.equal(estimateTokenCapacity(input).status, 'unavailable');
  }
  const manual = fixture();
  manual.observations = manual.observations.map((row) => ({ ...row, provenance: 'manual-official' }));
  const result = estimateTokenCapacity(manual);
  assert.equal(result.status, 'available');
  assert.equal(result.confidence, 'low');
  assert.ok(result.warnings.some((warning) => /manually/.test(warning)));
});

test('future readings and tokens cannot change an already calibrated estimate', () => {
  const input = fixture();
  input.observations.push(observation(NOW + 1, 70));
  input.events.push(event(NOW + 1, 99_000_000));
  assert.deepEqual(estimateTokenCapacity(input), estimateTokenCapacity(fixture()));
});

test('history is bounded to 45 days and recency weights do not drift merely with wall-clock time', () => {
  assert.equal(LOOKBACK_MS, 45 * DAY);
  assert.equal(STALENESS_MS, DAY);
  const input = fixture();
  const oldAt = NOW - LOOKBACK_MS - 1;
  input.observations.unshift(observation(oldAt, 0, { resets_at: iso(oldAt + 7 * DAY) }));
  input.events.unshift(event(oldAt, 99_000_000));
  assert.deepEqual(estimateTokenCapacity(input), estimateTokenCapacity(fixture()));
  assert.deepEqual(estimateTokenCapacity({ ...input, nowMs: NOW + HOUR }), estimateTokenCapacity(input));
});

test('expired, stale and newer derived-only reset anchors hide remaining tokens but keep historical capacity', () => {
  const original = estimateTokenCapacity(fixture());
  for (const input of [fixture({ nowMs: NOW + DAY + 1 }), fixture({ nowMs: NOW + 4 * DAY }),
    fixture({ nowMs: NOW + HOUR, observations: [...fixture().observations,
      observation(NOW + HOUR, 1, { provenance: 'derived-tokens', resets_at: iso(NOW + 6 * DAY) })] })]) {
    const result = estimateTokenCapacity(input);
    assert.equal(result.status, 'available');
    assert.equal(result.weeklyTokens, original.weeklyTokens);
    assert.equal(result.remainingTokens, null);
    assert.equal(result.remainingRange, null);
    assert.equal(result.remainingAsOf, null);
  }
  assert.notEqual(estimateTokenCapacity(fixture({ nowMs: NOW + DAY })).remainingTokens, null, 'exactly 24h remains eligible');
});

test('calibration intervals run between fetches, so a later redraw moves no tokens between rises', () => {
  // The week reads 20% two hours ago; tokens are then used before that figure
  // is first redrawn, half an hour after its fetch.
  const capacity = (second) => estimateTokenCapacity(fixture({
    observations: [observation(NOW - 3 * HOUR, 10), second, observation(NOW - HOUR, 30), observation(NOW, 40)],
    events: [event(NOW - 2.5 * HOUR), event(NOW - 1.75 * HOUR), event(NOW - 1.25 * HOUR, 2_000_000), event(NOW - HOUR / 2)],
  }));
  const read = capacity(observation(NOW - 2 * HOUR, 20));
  const redrawn = capacity(observation(NOW - 1.5 * HOUR, 20,
    { provenance: 'official-statusline', plan_type: null, fetched_after: iso(NOW - 2 * HOUR) }));
  assert.equal(read.status, 'available');
  assert.deepEqual([redrawn.weeklyTokens, redrawn.weeklyRange, redrawn.calibratedAt],
    [read.weeklyTokens, read.weeklyRange, read.calibratedAt]);
});

test('a figure fetched before an allowance change is scaled as a share of the old allowance, whenever it is redrawn', () => {
  // The allowance doubled 1.75 hours ago; the 20% figure was fetched before
  // that, but first redrawn after it.
  const capacity = (second) => estimateTokenCapacity(fixture({
    observations: [observation(NOW - 3 * HOUR, 10), second, observation(NOW - HOUR, 30), observation(NOW, 40)],
    events: [event(NOW - 2.5 * HOUR), event(NOW - 1.25 * HOUR), event(NOW - HOUR / 2)],
    allowanceChanges: [{ source: 'codex', at: iso(NOW - 1.75 * HOUR), previousAllowancePercent: 50 }],
  }));
  const read = capacity(observation(NOW - 2 * HOUR, 20));
  const redrawn = capacity(observation(NOW - 1.5 * HOUR, 20,
    { provenance: 'official-statusline', plan_type: null, fetched_after: iso(NOW - 2 * HOUR) }));
  assert.equal(read.status, 'available');
  assert.deepEqual([redrawn.weeklyTokens, redrawn.weeklyRange, redrawn.intervals], [read.weeklyTokens, read.weeklyRange, read.intervals]);
});

test('remaining tokens age from when the latest figure was fetched, not from a status-line redraw of it', () => {
  // A day and an hour later, an idle session redraws the 40% it fetched
  // before the last provider reading.
  const redraw = (fetchedAfter) => observation(NOW + 25 * HOUR, 40,
    { provenance: 'official-statusline', plan_type: null, fetched_after: iso(fetchedAfter) });
  const idle = estimateTokenCapacity(fixture({ nowMs: NOW + 25 * HOUR, observations: [...fixture().observations, redraw(NOW - 2 * HOUR)] }));
  assert.equal(idle.status, 'available');
  assert.equal(idle.remainingTokens, null, 'the figure was last known over a day ago');
  assert.ok(idle.warnings.some((warning) => /over 24 hours old/.test(warning)));
  // The same session, fetching again half an hour earlier, still sees 40%.
  const fetched = estimateTokenCapacity(fixture({ nowMs: NOW + 25 * HOUR, observations: [...fixture().observations, redraw(NOW + 24.5 * HOUR)] }));
  assert.equal(fetched.remainingTokens, 6_000_000);
  assert.equal(fetched.remainingAsOf, iso(NOW + 24.5 * HOUR));
});

test('a rise whose fetch overlaps the anchor’s closes at its first redraw, not inside the next rise', () => {
  // 10% and 20% are read; a session whose last redraw before its response was
  // at 09:30 then fetched 30% and first redrew it at 10:30; 40% is read at noon.
  const capacity = (third) => estimateTokenCapacity(fixture({
    observations: [observation(NOW - 3 * HOUR, 10), observation(NOW - 2 * HOUR, 20), third, observation(NOW, 40)],
    events: [event(NOW - 2.5 * HOUR), event(NOW - 1.75 * HOUR), event(NOW - HOUR / 2)],
  }));
  const read = capacity(observation(NOW - 1.5 * HOUR, 30));
  const overlapping = capacity(observation(NOW - HOUR, 30, { provenance: 'official-statusline', plan_type: null,
    fetched_after: iso(NOW - 2.5 * HOUR), seen_since: iso(NOW - 1.5 * HOUR) }));
  assert.equal(read.intervals, 3);
  assert.deepEqual([overlapping.weeklyTokens, overlapping.weeklyRange, overlapping.intervals], [read.weeklyTokens, read.weeklyRange, read.intervals]);
});

test('an idle redraw restating an older fetch of the latest figure does not change the calibration', () => {
  // Seven intervals of different capacity and model, then an idle session
  // redraws the latest 80%, its fetch dated two days before the last read.
  const steps = [10, 20, 30, 40, 50, 60, 70, 80];
  const observations = steps.map((used, index) => observation(NOW - (steps.length - 1 - index) * 6 * HOUR, used));
  const events = [1, 3, 1.2, 2.5, 0.8, 1.9, 1.4].map((millions, index) =>
    event(NOW - (steps.length - 2 - index) * 6 * HOUR - HOUR, millions * 1_000_000, { model: index % 2 ? 'gpt-5.6-sol' : 'gpt-5.6-terra' }));
  const calibration = (value) => [value.status, value.weeklyTokens, value.weeklyRange, value.modelMix, value.tokenMix, value.intervals];
  const read = estimateTokenCapacity(fixture({ nowMs: NOW + HOUR, observations, events }));
  const redrawn = estimateTokenCapacity(fixture({ nowMs: NOW + HOUR, events, observations: [...observations,
    observation(NOW + HOUR / 2, 80, { provenance: 'official-statusline', plan_type: null, fetched_after: iso(NOW - 2 * DAY) })] }));
  assert.equal(read.status, 'available');
  assert.deepEqual(calibration(redrawn), calibration(read));
});

test('a figure from before an early replenishment does not renew the allowance that replaced it', () => {
  // 40% is read at noon; a read at 13:00 shows an early replenishment to 0%
  // under the same reset; at 14:00 an undated redraw shows 40% again.
  const statusLine = { provenance: 'official-statusline', plan_type: null };
  const replenished = estimateTokenCapacity(fixture({ nowMs: NOW + 3 * HOUR, observations: [...fixture().observations,
    observation(NOW + HOUR, 0), observation(NOW + 2 * HOUR, 40, { ...statusLine, seen_since: iso(NOW + 2 * HOUR) })] }));
  assert.equal(replenished.status, 'available');
  assert.equal(replenished.remainingTokens, null, 'the noon read of the old allowance does not date the new 40%');
  assert.ok(replenished.warnings.some((warning) => /over 24 hours old/.test(warning)));
});

test('a redraw from a session first seen with limits in hand does not renew remaining tokens', () => {
  // A day and an hour later, a session the helper never saw open redraws 40%:
  // fetched at some point this week, perhaps before the last provider reading.
  const undated = estimateTokenCapacity(fixture({ nowMs: NOW + 25 * HOUR, observations: [...fixture().observations,
    observation(NOW + 25 * HOUR, 40, { provenance: 'official-statusline', plan_type: null, seen_since: iso(NOW + 25 * HOUR - 60_000) })] }));
  assert.equal(undated.status, 'available');
  assert.equal(undated.weeklyTokens, 10_000_000);
  assert.equal(undated.remainingTokens, null, 'the figure is known only from the last provider reading, over a day ago');
  assert.ok(undated.warnings.some((warning) => /over 24 hours old/.test(warning)));
});

test('an unconfirmed replenishment suppresses old official remaining even while its reset timestamp is unchanged', () => {
  const input = fixture();
  input.observations = input.observations.map((row, index) => ({ ...row, used_percent: 50 + index * 10,
    remaining_percent: 50 - index * 10 }));
  const original = estimateTokenCapacity(input);
  assert.equal(original.remainingTokens, 2_000_000);
  input.nowMs = NOW + HOUR;
  input.observations.push(observation(NOW + HOUR / 2, 0, { provenance: 'derived-tokens' }));
  for (const recovery of [null, 1, 6, 85]) {
    const observations = recovery == null ? input.observations : [...input.observations,
      observation(NOW + HOUR, recovery, { provenance: 'derived-tokens' })];
    const result = estimateTokenCapacity({ ...input, observations });
    assert.equal(result.status, 'available');
    assert.equal(result.weeklyTokens, original.weeklyTokens);
    assert.deepEqual(result.weeklyRange, original.weeklyRange);
    assert.equal(result.remainingTokens, null);
    assert.equal(result.remainingRange, null);
    assert.equal(result.remainingAsOf, null);
    assert.ok(result.warnings.some((warning) => /fresh official reading/.test(warning)));
  }
  const refreshed = estimateTokenCapacity({ ...input, observations: [...input.observations,
    observation(NOW + HOUR, 6)] });
  assert.equal(refreshed.remainingAsOf, iso(NOW + HOUR), 'a fresh official reading confirms the current balance');
  assert.notEqual(refreshed.remainingTokens, null);
});

test('normal derived progress preserves a dated official balance and cannot override a simultaneous official reading', () => {
  const input = fixture({ nowMs: NOW + HOUR });
  const original = estimateTokenCapacity(input);
  for (const reading of [observation(NOW + HOUR, 41, { provenance: 'derived-tokens' }),
    observation(NOW, 0, { provenance: 'derived-tokens' })]) {
    assert.deepEqual(estimateTokenCapacity({ ...input, observations: [...input.observations, reading] }), original);
  }
});

test('a hard reset or reset-time drift cannot form a consumption interval across windows', () => {
  const input = fixture();
  input.observations = [observation(NOW - 5 * HOUR, 40), observation(NOW - 4 * HOUR, 0),
    observation(NOW - 3 * HOUR, 10), observation(NOW - 2 * HOUR, 20), observation(NOW - HOUR, 30)];
  input.events = [event(NOW - 4 * HOUR, 99_000_000), event(NOW - 3 * HOUR), event(NOW - 2 * HOUR), event(NOW - HOUR)];
  assert.equal(estimateTokenCapacity(input).weeklyTokens, 10_000_000);
  const drift = fixture();
  drift.observations = drift.observations.map((row, index) => ({ ...row, resets_at: iso(Date.parse(row.resets_at) + index * 40_000) }));
  const drifted = estimateTokenCapacity(drift);
  assert.equal(drifted.status, 'learning');
  assert.equal(drifted.intervals, 2, 'jitter is measured from the first reset, not chained indefinitely');
});

test('backward corrections and rebounds do not make duplicate quota consumption', () => {
  const percentages = [10, 20, 19, 20, 21, 31, 41];
  const start = NOW - 6 * HOUR;
  const input = fixture({ observations: percentages.map((used, index) => observation(start + index * HOUR, used)),
    events: percentages.slice(1).map((_, index) => event(start + (index + 1) * HOUR, index >= 1 && index <= 3 ? 99_000_000 : 1_000_000)) });
  const result = estimateTokenCapacity(input);
  assert.equal(result.intervals, 3);
  assert.equal(result.observedPercent, 30);
  assert.equal(result.weeklyTokens, 10_000_000);
});

test('lagging Codex transcript snapshots cannot continually erase live calibration progress', () => {
  const start = NOW - 15 * HOUR;
  const live = Array.from({ length: 16 }, (_, index) => observation(start + index * HOUR, 10 + index));
  const input = fixture({ observations: live.flatMap((row, index) => index === 15 ? [row] : [row,
    observation(Date.parse(row.observed_at) + HOUR / 2, row.used_percent - 1, { provenance: 'local-official' })]),
  events: live.slice(1).map((row) => event(Date.parse(row.observed_at), 200_000)) });
  const result = estimateTokenCapacity(input);
  const baseline = estimateTokenCapacity({ ...input, observations: live });
  assert.equal(result.status, 'available');
  assert.equal(result.intervals, 3);
  assert.equal(result.observedPercent, 15);
  assert.equal(result.weeklyTokens, 20_000_000);
  assert.equal(result.remainingTokens, baseline.remainingTokens);
  assert.deepEqual(result.modelMix, baseline.modelMix);
  assert.ok(result.warnings.some((warning) => /overlapping transcript/.test(warning)));
  assert.ok(!result.warnings.some((warning) => /Quota corrections/.test(warning)));
});

test('transcript-only Codex history still calibrates without a live account connection', () => {
  const input = fixture();
  input.observations = input.observations.map((row) => ({ ...row, provenance: 'local-official' }));
  assert.deepEqual(estimateTokenCapacity(input), estimateTokenCapacity(fixture()));
});

test('live and transcript calibration never bridge a source handoff and preserve uncovered history', () => {
  const start = NOW - 10 * HOUR;
  const used = [0, 10, 20, 30, 45, 55, 65, 75, 80, 90, 100];
  const input = fixture({ observations: used.map((percent, index) => observation(start + index * HOUR, percent,
    { provenance: index >= 4 && index <= 7 ? 'official' : 'local-official' })),
  events: used.slice(1).map((_, index) => event(start + (index + 1) * HOUR,
    index === 3 || index === 7 ? 99_000_000 : 1_000_000)) });
  const result = estimateTokenCapacity(input);
  assert.equal(result.status, 'available');
  assert.equal(result.intervals, 8);
  assert.equal(result.cycles, 1);
  assert.equal(result.observedPercent, 80);
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.equal(result.remainingAsOf, iso(NOW), 'latest transcript reading still anchors the dated balance');
  assert.ok(!result.warnings.some((warning) => /inconsistent/.test(warning)));
});

test('overlapping transcripts cannot bypass a genuine live quota correction', () => {
  const percentages = [10, 20, 19, 20, 21, 31, 41];
  const start = NOW - 6 * HOUR;
  const input = fixture({ observations: percentages.flatMap((used, index) => [
    observation(start + index * HOUR, used),
    observation(start + index * HOUR, used + 1, { provenance: 'local-official' }),
  ]), events: percentages.slice(1).map((_, index) => event(start + (index + 1) * HOUR,
    index >= 1 && index <= 3 ? 99_000_000 : 1_000_000)) });
  const result = estimateTokenCapacity(input);
  assert.equal(result.intervals, 3);
  assert.equal(result.observedPercent, 30);
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.ok(result.warnings.some((warning) => /Quota corrections/.test(warning)));
});

test('plan changes exclude old-plan calibration and do not bridge the change', () => {
  const input = fixture();
  const old = [0, 1, 2, 3].map((index) => observation(NOW - (7 - index) * HOUR, index * 10, { plan_type: 'old-plan' }));
  input.observations = [...old, ...input.observations];
  input.events.unshift(...old.slice(1).map((row) => event(Date.parse(row.observed_at), 50_000_000)));
  const result = estimateTokenCapacity(input);
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.equal(result.intervals, 3);
  assert.ok(result.warnings.some((warning) => /different plan/.test(warning)));
});

test('missing local usage and invalid token categories cannot create apparently complete calibration', () => {
  const input = fixture();
  input.events[0].cached_input_tokens = 2_000_000;
  input.events.pop();
  const result = estimateTokenCapacity(input);
  assert.equal(result.status, 'learning');
  assert.equal(result.intervals, 1);
  assert.ok(result.warnings.some((warning) => /invalid token/.test(warning)));
  assert.ok(result.warnings.some((warning) => /no matching local/.test(warning)));
});

test('one huge ratio outlier cannot set the headline or supply the minimum evidence by itself', () => {
  const input = fixture();
  input.events[2].input_tokens = 1_000_000_000;
  const insufficient = estimateTokenCapacity(input);
  assert.equal(insufficient.status, 'learning');
  assert.equal(insufficient.intervals, 2);
  input.observations.unshift(observation(NOW - 4 * HOUR, 0));
  input.events.unshift(event(NOW - 3 * HOUR));
  const sufficient = estimateTokenCapacity(input);
  assert.equal(sufficient.weeklyTokens, 10_000_000);
  assert.equal(sufficient.intervals, 3);
  assert.equal(sufficient.confidence, 'low');
  assert.ok(sufficient.warnings.some((warning) => /inconsistent/.test(warning)));
});

test('several consistent intervals across two cycles can reach medium, never high confidence', () => {
  const input = fixture();
  const older = [0, 1, 2, 3].map((index) => observation(NOW - 7 * DAY - (3 - index) * HOUR, 10 + index * 10,
    { resets_at: iso(NOW - 3 * DAY) }));
  input.observations.unshift(...older);
  input.events.unshift(...older.slice(1).map((row) => event(Date.parse(row.observed_at))));
  const result = estimateTokenCapacity(input);
  assert.equal(result.cycles, 2);
  assert.equal(result.intervals, 6);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.weeklyTokens, 10_000_000);
  input.events.at(-1).model = 'gpt-6-astra';
  input.events.at(-1).cached_input_tokens = 900_000;
  const changed = estimateTokenCapacity(input);
  assert.equal(changed.confidence, 'low');
  assert.ok(changed.warnings.some((warning) => /mix changed/.test(warning)));
  assertMix(changed);
});

test('a coherent recent workload switch cannot be trimmed away by abundant older activity', () => {
  const input = fixture();
  input.events = input.events.map((row) => ({ ...row, model: 'gpt-6-astra', input_tokens: 200_000 }));
  for (const age of [14, 7]) {
    const older = Array.from({ length: 11 }, (_, index) => observation(NOW - age * DAY - (10 - index) * HOUR, index * 10,
      { resets_at: iso(NOW - age * DAY + 4 * DAY) }));
    input.observations.push(...older);
    input.events.push(...older.slice(1).map((row) => event(Date.parse(row.observed_at))));
  }
  const result = estimateTokenCapacity(input);
  assert.equal(result.status, 'available');
  assert.equal(result.weeklyTokens, 2_000_000);
  assert.equal(result.remainingTokens, 1_200_000);
  assert.equal(result.intervals, 3);
  assert.equal(result.calibratedAt, iso(NOW));
  assert.deepEqual(result.modelMix, [{ model: 'gpt-6-astra', share: 1 }]);
  assert.equal(result.confidence, 'low');
  assert.ok(result.warnings.some((warning) => /mix changed/.test(warning)));
  assert.ok(result.warnings.some((warning) => /Earlier intervals/.test(warning)));
});

test('one recent model and ratio outlier cannot replace the established workload calibration', () => {
  const input = fixture();
  input.observations.unshift(observation(NOW - 4 * HOUR, 0));
  input.events.unshift(event(NOW - 3 * HOUR));
  input.events.at(-1).input_tokens = 100_000_000;
  input.events.at(-1).model = 'gpt-6-astra';
  const result = estimateTokenCapacity(input);
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.equal(result.intervals, 3);
  assert.equal(result.confidence, 'low');
  assert.ok(result.warnings.some((warning) => /mix changed/.test(warning)), 'trimmed recent evidence must still trigger a workload warning');
});

test('ignored dates drop entire intersecting pairs while preserving actual remaining quota', () => {
  const local = (day) => new Date(2026, 8, day, 12).getTime();
  const nowMs = local(8), reset = local(10);
  const used = [10, 20, 40, 60, 70, 80];
  const input = fixture({ nowMs, excludedDates: ['2026-09-05'],
    observations: used.map((percent, index) => observation(local(3 + index), percent, { resets_at: iso(reset) })),
    events: used.slice(1).map((_, index) => event(local(4 + index), index === 1 || index === 2 ? 8_000_000 : 1_000_000)) });
  const result = estimateTokenCapacity(input);
  assert.equal(result.weeklyTokens, 10_000_000);
  assert.equal(result.intervals, 3);
  assert.equal(result.observedPercent, 30);
  assert.equal(result.remainingTokens, 2_000_000);
  assert.equal(result.remainingAsOf, iso(nowMs));
  assert.deepEqual(estimateTokenCapacity(fixture({ excludedDates: ['2020-01-01', '2026-10-01'] })), estimateTokenCapacity(fixture()));
});

for (const [month, day, expectedHours] of [[2, 29, 23], [9, 25, 25]]) {
  test(`ignored local dates span the real ${expectedHours}-hour DST day`, () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/London';
    try {
      const start = new Date(2026, month, day).getTime(), end = new Date(2026, month, day + 1).getTime();
      assert.equal((end - start) / HOUR, expectedHours);
      const times = [start - 6 * HOUR, start - 4 * HOUR, start - 2 * HOUR, start, end, end + 2 * HOUR, end + 4 * HOUR, end + 6 * HOUR];
      const used = [0, 10, 20, 30, 60, 70, 80, 90];
      const input = fixture({ nowMs: times.at(-1), excludedDates: [`2026-${String(month + 1).padStart(2, '0')}-${day}`],
        observations: times.map((at, index) => observation(at, used[index], { resets_at: iso(end + 4 * DAY) })),
        events: times.slice(1).map((at) => event(at, at >= start && at <= end ? 99_000_000 : 1_000_000)) });
      const result = estimateTokenCapacity(input);
      assert.equal(result.status, 'available');
      assert.equal(result.weeklyTokens, 10_000_000);
      assert.equal(result.intervals, 5);
      assert.equal(result.remainingTokens, 1_000_000);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
}

test('calibration is pure and does not depend on API prices or FX settings', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = estimateTokenCapacity(input);
  assert.deepEqual(input, before);
  assert.deepEqual(estimateTokenCapacity({ ...input, currency: 'EUR', usdToCurrency: 999,
    priceCatalog: [{ model: 'gpt-5.6-sol', input_usd_per_million: 99999 }] }), result);
});
