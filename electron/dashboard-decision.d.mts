import type { DashboardVerdict, Settings, Snapshot } from '../src/types';

export const SOURCES: { id: 'codex' | 'claude' | 'fable'; healthId: string; label: string }[];
export function subscriptionVisible(settings: Partial<Settings> | undefined, providerId: string): boolean;
export function buildDashboardVerdict(snapshot?: {
  settings?: Partial<Settings>;
  quotas?: Snapshot['quotas'];
  sources?: Snapshot['sources'];
  fableApplies?: boolean;
}): DashboardVerdict;

/** The Claude weekly bucket a Fable window's state follows, when the pool rather than Fable's own limit drives it. */
export function poolDrivenBucket(window: Partial<import('../src/types').QuotaWindow> | null | undefined): string | null;
/** Whether a pool-driven Fable window is reported under this Claude window instead of on its own. */
export function foldsInto(
  fableWindow: Partial<import('../src/types').QuotaWindow> | null | undefined,
  claudeWindow: Partial<import('../src/types').QuotaWindow> | null | undefined,
): boolean;

/** Whether a Fable figure depends on the Claude weekly limit now, on the expected path or on the heavier one. */
export function dependsOnClaudeWeekly(fableWindow: Partial<import('../src/types').QuotaWindow> | null | undefined): boolean;
/** The Claude weekly window a capped Fable figure follows, when its reading needs a Refresh. */
export function stalePoolWindow(
  fableWindow: Partial<import('../src/types').QuotaWindow> | null | undefined,
  claudeQuota: import('../src/types').Quota | null | undefined,
): import('../src/types').QuotaWindow | null;

export function freshnessLimitHours(window: Partial<import('../src/types').QuotaWindow> | null | undefined): number;
export function evidenceNeedsRefresh(window: Partial<import('../src/types').QuotaWindow> | null | undefined): boolean;
