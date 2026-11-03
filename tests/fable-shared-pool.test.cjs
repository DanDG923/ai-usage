'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applySharedPool } = require('../electron/fable-shared-pool.cjs');
const { buildDashboardVerdict, foldsInto, poolDrivenBucket } = require('../electron/dashboard-decision.cjs');
const { exhaustionTime } = require('../electron/forecast.cjs');
const { flyoutPayload } = require('../electron/flyout.cjs');
const { buildSummaryLines, buildTrayTooltip, decideNotifications } = require('../electron/notifications.cjs');
const { UsageStore } = require('../electron/store.cjs');

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse('2026-09-16T13:00:00Z');
const RESET = '2026-09-19T08:00:00.000Z';
const RESET_MS = Date.parse(RESET);
const iso = (at) => new Date(at).toISOString();
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);

// ---------------------------------------------------------------------------
// Store fixture: real readings through getTraySnapshot.

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-shared-pool-'));
  const store = new UsageStore(path.join(root, 'db.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const claude = (observedAt, usedPercent, overrides = {}) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(observedAt), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'overall' }, ...overrides,
  });
  const fable = (observedAt, usedPercent, overrides = {}) => store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable weekly', observedAt: iso(observedAt),
    usedPercent, remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'model' }, ...overrides,
  });
  const usage = (key, occurredAt, model, inputTokens) => store.recordUsageEvent({
    eventKey: `shared-pool:${key}`, sourceId: 'claude', occurredAt: iso(occurredAt), sessionId: 'session', model,
    inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, metadata: {},
  });
  return {
    store, claude, fable, usage,
    snapshot: (nowMs = NOW, options) => store.getTraySnapshot(nowMs, options),
    fableOnly: (nowMs = NOW) => store.getQuota('claude-fable', store.getSettings(), nowMs),
  };
}

// The user's week: another model has used 70% of the Claude weekly limit and
// Fable none of its own. Each pair of readings is taken in one refresh.
function opusWeek(context, { claudeReset = RESET } = {}) {
  const steps = [[72 * HOUR, 20], [48 * HOUR, 40], [24 * HOUR, 55], [10 * MINUTE, 70]];
  for (const [ago, used] of steps) {
    context.claude(NOW - ago, used, { resetsAt: claudeReset });
    context.fable(NOW - ago, 0);
  }
}

const fableWindowOf = (quota) => quota.windows.find((window) => window.bucketId === 'fable_seven_day');

// ---------------------------------------------------------------------------
// Unit fixtures: hand-built windows with hourly forecast series.

const T0 = Date.parse('2026-09-16T12:00:00Z');

function hourly(hours, value, start = T0) {
  return Array.from({ length: hours + 1 }, (_, hour) => {
    const projected = value(hour);
    return { at: start + hour * HOUR, remaining: Math.max(0, Math.min(100, projected)), projected };
  });
}

function forecastOf(expected, heavy = expected, overrides = {}) {
  return {
    state: 'safe', expired: false,
    expectedRemaining: expected.at(-1).remaining, heavyRemaining: heavy.at(-1).remaining,
    exhaustsAt: exhaustionTime(expected), heavyExhaustsAt: exhaustionTime(heavy),
    paceRatio: 0.3, safePace: 4, recentPace: 1.2, workingPace: 1.5, windowPace: 1, reservePercent: 0,
    confidence: 0.8, learnedSamples: 6, currentIsEstimated: false, estimatedCurrentRemaining: expected[0].remaining,
    staleHours: 0,
    series: {
      observed: [{ at: T0 - 2 * HOUR, remaining: expected[0].remaining }, { at: T0, remaining: expected[0].remaining }],
      expected, heavy,
    },
    ...overrides,
  };
}

function fableWindow(remaining, forecast, overrides = {}) {
  return {
    bucketId: 'fable_seven_day', bucketName: 'Fable weekly', windowMinutes: 10_080, observedAt: iso(T0),
    usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: iso(T0 + 10 * HOUR), planType: 'max',
    provenance: 'official-claude-usage', metadata: { scope: 'model' }, forecast, tokenCapacity: null, ...overrides,
  };
}

function poolWindow(remaining, forecast, overrides = {}) {
  return {
    bucketId: 'seven_day', bucketName: 'Weekly', windowMinutes: 10_080, observedAt: iso(T0),
    usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: iso(T0 + 10 * HOUR), planType: 'max',
    provenance: 'official-claude-usage', metadata: { scope: 'overall' }, forecast, ...overrides,
  };
}

const quotaOf = (window) => ({ ...window, windows: [window] });
const apply = (fable, pool, nowMs = T0, settings = {}) => applySharedPool(quotaOf(fable), pool ? quotaOf(pool) : null, { nowMs, settings });

// ---------------------------------------------------------------------------
// Through the store.

test('the user scenario: Claude weekly at 70% used caps an unused Fable limit at 60% usable', (t) => {
  const context = fixture(t);
  opusWeek(context);
  const snapshot = context.snapshot();
  const fable = snapshot.quotas.fable;
  const pool = fable.sharedPool;
  assert.equal(pool.status, 'applied');
  assert.equal(pool.share, 0.5);
  assert.equal(pool.capRemaining, 100);
  assert.equal(pool.poolRemaining, 30);
  assert.equal(pool.poolAsFable, 60);
  assert.equal(pool.usableRemaining, 60);
  assert.equal(pool.binding, 'pool');
  assert.equal(pool.bindingAtReset, 'pool');
  assert.equal(pool.estimated, false, 'both readings are fresh and taken together');
  assert.equal(pool.pool.bucketId, 'seven_day');
  assert.equal(pool.pool.resetsAt, RESET);
  assert.equal(pool.cap.expectedRemaining, context.fableOnly().forecast.expectedRemaining);
  // The provider's own Fable figure is kept beside the cap.
  assert.equal(fable.remainingPercent, 100);
  assert.equal(fable.usedPercent, 0);
  assert.deepEqual(fableWindowOf(fable).sharedPool, pool, 'the headline window and its windows entry agree');
  assert.deepEqual(fableWindowOf(fable).forecast, fable.forecast);
  // The observed history is capped too, and the Fable-only history is kept.
  assert.equal(fable.forecast.series.observed.at(-1).remaining, 60);
  assert.ok(pool.cap.observed.every((point) => point.remaining === 100));
  assert.ok(pool.ceiling.expected.length > 1);
  assert.equal(pool.ceiling.expected[0].remaining, snapshot.quotas.claude.forecast.series.expected[0].remaining / 0.5);
  // The combined forecast is never above the Fable-only forecast.
  const own = context.fableOnly().forecast.series.expected;
  const ownAt = new Map(own.map((point) => [point.at, point.remaining]));
  for (const point of fable.forecast.series.expected) {
    if (ownAt.has(point.at)) assert.ok(point.remaining <= ownAt.get(point.at) + 1e-9, `combined above Fable-only at ${iso(point.at)}`);
  }
  // Nothing about the cap leaks into the stored or cached Fable quota.
  assert.equal('sharedPool' in context.fableOnly(), false);
  assert.equal(context.fableOnly().remainingPercent, 100);
});

