import { selectDisplayedWindows } from '../electron/quota-selection.mjs';
import {
  SOURCES,
  evidenceNeedsRefresh,
  stalePoolWindow,
  subscriptionVisible,
} from '../electron/dashboard-decision.mjs';
import {
  compactNumber,
  dateTimeLabel,
  displayedRemaining,
  isEstimated,
  modelAllowanceName,
  primaryWindow,
  quotaWindows,
  sourceNeedsAttention,
  windowLabel,
} from './lib';
import type { ForecastState, Quota, QuotaWindow, Snapshot, Source } from './types';

export type ProviderId = 'codex' | 'claude' | 'fable';

/**
 * A record of the three providers holding only the shown subscriptions'
 * entries: a hidden subscription's entry is replaced by `hidden`, so it is
 * never counted, named as on track, or drawn.
 */
export function visibleOnly<T, H>(
  settings: Snapshot['settings'],
  entries: Record<ProviderId, T>,
  hidden: H,
): Record<ProviderId, T | H> {
  const shown = (id: ProviderId) => (subscriptionVisible(settings, id) ? entries[id] : hidden);
  return { codex: shown('codex'), claude: shown('claude'), fable: shown('fable') };
}

/** The quotas of the shown subscriptions; a hidden subscription reads as having none. */
export function visibleQuotas(snapshot: Pick<Snapshot, 'settings' | 'quotas'>): Snapshot['quotas'] {
  return visibleOnly(snapshot.settings, snapshot.quotas, null);
}

