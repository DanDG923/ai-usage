'use strict';

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./store/schema.cjs');
const settings = require('./store/settings.cjs');
const ledger = require('./store/ledger.cjs');
const quota = require('./store/quota.cjs');
const pricing = require('./store/pricing.cjs');
const analytics = require('./store/analytics.cjs');
const cycles = require('./store/cycles.cjs');
const snapshot = require('./store/snapshot.cjs');
const backup = require('./store/backup.cjs');
const { contextTierSql } = pricing;
const { DEFAULT_SETTINGS } = settings;
const { openDatabase } = schema;

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
  migrate() { return schema.migrate(this); }
  migrateAnalyticsRevisions() { return schema.migrateAnalyticsRevisions(this); }
  canonicaliseCodexManualRows() { return schema.canonicaliseCodexManualRows(this); }
  seed() { return schema.seed(this); }

  // Settings: store/settings.cjs
  repairSettings() { return settings.repairSettings(this); }
  getSettings() { return settings.getSettings(this); }
  updateSettings(...args) { return settings.updateSettings(this, ...args); }

  // Collector writes: store/ledger.cjs
  setSourceStatus(...args) { return ledger.setSourceStatus(this, ...args); }
  recordObservation(...args) { return ledger.recordObservation(this, ...args); }
  recordUsageEvent(...args) { return ledger.recordUsageEvent(this, ...args); }
  getManualBucketId(...args) { return ledger.getManualBucketId(this, ...args); }
  upsertDailyUsage(...args) { return ledger.upsertDailyUsage(this, ...args); }
  getImportedFile(...args) { return ledger.getImportedFile(this, ...args); }
  markImportedFile(...args) { return ledger.markImportedFile(this, ...args); }
  forgetImportedFile(...args) { return ledger.forgetImportedFile(this, ...args); }
  compactObservations(...args) { return ledger.compactObservations(this, ...args); }

  // Allowance windows and forecasts: store/quota.cjs
  getQuota(...args) { return quota.getQuota(this, ...args); }
  learnedForecast(...args) { return quota.learnedForecast(this, ...args); }
  projectedFableWindow(...args) { return quota.projectedFableWindow(this, ...args); }
  getFableProjection(...args) { return quota.getFableProjection(this, ...args); }
  hasUsableObservation(...args) { return quota.hasUsableObservation(this, ...args); }
  tokenCapacityEvidence(...args) { return quota.tokenCapacityEvidence(this, ...args); }
  getTokenCapacity(...args) { return quota.getTokenCapacity(this, ...args); }

  // Price catalogue: store/pricing.cjs
  withPriceCache(...args) { return pricing.withPriceCache(this, ...args); }
  resolvePrice(...args) { return pricing.resolvePrice(this, ...args); }
  lookupPrice(...args) { return pricing.lookupPrice(this, ...args); }
  getPriceCatalog() { return pricing.getPriceCatalog(this); }
  updatePrice(...args) { return pricing.updatePrice(this, ...args); }
  calculateCost(...args) { return pricing.calculateCost(this, ...args); }

  // Cost analytics: store/analytics.cjs
  getCostAnalytics(...args) { return analytics.getCostAnalytics(this, ...args); }
  analyticsRevision() { return analytics.analyticsRevision(this); }
  getAnalytics(...args) { return analytics.getAnalytics(this, ...args); }
  buildCostAnalytics(...args) { return analytics.buildCostAnalytics(this, ...args); }
  getSessionPage(...args) { return analytics.getSessionPage(this, ...args); }
  getTaskPage(...args) { return analytics.getTaskPage(this, ...args); }
  analyticsEvents(...args) { return analytics.analyticsEvents(this, ...args); }
  buildAnalytics(...args) { return analytics.buildAnalytics(this, ...args); }
  exportLedgerCsv(...args) { return analytics.exportLedgerCsv(this, ...args); }
  getDailyUsage(...args) { return analytics.getDailyUsage(this, ...args); }
  getFableActivity(...args) { return analytics.getFableActivity(this, ...args); }

  // Reset-cycle history: store/cycles.cjs
  cycleRevision(...args) { return cycles.cycleRevision(this, ...args); }
  getCycleHistory(...args) { return cycles.getCycleHistory(this, ...args); }
  buildCycleHistory(...args) { return cycles.buildCycleHistory(this, ...args); }

  // Snapshots: store/snapshot.cjs
  getTraySnapshot(...args) { return snapshot.getTraySnapshot(this, ...args); }
  getClaudeExtraUsage(...args) { return snapshot.getClaudeExtraUsage(this, ...args); }
  getDashboardSnapshot(...args) { return snapshot.getDashboardSnapshot(this, ...args); }

  // Backups and restore: store/backup.cjs
  createBackup(...args) { return backup.createBackup(this, ...args); }
  readExport(...args) { return backup.readExport(this, ...args); }
  readDatabaseBackup(...args) { return backup.readDatabaseBackup(this, ...args); }
  sweepPartialBackups(...args) { return backup.sweepPartialBackups(this, ...args); }
  restoreFromBackup(...args) { return backup.restoreFromBackup(this, ...args); }
  restoreFromExport(...args) { return backup.restoreFromExport(this, ...args); }
  pruneBackups(...args) { return backup.pruneBackups(this, ...args); }
  scheduledBackupDue(...args) { return backup.scheduledBackupDue(this, ...args); }
  maybeCreateScheduledBackup() { return backup.maybeCreateScheduledBackup(this); }
}

module.exports = { UsageStore, DEFAULT_SETTINGS, contextTierSql };
