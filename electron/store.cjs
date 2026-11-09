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

// The one handle on the local database. The class owns the connection, the
// prepared-statement and analytics caches and the transaction; what it does
// lives in electron/store/, one module per responsibility, and each method
// here hands over to it. Those modules call each other through this class, so
// a method replaced on an instance is the one every caller reaches.
class UsageStore {
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
    this.statements = new Map();
    this.costAnalyticsCache = new Map();
    this.cycleHistoryCache = new Map();
    this.tokenCapacityCache = new Map();
    this.fableProjectionCache = null;
    this.tokenCapacityEvidenceCache = new Map();
    this.quotaRowsCache = new Map();
    this.analyticsDayCache = new Map();
    this.forecastModelCache = new Map();
    this.transactionDepth = 0;
    // The price catalogue as read once for a run of lookups; see withPriceCache.
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
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // Bulk importers commit once per file rather than once per row: every
  // autocommit write is its own WAL sync. A nested call joins the outer
  // transaction; a throw rolls the whole unit back and is re-thrown.
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
  updateSettings(patch) { return impl.settings.updateSettings(this, patch); }

  // Collector writes: store/ledger.cjs
  setSourceStatus(id, status, detail, metadata, options) {
    return impl.ledger.setSourceStatus(this, id, status, detail, metadata, options);
  }
  recordObservation(observation) { return impl.ledger.recordObservation(this, observation); }
  recordUsageEvent(event) { return impl.ledger.recordUsageEvent(this, event); }
  getManualBucketId(sourceId) { return impl.ledger.getManualBucketId(this, sourceId); }
  upsertDailyUsage(sourceId, usageDate, tokens) { return impl.ledger.upsertDailyUsage(this, sourceId, usageDate, tokens); }
  getImportedFile(filePath) { return impl.ledger.getImportedFile(this, filePath); }
  markImportedFile(filePath, modifiedMs, sizeBytes, state) {
    return impl.ledger.markImportedFile(this, filePath, modifiedMs, sizeBytes, state);
  }
  forgetImportedFile(filePath) { return impl.ledger.forgetImportedFile(this, filePath); }
  compactObservations(nowMs) { return impl.ledger.compactObservations(this, nowMs); }

  // Allowance windows and forecasts: store/quota.cjs
  getQuota(sourceId, settings, nowMs, options) { return impl.quota.getQuota(this, sourceId, settings, nowMs, options); }
  learnedForecast(sourceId, bucketId, observations, options, revision) {
    return impl.quota.learnedForecast(this, sourceId, bucketId, observations, options, revision);
  }
  projectedFableWindow(windows, bucketRows, settings, forecastOptions, nowMs, includeTokenCapacity) {
    return impl.quota.projectedFableWindow(this, windows, bucketRows, settings, forecastOptions, nowMs, includeTokenCapacity);
  }
  getFableProjection(settings, nowMs) { return impl.quota.getFableProjection(this, settings, nowMs); }
  hasUsableObservation(sourceId, nowMs, options) { return impl.quota.hasUsableObservation(this, sourceId, nowMs, options); }
  tokenCapacityEvidence(sourceId, nowMs) { return impl.quota.tokenCapacityEvidence(this, sourceId, nowMs); }
  getTokenCapacity(sourceId, bucketId, observations, settings, nowMs, capturedQuotaRevision) {
    return impl.quota.getTokenCapacity(this, sourceId, bucketId, observations, settings, nowMs, capturedQuotaRevision);
  }

  // Price catalogue: store/pricing.cjs
  withPriceCache(run) { return impl.pricing.withPriceCache(this, run); }
  resolvePrice(model) { return impl.pricing.resolvePrice(this, model); }
  lookupPrice(model, cache) { return impl.pricing.lookupPrice(this, model, cache); }
  getPriceCatalog() { return impl.pricing.getPriceCatalog(this); }
  updatePrice(row) { return impl.pricing.updatePrice(this, row); }
  calculateCost(row) { return impl.pricing.calculateCost(this, row); }

  // Cost analytics: store/analytics.cjs
  getCostAnalytics(days, settings, nowMs) { return impl.analytics.getCostAnalytics(this, days, settings, nowMs); }
  analyticsRevision() { return impl.analytics.analyticsRevision(this); }
  getAnalytics(days, settings, nowMs) { return impl.analytics.getAnalytics(this, days, settings, nowMs); }
  buildCostAnalytics(days, settings, nowMs) { return impl.analytics.buildCostAnalytics(this, days, settings, nowMs); }
  getSessionPage(options, nowMs) { return impl.analytics.getSessionPage(this, options, nowMs); }
  getTaskPage(options, nowMs) { return impl.analytics.getTaskPage(this, options, nowMs); }
  analyticsEvents(since, until) { return impl.analytics.analyticsEvents(this, since, until); }
  buildAnalytics(days, settings, nowMs) { return impl.analytics.buildAnalytics(this, days, settings, nowMs); }
  exportLedgerCsv(days, nowMs, write) { return impl.analytics.exportLedgerCsv(this, days, nowMs, write); }
  getDailyUsage(days, nowMs) { return impl.analytics.getDailyUsage(this, days, nowMs); }
  getFableActivity(fableQuota, settings, nowMs) { return impl.analytics.getFableActivity(this, fableQuota, settings, nowMs); }

  // Reset-cycle history: store/cycles.cjs
  cycleRevision(sourceId, bucketId) { return impl.cycles.cycleRevision(this, sourceId, bucketId); }
  getCycleHistory(sourceId, quota, settings, limit, nowMs) {
    return impl.cycles.getCycleHistory(this, sourceId, quota, settings, limit, nowMs);
  }
  buildCycleHistory(sourceId, quota, settings, limit, nowMs) {
    return impl.cycles.buildCycleHistory(this, sourceId, quota, settings, limit, nowMs);
  }

  // Snapshots: store/snapshot.cjs
  getTraySnapshot(nowMs, options) { return impl.snapshot.getTraySnapshot(this, nowMs, options); }
  getClaudeExtraUsage(nowMs) { return impl.snapshot.getClaudeExtraUsage(this, nowMs); }
  getDashboardSnapshot(days, nowMs) { return impl.snapshot.getDashboardSnapshot(this, days, nowMs); }

  // Backups and restore: store/backup.cjs
  createBackup(options) { return impl.backup.createBackup(this, options); }
  readExport(filePath) { return impl.backup.readExport(this, filePath); }
  readDatabaseBackup(filePath) { return impl.backup.readDatabaseBackup(this, filePath); }
  sweepPartialBackups(nowMs) { return impl.backup.sweepPartialBackups(this, nowMs); }
  restoreFromBackup(filePath) { return impl.backup.restoreFromBackup(this, filePath); }
  restoreFromExport(payload) { return impl.backup.restoreFromExport(this, payload); }
  pruneBackups(retentionCount, keepPath) { return impl.backup.pruneBackups(this, retentionCount, keepPath); }
  scheduledBackupDue(nowMs) { return impl.backup.scheduledBackupDue(this, nowMs); }
  maybeCreateScheduledBackup() { return impl.backup.maybeCreateScheduledBackup(this); }
}

/** @typedef {InstanceType<typeof UsageStore>} Store The type of a store, for the modules in electron/store/. */

module.exports = { UsageStore, DEFAULT_SETTINGS, contextTierSql };