test('token capacity is scaled once per snapshot and the cached estimate is never shrunk', (t) => {
  const context = fixture(t);
  // Fable climbs ten points a day on local Fable tokens, so its capacity can
  // be calibrated; Claude weekly ends at 80% used, 40 Fable points.
  const steps = [[96, 5, 10], [72, 30, 20], [48, 50, 30], [24, 65, 40], [0.1, 80, 50]];
  steps.forEach(([hoursAgo, claudeUsed, fableUsed], index) => {
    if (index) {
      context.store.recordUsageEvent({ eventKey: `capacity-${index}`, sourceId: 'claude', model: 'claude-fable-5',
        occurredAt: iso(NOW - (hoursAgo + 2) * HOUR), inputTokens: 1_000_000, outputTokens: 50_000 });
    }
    context.claude(NOW - hoursAgo * HOUR, claudeUsed);
    context.fable(NOW - hoursAgo * HOUR, fableUsed);
  });
  const own = context.fableOnly().tokenCapacity;
  assert.equal(own.status, 'available');
  const first = context.snapshot(NOW, { tokenCapacity: true });
  const second = context.snapshot(NOW, { tokenCapacity: true });
  const pool = first.quotas.fable.sharedPool;
  assert.equal(pool.binding, 'pool');
  assert.equal(pool.capRemaining, 50);
  assert.equal(pool.usableRemaining, 40);
  // The Claude weekly reading leaves 20%, 40 Fable points: its share of the
  // estimated week, dated to that reading.
  near(first.quotas.fable.tokenCapacity.remainingTokens, own.weeklyTokens * 0.4, 1e-6, 'capped capacity');
  assert.equal(first.quotas.fable.tokenCapacity.remainingAsOf, pool.pool.observedAt);
  assert.equal(first.quotas.fable.tokenCapacity.warnings.length, own.warnings.length + 1);
  assert.deepEqual(second.quotas.fable, first.quotas.fable, 'a second snapshot does not scale twice');
  assert.deepEqual(context.fableOnly().tokenCapacity, own, 'the cached capacity is untouched');
});

test('a fresh shared pool cannot revive remaining tokens withheld for stale Fable evidence', (t) => {
  const context = fixture(t);
  [96, 72, 48, 25].forEach((hoursAgo, index) => {
    if (index) context.usage(`stale-capacity-${index}`, NOW - (hoursAgo + 2) * HOUR, 'claude-fable-5', 1_000_000);
    context.fable(NOW - hoursAgo * HOUR, 10 + index * 10);
  });
  context.claude(NOW, 95);
  const own = context.fableOnly().tokenCapacity;
  assert.equal(own.status, 'available');
  assert.equal(own.remainingTokens, null);
  const capped = context.snapshot(NOW, { tokenCapacity: true }).quotas.fable;
  assert.equal(capped.sharedPool.binding, 'pool');
  assert.deepEqual(capped.tokenCapacity, own);
});

test('a stale limiting pool withholds remaining tokens even when Fable evidence is fresh', (t) => {
  const context = fixture(t);
  [96, 72, 48, 0].forEach((hoursAgo, index) => {
    if (index) context.usage(`stale-pool-${index}`, NOW - (hoursAgo + 2) * HOUR, 'claude-fable-5', 1_000_000);
    context.fable(NOW - hoursAgo * HOUR, 10 + index * 10);
  });
  context.claude(NOW - 25 * HOUR, 95);
  const own = context.fableOnly().tokenCapacity;
  assert.ok(own.remainingTokens > 0);
  const capped = context.snapshot(NOW, { tokenCapacity: true }).quotas.fable;
  assert.equal(capped.sharedPool.binding, 'pool');
  assert.equal(capped.tokenCapacity.remainingTokens, null);
  assert.equal(capped.tokenCapacity.remainingRange, null);
  assert.equal(capped.tokenCapacity.remainingAsOf, null);
  assert.equal(capped.tokenCapacity.weeklyTokens, own.weeklyTokens);
  assert.deepEqual(context.fableOnly().tokenCapacity, own);
});

test('when Fable\'s own limit is tighter the cap binds and the forecast is Fable\'s own', (t) => {
  const context = fixture(t);
  // Claude 60% used (80 Fable points left), Fable 80% used (20 left). The two
  // are consistent: Fable's 40 points of the week fit inside Claude's 60.
  for (const [ago, claudeUsed, fableUsed] of [[48 * HOUR, 40, 70], [24 * HOUR, 50, 75], [10 * MINUTE, 60, 80]]) {
    context.claude(NOW - ago, claudeUsed);
    context.fable(NOW - ago, fableUsed);
  }
  const fable = context.snapshot().quotas.fable;
  const own = context.fableOnly().forecast;
  assert.equal(fable.sharedPool.status, 'applied');
  assert.equal(fable.sharedPool.binding, 'cap');
  assert.equal(fable.sharedPool.bindingAtReset, 'cap');
  assert.equal(fable.sharedPool.usableRemaining, 20);
  assert.equal(fable.sharedPool.capRemaining, 20);
  assert.equal(fable.sharedPool.poolAsFable, 80);
  assert.equal(fable.sharedPool.paceSource, 'cap');
  assert.equal(fable.forecast.state, own.state);
  near(fable.forecast.expectedRemaining, own.expectedRemaining, 1e-9, 'expected remaining');
  near(fable.forecast.heavyRemaining, own.heavyRemaining, 1e-9, 'heavy remaining');
  assert.equal(fable.forecast.exhaustsAt, own.exhaustsAt);
  assert.equal(fable.forecast.paceRatio, own.paceRatio);
  assert.equal(fable.forecast.safePace, own.safePace);
  assert.equal(fable.forecast.reservePercent, own.reservePercent);
});

test('a pool reset reported half a second either side of Fable\'s is the same reset', (t) => {
  const results = [-500, 400].map((offset) => {
    const context = fixture(t);
    opusWeek(context, { claudeReset: iso(RESET_MS + offset) });
    return { fable: context.snapshot().quotas.fable, own: context.fableOnly() };
  });
  const [before, after] = results;
  assert.equal(before.fable.sharedPool.status, 'applied');
  assert.equal(after.fable.sharedPool.status, 'applied');
  assert.equal(before.fable.sharedPool.bindingAtReset, after.fable.sharedPool.bindingAtReset);
  assert.equal(before.fable.sharedPool.bindingAtReset, 'pool');
  near(before.fable.forecast.expectedRemaining, after.fable.forecast.expectedRemaining, 1, 'expected remaining at reset');
  for (const { fable, own } of results) {
    const last = fable.forecast.series.expected.at(-1);
    const ownLast = own.forecast.series.expected.at(-1);
    assert.equal(last.at, ownLast.at);
    assert.ok(last.remaining < ownLast.remaining - 1,
      `the last point (${last.remaining}) must still be capped, not Fable-only (${ownLast.remaining})`);
    assert.equal(fable.forecast.expectedRemaining, last.remaining);
  }
});

test('readings that break the half share mark the pool unavailable and leave the forecast Fable-only', (t) => {
  const context = fixture(t);
  context.claude(NOW - 24 * HOUR, 10);
  context.fable(NOW - 24 * HOUR, 50);
  context.claude(NOW - 10 * MINUTE, 20);
  context.fable(NOW - 10 * MINUTE, 90);
  const fable = context.snapshot().quotas.fable;
  assert.deepEqual(fable.sharedPool, { status: 'unavailable', reason: 'share-inconsistent' });
  assert.deepEqual(fable.forecast, context.fableOnly().forecast);
  assert.deepEqual(fableWindowOf(fable).sharedPool, fable.sharedPool);

  // The same figures read at different moments are not a contradiction.
  const apart = fixture(t);
  apart.claude(NOW - 24 * HOUR, 10);
  apart.fable(NOW - 24 * HOUR, 50);
  apart.claude(NOW - 40 * MINUTE, 20);
  apart.fable(NOW - 10 * MINUTE, 90);
  const pool = apart.snapshot().quotas.fable.sharedPool;
  assert.equal(pool.status, 'applied');
  assert.equal(pool.binding, 'cap');
  assert.equal(pool.estimated, true);
});

