'use strict';

const { asIso } = require('./time.cjs');
const { selectDisplayedWindows } = require('./quota-selection.cjs');
const { QUOTA_CLOCK_SKEW_MS, validQuotaTime } = require('./quota-time.cjs');

const FABLE_SOURCE_ID = 'claude-fable';
const FABLE_BUCKET_ID = 'fable_seven_day';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const { OFFICIAL_PROVENANCES, isProviderProvenance } = require('./quota-provenance.mjs');
const { freshnessLimitHours } = require('./dashboard-decision.cjs');
const { evidenceTimes, freshReadGraceFor, latestEvidenceAt, withoutStaleRestatements } = require('./forecast.cjs');
const { PROVIDER_WINDOW_DESCRIPTORS } = require('./claude-window-descriptors.cjs');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asUtilization(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : null;
}

function isFableLabel(value) {
  return typeof value === 'string' && /(?:^|[^a-z0-9])fable(?:[^a-z0-9]|$)/i.test(value);
}

function invalid(reason) {
  return { kind: 'invalid', reason };
}

function normalizeWindow(value, label) {
  if (value == null) return { kind: 'absent' };
  if (!isRecord(value)) return invalid(`${label} must be an object or null`);
  if (value.utilization == null || value.resets_at == null) return { kind: 'absent' };
  const utilization = asUtilization(value.utilization);
  const resetsAt = asIso(value.resets_at);
  if (utilization == null || resetsAt == null) return invalid(`${label} has an invalid utilization or reset time`);
  return { kind: 'window', utilization, resetsAt };
}

function normalizeExtraUsage(value) {
  if (value == null) return { kind: 'extra-usage', value: null };
  if (!isRecord(value) || typeof value.is_enabled !== 'boolean') {
    return invalid('extra_usage must contain a boolean is_enabled value');
  }
  const nonNegativeNumberOrNull = (candidate) => candidate === null
    || (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0);
  if (!nonNegativeNumberOrNull(value.monthly_limit)
    || !nonNegativeNumberOrNull(value.used_credits)) {
    return invalid('extra_usage limits and credits must be non-negative numbers or null');
  }
  const utilization = value.utilization === null ? null : asUtilization(value.utilization);
  if (value.utilization !== null && utilization == null) {
    return invalid('extra_usage utilization must be between 0 and 100 or null');
  }
  if (value.currency !== undefined && value.currency !== null && typeof value.currency !== 'string') {
    return invalid('extra_usage currency must be a string or null');
  }
  const extraUsage = {
    isEnabled: value.is_enabled,
    monthlyLimit: value.monthly_limit,
    usedCredits: value.used_credits,
    utilization,
  };
  if (value.currency !== undefined) extraUsage.currency = value.currency;
  return { kind: 'extra-usage', value: extraUsage };
}

function modelScopedBucketId(displayName) {
  return `model_scoped:${encodeURIComponent(displayName.trim().toLowerCase())}`;
}

