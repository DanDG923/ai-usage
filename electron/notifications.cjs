'use strict';

const { subscriptionVisible } = require('./dashboard-decision.cjs');
const visibleSources = (snapshot) => SOURCES.filter((source) => subscriptionVisible(snapshot?.settings, source.key));

const { localDayKey } = require('./time.cjs');

// One ongoing risk episode is worth one notification, not one per refresh.
const RISK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SOURCES = [
  { key: 'codex', healthId: 'codex', label: 'Codex' },
  { key: 'claude', healthId: 'claude', label: 'Claude' },
  { key: 'fable', healthId: 'claude-fable', label: 'Fable 5' },
];
const HEALTHY = new Set(['connected', 'ready', 'observing', 'estimating', 'activity-only']);
const FALLEN_BACK = new Set(['stale', 'degraded', 'error']);

function emptyState() {
  return {
    lastRiskSignature: '',
    lastRiskNotifiedAt: 0,
    lastResetSignatures: {},
    lastFallbackSignatures: {},
    lastDigestDay: null,
  };
}

function quotaWindows(quota) {
  if (!quota) return [];
  return Array.isArray(quota.windows) && quota.windows.length ? quota.windows : [quota];
}

// The longest active window headlines, matching the dashboard weekly card.
function primaryWindow(quota) {
  if (!quota) return null;
  const windows = quotaWindows(quota);
  const active = windows.filter((window) => !window?.forecast?.expired);
  const candidates = active.length ? active : windows;
  if (!candidates.length) return null;
  const mainCodex = candidates.filter((window) => window.metadata?.limitId === 'codex' || /^codex:(primary|secondary|weekly)$/.test(window.bucketId));
  return (mainCodex.length ? mainCodex : candidates).reduce((longest, window) =>
    (window?.windowMinutes || 0) > (longest?.windowMinutes || 0) ? window : longest);
}

function displayedRemaining(window) {
  if (!window) return null;
  const forecast = window.forecast || {};
  if (forecast.currentIsEstimated && forecast.estimatedCurrentRemaining != null) return forecast.estimatedCurrentRemaining;
  return window.remainingPercent;
}

