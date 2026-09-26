import { buildDashboardVerdict } from '../electron/dashboard-decision.mjs';
import type { Quota, QuotaWindow, Snapshot } from './types';

// Claude reports one weekly reset up to a second apart across readings.
const RESET_TOLERANCE_MS = 60_000;

/**
 * A Fable window capped by a Claude weekly window that has since reset: the
 * week has refilled, so the cap no longer applies. Fable's own forecast
 * figures come back until the next snapshot rebuilds the combination.
 */
function releaseExpiredPool(entry: QuotaWindow, nowMs: number): QuotaWindow {
  const pool = entry.sharedPool;
  if (pool?.status !== 'applied' || !(Date.parse(pool.pool.resetsAt) + RESET_TOLERANCE_MS <= nowMs)) return entry;
  const { cap } = pool;
  return {
    ...entry,
    sharedPool: { status: 'unavailable', reason: 'pool-expired' },
    tokenCapacity: cap.tokenCapacity ?? entry.tokenCapacity,
    forecast: {
      ...entry.forecast,
      state: cap.state,
      expectedRemaining: cap.expectedRemaining,
      heavyRemaining: cap.heavyRemaining,
      exhaustsAt: cap.exhaustsAt,
      heavyExhaustsAt: cap.heavyExhaustsAt,
      paceRatio: cap.paceRatio,
      safePace: cap.safePace,
      recentPace: cap.recentPace,
      workingPace: cap.workingPace,
      windowPace: cap.windowPace,
      reservePercent: cap.reservePercent,
      confidence: cap.confidence,
      series: { observed: cap.observed, expected: cap.expected, heavy: cap.heavy },
    },
  };
}

/** Update only clock-dependent evidence; never manufacture a fresh collection. */
export function snapshotAtTime(snapshot: Snapshot, nowMs: number): Snapshot {
  const updateWindow = (value: QuotaWindow): QuotaWindow => {
    const entry = releaseExpiredPool(value, nowMs);
    return {
      ...entry,
      forecast: {
        ...entry.forecast,
        expired: entry.forecast.expired || Date.parse(entry.resetsAt) <= nowMs,
        staleHours: Math.max(entry.forecast.staleHours ?? 0, (nowMs - Date.parse(entry.observedAt)) / 3_600_000),
      },
    };
  };
  const updateQuota = (quota: Quota | null): Quota | null =>
    quota && {
      ...updateWindow(quota),
      windows: quota.windows.map(updateWindow),
    };
  const next = {
    ...snapshot,
    quotas: {
      codex: updateQuota(snapshot.quotas.codex),
      claude: updateQuota(snapshot.quotas.claude),
      fable: updateQuota(snapshot.quotas.fable),
    },
  };
  return { ...next, dashboardVerdict: buildDashboardVerdict(next) };
}
