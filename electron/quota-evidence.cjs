'use strict';

// Evidence dating: what a provider reading says and when its figure was
// actually fetched. A status-line reading redraws limits a session fetched
// earlier, so its own time is not the time of its evidence; the rules here
// date each figure, decide whether a lower restatement should be believed,
// and express readings taken before a recorded allowance change in the
// allowance in force now. The collectors and the forecaster both read
// readings through this module; it knows nothing of how a forecast is learned.

const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { freshnessLimitHours } = require('./dashboard-decision.cjs');
const { OFFICIAL_PROVENANCES, isOfficialProvenance } = require('./quota-provenance.mjs');
const { MAX_QUOTA_RESET_AHEAD_MS } = require('./quota-time.cjs');

/** @typedef {import('./types').Reading} Reading */
/** @typedef {import('./types').ReadingLike} ReadingLike */
/** @typedef {import('./types').AllowanceChange} AllowanceChange */
/** @typedef {import('./allowance-changes.cjs').AllowanceScaler} AllowanceScaler */

/**
 * A time as a reading may carry it before it is normalised.
 * @typedef {string | number | Date} TimeInput
 */

/**
 * A reading as it arrives: a row of quota_observations, or the same fields in
 * camelCase with each time as ISO text, a Date or milliseconds. Either
 * spelling of a field may be the one present. The two symbol keys are the
 * marks normaliseObservation and prepareObservation leave.
 * @typedef {Partial<import('./types').ProjectedObservationRow> & {
 *   observedAt?: TimeInput, fetchedAfter?: TimeInput | null, seenSince?: TimeInput | null, resetsAt?: TimeInput,
 *   usedPercent?: number, remainingPercent?: number, windowMinutes?: number | null,
 *   sourceId?: string, bucketId?: string, allowanceScaled?: boolean,
 *   [NORMALISED]?: true, [PREPARED]?: Reading,
 * }} RawReading
 */

/**
 * What rescaling needs to know besides the readings.
 * @typedef {object} RescaleOptions
 * @property {AllowanceChange[] | null} [allowanceChanges]
 * @property {TimeInput | null} [now] The moment the changes are judged from; the clock when absent.
 * @property {string} [sourceId] For readings that do not name their own.
 * @property {string} [bucketId] For readings that do not name their own.
 */

// On the casts to number in this file: a reading's fetch time, first-seen time
// and window length may be null. Number.isFinite, or a comparison with zero,
// rules null out at run time but does not tell the checker so; where a value
// is cast beside such a test, the test is the reason. Any other cast carries
// its own comment.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// Two reset timestamps this close name the same reset: providers restate one
// reset with up to a minute of jitter.
const RESET_TOLERANCE_MS = 60_000;
// A replenished allowance: the used share fell by at least this many points...
const REPLENISHED_MIN_DROP_POINTS = 5;
// ...to no more than this share used. A smaller fall is rounding jitter.
const REPLENISHED_MAX_USED_PERCENT = 2;
// Two figures within this many points of each other show the same use; a
// status-line figure lower than newer evidence by more is a stale restatement.
const STALE_RESTATEMENT_MARGIN = 0.5;
// An undated lower reading waits at least this long for the provider's next read...
const FRESH_READ_GRACE_MS = 2 * HOUR_MS;
// ...and at least this many refresh intervals.
const FRESH_READ_GRACE_REFRESHES = 2;
// Also asked about a reading with no provenance, which is in no set.
/** @type {Set<string | undefined>} */
const RESET_EVIDENCE_PROVENANCES = new Set(OFFICIAL_PROVENANCES);

// Parsing the two ISO timestamps was two thirds of a forecast's CPU time,
// because every pass (ordinary learning, the early-reset check, and the
// re-weighted learning) normalised the same raw rows again. A row is marked
// once it is normalised, and the mark survives object spread, so the later
// passes and the sample derivation inside them return it unchanged.
const NORMALISED = Symbol('normalised');
const PREPARED = Symbol('prepared');
// A figure a reading does not carry is not a number. Number() alone reads a
// null or a blank as zero, which would show an allowance as untouched or spent.
/** @param {unknown} value */
const figureOf = (value) => (value == null || (typeof value === 'string' && !value.trim()) ? Number.NaN : Number(value));
/**
 * @template {RawReading} T
 * @param {T} row
 */