test('without a live Claude weekly window the pool is unavailable and says why', (t) => {
  const none = fixture(t);
  none.fable(NOW - 10 * MINUTE, 30);
  const alone = none.snapshot();
  assert.equal(alone.quotas.claude, null);
  assert.deepEqual(alone.quotas.fable.sharedPool, { status: 'unavailable', reason: 'no-weekly-pool' });
  assert.deepEqual(alone.quotas.fable.forecast, none.fableOnly().forecast);

  const sessionOnly = fixture(t);
  sessionOnly.fable(NOW - 10 * MINUTE, 30);
  sessionOnly.claude(NOW - 10 * MINUTE, 90, { bucketId: 'five_hour', bucketName: 'Session', windowMinutes: 300,
    resetsAt: iso(NOW + 2 * HOUR) });
  assert.deepEqual(sessionOnly.snapshot().quotas.fable.sharedPool, { status: 'unavailable', reason: 'no-weekly-pool' },
    'the five-hour session is not the weekly pool');

  const expired = fixture(t);
  expired.fable(NOW - 10 * MINUTE, 30);
  expired.claude(NOW - 9 * 24 * HOUR, 80, { resetsAt: iso(NOW - 2 * 24 * HOUR) });
  const stale = expired.snapshot();
  assert.equal(stale.quotas.claude.forecast.expired, true);
  assert.deepEqual(stale.quotas.fable.sharedPool, { status: 'unavailable', reason: 'pool-expired' });
  assert.deepEqual(stale.quotas.fable.forecast, expired.fableOnly().forecast);

  // An expired Fable window is left exactly as it was.
  const oldFable = fixture(t);
  oldFable.claude(NOW - 10 * MINUTE, 70);
  oldFable.fable(NOW - 9 * 24 * HOUR, 30, { resetsAt: iso(NOW - 2 * 24 * HOUR) });
  const past = oldFable.snapshot().quotas.fable;
  assert.equal(past.forecast.expired, true);
  assert.equal('sharedPool' in past, false);
});

test('a Fable forecast still learning from one reading is capped now all the same', (t) => {
  const context = fixture(t);
  for (const [ago, used] of [[48 * HOUR, 40], [24 * HOUR, 55], [10 * MINUTE, 70]]) context.claude(NOW - ago, used);
  context.fable(NOW - 10 * MINUTE, 0);
  const fable = context.snapshot().quotas.fable;
  assert.equal(fable.forecast.learnedSamples, 0);
  assert.equal(fable.sharedPool.status, 'applied');
  assert.equal(fable.sharedPool.usableRemaining, 60);
  assert.equal(fable.sharedPool.binding, 'pool');
});

test('a projected Fable window is capped by the pool like a provider reading', (t) => {
  const context = fixture(t);
  // Mostly Opus: 70 points of the week, a fifteenth of it Fable's pressure.
  context.claude(NOW - 25 * HOUR, 10);
  context.usage('fable', NOW - 20 * HOUR, 'claude-fable-5', 1_000_000);
  context.usage('opus', NOW - 19 * HOUR, 'claude-opus-5', 28_000_000);
  context.claude(NOW - 10 * MINUTE, 80);
  const fable = context.snapshot().quotas.fable;
  assert.equal(fable.provenance, 'derived-tokens');
  near(fable.usedPercent, 70 / 15 / 0.5, 0.01, 'projected Fable use');
  assert.equal(fable.sharedPool.status, 'applied');
  assert.equal(fable.sharedPool.binding, 'pool');
  assert.equal(fable.sharedPool.usableRemaining, 40);
});

// ---------------------------------------------------------------------------
// applySharedPool as a pure function.

test('the Fable learning branch caps the figure and the history but invents no projection', () => {
  const learning = {
    state: 'unknown', expired: false, expectedRemaining: null, heavyRemaining: null, exhaustsAt: null,
    heavyExhaustsAt: null, paceRatio: 0, currentIsEstimated: false, estimatedCurrentRemaining: null, confidence: 0,
    series: { observed: [{ at: T0 - 2 * HOUR, remaining: 100 }, { at: T0, remaining: 100 }], expected: [], heavy: [] },
  };
  const poolForecast = forecastOf(hourly(10, (hour) => 30 - hour), undefined, {
    series: {
      observed: [{ at: T0 - 3 * HOUR, remaining: 40 }, { at: T0 - HOUR, remaining: 30 }],
      expected: hourly(10, (hour) => 30 - hour), heavy: hourly(10, (hour) => 30 - hour),
    },
  });
  const fable = fableWindow(100, learning);
  const pool = poolWindow(30, poolForecast, { observedAt: iso(T0 - HOUR) });
  const inputs = structuredClone({ fable, pool });
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.status, 'applied');
  assert.equal(result.sharedPool.usableRemaining, 60);
  assert.equal(result.sharedPool.binding, 'pool');
  assert.equal(result.sharedPool.bindingAtReset, null);
  assert.equal(result.forecast.state, 'unknown');
  assert.equal(result.forecast.expectedRemaining, null);
  assert.deepEqual(result.forecast.series.expected, []);
  assert.deepEqual(result.forecast.series.observed, [
    { at: T0 - 2 * HOUR, remaining: 80 },
    { at: T0 - HOUR, remaining: 60 },
    { at: T0, remaining: 60 },
  ]);
  assert.deepEqual({ fable, pool }, inputs, 'inputs are not modified');
});

test('the combination is an estimate when the two readings are more than fifteen minutes apart', () => {
  const flat = (value) => forecastOf(hourly(10, () => value));
  const estimatedFor = (poolObservedAt, poolOverrides = {}) => apply(
    fableWindow(100, flat(100)),
    poolWindow(30, { ...flat(30), ...poolOverrides }, { observedAt: iso(poolObservedAt) }),
  ).sharedPool.estimated;
  assert.equal(estimatedFor(T0), false);
  assert.equal(estimatedFor(T0 - 10 * MINUTE), false);
  assert.equal(estimatedFor(T0 - 15 * MINUTE), false, 'fifteen minutes is still one moment');
  assert.equal(estimatedFor(T0 - 20 * MINUTE), true);
  assert.equal(estimatedFor(T0 + 20 * MINUTE), true);
  assert.equal(estimatedFor(T0, { currentIsEstimated: true, estimatedCurrentRemaining: 29 }), true,
    'an estimated pool figure makes the combination an estimate');
});

test('the pool falls at least as fast as Fable\'s own projected use', () => {
  // Fable spends ten points an hour; the pool forecast, learned separately,
  // is flat at 40% (80 Fable points). Every Fable point spent is half a pool
  // point, so the ceiling cannot stay at 80.
  const own = (hour) => 100 - 10 * hour;
  const heavy = (hour) => 100 - 12 * hour;
  const fable = fableWindow(100, forecastOf(hourly(10, own), hourly(10, heavy)));
  const pool = poolWindow(40, forecastOf(hourly(10, () => 40), hourly(10, () => 40), { paceRatio: 0.1 }));
  const inputs = structuredClone({ fable, pool });
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.usableRemaining, 80);
  assert.equal(result.sharedPool.binding, 'pool');
  for (const point of result.forecast.series.expected) {
    const hour = (point.at - T0) / HOUR;
    assert.ok(point.remaining <= Math.max(0, 80 - (100 - own(hour))) + 1e-9,
      `expected ${point.remaining} at hour ${hour} exceeds the pool start less Fable's own use`);
  }
  for (const point of result.forecast.series.heavy) {
    const hour = (point.at - T0) / HOUR;
    assert.ok(point.remaining <= Math.max(0, 80 - (100 - heavy(hour))) + 1e-9, `heavy exceeds at hour ${hour}`);
  }
  assert.equal(result.forecast.series.expected[5].remaining, 30, 'a pointwise minimum alone would give 50');
  assert.equal(result.forecast.exhaustsAt, iso(T0 + 8 * HOUR));
  assert.equal(result.sharedPool.cap.exhaustsAt, iso(T0 + 10 * HOUR));
  near(Date.parse(result.forecast.heavyExhaustsAt), T0 + (80 / 12) * HOUR, 1000, 'heavy run-out');
  assert.equal(result.forecast.state, 'critical');
  assert.deepEqual({ fable, pool }, inputs);
});

