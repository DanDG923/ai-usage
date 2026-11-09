'use strict';

// Fable's limit is a ceiling inside the Claude weekly pool, not a pool of its
// own. Anthropic: Fable models can use "up to 50% of your weekly usage limits"
// and "draw from your plan's regular weekly usage limits", and every other
// model draws from the same limits. So Opus using 70% of the week leaves 30
// points, which is 60% of the Fable limit, however little of that limit Fable
// itself has used:
//
//   usable Fable = min(Fable limit remaining, Claude weekly remaining / share)
//
// This step applies that rule to each live weekly Fable window when the
// snapshot is built, now, through the observed history and along the
// forecast, so the card, runway, planner, verdict, notifications and tray all
// read one figure. The provider's own Fable percentage stays on the window and
// is shown beside it. Nothing here reads plan usage or writes a row.

const { FABLE_ALLOWANCE_SHARE } = require('./fable-projection.cjs');
const { exhaustionTime, forecastState } = require('./forecast.cjs');
const { FABLE } = require('./providers.mjs');
const { isMainWindow, selectDisplayedWindows } = require('./quota-selection.cjs');
const { STALENESS_MS } = require('./token-capacity.cjs');

/** @typedef {import('./types').Quota} Quota */
/** @typedef {import('./types').QuotaWindow} QuotaWindow */
/** @typedef {import('./types').Forecast} Forecast */
/** @typedef {import('./types').ForecastState} ForecastState */
/** @typedef {import('./types').Point} Point */
/** @typedef {import('./types').SharedPoolApplied} SharedPoolApplied */
/** @typedef {import('./types').TokenCapacityEstimate} TokenCapacityEstimate */
/** @typedef {Extract<import('./types').SharedPool, { status: 'unavailable' }>['reason']} UnavailableReason */

const WEEK_MINUTES = 10_080;
// The weekly Fable allowance, as the provider registry lists it. Any other
// Fable bucket is left as it is.
/** @type {Set<string>} */
const FABLE_WEEKLY_BUCKETS = new Set(FABLE.weeklyBuckets);
// The pool expressed in Fable points. Above 100 it cannot bind; the cap keeps
// chart coordinates finite once the pool has room to spare.
const MAX_POOL_AS_FABLE = 200;
const EPSILON = 1e-9;
// Claude reports the same weekly reset a fraction of a second apart across
// readings (07:59:59.5 on one, 08:00:00.4 on the next). Resets this close are
// one reset: the pool must not appear to refill at Fable's own reset instant.
const RESET_TOLERANCE_MS = 60_000;
// Readings further apart than this are not one moment, so a figure combining
// them is an estimate even when each reading is fresh.
const SAME_MOMENT_MS = 15 * 60_000;
// Whole-percent readings on both sides, one of them doubled.
const SHARE_SLACK = 2;

/** @type {Record<ForecastState, number>} */
const SEVERITY = { unknown: 0, safe: 1, watch: 2, risk: 3, critical: 4 };
/**
 * @param {ForecastState} a
 * @param {ForecastState} b
 */
const worse = (a, b) => ((SEVERITY[b] ?? 0) > (SEVERITY[a] ?? 0) ? b : a);
/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 */
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
/**
 * True only for a finite number, which the checker reads as "a number".
 * @param {unknown} value
 * @returns {value is number}
 */
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** @param {Pick<QuotaWindow, 'windowMinutes' | 'bucketId'> | null | undefined} window */
function isFableWeekly(window) {
  return Number(window?.windowMinutes) === WEEK_MINUTES && FABLE_WEEKLY_BUCKETS.has(String(window?.bucketId || ''));
}

// The dashboard's own "left now" rule (src/lib.ts displayedRemaining).
/** @param {QuotaWindow | null | undefined} window */
function displayed(window) {
  /** @type {Partial<Forecast>} */
  const forecast = window?.forecast || {};
  const value = forecast.currentIsEstimated && finite(forecast.estimatedCurrentRemaining)
    ? forecast.estimatedCurrentRemaining
    : window?.remainingPercent;
  return finite(value) ? clamp(value, 0, 100) : null;
}

