import { AlertTriangle, Bell, BellOff, CheckCircle2, Gauge, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { dailyBudget, paceLabel } from '../budget';
import { percent, quotaWindows, relativeTime, timeLabel, verdictSentence, whenLabel } from '../lib';
import { providerViews, type ProviderView } from '../provider-view';
import type {
  DashboardNavigation,
  DashboardVerdict,
  FlyoutSnapshot,
  ForecastState,
  Quota,
  Settings,
  Snapshot,
  Source,
  Theme,
} from '../types';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const STATUS: Record<ForecastState, { label: string; tone: Tone; icon: LucideIcon }> = {
  safe: { label: 'On track', tone: 'ok', icon: CheckCircle2 },
  watch: { label: 'Watch', tone: 'warn', icon: AlertTriangle },
  risk: { label: 'At risk', tone: 'warn', icon: AlertTriangle },
  critical: { label: 'Critical', tone: 'bad', icon: AlertTriangle },
  unknown: { label: 'Learning', tone: 'muted', icon: Gauge },
};

const STATES = Object.keys(STATUS) as ForecastState[];

const WAITING_VERDICT: DashboardVerdict = {
  state: 'unknown',
  reason: null,
  label: 'Waiting for allowance readings',
  windowsChecked: 0,
  affected: [],
  details: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Only windows carrying a forecast can be drawn; anything else is treated as
// no reading rather than risking a render error in a glanceable surface.
function hasForecast(value: unknown) {
  return isRecord(value) && isRecord(value.forecast);
}

function normalizeQuota(value: unknown): Quota | null {
  if (!hasForecast(value)) return null;
  const quota = value as unknown as Quota;
  const windows = Array.isArray(quota.windows) ? quota.windows.filter(hasForecast) : [];
  return { ...quota, windows };
}

function normalizeVerdict(value: unknown): DashboardVerdict {
  if (!isRecord(value) || !STATES.includes(value.state as ForecastState)) return WAITING_VERDICT;
  const verdict = value as unknown as DashboardVerdict;
  return {
    ...verdict,
    label: typeof verdict.label === 'string' ? verdict.label : WAITING_VERDICT.label,
    affected: Array.isArray(verdict.affected) ? verdict.affected.filter((entry) => typeof entry === 'string') : [],
    details: Array.isArray(verdict.details) ? verdict.details.filter(isRecord) : [],
  };
}

/**
 * The flyout accepts whatever the main process sends and fills anything
 * missing with an explicit "no reading" shape, never with invented numbers.
 */
export function normalizeFlyoutSnapshot(value: unknown): FlyoutSnapshot | null {
  if (!isRecord(value)) return null;
  const quotas = isRecord(value.quotas) ? value.quotas : {};
  return {
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    timezone: typeof value.timezone === 'string' ? value.timezone : undefined,
    settings: (isRecord(value.settings) ? value.settings : {}) as Settings,
    sources: (Array.isArray(value.sources) ? value.sources.filter(isRecord) : []) as Source[],
    quotas: {
      codex: normalizeQuota(quotas.codex),
      claude: normalizeQuota(quotas.claude),
      fable: normalizeQuota(quotas.fable),
    },
    fableApplies: typeof value.fableApplies === 'boolean' ? value.fableApplies : undefined,
    dashboardVerdict: normalizeVerdict(value.dashboardVerdict),
  };
}

/** Same rule as App.tsx: an explicit choice is pinned, "system" follows Windows. */
function applyThemeAttribute(theme: Theme | undefined) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason || 'Unknown local error.');
}

