'use strict';

// The allowance forecaster. It takes a provider's readings ("34% of this
// week's allowance is used; it resets at …") and predicts what will be left at
// the reset. A forecast is a pipeline of stages, each in its own module:
//
//   quota-evidence.cjs       1  normalise the readings
//                            2  rescale those from before an allowance change
//                            3  drop stale status-line restatements
//   forecast/readings.cjs    4  compact unchanged runs (when asked)
//   forecast/windows.cjs     5  cluster by allowance window; view the current one
//   forecast/samples.cjs     6  derive learning samples
//   forecast/anchors.cjs     7  the pace of the window itself
//   forecast/daily-shape.cjs 8  use by local day
//   forecast/rates.cjs       9  the rates to project with
//   forecast/series.cjs     10  the expected and heavier paths to the reset
//   forecast/assess.cjs     11  safe pace, confidence and state
//
// forecast/learn.cjs runs stages six to nine and caches their result;
// forecast/early-reset.cjs finds days an early reset has discounted, for which
// stages six to eleven run a second time; forecast/tuning.cjs holds every
// number the stages are tuned with.

const { assessForecast, forecastState, unknownForecast } = require('./forecast/assess.cjs');
const { activeHoursBetween } = require('./forecast/calendar.cjs');
const { earlyResetAdjustment, withEarlyReset } = require('./forecast/early-reset.cjs');
const { learnModel } = require('./forecast/learn.cjs');
const { percentile } = require('./forecast/maths.cjs');
const { prepareReadings } = require('./forecast/readings.cjs');
const { deriveLearningSamples } = require('./forecast/samples.cjs');
const { exhaustionTime, projectToReset } = require('./forecast/series.cjs');
const { resolveSettings } = require('./forecast/settings.cjs');
const { clusterByWindow, sameWindowDrift, viewCurrentWindow } = require('./forecast/windows.cjs');

// The shapes the forecast and its callers share, under the names they have
// always had here. Each is declared in the module that produces it.
/** @typedef {import('./types').Reading} Reading */
/** @typedef {import('./types').ReadingLike} ReadingLike */
/** @typedef {import('./types').Schedule} Schedule */
/** @typedef {import('./types').Point} Point */
/** @typedef {import('./types').AllowanceChange} AllowanceChange */
/** @typedef {import('./allowance-changes.cjs').AllowanceScaler} AllowanceScaler */
/** @typedef {import('../src/types').Forecast} Forecast */
/** @typedef {import('../src/types').ForecastState} ForecastState */
/** @typedef {import('./quota-evidence.cjs').TimeInput} TimeInput */
/** @typedef {import('./quota-evidence.cjs').RawReading} RawReading */
/** @typedef {import('./forecast/calendar.cjs').Excluded} Excluded */
/** @typedef {import('./forecast/calendar.cjs').Phase} Phase */
/**
 * @template {Reading} [T=Reading]
 * @typedef {import('./forecast/windows.cjs').WindowCluster<T>} WindowCluster
 */
/** @typedef {import('./forecast/anchors.cjs').WindowSplit} WindowSplit */
/** @typedef {import('./forecast/samples.cjs').LearningSample} LearningSample */
/** @typedef {import('./forecast/rates.cjs').PhaseRates} PhaseRates */
/** @typedef {import('./forecast/rates.cjs').ForecastRates} ForecastRates */
/** @typedef {import('./forecast/learn.cjs').LearnedModel} LearnedModel */
/** @typedef {import('./forecast/settings.cjs').ReadingEvidence} ReadingEvidence */
/** @typedef {import('./forecast/settings.cjs').ForecastSettings} ForecastSettings */
/** @typedef {import('./forecast/settings.cjs').ForecastOptions} ForecastOptions */

/**
 * @param {ReadingLike[]} observations
 * @param {ForecastOptions} [options]
 * @returns {Forecast}
 */
function forecastQuota(observations, options = {}) {
  // The clock is read once, so every stage forecasts from the same moment.
  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();
  const { rows, evidence: measured } = prepareReadings(observations, options, nowMs);
  if (!Number.isFinite(nowMs)) return unknownForecast();
  const settings = resolveSettings(options);
  const view = viewCurrentWindow(rows, nowMs, measured);
  if (!view) return unknownForecast();
  const { observed, staleHours } = view;
  if (view.expired) return unknownForecast({ expired: true, observed, staleHours });

  // Stages six to eleven, with each day at the influence it is given. They
  // run once with every day in full and, where an early reset followed an
  // unusually heavy day, again with that day discounted.
  /** @param {Map<string, number> | null} dayWeights */
  const forecastWith = (dayWeights) => {
    const model = learnModel(view, settings, dayWeights, options.learningCache);
    const projection = projectToReset(view, settings.schedule, model);
    return projection ? assessForecast(view, settings, model, projection) : unknownForecast({ observed, staleHours });
  };
  const ordinary = forecastWith(null);
  if (ordinary.expectedRemaining == null) return ordinary;
  const adjustment = earlyResetAdjustment(rows, settings, nowMs);
  if (!adjustment) return ordinary;
  const adjusted = forecastWith(new Map(adjustment.dates.map((day) => [day, adjustment.weight])));
  return withEarlyReset(ordinary, adjusted, adjustment, settings);
}

// The forecast and the pieces of it other modules and the tests use. A caller
// that only dates readings takes those rules from quota-evidence.cjs.
module.exports = {
  activeHoursBetween, clusterByWindow, sameWindowDrift, deriveLearningSamples, exhaustionTime, forecastQuota,
  forecastState, percentile,
};