test('when the pool runs out first, Fable runs out inside the same hour at the pool\'s instant', () => {
  const fableForecast = forecastOf(hourly(10, (hour) => 100 - hour), undefined, { reservePercent: 0, confidence: 0.8, paceRatio: 0.3 });
  const poolForecast = forecastOf(hourly(10, (hour) => 20 - 3 * hour), undefined, {
    state: 'critical', paceRatio: 2.5, safePace: 1, recentPace: 2.5, workingPace: 3, windowPace: 2,
    reservePercent: 10, confidence: 0.5,
  });
  const fable = fableWindow(100, fableForecast);
  const pool = poolWindow(20, poolForecast);
  const inputs = structuredClone({ fable, pool });
  const result = apply(fable, pool, T0, { paceRiskThreshold: 1.2, hardLimitThreshold: 90 });
  const shared = result.sharedPool;
  assert.equal(shared.poolAsFable, 40);
  assert.equal(shared.usableRemaining, 40);
  assert.equal(shared.binding, 'pool');
  assert.equal(shared.bindingAtReset, 'pool');
  assert.equal(shared.paceSource, 'pool');
  // 20 - 3h reaches zero at 6h40m; so does its ceiling in Fable points.
  const runOut = T0 + (20 / 3) * HOUR;
  near(Date.parse(result.forecast.exhaustsAt), runOut, 1000, 'combined run-out');
  near(Date.parse(poolForecast.exhaustsAt), runOut, 1000, 'pool run-out');
  assert.equal(shared.pool.exhaustsAt, poolForecast.exhaustsAt);
  assert.equal(result.forecast.expectedRemaining, 0);
  assert.equal(result.forecast.state, 'critical');
  // Pace, reserve and confidence follow the pool, in Fable points.
  assert.equal(result.forecast.paceRatio, 2.5);
  assert.equal(result.forecast.safePace, 2);
  assert.equal(result.forecast.recentPace, 5);
  assert.equal(result.forecast.workingPace, 6);
  assert.equal(result.forecast.windowPace, 4);
  assert.equal(result.forecast.reservePercent, 20);
  assert.equal(result.forecast.confidence, 0.5);
  // Fable's own forecast is kept under cap.
  assert.equal(shared.cap.expectedRemaining, 90);
  assert.equal(shared.cap.exhaustsAt, null);
  assert.equal(shared.cap.state, 'safe');
  assert.equal(shared.cap.paceRatio, 0.3);
  assert.deepEqual(shared.cap.observed, fableForecast.series.observed);
  assert.deepEqual(shared.ceiling.expected, poolForecast.series.expected
    .map((point) => ({ at: point.at, remaining: point.remaining / 0.5 })));
  assert.deepEqual({ fable, pool }, inputs, 'inputs are not modified');
  assert.equal('sharedPool' in fable, false);
  assert.equal(result.windows[0].sharedPool, result.sharedPool);
});

test('a pool that resets before Fable\'s reset stops constraining after it, within a minute\'s tolerance', () => {
  const fableForecast = forecastOf(hourly(10, (hour) => 100 - hour));
  const poolFor = (resetMs) => {
    const hours = Math.floor((resetMs - T0) / HOUR);
    const expected = [...hourly(hours, (hour) => 20 - 3 * hour), { at: resetMs, remaining: 5, projected: 5 }]
      .filter((point, index, all) => index === all.findIndex((other) => other.at === point.at));
    return poolWindow(20, forecastOf(expected), { resetsAt: iso(resetMs) });
  };
  const early = apply(fableWindow(100, fableForecast), poolFor(T0 + 5 * HOUR));
  const byHour = new Map(early.forecast.series.expected.map((point) => [(point.at - T0) / HOUR, point.remaining]));
  assert.equal(byHour.get(4), 16, 'the week at 8% is 16 Fable points');
  for (const hour of [6, 7, 8, 9, 10]) assert.equal(byHour.get(hour), 100 - hour, `hour ${hour} is Fable-only after the pool refills`);
  assert.equal(early.forecast.expectedRemaining, 90);

  // Half a second or thirty seconds early is the same reset; two minutes is not.
  const fableReset = T0 + 10 * HOUR;
  for (const offset of [-500, -30_000, 400]) {
    const result = apply(fableWindow(100, fableForecast), poolFor(fableReset + offset));
    assert.ok(result.forecast.expectedRemaining < 90, `offset ${offset}: the last point is still capped`);
  }
  const released = apply(fableWindow(100, fableForecast), poolFor(fableReset - 2 * MINUTE));
  assert.equal(released.forecast.expectedRemaining, 90);
});

test('token capacity is scaled as a copy when the pool binds now, and left alone when the cap binds', () => {
  const capacity = {
    status: 'available', weeklyTokens: 1_000_000, weeklyRange: { low: 800_000, high: 1_200_000 },
    remainingTokens: 1_000_000, remainingRange: { low: 800_000, high: 1_200_000 },
    remainingAsOf: iso(T0 - HOUR), warnings: ['base warning'], modelMix: [{ model: 'claude-fable-5', share: 1 }],
  };
  const flat = (value) => forecastOf(hourly(10, () => value));
  const fable = fableWindow(100, flat(100), { tokenCapacity: capacity });
  const input = structuredClone(fable);
  const first = apply(fable, poolWindow(30, flat(30)));
  const second = apply(fable, poolWindow(30, flat(30)));
  assert.notEqual(first.tokenCapacity, capacity);
  assert.equal(first.tokenCapacity.remainingTokens, 600_000);
  assert.deepEqual(first.tokenCapacity.remainingRange, { low: 480_000, high: 720_000 });
  assert.equal(first.tokenCapacity.remainingAsOf, iso(T0), 'dated to the Claude weekly reading');
  assert.equal(first.sharedPool.cap.tokenCapacity, capacity, 'the original is kept for release');
  assert.equal(first.tokenCapacity.warnings.length, 2);
  assert.equal(first.tokenCapacity.warnings[0], 'base warning');
  assert.match(first.tokenCapacity.warnings[1], /Claude weekly reading/);
  assert.deepEqual(first.tokenCapacity.modelMix, capacity.modelMix);
  assert.deepEqual(second.tokenCapacity, first.tokenCapacity, 'a second pass over the same input does not shrink twice');
  assert.deepEqual(fable, input, 'the cached capacity object is untouched');

  const capBinds = apply(fable, poolWindow(80, flat(80)));
  assert.equal(capBinds.sharedPool.binding, 'cap');
  assert.equal(capBinds.tokenCapacity, capacity);
  const unavailable = { status: 'unavailable', reason: 'not-enough-evidence' };
  assert.equal(apply(fableWindow(100, flat(100), { tokenCapacity: unavailable }), poolWindow(30, flat(30))).tokenCapacity, unavailable);
});

test('other buckets and short windows are returned untouched and a null quota stays null', () => {
  const flat = (value) => forecastOf(hourly(10, () => value));
  assert.equal(applySharedPool(null, quotaOf(poolWindow(30, flat(30))), { nowMs: T0 }), null);
  const other = fableWindow(100, flat(100), { bucketId: 'fable:session', windowMinutes: 300 });
  const result = apply(other, poolWindow(30, flat(30)));
  assert.equal('sharedPool' in result, false);
  assert.deepEqual(result.forecast, other.forecast);
  const alternate = apply(fableWindow(100, flat(100), { bucketId: 'fable:seven_day_fable' }), poolWindow(30, flat(30)));
  assert.equal(alternate.sharedPool.usableRemaining, 60, 'the alternate weekly Fable bucket is capped too');
});

