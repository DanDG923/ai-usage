'use strict';

const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { freshnessLimitHours } = require('./dashboard-decision.cjs');
const { OFFICIAL_PROVENANCES, isOfficialProvenance } = require('./quota-provenance.mjs');
const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS, validQuotaTime } = require('./quota-time.cjs');

/** @typedef {import('./types').Reading} Reading */
/** @typedef {import('./types').ReadingLike} ReadingLike */
/** @typedef {import('./types').Schedule} Schedule */
/** @typedef {import('./types').Point} Point */
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
 * Whether a span of time touches an ignored day.
 * @typedef {(startMs: number, endMs: number) => boolean} Excluded
 */

/**
 * The readings of one allowance window, in time order.
 * @template {Reading} [T=Reading]
 * @typedef {object} WindowCluster
 * @property {number} resetsAt The reset its latest reading names.
 * @property {T[]} rows Never empty.
 * @property {number | null} observedResetAt When the window was seen to begin, where an early replenishment showed it.
 */

/**
 * One window's elapsed hours and usage, divided between scheduled and
 * off-schedule time.
 * @typedef {{ elapsedHours: number, activeHours: number, offHours: number, activeUsed: number, offUsed: number }} WindowSplit
 */

/** @typedef {'active' | 'off-schedule'} Phase */

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

/** @typedef {ReturnType<typeof learnForecast>} LearnedModel */

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
 * The evidence is read-only so that a test of it, once stored in a constant,
 * still tells the checker it is present.
 * @typedef {ForecastSettings & { readonly evidence?: ReadingEvidence }} ForecastOptions
 */

// On the casts to number in this file: a reading's fetch time, first-seen time
// and window length may be null. Number.isFinite, or a comparison with zero,
// rules null out at run time but does not tell the checker so; where a value
// is cast beside such a test, the test is the reason. Any other cast carries
// its own comment.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RESET_TOLERANCE_MS = 60_000;
const HEAVY_HISTORY_DAYS = 7;
// Readings further apart than this leave the time between them unobserved.
const COVERAGE_GAP_MS = 6 * HOUR_MS;
const EARLY_RESET_DAY_WEIGHT = 0.25;
// Also asked about a reading with no provenance, which is in no set.
/** @type {Set<string | undefined>} */
const RESET_EVIDENCE_PROVENANCES = new Set(OFFICIAL_PROVENANCES);
const MAX_PROJECTION_MS = MAX_QUOTA_RESET_AHEAD_MS + QUOTA_CLOCK_SKEW_MS;
const MAX_SERIES_POINTS = Math.ceil(MAX_PROJECTION_MS / HOUR_MS) + 1;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

/** @param {number} cursor */
function nextLocalHour(cursor) {
  const date = new Date(cursor);
  // Advance elapsed time to the next local hour boundary. Arithmetic on local
  // minutes also visits the repeated hour at a DST fallback instead of skipping
  // it with Date.setHours, and supports half/quarter-hour UTC offsets.
  return cursor + HOUR_MS - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds();
}

/**
 * @param {number} expectedRemaining
 * @param {number} heavyRemaining
 * @param {number} paceRatio
 * @param {number} paceRiskThreshold
 * @param {number} watchRemainingThreshold
 * @returns {import('../src/types').ForecastState}
 */
function forecastState(expectedRemaining, heavyRemaining, paceRatio, paceRiskThreshold, watchRemainingThreshold) {
  return expectedRemaining <= 0 ? 'critical'
    : heavyRemaining <= 0 || paceRatio > paceRiskThreshold ? 'risk'
      : expectedRemaining < watchRemainingThreshold || heavyRemaining < watchRemainingThreshold
        || paceRatio > paceRiskThreshold * 0.75 ? 'watch' : 'safe';
}

/**
 * @param {number[]} values
 * @param {number} fraction
 */
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** @param {{ value: number, weight: number }[]} entries */
function weightedMean(entries) {
  let numerator = 0;
  let denominator = 0;
  for (const entry of entries) {
    numerator += entry.value * entry.weight;
    denominator += entry.weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * @param {Date} date
 * @param {Schedule} schedule
 */
function isActiveHour(date, schedule) {
  if (!schedule.activeDays.includes(date.getDay())) return false;
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= schedule.startHour && hour < schedule.endHour;
}

/** @param {Date} date */
function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Exclusions describe local calendar days, including the real 23/25-hour DST
// boundaries. Quota deltas cover [before, after), so a midnight reading can
// still close the preceding clean day. Never infer where a delta crossing an
// excluded day was spent: discard that interval and resume at its next reading.
/**
 * @param {string[]} [dates]
 * @returns {Excluded}
 */
function exclusionLookup(dates = []) {
  const ranges = (Array.isArray(dates) ? dates : []).flatMap((day) => {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const [year, month, date] = day.split('-').map(Number);
    const start = new Date(year, month - 1, date);
    if (localDayKey(start) !== day) return [];
    return [{ start: start.getTime(), end: new Date(year, month - 1, date + 1).getTime() }];
  });
  return (start, end) => end > start && ranges.some((range) => range.start < end && range.end > start);
}

/**
 * @param {number} startMs
 * @param {number} endMs
 * @param {Schedule} schedule
 */
function activeHoursBetween(startMs, endMs, schedule) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    if (isActiveHour(new Date((cursor + next) / 2), schedule)) total += (next - cursor) / HOUR_MS;
    cursor = next;
  }
  return total;
}

/**
 * @param {string} day
 * @param {Schedule} schedule
 */
