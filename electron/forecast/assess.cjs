'use strict';

// Stage eleven: what the projection means for the person. The pace that would
// keep the reserve, how the present pace compares with it, how far the
// evidence can be trusted, and the state the window is in.

const { HOUR_MS, activeHoursBetween, localDayKey } = require('./calendar.cjs');
const { clamp } = require('./maths.cjs');
const { exhaustionTime } = require('./series.cjs');
const {
  CONFIDENCE_BASE, CONFIDENCE_CHANGES_WEIGHT, CONFIDENCE_CYCLES_WEIGHT, CONFIDENCE_DAYS_WEIGHT, CONFIDENCE_FULL_CHANGES,
  CONFIDENCE_FULL_CYCLES, CONFIDENCE_FULL_DAYS, CONFIDENCE_FULL_HOURS, CONFIDENCE_HOURS_WEIGHT,
  CONFIDENCE_STALE_DECAY_HOURS, ESTIMATED_AFTER_STALE_HOURS, MAX_CONFIDENCE, MIN_CONFIDENCE, WATCH_PACE_SHARE,
} = require('./tuning.cjs');

/** @typedef {import('../../src/types').Forecast} Forecast */
/** @typedef {import('../../src/types').ForecastState} ForecastState */
/** @typedef {import('./calendar.cjs').Excluded} Excluded */
/** @typedef {import('./samples.cjs').LearningSample} LearningSample */
/** @typedef {import('./windows.cjs').WindowCluster} WindowCluster */
/** @typedef {import('./windows.cjs').WindowView} WindowView */
/** @typedef {import('./settings.cjs').ResolvedSettings} ResolvedSettings */
/** @typedef {import('./learn.cjs').LearnedModel} LearnedModel */
/** @typedef {import('./series.cjs').Projection} Projection */

/**
 * @param {number} expectedRemaining
 * @param {number} heavyRemaining
 * @param {number} paceRatio
 * @param {number} paceRiskThreshold
 * @param {number} watchRemainingThreshold
 * @returns {import('../../src/types').ForecastState}
 */
function forecastState(expectedRemaining, heavyRemaining, paceRatio, paceRiskThreshold, watchRemainingThreshold) {
  return expectedRemaining <= 0 ? 'critical'
    : heavyRemaining <= 0 || paceRatio > paceRiskThreshold ? 'risk'
      : expectedRemaining < watchRemainingThreshold || heavyRemaining < watchRemainingThreshold
        || paceRatio > paceRiskThreshold * WATCH_PACE_SHARE ? 'watch' : 'safe';
}

/**
 * @param {{ expired?: boolean, observed?: import('../../src/types').Point[], staleHours?: number }} [options]
 * @returns {import('../../src/types').Forecast}
 */
function unknownForecast({ expired = false, observed = [], staleHours = 0 } = {}) {
  return {
    state: 'unknown', expectedRemaining: null, heavyRemaining: null, confidence: 0,
    learnedSamples: 0, learnedDays: 0, activeHoursLeft: 0, safePace: 0,
    recentPace: 0, paceRatio: 0, workingPace: 0, windowPace: null, expired, staleHours,
    estimatedCurrentRemaining: null, currentIsEstimated: false,
    exhaustsAt: null, heavyExhaustsAt: null, reservePercent: 0,
    series: { observed, expected: [], heavy: [] },
  };
}

// How much history stands behind a forecast, and how far that can be trusted
// given the age of the latest evidence.
/**
 * @param {LearningSample[]} modelSamples The samples that give a rate.
 * @param {WindowCluster[]} clusters
 * @param {Excluded} excluded
 * @param {number} staleHours
 */