/** @param {QuotaWindow} window */
function estimated(window) {
  return Boolean(window?.forecast?.currentIsEstimated && finite(window?.forecast?.estimatedCurrentRemaining));
}

// The moment a window's figure held: a status-line redraw can carry limits
// its session fetched long before the redraw.
/** @param {QuotaWindow} window */
function readingMoment(window) {
  return window.evidenceAt ?? window.observedAt;
}

// The Claude weekly window every model draws on: the subscription's own
// seven-day allowance, not the five-hour session or a model-scoped limit.
/**
 * @param {Quota | null | undefined} claudeQuota
 * @param {number} nowMs
 * @returns {{ window: QuotaWindow, reason?: undefined } | { window?: undefined, reason: UnavailableReason }}
 */
function weeklyPool(claudeQuota, nowMs) {
  if (!claudeQuota) return { reason: 'no-weekly-pool' };
  const windows = Array.isArray(claudeQuota.windows) && claudeQuota.windows.length ? claudeQuota.windows : [claudeQuota];
  const weekly = windows.filter((window) => isMainWindow(window) && Number(window.windowMinutes) === WEEK_MINUTES);
  if (!weekly.length) return { reason: 'no-weekly-pool' };
  const live = selectDisplayedWindows(weekly, { nowMs }).active[0];
  if (!live || live.forecast?.expired) return { reason: 'pool-expired' };
  if (displayed(live) == null) return { reason: 'pool-unknown' };
  return { window: live };
}

// Fable can never have used more than twice what the whole week has used.
// Readings of both taken together that break this mean the half share is not
// the rule this account runs on, and the ceiling would be wrong, not safe.
// Weekly use only grows within a window, so a Fable reading is checked only
// against a Claude reading from the same moment or later. A projected Fable
// figure is built on the half share itself and is not evidence against it.
/**
 * @param {QuotaWindow} fable
 * @param {QuotaWindow} pool
 * @param {number} share
 */
function shareConsistent(fable, pool, share) {
  if (fable.provenance === 'derived-tokens') return true;
  const fableAt = Date.parse(readingMoment(fable));
  const poolAt = Date.parse(readingMoment(pool));
  if (!(fableAt <= poolAt + RESET_TOLERANCE_MS && poolAt - fableAt <= SAME_MOMENT_MS)) return true;
  return Number(fable.usedPercent) <= Number(pool.usedPercent) / share + SHARE_SLACK;
}

// A series value at any instant, interpolated between points. `projected`
// keeps how far past zero a point ran, which exhaustionTime needs.
/**
 * @param {Point[] | null | undefined} series
 * @returns {(at: number, key?: 'remaining' | 'projected') => number | null}
 */
function sampler(series) {
  const points = Array.isArray(series) ? series.filter((point) => finite(point?.at) && finite(point?.remaining)) : [];
  return (at, key = 'remaining') => {
    if (!points.length) return null;
    /** @param {Point} point */
    const read = (point) => (key === 'projected' && finite(point.projected) ? point.projected : point.remaining);
    if (at <= points[0].at) return read(points[0]);
    for (let index = 1; index < points.length; index += 1) {
      const next = points[index];
      if (at > next.at) continue;
      const previous = points[index - 1];
      const span = next.at - previous.at;
      const fraction = span > 0 ? (at - previous.at) / span : 1;
      return read(previous) + (read(next) - read(previous)) * fraction;
    }
    // Past the last point; `points` is not empty here.
    return read(/** @type {Point} */ (points.at(-1)));
  };
}