function offScheduleHoursForLocalDay(day, schedule) {
  const parts = String(day).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return 0;
  const [year, month, date] = parts;
  const startMs = new Date(year, month - 1, date).getTime();
  const endMs = new Date(year, month - 1, date + 1).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || localDayKey(new Date(startMs)) !== day) return 0;
  const elapsedHours = (endMs - startMs) / HOUR_MS;
  return Math.max(0, elapsedHours - activeHoursBetween(startMs, endMs, schedule));
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
  return before - after >= 5 && after <= 2;
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
  const jitterAllowance = RESET_TOLERANCE_MS + gapMs * 0.01;
  const resetShift = row.resetsAt - previousRow.resetsAt;
  if (Math.abs(resetShift) <= jitterAllowance) return true;
  return Math.abs(resetShift - gapMs) <= jitterAllowance
    && Math.abs(usedPercentOf(row) - usedPercentOf(previousRow)) <= 0.5;
}

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
        && Math.abs(row.resetsAt - previous.resetsAt) <= RESET_TOLERANCE_MS + gapMs * 0.01;
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

// Average allowance consumption per scheduled active hour across one window.
// The provider's used-percentage covers the whole window, so when the window
// length is known the denominator starts at the true window start.
/** @param {Reading} row */
function usedPercentOf(row) {
  return clamp(Number.isFinite(row.usedPercent) ? row.usedPercent : 100 - row.remainingPercent, 0, 100);
}

/**
 * @param {Reading[]} rows At least one reading.
 * @param {Schedule} schedule
 * @param {number | null} [observedResetAt]
 * @param {((startMs: number, endMs: number) => boolean) | null} [excluded]
 * @param {Map<string, number> | null} [dayWeights]
 */
function windowPaceOf(rows, schedule, observedResetAt = null, nowMs = Date.now(), excluded = null, dayWeights = null) {
  // Callers pass a window that has readings.
  const last = /** @type {Reading} */ (rows.at(-1));
  const usedEnd = usedPercentOf(last);
  const windowMinutes = rows.findLast((row) => Number.isFinite(row.windowMinutes) && /** @type {number} */ (row.windowMinutes) > 0)?.windowMinutes;
  const startMs = Number.isFinite(observedResetAt)
    ? /** @type {number} */ (observedResetAt)
    : windowMinutes ? last.resetsAt - windowMinutes * 60_000 : rows[0].observedAt;
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
  return evidenceActiveHours >= 1 && split.activeHours > 0
    ? { pace: split.activeUsed / split.activeHours, activeHours: split.activeHours, evidenceActiveHours } : null;
}

// Split one window's usage between scheduled and off-schedule hours. Usage
// already localised by observation intervals belongs to its measured phase.
// The remainder happened before the first useful reading, so the observed
// phase mix cannot tell us where it occurred; distribute that unknown
// remainder by elapsed exposure instead, otherwise one +1 just after the
// active-hours boundary can assign an entire 13% window burn to off-schedule use.
/**
 * @param {Reading[]} rows
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} used
 * @param {((startMs: number, endMs: number) => boolean) | null} [excluded]
 * @param {Map<string, number> | null} [dayWeights]
 * @returns {WindowSplit}
 */
function splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used, excluded = null, dayWeights = null) {
  if (excluded?.(startMs, endMs)) {
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
      const split = splitWindowUsage(segment, schedule, nowMs, first.observedAt, last.observedAt, cleanUsed, null, dayWeights);
      // The keys of `result` are the fields of a split and no others.
      for (const key of /** @type {(keyof WindowSplit)[]} */ (Object.keys(result))) result[key] += split[key];
    }
    return result;
  }
  if (dayWeights?.size && exclusionLookup([...dayWeights.keys()])(startMs, endMs)) {
    // Change the weight of localised usage and its measured exposure together.
    // Earlier cumulative usage cannot be assigned to this day: preserve its
    // original contribution and exposure. In particular, an initial 0% reading
    // proves the earlier window was quiet; dropping those hours inflates pace.
    const result = splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used);
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

// Parsing the two ISO timestamps was two thirds of a forecast's CPU time,
// because every pass (ordinary learning, the early-reset check, and the
// re-weighted learning) normalised the same raw rows again. A row is marked
// once it is normalised, and the mark survives object spread, so the later
// passes and the sample derivation inside them return it unchanged.
const NORMALISED = Symbol('normalised');
const PREPARED = Symbol('prepared');
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
 * @returns {Reading & { [NORMALISED]?: true }}
 */
function normaliseObservation(row) {
  // Only what this function returns carries the mark.
  if (row[NORMALISED]) return /** @type {Reading} */ (row);
  if (row[PREPARED]) return row[PREPARED];
  const windowMinutes = row.windowMinutes ?? row.window_minutes;
  const fetchedAfter = row.fetchedAfter ?? row.fetched_after;
  const seenSince = row.seenSince ?? row.seen_since;
  return {
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
    usedPercent: Number(row.usedPercent ?? row.used_percent),
    remainingPercent: Number(row.remainingPercent ?? row.remaining_percent),
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
  };
}

// Readings before a recorded allowance change are a share of a different
// allowance. Express them in the current one so the step at the change is
// not learned as a burst and the earlier pace is not understated. The scaled
// copy keeps its normalised mark, so every later pass takes it as it is.
/**
 * @param {Reading[]} rows
 * @param {Pick<ForecastOptions, 'allowanceChanges' | 'now' | 'sourceId' | 'bucketId'>} options
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
  if (delta < 0 || delta > 70) return;
  const ageDays = Math.max(0, (nowMs - after.observedAt) / DAY_MS);
  const provenanceWeight = ['official', 'official-statusline'].includes(after.provenance) ? 1 : 0.65;
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
    if (group.coveredHours <= 0.01 && group.delta <= 0) continue;
    const midpoint = new Date(group.midpointHours / group.coveredHours);
    samples.push({
      rate,
      observedAt: after.observedAt,
      weekday: midpoint.getDay(),
      hour: midpoint.getHours(),
      weight: Math.exp(-ageDays / 28) * provenanceWeight,
      changed: delta > 0,
      rateEligible: delta <= 0 || smoothingHours >= 0.01,
      phase,
      delta: group.delta,
      coveredHours: group.coveredHours,
      dailyDeltas: [...group.dailyDeltas].map(([day, dayDelta]) => ({ day, delta: dayDelta })),
      dailyHours: [...group.dailyHours].map(([day, hours]) => ({ day, hours })),
    });
  }
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
    const windowMs = /** @type {number} */ (row.windowMinutes) > 0 ? /** @type {number} */ (row.windowMinutes) * 60_000 : MAX_QUOTA_RESET_AHEAD_MS;
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
const STALE_RESTATEMENT_MARGIN = 0.5;
const FRESH_READ_GRACE_MS = 2 * HOUR_MS;
// The least an undated lower reading waits for the provider's next read: two
// refreshes, and never less than two hours.
/** @param {{ refreshIntervalMinutes?: number }} settings */
function freshReadGraceFor(settings) {
  const minutes = Number(settings.refreshIntervalMinutes);
  return Math.max(FRESH_READ_GRACE_MS, minutes > 0 ? 2 * minutes * 60_000 : 0);
}
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

