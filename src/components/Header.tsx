import {
  ArrowLeft,
  CircleDashed,
  CircleDollarSign,
  History,
  Home,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SOURCES, subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { HEALTHY_SOURCE_STATUSES, STALE_SOURCE_STATUSES, relativeTime, shortDate } from '../lib';
import { allowanceNeedsRefresh, lastCollectedAt } from '../provider-view';
import type { ForecastState, Snapshot } from '../types';
import { BrandMark } from './BrandMark';
import { STATE_ICON } from './StatePill';

// The derivation lives with the other provider rules in provider-view.ts;
// the header still exports it beside sourceHealth and refreshCadence.
export { lastCollectedAt };

export type Tab = 'overview' | 'activity' | 'costs' | 'settings';

/** The page keys, in the order of their number shortcuts 1-4. */
export const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: Home },
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'costs', label: 'Costs', icon: CircleDollarSign },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

/** The collection schedule in words. The menu offers whole hours, but a restored setting can hold any minutes. */
export function refreshCadence(minutes: number) {
  if (!(minutes > 0)) return 'manual refresh';
  if (minutes >= 60 && minutes % 60 === 0) return `auto every ${minutes === 60 ? 'hour' : `${minutes / 60} hours`}`;
  return `auto every ${minutes} min`;
}

/**
 * One line on the health of the sources behind the visible subscriptions:
 * "3 sources current", or the ones that need attention by name. The icon is
 * paired with words, so the state never rests on colour. A source that
 * collected successfully still needs a refresh while the allowance it shows
 * is older than the verdict's freshness rule allows.
 */
export function sourceHealth(snapshot: Snapshot): { tone: ForecastState; text: string } {
  const visible = SOURCES.filter(({ id }) => subscriptionVisible(snapshot.settings, id));
  const rows = visible
    .map(({ id, healthId, label }) => ({
      label,
      source: snapshot.sources.find((entry) => entry.id === healthId),
      aged: allowanceNeedsRefresh(snapshot, id),
    }))
    .filter((row) => row.source);
  const failing = rows.filter((row) => row.source!.status === 'error');
  const stale = rows.filter((row) => row.aged || STALE_SOURCE_STATUSES.has(row.source!.status));
  const connected = rows.filter((row) => HEALTHY_SOURCE_STATUSES.has(row.source!.status));
  const list = (entries: typeof rows) => entries.map((row) => row.label).join(' and ');
  if (failing.length) return { tone: 'critical', text: `${list(failing)} unavailable` };
  if (stale.length) return { tone: 'watch', text: `${list(stale)} ${stale.length === 1 ? 'needs' : 'need'} a refresh` };
  if (!rows.length) return { tone: 'unknown', text: 'No sources connected' };
  return connected.length === rows.length
    ? { tone: 'safe', text: `${rows.length} source${rows.length === 1 ? '' : 's'} current` }
    : { tone: 'unknown', text: `${connected.length} of ${rows.length} sources connected` };
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

/** The glareshield before the first snapshot: the mark only, nothing to switch or refresh. */
export function BareGlareshield() {
  return (
    <header className="glareshield glareshield-bare">
      <div className="gs-brand" aria-label="AI Usage">
        <BrandMark />
        <span>AI Usage</span>
      </div>
    </header>
  );
}

/**
 * The glareshield bar: the mark, the numbered page keys (one tablist, with
 * 4 Settings set apart at the right end), then source health in words,
 * freshness and the refresh key laid over the space between them.
 */
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
  const now = useClock();
  const health = sourceHealth(snapshot);
  const HealthIcon = STATE_ICON[health.tone] ?? CircleDashed;
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

  return (
    <header className="glareshield">
      <button
        type="button"
        className="gs-brand"
        onClick={() => onTab('overview')}
        aria-label="AI Usage, go to overview"
      >
        <BrandMark />
        <span>AI Usage</span>
      </button>
      <div role="tablist" aria-orientation="horizontal" aria-label="Sections" className="gs-keys">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-keyshortcuts={String(index + 1)}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTab(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`gs-key${item.id === 'settings' ? ' gs-key-settings' : ''}${tab === item.id ? ' active' : ''}`}
          >
            <span className="gs-key-face">
              <span className="kc" aria-hidden="true">
                {index + 1}
              </span>
              {item.label}
            </span>
          </button>
        ))}
      </div>
      <div className="gs-status">
        {snapshot.isPreview && <span className="badge gs-preview">Preview data</span>}
        <span className={`gs-health ${health.tone}`}>
          <HealthIcon aria-hidden="true" />
          {health.text}
        </span>
        <span className="gs-fresh" title={`Snapshot ${shortDate(snapshot.generatedAt)}`}>
          {collectedAt == null ? 'Not collected yet' : `Updated ${relativeTime(collectedAt, now)}`}
          <span className="gs-cadence"> · {refreshCadence(snapshot.settings.refreshIntervalMinutes)}</span>
        </span>
        <button
          type="button"
          className="ibtn"
          disabled={refreshing}
          onClick={onRefresh}
          title={`${refreshing ? 'Refreshing' : 'Refresh'} (R)`}
          aria-label={refreshing ? 'Refreshing local usage' : 'Refresh local usage'}
          aria-keyshortcuts="R"
        >
          <RefreshCw className={refreshing ? 'spin' : ''} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/**
 * The ECAM title row under the glareshield: underlined caps naming the page,
 * or, on a provider page, the breadcrumb back to the Overview. Costs and
 * Activity draw their own title (their h1 is styled as one in shell.css), and
 * Settings keeps its only h1 for screen readers, so the titles drawn here are
 * visual and hidden from assistive technology; the tab already names the page.
 */
export function PageTitle({ tab, detail, onBack }: { tab: Tab; detail?: string | null; onBack?: () => void }) {
  if (detail) {
    return (
      <div className="page-title has-breadcrumb">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="btn" onClick={onBack} aria-label="Back to Overview (Esc)">
            <ArrowLeft aria-hidden="true" />
            Overview
          </button>
          <span aria-hidden="true">/</span>
          <strong aria-current="page">{detail}</strong>
        </nav>
        <span className="page-title-hint">
          <kbd className="kc">Esc</kbd> back to Overview
        </span>
      </div>
    );
  }
  const title = tab === 'overview' ? 'Overview' : tab === 'settings' ? 'Settings' : null;
  if (!title) return null;
  return (
    <div className="page-title">
      <p className="ecam-title" aria-hidden="true">
        {title}
      </p>
    </div>
  );
}

/** The footer strip: where the snapshot came from, and the keyboard shortcuts. */
export function FooterStrip({ snapshot }: { snapshot: Snapshot }) {
  return (
    <footer className="app-footer">
      <span>
        Snapshot {shortDate(snapshot.generatedAt)} · {snapshot.timezone} · Local data only
      </span>
      <span className="app-footer-keys">1–4 sections · R refresh · Esc dismiss toast / close provider page</span>
    </footer>
  );
}
