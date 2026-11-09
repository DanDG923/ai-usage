'use strict';

// Stage six: what each interval between two readings teaches about pace, for
// the scheduled and the off-schedule part of the day separately.

const { fetchMomentOf, normaliseObservation, restatesSessionLimits, riseMomentOf } = require('../quota-evidence.cjs');
const { DAY_MS, HOUR_MS, exclusionLookup, isActiveHour, localDayKey, nextLocalHour } = require('./calendar.cjs');
const { learnableInOrder } = require('./readings.cjs');
const {
  ESTIMATED_READING_WEIGHT, MAX_LEARNABLE_RISE_POINTS, MIN_QUIET_SPAN_MS, MIN_SAMPLE_HOURS, SAMPLE_AGE_DECAY_DAYS,
} = require('./tuning.cjs');
const { sameWindowDrift } = require('./windows.cjs');

/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('../types').ReadingLike} ReadingLike */
/** @typedef {import('../types').Schedule} Schedule */
/** @typedef {import('./calendar.cjs').Excluded} Excluded */
/** @typedef {import('./calendar.cjs').Phase} Phase */

/**
 * What one interval between two readings teaches, for one phase of the day.
 * @typedef {object} LearningSample
 * @property {number} rate Allowance points per hour across the span the rise is smoothed over.
 * @property {number} observedAt When the interval ended.
 * @property {number} weekday The local weekday of the middle of the time covered.
 * @property {number} hour The local hour of the middle of the time covered.
 * @property {number} weight Less for older and for estimated readings.
 * @property {boolean} changed Whether usage rose across the interval.
 * @property {boolean} rateEligible False when the span is too short to give a rate.
 * @property {Phase} phase
 * @property {number} delta The points used in this phase.
 * @property {number} coveredHours
 * @property {{ day: string, delta: number }[]} dailyDeltas The points used, by local day.
 * @property {{ day: string, hours: number }[]} dailyHours The hours covered, by local day.
 * @property {number} [influence] The share of its weight a sample keeps once an early reset has discounted its days.
 */

// On the casts to number in this file: a time, window length or rate that may
// be null or absent is cast beside the test that rules that out at run time,
// which the checker cannot follow. Any other cast carries its own comment.

// The rise between two readings, as one sample for each phase of the day the
// interval covers. The rise is spread evenly over the interval; the rate is
// taken over `rateElapsedHours` where the rise closes a longer quiet span.
/**
 * @param {LearningSample[]} samples Added to.
 * @param {Reading} before
 * @param {Reading} after
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {number | null} [rateElapsedHours]
 */