/**
 * @param {ReadingLike[]} observations
 * @param {Schedule} schedule
 * @param {number} nowMs
 * @param {string[] | Excluded} [excludedDates] The ignored days, or a lookup already built from them.
 * @returns {LearningSample[]}
 */
function deriveLearningSamples(observations, schedule, nowMs, excludedDates = []) {
  const excluded = typeof excludedDates === 'function' ? excludedDates : exclusionLookup(excludedDates);
  const rows = observations.map(normaliseObservation)
    .filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs)
      && row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && Number.isFinite(row.usedPercent))
    .sort((a, b) => a.observedAt - b.observedAt);
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
      if (latest.observedAt - anchor.observedAt >= HOUR_MS) {
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
    if (!sameWindow || after.usedPercent - anchor.usedPercent > 70) {
      // The quiet span before a reset is learned like the excluded-day
      // restart and the final tail: dropping it leaves only the bursts.
      if (latest.observedAt - anchor.observedAt >= HOUR_MS) {
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
  if (latest.observedAt > anchor.observedAt && latest.observedAt - anchor.observedAt >= HOUR_MS) {
    addIntervalSamples(samples, anchor, latest, schedule, nowMs);
  }
  return samples;
}

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
    const exact = phaseSamples.filter((sample) => sample.weekday === weekday && Math.abs(sample.hour - hour) <= 1);
    const sameHour = phaseSamples.filter((sample) => Math.abs(sample.hour - hour) <= 1);
    const candidates = exact.length >= 2 ? exact : sameHour.length >= 3 ? sameHour : phaseSamples;
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
  const recent = samples.filter((sample) => sample.phase === phase && sample.rateEligible !== false && nowMs - sample.observedAt <= 36 * HOUR_MS);
  if (!recent.length) return 0;
  return contextualRate(recent, fallbackRate, (sample) => Math.exp(-(nowMs - sample.observedAt) / (8 * HOUR_MS)));
}

// Cumulative heavier-than-expected burn is a sum of independent busy-or-quiet
// days: its spread grows with the square root of the horizon, not linearly.
// One busy day is repeated in full; beyond that the busiest learned day is
// not assumed for every remaining day, so a fresh week is not projected as
// seven consecutive peak days. Returns the dampened share of one interval's
// full-rate overage, expressed through elapsed days since the projection
// origin. The origin is the latest reading, shared by the catch-up and future
// segments, so a stale reading projects the same reset balance whenever it is
// viewed instead of restarting the full-strength first day at every refresh.
/**
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} originMs
 */
function heavyOverageShare(fromMs, toMs, originMs) {
  /** @param {number} ms */
  const pace = (ms) => {
    const days = (ms - originMs) / DAY_MS;
    return days <= 1 ? days : Math.sqrt(days);
  };
  const span = (toMs - fromMs) / DAY_MS;
  return span > 0 ? clamp((pace(toMs) - pace(fromMs)) / span, 0, 1) : 1;
}

/**
 * @param {number} expectedStart
 * @param {number} heavyStart
 * @param {number} startMs
 * @param {number} endMs
 * @param {Schedule} schedule
 * @param {LearningSample[]} samples
 * @param {ForecastRates} rates
 */
function buildSeries(expectedStart, heavyStart, startMs, endMs, schedule, samples, rates, originMs = startMs) {
  // Reject unsupported work before allocation. Never turn a distant reset into
  // a shorter, apparently valid forecast (including an already empty allowance).
  const points = Math.ceil(Math.max(0, endMs - startMs) / HOUR_MS) + 1;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || endMs - startMs > MAX_PROJECTION_MS || points > MAX_SERIES_POINTS) return null;
  const expected = [{ at: startMs, remaining: clamp(expectedStart, 0, 100), projected: expectedStart }];
  const heavy = [{ at: startMs, remaining: clamp(heavyStart, 0, 100), projected: heavyStart }];
  const learnedRate = createRateLookup(samples);
  const hasOffScheduleSamples = samples.some((sample) => sample.phase === 'off-schedule');
  let expectedRemaining = expectedStart;
  let heavyRemaining = heavyStart;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    const midpoint = new Date((cursor + next) / 2);
    const phase = isActiveHour(midpoint, schedule) ? 'active' : 'off-schedule';
    const phaseRates = phase === 'active' ? rates.active : rates.offSchedule;
    const hasPhaseEvidence = phase === 'active'
      || hasOffScheduleSamples
      || (Number.isFinite(phaseRates.sustainable) && /** @type {number} */ (phaseRates.sustainable) > 0);
    if (hasPhaseEvidence) {
      const duration = (next - cursor) / HOUR_MS;
      const learned = learnedRate(midpoint, phaseRates.fallback, phase);
      const conditional = learned * (1 - phaseRates.blend.weight) + phaseRates.blend.rate * phaseRates.blend.weight;
      // Conditional rates describe pace while in use; the window anchor keeps
      // the projection tied to how much of the allowance is really being spent
      // per scheduled hour, so bursts are not extrapolated across every hour.
      const expectedRate = Number.isFinite(phaseRates.sustainable)
        ? /** @type {number} */ (phaseRates.sustainable)
        : phaseRates.anchor
          ? phaseRates.anchor.rate * phaseRates.anchor.weight + conditional * (1 - phaseRates.anchor.weight)
          : conditional;
      expectedRemaining -= expectedRate * duration;
      // A few busy days are weak evidence for repeating that pace all week.
      // Start with the usual heavier-use margin and gradually trust the
      // learned daily upper pace as independent historical days accumulate.
      const heavyBaseline = expectedRate * 1.22;
      const heavyRate = heavyBaseline
        + Math.max(0, phaseRates.heavy - heavyBaseline) * phaseRates.heavyWeight;
      heavyRemaining -= expectedRate * duration
        + Math.max(0, heavyRate - expectedRate) * duration * heavyOverageShare(cursor, next, originMs);
    }
    // The displayed value is clamped; the projected value keeps how far past
    // zero the hour ran so the run-out instant can be placed inside the hour.
    expected.push({ at: next, remaining: clamp(expectedRemaining, 0, 100), projected: expectedRemaining });
    heavy.push({ at: next, remaining: clamp(heavyRemaining, 0, 100), projected: heavyRemaining });
    cursor = next;
  }
  return { expected, heavy };
}

