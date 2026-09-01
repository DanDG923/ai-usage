import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { Details } from './components/Details';
import { Header, type Tab } from './components/Header';
import { Overview } from './components/Overview';
import { Settings, type SettingsActions } from './components/Settings';
import { demoSnapshot } from './data/demo';
import type { ManualObservation, PriceRow, Settings as SettingsType, Snapshot, Theme } from './types';

function applyThemeAttribute(theme: Theme | undefined) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(30);
  const isBrowserPreview = !window.aiUsage && window.location.protocol !== 'file:';
  // Demo data is a browser-preview adapter only. An installed desktop window
  // starts empty so a failed local read can never masquerade as real usage.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => (isBrowserPreview ? demoSnapshot : null));
  const [refreshing, setRefreshing] = useState(Boolean(window.aiUsage));
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const loadRequest = useRef(0);

  const commitSnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setDays(next.costs.periodDays);
  }, []);

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
      const request = ++loadRequest.current;
      setRefreshing(true);
      setLoadError('');
      try {
        const next = await window.aiUsage.getSnapshot(period);
        if (request !== loadRequest.current) return;
        // The selected period is committed with the data, never before it. A
        // rejected 90-day read therefore cannot relabel an existing 30-day view.
        commitSnapshot(next);
      } catch (error) {
        if (request !== loadRequest.current) return;
        const message = error instanceof Error ? error.message : 'Could not load the local dashboard.';
        setLoadError(message);
        setNotice(message);
      } finally {
        if (request === loadRequest.current) setRefreshing(false);
      }
    },
    [commitSnapshot, isBrowserPreview],
  );

  // This effect synchronises with the desktop bridge (an external system):
  // the first read starts here and later pushes arrive through onUpdated.
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    void load(30);
    const release = window.aiUsage?.onUpdated?.((next) => {
      loadRequest.current += 1;
      commitSnapshot(next);
      setLoadError('');
      setRefreshing(false);
    });
    return release;
  }, [commitSnapshot, load]);
  /* oxlint-enable react/set-state-in-effect */

  const failWith = (fallback: string) => (error: unknown) => {
    setNotice(error instanceof Error ? error.message : fallback);
  };

  const refresh = async () => {
    if (!window.aiUsage) {
      setNotice('The live collectors run in the installed desktop app.');
      return;
    }
    setRefreshing(true);
    try {
      const result = await window.aiUsage.refresh();
      commitSnapshot(result.snapshot);
      const failures = Object.entries(result.collectors || {}).filter(([, collector]) => collector?.error);
      const warnings = Object.entries(result.collectors || {}).filter(
        ([, collector]) => collector?.warning && !collector?.error,
      );
      const backup = result.backupError ? ` Scheduled backup failed: ${result.backupError}` : '';
      setNotice(
        `${
          failures.length
            ? `Refresh completed with ${failures.map(([source]) => source).join(' and ')} unavailable. Check Sources for details.`
            : warnings.length
              ? `Refresh completed using fallback data for ${warnings.map(([source]) => source).join(' and ')}. Check Sources for details.`
              : 'All supported local sources refreshed.'
        }${backup}`,
      );
    } catch (error) {
      failWith('Refresh did not finish.')(error);
    } finally {
      setRefreshing(false);
    }
  };

  const changeDays = (period: number) => {
    if (!window.aiUsage) return;
    void load(period);
  };

  const settings = async (patch: Partial<SettingsType>) => {
    try {
      if (!window.aiUsage) {
        setSnapshot((current) => (current ? { ...current, settings: { ...current.settings, ...patch } } : current));
        return;
      }
      const result = await window.aiUsage.updateSettings(patch);
      commitSnapshot(result.snapshot);
    } catch (error) {
      failWith('That setting could not be saved.')(error);
    }
  };

  const installClaude = async () => {
    if (!window.aiUsage) return;
    try {
      const result = await window.aiUsage.installClaudeHelper();
      commitSnapshot(result.snapshot);
      setNotice('Claude allowance helper enabled. Fully restart Claude to activate it.');
    } catch (error) {
      failWith('Claude helper could not be enabled.')(error);
    }
  };

  const uninstallClaude = async () => {
    if (!window.aiUsage) return;
    try {
      const result = await window.aiUsage.uninstallClaudeHelper();
      commitSnapshot(result.snapshot);
      const leftover =
        result.result.managed && !result.result.helperScriptRemoved
          ? ' The helper script is still in use and could not be deleted; it is no longer referenced.'
          : '';
      setNotice(
        result.result.restoredPreviousStatusLine
          ? `Claude allowance helper disabled and your previous status line restored. Fully restart Claude.${leftover}`
          : result.result.statusLineRemoved
            ? `Claude allowance helper disabled and its status line removed. Fully restart Claude.${leftover}`
            : 'Claude’s status line is not the one this app installed, so nothing was changed.',
      );
    } catch (error) {
      failWith('Claude helper could not be disabled.')(error);
    }
  };

  const backup = async () => {
    if (!window.aiUsage) return;
    try {
      const result = await window.aiUsage.createBackup();
      commitSnapshot(result.snapshot);
      setNotice(`Backup saved to ${result.result.exportPath}`);
    } catch (error) {
      failWith('Backup could not be created.')(error);
    }
  };

  const restore = async () => {
    if (!window.aiUsage) {
      setNotice('Restoring runs in the installed desktop app.');
      return;
    }
    try {
      const result = await window.aiUsage.restoreBackup();
      if (result.cancelled || !result.result) return;
      commitSnapshot(result.snapshot);
      const { settings: settingCount, observations, usageEvents, dailyUsage, prices, skipped } = result.result;
      setNotice(
        `Added ${observations} observations, ${usageEvents} token records, ${dailyUsage} daily totals and ${prices} prices; records already held were left as they were. ${settingCount} settings were replaced by the export's.${skipped ? ` ${skipped} unusable records were skipped.` : ''}`,
      );
    } catch (error) {
      failWith('That backup could not be restored.')(error);
    }
  };

  const manual = async (observation: ManualObservation) => {
    if (!window.aiUsage) {
      setNotice('Manual observations are saved by the installed desktop app.');
      return;
    }
    try {
      commitSnapshot(await window.aiUsage.addManualObservation(observation));
      setNotice('Official observation added to the learner.');
    } catch (error) {
      failWith('Observation could not be saved.')(error);
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
      setNotice(`${row.model} pricing updated.`);
    } catch (error) {
      failWith('Pricing could not be saved.')(error);
    }
  };

  const exportCsv = async (period: number) => {
    if (!window.aiUsage) {
      setNotice('Exports are written by the installed desktop app.');
      return;
    }
    try {
      const result = await window.aiUsage.exportCsv(period);
      if (result.cancelled) return;
      setNotice(
        `Exported ${result.rows?.toLocaleString() ?? ''} records from the last ${result.days} days to ${result.filePath}`,
      );
    } catch (error) {
      failWith('The CSV export could not be written.')(error);
    }
  };

  const copySummary = async () => {
    if (!window.aiUsage) {
      setNotice('The summary is copied by the installed desktop app.');
      return;
    }
    try {
      await window.aiUsage.copySummary();
      setNotice('Usage summary copied to the clipboard.');
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
      setNotice(hours > 0 ? `Alerts snoozed for ${hours} hour${hours === 1 ? '' : 's'}.` : 'Alerts resumed.');
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
    onSettings: settings,
    onPrice: price,
    onInstallClaude: installClaude,
    onUninstallClaude: uninstallClaude,
    onBackup: backup,
    onRestore: restore,
    onOpenBackups: openBackups,
    onManual: manual,
    onExportCsv: exportCsv,
    onCopySummary: copySummary,
    onSnooze: snooze,
    onCheckUpdates: checkUpdates,
  };

  if (!snapshot) {
    return (
      <div className="app-shell">
        <header className="app-header app-header-status">
          <div className="brand status-brand" aria-label="AI Usage">
            <span className="brand-orbit" aria-hidden="true">
              <Activity />
            </span>
            <span>AI Usage</span>
          </div>
        </header>
        <main className="page">
          <section className="panel" role={loadError ? 'alert' : 'status'} aria-live="polite">
            <span className="eyebrow">Local dashboard</span>
            <h1>{loadError ? 'Your local usage could not be loaded' : 'Loading your local usage…'}</h1>
            <p>{loadError || 'Reading the on-device usage database and allowance history.'}</p>
            {loadError && (
              <button
                className="refresh-button"
                disabled={refreshing}
                onClick={() => {
                  void load(days);
                }}
              >
                {refreshing ? 'Trying again…' : 'Try again'}
              </button>
            )}
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Header snapshot={snapshot} tab={tab} onTab={setTab} refreshing={refreshing} onRefresh={refresh} />
      {tab === 'overview' && <Overview snapshot={snapshot} />}
      {tab === 'details' && <Details snapshot={snapshot} days={days} onDays={changeDays} />}
      {tab === 'settings' && <Settings snapshot={snapshot} actions={actions} />}
      <footer className="app-footer">
        <span>
          Snapshot {new Date(snapshot.generatedAt).toLocaleString('en-GB')} · {snapshot.timezone}
        </span>
        <span>Local records only · Learned forecasts are estimates, not provider guarantees</span>
      </footer>
      {notice && (
        <div className="toast" role="status" aria-live="polite">
          <span>{notice}</span>
          <button aria-label="Dismiss message" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
