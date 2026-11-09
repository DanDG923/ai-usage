'use strict';

// The glance the Claude Code mod draws: the tray flyout's figures, already
// decided, so the mod is a view and never a second copy of the forecast.
// Every rule here mirrors the renderer (src/provider-view.ts, src/lib.ts,
// src/budget.ts and the flyout's verdict); tests/claude-code-glance.test.cjs
// compares the two on the demo snapshots so they cannot drift apart.

const { SOURCES, evidenceNeedsRefresh, stalePoolWindow, subscriptionVisible } = require('./dashboard-decision.cjs');
const { isMainWindow, selectDisplayedWindows } = require('./quota-selection.cjs');
const { displayedRemaining, isEstimated, poolLimited, primaryWindow, quotaWindows } = require('./notifications.cjs');
const { CODEX, FABLE, allowanceHost, isMainLimitId, providerBySnapshotKey } = require('./providers.mjs');

/** @typedef {import('./types').QuotaWindow} QuotaWindow */
/** @typedef {import('./types').ForecastState} ForecastState */
/** @typedef {import('./notifications.cjs').SnapshotLike} SnapshotLike */
/** @typedef {import('./providers.mjs').SnapshotKey} ProviderId The key a snapshot lists a provider under. */
/** @typedef {ReturnType<typeof providerRow>} GlanceProvider */
/** @typedef {ReturnType<typeof buildGlance>} Glance The file the Claude Code mod reads. */

const GLANCE_SCHEMA = 1;
// Compared with whatever a snapshot carries, which may be no state at all.
/** @type {Set<unknown>} */
const STATES = new Set(['safe', 'watch', 'risk', 'critical', 'unknown']);
const FALLEN_BACK = new Set(['stale', 'degraded', 'error']);

// Number.isFinite is true only for a number, so `value` is one where it is clamped.
/** @param {number | null | undefined} value */
const clampPercent = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(100, /** @type {number} */ (value))) : null);
/** @param {string} text */
const sentence = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
/** @param {unknown} value */
const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