// The pool's remaining, in Fable points, along the Fable horizon. Once the
// pool resets it refills and stops binding. Without a pool projection the
// current figure stands for the rest of the window: the pool can only
// shrink, so that is an optimistic bound, never a wrong one.
//
// Read unclipped: once the week is empty its projection runs below zero, and
// that is what places Fable's run-out. `scale` carries the rounding of the
// figure now (the card shows usable Fable as twice the whole Claude
// percentage), as a scale rather than a shift, so an empty week stays empty
// and Fable runs out at the same instant as Claude.
/**
 * @param {QuotaWindow} pool
 * @param {'expected' | 'heavy'} kind
 * @param {number} share
 * @param {number} nowRemaining
 * @param {number} [scale]
 * @returns {(at: number) => number}
 */
function poolCeiling(pool, kind, share, nowRemaining, scale = 1) {
  const resetMs = Date.parse(pool.resetsAt);
  const series = pool.forecast?.series?.[kind];
  const read = series?.length ? sampler(series) : null;
  return (at) => {
    if (Number.isFinite(resetMs) && at > resetMs + RESET_TOLERANCE_MS) return Number.POSITIVE_INFINITY;
    const value = read ? read(at, 'projected') : nowRemaining;
    return value == null ? Number.POSITIVE_INFINITY : (value / share) * scale;
  };
}

// Pointwise min of Fable's own path and the pool's. The two forecasts are
// learned separately, but every Fable point spends a pool point times the
// share, so the pool falls at least as fast as Fable's own projected use: in
// Fable points, ceiling(t) <= ceiling(0) - (F(0) - F(t)).
//
// Between two instants of either path each of these is a straight line, so
// the lowest changes only where two of them cross. Those crossings are
// instants of the combined path too: without them a run-out would be
// interpolated between points belonging to different limits.
/**
 * @param {Point[]} fableSeries Fable's own path; at least one point.
 * @param {(at: number) => number} ceiling
 * @param {number[]} extraTimes
 */
function combineSeries(fableSeries, ceiling, extraTimes) {
  const fable = sampler(fableSeries);
  const first = fableSeries[0].at;
  // The series is not empty, so it has a last point, and a value at any instant.
  const last = /** @type {Point} */ (fableSeries.at(-1)).at;
  const base = [...new Set([...fableSeries.map((point) => point.at), ...extraTimes.filter((at) => at > first && at < last)])]
    .sort((a, b) => a - b);
  /** @param {number} at */
  const ownAt = (at) => /** @type {number} */ (fable(at, 'projected'));
  const start = { own: ownAt(first), ceiling: ceiling(first) };
  /** @param {number} at */
  const coupledAt = (at) => (Number.isFinite(start.ceiling) ? start.ceiling - (start.own - ownAt(at)) : Number.POSITIVE_INFINITY);
  /** @param {number} at */
  const limitAt = (at) => {
    const value = ceiling(at);
    return Number.isFinite(value) ? Math.min(value, coupledAt(at)) : value;
  };
  const lines = [ownAt, ceiling, coupledAt];
  /** @type {number[]} */
  const times = [];
  base.forEach((at, index) => {
    times.push(at);
    const next = base[index + 1];
    if (next === undefined) return;
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const before = lines[i](at) - lines[j](at);
        const after = lines[i](next) - lines[j](next);
        if (Number.isFinite(before) && Number.isFinite(after) && before * after < 0) {
          times.push(at + (next - at) * (before / (before - after)));
        }
      }
    }
  });
  times.sort((a, b) => a - b);
  let poolBinds = false;
  // Every value comes from the unclipped lines and is clipped only at the
  // end. Interpolating Fable's clipped series instead would overstate an
  // instant inside the hour its own projection passes zero, and so postpone
  // its run-out: the combined path is never above either limit's own.
  const series = times.map((at) => {
    const own = ownAt(at);
    const limit = limitAt(at);
    const projected = Math.min(own, limit);
    // The week caps Fable only while Fable's own limit still has room.
    if (own > EPSILON && limit < own - EPSILON) poolBinds = true;
    return { at, remaining: clamp(projected, 0, 100), projected };
  });
  return { series, poolBinds };
}

