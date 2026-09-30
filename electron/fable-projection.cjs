'use strict';

// The Fable allowance estimate as a projection: computed from official
// readings and local activity whenever a snapshot is built, and never written
// to quota_observations. A persisted estimate outlived the settings and
// evidence it was computed from — an allowance change, a corrected import, a
// newer anchor — and every stale-row bug came from that. A projection has no
// rows to go stale, so there is nothing to rescale, retire or discard.

const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { clusterByWindow, evidenceTimes, fetchMomentOf, latestEvidenceAt, normaliseObservation, restatesSessionLimits, withoutStaleRestatements } = require('./forecast.cjs');
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

// Official readings as the Claude forecast sees them: expressed in today's
// allowance, a stale status-line restatement held back, and the rest split
// into allowance cycles. A provider can replenish before it moves the reset
// timestamp, so a shared timestamp alone does not put two readings in the same
// cycle. Percentages are compared only after a recorded allowance change is
// applied: after a fourfold upgrade an earlier 8% is today's 2%, the same use
// rather than a replenishment. Each cycle returns the original stored rows.
function allowanceCycles(rows, nowMs, freshReadGraceMs, usedOf = rawUsedPercent) {
  const current = rows.map((row) => {
    const usedPercent = usedOf(row);
    return { ...normaliseObservation(row), usedPercent, remainingPercent: 100 - usedPercent, row };
  });
  return clusterByWindow(withoutStaleRestatements(current, { nowMs, freshReadGraceMs }))
    .map((cluster) => cluster.rows.map((entry) => entry.row));
}

const FABLE_BUCKET = 'fable_seven_day';
// One allowance covers Fable 5 and Fable 5.1; Claude reports it as "Fable".
const FABLE_BUCKET_NAME = 'Fable weekly';
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
//
// v2 gives Fable 5.1 and Opus 5.5 their own rows. Before it, both matched
// their predecessors by prefix, so a Fable 5.1 cache read weighed four times
// its API rate. Anthropic publishes no conversion from tokens to plan usage,
// only that cached tokens count less and that Fable uses limits faster, so the
// weights stay API-proportional, the basis v1 was built on.
const ALLOWANCE_PRESSURE_V2 = [
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
];

// Longest name first so a dated variant matches its exact family, not a
// shorter prefix. Built once; the per-model answer is remembered because the
// pressure scan asks for it once per usage event.
const ALLOWANCE_PROFILES = ALLOWANCE_PRESSURE_V2
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
// fixed allowance-pressure units, and their ratio is the rate. Pairs must
// share an allowance cycle — a delta across a reset or a replenishment is
// meaningless — but a rate learned in one cycle carries into the next,
// because it is a property of pricing and caps, not the week.
// Whether a reading shows its figure held at its evidence moment: a read, or
// a dated status-line fetch. An undated redraw is known only to be no newer
// than its session's first redraw, so it cannot confirm a figure later.
function confirmsFigure(row) {
  return !restatesSessionLimits(row) || Number.isFinite(normaliseObservation(row).fetchedAfter);
}

// Where an interval that ends on a rise closes: the rise's evidence, or,
// when fetches overlap and that falls before the interval's start, the first
// later moment the new figure is known to have been fetched by. Boundaries
// then only move forward, so no use falls between intervals or into two.
function riseEndMs(row, evidenceMs, startMs) {
  const parsed = normaliseObservation(row);
  for (const at of [evidenceMs, parsed.seenSince, parsed.observedAt]) {
    if (Number.isFinite(at) && at > startMs) return Math.min(at, parsed.observedAt);
  }
  return startMs;
}

