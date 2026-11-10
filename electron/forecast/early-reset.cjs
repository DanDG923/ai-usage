'use strict';

// A provider sometimes replenishes an allowance well before its scheduled
// reset. When that follows an unusually heavy day, the day is poor evidence
// of ordinary use: the expected forecast gives it a fraction of its usual
// influence, while the heavier scenario keeps the whole of it.

const { DAY_MS, HOUR_MS, MINUTE_MS, localDayKey } = require('./calendar.cjs');
const { percentile } = require('./maths.cjs');
const { forecastState } = require('./assess.cjs');
const { learnableInOrder } = require('./readings.cjs');
const { addIntervalSamples } = require('./samples.cjs');
const { exhaustionTime } = require('./series.cjs');
const {
  DAY_ATTRIBUTION_MAX_GAP_MS, EARLY_RESET_BASELINE_DAYS, EARLY_RESET_DAY_COVERAGE, EARLY_RESET_DAY_WEIGHT,
  EARLY_RESET_GAP_WINDOW_DIVISOR, EARLY_RESET_HEAVY_EXTRA_POINTS, EARLY_RESET_HEAVY_MULTIPLE,
  EARLY_RESET_LEAD_WINDOW_DIVISOR, EARLY_RESET_MAX_GAP_MS, EARLY_RESET_MAX_LEAD_MS, EARLY_RESET_MAX_USED_PERCENT,
  EARLY_RESET_MIN_BASELINE_DAYS, EARLY_RESET_MIN_DROP_POINTS, EARLY_RESET_MIN_LEAD_MS, EARLY_RESET_TYPICAL_PERCENTILE,
  MAX_LEARNABLE_RISE_POINTS,
} = require('./tuning.cjs');
const { sameWindowDrift } = require('./windows.cjs');

/** @typedef {import('../../src/types').Forecast} Forecast */
/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('./samples.cjs').LearningSample} LearningSample */
/** @typedef {import('./settings.cjs').ResolvedSettings} ResolvedSettings */

/**
 * The days an early reset has discounted.
 * @typedef {object} EarlyResetAdjustment
 * @property {string} resetAt When the latest such reset was seen.
 * @property {string[]} dates The local days given less influence, in order.
 * @property {number} weight The share of its usual influence each keeps.
 */

// On the casts to number in this file: a time, window length or rate that may
// be null or absent is cast beside the test that rules that out at run time,
// which the checker cannot follow. Any other cast carries its own comment.

/**
 * @param {Reading[]} observations Normalised readings.
 * @param {Pick<ResolvedSettings, 'schedule' | 'excluded'>} settings
 * @param {number} nowMs
 * @returns {EarlyResetAdjustment | null}
 */