// ---------------------------------------------------------------------------
// Verdict, notifications, flyout and the renderer's clock.

function verdictSnapshot({ capState = 'safe', fableState = 'critical', claudeState = 'critical' } = {}) {
  const claude = {
    bucketId: 'seven_day', bucketName: 'Weekly', windowMinutes: 10_080, resetsAt: RESET, observedAt: iso(NOW),
    remainingPercent: 30, usedPercent: 70, metadata: { scope: 'overall' },
    forecast: { state: claudeState, expired: false, expectedRemaining: 0, exhaustsAt: iso(NOW + 30 * HOUR), paceRatio: 3, staleHours: 0 },
  };
  const fable = {
    bucketId: 'fable_seven_day', bucketName: 'Fable weekly', windowMinutes: 10_080, resetsAt: RESET, observedAt: iso(NOW),
    remainingPercent: 100, usedPercent: 0, metadata: { scope: 'model' },
    forecast: { state: fableState, expired: false, expectedRemaining: 0, exhaustsAt: iso(NOW + 30 * HOUR), paceRatio: 3, staleHours: 0 },
    sharedPool: {
      status: 'applied', share: 0.5, capRemaining: 100, poolRemaining: 30, poolAsFable: 60, usableRemaining: 60,
      binding: 'pool', bindingAtReset: 'pool', estimated: false, paceSource: 'pool',
      cap: { expectedRemaining: 100, heavyRemaining: 100, exhaustsAt: null, heavyExhaustsAt: null, state: capState, paceRatio: 0, observed: [] },
      pool: { bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(NOW), resetsAt: RESET, provenance: 'official-claude-usage',
        state: claudeState, expectedRemaining: 0, heavyRemaining: 0, exhaustsAt: iso(NOW + 30 * HOUR) },
      ceiling: { observed: [], expected: [] },
    },
  };
  const codex = { bucketId: 'codex:weekly', bucketName: 'Weekly', windowMinutes: 10_080, resetsAt: RESET, observedAt: iso(NOW),
    remainingPercent: 80, usedPercent: 20, metadata: {}, forecast: { state: 'safe', expired: false, staleHours: 0 } };
  return {
    settings: { notifyDesktop: true, notifyResets: true, notifyFallback: true, notifyDigest: false, digestHour: 9, alertsSnoozedUntil: null },
    sources: [{ id: 'codex', status: 'connected' }, { id: 'claude', status: 'connected' }, { id: 'claude-fable', status: 'connected' }],
    quotas: { codex: quotaOf(codex), claude: quotaOf(claude), fable: quotaOf(fable) },
  };
}

test('a pool-driven Fable state folds into the Claude weekly entry, named as included', () => {
  const snapshot = verdictSnapshot();
  const fableEntry = snapshot.quotas.fable.windows[0];
  assert.equal(poolDrivenBucket(fableEntry), 'seven_day');
  assert.equal(foldsInto(fableEntry, snapshot.quotas.claude.windows[0]), true);
  assert.equal(foldsInto(fableEntry, { ...snapshot.quotas.claude.windows[0], bucketId: 'five_hour' }), false);
  const verdict = buildDashboardVerdict(snapshot);
  assert.equal(verdict.state, 'critical');
  assert.equal(verdict.label, 'Claude will reach its limit before reset, Fable included');
  assert.deepEqual(verdict.affected, ['Claude · Weekly']);
  assert.equal(verdict.affected.some((label) => label.startsWith('Fable')), false);
  assert.equal(verdict.details.length, 1);
  assert.equal(verdict.details[0].sourceId, 'claude');
  assert.deepEqual(verdict.details[0].includes, ['Fable']);
  assert.equal(verdict.windowsChecked, 3);

  // A Fable state from its own limit stays a Fable entry.
  const own = buildDashboardVerdict(verdictSnapshot({ capState: 'critical' }));
  assert.equal(poolDrivenBucket(verdictSnapshot({ capState: 'critical' }).quotas.fable.windows[0]), null);
  assert.equal(own.label, 'Claude and Fable will reach their limits before reset');
  assert.deepEqual(own.affected, ['Claude · Weekly', 'Fable · Fable weekly']);
  assert.equal(own.details.some((detail) => detail.includes), false);

  // A pool-driven Fable worse than its Claude host is not hidden behind it.
  const worse = buildDashboardVerdict(verdictSnapshot({ claudeState: 'watch' }));
  assert.equal(worse.state, 'critical');
  assert.deepEqual(worse.affected, ['Fable · Fable weekly']);
  assert.doesNotMatch(worse.label, /included/);
});

test('the store verdict for the user scenario reports Claude once, with Fable included', (t) => {
  const context = fixture(t);
  opusWeek(context);
  const snapshot = context.snapshot();
  assert.equal(snapshot.quotas.claude.forecast.state, 'critical');
  assert.equal(snapshot.quotas.fable.sharedPool.cap.state, 'safe');
  assert.equal(snapshot.dashboardVerdict.label, 'Claude will reach its limit before reset, Fable included');
  assert.deepEqual(snapshot.dashboardVerdict.affected, ['Claude · Weekly']);
  assert.deepEqual(snapshot.dashboardVerdict.details[0].includes, ['Fable']);
});

test('tray, summary and risk toast read the usable figure and name Fable as affected', (t) => {
  const context = fixture(t);
  opusWeek(context);
  const snapshot = context.snapshot();
  assert.match(buildTrayTooltip(snapshot), /Fable 60% usable/);
  assert.match(buildTrayTooltip(snapshot), /Claude 30%/);
  const lines = buildSummaryLines(snapshot, NOW);
  const fableLine = lines.find((line) => line.startsWith('Fable:'));
  assert.match(fableLine, /^Fable: 60% usable \(Fable limit 100% left\)/);
  assert.match(fableLine, /expected 0% at reset/);
  const { notifications } = decideNotifications({ previous: null, current: snapshot, nowMs: NOW });
  const risk = notifications.find((entry) => entry.kind === 'risk');
  assert.ok(risk, 'a critical verdict raises a risk toast');
  assert.match(risk.body, /^Claude · Weekly is projected to exhaust its allowance before reset\./);
  assert.match(risk.body, /Fable draws on the same weekly limit, so it is affected too\.$/);

  // An estimated combination is shown as one; a cap-bound Fable is not "usable".
  const estimated = structuredClone(snapshot);
  for (const window of [estimated.quotas.fable, ...estimated.quotas.fable.windows]) window.sharedPool.estimated = true;
  assert.match(buildTrayTooltip(estimated), /Fable ~60% usable/);
  const capBound = verdictSnapshot();
  for (const window of [capBound.quotas.fable, ...capBound.quotas.fable.windows]) {
    window.sharedPool = { ...window.sharedPool, binding: 'cap', usableRemaining: 55, capRemaining: 55 };
  }
  assert.match(buildTrayTooltip(capBound), /Fable 55%(?! usable)/);
  assert.match(buildSummaryLines(capBound, NOW).find((line) => line.startsWith('Fable:')), /^Fable: 55% left/);
});

