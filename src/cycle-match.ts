import type { ProviderView } from './provider-view';
import type { CycleRow, Snapshot } from './types';

// Providers report one reset up to a second or so apart across readings (see
// snapshot-time.ts), so two reset times this close are the same reset.
const RESET_TOLERANCE_MS = 60_000;

/**
 * Whether a window ended before its scheduled reset. Every list of past
 * windows asks here, so the Activity page and a provider's page cannot
 * disagree about one row: an end within the jitter of reported reset times is
 * the ordinary reset.
 */
export function cycleEndedEarly(row: Pick<CycleRow, 'endsAt' | 'resetsAt'>): boolean {
  return Boolean(row.endsAt) && Math.abs(Date.parse(row.endsAt!) - Date.parse(row.resetsAt)) > RESET_TOLERANCE_MS;
}

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
        Math.abs(Date.parse(row.resetsAt) - Date.parse(quota.resetsAt)) <= RESET_TOLERANCE_MS &&
        (!(quota.windowMinutes && quota.windowMinutes > 0) || row.windowMinutes === quota.windowMinutes),
    ) ?? null
  );
}
