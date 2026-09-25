import { demoSnapshot } from './data/demo';
import type { DashboardVerdict, FlyoutBridge, FlyoutSnapshot, ForecastState, Quota } from './types';

/*
 * The tray flyout's browser-preview bridge: the demo snapshot behind the
 * FlyoutBridge interface, so http://127.0.0.1:<port>/flyout.html renders real
 * rows. flyout.tsx loads it only when there is no window.aiUsageFlyout and the
 * page is not a file: URL, which is never the case in Electron.
 *
 * ?demo=<variant> previews a state for visual QA:
 *   loading      the first snapshot never arrives
 *   unavailable  the snapshot read fails
 *   closing      the store is closing (a null snapshot, no error)
 *   refresh-error, snooze-error  that action fails
 *   snoozed      alerts are snoozed for an hour
 *   render-error the rows throw while drawing (the boundary's fallback)
 *   safe, watch, critical, partial, learning, waiting, single   verdict and row states
 */

const HOUR = 3_600_000;

function setState(quota: Quota | null, state: ForecastState, clearForecast = false) {
  if (!quota) return;
  for (const entry of [quota, ...(quota.windows ?? [])]) {
    entry.forecast = {
      ...entry.forecast,
      state,
      ...(clearForecast ? { expectedRemaining: null, heavyRemaining: null } : {}),
    };
  }
}

function verdictFor(snapshot: FlyoutSnapshot, state: ForecastState, label: string): DashboardVerdict {
  const current = snapshot.dashboardVerdict;
  return {
    ...current,
    state,
    label,
    details: current.details.map((entry) => ({ ...entry, state })),
  };
}

function demoFlyoutSnapshot(variant: string): FlyoutSnapshot {
  const snapshot = structuredClone(demoSnapshot) as unknown as FlyoutSnapshot;
  const now = Date.parse(snapshot.generatedAt);
  const { quotas } = snapshot;
  if (variant === 'snoozed') snapshot.settings.alertsSnoozedUntil = new Date(now + HOUR).toISOString();
  if (variant === 'safe') {
    setState(quotas.fable, 'safe');
    snapshot.dashboardVerdict = { ...verdictFor(snapshot, 'safe', 'All allowances on track'), affected: [] };
  }
  if (variant === 'watch') {
    setState(quotas.fable, 'watch');
    snapshot.dashboardVerdict = verdictFor(snapshot, 'watch', 'Fable 5 is using its allowance faster than usual');
  }
  if (variant === 'critical') {
    setState(quotas.fable, 'critical');
    snapshot.dashboardVerdict = verdictFor(snapshot, 'critical', 'Fable 5 is projected to run out before reset');
  }
  if (variant === 'partial' || variant === 'learning') {
    setState(quotas.fable, 'unknown', true);
    snapshot.dashboardVerdict = {
      ...verdictFor(snapshot, 'unknown', 'Available allowances on track'),
      affected: [],
    };
  }
  if (variant === 'learning') setState(quotas.codex, 'unknown', true);
  if (variant === 'single') {
    snapshot.settings.showClaudeSubscription = false;
    snapshot.dashboardVerdict = { ...verdictFor(snapshot, 'safe', 'All allowances on track'), affected: [] };
  }
  if (variant === 'render-error' && quotas.codex) {
    // A reset time that throws when read, so drawing the Codex cell fails.
    const unreadable = {
      [Symbol.toPrimitive]() {
        throw new Error('A preview row failed to draw.');
      },
    } as unknown as string;
    for (const entry of [quotas.codex, ...(quotas.codex.windows ?? [])]) entry.resetsAt = unreadable;
  }
  if (variant === 'waiting') {
    quotas.codex = null;
    quotas.claude = null;
    quotas.fable = null;
  }
  return snapshot;
}

export function previewFlyoutBridge(): FlyoutBridge {
  const variant = new URLSearchParams(window.location.search).get('demo') ?? '';
  let current = demoFlyoutSnapshot(variant);
  const later = <T>(value: T, ms = 400) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));
  const fail = (message: string, ms = 400) =>
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(message)), ms));
  return {
    getSnapshot() {
      if (variant === 'loading') return new Promise(() => {});
      if (variant === 'unavailable') return fail('The local usage store could not be opened.', 0);
      if (variant === 'closing') return Promise.resolve(null);
      return Promise.resolve(current);
    },
    onUpdated: () => () => {},
    refresh() {
      if (variant === 'refresh-error') return fail('Codex could not be read.', 600);
      return later(current, 600);
    },
    openDashboard: () => Promise.resolve(),
    snooze(hours) {
      if (variant === 'snooze-error') return fail('Settings are read-only in the preview.');
      const until = hours > 0 ? new Date(Date.parse(current.generatedAt) + hours * HOUR).toISOString() : null;
      current = { ...current, settings: { ...current.settings, alertsSnoozedUntil: until } };
      return later(current, 150);
    },
    close: () => Promise.resolve(),
  };
}
