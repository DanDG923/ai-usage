import { ArrowLeft, CircleDollarSign, History, Home, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SOURCES, subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { relativeTime, shortDate } from '../lib';
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
  if (!(minutes > 0)) return 'manual refresh';
  if (minutes >= 60) return `auto every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}`;
  return `auto every ${minutes} min`;
}

/**
 * One line on the health of the sources behind the visible subscriptions:
 * "3 sources current", or the ones that need attention by name. The dot is
 * paired with words, so the state never rests on colour.
 */
export function sourceHealth(snapshot: Snapshot) {
  const visible = SOURCES.filter(({ id }) => subscriptionVisible(snapshot.settings, id));
  const rows = visible
    .map(({ healthId, label }) => ({ label, source: snapshot.sources.find((entry) => entry.id === healthId) }))
    .filter((row) => row.source);
  const failing = rows.filter((row) => row.source!.status === 'error');
  const stale = rows.filter((row) => ['stale', 'degraded'].includes(row.source!.status));
  const connected = rows.filter((row) => row.source!.status === 'connected');
  const list = (entries: typeof rows) => entries.map((row) => row.label).join(' and ');
  if (failing.length) return { tone: 'critical', text: `${list(failing)} unavailable` };
  if (stale.length) return { tone: 'watch', text: `${list(stale)} ${stale.length === 1 ? 'needs' : 'need'} a refresh` };
  if (!rows.length) return { tone: 'unknown', text: 'No sources connected' };
  return connected.length === rows.length
    ? { tone: 'safe', text: `${rows.length} source${rows.length === 1 ? '' : 's'} current` }
    : { tone: 'unknown', text: `${connected.length} of ${rows.length} sources connected` };
}

/**
 * When the visible subscriptions' sources last collected successfully. A
 * snapshot's generatedAt is when it was built, which happens on demand, so it
 * would read "just now" over data that is hours old.
 */
export function lastCollectedAt(snapshot: Snapshot): number | null {
  let latest: number | null = null;
  for (const { id, healthId } of SOURCES) {
    if (!subscriptionVisible(snapshot.settings, id)) continue;
    const at = Date.parse(snapshot.sources.find((entry) => entry.id === healthId)?.last_success_at ?? '');
    if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
  }
  return latest;
}

/** Re-render every half minute so "Updated 2 min ago" keeps counting between snapshots. */
function useClock(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Header({
  snapshot,
  tab,
  onTab,
  refreshing,
  onRefresh,
  detail,
  onBack,
}: {
  snapshot: Snapshot;
  tab: Tab;
  onTab: (tab: Tab) => void;
  refreshing: boolean;
  onRefresh: () => void;
  /** The provider page open inside the current section, shown as a breadcrumb. */
  detail?: string | null;
  onBack?: () => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = TABS.find((item) => item.id === tab) ?? TABS[0];
  const now = useClock();
  const health = sourceHealth(snapshot);
  const collectedAt = lastCollectedAt(snapshot);

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
        <div role="tablist" aria-orientation="vertical" aria-label="Sections">
          <div className="rail-primary">{TABS.slice(0, -1).map(tabButton)}</div>
          <div className="rail-secondary">{tabButton(TABS.at(-1)!, TABS.length - 1)}</div>
        </div>
      </aside>
      <header className="app-header">
        <div className="command-title">
          {detail ? (
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <button type="button" onClick={onBack}>
                <ArrowLeft aria-hidden="true" />
                {active.label}
              </button>
              <span aria-hidden="true">/</span>
              <strong aria-current="page">{detail}</strong>
            </nav>
          ) : (
            <strong>{active.label}</strong>
          )}
          {snapshot.isPreview && <span className="preview-tag">Preview data</span>}
        </div>
        <div className="header-actions">
          <span className={`source-health ${health.tone}`}>
            <i aria-hidden="true" />
            {health.text}
          </span>
          <span className="refresh-cadence" title={`Snapshot ${shortDate(snapshot.generatedAt)}`}>
            {collectedAt == null ? 'Not collected yet' : `Updated ${relativeTime(collectedAt, now)}`}
            <span className="refresh-auto"> · {refreshCadence(snapshot.settings.refreshIntervalMinutes)}</span>
          </span>
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
