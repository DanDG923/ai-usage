'use strict';

const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS, validQuotaTime } = require('./quota-time.cjs');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RESET_TOLERANCE_MS = 60_000;
const HEAVY_HISTORY_DAYS = 7;
const MAX_PROJECTION_MS = MAX_QUOTA_RESET_AHEAD_MS + QUOTA_CLOCK_SKEW_MS;
const MAX_SERIES_POINTS = Math.ceil(MAX_PROJECTION_MS / HOUR_MS) + 1;

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function weightedPercentile(entries, fraction) {
  if (!entries.length) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return percentile(sorted.map((entry) => entry.value), fraction);
  const target = total * clamp(fraction, 0, 1);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += Math.max(0, entry.weight);
    if (cumulative >= target) return entry.value;
  }
  return sorted.at(-1).value;
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

function activeHoursBetween(startMs, endMs, schedule) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, Math.floor(cursor / HOUR_MS) * HOUR_MS + HOUR_MS);
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
  return provenance.startsWith('official') || provenance === 'local-official' || provenance === 'manual-official';
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

function windowPaceOf(rows, schedule, observedResetAt = null, nowMs = Date.now()) {
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
  const split = splitWindowUsage(rows, schedule, nowMs, startMs, last.observedAt, used);
  return split.activeHours >= 1 ? { pace: split.activeUsed / split.activeHours, activeHours: split.activeHours } : null;
}

// Split one window's usage between scheduled and off-schedule hours. Usage
// already localised by observation intervals belongs to its measured phase.
// The remainder happened before the first useful reading, so the observed
// phase mix cannot tell us where it occurred; distribute that unknown
// remainder by elapsed exposure instead, otherwise one +1 just after the
// active-hours boundary can assign an entire 13% window burn to off-schedule use.
function splitWindowUsage(rows, schedule, nowMs, startMs, endMs, used) {
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

function normaliseObservation(row) {
  const windowMinutes = row.windowMinutes ?? row.window_minutes;
  return {
    observedAt: new Date(row.observedAt ?? row.observed_at).getTime(),
    resetsAt: new Date(row.resetsAt ?? row.resets_at).getTime(),
    usedPercent: Number(row.usedPercent ?? row.used_percent),
    remainingPercent: Number(row.remainingPercent ?? row.remaining_percent),
    windowMinutes: windowMinutes == null ? null : Number(windowMinutes),
    provenance: row.provenance || 'official',
  };
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
    const next = Math.min(after.observedAt, Math.floor(cursor / HOUR_MS) * HOUR_MS + HOUR_MS);
    const midpointMs = (cursor + next) / 2;
    const midpoint = new Date(midpointMs);
    const phase = isActiveHour(midpoint, schedule) ? 'active' : 'off-schedule';
    const hours = (next - cursor) / HOUR_MS;
    const group = phases.get(phase) || { coveredHours: 0, delta: 0, midpointHours: 0, dailyDeltas: new Map() };
    group.coveredHours += hours * coverageScale;
    group.delta += allocationRate * hours;
    group.midpointHours += midpointMs * hours * coverageScale;
    const day = localDayKey(midpoint);
    group.dailyDeltas.set(day, (group.dailyDeltas.get(day) || 0) + allocationRate * hours);
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
    });
  }
}

function deriveLearningSamples(observations, schedule, nowMs) {
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
    // Same chained drift model as clusterByWindow: an idle window rolls its
    // reset forward with elapsed time, so compare against the previous row,
    // never a fixed anchor — a fixed 60s tolerance breaks after one idle
    // minute and relearns the next increase at a wildly inflated rate.
    const sameWindow = sameWindowDrift(previous, after);
    previous = after;
    if (!sameWindow || after.usedPercent - anchor.usedPercent > 70) {
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
    } else {
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
    const rate = candidates.length
      ? weightedMean(candidates.map((sample) => ({ value: sample.rate, weight: sample.weight * sample.coveredHours })))
      : fallbackRate;
    answers.set(key, rate);
    return rate;
  };
}

function recentRate(samples, nowMs, phase) {
  const recent = samples.filter((sample) => sample.phase === phase && sample.rateEligible !== false && nowMs - sample.observedAt <= 36 * HOUR_MS);
  if (!recent.length) return 0;
  return weightedMean(recent.map((sample) => ({
    value: sample.rate,
    weight: sample.weight * sample.coveredHours * Math.exp(-(nowMs - sample.observedAt) / (8 * HOUR_MS)),
  })));
}

function buildSeries(expectedStart, heavyStart, startMs, endMs, schedule, samples, rates) {
  // Reject unsupported work before allocation. Never turn a distant reset into
  // a shorter, apparently valid forecast (including an already empty allowance).
  const points = Math.ceil(Math.max(0, endMs - startMs) / HOUR_MS) + 1;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || endMs - startMs > MAX_PROJECTION_MS || points > MAX_SERIES_POINTS) return null;
  const expected = [{ at: startMs, remaining: clamp(expectedStart, 0, 100) }];
  const heavy = [{ at: startMs, remaining: clamp(heavyStart, 0, 100) }];
  const learnedRate = createRateLookup(samples);
  const hasOffScheduleSamples = samples.some((sample) => sample.phase === 'off-schedule');
  let expectedRemaining = expectedStart;
  let heavyRemaining = heavyStart;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, cursor + HOUR_MS);
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
      heavyRemaining -= heavyRate * duration;
    }
    expected.push({ at: next, remaining: clamp(expectedRemaining, 0, 100) });
    heavy.push({ at: next, remaining: clamp(heavyRemaining, 0, 100) });
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
// hour it happens. The series is clamped at zero, so the crossing point is the
// first zero sample; the previous sample says how far into that hour it fell.
function exhaustionTime(series) {
  for (let index = 1; index < series.length; index += 1) {
    const point = series[index];
    if (point.remaining > 0) continue;
    const previous = series[index - 1];
    if (previous.remaining <= 0) return new Date(previous.at).toISOString();
    const fraction = previous.remaining / Math.max(previous.remaining - point.remaining, Number.EPSILON);
    return new Date(previous.at + (point.at - previous.at) * clamp(fraction, 0, 1)).toISOString();
  }
  return null;
}

