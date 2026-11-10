'use strict';

// Which refreshes may read Claude plan usage.
//
// Plan usage is read by starting the user's own Claude Code through the Agent
// SDK. Anthropic's Consumer Terms bar automated access to a Claude
// subscription, so that read happens only when the user explicitly asks for a
// refresh. Everything else the app collects on its own — the local transcript
// import, the status-line inbox, the Claude Code mod's readings and Codex —
// never contacts Anthropic and stays automatic.
//
// Every refresh names its trigger. Only the triggers listed as user requests
// read plan usage; any other trigger, including one this table does not know,
// does not.

const REFRESH_TRIGGERS = Object.freeze({
  // Explicit user requests.
  DASHBOARD_REFRESH: 'dashboard-refresh',
  FLYOUT_REFRESH: 'flyout-refresh',
  TRAY_MENU_REFRESH: 'tray-menu-refresh',
  // Automatic collection.
  LAUNCH: 'launch',
  SCHEDULE: 'schedule',
  WINDOW_SHOW: 'window-show',
  FLYOUT_SHOW: 'flyout-show',
  WAKE: 'wake',
  BACKUP_RESTORE: 'backup-restore',
  // Claude-only refreshes after a local change (refreshClaudeOnly). Finishing
  // Claude setup also goes through refreshClaudeOnly, so it never reads plan usage.
  MANUAL_OBSERVATION: 'manual-observation',
  HELPER_CHANGE: 'helper-change',
  // "Sync now" in the Claude Code mod: a person asks, but from inside Claude
  // Code, which already holds the plan limits; the app collects locally only.
  CLAUDE_CODE_SYNC: 'claude-code-sync',
});

// Typed loosely so that a trigger this table does not know, or none at all,
// can be looked up and simply is not found.
/** @type {Set<string | undefined>} */
const USER_REQUESTED_TRIGGERS = new Set([
  REFRESH_TRIGGERS.DASHBOARD_REFRESH,
  REFRESH_TRIGGERS.FLYOUT_REFRESH,
  REFRESH_TRIGGERS.TRAY_MENU_REFRESH,
]);

/** @param {string | undefined} trigger One of REFRESH_TRIGGERS; anything else reads no plan usage. */
function readsPlanUsage(trigger) {
  return USER_REQUESTED_TRIGGERS.has(trigger);
}

/** @param {string | undefined} trigger */
function refreshOptionsFor(trigger) {
  return { trigger, readPlanUsage: readsPlanUsage(trigger) };
}

const settle = (/** @type {Promise<unknown>} */ promise) => promise.then(() => undefined, () => undefined);

// One collection at a time, and coalescing that never swallows a user's
// request: a request joins the run in flight unless it asks for plan usage
// and that run does not read it. Then it waits for the run and performs one
// plan-usage refresh, which every such request arriving meanwhile shares.
/** @param {(options: { readPlanUsage: boolean }) => unknown} run Collects once; its result is what every joined request receives. */
function createRefreshCoalescer(run) {
  /** @type {{ readPlanUsage: boolean, promise: Promise<any> } | null} */
  let current = null;
  /** @type {Promise<any> | null} */
  let followUp = null;

  /** @param {boolean} readPlanUsage */
  function start(readPlanUsage) {
    const entry = { readPlanUsage, promise: /** @type {Promise<any>} */ (/** @type {unknown} */ (null)) };
    current = entry;
    entry.promise = (async () => {
      try {
        return await run({ readPlanUsage });
      } finally {
        if (current === entry) current = null;
      }
    })();
    return entry.promise;
  }

  const automaticRun = () => (current && !current.readPlanUsage ? current.promise : null);

  function request({ readPlanUsage = false } = {}) {
    const wanted = readPlanUsage === true;
    if (!current) return start(wanted);
    if (current.readPlanUsage || !wanted) return current.promise;
    followUp ??= (async () => {
      // An automatic run may start in the instant between two runs; wait
      // that out too rather than run beside it.
      for (let automatic = automaticRun(); automatic; automatic = automaticRun()) await settle(automatic);
      followUp = null;
      return current ? current.promise : start(true);
    })();
    return followUp;
  }

  return {
    request,
    get running() { return Boolean(current); },
    get readingPlanUsage() { return Boolean(current?.readPlanUsage); },
  };
}

module.exports = { REFRESH_TRIGGERS, USER_REQUESTED_TRIGGERS, createRefreshCoalescer, readsPlanUsage, refreshOptionsFor };