function addIntervalSamples(samples, before, after, schedule, nowMs, rateElapsedHours = null) {
  const elapsedHours = (after.observedAt - before.observedAt) / HOUR_MS;
  if (!(elapsedHours > 0)) return;
  const delta = after.usedPercent - before.usedPercent;
  if (delta < 0 || delta > MAX_LEARNABLE_RISE_POINTS) return;
  const ageDays = Math.max(0, (nowMs - after.observedAt) / DAY_MS);
  const provenanceWeight = ['official', 'official-statusline'].includes(after.provenance) ? 1 : ESTIMATED_READING_WEIGHT;
  const smoothingHours = rateElapsedHours != null && rateElapsedHours > 0 ? rateElapsedHours : elapsedHours;
  const rate = delta / smoothingHours;
  const allocationRate = delta / elapsedHours;
  const coverageScale = rateElapsedHours != null && rateElapsedHours > 0 ? rateElapsedHours / elapsedHours : 1;
  /** @type {Map<Phase, { coveredHours: number, delta: number, midpointHours: number, dailyDeltas: Map<string, number>, dailyHours: Map<string, number> }>} */
  const phases = new Map();
  let cursor = before.observedAt;
  while (cursor < after.observedAt) {
    const next = Math.min(after.observedAt, nextLocalHour(cursor));
    const midpointMs = (cursor + next) / 2;
    const midpoint = new Date(midpointMs);
    const phase = isActiveHour(midpoint, schedule) ? 'active' : 'off-schedule';
    const hours = (next - cursor) / HOUR_MS;
    const group = phases.get(phase) || { coveredHours: 0, delta: 0, midpointHours: 0, dailyDeltas: new Map(), dailyHours: new Map() };
    group.coveredHours += hours * coverageScale;
    group.delta += allocationRate * hours;
    group.midpointHours += midpointMs * hours * coverageScale;
    const day = localDayKey(midpoint);
    group.dailyDeltas.set(day, (group.dailyDeltas.get(day) || 0) + allocationRate * hours);
    group.dailyHours.set(day, (group.dailyHours.get(day) || 0) + hours);
    phases.set(phase, group);
    cursor = next;
  }
  for (const [phase, group] of phases) {
    if (group.coveredHours <= MIN_SAMPLE_HOURS && group.delta <= 0) continue;
    const midpoint = new Date(group.midpointHours / group.coveredHours);
    samples.push({
      rate,
      observedAt: after.observedAt,
      weekday: midpoint.getDay(),
      hour: midpoint.getHours(),
      weight: Math.exp(-ageDays / SAMPLE_AGE_DECAY_DAYS) * provenanceWeight,
      changed: delta > 0,
      rateEligible: delta <= 0 || smoothingHours >= MIN_SAMPLE_HOURS,
      phase,
      delta: group.delta,
      coveredHours: group.coveredHours,
      dailyDeltas: [...group.dailyDeltas].map(([day, dayDelta]) => ({ day, delta: dayDelta })),
      dailyHours: [...group.dailyHours].map(([day, hours]) => ({ day, hours })),
    });
  }
}

// Walk the readings in time order and learn one interval for each rise, and
// one for each quiet span of an hour or more, within a single allowance window.
/**
 * @param {ReadingLike[]} observations
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {string[] | Excluded} [excludedDates] The ignored days, or a lookup already built from them.
 * @returns {LearningSample[]}
 */
