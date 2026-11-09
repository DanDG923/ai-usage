import { createContext, useContext } from 'react';
import { createNoticeChannel, type NoticeChannel } from '../components/NoticeToast';
import { bridgeSource, type BridgeSource } from './bridge';
import { createDashboardActions, type DashboardActions } from './dashboard-actions';
import { createDashboardStore, useStoreState, type DashboardState, type DashboardStore } from './dashboard-store';

/** One dashboard: its state, the actions that change it, and the notices they publish. */
export type Dashboard = {
  store: DashboardStore;
  actions: DashboardActions;
  notices: NoticeChannel;
  /** True in the installed app, where the preload's bridge is present. */
  desktop: boolean;
};

export function createDashboard({
  source = bridgeSource(),
  period = 30,
}: {
  source?: BridgeSource;
  /** The cost period the first read asks for. */
  period?: number;
} = {}): Dashboard {
  // Only a desktop window starts by reading: the preview waits for its demo
  // data, and a page with no bridge has nothing to wait for.
  const store = createDashboardStore({ period, refreshing: Boolean(source.desktop) });
  const notices = createNoticeChannel();
  return {
    store,
    actions: createDashboardActions({ store, source, notices }),
    notices,
    desktop: Boolean(source.desktop),
  };
}

/**
 * The dashboard a component belongs to. App provides the connected one. A
 * component drawn outside it (a Settings section rendered on its own) gets
 * this unconnected one: nothing is busy and its actions do nothing.
 */
export const DashboardContext = createContext<Dashboard>(
  createDashboard({ source: { desktop: undefined, preview: null } }),
);

/** The part of the dashboard's state a component draws; see useStoreState for what a selector may return. */
export function useDashboardState<T>(selector: (state: DashboardState) => T): T {
  return useStoreState(useContext(DashboardContext).store, selector);
}

/** The dashboard's actions. They are created once, so they are stable across renders. */
export function useDashboardActions(): DashboardActions {
  return useContext(DashboardContext).actions;
}
