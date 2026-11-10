'use strict';

// The first stages of a forecast, which settle what the readings are before
// anything is learned from them: normalise, rescale for allowance changes,
// drop stale restatements and, where asked, compact unchanged runs.

const {
  latestEvidenceAt, normaliseObservation, rescaleObservations, withoutStaleRestatements,
} = require('../quota-evidence.cjs');
const { FORECAST_LOOKBACK_MS, validQuotaTime } = require('../quota-time.cjs');
const { localDayKey } = require('./calendar.cjs');
const { COVERAGE_GAP_MS } = require('./tuning.cjs');

/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('../types').ReadingLike} ReadingLike */
/** @typedef {import('./settings.cjs').ForecastOptions} ForecastOptions */
/** @typedef {import('./settings.cjs').ReadingEvidence} ReadingEvidence */

/**
 * The readings a forecast is made from.
 * @typedef {object} PreparedReadings
 * @property {Reading[]} rows In time order, as far as their times are valid.
 * @property {ReadingEvidence} [evidence] How current the latest reading is, where it was measured before compacting.
 */

// The readings whose times can be trusted, in time order.
/**
 * @template {Reading} T
 * @param {T[]} rows
 * @param {number} nowMs
 */
function validInOrder(rows, nowMs) {
  return rows.filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs))
    .sort((a, b) => a.observedAt - b.observedAt);
}

// The readings a rate may be learned from, in time order: valid, recent
// enough to learn from, and showing a used share.
/**
 * @template {Reading} T
 * @param {T[]} rows
 * @param {number} nowMs
 */
function learnableInOrder(rows, nowMs) {
  return rows.filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs)
    && row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && Number.isFinite(row.usedPercent))
    .sort((a, b) => a.observedAt - b.observedAt);
}

// Keep the latest dormant reading so it still reports expired, but do not
// traverse ancient rolling windows in learning or active-hour calculations.
/**
 * @template {Reading} T
 * @param {T[]} rows
 * @param {T | undefined} current The latest reading.
 * @param {number} nowMs
 */
function withinLookback(rows, current, nowMs) {
  return rows.filter((row) => row === current || row.observedAt >= nowMs - FORECAST_LOOKBACK_MS);
}

// An unchanged run within a day keeps its first and latest reading, and a
// waypoint at least every COVERAGE_GAP_MS between them. Without the waypoints a
// quiet day polled throughout became one pair a day apart, which the quiet-day
// coverage (daily-shape.cjs) discards as a gap, so its unused off-schedule
// hours were lost.
/**
 * @param {Reading[]} rows
 * @param {number} nowMs
 */
function collapseReadings(rows, nowMs) {
  const result = [];
  /** @type {any} The row before this one, in time order. */
  let previous = null, run = 0, previousDay;
  for (const row of rows) {
    const day = localDayKey(new Date(row.observedAt));
    // Redraws of one fetch collapse; a different fetch of the same figure is
    // kept, since a newer one confirms the figure later than the others.
    const same = previous && day === previousDay && (row.observedAt <= nowMs) === (previous.observedAt <= nowMs)
      // Each names a field of a reading.
      && /** @type {(keyof Reading)[]} */ (['sourceId', 'bucketId', 'usedPercent', 'remainingPercent', 'resetsAt', 'windowMinutes', 'provenance', 'resetEvidence',
        'allowanceScaled', 'fetchedAfter', 'seenSince'])
        .every((field) => Object.is(row[field], previous[field]));
    run = same ? run + 1 : 1;
    if (run > 2 && row.observedAt - result[result.length - 2].observedAt <= COVERAGE_GAP_MS) {
      result[result.length - 1] = row;
    } else {
      result.push(row);
      if (run > 2) run = 2;
    }
    previous = row; previousDay = day;
  }
  return result;
}

// Stages one to four. The readings come back normalised and in time order; a
// reading with an invalid time is still among them unless they were compacted.
/**
 * @param {ReadingLike[]} observations
 * @param {ForecastOptions} options
 * @param {number} nowMs
 * @returns {PreparedReadings}
 */
function prepareReadings(observations, options, nowMs) {
  // Normalise once; each later stage would otherwise re-parse every timestamp.
  const rescaled = rescaleObservations(observations.map(normaliseObservation), options)
    .sort((a, b) => a.observedAt - b.observedAt);
  const believed = withoutStaleRestatements(rescaled, { nowMs, freshReadGraceMs: options.freshReadGraceMs });
  if (!options.compactReadings) return { rows: believed, evidence: options.evidence };
  const valid = validInOrder(believed, nowMs);
  const current = valid.at(-1);
  // A compacted run keeps its latest reading, which may redraw an older
  // fetch than a reading the run drops, so the evidence is measured first.
  const evidence = current
    ? { observedAt: current.observedAt, at: latestEvidenceAt(valid), known: latestEvidenceAt(valid, { known: true }) }
    : options.evidence;
  return { rows: collapseReadings(withinLookback(valid, current, nowMs), nowMs), evidence };
}

module.exports = { collapseReadings, learnableInOrder, prepareReadings, validInOrder, withinLookback };
