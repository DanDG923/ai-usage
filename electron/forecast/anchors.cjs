'use strict';

// Stage seven: the pace of a whole allowance window. The provider's used
// share covers the window from its start, so dividing it by the hours the
// window has run gives a sustained pace that anchors the projection: a burst
// learned from a few readings is not carried across every remaining hour.

const { latestEvidenceAt, usedPercentOf } = require('../quota-evidence.cjs');
const { HOUR_MS, MINUTE_MS, activeHoursBetween, exclusionLookup, isActiveHour, localDayKey, nextLocalHour } = require('./calendar.cjs');
const { clamp } = require('./maths.cjs');
const { deriveLearningSamples } = require('./samples.cjs');
const {
  ANCHOR_FULL_WEIGHT_HOURS, MAX_ANCHOR_WEIGHT, MAX_PRIOR_ANCHOR_WEIGHT, MIN_PRIOR_WINDOW_ACTIVE_HOURS,
  MIN_PRIOR_WINDOW_MINUTES, MIN_WINDOW_PACE_HOURS,
} = require('./tuning.cjs');

/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('../types').Schedule} Schedule */
/** @typedef {import('./calendar.cjs').Excluded} Excluded */
/** @typedef {import('./windows.cjs').WindowCluster} WindowCluster */

/**
 * One window's elapsed hours and usage, divided between scheduled and
 * off-schedule time.
 * @typedef {{ elapsedHours: number, activeHours: number, offHours: number, activeUsed: number, offUsed: number }} WindowSplit
 */

/**
 * A pace and how far it is trusted against the learned hourly rates.
 * @typedef {{ rate: number, weight: number }} RateAnchor
 */

/**
 * The pace of an earlier window, for a window too new to have one.
 * @typedef {{ pace: number, activeHours: number, evidenceActiveHours: number }} WindowPace
 */

/**
 * What the allowance windows say about sustained pace.
 * @typedef {object} WindowAnchors
 * @property {RateAnchor | null} active The scheduled-hours pace of this window, with the window before it standing in while this one is new.
 * @property {RateAnchor | null} offSchedule The off-schedule pace of this window.
 * @property {number | null} windowPace Points per scheduled hour across this window; null before it has covered an hour of them.
 * @property {number | null} offWindowPace Points per off-schedule hour across this window; null before it has covered an hour of them.
 * @property {number} offHours The off-schedule hours this window has covered.
 */

// On the casts to number in this file: a time, window length or rate that may
// be null or absent is cast beside the test that rules that out at run time,
// which the checker cannot follow. Any other cast carries its own comment.

// Split one window's usage between scheduled and off-schedule hours. There
// are three ways, chosen by what the span touches: a span that touches an
// ignored day is split clean span by clean span; one that touches a day an
// early reset discounted has that day's share reduced; any other is split by
// what the readings localise, and the rest by exposure.
/**
 * @param {Reading[]} rows
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} used
 * @param {Excluded | null} [excluded]
 * @param {Map<string, number> | null} [dayWeights]
 * @returns {WindowSplit}
 */
function splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used, excluded = null, dayWeights = null) {
  return excluded?.(startMs, endMs)
    ? splitCleanSpans(rows, schedule, nowMs, excluded, dayWeights)
    : splitSpan(rows, schedule, nowMs, startMs, endMs, used, dayWeights);
}

// A span that touches no ignored day: discounted where it touches a day with
// reduced influence, by exposure otherwise.
/**
 * @param {Reading[]} rows
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} used
 * @param {Map<string, number> | null} [dayWeights]
 * @returns {WindowSplit}
 */
function splitSpan(rows, schedule, nowMs, startMs, endMs, used, dayWeights = null) {
  return dayWeights?.size && exclusionLookup([...dayWeights.keys()])(startMs, endMs)
    ? splitDiscountingDays(rows, schedule, nowMs, startMs, endMs, used, dayWeights)
    : splitByExposure(rows, schedule, nowMs, startMs, endMs, used);
}