/**
 * @param {{ expired?: boolean, observed?: import('../src/types').Point[], staleHours?: number }} [options]
 * @returns {import('../src/types').Forecast}
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

// The instant a projected series first touches zero, interpolated inside the
// hour it happens. The displayed series is clamped at zero, which hides how far
// past zero that hour ran; the unclamped `projected` value on the first zero
// sample restores the slope. A series without it snaps to the end of the hour.
/** @param {Point[]} series */
function exhaustionTime(series) {
  for (let index = 1; index < series.length; index += 1) {
    const point = series[index];
    if (point.remaining > 0) continue;
    const previous = series[index - 1];
    if (previous.remaining <= 0) return new Date(previous.at).toISOString();
    const overshoot = Number.isFinite(point.projected) ? Math.min(/** @type {number} */ (point.projected), point.remaining) : point.remaining;
    const fraction = previous.remaining / Math.max(previous.remaining - overshoot, Number.EPSILON);
    return new Date(previous.at + (point.at - previous.at) * clamp(fraction, 0, 1)).toISOString();
  }
  return null;
}

/**
 * @param {object} input
 * @param {Reading[]} input.normalised
 * @param {Reading} input.current
 * @param {WindowCluster} input.currentCluster
 * @param {WindowCluster[]} input.clusters
 * @param {Schedule} input.schedule
 * @param {number} input.nowMs
 * @param {Excluded} input.excluded
 * @param {Map<string, number> | null} input.dayWeights
 * @param {number} input.usedNow
 * @param {number} input.resetMs
 * @param {number} input.fallbackRate
 * @param {number} input.evidenceMs
 */
