import { selectDisplayedWindows } from './quota-selection.mjs';

export function subscriptionVisible(settings, providerId) {
  return settings?.[providerId === 'codex' ? 'showCodexSubscription' : 'showClaudeSubscription'] !== false;
}

// The subscriptions the dashboard, tray and notifications all reason about,
// in display order: snapshot quota key, source-health id, and label.
export const SOURCES = [
  { id: 'codex', healthId: 'codex', label: 'Codex' },
  { id: 'claude', healthId: 'claude', label: 'Claude' },
  { id: 'fable', healthId: 'claude-fable', label: 'Fable 5' },
];

const ACTIONABLE_STATES = ['critical', 'risk', 'watch'];
const KNOWN_STATES = new Set([...ACTIONABLE_STATES, 'safe', 'unknown']);

function quotaWindows(quota) {
  if (!quota) return [];
  const windows = Array.isArray(quota.windows) && quota.windows.length ? quota.windows : [quota];
  // Historical buckets remain useful in Details, but only currently active
  // allowance windows can affect burn-rate safety. If every bucket is expired,
  // keep the one the card headlines so the provider stays explicitly unknown.
  const selection = selectDisplayedWindows(windows);
  return selection.active.length ? selection.active : selection.primary ? [selection.primary] : [];
}

function windowState(window) {
  if (!window || window.forecast?.expired) return 'unknown';
  const state = window.forecast?.state;
  return KNOWN_STATES.has(state) ? state : 'unknown';
}

function windowLabel(sourceLabel, window) {
  const bucket = window?.bucketName || window?.bucketId;
  return bucket ? `${sourceLabel} · ${bucket}` : sourceLabel;
}

