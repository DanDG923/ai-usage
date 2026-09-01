import { Activity, RefreshCw } from 'lucide-react';
import { displayedRemaining, isEstimated, primaryWindow, shortDate } from '../lib';
import type { Snapshot } from '../types';

export type Tab = 'overview' | 'details' | 'settings';

const TABS: { id: Tab; label: string }[] = [
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
  return (
    <header className="app-header">
      <button className="brand" onClick={() => onTab('overview')} aria-label="AI Usage, go to overview">
        <span className="brand-orbit" aria-hidden="true">
          <Activity />
        </span>
        <span>AI Usage</span>
      </button>
      <nav role="tablist" aria-label="Dashboard sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => onTab(item.id)}
            className={tab === item.id ? 'active' : ''}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className={`verdict-chip ${state}`} role="status" aria-live="polite" aria-atomic="true">
        <span className="verdict-label">{label}</span>
        <span className="verdict-numbers" aria-label={`Remaining allowance: ${numbers}`}>
          {numbers}
        </span>
      </div>
      <div className="header-actions">
        <span>
          {snapshot.isPreview ? 'Browser preview · ' : 'Last generated '}
          {shortDate(snapshot.generatedAt)}
        </span>
        <button className="refresh-button" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={refreshing ? 'spin' : ''} aria-hidden="true" />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </header>
  );
}
