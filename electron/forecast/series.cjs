'use strict';

// Stage ten: the expected and the heavier path of the allowance, hour by
// hour, from the moment the latest figure is evidence of to the reset.

const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS } = require('../quota-time.cjs');
const { DAY_MS, HOUR_MS, isActiveHour, nextLocalHour } = require('./calendar.cjs');
const { clamp } = require('./maths.cjs');
const { createRateLookup } = require('./rates.cjs');
const { HEAVY_BASELINE_MARGIN } = require('./tuning.cjs');

/** @typedef {import('../types').Schedule} Schedule */
/** @typedef {import('../types').Point} Point */
/** @typedef {import('./samples.cjs').LearningSample} LearningSample */
/** @typedef {import('./rates.cjs').ForecastRates} ForecastRates */
/** @typedef {import('./windows.cjs').WindowView} WindowView */
/** @typedef {import('./learn.cjs').LearnedModel} LearnedModel */

/**
 * A point of a projected path: `projected` keeps how far past zero it ran.
 * @typedef {{ at: number, remaining: number, projected: number }} ProjectedPoint
 */

/**
 * The two paths from now to the reset, and where each starts and ends.
 * @typedef {object} Projection
 * @property {ProjectedPoint[]} expected
 * @property {ProjectedPoint[]} heavy
 * @property {number} estimatedCurrent What is expected to be left now, after use since the latest figure.
 * @property {number} expectedRemaining What is expected to be left at the reset.
 * @property {number} heavyRemaining What a heavier week would leave at the reset.
 */

// On the casts to number in this file: a time, window length or rate that may
// be null or absent is cast beside the test that rules that out at run time,
// which the checker cannot follow. Any other cast carries its own comment.

// The longest span a projection will cover: as far ahead as a reset may lie,
// and the clock skew a reading's time is allowed.
const MAX_PROJECTION_MS = MAX_QUOTA_RESET_AHEAD_MS + QUOTA_CLOCK_SKEW_MS;
// One point for each hour of that span, and one for its start.
const MAX_SERIES_POINTS = Math.ceil(MAX_PROJECTION_MS / HOUR_MS) + 1;

// Cumulative heavier-than-expected burn is a sum of independent busy-or-quiet
// days: its spread grows with the square root of the horizon, not linearly.
// One busy day is repeated in full; beyond that the busiest learned day is
// not assumed for every remaining day, so a fresh week is not projected as
// seven consecutive peak days. Returns the dampened share of one interval's
// full-rate overage, expressed through elapsed days since the projection
// origin. The origin is the latest reading, shared by the catch-up and future
// segments, so a stale reading projects the same reset balance whenever it is
// viewed instead of restarting the full-strength first day at every refresh.
/**
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} originMs
 */
function heavyOverageShare(fromMs, toMs, originMs) {
  /** @param {number} ms */
  const pace = (ms) => {
    const days = (ms - originMs) / DAY_MS;
    return days <= 1 ? days : Math.sqrt(days);
  };
  const span = (toMs - fromMs) / DAY_MS;
  return span > 0 ? clamp((pace(toMs) - pace(fromMs)) / span, 0, 1) : 1;
}

// The share left from `startMs` to `endMs`, a point for each local hour, on
// the expected path and on a heavier one. `originMs` is the moment the heavier
// margin is measured from; null when the span is longer than is supported.
/**
 * @param {number} expectedStart
 * @param {number} heavyStart
 * @param {number} startMs
 * @param {number} endMs
 * @param {Schedule} schedule
 * @param {LearningSample[]} samples
 * @param {ForecastRates} rates
 */
