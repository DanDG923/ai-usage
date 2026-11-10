'use strict';

// Stage nine: the rates a projection runs on. For the scheduled and the
// off-schedule part of the day separately: the mean learned rate, the recent
// rate, the pace of the allowance window, and the rate of a busy day.

const { localDayKey } = require('./calendar.cjs');
const { clamp, percentile, weightedMean } = require('./maths.cjs');
const {
  HEAVY_DAY_PERCENTILE, HEAVY_FALLBACK_MULTIPLE, HEAVY_HISTORY_DAYS, HEAVY_SUSTAINED_MULTIPLE, MAX_RECENT_WEIGHT,
  MIN_DAYS_FOR_HEAVY_PERCENTILE, MIN_HOUR_SAMPLES, MIN_RECENT_WEIGHT, MIN_SAMPLES_FOR_RECENT_BLEND,
  MIN_WEEKDAY_HOUR_SAMPLES, OFF_WINDOW_FULL_TRUST_HOURS, RATE_NEIGHBOUR_HOURS, RECENT_DECAY_MS,
  RECENT_WEIGHT_SAMPLE_DIVISOR, RECENT_WINDOW_MS,
} = require('./tuning.cjs');

/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('../types').Schedule} Schedule */
/** @typedef {import('./calendar.cjs').Phase} Phase */
/** @typedef {import('./samples.cjs').LearningSample} LearningSample */
/** @typedef {import('./anchors.cjs').WindowAnchors} WindowAnchors */
/** @typedef {import('./daily-shape.cjs').DailyShape} DailyShape */

/**
 * The rates one phase of the day is projected with.
 * @typedef {object} PhaseRates
 * @property {number} fallback The mean learned rate, for hours no closer sample describes.
 * @property {{ rate: number, weight: number }} blend The recent rate and its pull on the learned one.
 * @property {{ rate: number, weight: number } | null} anchor The window's own average pace and its pull.
 * @property {number} [sustainable] A duty-cycled rate that replaces the others. Off-schedule only.
 * @property {number} heavy The rate of a busy day.
 * @property {number} heavyWeight How far the busy-day rate is trusted, from 0 to 1.
 */

/** @typedef {{ active: PhaseRates, offSchedule: PhaseRates }} ForecastRates */

/**
 * The rates, and the figures among them a forecast also reports.
 * @typedef {object} LearnedRates
 * @property {ForecastRates} rates
 * @property {number} sustainableOffSchedulePace Points per off-schedule hour, spread over whole nights.
 * @property {number} recent The recent scheduled-hours rate; zero when nothing recent was learned.
 * @property {number} globalRate The mean scheduled-hours rate.
 */

// A projection asks for the same (phase, weekday, hour) many times across a
// week, and each ask used to filter the whole sample set three times. The
// per-phase partition is built once and every answer is remembered, with the
// candidate order unchanged so the weighted means are bit-for-bit the same.
/**
 * @param {LearningSample[]} samples
 * @returns {(date: Date, fallbackRate: number, phase: Phase) => number}
 */
function createRateLookup(samples) {
  /** @type {Map<Phase, LearningSample[]>} */
  const partitions = new Map();
  /** @type {Map<string, number>} */
  const answers = new Map();
  /** @param {Phase} phase */
  const partition = (phase) => {
    let rows = partitions.get(phase);
    if (!rows) {
      rows = samples.filter((sample) => sample.phase === phase && sample.rateEligible !== false);
      partitions.set(phase, rows);
    }
    return rows;
  };
  return (date, fallbackRate, phase) => {
    const weekday = date.getDay();
    const hour = date.getHours();
    const key = `${phase}|${weekday}|${hour}|${fallbackRate}`;
    // Present: `has` has just said so.
    if (answers.has(key)) return /** @type {number} */ (answers.get(key));
    const phaseSamples = partition(phase);
    const exact = phaseSamples.filter((sample) => sample.weekday === weekday && Math.abs(sample.hour - hour) <= RATE_NEIGHBOUR_HOURS);
    const sameHour = phaseSamples.filter((sample) => Math.abs(sample.hour - hour) <= RATE_NEIGHBOUR_HOURS);
    const candidates = exact.length >= MIN_WEEKDAY_HOUR_SAMPLES ? exact : sameHour.length >= MIN_HOUR_SAMPLES ? sameHour : phaseSamples;
    const rate = contextualRate(candidates, fallbackRate);
    answers.set(key, rate);
    return rate;
  };
}

/**
 * @param {LearningSample[]} samples
 * @param {number} fallbackRate
 */
function contextualRate(samples, fallbackRate, recency = /** @type {(sample: LearningSample) => number} */ (() => 1)) {
  if (!samples.length) return fallbackRate;
  const entries = samples.map((sample) => ({ value: sample.rate,
    weight: sample.weight * sample.coveredHours * recency(sample), influence: sample.influence ?? 1 }));
  const retained = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const original = entries.reduce((sum, entry) => sum + entry.weight / entry.influence, 0);
  const influence = original > 0 ? retained / original : 1;
  // A recent/hour-specific subset may contain only the unusual day. Merely
  // multiplying all its weights by 0.25 would cancel out in its own mean, so
  // reduce that subset's pull towards its rate as well as its sample weight.
  return weightedMean(entries) * influence + fallbackRate * (1 - influence);
}

/**
 * @param {LearningSample[]} samples
 * @param {number} nowMs
 * @param {Phase} phase
 * @param {number} fallbackRate
 */
