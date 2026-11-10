'use strict';

// Stage five: which readings belong to which allowance window, and what the
// window in force now looks like before anything is learned.

const {
  RESET_TOLERANCE_MS, clearAllowanceRebase, fetchMomentOf, latestEvidenceAt, usedPercentOf,
} = require('../quota-evidence.cjs');
const { HOUR_MS } = require('./calendar.cjs');
const { clamp } = require('./maths.cjs');
const { validInOrder, withinLookback } = require('./readings.cjs');
const { IDLE_ROLLING_USED_TOLERANCE, OBSERVED_DISPLAY_MS, RESET_DRIFT_PER_ELAPSED } = require('./tuning.cjs');

/** @typedef {import('../types').Reading} Reading */
/** @typedef {import('../types').Point} Point */
/** @typedef {import('./settings.cjs').ReadingEvidence} ReadingEvidence */

/**
 * The readings of one allowance window, in time order.
 * @template {Reading} [T=Reading]
 * @typedef {object} WindowCluster
 * @property {number} resetsAt The reset its latest reading names.
 * @property {T[]} rows Never empty.
 * @property {number | null} observedResetAt When the window was seen to begin, where an early replenishment showed it.
 */

/**
 * The allowance window in force, as the readings show it.
 * @typedef {object} WindowView
 * @property {number} nowMs The moment forecast from.
 * @property {Reading[]} readings Valid readings in time order: those recent enough to learn from, and the latest.
 * @property {Reading} current The latest reading.
 * @property {WindowCluster[]} clusters Every window among the readings, oldest first.
 * @property {WindowCluster} currentCluster The window the latest reading belongs to.
 * @property {Point[]} observed The window's readings as the chart draws them.
 * @property {number} resetMs When the window resets.
 * @property {boolean} expired Whether that reset has passed, or is not a time at all.
 * @property {number} evidenceMs When the latest figure is evidence of.
 * @property {number} staleHours How long ago the latest figure is known to have held.
 * @property {number} remaining The share left, as the latest reading shows it.
 * @property {number} usedNow The share used, as the latest reading shows it.
 */

// On the casts to number in this file: a time, window length or rate that may
// be null or absent is cast beside the test that rules that out at run time,
// which the checker cannot follow. Any other cast carries its own comment.

// How far a reset timestamp may move between two readings a given time apart
// and still name the same reset.
/** @param {number} gapMs */
function resetJitterAllowance(gapMs) {
  return RESET_TOLERANCE_MS + gapMs * RESET_DRIFT_PER_ELAPSED;
}

// Two consecutive readings belong to the same allowance window in exactly two
// real patterns: a PINNED window (usage has started; the reset stays put bar
// slow jitter) or an IDLE ROLLING window (nothing used yet; the reset rolls
// forward 1:1 with elapsed time while the used percentage stays unchanged).
// Anything else — including a reset that moved by hours while usage changed —
// is a different window. A blanket gap-sized tolerance is NOT safe: it lets a
// dormant cluster's tolerance grow until it steals rows from the live window,
// and merges genuinely distinct short windows across an offline gap.
/**
 * @param {Reading} previousRow
 * @param {Reading} row
 */
function sameWindowDrift(previousRow, row) {
  if (clearAllowanceRebase(previousRow, row)) return false;
  const gapMs = Math.max(0, row.observedAt - previousRow.observedAt);
  const jitterAllowance = resetJitterAllowance(gapMs);
  const resetShift = row.resetsAt - previousRow.resetsAt;
  if (Math.abs(resetShift) <= jitterAllowance) return true;
  return Math.abs(resetShift - gapMs) <= jitterAllowance
    && Math.abs(usedPercentOf(row) - usedPercentOf(previousRow)) <= IDLE_ROLLING_USED_TOLERANCE;
}

// Group readings, given in time order, into the allowance windows they show.
/**
 * @template {Reading} T
 * @param {T[]} rows
 */