function buildSeries(expectedStart, heavyStart, startMs, endMs, schedule, samples, rates, originMs = startMs) {
  // Reject unsupported work before allocation. Never turn a distant reset into
  // a shorter, apparently valid forecast (including an already empty allowance).
  const points = Math.ceil(Math.max(0, endMs - startMs) / HOUR_MS) + 1;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || endMs - startMs > MAX_PROJECTION_MS || points > MAX_SERIES_POINTS) return null;
  const expected = [{ at: startMs, remaining: clamp(expectedStart, 0, 100), projected: expectedStart }];
  const heavy = [{ at: startMs, remaining: clamp(heavyStart, 0, 100), projected: heavyStart }];
  const learnedRate = createRateLookup(samples);
  const hasOffScheduleSamples = samples.some((sample) => sample.phase === 'off-schedule');
  let expectedRemaining = expectedStart;
  let heavyRemaining = heavyStart;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    const midpoint = new Date((cursor + next) / 2);
    const phase = isActiveHour(midpoint, schedule) ? 'active' : 'off-schedule';
    const phaseRates = phase === 'active' ? rates.active : rates.offSchedule;
    const hasPhaseEvidence = phase === 'active'
      || hasOffScheduleSamples
      || (Number.isFinite(phaseRates.sustainable) && /** @type {number} */ (phaseRates.sustainable) > 0);
    if (hasPhaseEvidence) {
      const duration = (next - cursor) / HOUR_MS;
      const learned = learnedRate(midpoint, phaseRates.fallback, phase);
      const conditional = learned * (1 - phaseRates.blend.weight) + phaseRates.blend.rate * phaseRates.blend.weight;
      // Conditional rates describe pace while in use; the window anchor keeps
      // the projection tied to how much of the allowance is really being spent
      // per scheduled hour, so bursts are not extrapolated across every hour.
      const expectedRate = Number.isFinite(phaseRates.sustainable)
        ? /** @type {number} */ (phaseRates.sustainable)
        : phaseRates.anchor
          ? phaseRates.anchor.rate * phaseRates.anchor.weight + conditional * (1 - phaseRates.anchor.weight)
          : conditional;
      expectedRemaining -= expectedRate * duration;
      // A few busy days are weak evidence for repeating that pace all week.
      // Start with the usual heavier-use margin and gradually trust the
      // learned daily upper pace as independent historical days accumulate.
      const heavyBaseline = expectedRate * HEAVY_BASELINE_MARGIN;
      const heavyRate = heavyBaseline
        + Math.max(0, phaseRates.heavy - heavyBaseline) * phaseRates.heavyWeight;
      heavyRemaining -= expectedRate * duration
        + Math.max(0, heavyRate - expectedRate) * duration * heavyOverageShare(cursor, next, originMs);
    }
    // The displayed value is clamped; the projected value keeps how far past
    // zero the hour ran so the run-out instant can be placed inside the hour.
    expected.push({ at: next, remaining: clamp(expectedRemaining, 0, 100), projected: expectedRemaining });
    heavy.push({ at: next, remaining: clamp(heavyRemaining, 0, 100), projected: heavyRemaining });
    cursor = next;
  }
  return { expected, heavy };
}

// The instant a projected series first touches zero, interpolated inside the
// hour it happens. The displayed series is clamped at zero, which hides how far
// past zero that hour ran; the unclamped `projected` value on the first zero
// sample restores the slope. A series without it snaps to the end of the hour.
/** @param {Point[]} series */
function exhaustionTime(series) {
  for (let index = 1; index < series.length; index += 1) {
    const point = series[index];
    if (point.remaining > 0) continue;
    const previous = series[index - 1];
    if (previous.remaining <= 0) return new Date(previous.at).toISOString();
    const overshoot = Number.isFinite(point.projected) ? Math.min(/** @type {number} */ (point.projected), point.remaining) : point.remaining;
    const fraction = previous.remaining / Math.max(previous.remaining - overshoot, Number.EPSILON);
    return new Date(previous.at + (point.at - previous.at) * clamp(fraction, 0, 1)).toISOString();
  }
  return null;
}

// Catch up from the moment the latest figure is evidence of to now, then
// project from now to the reset. Null when either span is longer than a
// projection supports.
/**
 * @param {WindowView} view
 * @param {Schedule} schedule
 * @param {LearnedModel} model
 * @returns {Projection | null}
 */
function projectToReset({ remaining, evidenceMs, nowMs, resetMs }, schedule, { samples, rates }) {
  const catchUp = buildSeries(remaining, remaining, evidenceMs, nowMs, schedule, samples, rates);
  if (!catchUp) return null;
  const estimatedCurrent = catchUp.expected.at(-1)?.remaining ?? remaining;
  const heavyCurrent = catchUp.heavy.at(-1)?.remaining ?? remaining;
  const future = buildSeries(estimatedCurrent, heavyCurrent, nowMs, resetMs, schedule, samples, rates, evidenceMs);
  if (!future) return null;
  return {
    expected: future.expected,
    heavy: future.heavy,
    estimatedCurrent,
    expectedRemaining: future.expected.at(-1)?.remaining ?? estimatedCurrent,
    heavyRemaining: future.heavy.at(-1)?.remaining ?? heavyCurrent,
  };
}

module.exports = { exhaustionTime, projectToReset };