// A window that touches an ignored day.
/**
 * @param {Reading[]} rows
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {Excluded} excluded
 * @param {Map<string, number> | null} dayWeights
 * @returns {WindowSplit}
 */
function splitCleanSpans(rows, schedule, nowMs, excluded, dayWeights) {
  // A cumulative provider total includes the ignored day's burn. Only clean
  // spans bounded by actual readings can supply usage and elapsed exposure;
  // distributing the missing remainder would silently relearn that day.
  /** @type {Reading[][]} Each holds at least one reading. */
  const segments = [];
  let peakUsed = 0;
  for (const row of rows) {
    const segment = segments.at(-1);
    peakUsed = Math.max(peakUsed, usedPercentOf(row));
    const monotonic = { ...row, usedPercent: peakUsed };
    if (!segment || excluded(/** @type {Reading} */ (segment.at(-1)).observedAt, row.observedAt)) segments.push([monotonic]);
    else segment.push(monotonic);
  }
  const result = { elapsedHours: 0, activeHours: 0, offHours: 0, activeUsed: 0, offUsed: 0 };
  for (const segment of segments) {
    if (segment.length < 2) continue;
    const first = segment[0];
    const last = /** @type {Reading} */ (segment.at(-1));
    const cleanUsed = segment.reduce((peak, row) => Math.max(peak, usedPercentOf(row)), usedPercentOf(first)) - usedPercentOf(first);
    const split = splitSpan(segment, schedule, nowMs, first.observedAt, last.observedAt, cleanUsed, dayWeights);
    // The keys of `result` are the fields of a split and no others.
    for (const key of /** @type {(keyof WindowSplit)[]} */ (Object.keys(result))) result[key] += split[key];
  }
  return result;
}

// A span that touches a day an early reset has discounted.
/**
 * @param {Reading[]} rows
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} used
 * @param {Map<string, number>} dayWeights
 * @returns {WindowSplit}
 */
function splitDiscountingDays(rows, schedule, nowMs, startMs, endMs, used, dayWeights) {
  // Change the weight of localised usage and its measured exposure together.
  // Earlier cumulative usage cannot be assigned to this day: preserve its
  // original contribution and exposure. In particular, an initial 0% reading
  // proves the earlier window was quiet; dropping those hours inflates pace.
  const result = splitByExposure(rows, schedule, nowMs, startMs, endMs, used);
  const samples = deriveLearningSamples(rows, schedule, nowMs);
  const known = samples.reduce((sum, sample) => sum + sample.delta, 0);
  const scale = known > used && known > 0 ? used / known : 1;
  for (const sample of samples) {
    const key = sample.phase === 'active' ? 'activeUsed' : 'offUsed';
    result[key] -= sample.dailyDeltas.reduce((sum, entry) => sum + entry.delta * scale * (1 - (dayWeights.get(entry.day) ?? 1)), 0);
  }
  let cursor = Math.max(startMs, rows[0].observedAt);
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    const midpoint = new Date((cursor + next) / 2);
    const hours = (next - cursor) / HOUR_MS * (1 - (dayWeights.get(localDayKey(midpoint)) ?? 1));
    result.elapsedHours -= hours;
    result[isActiveHour(midpoint, schedule) ? 'activeHours' : 'offHours'] -= hours;
    cursor = next;
  }
  return result;
}

// Usage already localised by observation intervals belongs to its measured
// phase. The remainder happened before the first useful reading, so the
// observed phase mix cannot tell us where it occurred; distribute that unknown
// remainder by elapsed exposure instead, otherwise one +1 just after the
// active-hours boundary can assign an entire 13% window burn to off-schedule use.
/**
 * @param {Reading[]} rows
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} used
 * @returns {WindowSplit}
 */