function prepareObservation(row) {
  Object.defineProperty(row, PREPARED, { value: normaliseObservation(row) });
  return row;
}

/**
 * @param {RawReading} row
 * @returns {Reading} Marked as normalised, which only this module can see.
 */
function normaliseObservation(row) {
  // Only what this function returns carries the mark.
  if (row[NORMALISED]) return /** @type {Reading} */ (row);
  if (row[PREPARED]) return row[PREPARED];
  const windowMinutes = row.windowMinutes ?? row.window_minutes;
  const fetchedAfter = row.fetchedAfter ?? row.fetched_after;
  const seenSince = row.seenSince ?? row.seen_since;
  return /** @type {Reading} */ ({
    [NORMALISED]: true,
    // A reading with neither spelling of a time gets an invalid one, which
    // every caller's validity check then rejects.
    observedAt: new Date(/** @type {TimeInput} */ (row.observedAt ?? row.observed_at)).getTime(),
    // The earliest moment a status-line reading's limits can have been
    // fetched; null for a provider read or a reading the collector could not date.
    fetchedAfter: fetchedAfter == null ? null : new Date(fetchedAfter).getTime(),
    // The first redraw in which its session showed the same limits: the fetch
    // was no later. Kept for readings that cannot be dated from below.
    seenSince: seenSince == null ? null : new Date(seenSince).getTime(),
    resetsAt: new Date(/** @type {TimeInput} */ (row.resetsAt ?? row.resets_at)).getTime(),
    usedPercent: figureOf(row.usedPercent ?? row.used_percent),
    remainingPercent: figureOf(row.remainingPercent ?? row.remaining_percent),
    windowMinutes: windowMinutes == null ? null : Number(windowMinutes),
    provenance: row.provenance || 'official',
    // Judged on the provenance as supplied: an absent one is not evidence of
    // a reset, even though it reads as 'official' everywhere else.
    resetEvidence: RESET_EVIDENCE_PROVENANCES.has(row.provenance),
    sourceId: row.sourceId ?? row.source_id,
    bucketId: row.bucketId ?? row.bucket_id,
    // A projected point is computed in the current allowance already; it
    // must not be rescaled again as if it were a stored reading.
    allowanceScaled: Boolean(row.allowanceScaled ?? row.allowance_scaled),
  });
}

// Readings before a recorded allowance change are a share of a different
// allowance. Express them in the current one so the step at the change is
// not learned as a burst and the earlier pace is not understated. The scaled
// copy keeps its normalised mark, so every later pass takes it as it is.
/**
 * @param {Reading[]} rows
 * @param {RescaleOptions} options
 */
function rescaleObservations(rows, options) {
  const changes = options.allowanceChanges;
  if (!Array.isArray(changes) || !changes.length) return rows;
  /** @type {Map<string, AllowanceScaler | null>} */
  const scalers = new Map();
  let /** @type {string | undefined} */ previousSource, /** @type {string | undefined} */ previousBucket,
    /** @type {number | null | undefined} */ previousMinutes, /** @type {AllowanceScaler | null | undefined} */ previousScaler;
  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();
  return rows.map((row) => {
    const sourceId = row.sourceId ?? options.sourceId;
    if (!sourceId || row.allowanceScaled) return row;
    const bucketId = row.bucketId ?? options.bucketId;
    const windowMinutes = row.windowMinutes;
    if (sourceId !== previousSource || bucketId !== previousBucket || windowMinutes !== previousMinutes) {
      const key = JSON.stringify([sourceId, bucketId, windowMinutes]);
      if (!scalers.has(key)) scalers.set(key, createAllowanceScaler(changes, sourceId, { bucketId, windowMinutes, nowMs }));
      previousSource = sourceId; previousBucket = bucketId; previousMinutes = windowMinutes; previousScaler = scalers.get(key);
    }
    const scale = previousScaler?.(fetchMomentOf(row)) ?? 1;
    if (scale === 1 || !Number.isFinite(row.usedPercent)) return row;
    const usedPercent = row.usedPercent * scale;
    return { ...row, usedPercent, remainingPercent: 100 - usedPercent };
  });
}

