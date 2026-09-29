import { dailyBudget, paceLabel } from '../../budget';
import { providerViews, type ProviderId } from '../../provider-view';
import { snapshotNowMs } from '../../snapshot-time';
import type { Snapshot } from '../../types';

export type BudgetPreviewEntry = { id: ProviderId; name: string; budget: number; label: string };

/**
 * Each visible provider's daily budget for its headline window, as the
 * Overview computes it, with an optional reserve that has not been saved yet.
 * Providers still learning or waiting for a reading have no budget and are left out.
 */
export function budgetPreview(snapshot: Snapshot, reserveOverride?: number): BudgetPreviewEntry[] {
  const nowMs = snapshotNowMs(snapshot);
  return providerViews(snapshot).flatMap((view) => {
    const budget = dailyBudget(view.current, snapshot.settings, nowMs, reserveOverride);
    return budget ? [{ id: view.id, name: view.name, budget: budget.budget, label: paceLabel(budget.budget) }] : [];
  });
}
