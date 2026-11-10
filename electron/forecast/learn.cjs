'use strict';

// The learner: stages six to nine in order, and the cache that lets a model
// learned a moment ago serve the next forecast.

const { windowAnchors } = require('./anchors.cjs');
const { dailyShape } = require('./daily-shape.cjs');
const { learnRates } = require('./rates.cjs');
const { deriveLearningSamples, weighSamplesByDay } = require('./samples.cjs');
const { LEARNING_CACHE_MAX_MODELS, LEARNING_CACHE_TTL_MS } = require('./tuning.cjs');

/** @typedef {import('./samples.cjs').LearningSample} LearningSample */
/** @typedef {import('./anchors.cjs').RateAnchor} RateAnchor */
/** @typedef {import('./rates.cjs').ForecastRates} ForecastRates */
/** @typedef {import('./windows.cjs').WindowView} WindowView */
/** @typedef {import('./settings.cjs').ResolvedSettings} ResolvedSettings */

/**
 * What the readings teach, as a projection and its assessment use it.
 * @typedef {object} LearnedModel
 * @property {LearningSample[]} samples Every sample, weighted by day.
 * @property {LearningSample[]} modelSamples The samples that give a rate.
 * @property {ForecastRates} rates
 * @property {number} sustainableOffSchedulePace Points per off-schedule hour, spread over whole nights.
 * @property {number} recent The recent scheduled-hours rate; zero when nothing recent was learned.
 * @property {number} globalRate The mean scheduled-hours rate.
 * @property {RateAnchor | null} anchor The scheduled-hours pace of the allowance window.
 * @property {number | null} windowPace Points per scheduled hour across this window.
 */

/**
 * The models learned lately, by what they were learned from.
 * @typedef {Map<string, { at: number, value: LearnedModel }>} LearningCache
 */

/**
 * @param {WindowView} view
 * @param {Pick<ResolvedSettings, 'schedule' | 'excluded' | 'fallbackRate'>} settings
 * @param {Map<string, number> | null} dayWeights The share of its usual influence each discounted day keeps.
 * @returns {LearnedModel}
 */
function learnForecast(view, { schedule, excluded, fallbackRate }, dayWeights) {
  const { readings, current, currentCluster, clusters, nowMs, usedNow, resetMs, evidenceMs } = view;
  const samples = weighSamplesByDay(deriveLearningSamples(readings, schedule, nowMs, excluded), dayWeights);
  const modelSamples = samples.filter((sample) => sample.rateEligible !== false);
  const anchors = windowAnchors({ currentCluster, clusters, schedule, nowMs, excluded, dayWeights, usedNow, resetMs, evidenceMs });
  const shape = dailyShape({ samples, readings, current, schedule, nowMs, excluded, dayWeights });
  const learned = learnRates({ samples, modelSamples, anchors, shape, current, schedule, nowMs, fallbackRate });
  return { samples, modelSamples, ...learned, anchor: anchors.active, windowPace: anchors.windowPace };
}

// Learning is most of a forecast's cost, and a card redrawn a few seconds
// later learns the same thing. The key names the readings (how many, the first
// and latest, the latest figure and its evidence) and the day weights, and
// nothing else: not the schedule, the ignored days, the fallback rate or the
// readings in between. A cache is therefore only safe when its owner keeps one
// per set of settings and discards it whenever a reading is added or changed,
// as the store does by keying its caches on the options and the quota revision.
/**
 * @param {WindowView} view
 * @param {Pick<ResolvedSettings, 'schedule' | 'excluded' | 'fallbackRate'>} settings
 * @param {Map<string, number> | null} dayWeights
 * @param {LearningCache} [cache] Read and added to.
 * @returns {LearnedModel}
 */
function learnModel(view, settings, dayWeights, cache) {
  const { readings, current, evidenceMs, nowMs } = view;
  const learningKey = JSON.stringify([readings.length, readings[0].observedAt, current.observedAt, current.usedPercent,
    evidenceMs, dayWeights ? [...dayWeights] : null]);
  const cachedModel = cache?.get(learningKey);
  const model = cachedModel && nowMs >= cachedModel.at && nowMs - cachedModel.at < LEARNING_CACHE_TTL_MS
    ? cachedModel.value : learnForecast(view, settings, dayWeights);
  if (cache && model !== cachedModel?.value) {
    if (cache.size >= LEARNING_CACHE_MAX_MODELS) cache.clear();
    cache.set(learningKey, { at: nowMs, value: model });
  }
  return model;
}

module.exports = { learnModel };