function earlyResetAdjustment(observations, { schedule, excluded }, nowMs) {
  const rows = learnableInOrder(observations, nowMs);
  if (rows.length < 2) return null;
  // Callers normally supply one bucket. A mixed history cannot establish that
  // an apparent drop represents replenishment of the same allowance.
  const first = rows[0];
  if (!first.sourceId || !first.bucketId || !(/** @type {number} */ (first.windowMinutes) > 0)
    || rows.some((row) => row.sourceId !== first.sourceId || row.bucketId !== first.bucketId || row.windowMinutes !== first.windowMinutes)) return null;
  /** @type {Map<string, number>} The day before each early reset, and when that reset was seen. */
  const candidates = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1], after = rows[index];
    if (!before.resetEvidence || !after.resetEvidence) continue;
    // Every row shares the first row's window length, shown above to be a positive number.
    const windowMs = /** @type {number} */ (before.windowMinutes) * MINUTE_MS;
    const gap = after.observedAt - before.observedAt;
    const earlyMargin = Math.max(EARLY_RESET_MIN_LEAD_MS, Math.min(EARLY_RESET_MAX_LEAD_MS, windowMs / EARLY_RESET_LEAD_WINDOW_DIVISOR));
    if (!(gap > 0) || gap > Math.min(EARLY_RESET_MAX_GAP_MS, windowMs / EARLY_RESET_GAP_WINDOW_DIVISOR)
      || before.resetsAt - after.observedAt < earlyMargin
      || before.usedPercent - after.usedPercent < EARLY_RESET_MIN_DROP_POINTS || after.usedPercent > EARLY_RESET_MAX_USED_PERCENT) continue;
    // The preceding completed calendar day has an independent daily total.
    // Do not discount the partly observed reset day or invent a reason for the
    // replenishment (a reset alone cannot establish the user's motivation).
    const previousDay = new Date(after.observedAt);
    previousDay.setHours(0, 0, 0, 0);
    previousDay.setDate(previousDay.getDate() - 1);
    const day = localDayKey(previousDay);
    const nextDay = new Date(previousDay);
    nextDay.setDate(nextDay.getDate() + 1);
    if (!excluded(previousDay.getTime(), nextDay.getTime())) candidates.set(day, after.observedAt);
  }
  if (!candidates.size) return null;
  const /** @type {Map<string, { used: number, hours: number }>} */ days = new Map(), /** @type {Set<string>} */ uncertainDays = new Set();
  /** @type {LearningSample[]} */
  const boundedSamples = [];
  let peak = rows[0].usedPercent;
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1], after = rows[index];
    if (!sameWindowDrift(before, after)) { peak = after.usedPercent; continue; }
    const delta = Math.max(0, after.usedPercent - peak);
    peak = Math.max(peak, after.usedPercent);
    const gap = after.observedAt - before.observedAt;
    if (!(gap > 0)) continue;
    const firstDay = localDayKey(new Date(before.observedAt));
    const lastDay = localDayKey(new Date(after.observedAt - 1));
    // A long gap crossing midnight cannot prove on which day the usage
    // happened. Within one date, midnight-to-midnight readings can establish
    // a complete day, including its real 23/25-hour DST duration.
    if (!before.resetEvidence || !after.resetEvidence || delta > MAX_LEARNABLE_RISE_POINTS
      || (firstDay !== lastDay && gap > DAY_ATTRIBUTION_MAX_GAP_MS)) {
      const cursor = new Date(before.observedAt);
      cursor.setHours(0, 0, 0, 0);
      while (cursor.getTime() < after.observedAt) {
        uncertainDays.add(localDayKey(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      continue;
    }
    if (excluded(before.observedAt, after.observedAt)) continue;
    // Consecutive unchanged polls prove quiet exposure too; the forecasting
    // samples intentionally compact those polls and are not coverage proof.
    addIntervalSamples(boundedSamples, { ...before, usedPercent: peak - delta },
      { ...after, usedPercent: peak }, schedule, nowMs);
  }
  for (const sample of boundedSamples) {
    for (const entry of sample.dailyDeltas) {
      const day = days.get(entry.day) || { used: 0, hours: 0 };
      day.used += entry.delta;
      days.set(entry.day, day);
    }
    for (const entry of sample.dailyHours) {
      const day = days.get(entry.day) || { used: 0, hours: 0 };
      day.hours += entry.hours;
      days.set(entry.day, day);
    }
  }
  /**
   * @param {string} day
   * @param {{ used: number, hours: number }} value
   */
  const covered = (day, value) => {
    const [year, month, date] = day.split('-').map(Number);
    const dayHours = (new Date(year, month - 1, date + 1).getTime() - new Date(year, month - 1, date).getTime()) / HOUR_MS;
    return !uncertainDays.has(day) && value.hours >= dayHours * EARLY_RESET_DAY_COVERAGE;
  };
  const adjusted = [];
  for (const [day, resetAt] of candidates) {
    const heavy = days.get(day);
    if (!heavy || !covered(day, heavy)) continue;
    const earliest = localDayKey(new Date(resetAt - EARLY_RESET_BASELINE_DAYS * DAY_MS));
    const baseline = [...days].filter(([date, value]) => date < day && date >= earliest
      && !candidates.has(date) && covered(date, value)).map(([, value]) => value.used / value.hours * heavy.hours);
    if (baseline.length < EARLY_RESET_MIN_BASELINE_DAYS) continue;
    const typical = percentile(baseline, EARLY_RESET_TYPICAL_PERCENTILE);
    if (heavy.used >= Math.max(typical * EARLY_RESET_HEAVY_MULTIPLE, typical + EARLY_RESET_HEAVY_EXTRA_POINTS)) adjusted.push({ day, resetAt });
  }
  return adjusted.length ? {
    resetAt: new Date(Math.max(...adjusted.map((entry) => entry.resetAt))).toISOString(),
    dates: adjusted.map((entry) => entry.day).sort(), weight: EARLY_RESET_DAY_WEIGHT,
  } : null;
}

// Normal-day expectations use the reduced influence. The heavier scenario
// keeps the complete observed workload, and can never be more optimistic
// than the adjusted expected curve at the same instant.
/**
 * @param {Forecast} ordinary The forecast with every day at its full influence.
 * @param {Forecast} adjusted The forecast with the heavy days discounted.
 * @param {EarlyResetAdjustment} adjustment
 * @param {Pick<ResolvedSettings, 'paceRiskThreshold' | 'watchRemainingThreshold'>} settings
 * @returns {Forecast}
 */
function withEarlyReset(ordinary, adjusted, adjustment, { paceRiskThreshold, watchRemainingThreshold }) {
  const heavy = ordinary.series.heavy.map((point, index) => {
    const bound = adjusted.series.expected[index];
    return { ...point,
      remaining: Math.min(point.remaining, bound?.remaining ?? point.remaining),
      projected: Math.min(point.projected ?? point.remaining, bound?.projected ?? bound?.remaining ?? point.remaining) };
  });
  const heavyRemaining = heavy.at(-1)?.remaining ?? ordinary.heavyRemaining;
  // The second pass differs from the first only in its day weights, so it has a projection wherever the first did.
  const state = forecastState(/** @type {number} */ (adjusted.expectedRemaining), /** @type {number} */ (heavyRemaining), adjusted.paceRatio, paceRiskThreshold, watchRemainingThreshold);
  return { ...adjusted, state, heavyRemaining, heavyExhaustsAt: exhaustionTime(heavy),
    series: { ...adjusted.series, heavy }, resetAdjustment: adjustment };
}

module.exports = { earlyResetAdjustment, withEarlyReset };
