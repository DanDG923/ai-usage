import { buildDashboardVerdict } from '../electron/dashboard-decision.mjs';
import { CircleDashed, OctagonAlert, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity } from './components/Activity';
import { ClaudeSetup } from './components/ClaudeSetup';
import { Costs } from './components/Costs';
import { BareGlareshield, FooterStrip, Header, PageTitle, TABS, type Tab } from './components/Header';
import { NoticeToast, createNoticeChannel } from './components/NoticeToast';
import { Overview } from './components/Overview';
import { ProviderDetail } from './components/ProviderDetail';
import { Settings, type SettingsActions } from './components/Settings';
import { ErrorBoundary } from './components/ErrorBoundary';
import { snapshotAtTime } from './snapshot-time';
import { readDashboardView, saveDashboardView } from './dashboard-view';
import { formatInt, sourceLabel } from './lib';
import { applyThemeAttribute } from './theme';
import type { ProviderId } from './provider-view';
import type { ManualObservation, PriceRow, Settings as SettingsType, Snapshot } from './types';

const DETAIL_NAMES: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude', fable: 'Fable' };

const BUSY_NOTICE = 'AI Usage is finishing an update; the dashboard will refresh shortly.';

export default function App() {
  const [initialView] = useState(readDashboardView);
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
  const [dataOperation, setDataOperation] = useState<SettingsActions['dataOperation']>(null);
  // Enabling or disabling the Claude helper rewrites Claude's settings; one
  // change runs at a time, so a double-click cannot send a second write.
  const [helperBusy, setHelperBusy] = useState(false);
  const helperInFlight = useRef(false);
  const [setupRequested, setSetupRequested] = useState(false);
  const [days, setDays] = useState(initialView.days);
  const isBrowserPreview = !window.aiUsage && window.location.protocol !== 'file:';
  // Demo data is a browser-preview adapter only. An installed desktop window
  // starts empty so a failed local read can never masquerade as real usage.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refreshing, setRefreshing] = useState(Boolean(window.aiUsage));
  // A requested Refresh has its own flag: a period read or a pushed update
  // clears `refreshing` when it lands, which must not re-enable Refresh while
  // the requested collection is still running.
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const manualRefreshInFlight = useRef(false);
  const busy = refreshing || manualRefreshing;
  // Whether any snapshot has been shown; before one, a declined read must not
  // leave the loading screen waiting with no explanation.
  const hasSnapshot = useRef(false);
  // Notices are published to the toast, not held as App state: see NoticeToast.
  const [notices] = useState(createNoticeChannel);
  const setNotice = notices.show;
  const [loadError, setLoadError] = useState('');
  const loadRequest = useRef(0);
  const desiredPeriod = useRef(initialView.days);
  const committedPeriod = useRef(initialView.days);
  const pendingPeriod = useRef<number | null>(null);

  useEffect(() => {
    return window.aiUsage?.onPrepareSleep?.(() => {
      if (!snapshot || loadError || busy || dataOperation || setupRequested || tab === 'settings') return false;
      if (document.querySelector('[role="dialog"], [aria-busy="true"], [data-keep-awake="true"]')) return false;
      return saveDashboardView({ tab, days, costQuery, provider: detail });
    });
  }, [snapshot, loadError, busy, dataOperation, setupRequested, tab, days, costQuery, detail]);

  const commitSnapshot = useCallback((next: Snapshot | null | undefined) => {
    if (!next) return;
    hasSnapshot.current = true;
    const matchesPeriod = next.costs.periodDays === desiredPeriod.current;
    setSnapshot((current) =>
      !matchesPeriod && current ? { ...next, costs: current.costs, desktopEstimates: current.desktopEstimates } : next,
    );
    if (matchesPeriod) {
      committedPeriod.current = next.costs.periodDays;
      setDays(next.costs.periodDays);
    }
  }, []);

  useEffect(() => {
    if (!isBrowserPreview) return;
    let active = true;
    void import('./data/demo').then(({ demoSnapshot, sharedPoolDemoSnapshot }) => {
      const variant = new URLSearchParams(window.location.search).get('demo');
      if (active) commitSnapshot(variant === 'shared-pool' ? sharedPoolDemoSnapshot() : demoSnapshot);
    });
    return () => {
      active = false;
    };
  }, [commitSnapshot, isBrowserPreview]);

  // Re-evaluate evidence and expiry locally even while collection is offline.
  // Wake at the first reset (or next minute), without changing the data revision.
  useEffect(() => {
    if (!snapshot) return;
    const now = Date.now();
    const resetTimes = Object.values(snapshot.quotas)
      .flatMap((quota) =>
        (quota?.windows?.length ? quota.windows : quota ? [quota] : []).map((entry) => Date.parse(entry.resetsAt)),
      )
      .filter((at) => at > now);
    const delay = Math.max(1, Math.min(60_000, ...resetTimes.map((at) => at - now)));
    const timer = window.setTimeout(
      () => setSnapshot((current) => (current ? snapshotAtTime(current, Date.now()) : current)),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    applyThemeAttribute(snapshot?.settings.theme);
  }, [snapshot?.settings.theme]);

  const load = useCallback(
    async (period: number) => {
      if (!window.aiUsage) {
        if (!isBrowserPreview) {
          setRefreshing(false);
          setLoadError(
            'AI Usage could not connect to its secure desktop bridge. Restart the app; if this persists, reinstall this build.',
          );
        }
        return;
      }
      desiredPeriod.current = period;
      pendingPeriod.current = period;
      const request = ++loadRequest.current;
      setRefreshing(true);
      // A failed first read stays on screen while it is retried ("Trying
      // again…"); the error clears when a snapshot arrives.
      try {
        const next = await window.aiUsage.getSnapshot(period);
        if (request !== loadRequest.current) return;
        // The bridge answers null while storage is closed for an update. The
        // last snapshot is still the truth, so it is kept rather than cleared.
        if (!next) {
          desiredPeriod.current = committedPeriod.current;
          // The toast is not shown before the first snapshot; the loading
          // screen then explains the wait and offers Try again instead.
          if (hasSnapshot.current) setNotice({ text: BUSY_NOTICE, tone: 'busy' });
          else setLoadError(BUSY_NOTICE);
          return;
        }
        // The selected period is committed with the data, never before it. A
        // rejected 90-day read therefore cannot relabel an existing 30-day view.
        commitSnapshot(next);
        setLoadError('');
      } catch (error) {
        if (request !== loadRequest.current) return;
        const message = error instanceof Error ? error.message : 'Could not load the local dashboard.';
        desiredPeriod.current = committedPeriod.current;
        setLoadError(message);
        notices.fail(message);
        // An earlier read that succeeded before this one failed leaves the
        // main process on a period this window no longer shows, and its later
        // updates would be set aside. Ask again, quietly, for the one shown.
        const shown = committedPeriod.current;
        if (period !== shown && hasSnapshot.current) {
          window.aiUsage.getSnapshot(shown).then(
            (next) => {
              if (request !== loadRequest.current || !next) return;
              commitSnapshot(next);
              setLoadError('');
            },
            () => {},
          );
        }
      } finally {
        if (request === loadRequest.current) {
          pendingPeriod.current = null;
          setRefreshing(false);
        }
      }
    },
    [commitSnapshot, isBrowserPreview, setNotice, notices],
  );

  // This effect synchronises with the desktop bridge (an external system):
  // the first read starts here and later pushes arrive through onUpdated.
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    void load(initialView.days);
    const release = window.aiUsage?.onUpdated?.((next) => {
      commitSnapshot(next);
      setLoadError('');
      if (pendingPeriod.current == null) setRefreshing(false);
    });
    return release;
  }, [commitSnapshot, load, initialView.days]);
  /* oxlint-enable react/set-state-in-effect */

  const failWith = (fallback: string) => (error: unknown) => {
    notices.fail(error instanceof Error ? error.message : fallback);
  };

  const refresh = async () => {
    if (!window.aiUsage) {
      setNotice({ text: 'The live collectors run in the installed desktop app.', tone: 'ok' });
      return;
    }
    if (manualRefreshInFlight.current) return;
    manualRefreshInFlight.current = true;
    setManualRefreshing(true);
    setRefreshing(true);
    try {
      const result = await window.aiUsage.refresh();
      commitSnapshot(result.snapshot);
      const failures = Object.entries(result.collectors || {}).filter(([, collector]) => collector?.error);
      const warnings = Object.entries(result.collectors || {}).filter(
        ([, collector]) => collector?.warning && !collector?.error,
      );
      const backup = result.backupError ? ` Scheduled backup failed: ${result.backupError}` : '';
      setNotice({
        text: `${
          failures.length
            ? `Refresh completed with ${failures.map(([source]) => sourceLabel(source)).join(' and ')} unavailable. Check Sources for details.`
            : warnings.length
              ? `Refresh completed using fallback data for ${warnings.map(([source]) => sourceLabel(source)).join(' and ')}. Check Sources for details.`
              : 'All supported local sources refreshed.'
        }${backup}`,
        // A source that could not be read, or a scheduled backup that failed,
        // is a failure and stays; fallback data is only a caution.
        tone: failures.length || result.backupError ? 'warning' : warnings.length ? 'caution' : 'ok',
      });
    } catch (error) {
      failWith('Refresh did not finish.')(error);
    } finally {
      manualRefreshInFlight.current = false;
      setManualRefreshing(false);
      // A period read started meanwhile owns `refreshing` now; its own finally
      // clears it when that read lands, as the onUpdated push does above.
      if (pendingPeriod.current == null) setRefreshing(false);
    }
  };

  // Keyboard shortcuts: 1/2/3/4 switch sections, R refreshes, Escape dismisses
  // the notice. Typing fields and modifier chords are left alone. The listener
  // is registered once and reads the current refresh state through a ref
  // instead of being removed and re-added on every render.
  const closeDetail = () => setDetail(null);
  const shortcutState = useRef({ refresh, busy, detail, closeDetail });
  useEffect(() => {
    shortcutState.current = { refresh, busy, detail, closeDetail };
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
        const { refresh: run, busy: running } = shortcutState.current;
        if (window.aiUsage && !running) void run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notices, setTab]);

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
    return window.aiUsage?.onNavigate?.((target) => {
      if (target.tab === 'overview' && target.provider) openProvider(target.provider);
      else setTab(target.tab);
    });
  }, [openProvider, setTab]);

  const changeDays = (period: number) => {
    if (!window.aiUsage) return;
    void load(period);
  };

  const settings = async (patch: Partial<SettingsType>) => {
    try {
      if (!window.aiUsage) {
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, settings: { ...current.settings, ...patch } };
          return { ...next, dashboardVerdict: buildDashboardVerdict(next) };
        });
        return true;
      }
      const result = await window.aiUsage.updateSettings(patch);
      commitSnapshot(result.snapshot);
      return true;
    } catch (error) {
      failWith('That setting could not be saved.')(error);
      return false;
    }
  };

  const installClaude = async () => {
    if (!window.aiUsage || helperInFlight.current) return;
    helperInFlight.current = true;
    setHelperBusy(true);
    try {
      const result = await window.aiUsage.installClaudeHelper();
      commitSnapshot(result.snapshot);
      setNotice({ text: 'Claude allowance helper enabled. Fully restart Claude to activate it.', tone: 'ok' });
    } catch (error) {
      failWith('Claude helper could not be enabled.')(error);
    } finally {
      helperInFlight.current = false;
      setHelperBusy(false);
    }
  };

  const uninstallClaude = async () => {
    if (!window.aiUsage || helperInFlight.current) return;
    helperInFlight.current = true;
    setHelperBusy(true);
    try {
      const result = await window.aiUsage.uninstallClaudeHelper();
      commitSnapshot(result.snapshot);
      const leftover =
        result.result.managed && !result.result.helperScriptRemoved
          ? ' The helper script is still in use and could not be deleted; it is no longer referenced.'
          : '';
      // The helper was disabled either way: a script left on disk is a detail
      // of that success, not a failure.
      setNotice({
        text: result.result.restoredPreviousStatusLine
          ? `Claude allowance helper disabled and your previous status line restored. Fully restart Claude.${leftover}`
          : result.result.statusLineRemoved
            ? `Claude allowance helper disabled and its status line removed. Fully restart Claude.${leftover}`
            : 'Claude’s status line is not the one this app installed, so nothing was changed.',
        tone: 'ok',
      });
    } catch (error) {
      failWith('Claude helper could not be disabled.')(error);
    } finally {
      helperInFlight.current = false;
      setHelperBusy(false);
    }
  };

  const claudeCodeMod = async (action: 'status' | 'install' | 'uninstall') => {
    const bridge = window.aiUsage;
    if (!bridge) return null;
    try {
      if (action === 'status') return await bridge.getClaudeCodeMod();
      const status = action === 'install' ? await bridge.installClaudeCodeMod() : await bridge.uninstallClaudeCodeMod();
      setNotice({
        text:
          action === 'install'
            ? 'Claude Code mod installed. Start a new Claude Code session, or run /reload-plugins in an open one, then type /ai-usage.'
            : 'Claude Code mod removed. Open Claude Code sessions drop it when they next start.',
        tone: 'ok',
      });
      return status;
    } catch (error) {
      failWith(
        action === 'install'
          ? 'The Claude Code mod could not be installed.'
          : action === 'uninstall'
            ? 'The Claude Code mod could not be removed.'
            : 'The Claude Code mod could not be checked.',
      )(error);
      return null;
    }
  };

  const backup = async () => {
    if (!window.aiUsage || dataOperation) return;
    setDataOperation('backup');
    try {
      const result = await window.aiUsage.createBackup();
      commitSnapshot(result.snapshot);
      setNotice({ text: `Backup saved to ${result.result.exportPath ?? result.result.databasePath}`, tone: 'ok' });
    } catch (error) {
      failWith('Backup could not be created.')(error);
    } finally {
      setDataOperation(null);
    }
  };

  const restore = async () => {
    if (!window.aiUsage) {
      setNotice({ text: 'Restoring runs in the installed desktop app.', tone: 'ok' });
      return;
    }
    if (dataOperation) return;
    setDataOperation('restore');
    try {
      const result = await window.aiUsage.restoreBackup();
      if (result.cancelled || !result.result) return;
      commitSnapshot(result.snapshot);
      const { settings: settingCount, observations, usageEvents, dailyUsage, prices, skipped } = result.result;
      setNotice({
        text: `Restored ${observations} observations, ${usageEvents} token records, ${dailyUsage} daily totals, ${prices} prices and ${result.result.desktopEstimates ?? 0} chat estimates. Existing usage and edited prices were kept. ${settingCount} settings were replaced by the export's.${skipped ? ` ${skipped} unusable records were skipped.` : ''}`,
        tone: 'ok',
      });
    } catch (error) {
      failWith('That backup could not be restored.')(error);
    } finally {
      setDataOperation(null);
    }
  };

  const manual = async (observation: ManualObservation) => {
    if (!window.aiUsage) {
      setNotice({ text: 'Manual observations are saved by the installed desktop app.', tone: 'ok' });
      return false;
    }
    try {
      commitSnapshot(await window.aiUsage.addManualObservation(observation));
      setNotice({ text: 'Official observation added to the learner.', tone: 'ok' });
      return true;
    } catch (error) {
      failWith('Observation could not be saved.')(error);
      return false;
    }
  };

  const price = async (row: PriceRow) => {
    if (!window.aiUsage) {
      setSnapshot((current) =>
        current
          ? { ...current, priceCatalog: current.priceCatalog.map((item) => (item.model === row.model ? row : item)) }
          : current,
      );
      return;
    }
    try {
      const result = await window.aiUsage.updatePrice({
        model: row.model,
        inputUsdPerMillion: row.input_usd_per_million,
        cacheWriteUsdPerMillion: row.cache_write_usd_per_million,
        cacheWrite1hUsdPerMillion: row.cache_write_1h_usd_per_million,
        cacheReadUsdPerMillion: row.cache_read_usd_per_million,
        outputUsdPerMillion: row.output_usd_per_million,
        effectiveFrom: row.effective_from,
        sourceUrl: row.source_url,
      });
      commitSnapshot(result.snapshot);
      setNotice({ text: `${row.model} pricing updated.`, tone: 'ok' });
    } catch (error) {
      failWith('Pricing could not be saved.')(error);
    }
  };

  const exportCsv = async (period: number) => {
    if (!window.aiUsage) {
      setNotice({ text: 'Exports are written by the installed desktop app.', tone: 'ok' });
      return;
    }
    if (dataOperation) return;
    setDataOperation('export');
    try {
      const result = await window.aiUsage.exportCsv(period);
      if (result.cancelled) return;
      setNotice({
        text: `Exported ${result.rows == null ? '' : formatInt(result.rows)} records from the last ${result.days} days to ${result.filePath}`,
        tone: 'ok',
      });
    } catch (error) {
      failWith('The CSV export could not be written.')(error);
    } finally {
      setDataOperation(null);
    }
  };

  const copySummary = async () => {
    if (!window.aiUsage) {
      setNotice({ text: 'The summary is copied by the installed desktop app.', tone: 'ok' });
      return;
    }
    try {
      await window.aiUsage.copySummary();
      setNotice({ text: 'Usage summary copied to the clipboard.', tone: 'ok' });
    } catch (error) {
      failWith('The summary could not be copied.')(error);
    }
  };

  const snooze = async (hours: number) => {
    if (!window.aiUsage) {
      const until = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
      setSnapshot((current) =>
        current ? { ...current, settings: { ...current.settings, alertsSnoozedUntil: until } } : current,
      );
      return;
    }
    try {
      const result = await window.aiUsage.snoozeAlerts(hours);
      commitSnapshot(result.snapshot);
      setNotice({
        text: hours > 0 ? `Alerts snoozed for ${hours} hour${hours === 1 ? '' : 's'}.` : 'Alerts resumed.',
        tone: 'ok',
      });
    } catch (error) {
      failWith('The snooze could not be saved.')(error);
    }
  };

  const checkUpdates = async () => {
    if (!window.aiUsage) return null;
    try {
      return await window.aiUsage.checkForUpdates();
    } catch (error) {
      failWith('The update check failed.')(error);
      return null;
    }
  };

  const openBackups = async () => {
    try {
      await window.aiUsage?.openBackupDirectory();
    } catch (error) {
      failWith('The backup folder could not be opened.')(error);
    }
  };

  const actions: SettingsActions = {
    dataOperation,
    helperBusy,
    onSetupClaude: () => setSetupRequested(true),
    onSettings: settings,
    onPrice: price,
    onInstallClaude: installClaude,
    onUninstallClaude: uninstallClaude,
    onClaudeCodeMod: claudeCodeMod,
    onBackup: backup,
    onRestore: restore,
    onOpenBackups: openBackups,
    onManual: manual,
    onExportCsv: exportCsv,
    onCopySummary: copySummary,
    onSnooze: snooze,
    onCheckUpdates: checkUpdates,
  };

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
                    void load(days);
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
    <div className="app-shell">
      <Header snapshot={snapshot} tab={tab} onTab={setTab} refreshing={busy} onRefresh={refresh} />
      {(snapshot.settings.showClaudeSubscription !== false || setupRequested) && (
        <ClaudeSetup requested={setupRequested} onClose={() => setSetupRequested(false)} />
      )}
      <PageTitle tab={tab} detail={tab === 'overview' && detail ? DETAIL_NAMES[detail] : null} onBack={closeDetail} />
      <ErrorBoundary key={`${tab}:${detail ?? ''}`}>
        {tab === 'overview' && detail && (
          <ProviderDetail
            snapshot={snapshot}
            provider={detail}
            onBack={closeDetail}
            onOpenProvider={openProvider}
            onOpenSettings={openSettings}
            onSaveReserve={(percent) => settings({ reservePercent: percent })}
          />
        )}
        {tab === 'overview' && !detail && (
          <Overview
            snapshot={snapshot}
            refreshing={busy}
            onRefresh={refresh}
            onSetupClaude={() => setSetupRequested(true)}
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
            onDays={changeDays}
            query={costQuery}
            onQuery={setCostQuery}
            onSnapshot={commitSnapshot}
          />
        )}
        {tab === 'settings' && <Settings snapshot={snapshot} actions={actions} initialSection={settingsSection} />}
      </ErrorBoundary>
      <FooterStrip snapshot={snapshot} />
      <NoticeToast channel={notices} />
    </div>
  );
}
