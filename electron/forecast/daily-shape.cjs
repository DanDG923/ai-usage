'use strict';

// Stage eight: how the learned use spreads over local days. Daily totals are
// what a busy day is measured by, and the off-schedule hours a day offered are
// what an isolated late-night step is spread across.

const { restatesSessionLimits } = require('../quota-evidence.cjs');
const { FORECAST_LOOKBACK_MS } = require('../quota-time.cjs');
const { HOUR_MS, isActiveHour, localDayKey, nextLocalHour, offScheduleHoursForLocalDay } = require('./calendar.cjs');
const { COVERAGE_GAP_MS } = require('./tuning.cjs');

/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('../types').Schedule} Schedule */
/** @typedef {import('./calendar.cjs').Excluded} Excluded */
/** @typedef {import('./samples.cjs').LearningSample} LearningSample */

/**
 * Learned use by local day.
 * @typedef {object} DailyShape
 * @property {Map<string, number>} activeDayUsage Points used in scheduled hours, by day.
 * @property {Map<string, number>} offDayUsage Points used off schedule, by day.
 * @property {number} offDailyPace Points per off-schedule hour, across every off-schedule hour the learned days offered.
 * @property {number[]} offDailyRates Each day's off-schedule points per off-schedule hour.
 */

// A change sample allocates only its last poll interval, so a day polled
// throughout with no use would never be learned. Consecutive readings no
// more than COVERAGE_GAP_MS apart show where such a quiet day was observed,
// and it supplies only the off-schedule hours they cover: a brief pair of
// polls is not a fully observed day. The latest observed day is still
// partial and counts only once a sample learns it. Only an interval ending
// in a fresh read shows nothing was used across it: a status-line repeat
// restates what a session fetched earlier while other sessions, the desktop
// app or the web may have been spending.
/**
 * @param {Reading[]} readings Valid readings in time order.
 * @param {Reading} current The latest reading.
 * @param {Set<string>} sampleDays The days a sample already describes.
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {Excluded} excluded
 * @returns {Map<string, number>} The quiet off-schedule hours observed, by day.
 */
function quietOffScheduleHours(readings, current, sampleDays, schedule, nowMs, excluded) {
  const partialDay = localDayKey(new Date(current.observedAt));
  /** @type {Map<string, number>} */
  const quietOffHours = new Map();
  const covered = readings.filter((row) => row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && !excluded(row.observedAt, row.observedAt + 1));
  for (let index = 1; index < covered.length; index += 1) {
    if (restatesSessionLimits(covered[index])) continue;
    const before = covered[index - 1].observedAt;
    const after = covered[index].observedAt;
    if (after - before > COVERAGE_GAP_MS) continue;
    let cursor = before;
    while (cursor < after) {
      const next = Math.min(after, nextLocalHour(cursor));
      const midpoint = new Date((cursor + next) / 2);
      const day = localDayKey(midpoint);
      if (day !== partialDay && !sampleDays.has(day) && !isActiveHour(midpoint, schedule)) {
        quietOffHours.set(day, (quietOffHours.get(day) || 0) + (next - cursor) / HOUR_MS);
      }
      cursor = next;
    }
  }
  return quietOffHours;
}

/**
 * @param {object} input
 * @param {LearningSample[]} input.samples Every sample, weighted by day.
 * @param {Reading[]} input.readings Valid readings in time order.
 * @param {Reading} input.current The latest reading.
 * @param {Schedule} input.schedule
 * @param {number} input.nowMs
 * @param {Excluded} input.excluded
 * @param {Map<string, number> | null} input.dayWeights
 * @returns {DailyShape}
 */
function dailyShape({ samples, readings, current, schedule, nowMs, excluded, dayWeights }) {
  // Heavy scenario: the busy end of learned *daily* usage, never of momentary
  // burst rates — a keyboard burst is not a pace anyone sustains for a week.
  /** @type {Map<string, number>} */
  const activeDayUsage = new Map();
  /** @type {Map<string, number>} */
  const offDayUsage = new Map();
  for (const sample of samples) {
    const target = sample.phase === 'active' ? activeDayUsage : offDayUsage;
    for (const entry of sample.dailyDeltas || []) target.set(entry.day, (target.get(entry.day) || 0) + entry.delta);
  }
  const offDailyTotals = [...offDayUsage.values()];
  const sampleDays = new Set(samples.flatMap((sample) => (sample.dailyDeltas || []).map((entry) => entry.day)));
  const quietOffHours = quietOffScheduleHours(readings, current, sampleDays, schedule, nowMs, excluded);
  // Off-schedule samples describe the pace of a discrete event, not the
  // probability that the user will be active throughout every future night.
  // Project a duty-cycled rate instead: the stronger of this window's usage
  // across all elapsed off-hours and the average off-schedule daily budget.
  // Each learned local day supplies its real off-schedule capacity: an
  // inactive day has all 24 hours, and a DST boundary may have 23 or 25.
  const offCapacityHours = [...sampleDays]
    .reduce((sum, day) => sum + offScheduleHoursForLocalDay(day, schedule) * (dayWeights?.get(day) ?? 1), 0)
    + [...quietOffHours].reduce((sum, [day, hours]) => sum + hours * (dayWeights?.get(day) ?? 1), 0);
  const offDailyPace = offCapacityHours > 0
    ? offDailyTotals.reduce((sum, value) => sum + value, 0) / offCapacityHours
    : 0;
  const offDailyRates = [...offDayUsage]
    .map(([day, value]) => {
      const hours = offScheduleHoursForLocalDay(day, schedule) * (dayWeights?.get(day) ?? 1);
      return hours > 0 ? value / hours : null;
    })
    .filter(Number.isFinite);
  return {
    activeDayUsage, offDayUsage, offDailyPace,
    // The filter above left only the finite rates.
    offDailyRates: /** @type {number[]} */ (offDailyRates),
  };
}

module.exports = { dailyShape };