// The observed history as usable Fable: at each reading of either side, the
// lower of Fable's latest reading and the pool's latest, in Fable points.
// Before the pool's first reading in view only Fable's own is known.
/**
 * @param {Point[] | undefined} fableObserved
 * @param {Point[] | undefined} poolObserved
 * @param {number} share
 * @returns {Point[]}
 */
function combineObserved(fableObserved, poolObserved, share) {
  const own = (Array.isArray(fableObserved) ? fableObserved : []).filter((point) => finite(point?.at) && finite(point?.remaining));
  const pool = (Array.isArray(poolObserved) ? poolObserved : []).filter((point) => finite(point?.at) && finite(point?.remaining));
  if (!own.length || !pool.length) return own;
  /**
   * @param {Point[]} points
   * @param {number} at
   */
  const latest = (points, at) => {
    /** @type {Point | null} */
    let found = null;
    for (const point of points) {
      if (point.at > at) break;
      found = point;
    }
    return found;
  };
  const first = own[0].at;
  const times = [...new Set([...own.map((point) => point.at), ...pool.map((point) => point.at).filter((at) => at >= first)])]
    .sort((a, b) => a - b);
  return times.map((at) => {
    const mine = latest(own, at) ?? own[0];
    const theirs = latest(pool, at);
    const ceiling = theirs ? theirs.remaining / share : Number.POSITIVE_INFINITY;
    return { at, remaining: clamp(Math.min(mine.remaining, ceiling), 0, 100) };
  });
}

const TOKEN_WARNING = 'The Claude weekly reading leaves less than the Fable limit, so the remaining tokens are its share of the estimated week, as of that reading.';

// Token capacity is estimated as of the last Fable reading. When the Claude
// weekly reading leaves less, the remaining tokens become that reading's share
// of the estimated week, dated to it. A copy: the store caches the original.
/**
 * @param {TokenCapacityEstimate | null | undefined} capacity
 * @param {number} poolAtReading
 * @param {string} poolObservedAt
 * @param {number} nowMs
 * @returns {TokenCapacityEstimate | null | undefined}
 */
function cappedCapacity(capacity, poolAtReading, poolObservedAt, nowMs) {
  // An unavailable remainder is intentional: a fresh overall reading cannot
  // establish how much remains of Fable's own stale or uncalibrated limit.
  if (!capacity || capacity.status !== 'available' || !finite(capacity.weeklyTokens)
    || !finite(capacity.remainingTokens)) return capacity;
  const poolTime = Date.parse(poolObservedAt);
  if (!Number.isFinite(poolTime) || nowMs - poolTime > STALENESS_MS) {
    return { ...capacity, remainingTokens: null, remainingRange: null, remainingAsOf: null,
      warnings: [...(capacity.warnings || []), 'The limiting Claude weekly reading needs refreshing before remaining tokens can be estimated.'] };
  }
  const share = clamp(poolAtReading, 0, 100) / 100;
  const remainingTokens = capacity.weeklyTokens * share;
  if (!(remainingTokens < capacity.remainingTokens)) return capacity;
  return {
    ...capacity,
    remainingTokens,
    remainingRange: capacity.weeklyRange
      ? { low: capacity.weeklyRange.low * share, high: capacity.weeklyRange.high * share }
      : capacity.remainingRange,
    remainingAsOf: poolObservedAt,
    warnings: [...(capacity.warnings || []), TOKEN_WARNING],
  };
}

/**
 * @param {QuotaWindow} window
 * @param {QuotaWindow} pool
 * @param {{ nowMs: number, share: number, paceRiskThreshold: number, hardLimitThreshold: number }} options
 * @returns {QuotaWindow}
 */
