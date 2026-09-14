import { buildDashboardVerdict } from '../electron/dashboard-decision.mjs';
import type { Quota, QuotaWindow, Snapshot } from './types';

/** Update only clock-dependent evidence; never manufacture a fresh collection. */
export function snapshotAtTime(snapshot: Snapshot, nowMs: number): Snapshot {
  const updateWindow = (entry: QuotaWindow): QuotaWindow => ({
    ...entry,
    forecast: {
      ...entry.forecast,
      expired: entry.forecast.expired || Date.parse(entry.resetsAt) <= nowMs,
      staleHours: Math.max(entry.forecast.staleHours ?? 0, (nowMs - Date.parse(entry.observedAt)) / 3_600_000),
    },
  });
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
