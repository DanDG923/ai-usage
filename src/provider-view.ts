import { compactNumber, displayedRemaining, isEstimated, primaryWindow, quotaWindows, windowLabel } from './lib';
import type { ForecastState, Quota, QuotaWindow, Snapshot, Source } from './types';

export type ProviderId = 'codex' | 'claude' | 'fable';

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
  secondaryWindows: QuotaWindow[];
};

const PROVIDERS: { id: ProviderId; name: string; sourceId: Source['id'] }[] = [
  { id: 'codex', name: 'Codex', sourceId: 'codex' },
  { id: 'claude', name: 'Claude', sourceId: 'claude' },
  { id: 'fable', name: 'Fable 5', sourceId: 'claude-fable' },
];

function sentence(text: string) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function planName(planType: string | null) {
  const value = planType?.trim();
  if (!value) return 'Allowance';
  if (value.toLowerCase() === 'pro') return 'ChatGPT Pro';
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
  let measurement = planName(current.planType);
  if (id === 'fable') {
    measurement =
      current.provenance === 'derived-tokens'
        ? 'Local estimate'
        : current.provenance === 'manual-official'
          ? 'Manual observation'
          : 'Provider reading';
    if (source && ['stale', 'degraded', 'error'].includes(source.status))
      measurement = `Stale ${measurement.toLowerCase()}`;
  }
  return `${sentence(measurement)} · ${sentence(windowLabel(current.windowMinutes))}`;
}

function providerNotes(id: ProviderId, current: QuotaWindow | null, source: Source | null) {
  const notes: string[] = [];
  if (!current) return notes;
  if (current.forecast.expired) return ['The last allowance window ended. A new provider reading is needed.'];
  if (current.provenance === 'derived-tokens') {
    notes.push('Allowance estimated from local activity and calibrated history.');
  }
  if (source && ['stale', 'degraded', 'error'].includes(source.status)) {
    notes.push(`Latest source status: ${source.status}. The balance is being projected from the last reading.`);
  }
  if (id === 'fable') {
    const activity = fableActivity(source);
    if (activity) {
      const activityStale = activity.activitySource && activity.activitySource !== 'current';
      notes.push(
        `${activityStale ? 'Cached local activity' : 'This device'}: ${compactNumber(activity.requests)} request${activity.requests === 1 ? '' : 's'} · ${compactNumber(activity.tokens)} tracked tokens.`,
      );
    }
  }
  return notes;
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
  return PROVIDERS.map(({ id, name, sourceId }) => {
    const quota = snapshot.quotas[id];
    const current = primaryWindow(quota);
    const expired = Boolean(current?.forecast.expired);
    const source = snapshot.sources.find((entry) => entry.id === sourceId) ?? null;
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
      stale: Boolean(
        expired ||
        (source && ['stale', 'degraded', 'error'].includes(source.status)) ||
        (current?.forecast.staleHours != null && current.forecast.staleHours > 24),
      ),
      notes: providerNotes(id, current, source),
      secondaryWindows: current
        ? quotaWindows(quota).filter((entry) => entry !== current && !entry.forecast.expired)
        : [],
    };
  });
}
