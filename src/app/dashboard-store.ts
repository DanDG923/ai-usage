import { useSyncExternalStore } from 'react';
import { clockDelayMs, snapshotAtTime } from '../snapshot-time';
import type { Snapshot } from '../types';

/** The long-running data job in progress, which the Settings data controls wait for. */
export type DataOperation = 'backup' | 'restore' | 'export' | null;

export type DashboardState = {
  /**
   * What the dashboard shows. Null until the first snapshot arrives: an
   * installed window starts empty, and demo data only ever comes from the
   * browser preview's bridge.
   */
  snapshot: Snapshot | null;
  /**
   * The cost period on screen, in days. It changes only with the snapshot
   * that covers it, so a rejected 90-day read cannot relabel a 30-day view.
   */
  period: number;
  /** A read or a collection is running. */
  refreshing: boolean;
  /**
   * A requested Refresh has its own flag: a period read or a pushed update
   * clears `refreshing` when it lands, which must not re-enable Refresh while
   * the requested collection is still running.
   */
  manualRefreshing: boolean;
  /** Why the last read failed; cleared when a snapshot arrives. */
  loadError: string;
  dataOperation: DataOperation;
  /** True while the Claude helper is being enabled or disabled. */
  helperBusy: boolean;
};

/** Refresh is unavailable while either a read or a requested collection runs. */
export const selectBusy = (state: DashboardState) => state.refreshing || state.manualRefreshing;

/**
 * The dashboard's state, held outside React as NoticeToast's channel is: each
 * component subscribes to the part it draws (useStoreState), so a busy flag
 * changing re-renders its control and not the page around it. The store knows
 * nothing of the bridge; dashboard-actions.ts is what talks to it.
 */
export type DashboardStore = {
  get: () => DashboardState;
  set: (patch: Partial<DashboardState>) => void;
  subscribe: (listener: () => void) => () => void;
  /** The period the next snapshot should cover: the one being read, or the one on screen. */
  expectPeriod: (period: number) => void;
  /** Shows a snapshot from the bridge. One for another period updates everything but the costs. */
  commit: (next: Snapshot | null | undefined) => void;
  /** Keeps the display clock running until the returned function is called. */
  runClock: () => () => void;
};

export function createDashboardStore({
  period,
  refreshing = false,
}: {
  period: number;
  refreshing?: boolean;
}): DashboardStore {
  let state: DashboardState = {
    snapshot: null,
    period,
    refreshing,
    manualRefreshing: false,
    loadError: '',
    dataOperation: null,
    helperBusy: false,
  };
  let expectedPeriod = period;
  const listeners = new Set<() => void>();
  let clockRunning = false;
  let clockTimer: ReturnType<typeof setTimeout> | undefined;

  // Re-evaluate evidence and expiry locally even while collection is offline:
  // wake at the first reset (or the next minute) and advance the clock,
  // without changing the data revision.
  const armClock = () => {
    clearTimeout(clockTimer);
    clockTimer = undefined;
    if (!clockRunning || !state.snapshot) return;
    clockTimer = setTimeout(
      () => {
        if (state.snapshot) set({ snapshot: snapshotAtTime(state.snapshot, Date.now()) });
      },
      clockDelayMs(state.snapshot, Date.now()),
    );
  };

  const set = (patch: Partial<DashboardState>) => {
    const keys = Object.keys(patch) as (keyof DashboardState)[];
    if (keys.every((key) => Object.is(state[key], patch[key]))) return;
    const previous = state;
    state = { ...state, ...patch };
    if (state.snapshot !== previous.snapshot) armClock();
    for (const listener of listeners) listener();
  };

  return {
    get: () => state,
    set,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    expectPeriod(next) {
      expectedPeriod = next;
    },
    commit(next) {
      if (!next) return;
      // The selected period is committed with the data, never before it. A
      // snapshot for another period (a push that raced a period change) keeps
      // the costs already on screen.
      const current = state.snapshot;
      if (next.costs.periodDays === expectedPeriod) set({ snapshot: next, period: next.costs.periodDays });
      else if (current)
        set({ snapshot: { ...next, costs: current.costs, desktopEstimates: current.desktopEstimates } });
      else set({ snapshot: next });
    },
    runClock() {
      clockRunning = true;
      armClock();
      return () => {
        clockRunning = false;
        armClock();
      };
    },
  };
}

/**
 * Reads one part of the store and re-renders when that part changes. The
 * selector must return a value held in the state or a primitive derived from
 * it, never a new object.
 */
export function useStoreState<T>(store: DashboardStore, selector: (state: DashboardState) => T): T {
  const read = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
