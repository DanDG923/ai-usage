'use strict';

// What a forecast can be told besides the readings, and the same with every
// default filled in.

const { exclusionLookup } = require('./calendar.cjs');
const { clamp } = require('./maths.cjs');
const {
  DEFAULT_ACTIVE_DAYS, DEFAULT_END_HOUR, DEFAULT_FALLBACK_RATE, DEFAULT_HARD_LIMIT_THRESHOLD, DEFAULT_PACE_RISK_THRESHOLD,
  DEFAULT_START_HOUR, MAX_RESERVE_PERCENT,
} = require('./tuning.cjs');

/** @typedef {import('../types').Schedule} Schedule */
/** @typedef {import('../types').AllowanceChange} AllowanceChange */
/** @typedef {import('../quota-evidence.cjs').TimeInput} TimeInput */
/** @typedef {import('./calendar.cjs').Excluded} Excluded */
/** @typedef {import('./learn.cjs').LearnedModel} LearnedModel */

/**
 * How current the latest reading is, measured by forecastQuota before it
 * compacts the readings: `at` is when its figure is evidence of, `known` how
 * current it is known to be.
 * @typedef {{ observedAt: number, at: number | null, known: number | null }} ReadingEvidence
 */

/**
 * What a forecast can be told besides the readings.
 * @typedef {object} ForecastSettings
 * @property {TimeInput | null} [now] The moment to forecast from; the clock when absent.
 * @property {Partial<Schedule> | null} [schedule]
 * @property {number} [fallbackRate]
 * @property {number} [paceRiskThreshold]
 * @property {number} [hardLimitThreshold]
 * @property {number} [reservePercent]
 * @property {string[]} [excludedDates]
 * @property {AllowanceChange[] | null} [allowanceChanges]
 * @property {string} [sourceId] For readings that do not name their own.
 * @property {string} [bucketId] For readings that do not name their own.
 * @property {boolean} [compactReadings] Collapse unchanged runs before learning.
 * @property {number} [freshReadGraceMs]
 * @property {Map<string, { at: number, value: LearnedModel }>} [learningCache]
 */

/**
 * The evidence is read-only: a forecast only reads what its caller measured.
 * @typedef {ForecastSettings & { readonly evidence?: ReadingEvidence }} ForecastOptions
 */

/**
 * A forecast's settings with every default filled in.
 * @typedef {object} ResolvedSettings
 * @property {Schedule} schedule
 * @property {number} fallbackRate Allowance points per scheduled hour, until history supplies a rate.
 * @property {number} paceRiskThreshold The multiple of the safe pace above which a pace is a risk.
 * @property {number} reservePercent The share of the allowance to leave untouched at reset.
 * @property {number} watchRemainingThreshold A projection that leaves less than this at reset is a watch.
 * @property {Excluded} excluded Whether a span of time touches an ignored day.
 */

/**
 * @param {Partial<Schedule> | null} [schedule]
 * @returns {Schedule}
 */
function resolveSchedule(schedule) {
  return {
    activeDays: schedule?.activeDays ?? [...DEFAULT_ACTIVE_DAYS],
    startHour: schedule?.startHour ?? DEFAULT_START_HOUR,
    endHour: schedule?.endHour ?? DEFAULT_END_HOUR,
  };
}

/**
 * @param {ForecastSettings} options
 * @returns {ResolvedSettings}
 */
function resolveSettings(options) {
  const hardLimitThreshold = Number(options.hardLimitThreshold ?? DEFAULT_HARD_LIMIT_THRESHOLD);
  // Budget mode: the share of the allowance the user wants untouched at reset.
  // It is subtracted from what the safe pace may spend, never from the
  // projection itself — the forecast still says what will happen.
  const reservePercent = clamp(Number(options.reservePercent ?? 0) || 0, 0, MAX_RESERVE_PERCENT);
  return {
    schedule: resolveSchedule(options.schedule),
    fallbackRate: Number(options.fallbackRate ?? DEFAULT_FALLBACK_RATE),
    paceRiskThreshold: Number(options.paceRiskThreshold ?? DEFAULT_PACE_RISK_THRESHOLD),
    reservePercent,
    // A reserve the projection will not honour is worth a warning of its own.
    watchRemainingThreshold: Math.max(100 - hardLimitThreshold, reservePercent),
    excluded: exclusionLookup(options.excludedDates),
  };
}

module.exports = { resolveSchedule, resolveSettings };