// The provider method is explicitly experimental. Validate the complete slice
// we consume before writing any of it; a half-valid response must not turn into
// authoritative history merely because one nested value happened to parse.
function normalizeUsagePayload(payload, observedAt) {
  if (!isRecord(payload)) return invalid('usage response must be an object');
  if (typeof payload.rate_limits_available !== 'boolean') return invalid('rate_limits_available must be boolean');
  if (payload.subscription_type != null && typeof payload.subscription_type !== 'string') {
    return invalid('subscription_type must be a string or null');
  }
  const planType = payload.subscription_type || null;
  if (!payload.rate_limits_available || payload.rate_limits == null) {
    return {
      kind: 'unavailable', reason: 'plan-window-unavailable', planType, overall: [], extraUsage: null,
    };
  }
  if (!isRecord(payload.rate_limits)) return invalid('rate_limits must be an object or null');

  const normalizedExtraUsage = normalizeExtraUsage(payload.rate_limits.extra_usage);
  if (normalizedExtraUsage.kind === 'invalid') return normalizedExtraUsage;
  const extraUsage = normalizedExtraUsage.value;

  const overall = [];
  for (const descriptor of PROVIDER_WINDOW_DESCRIPTORS) {
    const normalized = normalizeWindow(payload.rate_limits[descriptor.key], descriptor.key);
    if (normalized.kind === 'invalid') return normalized;
    if (normalized.kind === 'window') {
      overall.push({
        bucketId: descriptor.key,
        bucketName: descriptor.bucketName,
        windowMinutes: descriptor.windowMinutes,
        scope: descriptor.scope,
        utilization: normalized.utilization,
        resetsAt: normalized.resetsAt,
      });
    }
  }

  const scoped = payload.rate_limits.model_scoped;
  if (scoped === undefined) return {
    kind: 'unavailable', reason: 'fable-window-unavailable', planType, overall, extraUsage,
  };
  if (!Array.isArray(scoped)) return invalid('model_scoped must be an array when present');

  const fable = [];
  const otherModels = new Map();
  for (const entry of scoped) {
    if (!isRecord(entry) || typeof entry.display_name !== 'string' || !entry.display_name.trim()) {
      return invalid('every model_scoped entry must have a display name');
    }
    const displayName = entry.display_name.trim();
    const normalized = normalizeWindow(entry, `model_scoped:${displayName}`);
    if (normalized.kind === 'invalid') return normalized;
    if (isFableLabel(entry.display_name)) {
      fable.push({ displayName, ...normalized });
    } else if (normalized.kind === 'window') {
      const bucketId = modelScopedBucketId(displayName);
      const existing = otherModels.get(bucketId);
      if (existing
        && (existing.utilization !== normalized.utilization || existing.resetsAt !== normalized.resetsAt)) {
        return invalid(`conflicting ${displayName} model-scoped windows`);
      }
      if (!existing) {
        const providerWindow = {
          bucketId,
          bucketName: `${displayName} weekly`,
          windowMinutes: 10_080,
          scope: 'model',
          displayName,
          utilization: normalized.utilization,
          resetsAt: normalized.resetsAt,
        };
        otherModels.set(bucketId, providerWindow);
        overall.push(providerWindow);
      }
    }
  }
  if (!fable.length) return {
    kind: 'unavailable', reason: 'fable-window-unavailable', planType, overall, extraUsage,
  };
  if (fable.some((entry) => entry.kind !== 'window')) {
    return {
      kind: 'unavailable', reason: 'fable-window-incomplete', planType, overall, extraUsage,
    };
  }
  const first = fable[0];
  if (fable.some((entry) => entry.utilization !== first.utilization || entry.resetsAt !== first.resetsAt)) {
    // Fable 5 and Fable 5.1 share one allowance, reported as one "Fable"
    // window. Two that disagree cannot both be it, but they say nothing
    // against the overall windows in the same payload, which are kept.
    return {
      kind: 'unavailable', reason: 'fable-window-conflict', planType, overall, extraUsage,
    };
  }
  if (Date.parse(first.resetsAt) <= Date.parse(observedAt)) {
    return {
      kind: 'unavailable', reason: 'fable-window-expired', planType, overall, extraUsage,
    };
  }
  return {
    kind: 'observed',
    planType,
    overall,
    extraUsage,
    fable: first,
  };
}