function constrain(window, pool, options) {
  const { nowMs, share, paceRiskThreshold, hardLimitThreshold } = options;
  // applySharedPool has checked that both readings carry a figure.
  const capRemaining = /** @type {number} */ (displayed(window));
  const poolRemaining = /** @type {number} */ (displayed(pool));
  // Shown as whole percentages, the two figures must add up: Claude weekly
  // at 30% is 60% of Fable, not the 61% an unrounded 30.4% would give.
  const poolAsFable = clamp(Math.round(poolRemaining) / share, 0, MAX_POOL_AS_FABLE);
  const scale = poolRemaining > 0 ? poolAsFable / (poolRemaining / share) : 1;
  const usableRemaining = clamp(Math.min(capRemaining, poolAsFable), 0, 100);
  const binding = poolAsFable < capRemaining - EPSILON ? 'pool' : 'cap';
  const own = window.forecast;
  // Every window the store builds carries a forecast; the empty object only
  // keeps a malformed one from throwing, and reads as not known below.
  const poolForecast = /** @type {Forecast} */ (pool.forecast || {});
  const poolKnown = poolForecast.state !== 'unknown' && finite(poolForecast.expectedRemaining);
  /** @param {Point[] | undefined} series */
  const toFable = (series) => (Array.isArray(series) ? series : [])
    .filter((point) => finite(point?.at) && finite(point?.remaining))
    .map((point) => ({ at: point.at, remaining: clamp(point.remaining / share, 0, MAX_POOL_AS_FABLE) }));
  const resetMs = Date.parse(window.resetsAt);
  // Readings are drawn as read; the projection carries the rounding of "now",
  // and stays at zero once the week is empty.
  const ceilingExpected = (poolForecast.series?.expected || [])
    .filter((point) => finite(point?.at) && finite(point?.remaining) && !(point.at > resetMs + RESET_TOLERANCE_MS))
    .map((point) => ({
      at: point.at,
      remaining: clamp(((finite(point.projected) ? point.projected : point.remaining) / share) * scale, 0, MAX_POOL_AS_FABLE),
    }));
  const apart = Math.abs(Date.parse(readingMoment(window)) - Date.parse(readingMoment(pool)));
  /** @type {SharedPoolApplied} */
  const summary = {
    status: 'applied',
    share,
    capRemaining,
    poolRemaining,
    poolAsFable,
    usableRemaining,
    binding,
    bindingAtReset: /** @type {'pool' | 'cap' | null} */ (null),
    heavyBindsAtReset: false,
    cappedAtReset: /** @type {'pool' | 'cap' | null} */ (null),
    // Either figure estimated, or two readings from different moments, make
    // the combination an estimate whichever side binds.
    estimated: estimated(window) || estimated(pool) || !(apart <= SAME_MOMENT_MS),
    paceSource: 'cap',
    // Fable's own figures, everything the cap may replace, so the renderer
    // can restore them when the Claude window resets before Fable's.
    cap: {
      expectedRemaining: own.expectedRemaining ?? null,
      heavyRemaining: own.heavyRemaining ?? null,
      exhaustsAt: own.exhaustsAt ?? null,
      heavyExhaustsAt: own.heavyExhaustsAt ?? null,
      state: own.state,
      paceRatio: own.paceRatio,
      safePace: own.safePace ?? 0,
      recentPace: own.recentPace ?? 0,
      workingPace: own.workingPace ?? 0,
      windowPace: own.windowPace ?? null,
      reservePercent: own.reservePercent ?? 0,
      confidence: own.confidence ?? 0,
      observed: own.series?.observed ?? [],
      expected: own.series?.expected ?? [],
      heavy: own.series?.heavy ?? [],
      tokenCapacity: null,
    },
    pool: {
      bucketId: pool.bucketId,
      bucketName: pool.bucketName,
      observedAt: readingMoment(pool),
      resetsAt: pool.resetsAt,
      provenance: pool.provenance,
      state: poolForecast.state ?? 'unknown',
      expectedRemaining: poolKnown ? poolForecast.expectedRemaining : null,
      heavyRemaining: poolKnown && finite(poolForecast.heavyRemaining) ? poolForecast.heavyRemaining : null,
      exhaustsAt: poolKnown ? poolForecast.exhaustsAt ?? null : null,
    },
    ceiling: {
      observed: toFable(poolForecast.series?.observed),
      expected: ceilingExpected.length
        ? ceilingExpected
        : [{ at: nowMs, remaining: poolAsFable }, ...(Number.isFinite(resetMs) ? [{ at: resetMs, remaining: poolAsFable }] : [])],
    },
  };
  const tokenCapacity = binding === 'pool'
    ? cappedCapacity(window.tokenCapacity, Math.round(Number(pool.remainingPercent)) / share, readingMoment(pool), nowMs)
    : window.tokenCapacity;
  // cappedCapacity hands back a copy only of a capacity that exists.
  if (tokenCapacity !== window.tokenCapacity) summary.cap.tokenCapacity = /** @type {TokenCapacityEstimate} */ (window.tokenCapacity);
  const observed = combineObserved(own.series?.observed, poolForecast.series?.observed, share);

  // A Fable forecast still learning has no projection to combine; the
  // current figure and the history are capped all the same.
  if (own.expired || own.state === 'unknown' || !finite(own.expectedRemaining) || !own.series?.expected?.length) {
    return {
      ...window,
      tokenCapacity,
      sharedPool: summary,
      forecast: { ...own, series: { ...(own.series || { expected: [], heavy: [] }), observed } },
    };
  }

  const expectedCeiling = poolCeiling(pool, 'expected', share, poolRemaining, scale);
  const heavyCeiling = poolCeiling(pool, poolForecast.series?.heavy?.length ? 'heavy' : 'expected', share,
    poolRemaining, scale);
  /** @param {'expected' | 'heavy'} kind */
  const poolTimes = (kind) => (poolForecast.series?.[kind] || []).map((point) => point.at).filter(finite);
  const expectedPath = combineSeries(own.series.expected, expectedCeiling, poolTimes('expected'));
  const heavyPath = own.series.heavy?.length
    ? combineSeries(own.series.heavy, heavyCeiling, poolTimes('heavy'))
    : null;
  const expected = expectedPath.series;
  const heavy = heavyPath ? heavyPath.series : own.series.heavy;
  // A combined series always holds at least its starting point.
  const lastExpected = /** @type {typeof expected[number]} */ (expected.at(-1));
  const expectedRemaining = lastExpected.remaining;
  // Likewise the heavier combined series.
  const heavyRemaining = heavyPath ? /** @type {Point} */ (heavy.at(-1)).remaining : own.heavyRemaining;
  const exhaustsAt = exhaustionTime(expected);
  const heavyExhaustsAt = heavyPath ? exhaustionTime(heavy) : own.heavyExhaustsAt;

  // Whether the Claude weekly limit caps Fable at any point before the reset
  // on the expected path. The whole path decides, never its last instant.
  const bindingAtReset = binding === 'pool' || expectedPath.poolBinds ? 'pool' : 'cap';
  summary.bindingAtReset = bindingAtReset;
  // The heavier path can be capped when the expected one is not; the verdict
  // then still names the Claude weekly limit as the cause.
  summary.heavyBindsAtReset = Boolean(heavyPath?.poolBinds);
  // Which limit sets the figure at Fable's own reset: the lower of the two.
  // Fable's own expected series has points (checked above), so it has a value here.
  const ownEndRemaining = /** @type {number} */ (sampler(own.series.expected)(lastExpected.at));
  summary.cappedAtReset = expectedRemaining < ownEndRemaining - EPSILON ? 'pool' : 'cap';

  // While the pool is what runs out, the Fable balance shrinks at the pool's
  // pace, in Fable points, unless Fable's own pace is the faster of the two.
  // The reserve is the pool's in Fable points too (10% of the week is 20% of
  // Fable), so safe pace, planner, reserve line and state keep one reserve,
  // and Fable is never reported safer than the pool it cannot outlast.
  const poolPaces = bindingAtReset === 'pool' && poolKnown;
  const poolPaceWins = poolPaces && (poolForecast.paceRatio || 0) > (own.paceRatio || 0);
  summary.paceSource = poolPaceWins ? 'pool' : 'cap';
  /** @param {number} value */
  const inFable = (value) => (finite(value) ? value / share : value);
  const ownReserve = finite(own.reservePercent) ? own.reservePercent : 0;
  const reserve = poolPaces && finite(poolForecast.reservePercent)
    ? clamp(poolForecast.reservePercent / share, 0, 90) : ownReserve;
  const paceRatio = poolPaceWins ? poolForecast.paceRatio : own.paceRatio;
  const watchRemainingThreshold = Math.max(100 - hardLimitThreshold, reserve);
  let state = forecastState(expectedRemaining, heavyRemaining ?? expectedRemaining, paceRatio,
    paceRiskThreshold, watchRemainingThreshold);
  // A pool that resets early can refill before Fable's own reset; running
  // out on the way is still running out.
  if (exhaustsAt) state = worse(state, 'critical');
  if (heavyExhaustsAt) state = worse(state, 'risk');
  if (poolPaces) state = worse(state, poolForecast.state);

  return {
    ...window,
    tokenCapacity,
    sharedPool: summary,
    forecast: {
      ...own,
      state,
      expectedRemaining,
      heavyRemaining,
      exhaustsAt,
      heavyExhaustsAt,
      paceRatio,
      reservePercent: reserve,
      ...(poolPaceWins ? {
        safePace: inFable(poolForecast.safePace),
        recentPace: inFable(poolForecast.recentPace),
        workingPace: inFable(poolForecast.workingPace),
        windowPace: poolForecast.windowPace == null ? null : inFable(poolForecast.windowPace),
      } : {}),
      ...(poolPaces ? { confidence: Math.min(own.confidence ?? 1, poolForecast.confidence ?? 1) } : {}),
      series: { ...own.series, observed, expected, heavy },
    },
  };
}