function learnForecast({ normalised, current, currentCluster, clusters, schedule, nowMs, excluded, dayWeights, usedNow, resetMs, fallbackRate, evidenceMs }) {
  const samples = deriveLearningSamples(normalised, schedule, nowMs, excluded).map((sample) => {
    if (!dayWeights?.size) return sample;
    const hours = sample.dailyHours.reduce((sum, entry) => sum + entry.hours, 0);
    const weightedHours = sample.dailyHours.reduce((sum, entry) => sum + entry.hours * (dayWeights.get(entry.day) ?? 1), 0);
    const influence = hours > 0 ? weightedHours / hours : 1;
    return { ...sample, weight: sample.weight * influence, influence,
      dailyDeltas: sample.dailyDeltas.map((entry) => ({ ...entry, delta: entry.delta * (dayWeights.get(entry.day) ?? 1) })) };
  });
  const modelSamples = samples.filter((sample) => sample.rateEligible !== false);

  // Window anchor: the provider's used-percentage covers the whole window, so
  // usage divided by the window's elapsed active hours is the strongest signal
  // of sustainable pace. Evidence ends when the current figure was fetched,
  // never at "now" or at an idle redraw that came after it.
  const inWindow = currentCluster.rows;
  const windowMinutes = inWindow.findLast((row) => Number.isFinite(row.windowMinutes) && /** @type {number} */ (row.windowMinutes) > 0)?.windowMinutes;
  const anchorStartMs = Number.isFinite(currentCluster.observedResetAt)
    ? /** @type {number} */ (currentCluster.observedResetAt)
    : windowMinutes ? resetMs - windowMinutes * 60_000 : inWindow[0].observedAt;
  // Backward jitter on the latest reading (e.g. 5.0% → 4.9%) must degrade the
  // anchor to "pace ≈ 0", not discard the whole window's evidence as invalid.
  const anchorUsed = windowMinutes ? usedNow : Math.max(0, usedNow - usedPercentOf(inWindow[0]));
  const {
    activeHours: anchorActiveHours, offHours: anchorOffHours, activeUsed: activeAnchorUsed, offUsed: offAnchorUsed,
  } = splitWindowUsage(inWindow, schedule, nowMs, anchorStartMs, evidenceMs, anchorUsed, excluded, dayWeights);
  const windowPace = anchorActiveHours >= 1 ? activeAnchorUsed / anchorActiveHours : null;
  const offWindowPace = anchorOffHours >= 1 ? offAnchorUsed / anchorOffHours : null;
  // After a reset the fresh window has no history of its own, so the most
  // recent prior window's average pace carries forward as weaker evidence
  // instead of letting while-working burst rates run unchecked until reset.
  // Only the most recent qualifying window is used, so scan backwards and
  // stop there rather than pacing every historical cluster first.
  /** @type {{ pace: number, activeHours: number, evidenceActiveHours: number } | null} */
  let priorEvidence = null;
  for (let index = clusters.length - 1; index >= 0 && !priorEvidence; index -= 1) {
    const entry = clusters[index];
    if (entry === currentCluster || entry.rows.length < 2) continue;
    // A cluster is never empty. A window of unknown length fails the first test.
    if (/** @type {{ windowMinutes: number }} */ (entry.rows.at(-1)).windowMinutes > 0 && /** @type {{ windowMinutes: number }} */ (entry.rows.at(-1)).windowMinutes < 360) continue;
    const pace = windowPaceOf(entry.rows, schedule, entry.observedResetAt, nowMs, excluded, dayWeights);
    if (pace && pace.evidenceActiveHours >= 6) priorEvidence = pace;
  }
  const windowWeight = windowPace == null ? 0 : clamp(anchorActiveHours / 30, 0, 0.9);
  const priorWeight = priorEvidence ? clamp(priorEvidence.activeHours / 30, 0, 0.85) * (1 - windowWeight) : 0;
  const anchorWeight = clamp(windowWeight + priorWeight, 0, 0.9);
  const anchor = anchorWeight > 0
    ? {
      rate: ((windowPace ?? 0) * windowWeight + (priorEvidence?.pace ?? 0) * priorWeight) / (windowWeight + priorWeight),
      weight: anchorWeight,
    }
    : null;
  const offAnchor = offWindowPace == null ? null : { rate: offWindowPace, weight: clamp(anchorOffHours / 30, 0, 0.9) };
  const activeSamples = modelSamples.filter((sample) => sample.phase === 'active');
  const offScheduleSamples = modelSamples.filter((sample) => sample.phase === 'off-schedule');
  /**
   * @param {LearningSample[]} rows
   * @param {number} fallback
   */
  const mean = (rows, fallback) => rows.length
    ? weightedMean(rows.map((sample) => ({ value: sample.rate, weight: sample.weight * sample.coveredHours })))
    : fallback;
  const globalRate = mean(activeSamples, fallbackRate);
  const offScheduleRate = mean(offScheduleSamples, 0);
  const recent = recentRate(samples, nowMs, 'active', globalRate);
  const offScheduleRecent = recentRate(samples, nowMs, 'off-schedule', offScheduleRate);
  const recentWeight = activeSamples.length < 3 ? 0 : clamp(activeSamples.filter((sample) => nowMs - sample.observedAt <= 36 * HOUR_MS).length / 10, 0.1, 0.38);
  const offScheduleRecentWeight = offScheduleSamples.length < 3 ? 0 : clamp(offScheduleSamples.filter((sample) => nowMs - sample.observedAt <= 36 * HOUR_MS).length / 10, 0.1, 0.38);
  // Heavy scenario: the busy end of learned *daily* usage, never of momentary
  // burst rates — a keyboard burst is not a pace anyone sustains for a week.
  /** @type {Map<string, number>} */
  const activeDayUsage = new Map();
  /** @type {Map<string, number>} */
  const offDayUsage = new Map();
  for (const sample of samples) {
    const target = sample.phase === 'active' ? activeDayUsage : offDayUsage;
    for (const entry of sample.dailyDeltas || []) target.set(entry.day, (target.get(entry.day) || 0) + entry.delta);
  }
  const activeDailyTotals = [...activeDayUsage.values()];
  const offDailyTotals = [...offDayUsage.values()];
  const sampleDays = new Set(samples.flatMap((sample) => (sample.dailyDeltas || []).map((entry) => entry.day)));
  // A change sample allocates only its last poll interval, so a day polled
  // throughout with no use would never be learned. Consecutive readings no
  // more than COVERAGE_GAP_MS apart show where such a quiet day was observed,
  // and it supplies only the off-schedule hours they cover: a brief pair of
  // polls is not a fully observed day. The latest observed day is still
  // partial and counts only once a sample learns it. Only an interval ending
  // in a fresh read shows nothing was used across it: a status-line repeat
  // restates what a session fetched earlier while other sessions, the desktop
  // app or the web may have been spending.
  const partialDay = localDayKey(new Date(current.observedAt));
  /** @type {Map<string, number>} */
  const quietOffHours = new Map();
  const covered = normalised.filter((row) => row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && !excluded(row.observedAt, row.observedAt + 1));
  for (let index = 1; index < covered.length; index += 1) {
    if (restatesSessionLimits(covered[index])) continue;
    const before = covered[index - 1].observedAt;
    const after = covered[index].observedAt;
    if (after - before > COVERAGE_GAP_MS) continue;
    let cursor = before;
    while (cursor < after) {
      const next = Math.min(after, nextLocalHour(cursor));
      const midpoint = new Date((cursor + next) / 2);
      const day = localDayKey(midpoint);
      if (day !== partialDay && !sampleDays.has(day) && !isActiveHour(midpoint, schedule)) {
        quietOffHours.set(day, (quietOffHours.get(day) || 0) + (next - cursor) / HOUR_MS);
      }
      cursor = next;
    }
  }
  const scheduleHoursPerDay = Math.max(1, schedule.endHour - schedule.startHour);
  // Off-schedule samples describe the pace of a discrete event, not the
  // probability that the user will be active throughout every future night.
  // Project a duty-cycled rate instead: the stronger of this window's usage
  // across all elapsed off-hours and the average off-schedule daily budget.
  // Each learned local day supplies its real off-schedule capacity: an
  // inactive day has all 24 hours, and a DST boundary may have 23 or 25.
  const offCapacityHours = [...sampleDays]
    .reduce((sum, day) => sum + offScheduleHoursForLocalDay(day, schedule) * (dayWeights?.get(day) ?? 1), 0)
    + [...quietOffHours].reduce((sum, [day, hours]) => sum + hours * (dayWeights?.get(day) ?? 1), 0);
  const offDailyPace = offCapacityHours > 0
    ? offDailyTotals.reduce((sum, value) => sum + value, 0) / offCapacityHours
    : 0;
  const offDailyRates = [...offDayUsage]
    .map(([day, value]) => {
      const hours = offScheduleHoursForLocalDay(day, schedule) * (dayWeights?.get(day) ?? 1);
      return hours > 0 ? value / hours : null;
    })
    .filter(Number.isFinite);
  // This window's own off-schedule pace is a burst until its elapsed off-hours
  // cover about one full night: a fresh window's first late-evening surge must
  // not be extrapolated across every remaining night. Trust it in proportion
  // to that exposure and never fall below the learned daily off budget.
  const offWindowWeight = offWindowPace == null ? 0 : clamp(anchorOffHours / 10, 0, 1);
  const sustainableOffSchedulePace = offWindowPace == null
    ? offDailyPace
    : Math.max(offDailyPace, offDailyPace + (offWindowPace - offDailyPace) * offWindowWeight);
  const heavyActive = activeDailyTotals.length >= 2
    ? percentile(activeDailyTotals, 0.82) / scheduleHoursPerDay
    : anchor ? anchor.rate * 1.6 : fallbackRate * 1.55;
  const heavyOffSchedule = offDailyRates.length >= 2
    // The filter above left only the finite rates.
    ? percentile(/** @type {number[]} */ (offDailyRates), 0.82)
    : sustainableOffSchedulePace * 1.6;
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

  return { samples, modelSamples, rates, sustainableOffSchedulePace, recent, globalRate, anchor, windowPace };
}