function recordProviderWindows(store, normalized, observedAt) {
  // UsageStore's writes are synchronous. The store's transaction makes
  // validation plus persistence all-or-nothing without exposing transaction
  // choreography to the tracker caller.
  return store.transaction(() => {
    let overallWindowsRecorded = 0;
    for (const window of normalized.overall) {
      if (Date.parse(window.resetsAt) <= Date.parse(observedAt)) continue;
      const metadata = { scope: window.scope, source: 'claude-usage' };
      if (window.displayName) metadata.displayName = window.displayName;
      if (normalized.extraUsage) metadata.extraUsage = normalized.extraUsage;
      store.recordObservation({
        sourceId: 'claude',
        bucketId: window.bucketId,
        bucketName: window.bucketName,
        observedAt,
        usedPercent: window.utilization,
        remainingPercent: 100 - window.utilization,
        resetsAt: window.resetsAt,
        windowMinutes: window.windowMinutes,
        planType: normalized.planType,
        provenance: 'official-claude-usage',
        confidence: 1,
        metadata,
      });
      overallWindowsRecorded += 1;
    }
    if (normalized.kind === 'observed') {
      store.recordObservation({
        sourceId: FABLE_SOURCE_ID,
        bucketId: FABLE_BUCKET_ID,
        bucketName: 'Fable weekly',
        observedAt,
        usedPercent: normalized.fable.utilization,
        remainingPercent: 100 - normalized.fable.utilization,
        resetsAt: normalized.fable.resetsAt,
        windowMinutes: 10_080,
        planType: normalized.planType,
        provenance: 'official-claude-usage',
        confidence: 1,
        metadata: {
          scope: 'model',
          source: 'claude-usage',
          displayName: normalized.fable.displayName,
          ...(normalized.extraUsage ? { extraUsage: normalized.extraUsage } : {}),
        },
      });
    }
    return overallWindowsRecorded;
  });
}

// The official Fable window the card would headline, chosen the way getQuota
// chooses it: a bucket collapses to its latest usable reading first, and
// only then does window-level precedence apply. Ranking every historical
// reading of the bucket instead let an older provider reading outrank a
// newer manual correction the card was already showing. The card also holds
// back a stale status-line restatement and dates its figure by the newest
// reading that shows it (`evidence_at`), so this reads the week the same way:
// an idle session redraws every minute, and fifty rows can be under an hour.
function getLastCurrentOfficial(store, nowMs) {
  const placeholders = OFFICIAL_PROVENANCES.map(() => '?').join(', ');
  const rows = store.prepare(`
    SELECT * FROM quota_observations
    WHERE source_id = ? AND bucket_id = ? AND provenance IN (${placeholders}) AND observed_at <= ? AND observed_at >= ?
    ORDER BY observed_at ASC, id ASC
  `).all(FABLE_SOURCE_ID, FABLE_BUCKET_ID, ...OFFICIAL_PROVENANCES, new Date(nowMs + QUOTA_CLOCK_SKEW_MS).toISOString(),
    new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString())
    .filter((row) => validQuotaTime(Date.parse(row.observed_at), Date.parse(row.resets_at), row.window_minutes, nowMs));
  const accepted = withoutStaleRestatements(rows, { nowMs, freshReadGraceMs: freshReadGraceFor(store.getSettings()) });
  if (!accepted.length) return null;
  // A manual entry can be the allowance, but never evidence that the provider
  // was read recently: a provider figure is dated by provider readings alone.
  const chosen = accepted.at(-1);
  const evidence = isProviderProvenance(chosen.provenance)
    ? latestEvidenceAt(accepted.filter((row) => isProviderProvenance(row.provenance))) : Date.parse(chosen.observed_at);
  // Its own fetch as well, for the Refresh fallback, which must not borrow an
  // earlier read's time.
  const latest = { ...chosen, evidence_at: new Date(evidence).toISOString(),
    own_evidence_at: new Date(evidenceTimes(accepted).at(-1)).toISOString() };
  const window = { row: latest, bucketId: latest.bucket_id, observedAt: latest.observed_at, resetsAt: latest.resets_at,
    windowMinutes: latest.window_minutes, provenance: latest.provenance, metadata: {} };
  return selectDisplayedWindows([window], { nowMs }).active[0]?.row ?? null;
}