/** @param {number | null | undefined} minutes */
function windowLabel(minutes) {
  if (minutes == null) return 'allowance window';
  if (minutes >= 40_320) return 'monthly';
  if (minutes >= 10_080) return 'weekly';
  if (minutes >= 1_440) return `${Math.round(minutes / 1_440)}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}

/**
 * @param {string | null | undefined} planType
 * @param {ProviderId} provider
 */
function planName(planType, provider) {
  const value = typeof planType === 'string' ? planType.trim() : '';
  if (!value) return 'Allowance';
  if (value.toLowerCase() === 'pro') return provider === CODEX.snapshotKey ? 'ChatGPT Pro' : 'Claude Pro';
  if (value.toLowerCase() === 'max') return 'Claude Max';
  return value;
}

/** @param {QuotaWindow} window */
function modelAllowanceName(window) {
  /** @type {Record<string, unknown>} */
  const { limitId, limitName } = window.metadata || {};
  if (typeof limitId === 'string') {
    if (isMainLimitId(limitId)) return null;
    return typeof limitName === 'string' && limitName.trim() ? limitName : limitId;
  }
  if (isMainWindow(window) || /^fable/i.test(window.bucketId) || !window.bucketName?.trim()) return null;
  return window.bucketName.replace(/\s*weekly$/i, '').trim() || null;
}

/** @param {QuotaWindow} window */
function allowanceWindowLabel(window) {
  const model = modelAllowanceName(window);
  const duration = windowLabel(window.windowMinutes);
  return model ? `${model} · ${duration}` : `${duration} ${window.windowMinutes === 300 ? 'session' : 'allowance'}`;
}

/**
 * @param {ProviderId} id
 * @param {QuotaWindow | null} current
 * @param {import('./types').Source | null} source
 */
function subtitleOf(id, current, source) {
  if (!current) return 'Awaiting data';
  let measurement = planName(current.planType, id);
  // Fable has no plan of its own to name; its card says where the figure came from.
  if (id === FABLE.snapshotKey) {
    measurement = current.provenance === 'derived-tokens' ? 'Local estimate'
      : current.provenance === 'manual-official' ? 'Manual observation' : 'Provider reading';
    if (source && FALLEN_BACK.has(source.status)) measurement = `Stale ${measurement.toLowerCase()}`;
  }
  const model = modelAllowanceName(current);
  return `${sentence(measurement)} · ${model ? `${model} · ` : ''}${sentence(windowLabel(current.windowMinutes))}`;
}

/**
 * @param {QuotaWindow | null | undefined} window
 * @returns {ForecastState}
 */
function stateOf(window) {
  if (!window || window.forecast?.expired) return 'unknown';
  return STATES.has(window.forecast?.state) ? window.forecast.state : 'unknown';
}

// Active hours between two instants, stepping local hour boundaries as the
// forecast engine and src/budget.ts do.
/**
 * @param {number} startMs
 * @param {number} endMs
 * @param {import('./types').Schedule} schedule
 */
function activeHoursBetween(startMs, endMs, schedule) {
  if (!(endMs > startMs)) return 0;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const boundary = new Date(cursor);
    boundary.setMinutes(60, 0, 0);
    const next = Math.min(endMs, boundary.getTime());
    const middle = new Date((cursor + next) / 2);
    const hour = middle.getHours() + middle.getMinutes() / 60;
    if (schedule.activeDays.includes(middle.getDay()) && hour >= schedule.startHour && hour < schedule.endHour) {
      total += (next - cursor) / 3_600_000;
    }
    cursor = next;
  }
  return total;
}

// The share of the allowance that fits in each remaining active day while
// keeping the reserve: src/budget.ts dailyBudget's `budget`, or null where it
// declines one (a session window, under a day left, no forecast yet).
/**
 * @param {QuotaWindow} window
 * @param {Partial<import('./types').Settings>} settings
 * @param {number} nowMs
 */
function dailyBudget(window, settings, nowMs) {
  const forecast = window?.forecast;
  if (!forecast || forecast.expired || forecast.state === 'unknown' || forecast.expectedRemaining == null) return null;
  const schedule = {
    activeDays: Array.isArray(settings.activeDays) ? settings.activeDays : [1, 2, 3, 4, 5, 6, 0],
    startHour: Number(settings.activeStartHour ?? 8),
    endHour: Number(settings.activeEndHour ?? 22),
  };
  const hoursPerDay = Math.max(0, schedule.endHour - schedule.startHour);
  const activeHoursLeft = Number.isFinite(forecast.activeHoursLeft) && forecast.activeHoursLeft > 0
    ? forecast.activeHoursLeft
    : activeHoursBetween(nowMs, Date.parse(window.resetsAt), schedule);
  if (!(hoursPerDay > 0) || !(activeHoursLeft >= 0.5)) return null;
  const activeDaysLeft = activeHoursLeft / hoursPerDay;
  if ((window.windowMinutes != null && window.windowMinutes < 1_440) || activeDaysLeft < 1) return null;
  // A window always has a figure; only a missing window has none.
  const remaining = Math.max(0, Math.min(100, /** @type {number} */ (displayedRemaining(window))));
  const reserve = Math.max(0, Math.min(90, forecast.reservePercent ?? settings.reservePercent ?? 0));
  return Math.max(0, remaining - reserve) / activeDaysLeft;
}

/** @param {number} value */
const paceLabel = (value) => `${value < 20 ? value.toFixed(1) : Math.round(value)}%`;

/**
 * @param {typeof SOURCES[number]} source
 * @param {SnapshotLike} snapshot
 */
function providerRow({ id, healthId, label }, snapshot) {
  const quota = snapshot.quotas?.[id] ?? null;
  const current = primaryWindow(quota);
  const expired = Boolean(current?.forecast?.expired);
  const source = (snapshot.sources || []).find((entry) => entry.id === healthId) ?? null;
  // The weekly window of the provider whose pool this one sits inside (Claude, for Fable).
  const poolHost = allowanceHost(providerBySnapshotKey(id));
  const poolWindow = poolHost ? stalePoolWindow(current, snapshot.quotas?.[poolHost.snapshotKey]) : null;
  /** @type {Partial<import('../src/types').Forecast>} */
  const forecast = current?.forecast || {};
  const live = Boolean(current && !expired);
  const aged = quotaWindows(quota).some((entry) => !entry.forecast?.expired && evidenceNeedsRefresh(entry)) || Boolean(poolWindow);
  return {
    id,
    name: label,
    subtitle: subtitleOf(id, current, source),
    state: stateOf(current),
    waiting: !live,
    remaining: live ? clampPercent(displayedRemaining(current)) : null,
    expectedRemaining: expired || forecast.expectedRemaining == null ? null : clampPercent(forecast.expectedRemaining),
    estimated: live ? isEstimated(current) : false,
    usable: live && poolLimited(current),
    resetsAt: isoOrNull(current?.resetsAt),
    exhaustsAt: live ? isoOrNull(forecast.exhaustsAt) : null,
    stale: Boolean(expired || (source && FALLEN_BACK.has(source.status)) || aged),
    secondary: current
      ? selectDisplayedWindows(quotaWindows(quota)).secondary.map((window) => ({
        label: sentence(allowanceWindowLabel(window)),
        state: stateOf(window),
        remaining: clampPercent(displayedRemaining(window)),
        resetsAt: isoOrNull(window.resetsAt),
      }))
      : [],
  };
}

// The Overview's secondary sentence (src/lib.ts verdictSentence): the
// subscriptions that are on track, never one that is hidden or failing.
/**
 * @param {Partial<import('./types').DashboardVerdict>} verdict
 * @param {SnapshotLike} snapshot
 */
function onTrackSentence(verdict, snapshot) {
  /** @type {Partial<import('./types').Settings>} */
  const settings = snapshot.settings || {};
  const affected = new Set((verdict.affected || []).map((entry) => String(entry).split(' · ')[0].trim()));
  const others = SOURCES
    .filter(({ id, label }) => subscriptionVisible(settings, id) && !affected.has(label))
    .filter(({ healthId }) => !(snapshot.sources || []).some((source) => source.id === healthId && FALLEN_BACK.has(source.status)))
    .filter(({ id }) => {
      const active = quotaWindows(snapshot.quotas?.[id]).filter((window) => !window.forecast?.expired);
      return active.length > 0 && active.every((window) => window.forecast?.state === 'safe'
        && !evidenceNeedsRefresh(window) && !stalePoolWindow(window, snapshot.quotas?.claude));
    })
    .map(({ label }) => label);
  if (!others.length) return '';
  const names = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others.at(-1)}`;
  return `${names} ${others.length === 1 ? 'is' : 'are'} on track.`;
}