function deriveLearningSamples(observations, schedule, nowMs, excludedDates = []) {
  const excluded = typeof excludedDates === 'function' ? excludedDates : exclusionLookup(excludedDates);
  const rows = learnableInOrder(observations.map(normaliseObservation), nowMs);
  /** @type {LearningSample[]} */
  const samples = [];
  if (rows.length < 2) return samples;

  // A figure an interval starts from counts from when it was fetched, as a
  // rise does: placed at a later redraw, it would squeeze the use that follows
  // into too few hours. Never before the interval already learned, nor back
  // across an ignored day.
  /** @param {Reading} row */
  const fetchedAnchor = (row, notBefore = -Infinity) => {
    const at = fetchMomentOf(row);
    return at < row.observedAt && at > notBefore && !excluded(at, row.observedAt) ? { ...row, observedAt: at } : row;
  };
  // Polling cadence is not evidence. Compact unchanged snapshots into one
  // quiet interval, but retain the latest unchanged reading as the lower bound
  // for the next increase so its active/off-schedule phase stays localised.
  let anchor = fetchedAnchor(rows[0]);
  let latest = anchor;
  let previous = rows[0];
  for (let index = 1; index < rows.length; index += 1) {
    const after = rows[index];
    // A rise counts from when its figure was fetched, not its later redraw,
    // for the ignored-day check as for the sample it closes.
    const riseAt = after.usedPercent > anchor.usedPercent ? riseMomentOf(after, latest.observedAt) : after.observedAt;
    // The smoothing span starts at the last change, not merely the previous
    // poll. Restart both anchors when it crosses an excluded day so neither
    // cumulative usage nor a quiet ignored day changes the learned rate.
    if (excluded(anchor.observedAt, riseAt)) {
      if (latest.observedAt - anchor.observedAt >= MIN_QUIET_SPAN_MS) {
        addIntervalSamples(samples, anchor, latest, schedule, nowMs);
      }
      // A provider correction can dip below usage seen on the ignored day.
      // Keep that high-water mark so a later rebound is not counted again.
      anchor = fetchedAnchor(sameWindowDrift(previous, after) && after.usedPercent < anchor.usedPercent
        ? { ...after, usedPercent: anchor.usedPercent } : after, latest.observedAt);
      latest = anchor;
      previous = after;
      continue;
    }
    // Same chained drift model as clusterByWindow: an idle window rolls its
    // reset forward with elapsed time, so compare against the previous row,
    // never a fixed anchor — a fixed 60s tolerance breaks after one idle
    // minute and relearns the next increase at a wildly inflated rate.
    const sameWindow = sameWindowDrift(previous, after);
    previous = after;
    if (!sameWindow || after.usedPercent - anchor.usedPercent > MAX_LEARNABLE_RISE_POINTS) {
      // The quiet span before a reset is learned like the excluded-day
      // restart and the final tail: dropping it leaves only the bursts.
      if (latest.observedAt - anchor.observedAt >= MIN_QUIET_SPAN_MS) {
        addIntervalSamples(samples, anchor, latest, schedule, nowMs);
      }
      anchor = fetchedAnchor(after, latest.observedAt);
      latest = anchor;
      continue;
    }
    // Provider percentages can jitter backwards within one allowance window.
    // Keep a monotonic high-water mark so a rebound to an already observed
    // percentage is not counted as fresh usage.
    if (after.usedPercent < anchor.usedPercent) continue;
    if (after.usedPercent > anchor.usedPercent) {
      // The change-to-change span already includes the quiet time for rate
      // smoothing. Use the latest unchanged reading only to localise the phase
      // and daily allocation; adding that quiet span separately would weight it twice.
      // The rise is learned up to when its figure was fetched, not redrawn.
      const at = riseAt;
      const rise = at === after.observedAt ? after : { ...after, observedAt: at };
      addIntervalSamples(samples, latest, rise, schedule, nowMs, (at - anchor.observedAt) / HOUR_MS);
      anchor = rise;
      latest = rise;
    } else if (!restatesSessionLimits(after)) {
      latest = after;
    } else if (Number.isFinite(after.fetchedAfter) && /** @type {number} */ (after.fetchedAfter) > latest.observedAt) {
      // A status-line fetch newer than the latest confirmation proves the
      // figure still held then, as a read would; an idle redraw proves nothing.
      latest = { ...after, observedAt: Math.min(/** @type {number} */ (after.fetchedAfter), after.observedAt) };
    }
  }
  // anchor and latest only ever diverge within one chained window, so the
  // quiet tail needs no reset comparison (drift would fail a fixed tolerance).
  if (latest.observedAt > anchor.observedAt && latest.observedAt - anchor.observedAt >= MIN_QUIET_SPAN_MS) {
    addIntervalSamples(samples, anchor, latest, schedule, nowMs);
  }
  return samples;
}

// Give each sample the influence of the days it covers, where an early reset
// has discounted some of them. Its weight and the use it assigns to those
// days fall together.
/**
 * @param {LearningSample[]} samples
 * @param {Map<string, number> | null} dayWeights The share of its usual influence each discounted day keeps.
 * @returns {LearningSample[]}
 */
function weighSamplesByDay(samples, dayWeights) {
  return samples.map((sample) => {
    if (!dayWeights?.size) return sample;
    const hours = sample.dailyHours.reduce((sum, entry) => sum + entry.hours, 0);
    const weightedHours = sample.dailyHours.reduce((sum, entry) => sum + entry.hours * (dayWeights.get(entry.day) ?? 1), 0);
    const influence = hours > 0 ? weightedHours / hours : 1;
    return { ...sample, weight: sample.weight * influence, influence,
      dailyDeltas: sample.dailyDeltas.map((entry) => ({ ...entry, delta: entry.delta * (dayWeights.get(entry.day) ?? 1) })) };
  });
}

module.exports = { addIntervalSamples, deriveLearningSamples, weighSamplesByDay };
