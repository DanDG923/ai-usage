'use strict';

const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { freshnessLimitHours } = require('./dashboard-decision.cjs');
const { OFFICIAL_PROVENANCES, isOfficialProvenance } = require('./quota-provenance.mjs');
const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS, validQuotaTime } = require('./quota-time.cjs');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RESET_TOLERANCE_MS = 60_000;
const HEAVY_HISTORY_DAYS = 7;
// Readings further apart than this leave the time between them unobserved.
const COVERAGE_GAP_MS = 6 * HOUR_MS;
const EARLY_RESET_DAY_WEIGHT = 0.25;
const RESET_EVIDENCE_PROVENANCES = new Set(OFFICIAL_PROVENANCES);
const MAX_PROJECTION_MS = MAX_QUOTA_RESET_AHEAD_MS + QUOTA_CLOCK_SKEW_MS;
const MAX_SERIES_POINTS = Math.ceil(MAX_PROJECTION_MS / HOUR_MS) + 1;

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function nextLocalHour(cursor) {
  const date = new Date(cursor);
  // Advance elapsed time to the next local hour boundary. Arithmetic on local
  // minutes also visits the repeated hour at a DST fallback instead of skipping
  // it with Date.setHours, and supports half/quarter-hour UTC offsets.
  return cursor + HOUR_MS - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds();
}

