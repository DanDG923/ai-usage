'use strict';

const fs = require('node:fs');
const path = require('node:path');
// What the store does, one module per responsibility.
const impl = {
  schema: require('./store/schema.cjs'),
  settings: require('./store/settings.cjs'),
  ledger: require('./store/ledger.cjs'),
  quota: require('./store/quota.cjs'),
  pricing: require('./store/pricing.cjs'),
  analytics: require('./store/analytics.cjs'),
  cycles: require('./store/cycles.cjs'),
  snapshot: require('./store/snapshot.cjs'),
  backup: require('./store/backup.cjs'),
};
const { contextTierSql } = impl.pricing;
const { DEFAULT_SETTINGS } = impl.settings;
const { openDatabase } = impl.schema;

/**
 * A store method's type, taken from the function it hands over to: the same
 * parameters without the leading store, and the same result.
 *
 * @template {(store: any, ...args: any[]) => any} F
 * @typedef {F extends (store: any, ...args: infer A) => infer R ? (...args: A) => R : never} Method
 */

// The one handle on the local database. The class owns the connection, the
// prepared-statement and analytics caches and the transaction; what it does
// lives in electron/store/, one module per responsibility, and each method
// here hands over to it. Those modules call each other through this class, so
// a method replaced on an instance is the one every caller reaches.
class UsageStore {
  /**
   * @param {string} databasePath
   * @param {string} backupDirectory
   */
  constructor(databasePath, backupDirectory) {
    // A relative path resolves against whatever directory happened to be
    // current, which once produced a database literally named "-".
    if (databasePath !== ':memory:' && !path.isAbsolute(databasePath)) {
      throw new Error('The database path must be absolute.');
    }
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(backupDirectory, { recursive: true });
    this.databasePath = databasePath;
    this.backupDirectory = backupDirectory;
    /** @type {Map<string, import('./types').Statement>} */
    this.statements = new Map();
    this.costAnalyticsCache = new Map();
    this.cycleHistoryCache = new Map();
    this.tokenCapacityCache = new Map();
    /** @type {{ value: any, revision: number, key: string, evaluatedAt: number, expiresAt: number } | null} */
    this.fableProjectionCache = null;
    this.tokenCapacityEvidenceCache = new Map();
    this.quotaRowsCache = new Map();
    this.analyticsDayCache = new Map();
    this.forecastModelCache = new Map();
    this.transactionDepth = 0;
    // The price catalogue as read once for a run of lookups; see withPriceCache.
    /** @type {{ byModel: Map<string, any>, rows: any[] | null } | null} */
    this.priceCache = null;
    // Set by migrate() when this launch added the one-hour cache-write column,
    // so seed() knows to fill it.
    this.addedOneHourPriceColumn = false;
    const opened = openDatabase(databasePath);
    this.db = opened.db;
    // The path an unreadable database was moved to, or null on a normal open.
    this.recoveredFrom = opened.recoveredFrom;
    this.migrate();
    this.seed();
  }

