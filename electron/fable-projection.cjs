'use strict';

// The Fable 5 allowance estimate as a projection: computed from official
// readings and local activity whenever a snapshot is built, and never written
// to quota_observations. A persisted estimate outlived the settings and
// evidence it was computed from — an allowance change, a corrected import, a
// newer anchor — and every stale-row bug came from that. A projection has no
// rows to go stale, so there is nothing to rescale, retire or discard.

const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { OFFICIAL_PROVENANCES } = require('./quota-provenance.mjs');

// Every input is bounded by the projection's own clock. A reading dated
// ahead of now — queued for an early reset, or left behind by a clock that
// moved backwards — belongs to a later projection; using it now could end
// the current estimate before that reading's own timestamp.
const OFFICIAL_PLACEHOLDERS = OFFICIAL_PROVENANCES.map(() => '?').join(', ');

function latestOfficialAt(store, sourceId, bucketId, nowMs) {
  return store.prepare(`
    SELECT * FROM quota_observations
    WHERE source_id = ? AND bucket_id = ? AND provenance IN (${OFFICIAL_PLACEHOLDERS}) AND observed_at <= ?
    ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(sourceId, bucketId, ...OFFICIAL_PROVENANCES, new Date(nowMs).toISOString()) ?? null;
}

function officialBetween(store, sourceId, bucketId, sinceIso, nowMs) {
  return store.prepare(`
    SELECT * FROM quota_observations
    WHERE source_id = ? AND bucket_id = ? AND provenance IN (${OFFICIAL_PLACEHOLDERS})
      AND observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at ASC, id ASC
  `).all(sourceId, bucketId, ...OFFICIAL_PROVENANCES, sinceIso, new Date(nowMs).toISOString());
}

const FABLE_BUCKET = 'fable_seven_day';
const OVERALL_BUCKET = 'seven_day';
// Fable's cap is half the overall weekly allowance: spending all of Fable is
// spending half the week. So one point of Fable is half a point of the overall
// pool, and a Fable estimate at a given instant cannot exceed twice the overall
// percentage observed at that same instant.
const FABLE_ALLOWANCE_SHARE = 0.5;

// Versioned allowance-pressure weights are deliberately independent of the
// user-editable API price catalogue. They are only a stable attribution model
// for splitting a provider-reported allowance step between Claude model
// families; changing display prices or FX must never rewrite subscription use.
const ALLOWANCE_PRESSURE_V1 = [
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
];

// Longest name first so a dated variant matches its exact family, not a
// shorter prefix. Built once; the per-model answer is remembered because the
// pressure scan asks for it once per usage event.
const ALLOWANCE_PROFILES = ALLOWANCE_PRESSURE_V1
  .map(([name, input, write5m, write1h, read, output]) => ({ name, input, write5m, write1h, read, output }))
  .sort((a, b) => b.name.length - a.name.length);
const allowanceProfiles = new Map();

function allowanceProfile(model) {
  const normalized = String(model || '').toLowerCase().trim();
  let profile = allowanceProfiles.get(normalized);
  if (profile === undefined) {
    profile = ALLOWANCE_PROFILES.find((entry) => normalized === entry.name || normalized.startsWith(`${entry.name}-`)) || null;
    allowanceProfiles.set(normalized, profile);
  }
  return profile;
}

function allowancePressure(store, modelLike, sinceIso, untilIso) {
  const rows = store.prepare(`
    SELECT * FROM usage_events
    WHERE source_id = 'claude' AND occurred_at >= ? AND occurred_at < ?
      ${modelLike == null ? '' : "AND LOWER(COALESCE(model, '')) LIKE ?"}
  `).all(...(modelLike == null
    ? [sinceIso, untilIso]
    : [sinceIso, untilIso, `%${String(modelLike).toLowerCase()}%`]));
  let pressure = 0;
  let tokens = 0;
  let coveredTokens = 0;
  let coveredEvents = 0;
  for (const row of rows) {
    const profile = allowanceProfile(row.model);
    const cacheWriteTotal = Number(row.cache_write_input_tokens || 0);
    let cacheWrite5m = Number(row.cache_write_5m_input_tokens || 0);
    const cacheWrite1h = Number(row.cache_write_1h_input_tokens || 0);
    if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
    const eventTokens = Number(row.input_tokens || 0) + Number(row.cached_input_tokens || 0)
      + cacheWriteTotal + Number(row.output_tokens || 0);
    tokens += eventTokens;
    if (!profile) continue;
    coveredEvents += 1;
    coveredTokens += eventTokens;
    pressure += (
      Number(row.input_tokens || 0) * profile.input
      + cacheWrite5m * profile.write5m
      + cacheWrite1h * profile.write1h
      + Number(row.cached_input_tokens || 0) * profile.read
      + Number(row.output_tokens || 0) * profile.output
    ) / 1_000_000;
  }
  return {
    pressure,
    events: rows.length,
    coveredEvents,
    tokens,
    coveredTokens,
    complete: rows.length === coveredEvents && tokens === coveredTokens,
  };
}

// Two official Fable readings bound an interval exactly the way two overall
// readings do, and between them the Fable rate needs no share assumption at
// all: the percentage moved this much, the local Fable value was this many
// fixed allowance-pressure units, and their ratio is the rate. Pairs must share a reset — a delta
// across a reset is meaningless — but a rate learned in one window carries
// into the next, because it is a property of pricing and caps, not the week.
function fablePairCalibration(store, nowMs, usedOf = rawUsedPercent) {
  const sinceIso = new Date(nowMs - 21 * 24 * 60 * 60 * 1000).toISOString();
  const readings = officialBetween(store, 'claude-fable', FABLE_BUCKET, sinceIso, nowMs);
  let deltaSum = 0;
  let pressureSum = 0;
  let pairs = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const before = readings[index - 1];
    const after = readings[index];
    if (Math.abs(new Date(after.resets_at).getTime() - new Date(before.resets_at).getTime()) > 60_000) continue;
    // Backward movement is a correction or a mistyped reading, not consumption.
    const delta = usedOf(after) - usedOf(before);
    // Equal displayed readings are interval-censored: real use may have moved
    // by less than the provider's rounding precision. Treating them as a
    // measured zero rate would freeze every later estimate.
    if (!Number.isFinite(delta) || delta <= 0) continue;
    const measured = allowancePressure(store, 'fable', before.observed_at, after.observed_at);
    if (!(measured.pressure > 0) || !measured.complete) continue;
    deltaSum += delta;
    pressureSum += measured.pressure;
    pairs += 1;
  }
  return pressureSum > 0
    ? { ratePerPressure: deltaSum / pressureSum, pairs, measuredPressure: pressureSum }
    : { ratePerPressure: null, pairs: 0, measuredPressure: 0 };
}

// Every step the overall percentage takes is split between the models that
// caused it, in proportion to fixed allowance-pressure units. Each step is bounded
// by two official readings, so only tokens between those readings matter — a
// week of history this machine never saw cannot distort it.
function fableStepsFromOverall(store, readings, fromMs, toMs, usedOf = rawUsedPercent) {
  const steps = [];
  let rejectedCoverage = 0;
  let highWater = readings.length ? usedOf(readings[0]) : NaN;
  for (let index = 1; index < readings.length; index += 1) {
    const before = readings[index - 1];
    const after = readings[index];
    const atMs = new Date(after.observed_at).getTime();
    // Provider percentages jitter and correct backwards. Consumption is only a
    // new same-window high-water mark; a rebound to an already-seen value adds
    // nothing a second time.
    const afterUsed = usedOf(after);
    if (!Number.isFinite(afterUsed) || !Number.isFinite(highWater)) continue;
    const priorHighWater = highWater;
    highWater = Math.max(highWater, afterUsed);
    // Readings before an anchor still establish the high-water baseline, even
    // though their movement is already included in that anchor.
    if (!(atMs > fromMs) || atMs > toMs) continue;
    const deltaOverall = Math.max(0, afterUsed - priorHighWater);
    if (!(deltaOverall > 0)) continue;
    const fable = allowancePressure(store, 'fable',
      new Date(Math.max(fromMs, new Date(before.observed_at).getTime())).toISOString(), after.observed_at);
    const all = allowancePressure(store, null, before.observed_at, after.observed_at);
    if (!all.complete) {
      rejectedCoverage += 1;
      continue;
    }
    if (!(all.pressure > 0)) continue;
    const share = Math.min(1, fable.pressure / all.pressure);
    steps.push({
      at: after.observed_at,
      deltaOverall,
      ceiling: Math.min(100, afterUsed / FABLE_ALLOWANCE_SHARE),
      share,
      deltaFable: (deltaOverall * share) / FABLE_ALLOWANCE_SHARE,
      fablePressure: fable.pressure,
    });
  }
  return { steps, rejectedCoverage };
}

function rawUsedPercent(row) {
  return Number(row.used_percent);
}

// Every percentage the derivation reads is expressed in the current Claude
// allowance. Readings taken before a recorded allowance change are a share of
// the earlier allowance; without the rescale the step at the change would be
// calibrated as Fable consumption and the earlier pairs would run too cool.
function allowanceAdjustedUsed(store, nowMs) {
  const scaler = createAllowanceScaler(store.getSettings().allowanceChanges, 'claude', {
    bucketId: OVERALL_BUCKET, windowMinutes: 10_080, nowMs,
  });
  if (!scaler) return rawUsedPercent;
  return (row) => {
    const used = rawUsedPercent(row);
    const observedMs = new Date(row.observed_at).getTime();
    return Number.isFinite(used) && Number.isFinite(observedMs) ? used * scaler(observedMs) : used;
  };
}

// The plan named by the most recent official reading in the same window.
function planEvidence(store, overallWindow, nowMs) {
  const resetMs = new Date(overallWindow.resets_at).getTime();
  const row = store.prepare(`
    SELECT plan_type FROM quota_observations
    WHERE source_id = 'claude' AND bucket_id = ? AND provenance IN (${OFFICIAL_PLACEHOLDERS}) AND observed_at <= ?
      AND resets_at >= ? AND resets_at <= ? AND plan_type IS NOT NULL AND TRIM(plan_type) != ''
    ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(OVERALL_BUCKET, ...OFFICIAL_PROVENANCES, new Date(nowMs).toISOString(),
    new Date(resetMs - 60_000).toISOString(), new Date(resetMs + 60_000).toISOString());
  return String(row?.plan_type || '').trim().toLowerCase();
}

// When Claude does not expose a model-scoped Fable allowance, a labelled local
// estimate can be projected — but never from a guessed token rate. Two derivations exist, and
// both use only intervals bounded by official readings, so history this
// machine never recorded cannot distort the result:
//   * When two official Fable readings bound a measured interval, the rate
//     between them — Fable percent per allowance-pressure unit — is direct
//     evidence, and it projects the latest anchor forward. This is the only
//     method that keeps moving while the status line is not feeding readings,
//     which is every session run outside the terminal.
//   * Otherwise, every official step the overall figure takes is split between
//     the models that caused it by allowance pressure, and Fable's share,
//     doubled (its cap is half the overall weekly allowance), is its movement.
// At the same timestamp, Fable cannot exceed twice the overall percentage.
// That ceiling must never be carried forward across later local activity: the
// unobserved overall percentage moves too. A manual Fable reading re-anchors
// the running total whenever one is present.
function computeProjection(store, nowMs) {
  // Read the bucket directly rather than through getQuota, which forecasts
  // every window of every source on the way past.
  const overallWindow = latestOfficialAt(store, 'claude', OVERALL_BUCKET, nowMs);
  if (!overallWindow) return { derived: false, reason: 'no-overall-reading' };
  // Anthropic includes Fable in the shared weekly pool on Max and qualifying
  // premium seats, while Pro and standard seats use credits instead. The local
  // status line does not identify seat class, so anything short of an
  // affirmative Max classification is insufficient evidence for half-pool
  // arithmetic. The plan is read from the most recent official reading in
  // this window that names one: a status-line row carries none and must not
  // switch the projection off merely by being newest. The structured
  // model-scoped provider window remains authoritative for every plan.
  const planType = planEvidence(store, overallWindow, nowMs);
  if (planType !== 'max') {
    return { derived: false, reason: 'fable-not-confirmed-in-shared-plan' };
  }
  const usedOf = allowanceAdjustedUsed(store, nowMs);
  const resetMs = new Date(overallWindow.resets_at).getTime();
  const windowMinutes = Number(overallWindow.window_minutes) > 0 ? Number(overallWindow.window_minutes) : 10_080;
  const windowMs = windowMinutes * 60_000;
  const overallUsed = usedOf(overallWindow);
  const overallObservedMs = new Date(overallWindow.observed_at).getTime();
  if (!Number.isFinite(resetMs) || !Number.isFinite(overallUsed) || !Number.isFinite(overallObservedMs)) {
    return { derived: false, reason: 'invalid-overall-reading' };
  }
  if (resetMs <= nowMs) return { derived: false, reason: 'overall-window-expired' };
  const windowStartMs = resetMs - windowMs;

  const readings = officialBetween(store, 'claude', OVERALL_BUCKET, new Date(windowStartMs).toISOString(), nowMs)
    .filter((row) => Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000);

  // An official Fable reading inside this window is the best possible start.
  // Without one the window starts at zero, which is right after a reset and
  // an understatement on a machine that joined the window late — reported as
  // lower confidence rather than papered over.
  const anchor = [latestOfficialAt(store, 'claude-fable', FABLE_BUCKET, nowMs)]
    .find((row) => row && new Date(row.observed_at).getTime() >= windowStartMs
      && Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000) || null;
  const baseUsed = anchor ? usedOf(anchor) : 0;
  const baseAtMs = anchor ? new Date(anchor.observed_at).getTime() : windowStartMs;

  // Structural ceiling at the timestamp of the latest overall observation.
  // Activity after that instant is deliberately added outside the ceiling.
  const ceiling = Math.min(100, overallUsed / FABLE_ALLOWANCE_SHARE);

  // Two rates can move the estimate off its base. A rate measured between two
  // official Fable readings is direct evidence and needs no share assumption,
  // so when one exists it wins. The overall-share split is the fallback — and
  // it needs the overall figure to actually step, which an integer percentage
  // on a machine that mostly runs without the status line may never do.
  const pair = fablePairCalibration(store, nowMs, usedOf);
  let raw;
  let method;
  let steps = [];
  let stepped = 0;
  let tail = 0;
  let ratePerPressure = null;
  let clamped = false;
  if (pair.ratePerPressure != null) {
    method = 'fable-anchor-pair';
    ratePerPressure = pair.ratePerPressure;
    let boundedBase = baseUsed;
    let totalPressure = 0;
    if (baseAtMs < overallObservedMs) {
      const bounded = allowancePressure(store, 'fable', new Date(baseAtMs).toISOString(), new Date(overallObservedMs).toISOString());
      if (!bounded.complete) return { derived: false, reason: 'insufficient-activity-coverage' };
      totalPressure += bounded.pressure;
      const boundedRaw = baseUsed + ratePerPressure * bounded.pressure;
      boundedBase = Math.min(boundedRaw, ceiling);
      clamped = boundedRaw > ceiling + 0.01;
    } else if (baseAtMs === overallObservedMs) {
      boundedBase = Math.min(baseUsed, ceiling);
      clamped = baseUsed > ceiling + 0.01;
    }
    const tailFromMs = Math.max(baseAtMs, overallObservedMs);
    if (nowMs > tailFromMs) {
      const projected = allowancePressure(store, 'fable', new Date(tailFromMs).toISOString(), new Date(nowMs).toISOString());
      if (!projected.complete) return { derived: false, reason: 'insufficient-activity-coverage' };
      totalPressure += projected.pressure;
      tail = ratePerPressure * projected.pressure;
    }
    if (!anchor && !(totalPressure > 0)) return { derived: false, reason: 'no-measured-steps' };
    raw = boundedBase + tail;
  } else {
    if (readings.length < 2) return { derived: false, reason: 'not-enough-overall-readings' };
    method = 'overall-share';
    const steppedResult = fableStepsFromOverall(store, readings, baseAtMs, nowMs, usedOf);
    steps = steppedResult.steps;
    stepped = steps.reduce((total, step) => total + step.deltaFable, 0);
    if (!anchor && steps.length === 0) return {
      derived: false,
      reason: steppedResult.rejectedCoverage ? 'insufficient-activity-coverage' : 'no-measured-steps',
    };

    // Between the last official reading and now the overall figure is unknown,
    // so the movement is projected from the rate the steps themselves measured
    // — Fable percent per allowance-pressure unit, calibrated only on intervals
    // this machine fully recorded.
    const measuredPressure = steps.reduce((total, step) => total + step.fablePressure, 0);
    ratePerPressure = measuredPressure > 0 ? stepped / measuredPressure : null;
    // The tail starts wherever bounded evidence ends: after the last overall
    // reading, but never before the anchor — value the anchor already includes
    // must not be projected a second time.
    const tailFromMs = Math.max(new Date(readings.at(-1).observed_at).getTime(), baseAtMs);
    const tailResult = allowancePressure(store, 'fable', new Date(tailFromMs).toISOString(), new Date(nowMs).toISOString());
    if (!tailResult.complete) return { derived: false, reason: 'insufficient-activity-coverage' };
    tail = ratePerPressure != null ? ratePerPressure * tailResult.pressure : 0;
    const contemporaneousRaw = baseUsed + stepped;
    const boundedBase = baseAtMs <= overallObservedMs ? Math.min(contemporaneousRaw, ceiling) : contemporaneousRaw;
    clamped = baseAtMs <= overallObservedMs && contemporaneousRaw > ceiling + 0.01;
    raw = boundedBase + tail;
  }

  const usedPercent = Math.max(0, Math.min(raw, 100));
  clamped = clamped || raw > 100 + 0.01;

  // Confidence follows the evidence: directly measured Fable intervals are
  // stronger than shared-pool splits, and an anchor strengthens either.
  const confidence = method === 'fable-anchor-pair'
    ? Math.min(0.92, (anchor ? 0.6 : 0.45) + Math.min(pair.pairs, 4) * 0.08)
    : Math.min(0.9, 0.35 + Math.min(steps.length, 10) * 0.05 + (anchor ? 0.15 : 0));
  // The points the forecast learns from: the running total at each overall
  // step already attributed to Fable, then the current estimate. Official
  // Fable readings are persisted rows and need no synthetic twin.
  const series = [];
  let cumulative = baseUsed;
  for (const step of steps) {
    cumulative += step.deltaFable;
    series.push({ observedAt: step.at, usedPercent: Math.max(0, Math.min(cumulative, step.ceiling, 100)) });
  }
  series.push({ observedAt: new Date(nowMs).toISOString(), usedPercent });
  return {
    derived: true, usedPercent, ceiling, clamped, method, measuredSteps: steps.length, measuredPairs: pair.pairs,
    anchored: Boolean(anchor), confidence, resetsAt: new Date(resetMs).toISOString(), windowMinutes, planType, series,
    calibration: {
      method,
      allowanceShare: FABLE_ALLOWANCE_SHARE,
      overallUsedPercent: overallUsed,
      ceiling,
      clamped,
      anchoredAt: anchor ? anchor.observed_at : null,
      measuredSteps: steps.length,
      measuredPairs: pair.pairs,
      profile: 'allowance-pressure-v1',
      pairMeasuredPressure: pair.measuredPressure,
      steppedPercent: stepped,
      projectedTailPercent: tail,
      percentPerPressureUnit: ratePerPressure,
    },
  };
}

// Read-only. The store builds the displayed window and the forecast's
// learning series from this; the collector reports it as source status.
function projectFableAllowance(store, nowMs = Date.now()) {
  const result = computeProjection(store, nowMs);
  if (!result.derived) return { available: false, reason: result.reason };
  const { derived: _derived, ...projection } = result;
  return { available: true, reason: null, ...projection };
}

// The summary the Claude refresh has always reported for the estimate.
function deriveFableEstimate(store, nowMs = Date.now()) {
  const result = store.getFableProjection(store.getSettings(), nowMs);
  if (!result.available) return { derived: false, reason: result.reason };
  const { usedPercent, ceiling, clamped, method, measuredSteps, measuredPairs, anchored } = result;
  return { derived: true, usedPercent, ceiling, clamped, method, measuredSteps, measuredPairs, anchored };
}

module.exports = { FABLE_BUCKET, deriveFableEstimate, projectFableAllowance };