function forecastState(expectedRemaining, heavyRemaining, paceRatio, paceRiskThreshold, watchRemainingThreshold) {
  return expectedRemaining <= 0 ? 'critical'
    : heavyRemaining <= 0 || paceRatio > paceRiskThreshold ? 'risk'
      : expectedRemaining < watchRemainingThreshold || heavyRemaining < watchRemainingThreshold
        || paceRatio > paceRiskThreshold * 0.75 ? 'watch' : 'safe';
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function weightedMean(entries) {
  let numerator = 0;
  let denominator = 0;
  for (const entry of entries) {
    numerator += entry.value * entry.weight;
    denominator += entry.weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function isActiveHour(date, schedule) {
  if (!schedule.activeDays.includes(date.getDay())) return false;
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= schedule.startHour && hour < schedule.endHour;
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Exclusions describe local calendar days, including the real 23/25-hour DST
// boundaries. Quota deltas cover [before, after), so a midnight reading can
// still close the preceding clean day. Never infer where a delta crossing an
// excluded day was spent: discard that interval and resume at its next reading.
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

function providerBacked(row) {
  const provenance = String(row?.provenance || 'official');
  return isOfficialProvenance(provenance);
}

// A provider-backed replenishment can arrive one reading before its scheduled
// reset timestamp is updated. Only treat a large drop all the way back to the
// near-zero floor as a new allowance cycle; smaller backwards moves remain
// rounding jitter and locally derived corrections remain in their old cycle.
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
function sameWindowDrift(previousRow, row) {
  if (clearAllowanceRebase(previousRow, row)) return false;
  const gapMs = Math.max(0, row.observedAt - previousRow.observedAt);
  const jitterAllowance = RESET_TOLERANCE_MS + gapMs * 0.01;
  const resetShift = row.resetsAt - previousRow.resetsAt;
  if (Math.abs(resetShift) <= jitterAllowance) return true;
  return Math.abs(resetShift - gapMs) <= jitterAllowance
    && Math.abs(usedPercentOf(row) - usedPercentOf(previousRow)) <= 0.5;
}

function clusterByWindow(rows) {
  const clusters = [];
  for (const row of rows) {
    // Windows are sequential in time, so a time-sorted row either continues
    // the latest cluster or starts a new one — never rejoins a dormant one.
    const cluster = clusters.at(-1);
    const previous = cluster?.rows.at(-1);
    if (cluster && sameWindowDrift(previous, row)) {
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
        observedResetAt: previous && resetTimestampUnchanged && clearAllowanceRebase(previous, row)
          ? row.observedAt
          : null,
      });
    }
  }
  return clusters;
}

// Average allowance consumption per scheduled active hour across one window.
// The provider's used-percentage covers the whole window, so when the window
// length is known the denominator starts at the true window start.
function usedPercentOf(row) {
  return clamp(Number.isFinite(row.usedPercent) ? row.usedPercent : 100 - row.remainingPercent, 0, 100);
}

function windowPaceOf(rows, schedule, observedResetAt = null, nowMs = Date.now(), excluded = null, dayWeights = null) {
  const last = rows.at(-1);
  const usedEnd = usedPercentOf(last);
  const windowMinutes = rows.findLast((row) => Number.isFinite(row.windowMinutes) && row.windowMinutes > 0)?.windowMinutes;
  const startMs = Number.isFinite(observedResetAt)
    ? observedResetAt
    : windowMinutes ? last.resetsAt - windowMinutes * 60_000 : rows[0].observedAt;
  // Backward jitter within a window must not discard the pace entirely.
  const used = windowMinutes ? usedEnd : Math.max(0, usedEnd - usedPercentOf(rows[0]));
  if (!(used >= 0)) return null;
  // Only the scheduled share of the window's usage may carry forward as an
  // active-hour pace: the projection adds off-schedule use separately, so a
  // whole-window average would count every late-night point twice.
  const split = splitWindowUsage(rows, schedule, nowMs, startMs, last.observedAt, used, excluded, dayWeights);
  const evidenceActiveHours = dayWeights?.size
    ? splitWindowUsage(rows, schedule, nowMs, startMs, last.observedAt, used, excluded).activeHours : split.activeHours;
  return evidenceActiveHours >= 1 && split.activeHours > 0
    ? { pace: split.activeUsed / split.activeHours, activeHours: split.activeHours, evidenceActiveHours } : null;
}

// Split one window's usage between scheduled and off-schedule hours. Usage
// already localised by observation intervals belongs to its measured phase.
// The remainder happened before the first useful reading, so the observed
// phase mix cannot tell us where it occurred; distribute that unknown
// remainder by elapsed exposure instead, otherwise one +1 just after the
// active-hours boundary can assign an entire 13% window burn to off-schedule use.
function splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used, excluded = null, dayWeights = null) {
  if (excluded?.(startMs, endMs)) {
    // A cumulative provider total includes the ignored day's burn. Only clean
    // spans bounded by actual readings can supply usage and elapsed exposure;
    // distributing the missing remainder would silently relearn that day.
    const segments = [];
    let peakUsed = 0;
    for (const row of rows) {
      const segment = segments.at(-1);
      peakUsed = Math.max(peakUsed, usedPercentOf(row));
      const monotonic = { ...row, usedPercent: peakUsed };
      if (!segment || excluded(segment.at(-1).observedAt, row.observedAt)) segments.push([monotonic]);
      else segment.push(monotonic);
    }
    const result = { elapsedHours: 0, activeHours: 0, offHours: 0, activeUsed: 0, offUsed: 0 };
    for (const segment of segments) {
      if (segment.length < 2) continue;
      const first = segment[0];
      const last = segment.at(-1);
      const cleanUsed = segment.reduce((peak, row) => Math.max(peak, usedPercentOf(row)), usedPercentOf(first)) - usedPercentOf(first);
      const split = splitWindowUsage(segment, schedule, nowMs, first.observedAt, last.observedAt, cleanUsed, null, dayWeights);
      for (const key of Object.keys(result)) result[key] += split[key];
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
function prepareObservation(row) {
  Object.defineProperty(row, PREPARED, { value: normaliseObservation(row) });
  return row;
}

function normaliseObservation(row) {
  if (row[NORMALISED]) return row;
  if (row[PREPARED]) return row[PREPARED];
  const windowMinutes = row.windowMinutes ?? row.window_minutes;
  const fetchedAfter = row.fetchedAfter ?? row.fetched_after;
  return {
    [NORMALISED]: true,
    observedAt: new Date(row.observedAt ?? row.observed_at).getTime(),
    // The earliest moment a status-line reading's limits can have been
    // fetched; null for a provider read or a reading the collector could not date.
    fetchedAfter: fetchedAfter == null ? null : new Date(fetchedAfter).getTime(),
    resetsAt: new Date(row.resetsAt ?? row.resets_at).getTime(),
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
function rescaleObservations(rows, options) {
  const changes = options.allowanceChanges;
  if (!Array.isArray(changes) || !changes.length) return rows;
  const scalers = new Map();
  let previousSource, previousBucket, previousMinutes, previousScaler;
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
    const scale = previousScaler?.(row.observedAt) ?? 1;
    if (scale === 1 || !Number.isFinite(row.usedPercent)) return row;
    const usedPercent = row.usedPercent * scale;
    return { ...row, usedPercent, remainingPercent: 100 - usedPercent };
  });
}

function addIntervalSamples(samples, before, after, schedule, nowMs, rateElapsedHours = null) {
  const elapsedHours = (after.observedAt - before.observedAt) / HOUR_MS;
  if (!(elapsedHours > 0)) return;
  const delta = after.usedPercent - before.usedPercent;
  if (delta < 0 || delta > 70) return;
  const ageDays = Math.max(0, (nowMs - after.observedAt) / DAY_MS);
  const provenanceWeight = ['official', 'official-statusline'].includes(after.provenance) ? 1 : 0.65;
  const smoothingHours = rateElapsedHours > 0 ? rateElapsedHours : elapsedHours;
  const rate = delta / smoothingHours;
  const allocationRate = delta / elapsedHours;
  const coverageScale = rateElapsedHours > 0 ? rateElapsedHours / elapsedHours : 1;
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
function restatesSessionLimits(row) {
  return row.provenance === 'official-statusline';
}

// The moment a reading's value is evidence of. A status-line reading carries
// the limits its session last fetched, so the collector dates it by that fetch
// where it can; the redraw that recorded it proves nothing newer. A provider
// read, or a status-line reading that could not be dated, stands for itself.
function evidenceTimeOf(row) {
  return restatesSessionLimits(row) && Number.isFinite(row.fetchedAfter) ? row.fetchedAfter : row.observedAt;
}

// When the latest reading's value was last known to hold: the newest evidence
// among the readings of its window that show the same value. An idle session
// redrawing a value it fetched hours ago is only as current as that fetch,
// unless a newer read agrees with it. Readings must be in time order.
function latestEvidenceAt(rows) {
  const parsed = rows.map(normaliseObservation);
  const current = parsed.at(-1);
  if (!current) return null;
  let at = evidenceTimeOf(current);
  for (const row of parsed) {
    if (Math.abs(row.resetsAt - current.resetsAt) <= RESET_TOLERANCE_MS
      && Math.abs(usedPercentOf(row) - usedPercentOf(current)) <= STALE_RESTATEMENT_MARGIN) {
      at = Math.max(at, evidenceTimeOf(row));
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
// be ordered, a higher value is the later use and a lower one is held back.
// An undated reading (from a helper that did not record sessions, or a
// session first seen with limits in hand) cannot be ordered against the
// newest evidence, whether a provider read or a dated session's fetch. A
// lower one waits for the provider's next read to confirm or contradict it,
// and is believed without one only once that evidence is past the window's
// freshness limit, when the card already calls it out of date.
// Readings must be in time order; readings before any evidence are kept
// because nothing yet shows them to be stale.
const STALE_RESTATEMENT_MARGIN = 0.5;
const FRESH_READ_GRACE_MS = 2 * HOUR_MS;
// The least an undated lower reading waits for the provider's next read: two
// refreshes, and never less than two hours.
function freshReadGraceFor(settings) {
  const minutes = Number(settings.refreshIntervalMinutes);
  return Math.max(FRESH_READ_GRACE_MS, minutes > 0 ? 2 * minutes * 60_000 : 0);
}
function withoutStaleRestatements(rows, { nowMs = Date.now(), freshReadGraceMs = FRESH_READ_GRACE_MS } = {}) {
  const parsed = rows.map(normaliseObservation);
  const nextFresh = Array.from({ length: parsed.length }, () => null);
  for (let index = parsed.length - 1, next = null; index >= 0; index -= 1) {
    nextFresh[index] = next;
    if (!restatesSessionLimits(parsed[index])) next = parsed[index];
  }
  // The newest evidence so far, and the span its fetch is known to lie in.
  let newest = null;
  // Every redraw of one fetch carries its date. The first of them bounds the
  // fetch from above; the later ones were recorded after it anyway.
  const firstCarrier = new Map();
  return rows.filter((row, index) => {
    const reading = parsed[index];
    const used = usedPercentOf(reading);
    if (!restatesSessionLimits(reading)) {
      newest = { reading, from: reading.observedAt, to: reading.observedAt };
      return true;
    }
    const sameReset = (other) => other && Math.abs(other.resetsAt - reading.resetsAt) <= RESET_TOLERANCE_MS;
    if (Number.isFinite(reading.fetchedAfter)) {
      if (!firstCarrier.has(reading.fetchedAfter)) firstCarrier.set(reading.fetchedAfter, reading.observedAt);
      const own = { reading, from: reading.fetchedAfter, to: firstCarrier.get(reading.fetchedAfter) };
      if (!newest || own.from > newest.to) {
        newest = own;
        return true;
      }
      const newestUsed = usedPercentOf(newest.reading);
      if (own.to < newest.from) return sameReset(newest.reading) && Math.abs(used - newestUsed) <= STALE_RESTATEMENT_MARGIN;
      if (!sameReset(newest.reading) || used > newestUsed + STALE_RESTATEMENT_MARGIN) {
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
    // provider read or a dated session's fetch alike.
    const newestUsed = newest && usedPercentOf(newest.reading);
    if (!sameReset(newest?.reading) || used >= newestUsed - STALE_RESTATEMENT_MARGIN) return true;
    const after = nextFresh[index];
    if (after) return sameReset(after) && usedPercentOf(after) < newestUsed - STALE_RESTATEMENT_MARGIN;
    const graceMs = Math.max(freshReadGraceMs, freshnessLimitHours({ windowMinutes: reading.windowMinutes }) * HOUR_MS);
    return nowMs - newest.to > graceMs;
  });
}

function deriveLearningSamples(observations, schedule, nowMs, excludedDates = []) {
  const excluded = typeof excludedDates === 'function' ? excludedDates : exclusionLookup(excludedDates);
  const rows = observations.map(normaliseObservation)
    .filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs)
      && row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && Number.isFinite(row.usedPercent))
    .sort((a, b) => a.observedAt - b.observedAt);
  const samples = [];
  if (rows.length < 2) return samples;

  // Polling cadence is not evidence. Compact unchanged snapshots into one
  // quiet interval, but retain the latest unchanged reading as the lower bound
  // for the next increase so its active/off-schedule phase stays localised.
  let anchor = rows[0];
  let latest = rows[0];
  let previous = rows[0];
  for (let index = 1; index < rows.length; index += 1) {
    const after = rows[index];
    // The smoothing span starts at the last change, not merely the previous
    // poll. Restart both anchors when it crosses an excluded day so neither
    // cumulative usage nor a quiet ignored day changes the learned rate.
    if (excluded(anchor.observedAt, after.observedAt)) {
      if (latest.observedAt - anchor.observedAt >= HOUR_MS) {
        addIntervalSamples(samples, anchor, latest, schedule, nowMs);
      }
      // A provider correction can dip below usage seen on the ignored day.
      // Keep that high-water mark so a later rebound is not counted again.
      anchor = sameWindowDrift(previous, after) && after.usedPercent < anchor.usedPercent
        ? { ...after, usedPercent: anchor.usedPercent } : after;
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
      anchor = after;
      latest = after;
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
      addIntervalSamples(samples, latest, after, schedule, nowMs, (after.observedAt - anchor.observedAt) / HOUR_MS);
      anchor = after;
      latest = after;
    } else if (!restatesSessionLimits(after)) {
      latest = after;
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
function createRateLookup(samples) {
  const partitions = new Map();
  const answers = new Map();
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
    if (answers.has(key)) return answers.get(key);
    const phaseSamples = partition(phase);
    const exact = phaseSamples.filter((sample) => sample.weekday === weekday && Math.abs(sample.hour - hour) <= 1);
    const sameHour = phaseSamples.filter((sample) => Math.abs(sample.hour - hour) <= 1);
    const candidates = exact.length >= 2 ? exact : sameHour.length >= 3 ? sameHour : phaseSamples;
    const rate = contextualRate(candidates, fallbackRate);
    answers.set(key, rate);
    return rate;
  };
}

function contextualRate(samples, fallbackRate, recency = () => 1) {
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
function heavyOverageShare(fromMs, toMs, originMs) {
  const pace = (ms) => {
    const days = (ms - originMs) / DAY_MS;
    return days <= 1 ? days : Math.sqrt(days);
  };
  const span = (toMs - fromMs) / DAY_MS;
  return span > 0 ? clamp((pace(toMs) - pace(fromMs)) / span, 0, 1) : 1;
}

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
      || (Number.isFinite(phaseRates.sustainable) && phaseRates.sustainable > 0);
    if (hasPhaseEvidence) {
      const duration = (next - cursor) / HOUR_MS;
      const learned = learnedRate(midpoint, phaseRates.fallback, phase);
      const conditional = learned * (1 - phaseRates.blend.weight) + phaseRates.blend.rate * phaseRates.blend.weight;
      // Conditional rates describe pace while in use; the window anchor keeps
      // the projection tied to how much of the allowance is really being spent
      // per scheduled hour, so bursts are not extrapolated across every hour.
      const expectedRate = Number.isFinite(phaseRates.sustainable)
        ? phaseRates.sustainable
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
function exhaustionTime(series) {
  for (let index = 1; index < series.length; index += 1) {
    const point = series[index];
    if (point.remaining > 0) continue;
    const previous = series[index - 1];
    if (previous.remaining <= 0) return new Date(previous.at).toISOString();
    const overshoot = Number.isFinite(point.projected) ? Math.min(point.projected, point.remaining) : point.remaining;
    const fraction = previous.remaining / Math.max(previous.remaining - overshoot, Number.EPSILON);
    return new Date(previous.at + (point.at - previous.at) * clamp(fraction, 0, 1)).toISOString();
  }
  return null;
}

function learnForecast({ normalised, current, currentCluster, clusters, schedule, nowMs, excluded, dayWeights, usedNow, resetMs, fallbackRate }) {
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
  // of sustainable pace. Evidence ends at the reading, never at "now".
  const inWindow = currentCluster.rows;
  const windowMinutes = inWindow.findLast((row) => Number.isFinite(row.windowMinutes) && row.windowMinutes > 0)?.windowMinutes;
  const anchorStartMs = Number.isFinite(currentCluster.observedResetAt)
    ? currentCluster.observedResetAt
    : windowMinutes ? resetMs - windowMinutes * 60_000 : inWindow[0].observedAt;
  // Backward jitter on the latest reading (e.g. 5.0% → 4.9%) must degrade the
  // anchor to "pace ≈ 0", not discard the whole window's evidence as invalid.
  const anchorUsed = windowMinutes ? usedNow : Math.max(0, usedNow - usedPercentOf(inWindow[0]));
  const {
    activeHours: anchorActiveHours, offHours: anchorOffHours, activeUsed: activeAnchorUsed, offUsed: offAnchorUsed,
  } = splitWindowUsage(inWindow, schedule, nowMs, anchorStartMs, current.observedAt, anchorUsed, excluded, dayWeights);
  const windowPace = anchorActiveHours >= 1 ? activeAnchorUsed / anchorActiveHours : null;
  const offWindowPace = anchorOffHours >= 1 ? offAnchorUsed / anchorOffHours : null;
  // After a reset the fresh window has no history of its own, so the most
  // recent prior window's average pace carries forward as weaker evidence
  // instead of letting while-working burst rates run unchecked until reset.
  // Only the most recent qualifying window is used, so scan backwards and
  // stop there rather than pacing every historical cluster first.
  let priorEvidence = null;
  for (let index = clusters.length - 1; index >= 0 && !priorEvidence; index -= 1) {
    const entry = clusters[index];
    if (entry === currentCluster || entry.rows.length < 2) continue;
    if (entry.rows.at(-1).windowMinutes > 0 && entry.rows.at(-1).windowMinutes < 360) continue;
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
  const activeDayUsage = new Map();
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
    ? percentile(offDailyRates, 0.82)
    : sustainableOffSchedulePace * 1.6;
  // The latest observed day is still partial. Poll count and reset count
  // cannot turn it into multiple independent days of heavy-use evidence.
  const latestObservedDay = localDayKey(new Date(current.observedAt));
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
  const currentCluster = clusters.at(-1);
  const displayStart = nowMs - 48 * HOUR_MS;
  const firstVisible = currentCluster.rows.findIndex((row) => row.observedAt >= displayStart);
  const visibleRows = firstVisible < 0 ? currentCluster.rows.slice(-1) : currentCluster.rows.slice(Math.max(0, firstVisible - 1));
  const observed = visibleRows
    .map((row) => ({ at: row.observedAt, remaining: clamp(Number.isFinite(row.remainingPercent) ? row.remainingPercent : 100 - row.usedPercent, 0, 100) }));
  // The current value is as old as its evidence, not its latest redraw. The
  // caller may have measured that before compacting away a newer read.
  const evidenceMs = options.evidence?.observedAt === current.observedAt && Number.isFinite(options.evidence.at)
    ? Math.min(options.evidence.at, current.observedAt) : latestEvidenceAt(normalised);
  const staleHours = Math.max(0, (nowMs - evidenceMs) / HOUR_MS);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return unknownForecast({ expired: true, observed, staleHours });

  const remaining = Number.isFinite(current.remainingPercent) ? current.remainingPercent : 100 - current.usedPercent;
  const usedNow = clamp(Number.isFinite(current.usedPercent) ? current.usedPercent : 100 - remaining, 0, 100);
  const learningKey = JSON.stringify([normalised.length, normalised[0].observedAt, current.observedAt, current.usedPercent,
    dayWeights ? [...dayWeights] : null]);
  const cachedModel = options.learningCache?.get(learningKey);
  const model = cachedModel && nowMs >= cachedModel.at && nowMs - cachedModel.at < 60_000
    ? cachedModel.value : learnForecast({ normalised, current, currentCluster, clusters, schedule, nowMs, excluded, dayWeights, usedNow, resetMs, fallbackRate });
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
    ? sample.dailyDeltas.at(-1).day
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

function earlyResetAdjustment(observations, options, nowMs) {
  const rows = observations.map(normaliseObservation)
    .filter((row) => validQuotaTime(row.observedAt, row.resetsAt, row.windowMinutes, nowMs)
      && row.observedAt >= nowMs - FORECAST_LOOKBACK_MS && Number.isFinite(row.usedPercent))
    .sort((a, b) => a.observedAt - b.observedAt);
  if (rows.length < 2) return null;
  // Callers normally supply one bucket. A mixed history cannot establish that
  // an apparent drop represents replenishment of the same allowance.
  const first = rows[0];
  if (!first.sourceId || !first.bucketId || !(first.windowMinutes > 0)
    || rows.some((row) => row.sourceId !== first.sourceId || row.bucketId !== first.bucketId || row.windowMinutes !== first.windowMinutes)) return null;
  const candidates = new Map();
  const excluded = exclusionLookup(options.excludedDates);
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1], after = rows[index];
    if (!before.resetEvidence || !after.resetEvidence) continue;
    const windowMs = before.windowMinutes * 60_000;
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
  const days = new Map(), uncertainDays = new Set();
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
  const covered = (day, value) => {
    const [year, month, date] = day.split('-').map(Number);
    const dayHours = (new Date(year, month - 1, date + 1) - new Date(year, month - 1, date)) / HOUR_MS;
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
function collapseReadings(rows, nowMs) {
  const result = [];
  let previous = null, run = 0, previousDay;
  for (const row of rows) {
    const day = localDayKey(new Date(row.observedAt));
    const same = previous && day === previousDay && (row.observedAt <= nowMs) === (previous.observedAt <= nowMs)
      && ['sourceId', 'bucketId', 'usedPercent', 'remainingPercent', 'resetsAt', 'windowMinutes', 'provenance', 'resetEvidence', 'allowanceScaled']
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
    if (current) learningOptions = { ...options, evidence: { observedAt: current.observedAt, at: latestEvidenceAt(normalised) } };
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
  const watchRemainingThreshold = Math.max(100 - Number(options.hardLimitThreshold ?? 90), adjusted.reservePercent);
  const state = forecastState(adjusted.expectedRemaining, heavyRemaining, adjusted.paceRatio, paceRiskThreshold, watchRemainingThreshold);
  return { ...adjusted, state, heavyRemaining, heavyExhaustsAt: exhaustionTime(heavy),
    series: { ...adjusted.series, heavy }, resetAdjustment: adjustment };
}

module.exports = { activeHoursBetween, clusterByWindow, sameWindowDrift, normaliseObservation, prepareObservation, deriveLearningSamples, evidenceTimeOf, exhaustionTime, forecastQuota, forecastState, freshReadGraceFor, latestEvidenceAt, percentile, restatesSessionLimits, withoutStaleRestatements };