// The share of the allowance a reading shows as used, from whichever of its
// two figures is present, kept within 0 to 100.
/** @param {Reading} row */
function usedPercentOf(row) {
  return Math.min(100, Math.max(0, Number.isFinite(row.usedPercent) ? row.usedPercent : 100 - row.remainingPercent));
}

/** @param {Reading} row */
function providerBacked(row) {
  const provenance = String(row?.provenance || 'official');
  return isOfficialProvenance(provenance);
}

// A provider-backed replenishment can arrive one reading before its scheduled
// reset timestamp is updated. Only treat a large drop all the way back to the
// near-zero floor as a new allowance cycle; smaller backwards moves remain
// rounding jitter and locally derived corrections remain in their old cycle.
/**
 * @param {Reading} previousRow
 * @param {Reading} row
 */
function clearAllowanceRebase(previousRow, row) {
  if (!providerBacked(row)) return false;
  const before = usedPercentOf(previousRow);
  const after = usedPercentOf(row);
  return before - after >= REPLENISHED_MIN_DROP_POINTS && after <= REPLENISHED_MAX_USED_PERCENT;
}

// Claude Code redraws its status line with the limits from the session's last
// request, so an unchanged status-line reading restates old evidence rather
// than confirming that nothing was used since: another session, the desktop
// app or the web may have spent allowance meanwhile. Such a repeat must not
// become the lower bound that localises the next increase, or a rise first
// seen by a fresh read just after the active hours end is filed entirely as
// late-night use and projected across every remaining night.
/** @param {{ provenance?: string | null }} row */
function restatesSessionLimits(row) {
  return row.provenance === 'official-statusline';
}

// When one reading's figure was fetched, as far as that reading alone can
// say: a provider read's own time, or a status-line reading's recorded fetch.
// A percentage is a share of the allowance in force then, not at a redraw
// that came after a recorded allowance change.
/** @param {ReadingLike} row */
function fetchMomentOf(row) {
  const parsed = normaliseObservation(row);
  if (!restatesSessionLimits(parsed)) return parsed.observedAt;
  const bound = Number.isFinite(parsed.fetchedAfter) ? parsed.fetchedAfter : parsed.seenSince;
  return Number.isFinite(bound) ? Math.min(/** @type {number} */ (bound), parsed.observedAt) : parsed.observedAt;
}

// When a rise in a status-line figure was fetched, as late as needed to fall
// after the interval it closes began: its fetch's lower bound, else its
// session's first redraw of it, else the redraw itself. A read is its own time.
/**
 * @param {Reading} row
 * @param {number} startMs
 */
function riseMomentOf(row, startMs) {
  if (!restatesSessionLimits(row)) return row.observedAt;
  // A missing time is null, which the finite test below passes over.
  for (const at of /** @type {number[]} */ ([row.fetchedAfter, row.seenSince])) {
    if (Number.isFinite(at) && at > startMs && at < row.observedAt) return at;
  }
  return row.observedAt;
}

// The moment each reading's value is evidence of, for readings in time order.
// A status-line reading carries the limits its session last fetched, so the
// collector dates it by that fetch where it can; the redraw that recorded it
// proves nothing newer. An undated redraw (its session was first seen with
// limits in hand) can be no newer than its session's first redraw of the
// same limits (`seenSince`), so it takes that time: an idle session must not
// renew its evidence every minute. A reading from a helper that did not record
// sessions has neither and cannot be told from another session's, so it
// takes the first such reading of its window that showed the same figure:
// two idle sessions redrawing different figures in turn renew neither. A
// provider read stands for itself.
// `known` asks instead how current each figure is known to be, which decides
// whether it is fresh. A first redraw or first showing only bounds an undated
// fetch from above: the limits may have been fetched at any point in the
// window they show, so the figure is known only from that window's start.
// A figure shown before an early replenishment belongs to the allowance it
// replaced, even where the reset timestamp is unchanged.
// Given the recorded `allowanceChanges` (with `sourceId` and `nowMs`, as for
// `withoutStaleRestatements`), figures are compared in the allowance in force
// now: after a fourfold upgrade a read of 40% shows the same use as a later
// 10%, and a read of 10% does not.
/**
 * @param {ReadingLike[]} rows
 * @param {{ known?: boolean, nowMs?: number, allowanceChanges?: AllowanceChange[] | null, sourceId?: string }} [options]
 */