/** The latest successful collection among these sources, or null when none has succeeded yet. */
export function latestSuccessAt(sources: readonly (Pick<Source, 'last_success_at'> | null | undefined)[]) {
  let latest: number | null = null;
  for (const source of sources) {
    const at = Date.parse(source?.last_success_at ?? '');
    if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * When the visible subscriptions' sources last collected successfully. A
 * snapshot's generatedAt is when it was built, which happens on demand, so it
 * would read "just now" over data that is hours old.
 */
export function lastCollectedAt(snapshot: Pick<Snapshot, 'settings' | 'sources'>): number | null {
  return latestSuccessAt(
    SOURCES.filter(({ id }) => subscriptionVisible(snapshot.settings, id)).map(({ healthId }) =>
      snapshot.sources.find((entry) => entry.id === healthId),
    ),
  );
}

export type ProviderView = {
  id: ProviderId;
  name: string;
  quota: Quota | null;
  current: QuotaWindow | null;
  source: Source | null;
  state: ForecastState;
  remaining: number | null;
  expectedRemaining: number | null;
  heavyRemaining: number | null;
  resetAt: string | null;
  subtitle: string;
  provenance: string;
  expired: boolean;
  estimated: boolean;
  stale: boolean;
  notes: string[];
  /** Active windows shorter than the headline one, such as a five-hour session. */
  secondaryWindows: QuotaWindow[];
  /** Fable only: what is left now is set by the Claude weekly limit, not Fable's own. */
  poolLimited: boolean;
};

/** Whether a view has an expected and a heavier projection: enough to draw a forecast, not only a balance. */
export function hasProjection(view: ProviderView) {
  return view.state !== 'unknown' && view.expectedRemaining != null && view.heavyRemaining != null;
}

function sentence(text: string) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function planName(planType: string | null, provider: ProviderId) {
  const value = planType?.trim();
  if (!value) return 'Allowance';
  if (value.toLowerCase() === 'pro') return provider === 'codex' ? 'ChatGPT Pro' : 'Claude Pro';
  if (value.toLowerCase() === 'max') return 'Claude Max';
  return value;
}

function fableActivity(source: Source | null) {
  const automatic = source?.metadata?.automatic;
  if (!automatic || typeof automatic !== 'object' || Array.isArray(automatic)) return null;
  const activity = (automatic as Record<string, unknown>).activity;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;
  const row = activity as Record<string, unknown>;
  const healthValue = (automatic as Record<string, unknown>).health;
  const health =
    healthValue && typeof healthValue === 'object' && !Array.isArray(healthValue)
      ? (healthValue as Record<string, unknown>)
      : {};
  const numeric = (key: string) => (typeof row[key] === 'number' && Number.isFinite(row[key]) ? Number(row[key]) : 0);
  return {
    requests: numeric('requests'),
    tokens:
      numeric('inputTokens') +
      numeric('cachedInputTokens') +
      numeric('cacheWriteInputTokens') +
      numeric('outputTokens'),
    officialSource: typeof health.officialSource === 'string' ? health.officialSource : null,
    activitySource: typeof health.activitySource === 'string' ? health.activitySource : null,
  };
}

function providerSubtitle(id: ProviderId, current: QuotaWindow | null, source: Source | null) {
  if (!current) return 'Awaiting data';
  let measurement = planName(current.planType, id);
  if (id === 'fable') {
    measurement =
      current.provenance === 'derived-tokens'
        ? 'Local estimate'
        : current.provenance === 'manual-official'
          ? 'Manual observation'
          : 'Provider reading';
    if (source && sourceNeedsAttention(source.status)) measurement = `Stale ${measurement.toLowerCase()}`;
  }
  return `${sentence(measurement)} · ${modelAllowanceName(current) ? `${modelAllowanceName(current)} · ` : ''}${sentence(windowLabel(current.windowMinutes))}`;
}

function providerNotes(
  id: ProviderId,
  current: QuotaWindow | null,
  source: Source | null,
  poolWindow: QuotaWindow | null,
  snapshot: Snapshot,
) {
  const notes: string[] = [];
  if (!current) return notes;
  if (poolWindow) {
    notes.push(
      `Usable Fable follows the Claude weekly reading from ${dateTimeLabel(poolWindow.observedAt)}. Press Refresh to update both.`,
    );
  }
  if (current.forecast.expired) return ['The last allowance window ended. A new provider reading is needed.'];
  if (current.provenance === 'derived-tokens') {
    notes.push('Allowance estimated from local activity and calibrated history.');
  }
  if (source && sourceNeedsAttention(source.status)) {
    notes.push(`Latest source status: ${source.status}. The balance is being projected from the last reading.`);
  }
  if (id === 'fable') {
    // The dashboard snapshot's per-version table covers the current Fable
    // window; the note uses the same figures so the page states one total.
    const collected = fableActivity(source);
    const byVersion = snapshot.fableActivity?.models;
    const activity =
      byVersion && collected
        ? {
            ...collected,
            requests: byVersion.reduce((total, entry) => total + entry.requests, 0),
            tokens: byVersion.reduce((total, entry) => total + entry.totalTokens, 0),
          }
        : collected;
    if (activity) {
      const activityStale = activity.activitySource && activity.activitySource !== 'current';
      notes.push(
        `${activityStale ? 'Cached local activity' : 'This device'}: ${compactNumber(activity.requests)} request${activity.requests === 1 ? '' : 's'} · ${compactNumber(activity.tokens)} tracked tokens.`,
      );
    }
  }
  return notes;
}

// Whether a provider's allowance is older than the verdict's freshness rule
// allows. It is judged apart from the source's last collection: a collection
// can succeed and still leave the balance it shows in need of a refresh.
function allowanceAged(quota: Quota | null, poolWindow: QuotaWindow | null) {
  return (
    quotaWindows(quota).some((entry) => !entry.forecast.expired && evidenceNeedsRefresh(entry)) || Boolean(poolWindow)
  );
}

/** Whether the provider's shown allowance needs a refresh; a stale Claude weekly reading ages the Fable figure it caps. */
export function allowanceNeedsRefresh(snapshot: Snapshot, id: ProviderId) {
  const quota = snapshot.quotas[id];
  return allowanceAged(quota, id === 'fable' ? stalePoolWindow(primaryWindow(quota), snapshot.quotas.claude) : null);
}

// Each snapshot arrives as one immutable object over IPC, and several views
// derive the same provider rows from it on every render. The rows are built
// once per snapshot so their identity is stable for the memoised charts.
const viewCache = new WeakMap<Snapshot, ProviderView[]>();

export function providerViews(snapshot: Snapshot): ProviderView[] {
  let views = viewCache.get(snapshot);
  if (!views) {
    views = buildProviderViews(snapshot);
    viewCache.set(snapshot, views);
  }
  return views;
}

function buildProviderViews(snapshot: Snapshot): ProviderView[] {
  return SOURCES.filter(({ id }) => subscriptionVisible(snapshot.settings, id)).map(
    ({ id, label: name, healthId: sourceId }) => {
      const quota = snapshot.quotas[id];
      const current = primaryWindow(quota);
      const expired = Boolean(current?.forecast.expired);
      const source = snapshot.sources.find((entry) => entry.id === sourceId) ?? null;
      // The same rule as the verdict: a stale Claude reading ages the Fable figure it caps.
      const poolWindow = id === 'fable' ? stalePoolWindow(current, snapshot.quotas.claude) : null;
      return {
        id,
        name,
        quota,
        current,
        source,
        state: expired ? 'unknown' : (current?.forecast.state ?? 'unknown'),
        remaining: current && !expired ? Math.max(0, Math.min(100, displayedRemaining(current))) : null,
        expectedRemaining:
          expired || current?.forecast.expectedRemaining == null
            ? null
            : Math.max(0, Math.min(100, current.forecast.expectedRemaining)),
        heavyRemaining:
          expired || current?.forecast.heavyRemaining == null
            ? null
            : Math.max(0, Math.min(100, current.forecast.heavyRemaining)),
        resetAt: current?.resetsAt ?? null,
        subtitle: providerSubtitle(id, current, source),
        provenance: current?.provenance ?? 'unavailable',
        expired,
        estimated: current && !expired ? isEstimated(current) : false,
        stale: Boolean(expired || (source && sourceNeedsAttention(source.status)) || allowanceAged(quota, poolWindow)),
        notes: providerNotes(id, current, source, poolWindow, snapshot),
        secondaryWindows: current ? selectDisplayedWindows(quotaWindows(quota)).secondary : [],
        poolLimited: Boolean(
          !expired && current?.sharedPool?.status === 'applied' && current.sharedPool.binding === 'pool',
        ),
      };
    },
  );
}