/** The app's trace mark, as drawn by BrandMark in Header.tsx. */
function BrandMark() {
  return (
    <svg
      className="flyout-brand-mark"
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

// A snapshot's generatedAt is when it was built, which is every time the
// flyout opens. When the sources were last collected is what "Updated" means.
function lastCollectedAt(views: ProviderView[], sources: Source[]) {
  const relevant = views.length ? views.map((view) => view.source) : sources;
  let latest = Number.NaN;
  for (const source of relevant) {
    const at = Date.parse(source?.last_success_at ?? '');
    if (Number.isFinite(at) && !(at <= latest)) latest = at;
  }
  return Number.isFinite(latest) ? latest : null;
}

type VerdictView = { tone: 'safe' | 'warn' | 'bad' | 'neutral'; headline: string; detail: string };

function verdictView(snapshot: FlyoutSnapshot, views: ProviderView[], snapshotMs: number): VerdictView {
  if (!views.length) {
    return {
      tone: 'neutral',
      headline: 'No subscriptions shown',
      detail: 'Choose subscriptions in Settings to see their allowances here.',
    };
  }
  if (views.every((view) => !view.current || view.expired)) {
    return {
      tone: 'neutral',
      headline: 'Waiting for allowance readings',
      detail: 'They appear after the next refresh.',
    };
  }
  const verdict = snapshot.dashboardVerdict;
  if (verdict.state === 'safe') return { tone: 'safe', headline: 'All allowances on track', detail: '' };
  const { settings, quotas } = snapshot;
  // As the Overview does: hidden subscriptions are never named as on track.
  const sentence = verdictSentence(
    verdict,
    {
      codex: settings.showCodexSubscription !== false ? quotas.codex : null,
      claude: settings.showClaudeSubscription !== false ? quotas.claude : null,
      fable: settings.showClaudeSubscription !== false ? quotas.fable : null,
    },
    snapshot.sources,
  );
  let detail = sentence.secondary;
  const affected = verdict.details.filter((entry) => entry.state !== 'safe');
  if (new Set(affected.map((entry) => entry.sourceId)).size === 1) {
    // Budget the window the verdict names, which may be a shorter session
    // beside the headline weekly allowance; dailyBudget declines windows under a day.
    const view = views.find((entry) => entry.id === affected[0].sourceId);
    // As the Overview's status line: the named window, else the headline one.
    const window =
      quotaWindows(view?.quota).find((entry) => entry.bucketId === affected[0].bucketId && !entry.forecast.expired) ??
      view?.current;
    const budget = window ? dailyBudget(window, settings, snapshotMs) : null;
    if (budget && budget.budget > 0) detail = `Stay under ${paceLabel(budget.budget)} a day to reach the reset.`;
  }
  const tone = verdict.state === 'critical' ? 'bad' : verdict.state === 'unknown' ? 'neutral' : 'warn';
  return { tone, headline: sentence.headline, detail };
}

function ProviderRow({
  view,
  nowMs,
  onOpen,
}: {
  view: ProviderView;
  nowMs: number;
  onOpen?: (target: DashboardNavigation) => void;
}) {
  const status = STATUS[view.state] ?? STATUS.unknown;
  const StatusIcon = status.icon;
  const waiting = !view.current || view.expired;
  const learning = view.state === 'unknown';
  const remaining = waiting ? null : view.remaining;
  const atReset = waiting || learning ? null : view.expectedRemaining;
  const approx = view.estimated ? '~' : '';
  const reset = whenLabel(view.resetAt, nowMs);
  const detail = waiting
    ? 'Waiting for a reading'
    : atReset == null
      ? `Resets ${reset}`
      : `${percent(atReset)} at reset · ${reset}`;
  const barLabel =
    remaining == null
      ? 'No allowance reading yet'
      : atReset == null
        ? `${approx}${percent(remaining)} left now; no forecast yet`
        : `${approx}${percent(remaining)} left now; about ${percent(atReset)} expected to be left at reset`;
  return (
    <li>
      <button
        type="button"
        className="flyout-row"
        data-provider={view.id}
        title={`Open ${view.name} in the dashboard`}
        onClick={() => onOpen?.({ tab: 'overview', provider: view.id })}
      >
        <span className="flyout-row-top">
          <span className="flyout-swatch" aria-hidden="true" />
          <span className="flyout-row-name">
            <strong>{view.name}</strong>
            <span>{view.subtitle}</span>
          </span>
          {remaining == null ? (
            <span className="flyout-left flyout-left-none">
              <span aria-hidden="true">—</span>
              <span className="flyout-visually-hidden">No reading</span>
            </span>
          ) : (
            <span className="flyout-left">
              <strong>
                {approx}
                {percent(remaining)}
              </strong>
              <small>left</small>
            </span>
          )}
        </span>
        <span className="flyout-track" role="img" aria-label={barLabel}>
          {/* Without a forecast the balance is outlined: neither legend entry
              ("left at reset", "likely used") would be true of it. */}
          {remaining != null && (
            <span
              className={`flyout-fill ${atReset == null ? 'flyout-fill-now' : 'flyout-fill-used'}`}
              style={{ width: `${remaining}%` }}
            />
          )}
          {atReset != null && <span className="flyout-fill flyout-fill-reset" style={{ width: `${atReset}%` }} />}
        </span>
        <span className="flyout-row-bottom">
          <span className={`flyout-status ${status.tone}`}>
            <StatusIcon aria-hidden="true" />
            {status.label}
          </span>
          <span className="flyout-row-detail">{detail}</span>
        </span>
      </button>
    </li>
  );
}

export type TrayFlyoutProps = {
  /** Undefined while the first snapshot loads; null when it is unavailable. */
  snapshot: FlyoutSnapshot | null | undefined;
  /** The clock for relative labels, kept by the caller so rendering stays pure. */
  nowMs: number;
  refreshing?: boolean;
  error?: string;
  onRefresh?: () => void;
  onOpenDashboard?: (target: DashboardNavigation) => void;
  onSnooze?: (hours: number) => void;
};

export function TrayFlyout({
  snapshot,
  nowMs,
  refreshing = false,
  error = '',
  onRefresh,
  onOpenDashboard,
  onSnooze,
}: TrayFlyoutProps) {
  const views = snapshot ? providerViews(snapshot as unknown as Snapshot) : [];
  const parsedMs = snapshot ? Date.parse(snapshot.generatedAt) : Number.NaN;
  const snapshotMs = Number.isFinite(parsedMs) ? parsedMs : nowMs;
  const verdict: VerdictView = snapshot
    ? verdictView(snapshot, views, snapshotMs)
    : snapshot === null
      ? {
          tone: 'neutral',
          headline: 'Allowances are unavailable right now',
          detail: 'Open the dashboard for details.',
        }
      : { tone: 'neutral', headline: 'Loading allowances…', detail: '' };
  const VerdictIcon = verdict.tone === 'safe' ? CheckCircle2 : verdict.tone === 'neutral' ? Gauge : AlertTriangle;
  const collectedAt = snapshot ? lastCollectedAt(views, snapshot.sources) : null;
  const updated = refreshing
    ? 'Refreshing…'
    : collectedAt == null
      ? snapshot
        ? 'Not updated yet'
        : ''
      : `Updated ${relativeTime(collectedAt, nowMs)}`;
  const snoozedUntil = Date.parse(snapshot?.settings.alertsSnoozedUntil ?? '');
  const snoozed = Number.isFinite(snoozedUntil) && snoozedUntil > nowMs;

  return (
    <div className="flyout">
      <header className="flyout-header">
        <BrandMark />
        <span className="flyout-title">AI Usage</span>
        <span className="flyout-updated">{updated}</span>
        <button
          type="button"
          className="flyout-icon-button flyout-refresh"
          aria-label="Refresh now"
          title="Refresh now"
          aria-disabled={refreshing || !onRefresh}
          onClick={() => {
            if (!refreshing) onRefresh?.();
          }}
        >
          <RefreshCw className={refreshing ? 'flyout-spin' : undefined} aria-hidden="true" />
        </button>
      </header>

      <section className={`flyout-verdict ${verdict.tone}`} role="status">
        <VerdictIcon className="flyout-verdict-icon" aria-hidden="true" />
        <div>
          <strong>{verdict.headline}</strong>
          {verdict.detail && <p>{verdict.detail}</p>}
        </div>
      </section>

      {error && (
        <p className="flyout-error" role="alert">
          {error}
        </p>
      )}

      {views.length > 0 && (
        <>
          <ul className="flyout-list" aria-label="Allowances">
            {views.map((view) => (
              <ProviderRow key={view.id} view={view} nowMs={nowMs} onOpen={onOpenDashboard} />
            ))}
          </ul>
          <p className="flyout-legend">
            <span>
              <i className="flyout-chip flyout-chip-reset" aria-hidden="true" />
              Left at reset
            </span>
            <span>
              <i className="flyout-chip flyout-chip-used" aria-hidden="true" />
              Likely used before reset
            </span>
          </p>
        </>
      )}

      <footer className="flyout-footer">
        <button type="button" className="flyout-primary" onClick={() => onOpenDashboard?.({ tab: 'overview' })}>
          Open dashboard
        </button>
        {snoozed ? (
          <button
            type="button"
            className="flyout-secondary"
            title={`Alerts are snoozed until ${timeLabel(snoozedUntil, nowMs)}`}
            onClick={() => onSnooze?.(0)}
          >
            <Bell aria-hidden="true" />
            Resume alerts
          </button>
        ) : (
          <button
            type="button"
            className="flyout-secondary"
            aria-label="Snooze alerts for 1 hour"
            title="Snooze alerts for 1 hour"
            disabled={!snapshot}
            onClick={() => onSnooze?.(1)}
          >
            <BellOff aria-hidden="true" />
            Snooze 1 h
          </button>
        )}
        <button
          type="button"
          className="flyout-icon-button flyout-settings"
          aria-label="Settings"
          title="Settings"
          onClick={() => onOpenDashboard?.({ tab: 'settings' })}
        >
          <SettingsIcon aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}

type BoundaryProps = { children: ReactNode; resetKey: unknown; onOpenDashboard: () => void };

// A render error shows a way to the dashboard instead of an empty window; the
// next snapshot tries again. Keyed resets would remount and drop focus.
type BoundaryState = { failed: boolean; resetKey: unknown };

class FlyoutBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flyout">
        <section className="flyout-verdict neutral" role="alert">
          <AlertTriangle className="flyout-verdict-icon" aria-hidden="true" />
          <div>
            <strong>The allowances could not be shown</strong>
            <p>The dashboard has the full detail.</p>
          </div>
        </section>
        <footer className="flyout-footer">
          <button type="button" className="flyout-primary" onClick={this.props.onOpenDashboard}>
            Open dashboard
          </button>
        </footer>
      </div>
    );
  }
}

