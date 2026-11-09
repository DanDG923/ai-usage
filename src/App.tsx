import { CircleDashed, OctagonAlert, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscriptionVisible } from '../electron/dashboard-decision.mjs';
import { DashboardContext, createDashboard } from './app/dashboard';
import { selectBusy, useStoreState } from './app/dashboard-store';
import { Activity } from './components/Activity';
import { ClaudeSetup } from './components/ClaudeSetup';
import { Costs } from './components/Costs';
import { BareGlareshield, FooterStrip, Header, PageTitle, TABS, type Tab } from './components/Header';
import { NoticeToast } from './components/NoticeToast';
import { Overview } from './components/Overview';
import { ProviderDetail } from './components/ProviderDetail';
import { Settings } from './components/Settings';
import { ErrorBoundary } from './components/ErrorBoundary';
import { readDashboardView, saveDashboardView } from './dashboard-view';
import { sourceLabel } from './lib';
import { applyThemeAttribute } from './theme';
import type { ProviderId } from './provider-view';

/**
 * The dashboard window: which page is open, the keyboard shortcuts, and the
 * wiring between the pages and the dashboard (src/app), which holds the
 * snapshot and every action on it.
 */
export default function App() {
  const [initialView] = useState(readDashboardView);
  const [dashboard] = useState(() => createDashboard({ period: initialView.days }));
  const { store, actions, notices } = dashboard;
  const snapshot = useStoreState(store, (state) => state.snapshot);
  const days = useStoreState(store, (state) => state.period);
  const refreshing = useStoreState(store, (state) => state.refreshing);
  const busy = useStoreState(store, selectBusy);
  const loadError = useStoreState(store, (state) => state.loadError);

  const [tab, setTabState] = useState<Tab>(initialView.tab);
  // A provider page opened from the Overview; any section change returns to its list.
  const [detail, setDetail] = useState<ProviderId | null>(initialView.provider ?? null);
  // A Settings section to reveal when the page opens, such as "forecast".
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    setDetail(null);
    setSettingsSection(null);
  }, []);
  const [costQuery, setCostQuery] = useState(initialView.costQuery);
  const [setupRequested, setSetupRequested] = useState(false);

  // The first read starts here and later pushes arrive through the bridge.
  useEffect(() => actions.connect(), [actions]);

  useEffect(() => {
    return actions.onPrepareSleep(() => {
      const state = store.get();
      if (!state.snapshot || state.loadError || selectBusy(state) || state.dataOperation) return false;
      if (setupRequested || tab === 'settings') return false;
      if (document.querySelector('[role="dialog"], [aria-busy="true"], [data-keep-awake="true"]')) return false;
      return saveDashboardView({ tab, days: state.period, costQuery, provider: detail });
    });
  }, [actions, store, setupRequested, tab, costQuery, detail]);

  const theme = snapshot?.settings.theme;
  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);

  // Keyboard shortcuts: 1/2/3/4 switch sections, R refreshes, Escape dismisses
  // the notice. Typing fields and modifier chords are left alone. The listener
  // is registered once and reads the current refresh state through a ref
  // instead of being removed and re-added on every render.
  const closeDetail = () => setDetail(null);
  const shortcutState = useRef({ busy, detail, closeDetail });
  useEffect(() => {
    shortcutState.current = { busy, detail, closeDetail };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(
        target && (target.closest('input, select, textarea, [contenteditable="true"]') || target.isContentEditable),
      );
      if (event.key === 'Escape') {
        if (notices.current()) notices.dismiss();
        // Escape in a field (the reserve slider, a search box) stays with that field.
        else if (shortcutState.current.detail && !typing) shortcutState.current.closeDetail();
        return;
      }
      if (typing) return;
      const index = ['1', '2', '3', '4'].indexOf(event.key);
      if (index >= 0) {
        event.preventDefault();
        setTab(TABS[index].id);
        document.getElementById(`tab-${TABS[index].id}`)?.focus();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        // R does what the Refresh button does, in the browser preview as well.
        if (!shortcutState.current.busy) void actions.refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, notices, setTab]);

  const openProvider = useCallback((provider: ProviderId) => {
    setTabState('overview');
    setDetail(provider);
    window.scrollTo({ top: 0 });
  }, []);

  const openSettings = useCallback(
    (section?: string) => {
      setTab('settings');
      setSettingsSection(section ?? null);
    },
    [setTab],
  );

  const openSetup = useCallback(() => setSetupRequested(true), []);

  // Opening a provider page unmounts the control that had focus, so focus moves
  // to the page itself; closing it returns focus to that provider's card link.
  const previousDetail = useRef(detail);
  useEffect(() => {
    const previous = previousDetail.current;
    previousDetail.current = detail;
    if (previous === detail || tab !== 'overview') return;
    const frame = window.requestAnimationFrame(() => {
      const link = previous
        ? document.querySelector<HTMLElement>(`.provider-card.${previous} .provider-card-link`)
        : null;
      if (!detail && link) link.focus();
      else document.getElementById('panel-overview')?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail, tab]);

  // The tray flyout can open a section or a provider page.
  useEffect(() => {
    return actions.onNavigate((target) => {
      if (target.tab === 'overview' && target.provider) openProvider(target.provider);
      else setTab(target.tab);
    });
  }, [actions, openProvider, setTab]);

  // Before the first snapshot the glareshield carries only the mark: there
  // are no sections to switch to and nothing to refresh yet.
  if (!snapshot) {
    return (
      <div className="app-shell">
        <BareGlareshield />
        <main className="state-stage">
          <section
            className={`state-panel${loadError ? ' is-error' : ''}`}
            role={loadError ? 'alert' : 'status'}
            aria-live="polite"
          >
            <span className="state-panel-icon">
              {loadError ? <OctagonAlert aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
            </span>
            <div className="state-panel-body">
              <h1>{loadError ? 'Your local usage could not be loaded' : 'Loading your local usage…'}</h1>
              <p>{loadError || 'Reading the on-device usage database and allowance history.'}</p>
              {!loadError && <span className="state-progress" aria-hidden="true" />}
              {loadError && (
                <button
                  type="button"
                  className={`btn${refreshing ? '' : ' btn-p'}`}
                  disabled={refreshing}
                  aria-busy={refreshing || undefined}
                  onClick={() => {
                    void actions.load(days);
                  }}
                >
                  <RefreshCw className={refreshing ? 'spin' : ''} aria-hidden="true" />
                  {refreshing ? 'Trying again…' : 'Try again'}
                </button>
              )}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <DashboardContext value={dashboard}>
      <div className="app-shell">
        <Header snapshot={snapshot} tab={tab} onTab={setTab} refreshing={busy} onRefresh={actions.refresh} />
        {(subscriptionVisible(snapshot.settings, 'claude') || setupRequested) && (
          <ClaudeSetup requested={setupRequested} onClose={() => setSetupRequested(false)} />
        )}
        <PageTitle tab={tab} detail={tab === 'overview' && detail ? sourceLabel(detail) : null} onBack={closeDetail} />
        <ErrorBoundary key={`${tab}:${detail ?? ''}`}>
          {tab === 'overview' && detail && (
            <ProviderDetail
              snapshot={snapshot}
              provider={detail}
              onBack={closeDetail}
              onOpenProvider={openProvider}
              onOpenSettings={openSettings}
              onSaveReserve={(percent) => actions.updateSettings({ reservePercent: percent })}
            />
          )}
          {tab === 'overview' && !detail && (
            <Overview
              snapshot={snapshot}
              refreshing={busy}
              onRefresh={actions.refresh}
              onSetupClaude={openSetup}
              onSources={() => {
                setTab('settings');
                document.getElementById('tab-settings')?.focus();
              }}
              onOpenProvider={openProvider}
              onOpenSettings={openSettings}
            />
          )}
          {tab === 'activity' && <Activity snapshot={snapshot} days={days} />}
          {tab === 'costs' && (
            <Costs
              snapshot={snapshot}
              days={days}
              onDays={actions.load}
              query={costQuery}
              onQuery={setCostQuery}
              onSnapshot={store.commit}
            />
          )}
          {tab === 'settings' && (
            <Settings snapshot={snapshot} initialSection={settingsSection} onSetupClaude={openSetup} />
          )}
        </ErrorBoundary>
        <FooterStrip snapshot={snapshot} />
        <NoticeToast channel={notices} />
      </div>
    </DashboardContext>
  );
}