function recentRate(samples, nowMs, phase, fallbackRate) {
  const recent = samples.filter((sample) => sample.phase === phase && sample.rateEligible !== false && nowMs - sample.observedAt <= RECENT_WINDOW_MS);
  if (!recent.length) return 0;
  return contextualRate(recent, fallbackRate, (sample) => Math.exp(-(nowMs - sample.observedAt) / RECENT_DECAY_MS));
}

// One phase's mean learned rate, its recent rate, and how far the recent
// rate pulls on the learned one.
/**
 * @param {LearningSample[]} samples Every sample.
 * @param {LearningSample[]} modelSamples The samples that give a rate.
 * @param {Phase} phase
 * @param {number} nowMs
 * @param {number} fallbackRate The rate when the phase has no samples.
 */
function phasePace(samples, modelSamples, phase, nowMs, fallbackRate) {
  const phaseSamples = modelSamples.filter((sample) => sample.phase === phase);
  const mean = phaseSamples.length
    ? weightedMean(phaseSamples.map((sample) => ({ value: sample.rate, weight: sample.weight * sample.coveredHours })))
    : fallbackRate;
  const recent = recentRate(samples, nowMs, phase, mean);
  const recentWeight = phaseSamples.length < MIN_SAMPLES_FOR_RECENT_BLEND ? 0
    : clamp(phaseSamples.filter((sample) => nowMs - sample.observedAt <= RECENT_WINDOW_MS).length / RECENT_WEIGHT_SAMPLE_DIVISOR,
      MIN_RECENT_WEIGHT, MAX_RECENT_WEIGHT);
  return { mean, recent, recentWeight };
}

/**
 * @param {object} input
 * @param {LearningSample[]} input.samples Every sample, weighted by day.
 * @param {LearningSample[]} input.modelSamples The samples that give a rate.
 * @param {WindowAnchors} input.anchors
 * @param {DailyShape} input.shape
 * @param {Reading} input.current The latest reading.
 * @param {Schedule} input.schedule
 * @param {number} input.nowMs
 * @param {number} input.fallbackRate
 * @returns {LearnedRates}
 */
function learnRates({ samples, modelSamples, anchors, shape, current, schedule, nowMs, fallbackRate }) {
  const { active: anchor, offSchedule: offAnchor, offWindowPace, offHours: anchorOffHours } = anchors;
  const { activeDayUsage, offDayUsage, offDailyPace, offDailyRates } = shape;
  const { mean: globalRate, recent, recentWeight } = phasePace(samples, modelSamples, 'active', nowMs, fallbackRate);
  const { mean: offScheduleRate, recent: offScheduleRecent, recentWeight: offScheduleRecentWeight }
    = phasePace(samples, modelSamples, 'off-schedule', nowMs, 0);
  const activeDailyTotals = [...activeDayUsage.values()];
  const scheduleHoursPerDay = Math.max(1, schedule.endHour - schedule.startHour);
  // This window's own off-schedule pace is a burst until its elapsed off-hours
  // cover about one full night: a fresh window's first late-evening surge must
  // not be extrapolated across every remaining night. Trust it in proportion
  // to that exposure and never fall below the learned daily off budget.
  const offWindowWeight = offWindowPace == null ? 0 : clamp(anchorOffHours / OFF_WINDOW_FULL_TRUST_HOURS, 0, 1);
  const sustainableOffSchedulePace = offWindowPace == null
    ? offDailyPace
    : Math.max(offDailyPace, offDailyPace + (offWindowPace - offDailyPace) * offWindowWeight);
  const heavyActive = activeDailyTotals.length >= MIN_DAYS_FOR_HEAVY_PERCENTILE
    ? percentile(activeDailyTotals, HEAVY_DAY_PERCENTILE) / scheduleHoursPerDay
    : anchor ? anchor.rate * HEAVY_SUSTAINED_MULTIPLE : fallbackRate * HEAVY_FALLBACK_MULTIPLE;
  const heavyOffSchedule = offDailyRates.length >= MIN_DAYS_FOR_HEAVY_PERCENTILE
    ? percentile(offDailyRates, HEAVY_DAY_PERCENTILE)
    : sustainableOffSchedulePace * HEAVY_SUSTAINED_MULTIPLE;
  // The latest observed day is still partial. Poll count and reset count
  // cannot turn it into multiple independent days of heavy-use evidence.
  const latestObservedDay = localDayKey(new Date(current.observedAt));
  /** @param {Map<string, number>} dailyUsage */
  const heavyWeight = (dailyUsage) => clamp(
    [...dailyUsage.keys()].filter((day) => day < latestObservedDay).length / HEAVY_HISTORY_DAYS,
    0, 1,
  );
  const rates = {
    active: {
      fallback: globalRate, blend: { rate: recent || globalRate, weight: recentWeight }, anchor,
      heavy: heavyActive, heavyWeight: heavyWeight(activeDayUsage),
    },
    offSchedule: {
      fallback: offScheduleRate,
      blend: { rate: offScheduleRecent || offScheduleRate, weight: offScheduleRecentWeight },
      anchor: offAnchor,
      sustainable: sustainableOffSchedulePace,
      heavy: heavyOffSchedule,
      heavyWeight: heavyWeight(offDayUsage),
    },
  };

  return { rates, sustainableOffSchedulePace, recent, globalRate };
}

module.exports = { createRateLookup, learnRates };
