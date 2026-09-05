import { CircleDollarSign, History, Home, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { shortDate } from '../lib';
import type { Snapshot } from '../types';

export type Tab = 'overview' | 'activity' | 'costs' | 'settings';

export const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: Home },
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'costs', label: 'Costs', icon: CircleDollarSign },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

/** A restrained trace mark that remains legible at Windows title-bar size. */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 14.5h3.5L10 7l4 11 2.4-7H20" />
      <path d="M4.6 18.2A8.5 8.5 0 1 1 19.3 6" opacity=".7" />
    </svg>
  );
}

function refreshCadence(minutes: number) {
  if (!(minutes > 0)) return 'Manual refresh';
  if (minutes >= 60) return `Refreshes every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}`;
  return `Refreshes every ${minutes} min`;
}

export function Header({
  snapshot,
  tab,
  onTab,
  refreshing,
  onRefresh,
}: {
  snapshot: Snapshot;
  tab: Tab;
  onTab: (tab: Tab) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = TABS.find((item) => item.id === tab) ?? TABS[0];

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    const first = event.key === 'Home';
    const last = event.key === 'End';
    if (!forward && !backward && !first && !last) return;
    event.preventDefault();
    const next = first ? 0 : last ? TABS.length - 1 : (index + (forward ? 1 : -1) + TABS.length) % TABS.length;
    onTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const tabButton = (item: (typeof TABS)[number], index: number) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        ref={(element) => {
          tabRefs.current[index] = element;
        }}
        role="tab"
        id={`tab-${item.id}`}
        aria-selected={tab === item.id}
        aria-controls={`panel-${item.id}`}
        tabIndex={tab === item.id ? 0 : -1}
        onClick={() => onTab(item.id)}
        onKeyDown={(event) => onKeyDown(event, index)}
        className={tab === item.id ? 'active' : ''}
      >
        <Icon aria-hidden="true" />
        <span>{item.label}</span>
      </button>
    );
  };

  return (
    <>
      <aside className="app-rail">
        <button className="rail-brand" onClick={() => onTab('overview')} aria-label="AI Usage, go to overview">
          <BrandMark />
          <span>AI Usage</span>
        </button>
        <nav role="tablist" aria-orientation="vertical" aria-label="Sections">
          <div className="rail-primary">{TABS.slice(0, -1).map(tabButton)}</div>
          <div className="rail-secondary">{tabButton(TABS.at(-1)!, TABS.length - 1)}</div>
        </nav>
      </aside>
      <header className="app-header">
        <div className="command-title">
          <strong>{active.label}</strong>
          <span>{snapshot.isPreview ? 'Preview data' : `Updated ${shortDate(snapshot.generatedAt)}`}</span>
        </div>
        <div className="header-actions">
          <span className="refresh-cadence">{refreshCadence(snapshot.settings.refreshIntervalMinutes)}</span>
          <button
            className="icon-button"
            disabled={refreshing}
            onClick={onRefresh}
            title={`${refreshing ? 'Refreshing' : 'Refresh'} (R)`}
            aria-label={refreshing ? 'Refreshing local usage' : 'Refresh local usage'}
          >
            <RefreshCw className={refreshing ? 'spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>
    </>
  );
}