/** The flyout page: TrayFlyout connected to window.aiUsageFlyout. */
export function FlyoutApp() {
  const bridge = typeof window === 'undefined' ? undefined : window.aiUsageFlyout;
  const [snapshot, setSnapshot] = useState<FlyoutSnapshot | null | undefined>(bridge ? undefined : null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  // The window is revealed at its first non-empty paint and sized to the page.
  // Painting nothing until the first snapshot (normally a few milliseconds)
  // keeps it from opening at the loading state's height and then growing.
  const [loadingVisible, setLoadingVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLoadingVisible(true), 1_000);
    return () => window.clearTimeout(timer);
  }, []);

  const accept = useCallback((value: unknown) => {
    const next = normalizeFlyoutSnapshot(value);
    if (next) {
      setSnapshot(next);
      setNowMs(Date.now());
    }
  }, []);

  useEffect(() => {
    if (!bridge) return undefined;
    let live = true;
    let pushed = false;
    // Subscribe first; a push that lands before the first reply is newer.
    const release = bridge.onUpdated((next) => {
      pushed = true;
      accept(next);
    });
    bridge.getSnapshot().then(
      (first) => {
        if (live && !pushed) setSnapshot(normalizeFlyoutSnapshot(first));
      },
      (reason) => {
        if (!live || pushed) return;
        setSnapshot(null);
        setError(errorText(reason));
      },
    );
    return () => {
      live = false;
      release();
    };
  }, [bridge, accept]);

  const theme = snapshot?.settings.theme;
  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void bridge?.close().catch(() => {});
    };
    const tick = () => setNowMs(Date.now());
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', tick);
    const timer = window.setInterval(tick, 30_000);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', tick);
      window.clearInterval(timer);
    };
  }, [bridge]);

  const refresh = useCallback(async () => {
    if (!bridge || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError('');
    try {
      accept(await bridge.refresh());
    } catch (reason) {
      setError(`Refresh failed: ${errorText(reason)}`);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [bridge, accept]);

  const openDashboard = useCallback(
    (target: DashboardNavigation) => {
      setError('');
      bridge?.openDashboard(target).catch((reason) => setError(`The dashboard could not open: ${errorText(reason)}`));
    },
    [bridge],
  );

  const snooze = useCallback(
    async (hours: number) => {
      if (!bridge) return;
      setError('');
      try {
        accept(await bridge.snooze(hours));
      } catch (reason) {
        setError(`${hours > 0 ? 'Alerts could not be snoozed' : 'Alerts could not be resumed'}: ${errorText(reason)}`);
      }
    },
    [bridge, accept],
  );

  if (snapshot === undefined && !loadingVisible) return null;
  return (
    <FlyoutBoundary resetKey={snapshot} onOpenDashboard={() => openDashboard({ tab: 'overview' })}>
      <TrayFlyout
        snapshot={snapshot}
        nowMs={nowMs}
        refreshing={refreshing}
        error={error}
        onRefresh={bridge ? () => void refresh() : undefined}
        onOpenDashboard={openDashboard}
        onSnooze={(hours) => void snooze(hours)}
      />
    </FlyoutBoundary>
  );
}