test('the flyout keeps the shared-pool figures but drops its chart lines', (t) => {
  const context = fixture(t);
  opusWeek(context);
  const snapshot = context.store.getDashboardSnapshot(30, NOW);
  const before = structuredClone(snapshot.quotas.fable.sharedPool);
  assert.ok(before.ceiling.expected.length > 0 && before.cap.observed.length > 0);
  const payload = flyoutPayload(snapshot);
  for (const window of [payload.quotas.fable, ...payload.quotas.fable.windows]) {
    assert.deepEqual(window.sharedPool.ceiling, { observed: [], expected: [] });
    assert.deepEqual(window.sharedPool.cap.observed, []);
    assert.equal(window.sharedPool.usableRemaining, 60);
    assert.equal(window.sharedPool.binding, 'pool');
    assert.equal(window.sharedPool.cap.expectedRemaining, before.cap.expectedRemaining);
    assert.equal(window.sharedPool.pool.resetsAt, RESET);
  }
  assert.deepEqual(snapshot.quotas.fable.sharedPool, before, 'the dashboard snapshot is not modified');
  const unavailable = { status: 'unavailable', reason: 'no-weekly-pool' };
  const plain = flyoutPayload({ quotas: { fable: { ...verdictSnapshot().quotas.fable, sharedPool: unavailable, windows: [] } } });
  assert.deepEqual(plain.quotas.fable.sharedPool, unavailable);
});

test('the renderer clock releases an applied pool a minute after the pool resets', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { snapshotAtTime } = await server.ssrLoadModule('/src/snapshot-time.ts');
    const snapshot = verdictSnapshot();
    const poolReset = Date.parse(RESET) - 24 * HOUR;
    const fableReset = Date.parse(RESET);
    const capObserved = [{ at: NOW - HOUR, remaining: 100 }, { at: NOW, remaining: 100 }];
    for (const window of [snapshot.quotas.fable, ...snapshot.quotas.fable.windows]) {
      window.resetsAt = iso(fableReset);
      window.forecast = { ...window.forecast, heavyRemaining: 0, heavyExhaustsAt: iso(NOW + 20 * HOUR),
        series: { observed: [{ at: NOW, remaining: 60 }], expected: [], heavy: [] } };
      window.sharedPool.pool.resetsAt = iso(poolReset);
      window.sharedPool.cap.observed = capObserved;
    }
    const original = structuredClone(snapshot);

    const within = snapshotAtTime(snapshot, poolReset + 30_000);
    assert.equal(within.quotas.fable.sharedPool.status, 'applied', 'inside the reset tolerance nothing is released');
    assert.equal(within.quotas.fable.forecast.state, 'critical');

    const after = snapshotAtTime(snapshot, poolReset + 61_000);
    for (const window of [after.quotas.fable, ...after.quotas.fable.windows]) {
      assert.deepEqual(window.sharedPool, { status: 'unavailable', reason: 'pool-expired' });
      assert.equal(window.forecast.state, 'safe');
      assert.equal(window.forecast.expectedRemaining, 100);
      assert.equal(window.forecast.heavyRemaining, 100);
      assert.equal(window.forecast.exhaustsAt, null);
      assert.equal(window.forecast.heavyExhaustsAt, null);
      assert.equal(window.forecast.paceRatio, 0);
      assert.deepEqual(window.forecast.series.observed, capObserved);
      assert.equal(window.forecast.expired, false, 'Fable\'s own window has not reset');
    }
    assert.deepEqual(snapshot, original, 'the input snapshot is not modified');
    assert.equal(after.dashboardVerdict.affected.includes('Fable · Fable weekly'), false);
  } finally { await server.close(); }
});

test('releasing an expired cap restores every Fable figure the cap replaced, token capacity included', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { snapshotAtTime } = await server.ssrLoadModule('/src/snapshot-time.ts');
    const capacity = {
      status: 'available', weeklyTokens: 1_000_000, weeklyRange: { low: 800_000, high: 1_200_000 },
      remainingTokens: 1_000_000, remainingRange: { low: 800_000, high: 1_200_000 },
      remainingAsOf: iso(T0 - HOUR), warnings: ['base warning'], modelMix: [], tokenMix: {},
    };
    // Fable's own pace is slow; the pool's is fast and wins, with its own reserve.
    const own = forecastOf(hourly(10, (hour) => 100 - hour), undefined,
      { paceRatio: 0.2, safePace: 9, recentPace: 1, workingPace: 1.4, windowPace: 0.9, reservePercent: 5, confidence: 0.9 });
    const pool = forecastOf(hourly(10, (hour) => 30 - 2.5 * hour), undefined,
      { paceRatio: 1.6, safePace: 1.5, recentPace: 2.4, workingPace: 3, windowPace: 2, reservePercent: 10, confidence: 0.6 });
    const fableReset = T0 + 10 * HOUR;
    const poolReset = T0 + 6 * HOUR;
    const capped = apply(fableWindow(100, own, { tokenCapacity: capacity, resetsAt: iso(fableReset) }),
      poolWindow(30, pool, { resetsAt: iso(poolReset) }));
    assert.equal(capped.sharedPool.paceSource, 'pool');
    assert.equal(capped.forecast.reservePercent, 20, 'the pool reserve in Fable points');
    assert.equal(capped.tokenCapacity.remainingTokens, 600_000);
    const snapshot = { generatedAt: iso(T0), settings: {}, sources: [],
      quotas: { codex: null, claude: null, fable: capped } };
    const after = snapshotAtTime(snapshot, poolReset + 2 * MINUTE);
    const released = after.quotas.fable;
    assert.deepEqual(released.sharedPool, { status: 'unavailable', reason: 'pool-expired' });
    for (const field of ['state', 'expectedRemaining', 'heavyRemaining', 'exhaustsAt', 'heavyExhaustsAt', 'paceRatio',
      'safePace', 'recentPace', 'workingPace', 'windowPace', 'reservePercent', 'confidence']) {
      assert.deepEqual(released.forecast[field], own[field], `${field} is Fable's own again`);
    }
    assert.deepEqual(released.forecast.series.expected, own.series.expected);
    assert.deepEqual(released.forecast.series.heavy, own.series.heavy);
    assert.equal(released.tokenCapacity.remainingTokens, 1_000_000);
    assert.deepEqual(released.tokenCapacity.remainingRange, { low: 800_000, high: 1_200_000 });
    assert.deepEqual(released.tokenCapacity.warnings, ['base warning']);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// Review fixes.

test('a Claude weekly limit that caps only Fable\'s heavier week is still reported once, on Claude', () => {
  // Same reset. Fable's own week is safe; Claude weekly runs out only in the heavier case.
  const fable = fableWindow(90, forecastOf(hourly(10, (hour) => 90 - 3 * hour), hourly(10, (hour) => 90 - 5 * hour)));
  const poolForecast = forecastOf(hourly(10, (hour) => 80 - 3 * hour), hourly(10, (hour) => 80 - 9 * hour),
    { state: 'risk', heavyRemaining: 0, paceRatio: 0.9 });
  const pool = poolWindow(80, poolForecast);
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.bindingAtReset, 'cap');
  assert.equal(result.sharedPool.heavyBindsAtReset, true);
  assert.equal(result.sharedPool.cap.state, 'safe');
  assert.equal(result.forecast.state, 'risk');
  assert.equal(poolDrivenBucket(result), 'seven_day');
  const claude = { ...pool, forecast: { ...poolForecast, state: 'risk' } };
  const verdict = buildDashboardVerdict({ quotas: { codex: null, claude: quotaOf(claude), fable: result } });
  assert.equal(verdict.label, 'Claude could reach its limit under heavier usage, Fable included');
  assert.deepEqual(verdict.affected, ['Claude · Weekly']);
});

