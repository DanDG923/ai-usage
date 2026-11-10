'use strict';

const { SOURCES: SUBSCRIPTION_SOURCES, subscriptionVisible } = require('./dashboard-decision.cjs');
const { selectDisplayedWindows } = require('./quota-selection.cjs');
const { localDayKey } = require('./time.cjs');

/** @typedef {import('./types').Quota} Quota */
/** @typedef {import('./types').QuotaWindow} QuotaWindow */
/** @typedef {import('./types').Source} Source */

/**
 * A source as a snapshot lists it. The time of its last collection is read
 * under either spelling.
 * @typedef {Source & { lastSuccessAt?: string | null }} SnapshotSource
 */

/**
 * A tray or dashboard snapshot as this module reads it. Any part may be
 * missing, since each is read defensively; only the dashboard's has costs.
 * @typedef {Omit<Partial<import('./types').TraySnapshot>, 'sources'>
 *   & { sources?: SnapshotSource[] }
 *   & Partial<Pick<import('./types').Snapshot, 'costs'>>} SnapshotLike
 */

/**
 * The snapshot before the current one. Only each window's bucket, reset and
 * use, and each source's status, are compared, so a copy trimmed to those
 * serves as well as a whole snapshot.
 * @typedef {Pick<QuotaWindow, 'bucketId' | 'resetsAt' | 'usedPercent'>} PreviousWindow
 * @typedef {{
 *   quotas?: Partial<Record<import('./providers.mjs').SnapshotKey, { windows?: PreviousWindow[] } | null>>,
 *   sources?: Pick<Source, 'id' | 'status'>[],
 * }} PreviousSnapshot
 */

/**
 * What decideNotifications remembers between refreshes; saved as JSON.
 * @typedef {{
 *   lastRiskSignature: string,
 *   lastRiskNotifiedAt: number,
 *   lastResetSignatures: Record<string, string>,
 *   lastFallbackSignatures: Record<string, string>,
 *   lastDigestDay: string | null,
 * }} NotificationState
 */

/** @typedef {{ kind: 'risk' | 'reset' | 'fallback' | 'digest', title: string, body: string }} DesktopNotification */

// The same subscription list the dashboard verdict uses; this module has
// always addressed the snapshot quota key as `key`.
const SOURCES = SUBSCRIPTION_SOURCES.map(({ id, ...source }) => ({ key: id, ...source }));
/** @param {SnapshotLike | null | undefined} snapshot */
const visibleSources = (snapshot) => SOURCES.filter((source) => subscriptionVisible(snapshot?.settings, source.key));

// One ongoing risk episode is worth one notification, not one per refresh.
const RISK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HEALTHY = new Set(['connected', 'ready', 'observing', 'estimating', 'activity-only']);
const FALLEN_BACK = new Set(['stale', 'degraded', 'error']);

// Automatic refreshes can age a Claude reading or carry forward a failed
// read. They never introduce a new plan-usage failure themselves.
/** @param {Source | null | undefined} source */
function agedWithoutReading(source) {
  if (source?.status !== 'stale') return false;
  // The part of the Claude collector's status report that says whether this
  // run asked for plan usage.
  /** @type {{ planUsage?: { requested?: boolean }, automatic?: { provider?: { kind?: string } } }} */
  const metadata = source.metadata || {};
  return metadata.planUsage?.requested === false
    || metadata.automatic?.provider?.kind === 'not-requested';
}

/** @returns {NotificationState} */
function emptyState() {
  return {
    lastRiskSignature: '',
    lastRiskNotifiedAt: 0,
    lastResetSignatures: {},
    lastFallbackSignatures: {},
    lastDigestDay: /** @type {string | null} */ (null),
  };
}

/**
 * A quota's windows.
 * @template W
 * @param {{ windows?: W[] } | null | undefined} quota
 * @returns {W[]}
 */
function quotaWindows(quota) {
  if (!quota) return [];
  // A quota that lists no windows is its own single window.
  return Array.isArray(quota.windows) && quota.windows.length ? quota.windows : [/** @type {W} */ (quota)];
}

// The same window the dashboard card headlines, by the shared rule.
/** @param {Quota | null | undefined} quota */
function primaryWindow(quota) {
  return selectDisplayedWindows(quotaWindows(quota)).primary;
}

// The dashboard's "left now" rule (src/lib.ts). Fable is capped by what is
// left of the shared Claude weekly pool.
/** @param {QuotaWindow | null | undefined} window */
function displayedRemaining(window) {
  if (!window) return null;
  if (window.sharedPool?.status === 'applied') return window.sharedPool.usableRemaining;
  /** @type {Partial<import('./types').Forecast>} */
  const forecast = window.forecast || {};
  if (forecast.currentIsEstimated && forecast.estimatedCurrentRemaining != null) return forecast.estimatedCurrentRemaining;
  return window.remainingPercent;
}

