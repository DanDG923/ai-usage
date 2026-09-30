import { buildDashboardVerdict } from '../electron/dashboard-decision.mjs';
import type { Quota, QuotaWindow, Snapshot, TokenCapacityEstimate } from './types';

// Claude reports one weekly reset up to a second apart across readings.
const RESET_TOLERANCE_MS = 60_000;
// The backend's cutoff for a remaining-token estimate (STALENESS_MS in
// electron/token-capacity.cjs), and the warning it gives in its place.
const TOKEN_CAPACITY_STALENESS_MS = 24 * 3_600_000;
const STALE_REMAINDER_WARNING =
  'The latest official reading is over 24 hours old; remaining tokens need a fresh reading.';

/** The time a view should treat as now: the display clock, or the build time before it first advances. */
export function snapshotNowMs(snapshot: Snapshot): number {
  return Date.parse(snapshot.clockAt ?? snapshot.generatedAt);
}

/**
 * The remaining-token estimate the backend would give at this time: it drops
 * the remainder once its official reading is over a day old, while the
 * full-window capacity stays. Between rebuilds only the clock moves.
 */
function ageTokenCapacity<T extends TokenCapacityEstimate | null | undefined>(estimate: T, nowMs: number): T {
  if (!estimate?.remainingAsOf || !(nowMs - Date.parse(estimate.remainingAsOf) > TOKEN_CAPACITY_STALENESS_MS))
    return estimate;
  return {
    ...estimate,
    remainingTokens: null,
    remainingRange: null,
    remainingAsOf: null,
    warnings: estimate.warnings.includes(STALE_REMAINDER_WARNING)
      ? estimate.warnings
      : [...estimate.warnings, STALE_REMAINDER_WARNING],
  };
}

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
      tokenCapacity: ageTokenCapacity(entry.tokenCapacity, nowMs),
      forecast: {
        ...entry.forecast,
        expired: entry.forecast.expired || Date.parse(entry.resetsAt) <= nowMs,
        staleHours: Math.max(
          entry.forecast.staleHours ?? 0,
          (nowMs - Date.parse(entry.evidenceAt ?? entry.observedAt)) / 3_600_000,
        ),
      },
    };
  };
  const updateQuota = (quota: Quota | null): Quota | null =>
    quota && {
      ...updateWindow(quota),
      windows: quota.windows.map(updateWindow),
    };
  // The display clock never runs behind the build time it started from.
  const builtAt = Date.parse(snapshot.generatedAt);
  const next = {
    ...snapshot,
    clockAt: new Date(Number.isFinite(builtAt) ? Math.max(nowMs, builtAt) : nowMs).toISOString(),
    quotas: {
      codex: updateQuota(snapshot.quotas.codex),
      claude: updateQuota(snapshot.quotas.claude),
      fable: updateQuota(snapshot.quotas.fable),
    },
  };
  return { ...next, dashboardVerdict: buildDashboardVerdict(next) };
}
