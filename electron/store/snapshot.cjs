'use strict';

// The snapshots the tray, flyout, notifications and dashboard are drawn from.

/** @typedef {import('../../src/types').ClaudeExtraUsage} ClaudeExtraUsage */
/** @typedef {import('../../src/types').Snapshot} Snapshot */
/** @typedef {import('../types').IsoTime} IsoTime */
/** @typedef {import('../types').Ms} Ms */
/** @typedef {Pick<import('../../src/types').Snapshot, 'generatedAt' | 'timezone' | 'settings' | 'sources' | 'quotas' | 'fableApplies' | 'dashboardVerdict' | 'resetCredits'>} TraySnapshot */

const fs = require('node:fs');
const { buildDashboardVerdict } = require('../dashboard-decision.cjs');
const { applySharedPool } = require('../fable-shared-pool.cjs');
const { QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS } = require('../quota-time.cjs');
const { iso, json } = require('./shared.cjs');

/**
 * @param {import('../store.cjs').Store} store
 * @param {Ms} [nowMs]
 * @param {{ tokenCapacity?: boolean }} [options]
 * @returns {TraySnapshot}
 */
function getTraySnapshot(store, nowMs = Date.now(), { tokenCapacity = false } = {}) {
  const settings = store.getSettings();
  // The table holds only the seeded sources, so every id is one the renderer knows.
  const sources = /** @type {(import('../types').SourceRow & { id: import('../types').SourceId })[]} */ (
    store.prepare('SELECT * FROM sources ORDER BY CASE id WHEN \'codex\' THEN 1 WHEN \'claude\' THEN 2 ELSE 3 END').all())
    .map((row) => ({ ...row, metadata: json(row.metadata_json, {}) }));
  const claude = store.getQuota('claude', settings, nowMs, { tokenCapacity });
  const quotas = {
    codex: store.getQuota('codex', settings, nowMs, { tokenCapacity }),
    claude,
    // Fable's limit sits inside the Claude weekly pool: whatever any model
    // has used of the week also caps what Fable can still use.
    fable: applySharedPool(store.getQuota('claude-fable', settings, nowMs, { tokenCapacity }), claude, { nowMs, settings }),
  };
  // A plan the provider names other than Max has no Fable allowance, so
  // with no Fable reading there is nothing for the verdict to wait for.
  const fableProjection = quotas.fable ? null : store.getFableProjection(settings, nowMs);
  const fableApplies = Boolean(quotas.fable)
    || !(fableProjection?.reason === 'fable-not-confirmed-in-shared-plan' && fableProjection.planType);
  const reportedResetCredits = /** @type {any} */ (quotas.codex?.metadata?.resetCredits);
  // The renderer compares and formats this count. Never coerce imported JSON.
  const resetCredits = Number.isSafeInteger(reportedResetCredits) && reportedResetCredits >= 0
    ? reportedResetCredits : 0;
  return {
    generatedAt: iso(nowMs),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    settings,
    sources,
    quotas,
    fableApplies,
    dashboardVerdict: buildDashboardVerdict({ quotas, sources, settings, fableApplies }),
    resetCredits,
  };
}

// The extra-usage setting the newest plan-usage read reported, from either
// Claude source. A newer status-line or projected reading carries none, so
// the headline window's metadata alone can miss the last Refresh.
/**
 * @param {import('../store.cjs').Store} store
 * @param {Ms} [nowMs]
 * @returns {ClaudeExtraUsage | null}
 */
function getClaudeExtraUsage(store, nowMs = Date.now()) {
  const row = /** @type {{ metadata_json: string, observed_at: IsoTime } | undefined} */ (store.prepare(`
      SELECT metadata_json, observed_at FROM quota_observations
      WHERE source_id IN ('claude', 'claude-fable') AND provenance = 'official-claude-usage'
        AND observed_at >= ? AND observed_at <= ? AND metadata_json LIKE '%"extraUsage"%'
      ORDER BY observed_at DESC, id DESC LIMIT 1
    `).get(iso(nowMs - FORECAST_LOOKBACK_MS), iso(nowMs + QUOTA_CLOCK_SKEW_MS)));
  const extra = json(row?.metadata_json, {})?.extraUsage;
  if (!extra || typeof extra !== 'object' || typeof extra.isEnabled !== 'boolean') return null;
  const utilization = Number.isFinite(extra.utilization) ? extra.utilization : null;
  // Without a row there is no `extra`, and the function has returned above.
  return { isEnabled: extra.isEnabled, utilization, observedAt: /** @type {NonNullable<typeof row>} */ (row).observed_at };
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {number} [days]
 * @param {Ms} [nowMs]
 * @returns {Snapshot}
 */
function getDashboardSnapshot(store, days = 30, nowMs = Date.now()) {
  const snapshot = store.getTraySnapshot(nowMs, { tokenCapacity: true });
  const { settings, quotas } = snapshot;
  return {
    ...snapshot,
    fableActivity: store.getFableActivity(quotas.fable, settings, nowMs),
    claudeExtraUsage: store.getClaudeExtraUsage(nowMs),
    priceCatalog: store.getPriceCatalog(),
    costs: store.getCostAnalytics(days, settings, nowMs),
    desktopEstimates: require('../desktop-estimates.cjs').desktopAnalytics(store, days, settings, nowMs),
    cycles: {
      codex: store.getCycleHistory('codex', quotas.codex, settings, 8, nowMs),
      claude: store.getCycleHistory('claude', quotas.claude, settings, 8, nowMs),
      fable: store.getCycleHistory('claude-fable', quotas.fable, settings, 8, nowMs),
    },
    dailyUsage: store.getDailyUsage(Math.max(days, 90), nowMs),
    storage: {
      databasePath: store.databasePath,
      backupDirectory: store.backupDirectory,
      databaseSize: fs.existsSync(store.databasePath) ? fs.statSync(store.databasePath).size : 0,
    },
  };
}

module.exports = { getTraySnapshot, getClaudeExtraUsage, getDashboardSnapshot };