/** @param {QuotaWindow | null | undefined} window */
function isEstimated(window) {
  if (window?.sharedPool?.status === 'applied') return Boolean(window.sharedPool.estimated);
  return Boolean(window?.forecast?.currentIsEstimated && window?.forecast?.estimatedCurrentRemaining != null);
}

// "usable" when the Claude weekly limit, not Fable's own, sets what is left.
/** @param {QuotaWindow | null | undefined} window */
function poolLimited(window) {
  return window?.sharedPool?.status === 'applied' && window.sharedPool.binding === 'pool';
}

/**
 * @param {string} resetsAt
 * @param {number} nowMs
 */
function resetDistance(resetsAt, nowMs) {
  const hours = Math.max(0, (Date.parse(resetsAt) - nowMs) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${Math.round(hours)}h`;
  const whole = Math.round(hours);
  return `${Math.floor(whole / 24)}d ${whole % 24}h`;
}

// A plain-text digest of the dashboard: the tray tooltip, the daily digest,
// and "copy summary" all read from this so they can never disagree.
/**
 * @param {SnapshotLike | null | undefined} snapshot
 * @param {number} [nowMs]
 */
function buildSummaryLines(snapshot, nowMs = Date.now()) {
  const lines = [];
  for (const source of visibleSources(snapshot)) {
    const window = primaryWindow(snapshot?.quotas?.[source.key]);
    if (!window) {
      lines.push(`${source.label}: no allowance reading yet`);
      continue;
    }
    /** @type {Partial<import('../src/types').Forecast>} */
    const forecast = window.forecast || {};
    const remaining = displayedRemaining(window);
    const estimated = isEstimated(window);
    if (forecast.expired) {
      lines.push(`${source.label}: window has reset, waiting for a new reading`);
      continue;
    }
    const parts = [poolLimited(window)
      ? `${estimated ? '~' : ''}${Math.round(remaining ?? 0)}% usable (Fable limit ${Math.round(/** @type {import('../src/types').SharedPoolApplied} */ (window.sharedPool).capRemaining)}% left)`
      : `${estimated ? '~' : ''}${Math.round(remaining ?? 0)}% left`];
    if (window.resetsAt) parts.push(`resets in ${resetDistance(window.resetsAt, nowMs)}`);
    if (forecast.expectedRemaining != null) parts.push(`expected ${Math.round(forecast.expectedRemaining)}% at reset`);
    if (forecast.exhaustsAt) parts.push(`runs out ${new Date(forecast.exhaustsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`);
    lines.push(`${source.label}: ${parts.join(' · ')}`);
  }
  return lines;
}

/**
 * @param {SnapshotLike | null | undefined} snapshot
 * @param {number} [nowMs]
 */
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

/** @param {SnapshotLike | null | undefined} snapshot */
function buildTrayTooltip(snapshot) {
  const verdict = snapshot?.dashboardVerdict?.label || 'AI Usage';
  const compact = visibleSources(snapshot).map((source) => {
    const window = primaryWindow(snapshot?.quotas?.[source.key]);
    if (!window || window.forecast?.expired) return `${source.label} —`;
    const remaining = displayedRemaining(window);
    const estimated = isEstimated(window);
    return `${source.label} ${estimated ? '~' : ''}${Math.round(remaining ?? 0)}%${poolLimited(window) ? ' usable' : ''}`;
  });
  const latest = Math.max(0, ...(snapshot?.sources || []).map((source) => Date.parse(source.lastSuccessAt || source.last_success_at || '') || 0));
  const updated = latest ? `Updated ${new Date(latest).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Not collected yet';
  const prefix = `${compact.join(' · ')}\n${updated}\n`;
  const available = Math.max(0, 127 - prefix.length);
  const label = verdict.length > available ? `${verdict.slice(0, Math.max(0, available - 1))}…` : verdict;
  return `${prefix}${label}`.slice(0, 127);
}

// Decide which desktop notifications a fresh snapshot earns. Pure: takes the
// previous snapshot, the persisted decision state, and the clock; returns the
// notifications to show and the state to persist. Snoozed alerts are dropped,
// not deferred — when the snooze ends, the next refresh judges afresh.
/**
 * @param {{
 *   previous?: PreviousSnapshot | null,
 *   current?: SnapshotLike | null,
 *   state?: NotificationState,
 *   nowMs?: number,
 * }} input
 * @returns {{ notifications: DesktopNotification[], state: NotificationState }}
 */
function decideNotifications({ previous, current, state = emptyState(), nowMs = Date.now() }) {
  const next = { ...emptyState(), ...state, lastResetSignatures: { ...state.lastResetSignatures }, lastFallbackSignatures: { ...state.lastFallbackSignatures } };
  // Saved before 1.0.52 renamed the allowance: an open episode must not alert again.
  next.lastRiskSignature = String(next.lastRiskSignature || '').split('|')
    .map((part) => (part === 'Fable 5 · Fable 5 weekly' ? 'Fable · Fable weekly' : part === 'Fable 5' ? 'Fable' : part))
    .join('|');
  /** @type {Partial<import('./types').Settings>} */
  const settings = current?.settings || {};
  /** @type {DesktopNotification[]} */
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
      // The verdict was read from `current`, so there is one; and the filter
      // before the parse leaves only run-out times that are set.
      const runsOut = visibleSources(current).flatMap((source) => quotaWindows(/** @type {SnapshotLike} */ (current).quotas?.[source.key]).filter((window) => !window.forecast?.expired))
        .map((window) => window?.forecast?.exhaustsAt)
        .filter(Boolean)
        .map((at) => Date.parse(/** @type {string} */ (at)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      const when = runsOut
        ? ` At the current pace the earliest run-out is ${new Date(runsOut).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
        : '';
      const subject = affected.join(', ') || 'An allowance window';
      const included = [...new Set((verdict.details || []).flatMap((detail) => detail.includes || []))];
      const shared = included.length
        ? ` ${included.join(' and ')} ${included.length > 1 ? 'draw' : 'draws'} on the same weekly limit, so ${included.length > 1 ? 'they are' : 'it is'} affected too.`
        : '';
      const title = verdict.state === 'critical'
        ? 'An allowance is projected to run out'
        : verdict.reason === 'heavy-exhaustion'
          ? 'An allowance could run out under heavier usage'
          : verdict.reason === 'mixed'
            ? (affected.length > 1 ? 'Multiple allowances need attention' : 'An allowance needs attention')
            : 'AI usage pace needs attention';
      const body = (verdict.state === 'critical'
        ? `${subject} is projected to exhaust its allowance before reset.${when}`
        : verdict.reason === 'heavy-exhaustion'
          ? `${subject} remains above zero in the expected forecast, but could exhaust under heavier usage before reset.`
          : verdict.reason === 'mixed'
            ? `${subject} ${affected.length > 1 ? "need" : "needs"} attention for different forecast reasons. Open AI Usage for the provider-level detail.${when}`
            : `${subject} is above the configured safe pace.${when}`) + shared;
      notifications.push({
        kind: 'risk',
        title,
        body,
      });
    }
  }

  // Compare each bucket only with itself. Changing the riskiest window is not
  // a reset. Legacy per-provider signatures safely reseed without an alert.
  /** @type {Record<string, string>} */
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
      // Only a window that had usage to replenish can announce a reset. An idle
      // window's reset rolls forward with the clock, and the poll after an
      // early replenishment moves the timestamp of a window already at zero.
      const movedForward = Number(before.usedPercent) > 2
        && Date.parse(window.resetsAt) - Date.parse(before.resetsAt) > 60 * 60 * 1000;
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

  // Fallback: a collector that was healthy (or merely aged) and now failed.
  /** @type {Map<string, Source>} */
  const health = new Map((current?.sources || []).map((source) => [source.id, source]));
  /** @type {Map<string, Pick<Source, 'id' | 'status'>>} */
  const previousHealth = new Map((previous?.sources || []).map((source) => [source.id, source]));
  for (const source of visibleSources(current)) {
    const now = health.get(source.healthId);
    if (!now) continue;
    const signature = `${source.healthId}|${now.status}`;
    const known = next.lastFallbackSignatures[source.healthId];
    const agedSignature = `${source.healthId}|aged`;
    if (agedWithoutReading(now)) {
      // Persist the distinction: tray-idle cleanup drops previous metadata.
      // After a real failure, an automatic run must not rearm its alert.
      const alreadyFailed = [...FALLEN_BACK].some((status) => known === `${source.healthId}|${status}`);
      if (!alreadyFailed) next.lastFallbackSignatures[source.healthId] = agedSignature;
      continue;
    }
    next.lastFallbackSignatures[source.healthId] = signature;
    if (!FALLEN_BACK.has(now.status) || known === signature) continue;
    const was = previousHealth.get(source.healthId);
    if (!was || (!HEALTHY.has(was.status) && known !== agedSignature)) continue;
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

module.exports = {
  HEALTHY_SOURCE_STATUSES: HEALTHY, buildSummaryLines, buildSummaryText, buildTrayTooltip, decideNotifications,
  displayedRemaining, emptyState, isEstimated, poolLimited, primaryWindow, quotaWindows,
};