// The flyout's annunciator (src/components/TrayFlyout.tsx verdictView).
/**
 * @param {SnapshotLike} snapshot
 * @param {GlanceProvider[]} providers
 * @param {number} nowMs
 * @returns {{ state: ForecastState, headline: string, detail: string }}
 */
function verdictOf(snapshot, providers, nowMs) {
  if (!providers.length) {
    return { state: 'unknown', headline: 'No subscriptions shown', detail: 'Choose subscriptions in AI Usage settings to see their allowances here.' };
  }
  if (providers.every((provider) => provider.waiting)) {
    return { state: 'unknown', headline: 'Waiting for allowance readings', detail: 'They appear after the next refresh.' };
  }
  /** @type {Partial<import('./types').DashboardVerdict>} */
  const verdict = snapshot.dashboardVerdict || {};
  // The set holds the five states only, so a missing or unlisted one has become 'unknown'.
  const state = /** @type {ForecastState} */ (STATES.has(verdict.state) ? verdict.state : 'unknown');
  if (state === 'safe') return { state, headline: 'All allowances on track', detail: '' };
  let detail = onTrackSentence(verdict, snapshot);
  const details = Array.isArray(verdict.details) ? verdict.details : [];
  const flagged = details.filter((entry) => entry && entry.state !== 'safe');
  if (flagged.length && new Set(flagged.map((entry) => entry.sourceId)).size === 1
    && subscriptionVisible(snapshot.settings, flagged[0].sourceId)) {
    const quota = snapshot.quotas?.[flagged[0].sourceId];
    const window = quotaWindows(quota).find((entry) => entry.bucketId === flagged[0].bucketId && !entry.forecast?.expired)
      ?? primaryWindow(quota);
    const budget = window ? dailyBudget(window, snapshot.settings || {}, nowMs) : null;
    if (budget != null && budget > 0) detail = `Stay under ${paceLabel(budget)} a day to reach the reset.`;
  }
  return { state, headline: typeof verdict.label === 'string' && verdict.label ? verdict.label : 'Usage status unknown', detail };
}

// When the visible sources last collected: what "Updated" means in the flyout.
/**
 * @param {SnapshotLike} snapshot
 * @param {GlanceProvider[]} providers
 */
function collectedAt(snapshot, providers) {
  const ids = new Set(SOURCES.filter(({ id }) => providers.some((provider) => provider.id === id)).map(({ healthId }) => healthId));
  /** @type {number | null} */
  let latest = null;
  for (const source of snapshot.sources || []) {
    if (ids.size && !ids.has(source.id)) continue;
    const at = Date.parse(source.last_success_at ?? source.lastSuccessAt ?? '');
    if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
  }
  return latest == null ? null : new Date(latest).toISOString();
}

/**
 * The glance from a tray or dashboard snapshot. The snapshot's own build time
 * is the clock, as the flyout uses it, so a budget never mixes two instants.
 * @param {SnapshotLike | null | undefined} snapshot
 * @param {{ nowMs?: number, appVersion?: string | null }} [options]
 */
function buildGlance(snapshot, { nowMs = Date.now(), appVersion = /** @type {string | null} */ (null) } = {}) {
  /** @type {SnapshotLike} */
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  /** @type {Partial<import('./types').Settings>} */
  const settings = value.settings || {};
  // A missing build time parses as NaN, and the clock below is then `nowMs`.
  const generatedMs = Date.parse(/** @type {string} */ (value.generatedAt));
  const clockMs = Number.isFinite(generatedMs) ? generatedMs : nowMs;
  const providers = SOURCES.filter(({ id }) => subscriptionVisible(settings, id)).map((source) => providerRow(source, value));
  return {
    schema: GLANCE_SCHEMA,
    appVersion: typeof appVersion === 'string' ? appVersion : null,
    writtenAt: new Date(nowMs).toISOString(),
    generatedAt: new Date(clockMs).toISOString(),
    collectedAt: collectedAt(value, providers),
    verdict: verdictOf(value, providers, clockMs),
    providers,
    alertsSnoozedUntil: isoOrNull(settings.alertsSnoozedUntil),
  };
}

module.exports = { GLANCE_SCHEMA, buildGlance };
