import { Activity, RefreshCw } from 'lucide-react';
import { useRef } from 'react';
import { displayedRemaining, isEstimated, primaryWindow, shortDate } from '../lib';
import type { Snapshot } from '../types';

export type Tab = 'overview' | 'details' | 'settings';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'details', label: 'Details' },
  { id: 'settings', label: 'Data & settings' },
];

function headlineNumbers(snapshot: Snapshot) {
  const entries: { label: string; quota: Snapshot['quotas'][keyof Snapshot['quotas']] }[] = [
    { label: 'Codex', quota: snapshot.quotas.codex },
    { label: 'Claude', quota: snapshot.quotas.claude },
    { label: 'Fable', quota: snapshot.quotas.fable },
  ];
  return entries
    .map(({ label, quota }) => {
      const window = primaryWindow(quota);
      if (!window || window.forecast.expired) return `${label} —`;
      return `${label} ${isEstimated(window) ? '~' : ''}${Math.round(displayedRemaining(window))}%`;
    })
    .join(' · ');
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
  const { state, label } = snapshot.dashboardVerdict;
  const numbers = headlineNumbers(snapshot);
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
        <span className="brand-orbit" aria-hidden="true">
          <Activity />
        </span>
        <span>AI Usage</span>
      </button>
      <nav role="tablist" aria-label="Dashboard sections">
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
      <div className={`verdict-chip ${state}`} role="status" aria-live="polite" aria-atomic="true">
        <span className="verdict-label">{label}</span>
        <span className="verdict-numbers" title="Remaining allowance">
          {numbers}
        </span>
      </div>
      <div className="header-actions">
        <span>
          {snapshot.isPreview ? 'Preview · ' : 'Updated '}
          {shortDate(snapshot.generatedAt)}
        </span>
        <button className="refresh-button" disabled={refreshing} onClick={onRefresh} title="Refresh (R)">
          <RefreshCw className={refreshing ? 'spin' : ''} aria-hidden="true" />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </header>
  );
}
