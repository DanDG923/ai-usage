'use strict';

const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { FORECAST_LOOKBACK_MS } = require('./quota-time.cjs');
const { evidenceTimes, normaliseObservation } = require('./forecast.cjs');
const { OFFICIAL_PROVENANCES: CALIBRATION_PROVENANCES } = require('./quota-provenance.mjs');

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// The same learning horizon as the forecast, by construction rather than by
// keeping two numbers in step.
const LOOKBACK_MS = FORECAST_LOOKBACK_MS;
const STALENESS_MS = DAY_MS;
const RESET_TOLERANCE_MS = 60_000;
const MIN_INTERVAL_PERCENT = 5;
const MIN_INTERVALS = 3;
const OFFICIAL_PROVENANCES = new Set(CALIBRATION_PROVENANCES);
const MODEL_IDS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5']);
const EMPTY_MIX = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const BASE_WARNINGS = [
  'This estimates capacity for the observed model and token mix, not a fixed provider token limit.',
  'Only locally recorded activity is matched; usage from other devices or apps may be missing.',
];

function asTime(value) {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : NaN;
}

function metadataOf(row) {
  try {
    const value = JSON.parse(row.metadata_json || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function scopeFor(sourceId, bucketId) {
  const family = (name) => {
    const pattern = new RegExp(`^claude-${name}(?:-|$)`, 'i');
    return (model) => pattern.test(model || '');
  };
  if (sourceId === 'codex' && ['codex:weekly', 'codex:primary', 'codex:secondary'].includes(bucketId)) {
    // Spark is metered separately. Its tokens remain in the ledger but cannot
    // explain movement in the main Codex allowance or increase its capacity.
    return { eventSource: 'codex', modelMatches: (model) =>
      !/^gpt-5\.3-codex-spark(?:$|-(?:\d{8}|\d{4}-\d{2}-\d{2})$)/i.test(typeof model === 'string' ? model.trim() : ''), kind: 'overall' };
  }
  if (sourceId === 'claude-fable' && ['fable_seven_day', 'fable:seven_day_fable'].includes(bucketId)) {
    return { eventSource: 'claude', modelMatches: family('fable'), kind: 'model' };
  }
  if (sourceId !== 'claude') return null;
  if (bucketId === 'seven_day') return { eventSource: 'claude', modelMatches: () => true, kind: 'overall' };
  const known = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };
  if (Object.hasOwn(known, bucketId)) return { eventSource: 'claude', modelMatches: family(known[bucketId]), kind: 'model' };
  if (!String(bucketId).startsWith('model_scoped:')) return null;
  let label;
  try { label = decodeURIComponent(bucketId.slice('model_scoped:'.length)).trim().toLowerCase(); }
  catch { return null; }
  const familyLabel = /^(?:claude )?(opus|sonnet|fable)$/.exec(label);
  if (familyLabel) return { eventSource: 'claude', modelMatches: family(familyLabel[1]), kind: 'model' };
  if (!MODEL_IDS.has(label)) return null;
  return { eventSource: 'claude', kind: 'model', modelMatches: (model) => {
    const value = String(model || '').toLowerCase();
    return value === label || (value.startsWith(`${label}-`) && /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(value.slice(label.length + 1)));
  } };
}

function excludedIntervals(dates) {
  const ranges = (Array.isArray(dates) ? dates : []).flatMap((value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return [];
    const [year, month, day] = value.split('-').map(Number);
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return [];
    return [{ start: start.getTime(), end: new Date(year, month - 1, day + 1).getTime() }];
  });
  // Tokens and quota steps use (before, after]. A token timestamped exactly
  // at the start of an ignored day belongs to that day; its whole pair is out.
  return (before, after) => ranges.some((range) => range.start <= after && range.end > before);
}

function normalizeObservation(row, sourceId, bucketId, scope, nowMs, evidence, known) {
  if (!row || row.source_id !== sourceId || row.bucket_id !== bucketId || row.window_minutes !== 10_080) return null;
  const prepared = normaliseObservation(row);
  const at = prepared.observedAt, reset = prepared.resetsAt, used = row.used_percent;
  if (!Number.isFinite(at) || !Number.isFinite(reset) || at > nowMs || at < nowMs - LOOKBACK_MS
    || reset - at < -RESET_TOLERANCE_MS || reset - at > WEEK_MS + RESET_TOLERANCE_MS
    || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (row.remaining_percent != null && (typeof row.remaining_percent !== 'number'
    || !Number.isFinite(row.remaining_percent) || Math.abs(used + row.remaining_percent - 100) > 0.1)) return null;
  const metadata = metadataOf(row);
  if ((metadata.scope && metadata.scope !== scope.kind)
    || (sourceId === 'codex' && metadata.limitId != null && metadata.limitId !== 'codex')) return null;
  return { at, reset, used, plan: typeof row.plan_type === 'string' ? row.plan_type.trim().toLowerCase() || null : null,
    official: OFFICIAL_PROVENANCES.has(row.provenance), manual: row.provenance === 'manual-official',
    provenance: row.provenance, evidence: Math.min(at, evidence.get(row) ?? at), known: Math.min(at, known.get(row) ?? at),
    // A read or a dated fetch, which can show a replenishment; an undated
    // redraw may restate older limits.
    confirms: row.provenance !== 'official-statusline' || Number.isFinite(prepared.fetchedAfter),
    // A status-line reading's first redraw of its fetch: the fetch was no later.
    seenSince: Number.isFinite(prepared.seenSince) ? Math.min(at, prepared.seenSince) : null };
}

// Where an interval that ends on a reading closes: its fetch, or, when that
// cannot be ordered after the interval's start, the first later moment its
// figure is known to have been fetched by. Boundaries then only move forward,
// so no tokens fall between intervals or into two. Null when none is later.
function closingMs(reading, startMs) {
  for (const at of [reading.evidence, reading.seenSince, reading.at]) {
    if (Number.isFinite(at) && at > startMs) return at;
  }
  return null;
}

function normalizeEvent(row, scope, nowMs) {
  if (!row || row.source_id !== scope.eventSource || !scope.modelMatches(row.model)) return null;
  const at = asTime(row.occurred_at);
  if (!Number.isFinite(at) || at > nowMs || at < nowMs - LOOKBACK_MS) return null;
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  const [input, read, write, output, reasoning] = fields.map((field) => row[field] ?? 0);
  if (![input, read, write, output, reasoning].every((value) => Number.isSafeInteger(value) && value >= 0)
    || reasoning > output || (scope.eventSource === 'codex' && read > input)) return { at, invalid: true };
  const mix = { input: scope.eventSource === 'codex' ? input - read : input,
    cacheRead: read, cacheWrite: write, output };
  const tokens = Object.values(mix).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(tokens)) return { at, invalid: true };
  return { at, tokens, mix, model: typeof row.model === 'string' && row.model.trim() ? row.model : 'Unknown' };
}

function weightedQuantile(entries, fraction) {
  const sorted = [...entries].sort((a, b) => a.capacity - b.capacity);
  const target = sorted.reduce((sum, entry) => sum + entry.weight, 0) * fraction;
  let total = 0;
  for (const entry of sorted) {
    total += entry.weight;
    if (total >= target) return entry.capacity;
  }
  return sorted.at(-1)?.capacity ?? 0;
}

function mixOf(intervals) {
  const models = new Map();
  const tokenMix = { ...EMPTY_MIX };
  let tokens = 0;
  for (const interval of intervals) {
    tokens += interval.tokens;
    for (const [model, count] of interval.models) models.set(model, (models.get(model) || 0) + count);
    for (const key of Object.keys(tokenMix)) tokenMix[key] += interval.mix[key];
  }
  return { models: new Map([...models].map(([model, count]) => [model, tokens > 0 ? count / tokens : 0])),
    tokens: Object.fromEntries(Object.entries(tokenMix).map(([key, count]) => [key, tokens > 0 ? count / tokens : 0])) };
}

function mixDistance(left, right) {
  const models = new Set([...left.models.keys(), ...right.models.keys()]);
  const modelDistance = [...models].reduce((sum, model) => sum + Math.abs((left.models.get(model) || 0) - (right.models.get(model) || 0)), 0) / 2;
  const tokenDistance = Object.keys(EMPTY_MIX).reduce((sum, key) => sum + Math.abs(left.tokens[key] - right.tokens[key]), 0) / 2;
  return Math.max(modelDistance, tokenDistance);
}

function roundedTokens(value, direction = 'round') {
  if (!(value > 0)) return 0;
  const step = Math.max(1, 10 ** (Math.floor(Math.log10(value)) - 1));
  return Math[direction](value / step) * step;
}

function estimateTokenCapacity({ sourceId, bucketId, observations = [], events = [], nowMs = Date.now(), excludedDates = [], allowanceChanges = [] } = {}) {
  const result = { status: 'unavailable', reason: null, weeklyTokens: null, weeklyRange: null,
    remainingTokens: null, remainingRange: null, remainingAsOf: null, confidence: 'low',
    intervals: 0, cycles: 0, observedPercent: 0, calibratedAt: null, modelMix: [], tokenMix: { ...EMPTY_MIX },
    warnings: [...BASE_WARNINGS] };
  const scope = scopeFor(sourceId, bucketId);
  if (!scope || !Number.isFinite(nowMs)) {
    return { ...result, reason: 'This limit cannot be matched safely to a known weekly token scope.' };
  }
  // A percentage read under a different allowance is a share of a different
  // whole. Rescaling it to the current allowance keeps the tokens-per-point
  // ratio of every earlier interval comparable with intervals measured now,
  // and turns the step at the change into ordinary rounding.
  const scaler = createAllowanceScaler(allowanceChanges, sourceId, { bucketId, windowMinutes: 10_080, nowMs });
  let rescaled = false;
  // When each figure was fetched, judged in time order: an undated redraw is
  // no newer than the first of its unbroken run.
  const ordered = (Array.isArray(observations) ? observations : []).filter((row) => row && typeof row === 'object')
    .sort((a, b) => (normaliseObservation(a).observedAt || 0) - (normaliseObservation(b).observedAt || 0));
  const evidence = new Map(evidenceTimes(ordered).map((at, index) => [ordered[index], at]));
  // How current each figure is known to be, which decides whether it is fresh.
  const known = new Map(evidenceTimes(ordered, { known: true }).map((at, index) => [ordered[index], at]));
  const allReadings = (Array.isArray(observations) ? observations : [])
    .map((row) => normalizeObservation(row, sourceId, bucketId, scope, nowMs, evidence, known)).filter(Boolean)
    .map((row) => {
      // A share of the allowance in force when the figure was fetched.
      const scale = scaler ? scaler(row.evidence) : 1;
      if (scale === 1) return row;
      rescaled = true;
      return { ...row, used: row.used * scale };
    })
    .sort((a, b) => a.at - b.at || Number(a.official) - Number(b.official));
  if (rescaled) result.warnings.push('Readings before a recorded allowance change were rescaled to the current allowance.');
  let readings = allReadings.filter((row) => row.official);
  if (!readings.length) return { ...result, reason: 'No valid official seven-day readings are available for this limit.' };
  // A plan name changing is only a calibration break when nothing says how
  // the allowance moved. A recorded change inside that transition already
  // rescaled the earlier readings, so their evidence stays comparable. Each
  // boundary is judged on its own, and history restarts after the latest
  // one nothing explains. A boundary spans from the last reading naming the
  // old plan to the first naming the new one: status-line and manual
  // readings carry no plan, and one in between must not hide the change.
  let cutoff = -1;
  let previousPlanned = -1;
  readings.forEach((row, index) => {
    if (!row.plan) return;
    if (previousPlanned >= 0 && row.plan !== readings[previousPlanned].plan
      && !scaler?.hasChangeBetween(readings[previousPlanned].at, row.at)) cutoff = index;
    previousPlanned = index;
  });
  if (cutoff > 0) {
    readings = readings.slice(cutoff);
    result.warnings.push('Earlier readings from a different plan were excluded.');
  }
  result.status = 'learning';
  // Transcript quota snapshots can lag the live account readings. Interleaving
  // them creates apparent corrections at every percentage step and continually
  // throws away the accumulating calibration interval. Prefer live readings
  // over the period they cover; retain transcript-only history outside it.
  const liveReadings = sourceId === 'codex' ? readings.filter((row) => row.provenance === 'official') : [];
  const calibrationReadings = liveReadings.length >= 2 ? readings.filter((row) =>
    row.provenance !== 'local-official' || row.at < liveReadings[0].at || row.at > liveReadings.at(-1).at) : readings;
  if (calibrationReadings.length < readings.length) {
    result.warnings.push('Live Codex readings take priority over overlapping transcript snapshots for calibration.');
  }
  const excluded = excludedIntervals(excludedDates);
  const intervals = [];
  // Intervals run between the moments the figures were fetched, not redrawn:
  // tokens used between a fetch and its later redraw belong to the next rise.
  let anchor = calibrationReadings[0], highWater = anchor.used, cycleReset = anchor.reset, cycle = 0, recovering = false;
  let excludedCount = 0, corrected = false, closeResets = false;
  for (const after of calibrationReadings.slice(1)) {
    // The first reset stays fixed for the entire cluster: chained small reset
    // shifts must not merge unrelated windows across a long observation gap.
    const resetChanged = Math.abs(after.reset - cycleReset) > RESET_TOLERANCE_MS;
    const gap = after.evidence - anchor.evidence;
    const idleRolling = anchor.used === 0 && after.used === 0 && gap > 0
      && Math.abs((after.reset - anchor.reset) - gap) <= RESET_TOLERANCE_MS + gap * 0.01;
    if (idleRolling) { anchor = after; cycleReset = after.reset; continue; }
    const rebased = highWater - after.used >= 5 && after.used <= 2;
    const pinnedAfterIdle = anchor.used === 0 && after.used > 0
      && after.reset - WEEK_MS >= anchor.evidence - RESET_TOLERANCE_MS
      && after.reset - WEEK_MS <= after.evidence + RESET_TOLERANCE_MS;
    if (resetChanged || rebased) {
      if (resetChanged && !pinnedAfterIdle && Math.abs(after.reset - cycleReset) < DAY_MS) closeResets = true;
      anchor = after; highWater = after.used; cycleReset = after.reset; cycle += 1; recovering = false;
      continue;
    }
    if (sourceId === 'codex' && (anchor.provenance === 'local-official') !== (after.provenance === 'local-official')) {
      // A source handoff has no known delay, so never match tokens across it.
      anchor = after; highWater = after.used; recovering = false;
      continue;
    }
    const closeMs = closingMs(after, anchor.evidence);
    if (excluded(anchor.evidence, closeMs ?? after.evidence)) {
      excludedCount += 1;
      highWater = Math.max(highWater, after.used);
      anchor = { ...after, used: highWater, evidence: Math.max(anchor.evidence, closeMs ?? after.evidence) };
      recovering = after.used < highWater;
      continue;
    }
    if (after.used < highWater - 1e-9 || recovering) {
      corrected = true;
      recovering = after.used <= highWater;
      highWater = Math.max(highWater, after.used);
      anchor = { ...after, used: highWater, evidence: Math.max(anchor.evidence, closeMs ?? after.evidence) };
      continue;
    }
    highWater = Math.max(highWater, after.used);
    const delta = after.used - anchor.used;
    if (delta < MIN_INTERVAL_PERCENT || closeMs == null) continue;
    intervals.push({ before: anchor.evidence, after: closeMs, delta, cycle, manual: anchor.manual || after.manual });
    anchor = { ...after, evidence: closeMs };
  }
  if (excludedCount) result.warnings.push('Intervals touching an ignored date were excluded from calibration.');
  if (corrected) result.warnings.push('Quota corrections and their recovery intervals were excluded.');
  if (closeResets) result.warnings.push('Reset times shifted within a day; confidence remains limited.');

  const ledger = (Array.isArray(events) ? events : []).map((row) => normalizeEvent(row, scope, nowMs))
    .filter(Boolean).sort((a, b) => a.at - b.at);
  const matched = [];
  let cursor = 0, missing = false, invalid = false;
  for (const interval of intervals) {
    while (cursor < ledger.length && ledger[cursor].at <= interval.before) cursor += 1;
    const item = { ...interval, tokens: 0, mix: { ...EMPTY_MIX }, models: new Map() };
    let invalidInterval = false;
    while (cursor < ledger.length && ledger[cursor].at <= interval.after) {
      const event = ledger[cursor++];
      if (event.invalid) { invalidInterval = true; continue; }
      item.tokens += event.tokens;
      item.models.set(event.model, (item.models.get(event.model) || 0) + event.tokens);
      for (const key of Object.keys(item.mix)) item.mix[key] += event.mix[key];
    }
    if (invalidInterval || !Number.isSafeInteger(item.tokens)) { invalid = true; continue; }
    if (!(item.tokens > 0)) { missing = true; continue; }
    item.capacity = item.tokens / item.delta * 100;
    item.weight = Math.min(item.delta, 20);
    matched.push(item);
  }
  if (missing) result.warnings.push('Some quota changes had no matching local token activity.');
  if (invalid) result.warnings.push('Intervals containing invalid token records were excluded.');

  // Inspect the newest evidence before trimming: a real workload switch must
  // not be discarded as an outlier simply because the older workload is common.
  // Require three compatible recent intervals so one unusual request cannot
  // select a new calibration pool by itself.
  const recent = matched.slice(-3);
  const recentMix = mixOf(recent);
  const mixChanged = matched.some((entry) => mixDistance(mixOf([entry]), recentMix) > 0.35);
  const recentCapacities = recent.map((entry) => entry.capacity);
  const coherentRecent = recent.length === 3
    && Math.max(...recentCapacities) <= Math.min(...recentCapacities) * 2
    && recent.every((entry) => mixDistance(mixOf([entry]), recentMix) <= 0.35);
  const comparable = coherentRecent ? matched.filter((entry) => mixDistance(mixOf([entry]), recentMix) <= 0.35) : matched;
  if (comparable.length < matched.length) result.warnings.push('Earlier intervals with a different model or token mix were excluded.');
  if (mixChanged) result.warnings.push('The model or cache/input/output mix changed; capacity may differ for your next workload.');
  // A single enormous interval must not set the headline. Require at least
  // three usable intervals even after obvious ratio outliers are removed.
  const median = weightedQuantile((coherentRecent ? recent : comparable).map((entry) => ({ ...entry, weight: 1 })), 0.5);
  const retained = comparable.length >= 3 ? comparable.filter((entry) => entry.capacity >= median / 4 && entry.capacity <= median * 4) : comparable;
  const inconsistent = retained.length < comparable.length;
  if (inconsistent) result.warnings.push('Highly inconsistent intervals were omitted; more matching activity will improve the estimate.');
  const mix = mixOf(retained);
  result.modelMix = [...mix.models].map(([model, share]) => ({ model, share })).sort((a, b) => b.share - a.share || a.model.localeCompare(b.model));
  result.tokenMix = mix.tokens;
  result.intervals = retained.length;
  result.cycles = new Set(retained.map((entry) => entry.cycle)).size;
  result.observedPercent = retained.reduce((sum, entry) => sum + entry.delta, 0);
  result.calibratedAt = retained.length ? new Date(retained.at(-1).after).toISOString() : null;
  if (retained.length < MIN_INTERVALS) {
    result.reason = 'Learning from official usage: at least three matched intervals of 5 percentage points are needed.';
    return result;
  }
  // Age is relative to the newest evidence, not wall time, so merely opening
  // the dashboard later cannot alter the calibrated weekly capacity. Nor is it
  // the last redraw, which may restate a fetch older than a later read: no
  // interval is newer than the reference, so no weight exceeds its size.
  const referenceAt = retained.reduce((latest, entry) => Math.max(latest, entry.after),
    readings.reduce((latest, row) => Math.max(latest, row.evidence), -Infinity));
  for (const entry of retained) {
    const distance = mixDistance(mixOf([entry]), recentMix);
    entry.weight *= Math.exp(-(referenceAt - entry.after) / (21 * DAY_MS)) * Math.max(0.2, 1 - distance * 0.8);
  }
  // Even a very recent large interval cannot outweigh every other interval
  // combined. Recency and sample size must never turn one outlier into the
  // apparent consensus of several observations.
  const totalWeight = retained.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of retained) entry.weight = Math.min(entry.weight, (totalWeight - entry.weight) * 0.99);
  if (retained.some((entry) => entry.manual)) result.warnings.push('Some calibration readings were entered manually.');
  const capacity = weightedQuantile(retained, 0.5);
  const low = Math.min(capacity * 0.75, weightedQuantile(retained, 0.2));
  const high = Math.max(capacity * 1.25, weightedQuantile(retained, 0.8));
  const broad = high / Math.max(1, low) > 2;
  if (broad) result.warnings.push('Observed capacity varies substantially between intervals.');
  result.status = 'available';
  result.weeklyTokens = roundedTokens(capacity);
  result.weeklyRange = { low: roundedTokens(low, 'floor'), high: roundedTokens(high, 'ceil') };
  result.confidence = retained.length >= 5 && result.cycles >= 2 && result.observedPercent >= 25
    && !mixChanged && !broad && !inconsistent && !missing && !invalid && !closeResets
    && !retained.some((entry) => entry.manual) ? 'medium' : 'low';

  const latestOfficial = readings.at(-1), latestAny = allReadings.at(-1);
  // A local estimate can see replenishment before the provider publishes a
  // new reset timestamp. Once that happens, the old official percentage is no
  // longer a current-window anchor, even if later estimates rise again.
  let previous = latestOfficial, unconfirmedRebase = false;
  for (const reading of allReadings) {
    if (reading.at <= latestOfficial.at) continue;
    if (!reading.official && previous.used - reading.used >= 5 && reading.used <= 2) unconfirmedRebase = true;
    previous = reading;
  }
  const currentMatches = latestAny && Math.abs(latestAny.reset - latestOfficial.reset) <= RESET_TOLERANCE_MS
    && (!latestAny.plan || !latestOfficial.plan || latestAny.plan === latestOfficial.plan);
  // The latest official figure is as current as its evidence, as on the card:
  // a status-line redraw re-records limits its session fetched earlier, unless
  // a newer reading of the same window shows the same figure. A reading from
  // before an early replenishment under the same reset belongs to the
  // allowance it replaced.
  let since = readings.length - 1;
  while (since > 0 && !(readings[since].confirms && Math.abs(readings[since].reset - readings[since - 1].reset) <= RESET_TOLERANCE_MS
    && readings[since - 1].used - readings[since].used >= 5 && readings[since].used <= 2)) since -= 1;
  const evidenceAt = readings.slice(since).reduce((latest, row) => (Math.abs(row.reset - latestOfficial.reset) <= RESET_TOLERANCE_MS
    && Math.abs(row.used - latestOfficial.used) <= 0.5 ? Math.max(latest, row.known) : latest), latestOfficial.known);
  if (unconfirmedRebase) result.warnings.push('A newer non-official reading suggests the allowance was reset; remaining tokens need a fresh official reading.');
  else if (!currentMatches) result.warnings.push('The current allowance window has no matching official reading; remaining tokens are unavailable.');
  else if (latestOfficial.reset <= nowMs) result.warnings.push('The latest official allowance has expired; remaining tokens need a fresh reading.');
  else if (nowMs - evidenceAt > STALENESS_MS) result.warnings.push('The latest official reading is over 24 hours old; remaining tokens need a fresh reading.');
  else {
    const remaining = (100 - latestOfficial.used) / 100;
    result.remainingTokens = roundedTokens(capacity * remaining);
    result.remainingRange = { low: roundedTokens(low * remaining, 'floor'), high: roundedTokens(high * remaining, 'ceil') };
    result.remainingAsOf = new Date(evidenceAt).toISOString();
  }
  return result;
}

module.exports = { estimateTokenCapacity, LOOKBACK_MS, STALENESS_MS };
