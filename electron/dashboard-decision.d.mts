import type { DashboardVerdict, Settings, Snapshot } from '../src/types';

export function subscriptionVisible(settings: Partial<Settings> | undefined, providerId: string): boolean;
export function buildDashboardVerdict(snapshot?: {
  settings?: Partial<Settings>;
  quotas?: Snapshot['quotas'];
  sources?: Snapshot['sources'];
}): DashboardVerdict;