function fablePairCalibration(store, nowMs, usedOf = rawUsedPercent, freshReadGraceMs) {
  const sinceIso = new Date(nowMs - 21 * 24 * 60 * 60 * 1000).toISOString();
  let deltaSum = 0;
  let pressureSum = 0;
  let pairs = 0;
  const rows = officialBetween(store, 'claude-fable', FABLE_BUCKET, sinceIso, nowMs);
  for (const readings of allowanceCycles(rows, nowMs, freshReadGraceMs, usedOf)) {
    // Each figure is bounded by its evidence, as the projection's own tail is,
    // not by a redraw that may come well after its fetch.
    const moments = new Map(evidenceTimes(readings).map((at, index) => [readings[index], at]));
    // Consumption is only a new high-water mark within the cycle. A backward
    // move is a correction or a mistyped reading, and the rebound after it
    // returns to use already counted. Each rise is measured from the latest
    // reading that confirmed the mark: a read, or a newer dated fetch. An
    // older or undated status-line repeat only restates what a session
    // fetched earlier, so it cannot bound the rise.
    let highWater = NaN;
    let fromMs = NaN;
    for (const after of readings) {
      const used = usedOf(after);
      if (!Number.isFinite(used)) continue;
      if (!Number.isFinite(fromMs)) {
        highWater = used;
        fromMs = moments.get(after);
        continue;
      }
      if (used < highWater) continue;
      // Equal displayed readings are interval-censored: real use may have moved
      // by less than the provider's rounding precision. Treating them as a
      // measured zero rate would freeze every later estimate.
      if (used === highWater) {
        if (confirmsFigure(after)) fromMs = Math.max(fromMs, moments.get(after));
        continue;
      }
      const delta = used - highWater;
      const startMs = fromMs;
      const endMs = riseEndMs(after, moments.get(after), startMs);
      highWater = used;
      fromMs = Math.max(fromMs, endMs);
      if (!(endMs > startMs)) continue;
      const measured = allowancePressure(store, 'fable', new Date(startMs).toISOString(), new Date(endMs).toISOString());
      if (!(measured.pressure > 0) || !measured.complete) continue;
      deltaSum += delta;
      pressureSum += measured.pressure;
      pairs += 1;
    }
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
  // Each step is bounded by its readings' evidence, as the tail after them
  // is, so activity between a fetch and its later redraw counts once.
  const moments = evidenceTimes(readings);
  // The latest moment the high-water figure is known to have held; each step
  // is measured from there. An older restatement of the mark redrawn later
  // must not reach back before it, and only a read or a dated fetch confirms it.
  let markMs = moments[0];
  for (let index = 1; index < readings.length; index += 1) {
    const after = readings[index];
    // Provider percentages jitter and correct backwards. Consumption is only a
    // new same-window high-water mark; a rebound to an already-seen value adds
    // nothing a second time.
    const afterUsed = usedOf(after);
    if (!Number.isFinite(afterUsed) || !Number.isFinite(highWater)) continue;
    const priorHighWater = highWater;
    const beforeMs = markMs;
    highWater = Math.max(highWater, afterUsed);
    const rise = afterUsed > priorHighWater;
    const atMs = rise ? riseEndMs(after, moments[index], beforeMs) : moments[index];
    const at = new Date(atMs).toISOString();
    if (rise || (afterUsed === priorHighWater && confirmsFigure(after))) markMs = Math.max(markMs, atMs);
    // Readings before an anchor still establish the high-water baseline, even
    // though their movement is already included in that anchor.
    if (!(atMs > fromMs) || atMs > toMs) continue;
    const deltaOverall = Math.max(0, afterUsed - priorHighWater);
    if (!(deltaOverall > 0)) continue;
    const fable = allowancePressure(store, 'fable', new Date(Math.max(fromMs, beforeMs)).toISOString(), at);
    const all = allowancePressure(store, null, new Date(beforeMs).toISOString(), at);
    if (!all.complete) {
      rejectedCoverage += 1;
      continue;
    }
    if (!(all.pressure > 0)) continue;
    const share = Math.min(1, fable.pressure / all.pressure);
    steps.push({
      at,
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
    // The allowance in force when the figure was fetched, not redrawn.
    const fetchedMs = fetchMomentOf(row);
    return Number.isFinite(used) && Number.isFinite(fetchedMs) ? used * scaler(fetchedMs) : used;
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
function computeProjection(store, nowMs, { freshReadGraceMs } = {}) {
  // Read the bucket directly rather than through getQuota, which forecasts
  // every window of every source on the way past.
  const latest = latestOfficialAt(store, 'claude', OVERALL_BUCKET, nowMs);
  if (!latest) return { derived: false, reason: 'no-overall-reading' };
  // Anthropic includes Fable in the shared weekly pool on Max and qualifying
  // premium seats, while Pro and standard seats use credits instead. The local
  // status line does not identify seat class, so anything short of an
  // affirmative Max classification is insufficient evidence for half-pool
  // arithmetic. The plan is read from the most recent official reading in
  // this window that names one: a status-line row carries none and must not
  // switch the projection off merely by being newest. The structured
  // model-scoped provider window remains authoritative for every plan.
  const planType = planEvidence(store, latest, nowMs);
  if (planType !== 'max') {
    return { derived: false, reason: 'fable-not-confirmed-in-shared-plan', planType };
  }
  const usedOf = allowanceAdjustedUsed(store, nowMs);
  const resetMs = new Date(latest.resets_at).getTime();
  if (!Number.isFinite(resetMs)) return { derived: false, reason: 'invalid-overall-reading' };
  if (resetMs <= nowMs) return { derived: false, reason: 'overall-window-expired' };
  const windowMinutes = Number(latest.window_minutes) > 0 ? Number(latest.window_minutes) : 10_080;
  const windowMs = windowMinutes * 60_000;
  const windowStartMs = resetMs - windowMs;

  // The current cycle's readings, as the Claude card sees them. After an early
  // replenishment the cycle starts at the first reading that showed it, and
  // nothing observed before then — a step, an anchor or local activity — is
  // part of this cycle's use.
  const cycles = allowanceCycles(
    officialBetween(store, 'claude', OVERALL_BUCKET, new Date(windowStartMs).toISOString(), nowMs)
      .filter((row) => Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000),
    nowMs, freshReadGraceMs, usedOf);
  const readings = cycles.at(-1) ?? [];
  // A replenished cycle starts when its first reading's figure was fetched,
  // not when that figure was first redrawn.
  const cycleStartMs = cycles.length > 1 ? evidenceTimes(readings)[0] : windowStartMs;
  const overallWindow = readings.at(-1) ?? latest;
  const overallUsed = usedOf(overallWindow);
  // The overall figure holds as of its evidence, not its latest redraw: an
  // idle session re-records limits it fetched earlier, and Fable activity
  // since that fetch is still unaccounted for.
  const overallObservedMs = latestEvidenceAt(readings.length ? readings : [latest]);
  if (!Number.isFinite(overallUsed) || !Number.isFinite(overallObservedMs)) {
    return { derived: false, reason: 'invalid-overall-reading' };
  }

  // An official Fable reading inside this cycle is the best possible start.
  // Without one the cycle starts at zero, which is right after a reset and
  // an understatement on a machine that joined the window late — reported as
  // lower confidence rather than papered over.
  const anchor = [latestOfficialAt(store, 'claude-fable', FABLE_BUCKET, nowMs)]
    .find((row) => row && new Date(row.observed_at).getTime() >= cycleStartMs
      && Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000) || null;
  const baseUsed = anchor ? usedOf(anchor) : 0;
  // Likewise the anchor's figure holds as of its own evidence.
  const baseAtMs = anchor ? Math.max(cycleStartMs, latestEvidenceAt(
    officialBetween(store, 'claude-fable', FABLE_BUCKET, new Date(cycleStartMs).toISOString(), nowMs)
      .filter((row) => Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000))) : cycleStartMs;

  // Structural ceiling at the timestamp of the latest overall observation.
  // Activity after that instant is deliberately added outside the ceiling.
  const ceiling = Math.min(100, overallUsed / FABLE_ALLOWANCE_SHARE);

  // Two rates can move the estimate off its base. A rate measured between two
  // official Fable readings is direct evidence and needs no share assumption,
  // so when one exists it wins. The overall-share split is the fallback — and
  // it needs the overall figure to actually step, which an integer percentage
  // on a machine that mostly runs without the status line may never do.
  const pair = fablePairCalibration(store, nowMs, usedOf, freshReadGraceMs);
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
    const tailFromMs = Math.max(overallObservedMs, baseAtMs);
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
      profile: 'allowance-pressure-v2',
      pairMeasuredPressure: pair.measuredPressure,
      steppedPercent: stepped,
      projectedTailPercent: tail,
      percentPerPressureUnit: ratePerPressure,
    },
  };
}

// Read-only. The store builds the displayed window and the forecast's
// learning series from this; the collector reports it as source status.
// `freshReadGraceMs` is the store's wait for a lower status-line reading to be
// confirmed; left out, the forecast's default applies.
function projectFableAllowance(store, nowMs = Date.now(), options = {}) {
  const result = computeProjection(store, nowMs, options);
  // The plan is kept on this refusal: a named plan other than Max has no
  // Fable allowance to wait for, while an unnamed one is only unknown.
  if (!result.derived) return { available: false, reason: result.reason, ...(result.planType ? { planType: result.planType } : {}) };
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

module.exports = { FABLE_ALLOWANCE_SHARE, FABLE_BUCKET, FABLE_BUCKET_NAME, deriveFableEstimate, projectFableAllowance };
