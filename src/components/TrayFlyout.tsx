import {
  AlertTriangle,
  Bell,
  BellOff,
  CircleCheck,
  CircleDashed,
  OctagonAlert,
  PanelTop,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { dailyBudget, paceLabel } from '../budget';
import { percent, quotaWindows, relativeTime, timeLabel, verdictSentence, whenLabel } from '../lib';
import { providerViews, type ProviderView } from '../provider-view';
import { applyThemeAttribute } from '../theme';
import type {
  DashboardNavigation,
  DashboardVerdict,
  FlyoutBridge,
  FlyoutSnapshot,
  ForecastState,
  Quota,
  Settings,
  Snapshot,
  Source,
} from '../types';

// A cell's status is an icon and a word. Watch keeps the warning triangle, as
// the tray always drew it; a state still learning is a dashed circle.
const STATUS: Record<ForecastState, { label: string; icon: LucideIcon }> = {
  safe: { label: 'On track', icon: CircleCheck },
  watch: { label: 'Watch', icon: AlertTriangle },
  risk: { label: 'At risk', icon: AlertTriangle },
  critical: { label: 'Critical', icon: OctagonAlert },
  unknown: { label: 'Learning', icon: CircleDashed },
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

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason || 'Unknown local error.');
}

/** The Flight Deck mark (a fuel tape with a trace running into it), as BrandMark in Header.tsx. */
function BrandMark() {
  return (
    <svg
      className="flyout-brand-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3h5v18h-5z M14 12h5 M3.5 16l4.5-5 3 3 3.5-4.5" />
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

/**
 * The annunciator tone: a forecast state, as the Overview's annunciator takes
 * them, or failure when the allowances could not be read at all. Unknown is
 * the neutral dashed lozenge: waiting, learning, or a partial all-clear.
 */
type VerdictTone = ForecastState | 'failure';
type VerdictView = { tone: VerdictTone; headline: string; detail: string };

const VERDICT_ICON: Record<VerdictTone, LucideIcon> = {
  safe: CircleCheck,
  watch: AlertTriangle,
  risk: AlertTriangle,
  critical: OctagonAlert,
  unknown: CircleDashed,
  failure: OctagonAlert,
};

function verdictView(snapshot: FlyoutSnapshot, views: ProviderView[], snapshotMs: number): VerdictView {
  if (!views.length) {
    return {
      tone: 'unknown',
      headline: 'No subscriptions shown',
      detail: 'Choose subscriptions in Settings to see their allowances here.',
    };
  }
  if (views.every((view) => !view.current || view.expired)) {
    return {
      tone: 'unknown',
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
  return { tone: verdict.state, headline: sentence.headline, detail };
}

/** The compact Master Caution annunciator: an icon lozenge beside the verdict. */
function Verdict({
  view,
  role = 'status',
  children,
}: {
  view: VerdictView;
  role?: 'status' | 'alert';
  children?: ReactNode;
}) {
  const Icon = VERDICT_ICON[view.tone];
  return (
    <section className="annunciator flyout-verdict" data-tone={view.tone} role={role}>
      <div className="annunciator-lozenge">
        <Icon aria-hidden="true" />
      </div>
      <div className="annunciator-body">
        <h2>{view.headline}</h2>
        {view.detail && <p>{view.detail}</p>}
        {children}
      </div>
    </section>
  );
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
  // Two halves that wrap as wholes, so the dot stays on the first line and the
  // day with its time, as the artboard sets it; the text is unchanged.
  const detail = waiting ? (
    'Waiting for a reading'
  ) : atReset == null ? (
    `Resets ${reset}`
  ) : (
    <>
      <span>{`${percent(atReset)} at reset ·`}</span> <span>{reset}</span>
    </>
  );
  const barLabel =
    remaining == null
      ? 'No allowance reading yet'
      : atReset == null
        ? `${approx}${percent(remaining)} ${view.poolLimited ? 'usable' : 'left'} now; no forecast yet`
        : `${approx}${percent(remaining)} ${view.poolLimited ? 'usable' : 'left'} now; about ${percent(atReset)} expected to be left at reset`;
  return (
    <li>
      <button
        type="button"
        className="flyout-row"
        data-provider={view.id}
        title={`Open ${view.name} in the dashboard`}
        onClick={() => onOpen?.({ tab: 'overview', provider: view.id })}
      >
        <span className="flyout-row-name">
          <span className={`swatch ${view.id}`} aria-hidden="true" />
          <strong>{view.name}</strong>
        </span>
        <span className="flyout-row-plan">{view.subtitle}</span>
        <span className="flyout-row-gauge">
          {/* The mini fuel tape: solid is left at reset, translucent is likely
              used before reset. Without a forecast the balance is outlined:
              neither legend entry would be true of it. */}
          <span className="flyout-tape" role="img" aria-label={barLabel}>
            {remaining != null && (
              <span
                className={`flyout-fill ${atReset == null ? 'flyout-fill-now' : 'flyout-fill-used'}`}
                style={{ height: `${remaining}%` }}
              />
            )}
            {atReset != null && <span className="flyout-fill flyout-fill-reset" style={{ height: `${atReset}%` }} />}
          </span>
          {remaining == null ? (
            <span className="flyout-left flyout-left-none">
              <strong aria-hidden="true">—</strong>
              <span className="sr-only">No reading</span>
            </span>
          ) : (
            <span className="flyout-left">
              <strong>{`${approx}${percent(remaining)}`}</strong>
              <small>{view.poolLimited ? 'usable' : 'left'}</small>
            </span>
          )}
        </span>
        <span className="flyout-status" data-state={view.state}>
          <StatusIcon aria-hidden="true" />
          {status.label}
        </span>
        <span className="flyout-row-detail">{detail}</span>
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
          // A read that failed is a failure; a store that is only closing
          // (for an update or sleep) is a neutral wait.
          tone: error ? 'failure' : 'unknown',
          headline: 'Allowances are unavailable right now',
          detail: 'Open the dashboard for details.',
        }
      : { tone: 'unknown', headline: 'Loading allowances…', detail: '' };
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
        <div className="flyout-heading">
          <span className="flyout-title">AI Usage</span>
          {updated && <span className="flyout-updated">{updated}</span>}
        </div>
        <button
          type="button"
          className="ibtn flyout-refresh"
          aria-label="Refresh now"
          title="Refresh now"
          aria-disabled={refreshing || !onRefresh}
          onClick={() => {
            if (!refreshing) onRefresh?.();
          }}
        >
          <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
        </button>
      </header>

      <Verdict view={verdict}>
        {snapshot === undefined && <div className="state-progress" aria-hidden="true" />}
      </Verdict>

      {error && (
        <p className="flyout-error" role="alert">
          <OctagonAlert aria-hidden="true" />
          <span>{error}</span>
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
        <button type="button" className="btn btn-p" onClick={() => onOpenDashboard?.({ tab: 'overview' })}>
          <PanelTop aria-hidden="true" />
          Open dashboard
        </button>
        {snoozed ? (
          <button
            type="button"
            className="btn"
            title={`Alerts are snoozed until ${timeLabel(snoozedUntil, nowMs)}`}
            onClick={() => onSnooze?.(0)}
          >
            <Bell aria-hidden="true" />
            Resume alerts
          </button>
        ) : (
          <button
            type="button"
            className="btn"
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
          className="ibtn flyout-settings"
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
        <Verdict
          role="alert"
          view={{
            tone: 'failure',
            headline: 'The allowances could not be shown',
            detail: 'The dashboard has the full detail.',
          }}
        />
        <footer className="flyout-footer flyout-footer-single">
          <button type="button" className="btn btn-p" onClick={this.props.onOpenDashboard}>
            <PanelTop aria-hidden="true" />
            Open dashboard
          </button>
        </footer>
      </div>
    );
  }
}

/**
 * The flyout page: TrayFlyout connected to window.aiUsageFlyout. The bridge
 * prop is only for the browser preview (see flyout.tsx); Electron passes
 * nothing, so the preload's bridge is used.
 */
export function FlyoutApp({ bridge: previewBridge }: { bridge?: FlyoutBridge } = {}) {
  const bridge = previewBridge ?? (typeof window === 'undefined' ? undefined : window.aiUsageFlyout);
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
