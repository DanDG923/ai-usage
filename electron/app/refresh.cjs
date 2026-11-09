'use strict';

// Collection: when one runs (launch, schedule, wake, a click), the run
// itself, and publishing its result to the window, tray and notifications.

const path = require('node:path');
const { createCollectorHost, createInlineCollectorHost } = require('../collector-host.cjs');
const { createCollectorService } = require('../collector-service.cjs');
const { REFRESH_TRIGGERS, createRefreshCoalescer, refreshOptionsFor } = require('../refresh-policy.cjs');
const { closed } = require('./closed.cjs');

// This file sits one folder below the main process's other modules.
const ELECTRON_DIR = path.join(__dirname, '..');

const STALE_AFTER_MS = 5 * 60_000;

/** @typedef {import('../types').TraySnapshot} TraySnapshot */
/** @typedef {import('../collector-service.cjs').SettledOutcome} SettledOutcome */

/** @param {import('./application.cjs').Application} main */
function createRefreshModule(main) {
  const { utilityProcess } = main.electron;
  const refresh = closed({
    refreshTimer: /** @type {NodeJS.Timeout | null | undefined} */ (undefined),
    lastRefreshAt: 0,
    resumeTimer: /** @type {NodeJS.Timeout | undefined} */ (undefined),
    refreshIntervalMs: 0,
    refreshRuns: /** @type {ReturnType<typeof createRefreshCoalescer>} */ (/** @type {unknown} */ (undefined)),
    automaticCollectionEnabled, scheduleAutomaticRefresh, refreshIfStale, scheduleLaunchRefresh, onResume,
    createCollectors, collectorOutcome, publishAfterWrite, answerClaudeCodeRequest, importClaudeCodeReading,
    refreshAll, collectAll, refreshClaudeOnly,
  });

  function automaticCollectionEnabled() {
    return Number(main.store?.getSettings().refreshIntervalMinutes) > 0;
  }

  // Collection used to happen only at launch and on an explicit click, so the
  // pace notification could fire only while the dashboard was already open, and
  // a "daily" backup was skipped on any day nobody pressed Refresh.
  function scheduleAutomaticRefresh() {
    const minutes = Number(main.store.getSettings().refreshIntervalMinutes);
    const intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
    if (intervalMs === refresh.refreshIntervalMs && (refresh.refreshTimer || intervalMs === 0)) return;
    main.timers.clearInterval(refresh.refreshTimer ?? undefined);
    refresh.refreshTimer = null;
    refresh.refreshIntervalMs = intervalMs;
    if (!intervalMs) return;
    refresh.refreshTimer = main.timers.setInterval(() => {
      if (Date.now() - refresh.lastRefreshAt >= intervalMs) refresh.refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.SCHEDULE)).catch(() => {});
    }, Math.min(intervalMs, 60_000));
  }

  // `ignoreSchedule` is for the one collection a launch always earns. Turning
  // automatic collection off has to silence the show and resume triggers too,
  // or the setting means nothing. Every caller is automatic, so the trigger's
  // policy never reads Claude plan usage here.
  /** @param {{ trigger?: string, ignoreSchedule?: boolean }} [options] */
  function refreshIfStale({ trigger, ignoreSchedule = false } = {}) {
    // The window can be shown while an update install has closed the database.
    if (!main.store || main.lifecycle.storageClosing() || refresh.refreshRuns.running) return;
    if (!ignoreSchedule && !refresh.automaticCollectionEnabled()) return;
    if (Date.now() - refresh.lastRefreshAt < STALE_AFTER_MS) return;
    refresh.refreshAll(refreshOptionsFor(trigger)).catch(() => {});
  }

  // A launch always earns one collection, whether or not automatic collection
  // is on. Showing the window fires first in practice; the staleness guard
  // makes whichever arrives second a no-op rather than a second full scan.
  function scheduleLaunchRefresh() {
    main.timers.setTimeout(() => refresh.refreshIfStale({ trigger: REFRESH_TRIGGERS.LAUNCH, ignoreSchedule: true }), 900);
  }

  // A sleeping PC collects nothing, so waking is the moment the local records
  // are most likely to be behind.
  function onResume() {
    main.timers.clearTimeout(refresh.resumeTimer);
    refresh.resumeTimer = main.timers.setTimeout(() => { if (!main.lifecycle.isQuitting) refresh.refreshIfStale({ trigger: REFRESH_TRIGGERS.WAKE }); }, 15_000);
    refresh.resumeTimer.unref?.();
  }

  function createCollectors() {
    const config = {
      databasePath: main.store.databasePath,
      backupDirectory: main.store.backupDirectory,
      inboxPath: main.paths.getInboxPath(),
      claudeCodeReadingsDirectory: path.join(main.paths.claudeCodeRoot(), 'readings'),
    };
    const inline = main.process.env.AI_USAGE_INLINE_COLLECTORS === '1' || typeof utilityProcess?.fork !== 'function';
    if (inline) return createInlineCollectorHost(createCollectorService(config));
    return createCollectorHost({
      fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      modulePath: path.join(ELECTRON_DIR, 'collector-service.cjs'),
      config,
      forkOptions: { env: { ...main.launchEnvironment } },
      onLog: main.logs.log,
    });
  }

  /** @param {SettledOutcome | undefined} entry */
  function collectorOutcome(entry) {
    if (!entry) return { error: 'The collector did not report.' };
    if (entry.status === 'fulfilled') return entry.value;
    return { error: entry.reason?.message || 'Unknown local error.' };
  }

  // Everything that has to happen after collectors write: publish the new
  // snapshot, then the things that can fail. A backup error used to skip the
  // publish, silently freezing an open window for the life of the process.
  /**
   * @param {TraySnapshot} current a tray snapshot, or a full one, which has the same fields
   * @param {{ push?: boolean }} [options] `push: false` when the caller hands the snapshot to the dashboard itself
   */
  function publishAfterWrite(current, { push = true } = {}) {
    if (push && main.dashboard.isVisible()) main.dashboard.window?.webContents.send('dashboard:updated', current);
    main.tray.updateTray(current);
    try {
      main.alerts.showNotifications(current);
    } catch { /* Notification decisions must never fail a refresh. */ }
    main.snapshots.previousSnapshot = current;
  }

  // What the Claude Code mod asks for. "Sync now" is a local collection: the
  // session asking already holds the plan limits, so nothing reads plan usage.
  /** @param {'sync' | 'open'} action */
  function answerClaudeCodeRequest(action) {
    if (main.lifecycle.isQuitting || !main.store || main.lifecycle.storageClosing()) return;
    if (action === 'sync') refresh.refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.CLAUDE_CODE_SYNC)).catch(() => {});
    else if (action === 'open') main.dashboard.openDashboardAt({ tab: 'overview' });
  }

  // A reading the mod left is imported straight away, as the status-line inbox
  // is on a schedule, unless the person collects only when they refresh.
  function importClaudeCodeReading() {
    if (main.lifecycle.isQuitting || !main.store || main.lifecycle.storageClosing() || !refresh.automaticCollectionEnabled()) return;
    void refresh.refreshClaudeOnly().catch((error) => main.logs.log(`Import after a Claude Code reading: ${error.message}`));
  }

  function refreshAll({ readPlanUsage = false } = {}) {
    return refresh.refreshRuns.request({ readPlanUsage: readPlanUsage === true });
  }

  /** @param {{ readPlanUsage: boolean }} options */
  async function collectAll({ readPlanUsage }) {
    if (main.lifecycle.isQuitting) return { snapshot: undefined, backupError: null, collectors: {} };
    /** @type {{ codex?: SettledOutcome, claude?: SettledOutcome }} */
    let outcomes;
    try {
      outcomes = await main.databaseJobs.collect(() => main.collectors.refreshAll({ readPlanUsage }));
    } catch (error) {
      const detail = `Local collection failed: ${error?.message || 'Unknown local error.'}`;
      outcomes = {
        codex: { status: 'rejected', reason: { message: detail } },
        claude: { status: 'rejected', reason: { message: detail } },
      };
    }
    // Quitting stops the collectors, which rejects the in-flight run; that is
    // not a source failure and must not be written as one for the next launch.
    if (main.lifecycle.isQuitting) return { snapshot: undefined, backupError: null, collectors: {} };
    const { codex, claude } = outcomes;
    await main.databaseJobs.run(() => {
      if (codex?.status === 'rejected') main.store.setSourceStatus('codex', 'error', `Codex refresh failed: ${codex.reason?.message || 'Unknown local error.'}`);
      if (claude?.status === 'rejected') {
        const detail = `Claude refresh failed: ${claude.reason?.message || 'Unknown local error.'}`;
        main.store.setSourceStatus('claude', 'error', detail);
        main.store.setSourceStatus('claude-fable', 'error', detail);
      }
      try {
        main.store.compactObservations();
      } catch { /* Housekeeping is best effort. */ }
      main.snapshots.invalidateSnapshot();
      const updated = main.snapshots.currentView();
      refresh.lastRefreshAt = Date.now();
      refresh.publishAfterWrite(updated);
      return updated;
    });
    /** @type {string | null} */
    let backupError = null;
    try {
      // Asked here first, so the storage worker is not started after every
      // collection just to answer "not yet"; it re-checks before backing up.
      if (main.store.scheduledBackupDue()) {
        const backup = await main.databaseJobs.exclusive(() => main.maintenance.request('scheduled-backup'));
        if (backup) main.snapshots.invalidateSnapshot();
      }
    } catch (error) {
      backupError = error.message;
    }
    return {
      // Collection publishes once. Returning a second snapshot repeats renders
      // and could replace a newer settings or restore result.
      snapshot: undefined,
      backupError,
      collectors: {
        codex: refresh.collectorOutcome(codex),
        claude: refresh.collectorOutcome(claude),
      },
    };
  }

  // Claude-only refreshes follow a local change (a manual observation, or the
  // status-line helper being enabled or disabled). None is a request to read
  // plan usage, so the collector host sends every one with readPlanUsage false.
  async function refreshClaudeOnly() {
    if (main.lifecycle.isQuitting) return main.snapshots.previousSnapshot;
    const outcomes = await main.databaseJobs.collect(() => main.collectors.refreshClaude());
    if (outcomes?.claude?.status === 'rejected') {
      throw new Error(outcomes.claude.reason?.message || 'Claude refresh failed.');
    }
    return main.databaseJobs.run(() => {
      main.snapshots.invalidateSnapshot();
      const current = main.snapshots.currentView();
      refresh.publishAfterWrite(current);
      return current;
    });
  }

  // Every caller passes refreshOptionsFor(trigger). Claude plan usage is read
  // only when that says so (an explicit user refresh); the default never reads
  // it. The coalescer joins overlapping requests, except that a user refresh
  // arriving during an automatic run gets its own plan-usage run afterwards.
  refresh.refreshRuns = createRefreshCoalescer((/** @type {{ readPlanUsage: boolean }} */ options) => refresh.collectAll(options));
  return refresh;
}

module.exports = { createRefreshModule };