function unique(values) {
  return [...new Set(values)];
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function providerNames(labels) {
  return unique(labels.map((label) => String(label).split(' · ')[0].trim()));
}

function forecastReasons(state, forecast = {}, paceRiskThreshold = 1.2) {
  if (state === 'critical') return ['expected-exhaustion'];
  if (state === 'watch') return ['watch'];
  if (state !== 'risk') return [];
  const reasons = [];
  const heavyExhausts = Boolean(forecast.heavyExhaustsAt)
    || (Number.isFinite(forecast.heavyRemaining) && forecast.heavyRemaining <= 0);
  if (heavyExhausts) reasons.push('heavy-exhaustion');
  if ((Number.isFinite(forecast.paceRatio) && forecast.paceRatio > paceRiskThreshold) || !reasons.length) reasons.push('pace');
  return reasons;
}

function actionableLabel(state, affected, reason, details, assessed) {
  if (reason === 'mixed') return `${details.length} ${details.length === 1 ? 'allowance needs' : 'allowances need'} attention`;
  const only = details.length === 1 ? details[0] : null;
  const sameSourceWindows = only ? assessed.filter((entry) => entry.sourceId === only.sourceId).length : 0;
  const names = only && sameSourceWindows > 1
    ? [`${only.sourceLabel} ${only.bucketName || only.bucketId}`]
    : providerNames(affected);
  const subject = joinNames(names);
  const plural = names.length > 1;
  if (state === 'critical') {
    return `${subject} ${plural ? 'will reach their limits' : 'will reach its limit'} before reset`;
  }
  if (reason === 'heavy-exhaustion') {
    return `${subject} could reach ${plural ? 'their limits' : 'its limit'} under heavier usage`;
  }
  if (state === 'risk') {
    return `${subject} ${plural ? 'are' : 'is'} above ${plural ? 'their' : 'its'} safe pace`;
  }
  return `${subject} ${plural ? 'are' : 'is'} running warm`;
}

export function freshnessLimitHours(window) {
  const minutes = Number(window?.windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 24;
  // Short windows need proportionally recent evidence. Weekly windows can
  // tolerate an overnight gap, but never a multi-day silent collector.
  return Math.min(24, Math.max(0.5, (minutes / 60) * 0.2));
}

export function evidenceNeedsRefresh(window) {
  const staleHours = Number(window?.forecast?.staleHours);
  return Number.isFinite(staleHours) && staleHours > freshnessLimitHours(window);
}

export function buildDashboardVerdict(snapshot = {}) {
  const quotas = snapshot.quotas || {};
  const sourceHealth = new Map((snapshot.sources || []).map((source) => [source.id, source]));
  const assessed = [];
  const missing = [];
  const staleSources = [];

  for (const source of SOURCES) {
    if (!subscriptionVisible(snapshot.settings, source.id)) continue;
    const windows = quotaWindows(quotas[source.id]);
    if (!windows.length) {
      missing.push(source.label);
      continue;
    }
    for (const window of windows) {
      assessed.push({
        sourceId: source.id,
        sourceLabel: source.label,
        bucketId: window.bucketId || '',
        bucketName: window.bucketName || window.bucketId || '',
        state: windowState(window),
        label: windowLabel(source.label, window),
        forecast: window.forecast,
      });
      const health = sourceHealth.get(source.healthId);
      if (['error', 'stale', 'degraded'].includes(health?.status) || evidenceNeedsRefresh(window)) {
        staleSources.push(source.label);
      }
    }
  }

  if (!assessed.length && !missing.length) {
    return { state: 'unknown', reason: null, label: 'No subscriptions shown', windowsChecked: 0, affected: [], details: [] };
  }

  const actionable = ACTIONABLE_STATES.find((state) => assessed.some((entry) => entry.state === state));
  if (actionable) {
    const affectedEntries = assessed.filter((entry) => entry.state === actionable);
    const affected = unique(affectedEntries.map((entry) => entry.label));
    const details = affectedEntries.map((entry) => ({
      sourceId: entry.sourceId,
      sourceLabel: entry.sourceLabel,
      bucketId: entry.bucketId,
      bucketName: entry.bucketName,
      state: entry.state,
      reasons: forecastReasons(entry.state, entry.forecast, snapshot.settings?.paceRiskThreshold ?? 1.2),
      expectedRemaining: Number.isFinite(entry.forecast?.expectedRemaining) ? entry.forecast.expectedRemaining : null,
      heavyRemaining: Number.isFinite(entry.forecast?.heavyRemaining) ? entry.forecast.heavyRemaining : null,
      exhaustsAt: entry.forecast?.exhaustsAt || null,
      heavyExhaustsAt: entry.forecast?.heavyExhaustsAt || null,
      paceRatio: Number.isFinite(entry.forecast?.paceRatio) ? entry.forecast.paceRatio : 0,
    }));
    const reasons = unique(details.flatMap((entry) => entry.reasons));
    const reason = reasons.length === 1 || details.length === 1 ? reasons[0] : 'mixed';
    return {
      state: actionable,
      reason,
      label: actionableLabel(actionable, affected, reason, details, assessed),
      windowsChecked: assessed.length,
      affected,
      details,
    };
  }

  const unknown = unique([
    ...missing,
    ...assessed.filter((entry) => entry.state === 'unknown').map((entry) => entry.label),
  ]);
  if (unknown.length) {
    return {
      state: 'unknown',
      reason: null,
      label: `Usage status needs data: ${unknown.join(', ')}`,
      windowsChecked: assessed.length,
      affected: unknown,
      details: [],
    };
  }

  const needsCurrentData = unique(staleSources);
  if (needsCurrentData.length) {
    return {
      state: 'unknown',
      reason: null,
      label: `Allowance check needs current data: ${needsCurrentData.join(', ')}`,
      windowsChecked: assessed.length,
      affected: needsCurrentData,
      details: [],
    };
  }

  return {
    state: 'safe',
    reason: null,
    label: 'All allowances on track',
    windowsChecked: assessed.length,
    affected: [],
    details: [],
  };
}