function splitByExposure(rows, schedule, nowMs, startMs, endMs, used) {
  const elapsedHours = Math.max(0, (endMs - startMs) / HOUR_MS);
  const activeHours = activeHoursBetween(startMs, endMs, schedule);
  const offHours = Math.max(0, elapsedHours - activeHours);
  const samples = deriveLearningSamples(rows, schedule, nowMs);
  const knownActive = samples.filter((sample) => sample.phase === 'active').reduce((sum, sample) => sum + sample.delta, 0);
  const knownOff = samples.filter((sample) => sample.phase === 'off-schedule').reduce((sum, sample) => sum + sample.delta, 0);
  const known = knownActive + knownOff;
  const scale = known > used && known > 0 ? used / known : 1;
  const unlocalised = Math.max(0, used - known * scale);
  const exposureActiveShare = elapsedHours > 0 ? activeHours / elapsedHours : 1;
  return {
    elapsedHours,
    activeHours,
    offHours,
    activeUsed: knownActive * scale + unlocalised * exposureActiveShare,
    offUsed: knownOff * scale + unlocalised * (1 - exposureActiveShare),
  };
}

// Average allowance consumption per scheduled active hour across one window.
// The provider's used-percentage covers the whole window, so when the window
// length is known the denominator starts at the true window start.
/**
 * @param {Reading[]} rows At least one reading.
 * @param {Schedule} schedule
 * @param {number | null} [observedResetAt]
 * @param {Excluded | null} [excluded]
 * @param {Map<string, number> | null} [dayWeights]
 * @returns {WindowPace | null}
 */
function windowPaceOf(rows, schedule, observedResetAt = null, nowMs = Date.now(), excluded = null, dayWeights = null) {
  // Callers pass a window that has readings.
  const last = /** @type {Reading} */ (rows.at(-1));
  const usedEnd = usedPercentOf(last);
  const windowMinutes = rows.findLast((row) => Number.isFinite(row.windowMinutes) && /** @type {number} */ (row.windowMinutes) > 0)?.windowMinutes;
  const startMs = Number.isFinite(observedResetAt)
    ? /** @type {number} */ (observedResetAt)
    : windowMinutes ? last.resetsAt - windowMinutes * MINUTE_MS : rows[0].observedAt;
  // Backward jitter within a window must not discard the pace entirely.
  const used = windowMinutes ? usedEnd : Math.max(0, usedEnd - usedPercentOf(rows[0]));
  if (!(used >= 0)) return null;
  // Only the scheduled share of the window's usage may carry forward as an
  // active-hour pace: the projection adds off-schedule use separately, so a
  // whole-window average would count every late-night point twice. Exposure
  // ends when the last figure was fetched: a later idle redraw observed nothing.
  // Null only for no readings at all.
  const endMs = /** @type {number} */ (latestEvidenceAt(rows));
  const split = splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used, excluded, dayWeights);
  const evidenceActiveHours = dayWeights?.size
    ? splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used, excluded).activeHours : split.activeHours;
  return evidenceActiveHours >= MIN_WINDOW_PACE_HOURS && split.activeHours > 0
    ? { pace: split.activeUsed / split.activeHours, activeHours: split.activeHours, evidenceActiveHours } : null;
}

// After a reset the fresh window has no history of its own, so the most
// recent prior window's average pace carries forward as weaker evidence
// instead of letting while-working burst rates run unchecked until reset.
// Only the most recent qualifying window is used, so scan backwards and
// stop there rather than pacing every historical cluster first.
/**
 * @param {WindowCluster[]} clusters
 * @param {WindowCluster} currentCluster
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {Excluded} excluded
 * @param {Map<string, number> | null} dayWeights
 * @returns {WindowPace | null}
 */
function priorWindowPace(clusters, currentCluster, schedule, nowMs, excluded, dayWeights) {
  /** @type {WindowPace | null} */
  let priorEvidence = null;
  for (let index = clusters.length - 1; index >= 0 && !priorEvidence; index -= 1) {
    const entry = clusters[index];
    if (entry === currentCluster || entry.rows.length < 2) continue;
    // A cluster is never empty. A window of unknown length fails the first test.
    if (/** @type {{ windowMinutes: number }} */ (entry.rows.at(-1)).windowMinutes > 0 && /** @type {{ windowMinutes: number }} */ (entry.rows.at(-1)).windowMinutes < MIN_PRIOR_WINDOW_MINUTES) continue;
    const pace = windowPaceOf(entry.rows, schedule, entry.observedResetAt, nowMs, excluded, dayWeights);
    if (pace && pace.evidenceActiveHours >= MIN_PRIOR_WINDOW_ACTIVE_HOURS) priorEvidence = pace;
  }
  return priorEvidence;
}