test('a heavier-week run-out on the way is a risk even when an early Claude reset refills the week', () => {
  const fable = fableWindow(90, forecastOf(hourly(10, (hour) => 90 - hour), hourly(10, (hour) => 90 - 2 * hour)),
    { resetsAt: iso(T0 + 10 * HOUR) });
  // Claude resets after four hours; its heavier path empties before that.
  const pool = poolWindow(20, forecastOf(hourly(4, (hour) => 20 - 3 * hour), hourly(4, (hour) => 20 - 8 * hour),
    { state: 'risk' }), { resetsAt: iso(T0 + 4 * HOUR) });
  const result = apply(fable, pool);
  assert.ok(result.forecast.heavyExhaustsAt, 'the heavier path runs out on the way');
  assert.ok(result.forecast.heavyRemaining > 0, 'and refills after the Claude reset');
  assert.ok(['risk', 'critical'].includes(result.forecast.state));
});

test('the share check never rejects a projection or a Fable reading newer than the Claude one', () => {
  const flat = (value) => forecastOf(hourly(10, () => value));
  // Fable read ten minutes after Claude, having used more than twice the older Claude figure.
  const newer = apply(fableWindow(40, flat(40), { observedAt: iso(T0 + 10 * MINUTE) }), poolWindow(80, flat(80)));
  assert.equal(newer.sharedPool.status, 'applied');
  // A projected Fable figure is built on the half share and is never evidence against it.
  const projected = apply(fableWindow(40, flat(40), { provenance: 'derived-tokens' }), poolWindow(80, flat(80)));
  assert.equal(projected.sharedPool.status, 'applied');
  // Read together, the same figures break the rule.
  const together = apply(fableWindow(40, flat(40)), poolWindow(80, flat(80)));
  assert.deepEqual(together.sharedPool, { status: 'unavailable', reason: 'share-inconsistent' });
  // An idle session's status line redrew the older Claude figure alongside the
  // Fable read: it is as old as its fetch, so the figures are not simultaneous.
  const redrawn = apply(fableWindow(40, flat(40)), poolWindow(80, flat(80),
    { provenance: 'official-statusline', evidenceAt: iso(T0 - 5 * HOUR) }));
  assert.equal(redrawn.sharedPool.status, 'applied');
  assert.equal(redrawn.sharedPool.pool.observedAt, iso(T0 - 5 * HOUR), 'the card quotes the Claude figure by its fetch');
  assert.equal(redrawn.sharedPool.estimated, true);
});

test('the projection starts from the rounded usable figure the card shows', () => {
  const fable = fableWindow(100, forecastOf(hourly(10, () => 100)));
  const pool = poolWindow(30.6, forecastOf(hourly(10, (hour) => 30.6 - hour)));
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.poolAsFable, 62);
  assert.equal(result.sharedPool.usableRemaining, 62);
  near(result.forecast.series.expected[0].remaining, 62, 1e-9, 'the path starts at the card figure');
  near(result.sharedPool.ceiling.expected[0].remaining, 62, 1e-9, 'and so does the cap line');
  near(result.sharedPool.ceiling.observed.at(-1).remaining, 61.2, 1e-9, 'readings are drawn as read');
});

test('when the week refills before the Fable reset the figure at that reset is Fable\'s own', () => {
  const fable = fableWindow(90, forecastOf(hourly(10, (hour) => 90 - 2 * hour)), { resetsAt: iso(T0 + 10 * HOUR) });
  const pool = poolWindow(20, forecastOf(hourly(4, (hour) => 20 - 3 * hour)), { resetsAt: iso(T0 + 4 * HOUR) });
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.bindingAtReset, 'pool', 'the week caps Fable on the way');
  assert.equal(result.sharedPool.cappedAtReset, 'cap', 'but not at the Fable reset');
});

test('a Claude weekly reading that needs a Refresh keeps a capped Fable out of on track', async () => {
  const { stalePoolWindow } = await import('../electron/dashboard-decision.mjs');
  const flat = (value, extra = {}) => forecastOf(hourly(10, () => value), undefined, extra);
  const fable = apply(fableWindow(100, flat(100)), poolWindow(30, flat(30)));
  const staleClaude = poolWindow(30, flat(30, { staleHours: 30 }));
  assert.ok(stalePoolWindow(fable, quotaOf(staleClaude)));
  assert.equal(stalePoolWindow(fable, quotaOf(poolWindow(30, flat(30)))), null);
  const verdict = buildDashboardVerdict({ settings: { showCodexSubscription: false },
    quotas: { codex: null, claude: quotaOf(staleClaude), fable } });
  assert.equal(verdict.state, 'unknown');
  assert.match(verdict.label, /needs current data: Claude, Fable$/);
});

test('releasing a cap that had taken the tokens to zero restores the original estimate', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { snapshotAtTime } = await server.ssrLoadModule('/src/snapshot-time.ts');
    const budget = await server.ssrLoadModule('/src/budget.ts');
    const capacity = {
      status: 'available', weeklyTokens: 1_000_000, weeklyRange: { low: 800_000, high: 1_200_000 },
      remainingTokens: 500_000, remainingRange: { low: 400_000, high: 600_000 },
      remainingAsOf: iso(T0 - HOUR), warnings: [], modelMix: [], tokenMix: {},
    };
    const poolReset = T0 + 6 * HOUR;
    const capped = apply(fableWindow(50, forecastOf(hourly(10, () => 50)), { tokenCapacity: capacity }),
      poolWindow(0, forecastOf(hourly(6, () => 0)), { resetsAt: iso(poolReset) }));
    assert.equal(capped.tokenCapacity.remainingTokens, 0);
    // A saved reserve of the week is twice as much of Fable while the week sets its budget.
    assert.equal(budget.forecastReserve(capped, 10), 20);
    assert.equal(budget.forecastReserve(fableWindow(50, forecastOf(hourly(10, () => 50))), 10), 10);
    const snapshot = { generatedAt: iso(T0), settings: {}, sources: [], quotas: { codex: null, claude: null, fable: capped } };
    const released = snapshotAtTime(snapshot, poolReset + 2 * MINUTE).quotas.fable;
    assert.equal(released.tokenCapacity, capacity);
  } finally { await server.close(); }
});

test('a Fable risk episode saved before the rename is not announced again', () => {
  const window = { ...fableWindow(20, forecastOf(hourly(10, () => 20))), forecast: { state: 'risk', expired: false } };
  const current = {
    settings: { notifyDesktop: true, showCodexSubscription: false },
    quotas: { codex: null, claude: null, fable: quotaOf(window) },
    dashboardVerdict: { state: 'risk', reason: 'pace', label: 'Fable is above its safe pace', affected: ['Fable · Fable weekly'], details: [] },
    sources: [],
  };
  const state = { lastRiskSignature: 'risk|pace|Fable 5 · Fable 5 weekly', lastRiskNotifiedAt: T0 - 7 * 24 * HOUR };
  const { notifications } = decideNotifications({ previous: current, current, state, nowMs: T0 });
  assert.equal(notifications.filter((entry) => entry.kind === 'risk').length, 0);
});

// ---------------------------------------------------------------------------
// Second review (Astra).

test('rounding never leaves Fable a balance after the Claude weekly limit has run out', async () => {
  // Claude weekly at 30.6% rounds up to 31%, so the cap now is 62 Fable
  // points; the week then empties before the reset.
  const fable = fableWindow(100, forecastOf(hourly(10, () => 100)));
  const pool = poolWindow(30.6, forecastOf(hourly(10, (hour) => 30.6 - 8 * hour)));
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.usableRemaining, 62, 'the card still shows twice the rounded Claude figure');
  assert.equal(result.forecast.expectedRemaining, 0);
  assert.ok(result.forecast.exhaustsAt, 'Fable runs out with the week');
  near(Date.parse(result.forecast.exhaustsAt), Date.parse(pool.forecast.exhaustsAt), 1000, 'at the same instant as Claude');
  assert.equal(result.forecast.state, 'critical');
  for (const point of result.sharedPool.ceiling.expected.filter((entry) => entry.at > Date.parse(pool.forecast.exhaustsAt))) {
    assert.equal(point.remaining, 0, 'the cap line stays at zero once the week is empty');
  }
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const budget = await server.ssrLoadModule('/src/budget.ts');
    const settings = { activeDays: [0, 1, 2, 3, 4, 5, 6], activeStartHour: 0, activeEndHour: 24, reservePercent: 0 };
    const window = { ...result, resetsAt: iso(T0 + 48 * HOUR), forecast: { ...result.forecast, activeHoursLeft: 48 } };
    const plan = budget.dailyBudget(window, settings, T0);
    if (plan) assert.equal(plan.expectedFits, false, 'a week that runs out does not fit the budget');
  } finally { await server.close(); }
});