function forecastQuota(observations, options = {}) {
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
  const currentCluster = clusters.findLast((entry) => Math.abs(entry.resetsAt - resetMs) <= RESET_TOLERANCE_MS) ?? clusters.at(-1);
  const observed = currentCluster.rows
    .map((row) => ({ at: row.observedAt, remaining: clamp(Number.isFinite(row.remainingPercent) ? row.remainingPercent : 100 - row.usedPercent, 0, 100) }));
  const staleHours = Math.max(0, (nowMs - current.observedAt) / HOUR_MS);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return unknownForecast({ expired: true, observed, staleHours });

  const remaining = Number.isFinite(current.remainingPercent) ? current.remainingPercent : 100 - current.usedPercent;
  const usedNow = clamp(Number.isFinite(current.usedPercent) ? current.usedPercent : 100 - remaining, 0, 100);
  const samples = deriveLearningSamples(normalised, schedule, nowMs);
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
  } = splitWindowUsage(inWindow, schedule, nowMs, anchorStartMs, current.observedAt, anchorUsed);
  const windowPace = anchorActiveHours >= 1 && anchorUsed >= 0 ? activeAnchorUsed / anchorActiveHours : null;
  const offWindowPace = anchorOffHours >= 1 && anchorUsed >= 0 ? offAnchorUsed / anchorOffHours : null;
  // After a reset the fresh window has no history of its own, so the most
  // recent prior window's average pace carries forward as weaker evidence
  // instead of letting while-working burst rates run unchecked until reset.
  const priorEvidence = clusters
    .filter((entry) => entry !== currentCluster && entry.rows.length >= 2)
    .map((entry) => windowPaceOf(entry.rows, schedule, entry.observedResetAt, nowMs))
    .filter((entry) => entry && entry.activeHours >= 6)
    .at(-1) ?? null;
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
  const recent = recentRate(samples, nowMs, 'active');
  const offScheduleRecent = recentRate(samples, nowMs, 'off-schedule');
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
  const scheduleHoursPerDay = Math.max(1, schedule.endHour - schedule.startHour);
  // Off-schedule samples describe the pace of a discrete event, not the
  // probability that the user will be active throughout every future night.
  // Project a duty-cycled rate instead: the stronger of this window's usage
  // across all elapsed off-hours and the average off-schedule daily budget.
  // Each learned local day supplies its real off-schedule capacity: an
  // inactive day has all 24 hours, and a DST boundary may have 23 or 25.
  const offCapacityHours = [...sampleDays]
    .reduce((sum, day) => sum + offScheduleHoursForLocalDay(day, schedule), 0);
  const offDailyPace = offCapacityHours > 0
    ? offDailyTotals.reduce((sum, value) => sum + value, 0) / offCapacityHours
    : 0;
  const offDailyRates = [...offDayUsage]
    .map(([day, value]) => {
      const hours = offScheduleHoursForLocalDay(day, schedule);
      return hours > 0 ? value / hours : null;
    })
    .filter(Number.isFinite);
  const sustainableOffSchedulePace = Math.max(offWindowPace ?? 0, offDailyPace);
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

  const catchUp = buildSeries(remaining, remaining, current.observedAt, nowMs, schedule, samples, rates);
  if (!catchUp) return unknownForecast({ observed, staleHours });
  const estimatedCurrent = catchUp.expected.at(-1)?.remaining ?? remaining;
  const heavyCurrent = catchUp.heavy.at(-1)?.remaining ?? remaining;
  const future = buildSeries(estimatedCurrent, heavyCurrent, nowMs, resetMs, schedule, samples, rates);
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
  const learnedDays = new Set(modelSamples.map((sample) => localDayKey(new Date(sample.observedAt)))).size;
  const coveredHours = modelSamples.reduce((total, sample) => total + sample.coveredHours, 0);
  const changedSamples = new Set(modelSamples.filter((sample) => sample.changed).map((sample) => sample.observedAt)).size;
  const resetCycles = new Set(normalised.map((row) => Math.round(row.resetsAt / RESET_TOLERANCE_MS))).size;
  const evidenceConfidence = 0.18 + Math.min(learnedDays, 28) / 28 * 0.5
    + Math.min(coveredHours, 80) / 80 * 0.15 + Math.min(changedSamples, 12) / 12 * 0.08
    + Math.min(resetCycles, 3) / 3 * 0.04;
  const confidence = clamp(evidenceConfidence * Math.exp(-staleHours / 168), 0.12, 0.95);
  const watchPaceThreshold = paceRiskThreshold * 0.75;
  // A reserve the projection will not honour is worth a warning of its own.
  const watchRemainingThreshold = Math.max(100 - hardLimitThreshold, reservePercent);
  const state = expectedRemaining <= 0 ? 'critical'
    : heavyRemaining <= 0 || paceRatio > paceRiskThreshold ? 'risk'
      : expectedRemaining < watchRemainingThreshold || paceRatio > watchPaceThreshold ? 'watch' : 'safe';

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

module.exports = { activeHoursBetween, deriveLearningSamples, exhaustionTime, forecastQuota, percentile, weightedPercentile };