function evidenceTimes(rows, { known = false, nowMs, allowanceChanges, sourceId } = {}) {
  const parsed = rescaleObservations(rows.map(normaliseObservation), { allowanceChanges, now: nowMs, sourceId });
  /** @type {{ resetsAt: number, used: number, from: number }[]} */
  let firstShown = [];
  return parsed.map((row, index) => {
    if (index > 0 && replenishedWithin(parsed[index - 1], row)) {
      firstShown = firstShown.filter((entry) => Math.abs(entry.resetsAt - row.resetsAt) > RESET_TOLERANCE_MS);
    }
    if (!restatesSessionLimits(row)) return row.observedAt;
    if (Number.isFinite(row.fetchedAfter)) return Math.min(/** @type {number} */ (row.fetchedAfter), row.observedAt);
    let placed;
    if (Number.isFinite(row.seenSince)) placed = Math.min(/** @type {number} */ (row.seenSince), row.observedAt);
    else {
      const used = usedPercentOf(row);
      let first = firstShown.find((entry) => Math.abs(entry.resetsAt - row.resetsAt) <= RESET_TOLERANCE_MS
        && Math.abs(entry.used - used) <= STALE_RESTATEMENT_MARGIN);
      if (!first) {
        first = { resetsAt: row.resetsAt, used, from: row.observedAt };
        firstShown.push(first);
      }
      placed = first.from;
    }
    if (!known) return placed;
    // A window of unknown length is no longer than a reset may lie ahead.
    const windowMs = /** @type {number} */ (row.windowMinutes) > 0 ? /** @type {number} */ (row.windowMinutes) * MINUTE_MS : MAX_QUOTA_RESET_AHEAD_MS;
    return Math.min((Number.isFinite(row.resetsAt) ? row.resetsAt : placed) - windowMs, placed);
  });
}

// An early replenishment between two readings of a window whose reset
// timestamp did not move: a new allowance, as `clusterByWindow` reads it.
// Only a read or a dated fetch shows one; an undated drop may be an idle
// session restating an older figure.
/**
 * @param {Reading} previous
 * @param {Reading} row
 */
function replenishedWithin(previous, row) {
  return (!restatesSessionLimits(row) || Number.isFinite(row.fetchedAfter))
    && Math.abs(row.resetsAt - previous.resetsAt) <= RESET_TOLERANCE_MS && clearAllowanceRebase(previous, row);
}

// When the latest reading's value was last known to hold: the newest evidence
// among the readings of its window that show the same value. An idle session
// redrawing a value it fetched hours ago is only as current as that fetch,
// unless a newer read agrees with it. The same figure from before an early
// replenishment is no evidence for the allowance that replaced it. Readings
// must be in time order. Options as for `evidenceTimes`.
/**
 * @param {ReadingLike[]} rows
 * @param {{ known?: boolean, nowMs?: number, allowanceChanges?: AllowanceChange[] | null, sourceId?: string }} [options]
 */
function latestEvidenceAt(rows, { known = false, nowMs, allowanceChanges, sourceId } = {}) {
  const parsed = rescaleObservations(rows.map(normaliseObservation), { allowanceChanges, now: nowMs, sourceId });
  const current = parsed.at(-1);
  if (!current) return null;
  const times = evidenceTimes(parsed, { known });
  let start = parsed.length - 1;
  while (start > 0 && !replenishedWithin(parsed[start - 1], parsed[start])) start -= 1;
  // One time for each reading, and there is at least one reading.
  let at = /** @type {number} */ (times.at(-1));
  for (let index = start; index < parsed.length; index += 1) {
    const row = parsed[index];
    if (Math.abs(row.resetsAt - current.resetsAt) <= RESET_TOLERANCE_MS
      && Math.abs(usedPercentOf(row) - usedPercentOf(current)) <= STALE_RESTATEMENT_MARGIN) {
      at = Math.max(at, times[index]);
    }
  }
  return Math.min(at, current.observedAt);
}