/**
 * @param {QuotaWindow} window
 * @param {UnavailableReason} reason
 * @returns {QuotaWindow}
 */
function unavailable(window, reason) {
  return { ...window, sharedPool: { status: 'unavailable', reason } };
}

/**
 * Caps each live weekly Fable window by the Claude weekly pool it sits in.
 * Returns a new Fable quota; the inputs are not modified. Expired windows
 * and other buckets are returned unchanged.
 * @param {Quota | null} fableQuota
 * @param {Quota | null | undefined} claudeQuota
 * @param {{ nowMs?: number, settings?: Partial<import('./types').Settings> }} [options]
 * @returns {Quota | null}
 */
function applySharedPool(fableQuota, claudeQuota, options = {}) {
  if (!fableQuota) return fableQuota;
  // Number.isFinite is true only for a number.
  const nowMs = Number.isFinite(options.nowMs) ? /** @type {number} */ (options.nowMs) : Date.now();
  /** @type {Partial<import('./types').Settings>} */
  const settings = options.settings || {};
  const context = {
    nowMs,
    share: FABLE_ALLOWANCE_SHARE,
    paceRiskThreshold: Number(settings.paceRiskThreshold ?? 1.2),
    hardLimitThreshold: Number(settings.hardLimitThreshold ?? 90),
  };
  const pool = weeklyPool(claudeQuota, nowMs);
  /** @param {QuotaWindow} window */
  const apply = (window) => {
    if (!isFableWeekly(window) || window.forecast?.expired || !(Date.parse(window.resetsAt) > nowMs)) return window;
    if (displayed(window) == null) return window;
    if (!pool.window) return unavailable(window, pool.reason);
    if (!shareConsistent(window, pool.window, context.share)) return unavailable(window, 'share-inconsistent');
    return constrain(window, pool.window, context);
  };
  const windows = Array.isArray(fableQuota.windows) ? fableQuota.windows.map(apply) : [];
  /** @type {QuotaWindow & { windows?: QuotaWindow[] }} */
  const top = { ...fableQuota };
  delete top.windows;
  const primary = windows.find((window) => window.bucketId === top.bucketId) || apply(top);
  return { ...primary, windows };
}

module.exports = { TOKEN_WARNING, applySharedPool, isFableWeekly };