  // node:sqlite does not cache prepared statements, so every call re-parsed
  // its SQL; a first import calls recordUsageEvent thousands of times.
  /**
   * @param {string} sql
   * @returns {import('./types').Statement}
   */
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = /** @type {import('./types').Statement} */ (this.db.prepare(sql));
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // Bulk importers commit once per file rather than once per row: every
  // autocommit write is its own WAL sync. A nested call joins the outer
  // transaction; a throw rolls the whole unit back and is re-thrown.
  /**
   * @template T
   * @param {() => T} run
   * @returns {T}
   */
  transaction(run) {
    if (this.transactionDepth > 0) return run();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  releaseDashboardCaches() {
    this.costAnalyticsCache.clear();
    this.cycleHistoryCache.clear();
    this.analyticsDayCache.clear();
  }

  close() {
    this.releaseDashboardCaches();
    this.statements.clear();
    this.db.close();
  }

  // Schema, migrations and seed rows: store/schema.cjs
  migrate() { return impl.schema.migrate(this); }
  migrateAnalyticsRevisions() { return impl.schema.migrateAnalyticsRevisions(this); }
  canonicaliseCodexManualRows() { return impl.schema.canonicaliseCodexManualRows(this); }
  seed() { return impl.schema.seed(this); }

  // Settings: store/settings.cjs
  repairSettings() { return impl.settings.repairSettings(this); }
  getSettings() { return impl.settings.getSettings(this); }
  /** @type {Method<typeof impl.settings.updateSettings>} */
  updateSettings(patch) { return impl.settings.updateSettings(this, patch); }

  // Collector writes: store/ledger.cjs
  /** @type {Method<typeof impl.ledger.setSourceStatus>} */
  setSourceStatus(id, status, detail, metadata, options) {
    return impl.ledger.setSourceStatus(this, id, status, detail, metadata, options);
  }
  /** @type {Method<typeof impl.ledger.recordObservation>} */
  recordObservation(observation) { return impl.ledger.recordObservation(this, observation); }
  /** @type {Method<typeof impl.ledger.recordUsageEvent>} */
  recordUsageEvent(event) { return impl.ledger.recordUsageEvent(this, event); }
  /** @type {Method<typeof impl.ledger.getManualBucketId>} */
  getManualBucketId(sourceId) { return impl.ledger.getManualBucketId(this, sourceId); }
  /** @type {Method<typeof impl.ledger.upsertDailyUsage>} */
  upsertDailyUsage(sourceId, usageDate, tokens) { return impl.ledger.upsertDailyUsage(this, sourceId, usageDate, tokens); }
  /** @type {Method<typeof impl.ledger.getImportedFile>} */
  getImportedFile(filePath) { return impl.ledger.getImportedFile(this, filePath); }
  /** @type {Method<typeof impl.ledger.markImportedFile>} */
  markImportedFile(filePath, modifiedMs, sizeBytes, state) {
    return impl.ledger.markImportedFile(this, filePath, modifiedMs, sizeBytes, state);
  }
  /** @type {Method<typeof impl.ledger.forgetImportedFile>} */
  forgetImportedFile(filePath) { return impl.ledger.forgetImportedFile(this, filePath); }
  /** @type {Method<typeof impl.ledger.compactObservations>} */
  compactObservations(nowMs) { return impl.ledger.compactObservations(this, nowMs); }

  // Allowance windows and forecasts: store/quota.cjs
  /** @type {Method<typeof impl.quota.getQuota>} */
  getQuota(sourceId, settings, nowMs, options) { return impl.quota.getQuota(this, sourceId, settings, nowMs, options); }
  /** @type {Method<typeof impl.quota.learnedForecast>} */
  learnedForecast(sourceId, bucketId, observations, options, revision) {
    return impl.quota.learnedForecast(this, sourceId, bucketId, observations, options, revision);
  }
  /** @type {Method<typeof impl.quota.projectedFableWindow>} */
  projectedFableWindow(windows, bucketRows, settings, forecastOptions, nowMs, includeTokenCapacity) {
    return impl.quota.projectedFableWindow(this, windows, bucketRows, settings, forecastOptions, nowMs, includeTokenCapacity);
  }
  /** @type {Method<typeof impl.quota.getFableProjection>} */
  getFableProjection(settings, nowMs) { return impl.quota.getFableProjection(this, settings, nowMs); }
  /** @type {Method<typeof impl.quota.hasUsableObservation>} */
  hasUsableObservation(sourceId, nowMs, options) { return impl.quota.hasUsableObservation(this, sourceId, nowMs, options); }
  /** @type {Method<typeof impl.quota.tokenCapacityEvidence>} */
  tokenCapacityEvidence(sourceId, nowMs) { return impl.quota.tokenCapacityEvidence(this, sourceId, nowMs); }
  /** @type {Method<typeof impl.quota.getTokenCapacity>} */
  getTokenCapacity(sourceId, bucketId, observations, settings, nowMs, capturedQuotaRevision) {
    return impl.quota.getTokenCapacity(this, sourceId, bucketId, observations, settings, nowMs, capturedQuotaRevision);
  }

  // Price catalogue: store/pricing.cjs
  /**
   * @template T
   * @param {() => T} run
   * @returns {T}
   */
  withPriceCache(run) { return impl.pricing.withPriceCache(this, run); }
  /** @type {Method<typeof impl.pricing.resolvePrice>} */
  resolvePrice(model) { return impl.pricing.resolvePrice(this, model); }
  /** @type {Method<typeof impl.pricing.lookupPrice>} */
  lookupPrice(model, cache) { return impl.pricing.lookupPrice(this, model, cache); }
  getPriceCatalog() { return impl.pricing.getPriceCatalog(this); }
  /** @type {Method<typeof impl.pricing.updatePrice>} */
  updatePrice(row) { return impl.pricing.updatePrice(this, row); }
  /** @type {Method<typeof impl.pricing.calculateCost>} */
  calculateCost(row) { return impl.pricing.calculateCost(this, row); }

  // Cost analytics: store/analytics.cjs
  /** @type {Method<typeof impl.analytics.getCostAnalytics>} */
  getCostAnalytics(days, settings, nowMs) { return impl.analytics.getCostAnalytics(this, days, settings, nowMs); }
  analyticsRevision() { return impl.analytics.analyticsRevision(this); }
  /** @type {Method<typeof impl.analytics.getAnalytics>} */
  getAnalytics(days, settings, nowMs) { return impl.analytics.getAnalytics(this, days, settings, nowMs); }
  /** @type {Method<typeof impl.analytics.buildCostAnalytics>} */
  buildCostAnalytics(days, settings, nowMs) { return impl.analytics.buildCostAnalytics(this, days, settings, nowMs); }
  /** @type {Method<typeof impl.analytics.getSessionPage>} */
  getSessionPage(options, nowMs) { return impl.analytics.getSessionPage(this, options, nowMs); }
  /** @type {Method<typeof impl.analytics.getTaskPage>} */
  getTaskPage(options, nowMs) { return impl.analytics.getTaskPage(this, options, nowMs); }
  /** @type {Method<typeof impl.analytics.analyticsEvents>} */
  analyticsEvents(since, until) { return impl.analytics.analyticsEvents(this, since, until); }
  /** @type {Method<typeof impl.analytics.buildAnalytics>} */
  buildAnalytics(days, settings, nowMs) { return impl.analytics.buildAnalytics(this, days, settings, nowMs); }
  /** @type {Method<typeof impl.analytics.exportLedgerCsv>} */
  exportLedgerCsv(days, nowMs, write) { return impl.analytics.exportLedgerCsv(this, days, nowMs, write); }
  /** @type {Method<typeof impl.analytics.getDailyUsage>} */
  getDailyUsage(days, nowMs) { return impl.analytics.getDailyUsage(this, days, nowMs); }
  /** @type {Method<typeof impl.analytics.getFableActivity>} */
  getFableActivity(fableQuota, settings, nowMs) { return impl.analytics.getFableActivity(this, fableQuota, settings, nowMs); }

  // Reset-cycle history: store/cycles.cjs
  /** @type {Method<typeof impl.cycles.cycleRevision>} */
  cycleRevision(sourceId, bucketId) { return impl.cycles.cycleRevision(this, sourceId, bucketId); }
  /** @type {Method<typeof impl.cycles.getCycleHistory>} */
  getCycleHistory(sourceId, quota, settings, limit, nowMs) {
    return impl.cycles.getCycleHistory(this, sourceId, quota, settings, limit, nowMs);
  }
  /** @type {Method<typeof impl.cycles.buildCycleHistory>} */
  buildCycleHistory(sourceId, quota, settings, limit, nowMs) {
    return impl.cycles.buildCycleHistory(this, sourceId, quota, settings, limit, nowMs);
  }

  // Snapshots: store/snapshot.cjs
  /** @type {Method<typeof impl.snapshot.getTraySnapshot>} */
  getTraySnapshot(nowMs, options) { return impl.snapshot.getTraySnapshot(this, nowMs, options); }
  /** @type {Method<typeof impl.snapshot.getClaudeExtraUsage>} */
  getClaudeExtraUsage(nowMs) { return impl.snapshot.getClaudeExtraUsage(this, nowMs); }
  /** @type {Method<typeof impl.snapshot.getDashboardSnapshot>} */
  getDashboardSnapshot(days, nowMs) { return impl.snapshot.getDashboardSnapshot(this, days, nowMs); }

  // Backups and restore: store/backup.cjs
  /** @type {Method<typeof impl.backup.createBackup>} */
  createBackup(options) { return impl.backup.createBackup(this, options); }
  /** @type {Method<typeof impl.backup.readExport>} */
  readExport(filePath) { return impl.backup.readExport(this, filePath); }
  /** @type {Method<typeof impl.backup.readDatabaseBackup>} */
  readDatabaseBackup(filePath) { return impl.backup.readDatabaseBackup(this, filePath); }
  /** @type {Method<typeof impl.backup.sweepPartialBackups>} */
  sweepPartialBackups(nowMs) { return impl.backup.sweepPartialBackups(this, nowMs); }
  /** @type {Method<typeof impl.backup.restoreFromBackup>} */
  restoreFromBackup(filePath) { return impl.backup.restoreFromBackup(this, filePath); }
  /** @type {Method<typeof impl.backup.restoreFromExport>} */
  restoreFromExport(payload) { return impl.backup.restoreFromExport(this, payload); }
  /** @type {Method<typeof impl.backup.pruneBackups>} */
  pruneBackups(retentionCount, keepPath) { return impl.backup.pruneBackups(this, retentionCount, keepPath); }
  /** @type {Method<typeof impl.backup.scheduledBackupDue>} */
  scheduledBackupDue(nowMs) { return impl.backup.scheduledBackupDue(this, nowMs); }
  maybeCreateScheduledBackup() { return impl.backup.maybeCreateScheduledBackup(this); }
}

/** @typedef {InstanceType<typeof UsageStore>} Store The type of a store, for the modules in electron/store/. */

module.exports = { UsageStore, DEFAULT_SETTINGS, contextTierSql };