/** @typedef {import('../src/types').Forecast} Forecast */
/** @typedef {import('../src/types').ForecastState} ForecastState */

/**
 * @param {ReadingLike[]} observations
 * @param {ForecastOptions} [options]
 * @param {Map<string, number> | null} [dayWeights]
 * @returns {Forecast}
 */
function forecastQuotaWithLearning(observations, options = {}, dayWeights = null) {
  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();
  if (!Number.isFinite(nowMs)) return unknownForecast();
  const schedule = {
    activeDays: options.schedule?.activeDays ?? [1, 2, 3, 4, 5, 6, 0],
    startHour: options.schedule?.startHour ?? 8,
    endHour: options.schedule?.endHour ?? 22,
  };
  const fallbackRate = Number(options.fallbackRate ?? 0.35);
  const paceRiskThreshold = Number(options.paceRiskThreshold ?? 1.2);
  const hardLimitThreshold = Number(options.hardLimitThreshold ?? 90);
  // Budget mode: the share of the allowance the user wants untouched at reset.
  // It is subtracted from what the safe pace may spend, never from the
  // projection itself — the forecast still says what will happen.
  const reservePercent = clamp(Number(options.reservePercent ?? 0) || 0, 0, 90);
  const excluded = exclusionLookup(options.excludedDates);
  let normalised = observations.map(normaliseObservation)
    .filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs))
    .sort((a, b) => a.observedAt - b.observedAt);
  const current = normalised.at(-1);
  if (!current) return unknownForecast();
  // Keep the latest dormant reading so it still reports expired, but do not
  // traverse ancient rolling windows in learning or active-hour calculations.
  normalised = normalised.filter((row) => row === current || row.observedAt >= nowMs - FORECAST_LOOKBACK_MS);

  const resetMs = current.resetsAt;
  const clusters = clusterByWindow(normalised);
  // A hard reset may briefly retain the previous reset timestamp, so select
  // the latest matching cluster rather than the first historical match.
  // There is a current reading, and the last cluster holds it.
  const currentCluster = /** @type {WindowCluster} */ (clusters.at(-1));
  const displayStart = nowMs - 48 * HOUR_MS;
  const firstVisible = currentCluster.rows.findIndex((row) => row.observedAt >= displayStart);
  const visibleRows = firstVisible < 0 ? currentCluster.rows.slice(-1) : currentCluster.rows.slice(Math.max(0, firstVisible - 1));
  const observed = visibleRows
    .map((row) => ({ at: row.observedAt, remaining: clamp(Number.isFinite(row.remainingPercent) ? row.remainingPercent : 100 - row.usedPercent, 0, 100) }));
  // The current value is as old as its evidence, not its latest redraw. The
  // caller may have measured that before compacting away a newer read. Use
  // since then is caught up from where the figure is placed, but it is only
  // as fresh as it is known to be: an undated redraw may carry a fetch from
  // anywhere in its window.
  const measured = options.evidence?.observedAt === current.observedAt;
  // Where it is measured afresh, there is a current reading, so it has a time.
  const evidenceMs = measured && Number.isFinite(options.evidence.at)
    ? Math.min(/** @type {number} */ (options.evidence.at), current.observedAt) : /** @type {number} */ (latestEvidenceAt(normalised));
  const knownMs = measured && Number.isFinite(options.evidence.known)
    ? Math.min(/** @type {number} */ (options.evidence.known), current.observedAt) : latestEvidenceAt(normalised, { known: true });
  // There is a current reading here, so its evidence has a time.
  const staleHours = Math.max(0, (nowMs - /** @type {number} */ (knownMs)) / HOUR_MS);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return unknownForecast({ expired: true, observed, staleHours });

  const remaining = Number.isFinite(current.remainingPercent) ? current.remainingPercent : 100 - current.usedPercent;
  const usedNow = clamp(Number.isFinite(current.usedPercent) ? current.usedPercent : 100 - remaining, 0, 100);
  const learningKey = JSON.stringify([normalised.length, normalised[0].observedAt, current.observedAt, current.usedPercent,
    evidenceMs, dayWeights ? [...dayWeights] : null]);
  const cachedModel = options.learningCache?.get(learningKey);
  const model = cachedModel && nowMs >= cachedModel.at && nowMs - cachedModel.at < 60_000
    ? cachedModel.value : learnForecast({ normalised, current, currentCluster, clusters, schedule, nowMs, excluded, dayWeights, usedNow, resetMs, fallbackRate, evidenceMs });
  if (options.learningCache && model !== cachedModel?.value) {
    if (options.learningCache.size >= 4) options.learningCache.clear();
    options.learningCache.set(learningKey, { at: nowMs, value: model });
  }
  const { samples, modelSamples, rates, sustainableOffSchedulePace, recent, globalRate, anchor, windowPace } = model;

  const catchUp = buildSeries(remaining, remaining, evidenceMs, nowMs, schedule, samples, rates);
  if (!catchUp) return unknownForecast({ observed, staleHours });
  const estimatedCurrent = catchUp.expected.at(-1)?.remaining ?? remaining;
  const heavyCurrent = catchUp.heavy.at(-1)?.remaining ?? remaining;
  const future = buildSeries(estimatedCurrent, heavyCurrent, nowMs, resetMs, schedule, samples, rates, evidenceMs);
  if (!future) return unknownForecast({ observed, staleHours });
  const expectedRemaining = future.expected.at(-1)?.remaining ?? estimatedCurrent;
  const heavyRemaining = future.heavy.at(-1)?.remaining ?? heavyCurrent;
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
  const evidenceConfidence = 0.18 + Math.min(learnedDays, 28) / 28 * 0.5
    + Math.min(coveredHours, 80) / 80 * 0.15 + Math.min(changedSamples, 12) / 12 * 0.08
    + Math.min(resetCycles, 3) / 3 * 0.04;
  const confidence = clamp(evidenceConfidence * Math.exp(-staleHours / 168), 0.12, 0.95);
  // A reserve the projection will not honour is worth a warning of its own.
  const watchRemainingThreshold = Math.max(100 - hardLimitThreshold, reservePercent);
  const state = forecastState(expectedRemaining, heavyRemaining, paceRatio, paceRiskThreshold, watchRemainingThreshold);

  return {
    state, expectedRemaining, heavyRemaining, confidence, learnedSamples: modelSamples.length,
    learnedDays, activeHoursLeft, safePace, recentPace, paceRatio, expired: false,
    workingPace, windowPace,
    staleHours, estimatedCurrentRemaining: estimatedCurrent, currentIsEstimated: staleHours > 0.25,
    exhaustsAt: exhaustionTime(future.expected),
    heavyExhaustsAt: exhaustionTime(future.heavy),
    reservePercent,
    series: { observed, expected: future.expected, heavy: future.heavy },
  };
}

