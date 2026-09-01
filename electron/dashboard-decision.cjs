'use strict';

const SOURCES = [
  { id: 'codex', healthId: 'codex', label: 'Codex' },
  { id: 'claude', healthId: 'claude', label: 'Claude' },
  { id: 'fable', healthId: 'claude-fable', label: 'Fable 5' },
];

const ACTIONABLE_STATES = ['critical', 'risk', 'watch'];
const KNOWN_STATES = new Set([...ACTIONABLE_STATES, 'safe', 'unknown']);

function quotaWindows(quota) {
  if (!quota) return [];
  const windows = Array.isArray(quota.windows) && quota.windows.length ? quota.windows : [quota];
  const active = windows.filter((window) => !window?.forecast?.expired);
  // Historical buckets remain useful in Details, but only currently active
  // allowance windows can affect burn-rate safety. If every bucket is expired,
  // keep one so the provider remains explicitly unknown rather than vanishing.
  return active.length ? active : windows.slice(0, 1);
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

function freshnessLimitHours(window) {
  const minutes = Number(window?.windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 24;
  // Short windows need proportionally recent evidence. Weekly windows can
  // tolerate an overnight gap, but never a multi-day silent collector.
  return Math.min(24, Math.max(0.5, (minutes / 60) * 0.2));
}

function evidenceNeedsRefresh(window) {
  const staleHours = Number(window?.forecast?.staleHours);
  return Number.isFinite(staleHours) && staleHours > freshnessLimitHours(window);
}

function buildDashboardVerdict(snapshot = {}) {
  const quotas = snapshot.quotas || {};
  const sourceHealth = new Map((snapshot.sources || []).map((source) => [source.id, source]));
  const assessed = [];
  const missing = [];
  const staleSources = [];

  for (const source of SOURCES) {
    const windows = quotaWindows(quotas[source.id]);
    if (!windows.length) {
      missing.push(source.label);
      continue;
    }
    for (const window of windows) {
      assessed.push({
        state: windowState(window),
        label: windowLabel(source.label, window),
      });
      const health = sourceHealth.get(source.healthId);
      if (['error', 'stale', 'degraded'].includes(health?.status) || evidenceNeedsRefresh(window)) {
        staleSources.push(source.label);
      }
    }
  }

  const actionable = ACTIONABLE_STATES.find((state) => assessed.some((entry) => entry.state === state));
  if (actionable) {
    const affected = unique(assessed.filter((entry) => entry.state === actionable).map((entry) => entry.label));
    return {
      state: actionable,
      label: actionable === 'watch'
        ? `${affected.join(' and ')} running warm`
        : `${affected.join(' and ')} may hit the limit`,
      windowsChecked: assessed.length,
      affected,
    };
  }

  const unknown = unique([
    ...missing,
    ...assessed.filter((entry) => entry.state === 'unknown').map((entry) => entry.label),
  ]);
  if (unknown.length) {
    return {
      state: 'unknown',
      label: `Usage status needs data: ${unknown.join(', ')}`,
      windowsChecked: assessed.length,
      affected: unknown,
    };
  }

  const needsCurrentData = unique(staleSources);
  if (needsCurrentData.length) {
    return {
      state: 'unknown',
      label: `Allowance check needs current data: ${needsCurrentData.join(', ')}`,
      windowsChecked: assessed.length,
      affected: needsCurrentData,
    };
  }

  return {
    state: 'safe',
    label: 'All allowances on track',
    windowsChecked: assessed.length,
    affected: [],
  };
}

module.exports = { buildDashboardVerdict };
