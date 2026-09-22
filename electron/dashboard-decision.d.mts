import type { DashboardVerdict, Settings, Snapshot } from '../src/types';

export const SOURCES: { id: 'codex' | 'claude' | 'fable'; healthId: string; label: string }[];
export function subscriptionVisible(settings: Partial<Settings> | undefined, providerId: string): boolean;
export function buildDashboardVerdict(snapshot?: {
  settings?: Partial<Settings>;
  quotas?: Snapshot['quotas'];
  sources?: Snapshot['sources'];
  fableApplies?: boolean;
}): DashboardVerdict;

export function freshnessLimitHours(window: Partial<import('../src/types').QuotaWindow> | null | undefined): number;
export function evidenceNeedsRefresh(window: Partial<import('../src/types').QuotaWindow> | null | undefined): boolean;