function resetDistance(resetsAt, nowMs) {
  const hours = Math.max(0, (Date.parse(resetsAt) - nowMs) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${Math.round(hours)}h`;
  const whole = Math.round(hours);
  return `${Math.floor(whole / 24)}d ${whole % 24}h`;
}

// A plain-text digest of the dashboard: the tray tooltip, the daily digest,
// and "copy summary" all read from this so they can never disagree.
function buildSummaryLines(snapshot, nowMs = Date.now()) {
  const lines = [];
  for (const source of visibleSources(snapshot)) {
    const window = primaryWindow(snapshot?.quotas?.[source.key]);
    if (!window) {
      lines.push(`${source.label}: no allowance reading yet`);
      continue;
    }
    const forecast = window.forecast || {};
    const remaining = displayedRemaining(window);
    const estimated = forecast.currentIsEstimated && forecast.estimatedCurrentRemaining != null;
    if (forecast.expired) {
      lines.push(`${source.label}: window has reset, waiting for a new reading`);
      continue;
    }
    const parts = [`${estimated ? '~' : ''}${Math.round(remaining ?? 0)}% left`];
    if (window.resetsAt) parts.push(`resets in ${resetDistance(window.resetsAt, nowMs)}`);
    if (forecast.expectedRemaining != null) parts.push(`expected ${Math.round(forecast.expectedRemaining)}% at reset`);
    if (forecast.exhaustsAt) parts.push(`runs out ${new Date(forecast.exhaustsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`);
    lines.push(`${source.label}: ${parts.join(' · ')}`);
  }
  return lines;
}

function buildSummaryText(snapshot, nowMs = Date.now()) {
  const verdict = snapshot?.dashboardVerdict?.label || 'Usage status unknown';
  const costs = snapshot?.costs;
  const costLine = costs
    ? `${costs.isLowerBound ? 'At least ' : ''}${costs.currency} ${costs.actual.toFixed(2)} API-equivalent over the last ${costs.periodDays} days`
    : null;
  return [
    `AI Usage · ${new Date(nowMs).toLocaleString('en-GB')}`,
    verdict,
    ...buildSummaryLines(snapshot, nowMs),
    ...(costLine ? [costLine] : []),
  ].join('\n');
}

function buildTrayTooltip(snapshot, nowMs = Date.now()) {
  const verdict = snapshot?.dashboardVerdict?.label || 'AI Usage';
  const compact = visibleSources(snapshot).map((source) => {
    const window = primaryWindow(snapshot?.quotas?.[source.key]);
    if (!window || window.forecast?.expired) return `${source.label} —`;
    const remaining = displayedRemaining(window);
    const estimated = window.forecast?.currentIsEstimated && window.forecast?.estimatedCurrentRemaining != null;
    return `${source.label} ${estimated ? '~' : ''}${Math.round(remaining ?? 0)}%`;
  });
  return `${verdict}\n${compact.join(' · ')}\nUpdated ${new Date(nowMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

// Decide which desktop notifications a fresh snapshot earns. Pure: takes the
// previous snapshot, the persisted decision state, and the clock; returns the
// notifications to show and the state to persist. Snoozed alerts are dropped,
// not deferred — when the snooze ends, the next refresh judges afresh.
function decideNotifications({ previous, current, state = emptyState(), nowMs = Date.now() }) {
  const next = { ...emptyState(), ...state, lastResetSignatures: { ...state.lastResetSignatures }, lastFallbackSignatures: { ...state.lastFallbackSignatures } };
  const settings = current?.settings || {};
  const notifications = [];
  const snoozedUntil = settings.alertsSnoozedUntil ? Date.parse(settings.alertsSnoozedUntil) : Number.NaN;
  const snoozed = Number.isFinite(snoozedUntil) && snoozedUntil > nowMs;

  // Risk: one toast per episode, cooldown for flapping, escalation always.
  const verdict = current?.dashboardVerdict;
  if (!verdict || !['risk', 'critical'].includes(verdict.state)) {
    next.lastRiskSignature = '';
  } else if (settings.notifyDesktop && !snoozed) {
    const affected = Array.isArray(verdict.affected) ? verdict.affected : [];
    const signature = `${verdict.state}|${verdict.reason || 'unspecified'}|${affected.join('|')}`;
    const escalated = verdict.state === 'critical' && !next.lastRiskSignature.startsWith('critical|');
    const repeated = !escalated && signature === next.lastRiskSignature;
    const coolingDown = !escalated && nowMs - next.lastRiskNotifiedAt < RISK_COOLDOWN_MS;
    if (!repeated && !coolingDown) {
      next.lastRiskSignature = signature;
      next.lastRiskNotifiedAt = nowMs;
      const runsOut = visibleSources(current).flatMap((source) => quotaWindows(current.quotas?.[source.key]).filter((window) => !window.forecast?.expired))
        .map((window) => window?.forecast?.exhaustsAt)
        .filter(Boolean)
        .map((at) => Date.parse(at))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      const when = runsOut
        ? ` At the current pace the earliest run-out is ${new Date(runsOut).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
        : '';
      const subject = affected.join(', ') || 'An allowance window';
      const title = verdict.state === 'critical'
        ? 'An allowance is projected to run out'
        : verdict.reason === 'heavy-exhaustion'
          ? 'An allowance could run out under heavier usage'
          : verdict.reason === 'mixed'
            ? 'Multiple allowances need attention'
            : 'AI usage pace needs attention';
      const body = verdict.state === 'critical'
        ? `${subject} is projected to exhaust its allowance before reset.${when}`
        : verdict.reason === 'heavy-exhaustion'
          ? `${subject} remains above zero in the expected forecast, but could exhaust under heavier usage before reset.`
          : verdict.reason === 'mixed'
            ? `${subject} need attention for different forecast reasons. Open AI Usage for the provider-level detail.${when}`
            : `${subject} is above the configured safe pace.${when}`;
      notifications.push({
        kind: 'risk',
        title,
        body,
      });
    }
  }

  // Compare each bucket only with itself. Changing the riskiest window is not
  // a reset. Legacy per-provider signatures safely reseed without an alert.
  const resetSignatures = {};
  for (const source of visibleSources(current)) {
    for (const window of quotaWindows(current?.quotas?.[source.key])) {
      if (!window?.resetsAt) continue;
      const key = JSON.stringify([source.key, window.bucketId]);
      const signature = JSON.stringify([window.resetsAt, Number(window.usedPercent) <= 2]);
      const before = quotaWindows(previous?.quotas?.[source.key]).find((entry) => entry.bucketId === window.bucketId);
      const known = next.lastResetSignatures[key];
      resetSignatures[key] = signature;
      if (!before || !known || known === signature || window.forecast?.expired) continue;
      const movedForward = Date.parse(window.resetsAt) - Date.parse(before.resetsAt) > 60 * 60 * 1000;
      const replenished = Number(before.usedPercent) >= 5 && Number(window.usedPercent) <= 2;
      if (!movedForward && !replenished) continue;
      if (!settings.notifyResets || snoozed) continue;
      notifications.push({
        kind: 'reset',
        title: `${source.label} allowance has reset`,
        body: `${Math.round(window.remainingPercent)}% is available in the new ${window.bucketName || 'window'}, which resets in ${resetDistance(window.resetsAt, nowMs)}.`,
      });
    }
  }
  next.lastResetSignatures = resetSignatures;

  // Fallback: a collector that was healthy and is now serving cached data.
  const health = new Map((current?.sources || []).map((source) => [source.id, source]));
  const previousHealth = new Map((previous?.sources || []).map((source) => [source.id, source]));
  for (const source of visibleSources(current)) {
    const now = health.get(source.healthId);
    if (!now) continue;
    const signature = `${source.healthId}|${now.status}`;
    const known = next.lastFallbackSignatures[source.healthId];
    next.lastFallbackSignatures[source.healthId] = signature;
    if (!FALLEN_BACK.has(now.status) || known === signature) continue;
    const was = previousHealth.get(source.healthId);
    if (!was || !HEALTHY.has(was.status)) continue;
    if (!settings.notifyFallback || snoozed) continue;
    notifications.push({
      kind: 'fallback',
      title: `${source.label} readings are running on cached data`,
      body: now.status_detail || `The ${source.label} collector reported ${now.status}. The dashboard keeps the last good reading until it recovers.`,
    });
  }

  // Digest: once per local day, at or after the configured hour.
  if (settings.notifyDigest && !snoozed && visibleSources(current).length) {
    const today = localDayKey(nowMs);
    const hour = new Date(nowMs).getHours();
    if (next.lastDigestDay !== today && hour >= Number(settings.digestHour ?? 9)) {
      next.lastDigestDay = today;
      notifications.push({
        kind: 'digest',
        title: verdict?.label || 'AI Usage daily digest',
        body: buildSummaryLines(current, nowMs).join('\n'),
      });
    }
  }

  return { notifications, state: next };
}

module.exports = { buildSummaryLines, buildSummaryText, buildTrayTooltip, decideNotifications, emptyState, primaryWindow };
