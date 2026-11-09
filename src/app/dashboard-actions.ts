import type { NoticeChannel } from '../components/NoticeToast';
import { formatInt, sourceLabel } from '../lib';
import type {
  ClaudeCodeModStatus,
  DashboardNavigation,
  ManualObservation,
  PriceRow,
  Settings,
  UpdateStatus,
} from '../types';
import { DesktopOnly, type BridgeSource, type DashboardBridge } from './bridge';
import type { DashboardStore } from './dashboard-store';

const BUSY_NOTICE = 'AI Usage is finishing an update; the dashboard will refresh shortly.';
const NO_BRIDGE_ERROR =
  'AI Usage could not connect to its secure desktop bridge. Restart the app; if this persists, reinstall this build.';

/**
 * Everything the dashboard asks of its bridge: the reads that fill the store,
 * and the actions behind its controls. Each action keeps its own guard against
 * overlapping requests and publishes its own notice; the store only holds what
 * they report.
 */
export function createDashboardActions({
  store,
  source,
  notices,
}: {
  store: DashboardStore;
  source: BridgeSource;
  notices: NoticeChannel;
}) {
  // The desktop bridge is there from the start; the preview's arrives with its demo data.
  let bridge: DashboardBridge | null = source.desktop ?? null;
  const initialPeriod = store.get().period;
  const setNotice = notices.show;
  // Whether any snapshot has been shown; before one, a declined read must not
  // leave the loading screen waiting with no explanation.
  const hasSnapshot = () => store.get().snapshot !== null;
  let loadRequest = 0;
  // The period a read in flight is fetching. While one is, that read owns `refreshing`.
  let pendingPeriod: number | null = null;
  let manualRefreshInFlight = false;
  // Enabling or disabling the Claude helper rewrites Claude's settings; one
  // change runs at a time, so a double-click cannot send a second write.
  let helperInFlight = false;

  const failWith = (fallback: string) => (error: unknown) => {
    // The browser preview has no desktop to do this: it says so, or shows the
    // change unsaved, and nothing has failed.
    if (error instanceof DesktopOnly) {
      store.commit(error.snapshot);
      if (error.message) setNotice({ text: error.message, tone: 'ok' });
      return;
    }
    notices.fail(error instanceof Error ? error.message : fallback);
  };

  /** Reads the snapshot for a cost period and shows it; the period on screen changes only when it arrives. */
  const load = async (period: number) => {
    if (!bridge) {
      // The preview's bridge is still loading; anywhere else there is nothing to ask.
      if (!source.preview) store.set({ refreshing: false, loadError: NO_BRIDGE_ERROR });
      return;
    }
    store.expectPeriod(period);
    pendingPeriod = period;
    const request = ++loadRequest;
    store.set({ refreshing: true });
    // A failed first read stays on screen while it is retried ("Trying
    // again…"); the error clears when a snapshot arrives.
    try {
      const next = await bridge.getSnapshot(period);
      if (request !== loadRequest) return;
      // The bridge answers null while storage is closed for an update. The
      // last snapshot is still the truth, so it is kept rather than cleared.
      if (!next) {
        store.expectPeriod(store.get().period);
        // The toast is not shown before the first snapshot; the loading
        // screen then explains the wait and offers Try again instead.
        if (hasSnapshot()) setNotice({ text: BUSY_NOTICE, tone: 'busy' });
        else store.set({ loadError: BUSY_NOTICE });
        return;
      }
      // The selected period is committed with the data, never before it. A
      // rejected 90-day read therefore cannot relabel an existing 30-day view.
      store.commit(next);
      store.set({ loadError: '' });
    } catch (error) {
      if (request !== loadRequest) return;
      const shown = store.get().period;
      store.expectPeriod(shown);
      // The preview's demo data covers one period; asking for another changes nothing.
      if (error instanceof DesktopOnly) return;
      const message = error instanceof Error ? error.message : 'Could not load the local dashboard.';
      store.set({ loadError: message });
      notices.fail(message);
      // An earlier read that succeeded before this one failed leaves the
      // main process on a period this window no longer shows, and its later
      // updates would be set aside. Ask again, quietly, for the one shown.
      if (period !== shown && hasSnapshot()) {
        bridge.getSnapshot(shown).then(
          (next) => {
            if (request !== loadRequest || !next) return;
            store.commit(next);
            store.set({ loadError: '' });
          },
          () => {},
        );
      }
    } finally {
      if (request === loadRequest) {
        pendingPeriod = null;
        store.set({ refreshing: false });
      }
    }
  };

  /**
   * Starts the dashboard: the display clock, the first read, and the updates
   * the desktop pushes afterwards. Returns the function that stops them.
   */
  const connect = () => {
    let connected = true;
    const stopClock = store.runClock();
    if (!bridge && source.preview) {
      void source
        .preview(() => store.get().snapshot)
        .then((preview) => {
          if (!connected) return;
          bridge = preview;
          void load(initialPeriod);
        });
    }
    void load(initialPeriod);
    const release = bridge?.onUpdated?.((next) => {
      store.commit(next);
      store.set({ loadError: '' });
      if (pendingPeriod == null) store.set({ refreshing: false });
    });
    return () => {
      connected = false;
      stopClock();
      release?.();
    };
  };

  const refresh = async () => {
    if (!bridge || manualRefreshInFlight) return;
    manualRefreshInFlight = true;
    store.set({ manualRefreshing: true, refreshing: true });
    try {
      const result = await bridge.refresh();
      store.commit(result.snapshot);
      const failures = Object.entries(result.collectors || {}).filter(([, collector]) => collector?.error);
      const warnings = Object.entries(result.collectors || {}).filter(
        ([, collector]) => collector?.warning && !collector?.error,
      );
      const backup = result.backupError ? ` Scheduled backup failed: ${result.backupError}` : '';
      setNotice({
        text: `${
          failures.length
            ? `Refresh completed with ${failures.map(([id]) => sourceLabel(id)).join(' and ')} unavailable. Check Sources for details.`
            : warnings.length
              ? `Refresh completed using fallback data for ${warnings.map(([id]) => sourceLabel(id)).join(' and ')}. Check Sources for details.`
              : 'All supported local sources refreshed.'
        }${backup}`,
        // A source that could not be read, or a scheduled backup that failed,
        // is a failure and stays; fallback data is only a caution.
        tone: failures.length || result.backupError ? 'warning' : warnings.length ? 'caution' : 'ok',
      });
    } catch (error) {
      failWith('Refresh did not finish.')(error);
    } finally {
      manualRefreshInFlight = false;
      // A period read started meanwhile owns `refreshing` now; its own finally
      // clears it when that read lands, as a pushed update does in connect.
      store.set(pendingPeriod == null ? { manualRefreshing: false, refreshing: false } : { manualRefreshing: false });
    }
  };

  /** Resolves true when the patch was saved, false when it was not (the failure is shown as a notice). */
  const updateSettings = async (patch: Partial<Settings>) => {
    if (!bridge) return false;
    try {
      const result = await bridge.updateSettings(patch);
      store.commit(result.snapshot);
      return true;
    } catch (error) {
      failWith('That setting could not be saved.')(error);
      // The preview shows the change in place of saving it; its controls take that as saved.
      return error instanceof DesktopOnly;
    }
  };

  const installClaude = async () => {
    if (!bridge || helperInFlight) return;
    helperInFlight = true;
    store.set({ helperBusy: true });
    try {
      const result = await bridge.installClaudeHelper();
      store.commit(result.snapshot);
      setNotice({ text: 'Claude allowance helper enabled. Fully restart Claude to activate it.', tone: 'ok' });
    } catch (error) {
      failWith('Claude helper could not be enabled.')(error);
    } finally {
      helperInFlight = false;
      store.set({ helperBusy: false });
    }
  };

  const uninstallClaude = async () => {
    if (!bridge || helperInFlight) return;
    helperInFlight = true;
    store.set({ helperBusy: true });
    try {
      const result = await bridge.uninstallClaudeHelper();
      store.commit(result.snapshot);
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
      helperInFlight = false;
      store.set({ helperBusy: false });
    }
  };

  /** Null in the browser preview, or when the step failed (the failure is shown as a notice). */
  const claudeCodeMod = async (action: 'status' | 'install' | 'uninstall'): Promise<ClaudeCodeModStatus | null> => {
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

  // Backup, restore and export share one slot, `dataOperation`, and all three
  // controls are disabled while it is taken. That is the whole guard, as it
  // always was: unlike the helper's in-flight flag it is not checked here, so
  // two calls made in the same tick, before the controls are redrawn, both run.
  const backup = async () => {
    if (!bridge) return;
    store.set({ dataOperation: 'backup' });
    try {
      const result = await bridge.createBackup();
      store.commit(result.snapshot);
      setNotice({ text: `Backup saved to ${result.result.exportPath ?? result.result.databasePath}`, tone: 'ok' });
    } catch (error) {
      failWith('Backup could not be created.')(error);
    } finally {
      store.set({ dataOperation: null });
    }
  };

  const restore = async () => {
    if (!bridge) return;
    store.set({ dataOperation: 'restore' });
    try {
      const result = await bridge.restoreBackup();
      if (result.cancelled || !result.result) return;
      store.commit(result.snapshot);
      const { settings: settingCount, observations, usageEvents, dailyUsage, prices, skipped } = result.result;
      setNotice({
        text: `Restored ${observations} observations, ${usageEvents} token records, ${dailyUsage} daily totals, ${prices} prices and ${result.result.desktopEstimates ?? 0} chat estimates. Existing usage and edited prices were kept. ${settingCount} settings were replaced by the export's.${skipped ? ` ${skipped} unusable records were skipped.` : ''}`,
        tone: 'ok',
      });
    } catch (error) {
      failWith('That backup could not be restored.')(error);
    } finally {
      store.set({ dataOperation: null });
    }
  };

  const addManualObservation = async (observation: ManualObservation) => {
    if (!bridge) return false;
    try {
      store.commit(await bridge.addManualObservation(observation));
      setNotice({ text: 'Official observation added to the learner.', tone: 'ok' });
      return true;
    } catch (error) {
      failWith('Observation could not be saved.')(error);
      return false;
    }
  };

  const updatePrice = async (row: PriceRow) => {
    if (!bridge) return;
    try {
      const result = await bridge.updatePrice({
        model: row.model,
        inputUsdPerMillion: row.input_usd_per_million,
        cacheWriteUsdPerMillion: row.cache_write_usd_per_million,
        cacheWrite1hUsdPerMillion: row.cache_write_1h_usd_per_million,
        cacheReadUsdPerMillion: row.cache_read_usd_per_million,
        outputUsdPerMillion: row.output_usd_per_million,
        effectiveFrom: row.effective_from,
        sourceUrl: row.source_url,
      });
      store.commit(result.snapshot);
      setNotice({ text: `${row.model} pricing updated.`, tone: 'ok' });
    } catch (error) {
      failWith('Pricing could not be saved.')(error);
    }
  };

  const exportCsv = async (period: number) => {
    if (!bridge) return;
    store.set({ dataOperation: 'export' });
    try {
      const result = await bridge.exportCsv(period);
      if (result.cancelled) return;
      setNotice({
        text: `Exported ${result.rows == null ? '' : formatInt(result.rows)} records from the last ${result.days} days to ${result.filePath}`,
        tone: 'ok',
      });
    } catch (error) {
      failWith('The CSV export could not be written.')(error);
    } finally {
      store.set({ dataOperation: null });
    }
  };

  const copySummary = async () => {
    if (!bridge) return;
    try {
      await bridge.copySummary();
      setNotice({ text: 'Usage summary copied to the clipboard.', tone: 'ok' });
    } catch (error) {
      failWith('The summary could not be copied.')(error);
    }
  };

  const snooze = async (hours: number) => {
    if (!bridge) return;
    try {
      const result = await bridge.snoozeAlerts(hours);
      store.commit(result.snapshot);
      setNotice({
        text: hours > 0 ? `Alerts snoozed for ${hours} hour${hours === 1 ? '' : 's'}.` : 'Alerts resumed.',
        tone: 'ok',
      });
    } catch (error) {
      failWith('The snooze could not be saved.')(error);
    }
  };

  const checkUpdates = async (): Promise<UpdateStatus | null> => {
    if (!bridge) return null;
    try {
      return await bridge.checkForUpdates();
    } catch (error) {
      failWith('The update check failed.')(error);
      return null;
    }
  };

  const openBackups = async () => {
    try {
      await bridge?.openBackupDirectory();
    } catch (error) {
      failWith('The backup folder could not be opened.')(error);
    }
  };

  return {
    connect,
    /** Pages requested from the tray flyout; subscribing also delivers one made while this page was loading. */
    onNavigate: (callback: (target: DashboardNavigation) => void) => bridge?.onNavigate?.(callback),
    /** The hidden window asks before releasing this page; answering false keeps it. */
    onPrepareSleep: (callback: () => boolean) => bridge?.onPrepareSleep?.(callback),
    load,
    refresh,
    updateSettings,
    updatePrice,
    addManualObservation,
    installClaudeHelper: installClaude,
    uninstallClaudeHelper: uninstallClaude,
    claudeCodeMod,
    backup,
    restore,
    openBackups,
    exportCsv,
    copySummary,
    snooze,
    checkUpdates,
  };
}

export type DashboardActions = ReturnType<typeof createDashboardActions>;