/**
 * @param {Reading[]} observations
 * @param {ForecastOptions} options
 * @param {number} nowMs
 */
function earlyResetAdjustment(observations, options, nowMs) {
  const rows = observations.map(normaliseObservation)
    .filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs)
      && row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && Number.isFinite(row.usedPercent))
    .sort((a, b) => a.observedAt - b.observedAt);
  if (rows.length < 2) return null;
  // Callers normally supply one bucket. A mixed history cannot establish that
  // an apparent drop represents replenishment of the same allowance.
  const first = rows[0];
  if (!first.sourceId || !first.bucketId || !(/** @type {number} */ (first.windowMinutes) > 0)
    || rows.some((row) => row.sourceId !== first.sourceId || row.bucketId !== first.bucketId || row.windowMinutes !== first.windowMinutes)) return null;
  /** @type {Map<string, number>} The day before each early reset, and when that reset was seen. */
  const candidates = new Map();
  const excluded = exclusionLookup(options.excludedDates);
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1], after = rows[index];
    if (!before.resetEvidence || !after.resetEvidence) continue;
    // Every row shares the first row's window length, shown above to be a positive number.
    const windowMs = /** @type {number} */ (before.windowMinutes) * 60_000;
    const gap = after.observedAt - before.observedAt;
    const earlyMargin = Math.max(HOUR_MS / 2, Math.min(6 * HOUR_MS, windowMs / 10));
    if (!(gap > 0) || gap > Math.min(6 * HOUR_MS, windowMs / 4)
      || before.resetsAt - after.observedAt < earlyMargin
      || before.usedPercent - after.usedPercent < 20 || after.usedPercent > 2) continue;
    // The preceding completed calendar day has an independent daily total.
    // Do not discount the partly observed reset day or invent a reason for the
    // replenishment (a reset alone cannot establish the user's motivation).
    const previousDay = new Date(after.observedAt);
    previousDay.setHours(0, 0, 0, 0);
    previousDay.setDate(previousDay.getDate() - 1);
    const day = localDayKey(previousDay);
    const nextDay = new Date(previousDay);
    nextDay.setDate(nextDay.getDate() + 1);
    if (!excluded(previousDay.getTime(), nextDay.getTime())) candidates.set(day, after.observedAt);
  }
  if (!candidates.size) return null;
  const schedule = { activeDays: options.schedule?.activeDays ?? [1, 2, 3, 4, 5, 6, 0],
    startHour: options.schedule?.startHour ?? 8, endHour: options.schedule?.endHour ?? 22 };
  const /** @type {Map<string, { used: number, hours: number }>} */ days = new Map(), /** @type {Set<string>} */ uncertainDays = new Set();
  /** @type {LearningSample[]} */
  const boundedSamples = [];
  let peak = rows[0].usedPercent;
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1], after = rows[index];
    if (!sameWindowDrift(before, after)) { peak = after.usedPercent; continue; }
    const delta = Math.max(0, after.usedPercent - peak);
    peak = Math.max(peak, after.usedPercent);
    const gap = after.observedAt - before.observedAt;
    if (!(gap > 0)) continue;
    const firstDay = localDayKey(new Date(before.observedAt));
    const lastDay = localDayKey(new Date(after.observedAt - 1));
    // A long gap crossing midnight cannot prove on which day the usage
    // happened. Within one date, midnight-to-midnight readings can establish
    // a complete day, including its real 23/25-hour DST duration.
    if (!before.resetEvidence || !after.resetEvidence || delta > 70
      || (firstDay !== lastDay && gap > 6 * HOUR_MS)) {
      const cursor = new Date(before.observedAt);
      cursor.setHours(0, 0, 0, 0);
      while (cursor.getTime() < after.observedAt) {
        uncertainDays.add(localDayKey(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      continue;
    }
    if (excluded(before.observedAt, after.observedAt)) continue;
    // Consecutive unchanged polls prove quiet exposure too; the forecasting
    // samples intentionally compact those polls and are not coverage proof.
    addIntervalSamples(boundedSamples, { ...before, usedPercent: peak - delta },
      { ...after, usedPercent: peak }, schedule, nowMs);
  }
  for (const sample of boundedSamples) {
    for (const entry of sample.dailyDeltas) {
      const day = days.get(entry.day) || { used: 0, hours: 0 };
      day.used += entry.delta;
      days.set(entry.day, day);
    }
    for (const entry of sample.dailyHours) {
      const day = days.get(entry.day) || { used: 0, hours: 0 };
      day.hours += entry.hours;
      days.set(entry.day, day);
    }
  }
  /**
   * @param {string} day
   * @param {{ used: number, hours: number }} value
   */
  const covered = (day, value) => {
    const [year, month, date] = day.split('-').map(Number);
    const dayHours = (new Date(year, month - 1, date + 1).getTime() - new Date(year, month - 1, date).getTime()) / HOUR_MS;
    return !uncertainDays.has(day) && value.hours >= dayHours * 0.75;
  };
  const adjusted = [];
  for (const [day, resetAt] of candidates) {
    const heavy = days.get(day);
    if (!heavy || !covered(day, heavy)) continue;
    const earliest = localDayKey(new Date(resetAt - 28 * DAY_MS));
    const baseline = [...days].filter(([date, value]) => date < day && date >= earliest
      && !candidates.has(date) && covered(date, value)).map(([, value]) => value.used / value.hours * heavy.hours);
    if (baseline.length < 3) continue;
    const typical = percentile(baseline, 0.5);
    if (heavy.used >= Math.max(typical * 3, typical + 10)) adjusted.push({ day, resetAt });
  }
  return adjusted.length ? {
    resetAt: new Date(Math.max(...adjusted.map((entry) => entry.resetAt))).toISOString(),
    dates: adjusted.map((entry) => entry.day).sort(), weight: EARLY_RESET_DAY_WEIGHT,
  } : null;
}

// An unchanged run within a day keeps its first and latest reading, and a
// waypoint at least every COVERAGE_GAP_MS between them. Without the waypoints a
// quiet day polled throughout became one pair a day apart, which the quiet-day
// coverage below discards as a gap, so its unused off-schedule hours were lost.
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

/**
 * @param {ReadingLike[]} observations
 * @param {ForecastOptions} [options]
 * @returns {Forecast}
 */
function forecastQuota(observations, options = {}) {
  // Normalise once; each pass below would otherwise re-parse every timestamp.
  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();
  let normalised = withoutStaleRestatements(rescaleObservations(observations.map(normaliseObservation), options)
    .sort((a, b) => a.observedAt - b.observedAt), { nowMs, freshReadGraceMs: options.freshReadGraceMs });
  let learningOptions = options;
  if (options.compactReadings) {
    normalised = normalised.filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs))
      .sort((a, b) => a.observedAt - b.observedAt);
    const current = normalised.at(-1);
    // A compacted run keeps its latest reading, which may redraw an older
    // fetch than a reading the run drops, so the evidence is measured first.
    if (current) learningOptions = { ...options, evidence: { observedAt: current.observedAt, at: latestEvidenceAt(normalised),
      known: latestEvidenceAt(normalised, { known: true }) } };
    normalised = collapseReadings(normalised.filter((row) => row === current || row.observedAt >= nowMs - FORECAST_LOOKBACK_MS), nowMs);
  }
  const rows = normalised;
  const ordinary = forecastQuotaWithLearning(rows, learningOptions);
  if (ordinary.expired || ordinary.expectedRemaining == null) return ordinary;
  const adjustment = earlyResetAdjustment(rows, options, nowMs);
  if (!adjustment) return ordinary;
  const adjusted = forecastQuotaWithLearning(rows, learningOptions,
    new Map(adjustment.dates.map((day) => [day, adjustment.weight])));
  // Normal-day expectations use the reduced influence. The heavier scenario
  // keeps the complete observed workload, and can never be more optimistic
  // than the adjusted expected curve at the same instant.
  const heavy = ordinary.series.heavy.map((point, index) => {
    const bound = adjusted.series.expected[index];
    return { ...point,
      remaining: Math.min(point.remaining, bound?.remaining ?? point.remaining),
      projected: Math.min(point.projected ?? point.remaining, bound?.projected ?? bound?.remaining ?? point.remaining) };
  });
  const heavyRemaining = heavy.at(-1)?.remaining ?? ordinary.heavyRemaining;
  const paceRiskThreshold = Number(options.paceRiskThreshold ?? 1.2);
  const watchRemainingThreshold = Math.max(100 - Number(options.hardLimitThreshold ?? 90), /** @type {number} */ (adjusted.reservePercent));
  // The second pass differs from the first only in its day weights, so it has a projection wherever the first did.
  const state = forecastState(/** @type {number} */ (adjusted.expectedRemaining), /** @type {number} */ (heavyRemaining), adjusted.paceRatio, paceRiskThreshold, watchRemainingThreshold);
  return { ...adjusted, state, heavyRemaining, heavyExhaustsAt: exhaustionTime(heavy),
    series: { ...adjusted.series, heavy }, resetAdjustment: adjustment };
}

module.exports = { activeHoursBetween, clusterByWindow, sameWindowDrift, normaliseObservation, prepareObservation, deriveLearningSamples, evidenceTimes, exhaustionTime, fetchMomentOf, forecastQuota, forecastState, freshReadGraceFor, latestEvidenceAt, percentile, restatesSessionLimits, withoutStaleRestatements };