// The least an undated lower reading waits for the provider's next read: two
// refreshes, and never less than two hours.
/** @param {{ refreshIntervalMinutes?: number }} settings */
function freshReadGraceFor(settings) {
  const minutes = Number(settings.refreshIntervalMinutes);
  return Math.max(FRESH_READ_GRACE_MS, minutes > 0 ? FRESH_READ_GRACE_REFRESHES * minutes * MINUTE_MS : 0);
}

// A status-line reading lower than newer evidence for the same reset is either
// a session restating limits it fetched earlier or the first sign of an early
// replenishment. Left in, stale restatements read as a replenishment followed
// by the same usage spent again: one 12% rise was learned eight times over as
// late-night use, and an idle session's 1% replaced a 13% provider read on the
// card until the next Refresh.
// A dated reading is judged by its fetch. Fetched after the newest evidence,
// it is the newest evidence, a drop included, so an early replenishment a
// working session sees reaches the card at once. Fetched before, it stands
// only where it agrees with what is known since. When the two fetches cannot
// be ordered, a higher value is the later use and a lower one is held back,
// and a later reset window is newer than the one it replaced.
// An undated reading (from a helper that did not record sessions, or a
// session first seen with limits in hand) cannot be ordered against the
// newest evidence, whether a provider read or a dated session's fetch. A
// lower one waits for the provider's next read to confirm or contradict it,
// and is believed without one only once that evidence is past the window's
// freshness limit, when the card already calls it out of date. So does one
// showing an earlier window than a read or a dated fetch: it may restate the
// window an early replenishment replaced as well as show a corrected reset.
// Readings must be in time order; readings before any evidence are kept
// because nothing yet shows them to be stale.
// Given the recorded `allowanceChanges` (and the `sourceId` for rows that do
// not name it), readings are compared in the allowance in force now, as the
// forecast compares them: after a fourfold upgrade a read of 40% is today's
// 10%, so a later 11% is newer use, not a restatement. The rows kept come back
// as given, so a caller that forecasts from them rescales them only once.
/**
 * @template {ReadingLike} [T=any] Rows of no declared type come back the same way.
 * @param {T[]} rows
 * @param {{ nowMs?: number, freshReadGraceMs?: number, allowanceChanges?: AllowanceChange[] | null, sourceId?: string }} [options]
 * @returns {T[]} The readings kept, as they were given.
 */