// Window anchor: the provider's used-percentage covers the whole window, so
// usage divided by the window's elapsed active hours is the strongest signal
// of sustainable pace. Evidence ends when the current figure was fetched,
// never at "now" or at an idle redraw that came after it.
/**
 * @param {object} input
 * @param {WindowCluster} input.currentCluster
 * @param {WindowCluster[]} input.clusters
 * @param {Schedule} input.schedule
 * @param {number} input.nowMs
 * @param {Excluded} input.excluded
 * @param {Map<string, number> | null} input.dayWeights
 * @param {number} input.usedNow
 * @param {number} input.resetMs
 * @param {number} input.evidenceMs
 * @returns {WindowAnchors}
 */
function windowAnchors({ currentCluster, clusters, schedule, nowMs, excluded, dayWeights, usedNow, resetMs, evidenceMs }) {
  const inWindow = currentCluster.rows;
  const windowMinutes = inWindow.findLast((row) => Number.isFinite(row.windowMinutes) && /** @type {number} */ (row.windowMinutes) > 0)?.windowMinutes;
  const anchorStartMs = Number.isFinite(currentCluster.observedResetAt)
    ? /** @type {number} */ (currentCluster.observedResetAt)
    : windowMinutes ? resetMs - windowMinutes * MINUTE_MS : inWindow[0].observedAt;
  // Backward jitter on the latest reading (e.g. 5.0% → 4.9%) must degrade the
  // anchor to "pace ≈ 0", not discard the whole window's evidence as invalid.
  const anchorUsed = windowMinutes ? usedNow : Math.max(0, usedNow - usedPercentOf(inWindow[0]));
  const {
    activeHours: anchorActiveHours, offHours: anchorOffHours, activeUsed: activeAnchorUsed, offUsed: offAnchorUsed,
  } = splitWindowUsage(inWindow, schedule, nowMs, anchorStartMs, evidenceMs, anchorUsed, excluded, dayWeights);
  const windowPace = anchorActiveHours >= MIN_WINDOW_PACE_HOURS ? activeAnchorUsed / anchorActiveHours : null;
  const offWindowPace = anchorOffHours >= MIN_WINDOW_PACE_HOURS ? offAnchorUsed / anchorOffHours : null;
  const priorEvidence = priorWindowPace(clusters, currentCluster, schedule, nowMs, excluded, dayWeights);
  const windowWeight = windowPace == null ? 0 : clamp(anchorActiveHours / ANCHOR_FULL_WEIGHT_HOURS, 0, MAX_ANCHOR_WEIGHT);
  const priorWeight = priorEvidence
    ? clamp(priorEvidence.activeHours / ANCHOR_FULL_WEIGHT_HOURS, 0, MAX_PRIOR_ANCHOR_WEIGHT) * (1 - windowWeight) : 0;
  const anchorWeight = clamp(windowWeight + priorWeight, 0, MAX_ANCHOR_WEIGHT);
  const active = anchorWeight > 0
    ? {
      rate: ((windowPace ?? 0) * windowWeight + (priorEvidence?.pace ?? 0) * priorWeight) / (windowWeight + priorWeight),
      weight: anchorWeight,
    }
    : null;
  const offSchedule = offWindowPace == null
    ? null : { rate: offWindowPace, weight: clamp(anchorOffHours / ANCHOR_FULL_WEIGHT_HOURS, 0, MAX_ANCHOR_WEIGHT) };
  return { active, offSchedule, windowPace, offWindowPace, offHours: anchorOffHours };
}

module.exports = { splitWindowUsage, windowAnchors, windowPaceOf };