// A stored reading's own fetch: a status-line redraw can re-record limits its
// session fetched hours earlier. `own_evidence_at` when the caller judged it
// among its window's readings; alone, an undated redraw is its own run.
function ownFetchMs(row) {
  return row.own_evidence_at ? Date.parse(row.own_evidence_at) : evidenceTimes([row])[0];
}

// The moment a stored reading's value is evidence of: `evidence_at` when the
// caller measured it against the rest of the window, or else its own fetch.
function readingEvidenceMs(row) {
  return row.evidence_at ? Date.parse(row.evidence_at) : ownFetchMs(row);
}

// Whether a provider reading (the SDK or the status line, never a manual
// entry) is recent enough to stand as current evidence on a refresh that did
// not ask the provider. The rule is the dashboard verdict's own.
function providerReadingFresh(row, nowMs) {
  if (!row || !isProviderProvenance(row.provenance)) return false;
  const ageMs = nowMs - readingEvidenceMs(row);
  return ageMs >= -QUOTA_CLOCK_SKEW_MS
    && ageMs <= freshnessLimitHours({ windowMinutes: row.window_minutes }) * 60 * 60 * 1000;
}

function allowanceFromRow(row) {
  return {
    kind: 'official',
    usedPercent: row.used_percent,
    remainingPercent: row.remaining_percent,
    resetsAt: row.resets_at,
    observedAt: row.observed_at,
    // When the figure was last known to hold, which the status text quotes.
    evidenceAt: new Date(readingEvidenceMs(row)).toISOString(),
    source: row.provenance === 'official-claude-usage'
      ? 'claude-usage-model-scoped'
      : row.provenance === 'official-statusline'
        ? 'claude-statusline-model-scoped'
        : 'manual-official',
  };
}

