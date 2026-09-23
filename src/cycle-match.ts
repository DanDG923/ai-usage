import type { ProviderView } from './provider-view';
import type { CycleRow, Snapshot } from './types';

/**
 * The cycle row that belongs to the window a provider headlines. Cycle history
 * follows the backend's primary bucket, which the shared display rule also
 * makes the card's headline. Small reset-timestamp jitter is tolerated, but a
 * row with a different window length (a five-hour session beside a weekly
 * allowance) is never borrowed, and an expired window has no current row.
 */
export function currentCycleFor(view: ProviderView, snapshot: Snapshot): CycleRow | null {
  const quota = view.quota && !view.quota.forecast.expired ? view.quota : null;
  if (!quota) return null;
  const rows = snapshot.cycles[view.id] ?? [];
  return (
    rows.find(
      (row) =>
        row.current &&
        Math.abs(Date.parse(row.resetsAt) - Date.parse(quota.resetsAt)) <= 60_000 &&
        (!(quota.windowMinutes && quota.windowMinutes > 0) || row.windowMinutes === quota.windowMinutes),
    ) ?? null
  );
}