test('a Fable path that crosses the Claude cap runs out when the Claude weekly limit does', () => {
  // In the first hour Fable's own path falls 20 -> 19 while the Claude cap
  // falls 25 -> -5 Fable points: the cap takes over part-way through the hour.
  const fable = fableWindow(20, forecastOf(hourly(2, (hour) => 20 - hour)));
  const poolForecast = forecastOf(hourly(2, (hour) => 12 - 15 * hour));
  const pool = poolWindow(12, poolForecast);
  const result = apply(fable, pool);
  assert.equal(result.sharedPool.cap.exhaustsAt, null, 'Fable\'s own limit never runs out');
  const claudeOut = Date.parse(poolForecast.exhaustsAt);
  near(claudeOut, T0 + 0.8 * HOUR, 1000, 'Claude weekly runs out at 12:48');
  near(Date.parse(result.forecast.exhaustsAt), claudeOut, 1000, 'and Fable with it, not before');
  // The instant the cap takes over is a point of the combined path.
  const crossing = T0 + HOUR * (24 - 20) / (30 - 1);
  assert.ok(result.forecast.series.expected.some((point) => Math.abs(point.at - crossing) < 1000));
});

test('a capped Fable follows a stale Claude reading even when only its heavier week is capped', async (t) => {
  const { stalePoolWindow } = await import('../electron/dashboard-decision.mjs');
  const fable = apply(fableWindow(90, forecastOf(hourly(10, (hour) => 90 - 3 * hour), hourly(10, (hour) => 90 - 5 * hour))),
    poolWindow(80, forecastOf(hourly(10, (hour) => 80 - 3 * hour), hourly(10, (hour) => 80 - 9 * hour))));
  assert.equal(fable.sharedPool.bindingAtReset, 'cap');
  assert.equal(fable.sharedPool.heavyBindsAtReset, true);
  const stale = poolWindow(80, forecastOf(hourly(10, (hour) => 80 - 3 * hour), hourly(10, (hour) => 80 - 9 * hour),
    { staleHours: 25 }));
  assert.ok(stalePoolWindow(fable, quotaOf(stale)), 'the heavier-week dependency counts');
  // The card follows the same rule.
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  t.after(() => server.close());
  const { providerViews } = await server.ssrLoadModule('/src/provider-view.ts');
  const snapshot = {
    generatedAt: iso(T0), settings: { showCodexSubscription: false }, sources: [],
    quotas: { codex: null, claude: quotaOf(stale), fable },
  };
  const view = providerViews(snapshot).find((entry) => entry.id === 'fable');
  assert.equal(view.stale, true);
  assert.ok(view.notes.some((note) => /follows the Claude weekly reading/.test(note)));
});

test('the shared limit never postpones Fable\'s own run-out', () => {
  // Astra's case: Fable's own projection passes zero at 13:30, inside the
  // hour a crossing of the Claude cap and the coupling bound is inserted.
  const own = [
    { at: T0, remaining: 30, projected: 30 },
    { at: T0 + HOUR, remaining: 20, projected: 20 },
    { at: T0 + 2 * HOUR, remaining: 0, projected: -20 },
  ];
  const claude = [
    { at: T0, remaining: 20, projected: 20 },
    { at: T0 + HOUR, remaining: 12.5, projected: 12.5 },
    { at: T0 + 2 * HOUR, remaining: 0, projected: 0 },
  ];
  const fable = fableWindow(30, forecastOf(own), { resetsAt: iso(T0 + 2 * HOUR) });
  const pool = poolWindow(20, forecastOf(claude), { resetsAt: iso(T0 + 2 * HOUR) });
  const result = apply(fable, pool);
  near(Date.parse(result.sharedPool.cap.exhaustsAt), T0 + 1.5 * HOUR, 1000, 'Fable\'s own run-out is 13:30');
  near(Date.parse(result.forecast.exhaustsAt), T0 + 1.5 * HOUR, 1000, 'and the combined run-out is no later');
  for (const point of result.forecast.series.expected) {
    assert.equal(point.remaining, Math.max(0, Math.min(100, point.projected)), 'every point is its own projection, clipped');
  }
});

test('across many paths the combined run-out is never later than either limit\'s own', () => {
  // A path's unclipped projection at any instant, between its hourly points.
  const lineOf = (series) => (at) => {
    const index = series.findIndex((point) => point.at >= at);
    if (index <= 0) return series[Math.max(0, index)].projected;
    const [a, b] = [series[index - 1], series[index]];
    return a.projected + (b.projected - a.projected) * ((at - a.at) / (b.at - a.at));
  };
  const runOut = (series) => {
    const at = exhaustionTime(series);
    return at ? Date.parse(at) : Number.POSITIVE_INFINITY;
  };
  let checked = 0;
  for (const ownStart of [15, 40, 90]) {
    for (const ownSlope of [0, 4, 9, 22]) {
      for (const poolStart of [8, 25, 45]) {
        for (const poolSlope of [0, 1.5, 3, 7]) {
          for (const bend of [0, 0.5, 2, 'knee']) {
            // Paces change over the day, so the lines bend and cross inside
            // hours; a knee is a pace that jumps after the first hour.
            const shape = (start, slope, curve, jump) => hourly(10, (hour) => (bend === 'knee'
              ? start - slope * Math.min(hour, 1) - slope * jump * Math.max(0, hour - 1)
              : start - slope * hour - curve * hour * hour));
            const ownPath = shape(ownStart, ownSlope, bend, 4);
            const poolPath = shape(poolStart, poolSlope, bend * 0.3, 1.7);
            const result = apply(fableWindow(Math.min(100, ownStart), forecastOf(ownPath)),
              poolWindow(poolStart, forecastOf(poolPath)));
            if (result.sharedPool.status !== 'applied') continue;
            const combined = runOut(result.forecast.series.expected);
            assert.ok(combined <= runOut(ownPath) + 1000,
              `own ${ownStart}-${ownSlope}h pool ${poolStart}-${poolSlope}h bend ${bend}: Fable's own run-out is not postponed`);
            assert.ok(combined <= runOut(poolPath) + 1000,
              `own ${ownStart}-${ownSlope}h pool ${poolStart}-${poolSlope}h bend ${bend}: nor the Claude weekly run-out`);
            // At every instant, inserted crossings included, the combined path
            // is at or below each limit's own unclipped line.
            const ownLine = lineOf(ownPath);
            const poolLine = lineOf(poolPath);
            for (const point of result.forecast.series.expected) {
              const bound = Math.min(ownLine(point.at), poolLine(point.at) / 0.5);
              assert.ok(point.remaining <= Math.max(0, Math.min(100, bound)) + 1e-6,
                `own ${ownStart}-${ownSlope}h pool ${poolStart}-${poolSlope}h bend ${bend}: above a limit at ${iso(point.at)}`);
            }
            checked += 1;
          }
        }
      }
    }
  }
  assert.ok(checked > 100, `checked ${checked} paths`);
});