function localFableActivity(store, nowMs, allowance) {
  const resetMs = allowance?.kind === 'official' ? Date.parse(allowance.resetsAt) : Number.NaN;
  const sinceMs = Number.isFinite(resetMs) ? resetMs - WEEK_MS : nowMs - WEEK_MS;
  const since = new Date(sinceMs).toISOString();
  const through = new Date(nowMs).toISOString();
  const row = store.prepare(`
    SELECT COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
      COALESCE(SUM(cache_write_5m_input_tokens), 0) AS cache_write_5m_input_tokens,
      COALESCE(SUM(cache_write_1h_input_tokens), 0) AS cache_write_1h_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens
    FROM usage_events
    WHERE source_id = 'claude' AND occurred_at >= ? AND occurred_at <= ?
      AND LOWER(COALESCE(model, '')) LIKE '%fable%'
  `).get(since, through);
  // Fable 5 and Fable 5.1 draw on the same allowance, so the totals above
  // cover both; the versions seen are kept for diagnostics.
  const models = store.prepare(`
    SELECT model, COUNT(*) AS requests FROM usage_events
    WHERE source_id = 'claude' AND occurred_at >= ? AND occurred_at <= ?
      AND LOWER(COALESCE(model, '')) LIKE '%fable%'
    GROUP BY model ORDER BY requests DESC, model ASC
  `).all(since, through).map((entry) => ({ model: String(entry.model), requests: Number(entry.requests || 0) }));
  return {
    scope: 'this-device',
    models,
    since,
    through,
    requests: Number(row.requests || 0),
    inputTokens: Number(row.input_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0),
    cacheWriteInputTokens: Number(row.cache_write_input_tokens || 0),
    cacheWrite5mInputTokens: Number(row.cache_write_5m_input_tokens || 0),
    cacheWrite1hInputTokens: Number(row.cache_write_1h_input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    reasoningOutputTokens: Number(row.reasoning_output_tokens || 0),
  };
}

function previousActivitySuccess(store) {
  try {
    const row = store.prepare("SELECT metadata_json FROM sources WHERE id = 'claude-fable'").get();
    const metadata = JSON.parse(row?.metadata_json || '{}');
    const value = metadata?.automatic?.health?.activityLastSuccessfulAt;
    return asIso(value);
  } catch {
    return null;
  }
}

// `usagePort` is null when this refresh was not asked to read plan usage
// (every automatic refresh). Nothing contacts the provider then, and the
// provider outcome is 'not-requested': neither a success nor a failure.
function createFableUsageTracker({ store, usagePort, activityReader, clock = () => new Date() }) {
  if (!store?.db || typeof store.recordObservation !== 'function') throw new TypeError('A UsageStore is required.');
  if (usagePort !== null && typeof usagePort?.read !== 'function') {
    throw new TypeError('usagePort.read is required, or usagePort must be null when plan usage was not requested.');
  }
  const planUsageRequested = usagePort !== null;
  if (typeof activityReader?.import !== 'function') throw new TypeError('activityReader.import is required.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  async function performRefresh(options = {}) {
    const now = clock();
    let nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error('The tracker clock returned an invalid time.');
    let refreshedAt = new Date(nowMs).toISOString();
    const fallbackObservedAt = options.fallbackObservedAt == null
      ? null : asIso(options.fallbackObservedAt);
    if (options.fallbackObservedAt != null && fallbackObservedAt == null) {
      throw new TypeError('fallbackObservedAt must be a valid ISO date and time.');
    }

    // Wall-clock cost of each surface, for the diagnostics panel.
    const timed = (run) => {
      const startedAt = Date.now();
      let elapsedMs;
      const promise = Promise.resolve().then(run).finally(() => { elapsedMs = Date.now() - startedAt; });
      return { promise, elapsed: () => elapsedMs };
    };
    // Finish synchronous imports before starting the SDK timeout clock.
    const activityRead = timed(() => activityReader.import({ signal: options.signal }));
    const [activityResult] = await Promise.allSettled([activityRead.promise]);
    const usageRead = planUsageRequested ? timed(() => usagePort.read({ signal: options.signal })) : null;
    const [usageResult] = usageRead ? await Promise.allSettled([usageRead.promise]) : [null];
    const fetched = clock();
    nowMs = fetched instanceof Date ? fetched.getTime() : new Date(fetched).getTime();
    if (!Number.isFinite(nowMs)) throw new Error('The tracker clock returned an invalid time.');
    refreshedAt = new Date(nowMs).toISOString();
    const usageDurationMs = usageRead ? usageRead.elapsed() : null;
    const activityDurationMs = activityRead.elapsed();

    let normalized;
    let providerFailure = null;
    let overallWindowsRecorded = 0;
    if (usageResult?.status === 'fulfilled') normalized = normalizeUsagePayload(usageResult.value, refreshedAt);
    else if (usageResult) providerFailure = usageResult.reason instanceof Error
      ? usageResult.reason : new Error(String(usageResult.reason || 'Unknown provider failure'));

    if (normalized && !providerFailure && normalized.kind !== 'invalid'
      && (normalized.kind === 'observed' || normalized.overall.length)) {
      try {
        overallWindowsRecorded = recordProviderWindows(store, normalized, refreshedAt);
      } catch (error) {
        providerFailure = error;
      }
    }

    const cached = getLastCurrentOfficial(store, nowMs);
    // A redraw this refresh imported stands in for the provider only if its
    // own session is known to have fetched the limits in the last few
    // minutes; an earlier read that agrees with it is not new evidence from
    // this refresh, and a session first seen with limits in hand may have
    // fetched them long before its first redraw.
    const freshStatuslineFallback = Boolean(cached
      && fallbackObservedAt
      && cached.provenance === 'official-statusline'
      && cached.observed_at === fallbackObservedAt
      && cached.fetched_after != null
      && nowMs - ownFetchMs(cached) <= 5 * 60_000
      && Date.parse(fallbackObservedAt) <= nowMs + QUOTA_CLOCK_SKEW_MS);
    let allowance;
    let officialSource;
    let state;
    const details = [];

    if (!planUsageRequested) {
      // Not asked this time: the last official reading stays the allowance,
      // judged by its age rather than marked stale for not being re-read.
      if (cached) {
        const fresh = freshStatuslineFallback || providerReadingFresh(cached, nowMs);
        allowance = allowanceFromRow(cached);
        officialSource = fresh ? 'connected' : 'not-requested';
        state = fresh ? 'current' : 'stale';
      } else {
        allowance = { kind: 'unavailable', reason: 'not-requested' };
        officialSource = 'not-requested';
        state = 'waiting';
      }
    } else if (!providerFailure && normalized.kind === 'observed') {
      // `cached` was read after this refresh's windows were recorded, so it
      // is already the row a second query would return.
      allowance = allowanceFromRow(cached);
      officialSource = 'connected';
      state = 'current';
    } else if (cached) {
      allowance = allowanceFromRow(cached);
      officialSource = freshStatuslineFallback
        ? 'connected'
        : normalized?.kind === 'invalid' ? 'unsupported' : 'temporarily-unavailable';
      state = freshStatuslineFallback ? 'current' : 'stale';
    } else if (providerFailure) {
      allowance = { kind: 'unavailable', reason: 'provider-error' };
      officialSource = 'temporarily-unavailable';
      state = 'degraded';
    } else if (normalized.kind === 'invalid') {
      allowance = { kind: 'unavailable', reason: 'invalid-provider-data' };
      officialSource = 'unsupported';
      state = 'degraded';
    } else {
      allowance = { kind: 'unavailable', reason: normalized.reason };
      officialSource = 'temporarily-unavailable';
      state = 'waiting';
    }

    if (providerFailure) details.push(providerFailure.message);
    else if (normalized?.kind === 'invalid') details.push(normalized.reason);
    else if (normalized?.kind === 'unavailable') details.push(normalized.reason);

    const activity = localFableActivity(store, nowMs, allowance);
    let activitySource = 'current';
    let activityLastSuccessfulAt = previousActivitySuccess(store);
    const partialRead = activityResult.status === 'fulfilled' && Number(activityResult.value?.readErrors) > 0;
    if (activityResult.status === 'rejected' || partialRead) {
      activitySource = activity.requests ? 'stale' : 'temporarily-unavailable';
      details.push(partialRead
        ? `${activityResult.value.readErrors} transcript file(s) could not be read (${activityResult.value.lastReadError || 'unknown error'}); they will be retried.`
        : activityResult.reason?.message || String(activityResult.reason || 'Local activity import failed'));
      if (state === 'current') state = 'degraded';
    } else {
      activityLastSuccessfulAt = refreshedAt;
    }

    const collectionDiagnostics = usageResult && (usageResult.status === 'fulfilled'
      ? usageResult.value : usageResult.reason)?.collectionDiagnostics;
    return {
      refreshedAt,
      allowance,
      activity,
      provider: !planUsageRequested ? {
        kind: 'not-requested',
        attempted: false,
        attemptSucceeded: false,
        overallWindowsRecorded: 0,
        extraUsage: null,
        durationMs: null,
        errorCode: null,
      } : {
        attemptSucceeded: usageResult.status === 'fulfilled',
        kind: providerFailure ? 'failed' : normalized.kind,
        overallWindowsRecorded,
        extraUsage: normalized?.kind !== 'invalid' ? normalized?.extraUsage ?? null : null,
        durationMs: usageDurationMs,
        errorCode: providerFailure?.code || null,
        ...(collectionDiagnostics ? { collectionDiagnostics } : {}),
      },
      health: {
        state,
        officialSource,
        activitySource,
        activityLastSuccessfulAt,
        activityDurationMs,
        detail: details.join(' '),
      },
      imports: activityResult.status === 'fulfilled' ? activityResult.value : null,
    };
  }

  return {
    refresh: performRefresh,
  };
}

module.exports = {
  getLastCurrentOfficial, createFableUsageTracker, providerReadingFresh, OFFICIAL_PROVENANCES };