function withoutStaleRestatements(rows, { nowMs = Date.now(), freshReadGraceMs = FRESH_READ_GRACE_MS, allowanceChanges, sourceId } = {}) {
  const parsed = rescaleObservations(rows.map(normaliseObservation), { allowanceChanges, now: nowMs, sourceId });
  /** @type {(Reading | null)[]} The next provider read after each reading, if any. */
  const nextFresh = Array.from({ length: parsed.length }, () => null);
  for (let index = parsed.length - 1, next = null; index >= 0; index -= 1) {
    nextFresh[index] = next;
    if (!restatesSessionLimits(parsed[index])) next = parsed[index];
  }
  // The newest evidence so far, and the span its fetch is known to lie in.
  /** @type {{ reading: Reading, from: number, to: number } | null} */
  let newest = null;
  // Every redraw of one fetch carries its session's first redraw of it
  // (`seenSince`), which bounds the fetch from above. A dated reading without
  // one falls back to the first reading here that carries the same date.
  /** @type {Map<number | null, number>} */
  const firstCarrier = new Map();
  return rows.filter((row, index) => {
    const reading = parsed[index];
    const used = usedPercentOf(reading);
    if (!restatesSessionLimits(reading)) {
      newest = { reading, from: reading.observedAt, to: reading.observedAt };
      return true;
    }
    /** @param {Reading | null} other */
    const sameReset = (other) => other && Math.abs(other.resetsAt - reading.resetsAt) <= RESET_TOLERANCE_MS;
    // This reading's window had already ended when it was drawn, and newer
    // evidence shows the window after it.
    /** @param {Reading} other */
    const endedBefore = (other) => reading.resetsAt < other.resetsAt && reading.resetsAt <= reading.observedAt;
    // Held back until the provider's next read confirms or contradicts it, or
    // until the newest evidence is past the window's freshness limit.
    /** @param {(after: Reading) => unknown} confirms */
    const confirmedLater = (confirms) => {
      const after = nextFresh[index];
      if (after) return confirms(after);
      const graceMs = Math.max(freshReadGraceMs, freshnessLimitHours({ windowMinutes: reading.windowMinutes }) * HOUR_MS);
      // Only asked once a newer reading exists to answer to.
      return nowMs - /** @type {NonNullable<typeof newest>} */ (newest).to > graceMs;
    };
    if (Number.isFinite(reading.fetchedAfter)) {
      if (!firstCarrier.has(reading.fetchedAfter)) firstCarrier.set(reading.fetchedAfter, reading.observedAt);
      // The first carrier of this fetch was recorded on the line above at the latest.
      const own = { reading, from: /** @type {number} */ (reading.fetchedAfter),
        to: Number.isFinite(reading.seenSince) ? Math.min(/** @type {number} */ (reading.seenSince), reading.observedAt) : /** @type {number} */ (firstCarrier.get(reading.fetchedAfter)) };
      if (!newest || own.from > newest.to) {
        newest = own;
        return true;
      }
      const newestUsed = usedPercentOf(newest.reading);
      if (own.to < newest.from) return sameReset(newest.reading) && Math.abs(used - newestUsed) <= STALE_RESTATEMENT_MARGIN;
      // Around a reset, a redraw can still carry the window that just ended;
      // of two fetches from around the same time, the later window is newer.
      // An earlier one still ahead may be a corrected reset or the window an
      // early replenishment replaced, so it waits for a read as undated ones do.
      if (!sameReset(newest.reading)) {
        if (endedBefore(newest.reading)) return false;
        if (reading.resetsAt < newest.reading.resetsAt) return confirmedLater(sameReset);
        newest = own;
        return true;
      }
      if (used > newestUsed + STALE_RESTATEMENT_MARGIN) {
        newest = own;
        return true;
      }
      if (used < newestUsed - STALE_RESTATEMENT_MARGIN) return false;
      // An agreeing fetch from around the same time shows the value held as
      // late as either fetch, so a drop must be newer than both to count.
      newest = { reading: newest.reading, from: Math.max(newest.from, own.from), to: Math.max(newest.to, own.to) };
      return true;
    }
    // Undated: its fetch cannot be ordered against the newest evidence, a
    // provider read or a dated session's fetch alike, so around a reset only
    // a later window gets through, as for fetches that cannot be ordered. A
    // later window or a higher figure is still the later use: it becomes the
    // high-water mark a lower reading must answer to. Its fetch is known only
    // to be no later than its session's first redraw of it.
    // Read below only where `newest` is set.
    const newestUsed = /** @type {number} */ (newest && usedPercentOf(newest.reading));
    const undated = () => ({ reading, from: -Infinity,
      to: Number.isFinite(reading.seenSince) ? Math.min(/** @type {number} */ (reading.seenSince), reading.observedAt) : reading.observedAt });
    if (newest && !sameReset(newest.reading)) {
      if (endedBefore(newest.reading)) return false;
      // Two undated readings cannot be ordered either, so the later redraw stands.
      if (reading.resetsAt < newest.reading.resetsAt && Number.isFinite(newest.from)) return confirmedLater(sameReset);
      newest = undated();
      return true;
    }
    if (!newest || used > newestUsed + STALE_RESTATEMENT_MARGIN) {
      newest = undated();
      return true;
    }
    if (used >= newestUsed - STALE_RESTATEMENT_MARGIN) return true;
    return confirmedLater((after) => sameReset(after) && usedPercentOf(after) < newestUsed - STALE_RESTATEMENT_MARGIN);
  });
}

module.exports = {
  RESET_TOLERANCE_MS,
  clearAllowanceRebase, evidenceTimes, fetchMomentOf, freshReadGraceFor, latestEvidenceAt, normaliseObservation,
  prepareObservation, rescaleObservations, restatesSessionLimits, riseMomentOf, usedPercentOf, withoutStaleRestatements,
};