function evidenceBehind(modelSamples, clusters, excluded, staleHours) {
  // Preserve ordinary evidence counting when exclusions do not affect a
  // sample. A clean interval may close at midnight on an ignored day; only
  // that endpoint needs the preceding allocation day instead of its label.
  const learnedDays = new Set(modelSamples.map((sample) => excluded(sample.observedAt, sample.observedAt + 1)
    // Every sample covers part of at least one day.
    ? /** @type {{ day: string }} */ (sample.dailyDeltas.at(-1)).day
    : localDayKey(new Date(sample.observedAt)))).size;
  const coveredHours = modelSamples.reduce((total, sample) => total + sample.coveredHours, 0);
  const changedSamples = new Set(modelSamples.filter((sample) => sample.changed).map((sample) => sample.observedAt)).size;
  const resetCycles = clusters.filter((entry) => entry.rows.some((row) => !excluded(row.observedAt, row.observedAt + 1))).length;
  const evidenceConfidence = CONFIDENCE_BASE + Math.min(learnedDays, CONFIDENCE_FULL_DAYS) / CONFIDENCE_FULL_DAYS * CONFIDENCE_DAYS_WEIGHT
    + Math.min(coveredHours, CONFIDENCE_FULL_HOURS) / CONFIDENCE_FULL_HOURS * CONFIDENCE_HOURS_WEIGHT
    + Math.min(changedSamples, CONFIDENCE_FULL_CHANGES) / CONFIDENCE_FULL_CHANGES * CONFIDENCE_CHANGES_WEIGHT
    + Math.min(resetCycles, CONFIDENCE_FULL_CYCLES) / CONFIDENCE_FULL_CYCLES * CONFIDENCE_CYCLES_WEIGHT;
  const confidence = clamp(evidenceConfidence * Math.exp(-staleHours / CONFIDENCE_STALE_DECAY_HOURS), MIN_CONFIDENCE, MAX_CONFIDENCE);
  return { learnedDays, confidence };
}

/**
 * @param {WindowView} view
 * @param {ResolvedSettings} settings
 * @param {LearnedModel} model
 * @param {Projection} projection
 * @returns {Forecast}
 */
function assessForecast(view, settings, model, projection) {
  const { nowMs, resetMs, clusters, observed, staleHours } = view;
  const { schedule, reservePercent, paceRiskThreshold, watchRemainingThreshold, excluded } = settings;
  const { modelSamples, sustainableOffSchedulePace, recent, globalRate, anchor, windowPace } = model;
  const { estimatedCurrent, expectedRemaining, heavyRemaining } = projection;
  const activeHoursLeft = activeHoursBetween(nowMs, resetMs, schedule);
  const elapsedHoursLeft = Math.max(0, (resetMs - nowMs) / HOUR_MS);
  const offHoursLeft = Math.max(0, elapsedHoursLeft - activeHoursLeft);
  const offProjectedPace = sustainableOffSchedulePace;
  const safePace = activeHoursLeft > 0
    ? Math.max(0, estimatedCurrent - reservePercent - offProjectedPace * offHoursLeft) / activeHoursLeft
    : 0;
  // Compare like with like: the safe pace is an average over every remaining
  // active hour, so the pace measured against it must be the anchored
  // projection, not the conditional while-working burst rate.
  const workingPace = recent || globalRate;
  const recentPace = anchor ? anchor.rate * anchor.weight + workingPace * (1 - anchor.weight) : workingPace;
  // A positive pace against a zero active-hours budget is over the limit, not
  // zero risk. Keep the sentinel finite so snapshots remain JSON-safe. When
  // there are no active hours left, active pace is irrelevant to this reset.
  const paceRatio = safePace > 0
    ? recentPace / safePace
    : activeHoursLeft > 0 && recentPace > 0 ? paceRiskThreshold + 1 : 0;
  const { learnedDays, confidence } = evidenceBehind(modelSamples, clusters, excluded, staleHours);
  const state = forecastState(expectedRemaining, heavyRemaining, paceRatio, paceRiskThreshold, watchRemainingThreshold);

  return {
    state, expectedRemaining, heavyRemaining, confidence, learnedSamples: modelSamples.length,
    learnedDays, activeHoursLeft, safePace, recentPace, paceRatio, expired: false,
    workingPace, windowPace,
    staleHours, estimatedCurrentRemaining: estimatedCurrent, currentIsEstimated: staleHours > ESTIMATED_AFTER_STALE_HOURS,
    exhaustsAt: exhaustionTime(projection.expected),
    heavyExhaustsAt: exhaustionTime(projection.heavy),
    reservePercent,
    series: { observed, expected: projection.expected, heavy: projection.heavy },
  };
}

module.exports = { assessForecast, forecastState, unknownForecast };