function clusterByWindow(rows) {
  /** @type {WindowCluster<T>[]} */
  const clusters = [];
  for (const row of rows) {
    // Windows are sequential in time, so a time-sorted row either continues
    // the latest cluster or starts a new one — never rejoins a dormant one.
    const cluster = clusters.at(-1);
    const previous = cluster?.rows.at(-1);
    // A cluster is never empty, so it has a last row.
    if (cluster && sameWindowDrift(/** @type {T} */ (previous), row)) {
      cluster.rows.push(row);
      cluster.resetsAt = row.resetsAt;
    } else {
      const gapMs = previous ? Math.max(0, row.observedAt - previous.observedAt) : 0;
      const resetTimestampUnchanged = previous
        && Math.abs(row.resetsAt - previous.resetsAt) <= resetJitterAllowance(gapMs);
      clusters.push({
        resetsAt: row.resetsAt,
        rows: [row],
        // When only the percentage has updated, the first near-zero reading
        // is the strongest available lower bound for the new window start.
        // It is dated by its fetch, as the evidence ending the window's
        // exposure is: a status-line redraw may come well after the fetch.
        observedResetAt: previous && resetTimestampUnchanged && clearAllowanceRebase(previous, row)
          ? fetchMomentOf(row)
          : null,
      });
    }
  }
  return clusters;
}

// The latest reading, its window, and how current it is. Null when no
// reading has a valid time.
/**
 * @param {Reading[]} rows Normalised readings.
 * @param {number} nowMs
 * @param {ReadingEvidence} [evidence] How current the latest reading is, where the caller measured it.
 * @returns {WindowView | null}
 */
function viewCurrentWindow(rows, nowMs, evidence) {
  const valid = validInOrder(rows, nowMs);
  const current = valid.at(-1);
  if (!current) return null;
  const readings = withinLookback(valid, current, nowMs);

  const resetMs = current.resetsAt;
  const clusters = clusterByWindow(readings);
  // A hard reset may briefly retain the previous reset timestamp, so select
  // the latest matching cluster rather than the first historical match.
  // There is a current reading, and the last cluster holds it.
  const currentCluster = /** @type {WindowCluster} */ (clusters.at(-1));
  const displayStart = nowMs - OBSERVED_DISPLAY_MS;
  const firstVisible = currentCluster.rows.findIndex((row) => row.observedAt >= displayStart);
  const visibleRows = firstVisible < 0 ? currentCluster.rows.slice(-1) : currentCluster.rows.slice(Math.max(0, firstVisible - 1));
  const observed = visibleRows
    .map((row) => ({ at: row.observedAt, remaining: Number.isFinite(row.remainingPercent) ? row.remainingPercent : 100 - row.usedPercent }))
    // A reading that carries neither figure has no place on the chart.
    .filter((point) => Number.isFinite(point.remaining))
    .map((point) => ({ at: point.at, remaining: clamp(point.remaining, 0, 100) }));
  // The current value is as old as its evidence, not its latest redraw. The
  // caller may have measured that before compacting away a newer read. Use
  // since then is caught up from where the figure is placed, but it is only
  // as fresh as it is known to be: an undated redraw may carry a fetch from
  // anywhere in its window.
  const measured = evidence?.observedAt === current.observedAt;
  // Where it is measured afresh, there is a current reading, so it has a time.
  const evidenceMs = measured && Number.isFinite(evidence.at)
    ? Math.min(/** @type {number} */ (evidence.at), current.observedAt) : /** @type {number} */ (latestEvidenceAt(readings));
  const knownMs = measured && Number.isFinite(evidence.known)
    ? Math.min(/** @type {number} */ (evidence.known), current.observedAt) : latestEvidenceAt(readings, { known: true });
  // There is a current reading here, so its evidence has a time.
  const staleHours = Math.max(0, (nowMs - /** @type {number} */ (knownMs)) / HOUR_MS);

  const remaining = Number.isFinite(current.remainingPercent) ? current.remainingPercent : 100 - current.usedPercent;
  const usedNow = clamp(Number.isFinite(current.usedPercent) ? current.usedPercent : 100 - remaining, 0, 100);
  return {
    nowMs, readings, current, clusters, currentCluster, observed, resetMs,
    expired: !Number.isFinite(resetMs) || resetMs <= nowMs,
    evidenceMs, staleHours, remaining, usedNow,
  };
}

module.exports = { clusterByWindow, sameWindowDrift, viewCurrentWindow };
