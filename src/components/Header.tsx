import { RefreshCw } from 'lucide-react';
import { useRef } from 'react';
import { shortDate } from '../lib';
import type { Snapshot } from '../types';

export type Tab = 'overview' | 'details' | 'settings';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'details', label: 'Details' },
  { id: 'settings', label: 'Settings' },
];

/** The app mark: a small line trace, drawn inline so it takes the text colour. */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 9.5h3l2-6 3 9 2-5h3" />
    </svg>
  );
}

function refreshCadence(minutes: number) {
  if (!(minutes > 0)) return 'manual refresh';
  if (minutes >= 60) return `refreshes every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}`;
  return `refreshes every ${minutes} min`;
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
  // Arrow keys move between tabs, as the tablist pattern expects; only the
  // active tab is in the tab order.
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + TABS.length) % TABS.length;
    onTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };
  return (
    <header className="app-header">
      <button className="brand" onClick={() => onTab('overview')} aria-label="AI Usage, go to overview">
        <BrandMark />
        <span>AI Usage</span>
      </button>
      <nav role="tablist" aria-label="Sections">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTab(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={tab === item.id ? 'active' : ''}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <span>
          {snapshot.isPreview ? 'Preview' : `Updated ${shortDate(snapshot.generatedAt)}`} ·{' '}
          {refreshCadence(snapshot.settings.refreshIntervalMinutes)}
        </span>
        <button className="refresh-button" disabled={refreshing} onClick={onRefresh} title="Refresh (R)">
          <RefreshCw className={refreshing ? 'spin' : ''} aria-hidden="true" />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </header>
  );
}
