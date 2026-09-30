'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { buildDashboardVerdict } = require('./dashboard-decision.cjs');
const { isOfficialWindow, selectDisplayedWindows } = require('./quota-selection.cjs');
const { FABLE_BUCKET, FABLE_BUCKET_NAME, projectFableAllowance } = require('./fable-projection.cjs');
const { applySharedPool } = require('./fable-shared-pool.cjs');
const { codexQuotaLabel } = require('./codex-quota-label.cjs');
const { forecastQuota, freshReadGraceFor, normaliseObservation, prepareObservation, clusterByWindow, withoutStaleRestatements } = require('./forecast.cjs');
const { TaskUsage } = require('./task-usage.cjs');
const { estimateTokenCapacity, LOOKBACK_MS: TOKEN_CAPACITY_LOOKBACK_MS, STALENESS_MS: TOKEN_CAPACITY_STALENESS_MS } = require('./token-capacity.cjs');
const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS, validQuotaTime } = require('./quota-time.cjs');
const { isAllowanceChange, isAllowanceChangeList, normalizeAllowanceChanges } = require('./allowance-changes.cjs');

const SOURCE_DEFINITIONS = [
  ['codex', 'Codex', 'codex'],
  ['claude', 'Claude', 'claude'],
  ['claude-fable', 'Fable', 'fable'],
];
const KNOWN_SOURCE_IDS = new Set(SOURCE_DEFINITIONS.map(([id]) => id));
// Stored by versions before 1.0.52 and still present in their backups.
const LEGACY_FABLE_BUCKET_NAME = 'Fable 5 weekly';
const DAY_MS = 24 * 60 * 60 * 1000;
// Beyond this age, keep each local day's endpoints and peak per bucket/window.
// Provider rebounds must not erase the maximum shown in reset-cycle history.
const COMPACT_AFTER_MS = 60 * DAY_MS;
// About a megabyte of ledger CSV is written at a time.
const CSV_BATCH_CHARS = 1 << 20;
const OPENAI_LONG_CONTEXT_THRESHOLD = 272_000;
const OPENAI_LONG_CONTEXT_MODELS = new Set(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

const DEFAULT_SETTINGS = {
  showCodexSubscription: true,
  showClaudeSubscription: true,
  currency: 'GBP',
  usdToCurrency: 0.736,
  currencyRates: { USD: 1, GBP: 0.736 },
  activeDays: [1, 2, 3, 4, 5, 6, 0],
  activeStartHour: 8,
  activeEndHour: 22,
  forecastFallbackRate: 0.35,
  paceRiskThreshold: 1.2,
  hardLimitThreshold: 90,
  reservePercent: 0,
  forecastExcludedDates: [],
  allowanceChanges: [],
  codexPlanUsdPerMonth: 0,
  claudePlanUsdPerMonth: 0,
  // A free reset Claude offers in its own Usage settings. No Claude API
  // reports it, so it is recorded by hand and hidden after its expiry date.
  claudeFreeResets: 0,
  claudeFreeResetsExpireOn: null,
  notifyDesktop: true,
  notifyResets: true,
  notifyFallback: true,
  notifyDigest: false,
  digestHour: 9,
  alertsSnoozedUntil: null,
  launchAtLogin: false,
  theme: 'system',
  // Software rendering keeps Chromium's GPU process small while the dashboard
  // sits in the tray. Applied at the next launch; see startup-preferences.cjs.
  softwareRendering: true,
  autoUpdate: true,
  backupFrequency: 'daily',
  backupRetentionCount: 30,
  refreshIntervalMinutes: 15,
};

// Settings renamed between releases. Old exports and databases carry the old
// key; both read paths map it forward instead of counting it as unusable.
const SETTING_ALIASES = { notifyInApp: 'notifyDesktop' };

function isIsoOrNull(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function isForecastDate(value) {
  return typeof value === 'string' && /^(?:20\d{2}|2100)-\d{2}-\d{2}$/.test(value)
    && value >= '2020-01-01' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function normalizedSetting(key, value) {
  if (key === 'forecastExcludedDates') return [...new Set(value)].sort();
  if (key === 'allowanceChanges') return normalizeAllowanceChanges(value);
  return value;
}

const SETTING_VALIDATORS = {
  showCodexSubscription: (value) => typeof value === 'boolean',
  showClaudeSubscription: (value) => typeof value === 'boolean',
  currency: (value) => ['GBP', 'USD', 'EUR'].includes(value),
  usdToCurrency: (value) => Number.isFinite(value) && value > 0 && value <= 10_000,
  currencyRates: (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([currency, rate]) => ['GBP', 'USD', 'EUR'].includes(currency)
      && Number.isFinite(rate) && rate > 0 && rate <= 10_000 && (currency !== 'USD' || rate === 1)),
  activeDays: (value) => Array.isArray(value)
    && value.length > 0
    && value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && new Set(value).size === value.length,
  activeStartHour: (value) => Number.isInteger(value) && value >= 0 && value <= 23,
  activeEndHour: (value) => Number.isInteger(value) && value >= 1 && value <= 24,
  forecastFallbackRate: (value) => Number.isFinite(value) && value > 0 && value <= 100,
  paceRiskThreshold: (value) => Number.isFinite(value) && value >= 0.1 && value <= 20,
  hardLimitThreshold: (value) => Number.isFinite(value) && value >= 0 && value <= 100,
  reservePercent: (value) => Number.isFinite(value) && value >= 0 && value <= 50,
  forecastExcludedDates: (value) => Array.isArray(value) && value.length <= 366 && value.every(isForecastDate),
  allowanceChanges: (value) => isAllowanceChangeList(value),
  codexPlanUsdPerMonth: (value) => Number.isFinite(value) && value >= 0 && value <= 100_000,
  claudePlanUsdPerMonth: (value) => Number.isFinite(value) && value >= 0 && value <= 100_000,
  claudeFreeResets: (value) => Number.isInteger(value) && value >= 0 && value <= 10,
  claudeFreeResetsExpireOn: (value) => value === null || isForecastDate(value),
  notifyDesktop: (value) => typeof value === 'boolean',
  notifyResets: (value) => typeof value === 'boolean',
  notifyFallback: (value) => typeof value === 'boolean',
  notifyDigest: (value) => typeof value === 'boolean',
  digestHour: (value) => Number.isInteger(value) && value >= 0 && value <= 23,
  alertsSnoozedUntil: isIsoOrNull,
  launchAtLogin: (value) => typeof value === 'boolean',
  theme: (value) => ['system', 'dark', 'light'].includes(value),
  softwareRendering: (value) => typeof value === 'boolean',
  autoUpdate: (value) => typeof value === 'boolean',
  backupFrequency: (value) => ['off', 'daily', 'weekly'].includes(value),
  backupRetentionCount: (value) => Number.isInteger(value) && value >= 1 && value <= 365,
  // Zero disables the background timer. The floor keeps a mistyped value from
  // rescanning every local transcript once a second.
  refreshIntervalMinutes: (value) => Number.isInteger(value) && (value === 0 || (value >= 5 && value <= 240)),
};

// Inherited names such as `constructor` are not settings. Only an own entry
// of the validator table may vouch for a key from IPC, an export, or a row.
function settingValidator(key) {
  return typeof key === 'string' && Object.hasOwn(SETTING_VALIDATORS, key) ? SETTING_VALIDATORS[key] : null;
}

// Catalogue text fields come from the settings screen or a restored export.
// They are stored and displayed, never dereferenced, so shape and length are
// all that is enforced here.
const MAX_PRICE_MODEL_LENGTH = 120;
const MAX_PRICE_SOURCE_URL_LENGTH = 2048;

function priceModelName(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > MAX_PRICE_MODEL_LENGTH || /[\p{Cc}\p{Cf}]/u.test(model)) return null;
  return model;
}

function priceEffectiveFrom(value) {
  if (value == null || value === '') return iso().slice(0, 10);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function priceSourceUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_PRICE_SOURCE_URL_LENGTH || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
  } catch {
    return undefined;
  }
  return value;
}

// model, input, five-minute cache write, one-hour cache write, cache read, output
const PRICE_ROWS = [
  // Standard API rates verified 2026-09-04; OpenAI has one cache-write rate.
  ['gpt-6-astra', 10, 12.5, 12.5, 1, 50],
  // GPT-6 Sol and Luna standard rates verified 2026-09-22.
  ['gpt-6-sol', 2, 2.5, 2.5, 0.2, 10],
  ['gpt-6-luna', 0.1, 0.125, 0.125, 0.01, 0.5],
  ['gpt-5.6-sol', 4, 5, 5, 0.4, 20],
  ['codex-auto-review', 4, 5, 5, 0.4, 20],
  ['gpt-5.6-terra', 2, 2.5, 2.5, 0.2, 12],
  ['gpt-5.6-luna', 0.2, 0.25, 0.25, 0.02, 1.2],
  // Fable 5.1 and Opus 5.5 standard rates verified 2026-09-26. Fable 5.1
  // differs from Fable 5 only in cache reads: $0.25 against $1 per MTok.
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
];

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function validIso(value, label) {
  if (value == null || value === '') throw new Error(`${label} must be a valid date and time.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
  if (date.getUTCFullYear() < 2020 || date.getUTCFullYear() > 2100) {
    throw new Error(`${label} is outside the supported date range.`);
  }
  return date.toISOString();
}

function optionalText(value, label) {
  if (value != null && typeof value !== 'string') throw new Error(`${label} must be text when supplied.`);
  return value || null;
}

function json(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// The settings a backup carries, whether exported or restored from its
// SQLite copy: the known keys only, as the export has always written them.
function backupSettings(database) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of database.prepare('SELECT key, value_json FROM settings').iterate()) {
    if (Object.hasOwn(DEFAULT_SETTINGS, row.key)) settings[row.key] = json(row.value_json, settings[row.key]);
  }
  return settings;
}

// The settings a SQLite backup actually stored. A restore writes every key it
// is given, so filling the gaps with defaults, as an export does, would reset
// settings the backed-up version never had. A renamed key maps forward, and
// the current name wins when a database holds both.
const UNREADABLE = Symbol('unreadable');
function storedSettings(database) {
  const settings = {};
  for (const row of database.prepare('SELECT key, value_json FROM settings').iterate()) {
    const renamed = Object.hasOwn(SETTING_ALIASES, row.key);
    const key = renamed ? SETTING_ALIASES[row.key] : row.key;
    if (!Object.hasOwn(DEFAULT_SETTINGS, key) || (renamed && Object.hasOwn(settings, key))) continue;
    const value = json(row.value_json, UNREADABLE);
    if (value !== UNREADABLE) settings[key] = value;
  }
  return settings;
}

// Quota metadata is an object even when its JSON text parses successfully.
// Keep the generic JSON decoder unchanged for settings and cursor values.
function quotaMetadata(value) {
  const decoded = typeof value === 'string' ? json(value) : value;
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

// A catalogue model name followed by a date snapshot suffix, e.g. "-20260901".
// Only dates: a point release such as claude-fable-5-1 or claude-opus-5-5 is
// a different model with its own prices, and must show as unpriced until it
// has a row rather than silently borrowing its predecessor's.
const VERSION_SUFFIX = /^(?:\d{8}|\d{4}(?:-\d{2}){0,2})$/;

// Analytics call these once per usage event; constructing an Intl formatter
// each time was the dominant cost of a snapshot, so they are cached per zone.
// Callers on a hot path resolve the zone once and pass it in: the default
// argument below is itself an Intl construction.
const dateFormatters = new Map();
function localParts(value, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
}

function dateKey(value, timeZone) {
  const values = localParts(value, timeZone);
  return `${values.year}-${values.month}-${values.day}`;
}

// A period of N days is the last N local calendar days, today included: its
// total, its daily chart and the renderer's weekly tile share one window, and
// its start moves only at local midnight. Zero days gives tomorrow's midnight.
function periodStart(days, nowMs) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

// The ledger is read in time order, so consecutive events nearly always fall
// in the same quarter hour. Every zone offset is a multiple of fifteen
// minutes, so a quarter-hour slot never straddles a local hour, day or DST
// boundary and one formatted answer serves the whole slot. Formatting was
// otherwise a third of the aggregation.
const QUARTER_HOUR_MS = 15 * 60_000;
function createLocalPartsLookup(timeZone) {
  let slot = null;
  let parts = null;
  return (value) => {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    const current = Math.floor(ms / QUARTER_HOUR_MS);
    if (current !== slot || parts === null) {
      parts = localParts(ms, timeZone);
      slot = current;
    }
    return parts;
  };
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Analytics groups usage by the metadata that attributes it to a task or
// agent. Per-request fields such as Claude's requestId are unique to every
// event, so grouping on them would keep one aggregate row per request.
const ATTRIBUTION_METADATA = `CASE WHEN json_valid(metadata_json)
  THEN json_remove(metadata_json, '$.requestId', '$.entrypoint', '$.sidechain', '$.effort')
  ELSE metadata_json END`;

// SQLITE_CORRUPT and SQLITE_NOTADB: the file exists but SQLite cannot read it.
const UNREADABLE_DATABASE_CODES = new Set([11, 26]);

function openDatabase(databasePath) {
  const open = () => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      return db;
    } catch (error) {
      try { db.close(); } catch { /* Report the pragma failure, not the close. */ }
      throw error;
    }
  };
  try {
    return { db: open(), recoveredFrom: null };
  } catch (error) {
    if (databasePath === ':memory:' || !UNREADABLE_DATABASE_CODES.has(Number(error?.errcode) & 0xff)) throw error;
    // A file SQLite cannot read used to make every launch fatal. Set it aside
    // under a dated name so the app can start again; the daily backups remain
    // the way to get the history back.
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const asideBase = `${databasePath}.corrupt-${stamp}`;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.renameSync(`${databasePath}${suffix}`, `${asideBase}${suffix}`); } catch { /* No sidecar. */ }
    }
    return { db: open(), recoveredFrom: asideBase };
  }
}

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

  migrate() {
    require('./desktop-estimates.cjs').migrateDesktopEstimates(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        status_detail TEXT,
        last_observation_at TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS quota_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        bucket_id TEXT NOT NULL,
        bucket_name TEXT,
        observed_at TEXT NOT NULL,
        used_percent REAL NOT NULL,
        remaining_percent REAL NOT NULL,
        resets_at TEXT NOT NULL,
        window_minutes INTEGER,
        plan_type TEXT,
        provenance TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(source_id, bucket_id, observed_at),
        FOREIGN KEY(source_id) REFERENCES sources(id)
      );
      -- UNIQUE(source_id, bucket_id, observed_at) already provides this order;
      -- the duplicate index only added write cost.
      DROP INDEX IF EXISTS idx_quota_source_bucket_time;
      CREATE INDEX IF NOT EXISTS idx_quota_source_bucket_reset
        ON quota_observations(source_id, bucket_id, resets_at);
      -- Source-wide reads by time (the forecast candidates and the collector's
      -- existence probes) otherwise sort every row of the source.
      CREATE INDEX IF NOT EXISTS idx_quota_source_time
        ON quota_observations(source_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_quota_observed ON quota_observations(observed_at);
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        session_id TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_5m_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(source_id) REFERENCES sources(id)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(occurred_at);
      DROP INDEX IF EXISTS idx_usage_source_model;
      CREATE INDEX IF NOT EXISTS idx_usage_source_time ON usage_events(source_id, occurred_at);
      CREATE TABLE IF NOT EXISTS account_daily_usage (
        source_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY(source_id, usage_date)
      );
      CREATE TABLE IF NOT EXISTS price_catalog (
        model TEXT PRIMARY KEY,
        input_usd_per_million REAL NOT NULL,
        cache_write_usd_per_million REAL NOT NULL,
        cache_write_1h_usd_per_million REAL NOT NULL DEFAULT 0,
        cache_read_usd_per_million REAL NOT NULL,
        output_usd_per_million REAL NOT NULL,
        effective_from TEXT NOT NULL,
        source_url TEXT
      );
      CREATE TABLE IF NOT EXISTS imported_files (
        file_path TEXT PRIMARY KEY,
        modified_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        database_path TEXT NOT NULL,
        export_path TEXT NOT NULL
      );
    `);
    this.transaction(() => {
    const sourceColumns = new Set(this.prepare('PRAGMA table_info(sources)').all().map((row) => row.name));
    if (!sourceColumns.has('last_attempt_at')) this.db.exec('ALTER TABLE sources ADD COLUMN last_attempt_at TEXT;');
    if (!sourceColumns.has('last_success_at')) this.db.exec('ALTER TABLE sources ADD COLUMN last_success_at TEXT;');
    const usageColumns = new Set(this.prepare('PRAGMA table_info(usage_events)').all().map((row) => row.name));
    const addedCacheBreakdown = !usageColumns.has('cache_write_5m_input_tokens') || !usageColumns.has('cache_write_1h_input_tokens');
    if (!usageColumns.has('cache_write_5m_input_tokens')) this.db.exec('ALTER TABLE usage_events ADD COLUMN cache_write_5m_input_tokens INTEGER NOT NULL DEFAULT 0;');
    if (!usageColumns.has('cache_write_1h_input_tokens')) this.db.exec('ALTER TABLE usage_events ADD COLUMN cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0;');
    if (!usageColumns.has('project')) this.db.exec('ALTER TABLE usage_events ADD COLUMN project TEXT;');
    const importColumns = new Set(this.prepare('PRAGMA table_info(imported_files)').all().map((row) => row.name));
    if (!importColumns.has('state_json')) this.db.exec('ALTER TABLE imported_files ADD COLUMN state_json TEXT;');
    if (!usageColumns.has('project')) {
      // Project attribution is read from the same local transcripts as the
      // token counts. Rescanning them once fills the new column in place.
      this.prepare("DELETE FROM imported_files WHERE lower(file_path) LIKE '%.claude%projects%.jsonl' OR lower(file_path) LIKE '%.codex%sessions%.jsonl'").run();
    }
    for (const [oldKey, newKey] of Object.entries(SETTING_ALIASES)) {
      const legacy = this.prepare('SELECT value_json FROM settings WHERE key = ?').get(oldKey);
      if (!legacy) continue;
      this.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
        .run(newKey, legacy.value_json, iso());
      this.prepare('DELETE FROM settings WHERE key = ?').run(oldKey);
    }
    const priceColumns = new Set(this.prepare('PRAGMA table_info(price_catalog)').all().map((row) => row.name));
    // Existing prices are user-owned; only newly seeded defaults yield to restores.
    if (!priceColumns.has('is_seed')) this.db.exec('ALTER TABLE price_catalog ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0;');
    this.addedOneHourPriceColumn = !priceColumns.has('cache_write_1h_usd_per_million');
    if (!priceColumns.has('cache_write_1h_usd_per_million')) this.db.exec('ALTER TABLE price_catalog ADD COLUMN cache_write_1h_usd_per_million REAL NOT NULL DEFAULT 0;');
    this.migrateAnalyticsRevisions();
    if (addedCacheBreakdown) {
      // Existing Claude transcript events did not retain cache TTL detail. Make
      // the next refresh rebuild them from the local source of truth.
      this.prepare("DELETE FROM imported_files WHERE lower(file_path) LIKE '%.claude%projects%.jsonl'").run();
    }
    const dateMigration = 'migration.quota-date-cleanup-v1';
    if (!this.prepare('SELECT 1 FROM settings WHERE key = ?').get(dateMigration)) {
    this.db.exec(`
      DELETE FROM quota_observations
      WHERE resets_at IS NULL
         OR julianday(resets_at) IS NULL
         OR CAST(strftime('%Y', resets_at) AS INTEGER) < 2020;
      UPDATE OR IGNORE quota_observations
      SET bucket_id = 'seven_day', bucket_name = 'Weekly'
      WHERE source_id = 'claude' AND bucket_id = 'manual-weekly';
      DELETE FROM quota_observations
      WHERE source_id = 'claude' AND bucket_id = 'manual-weekly';
      UPDATE OR IGNORE quota_observations
      SET bucket_id = 'fable_seven_day', bucket_name = 'Fable weekly'
      WHERE source_id = 'claude-fable' AND bucket_id = 'fable-weekly';
      DELETE FROM quota_observations
      WHERE source_id = 'claude-fable' AND bucket_id = 'fable-weekly';
    `);
    this.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)').run(dateMigration, 'true', iso());
    }
    });
    const fablePlanEvidenceMigration = 'migration.fable-plan-evidence-v1';
    if (!this.prepare('SELECT 1 FROM settings WHERE key = ?').get(fablePlanEvidenceMigration)) {
      // Claude's status-line payload has never contained a subscription/seat
      // classification. Earlier builds stamped those rows as Max and could
      // derive a half-pool Fable estimate from that invented fact. Keep the
      // official percentages, remove the false plan claim, and discard only
      // the reproducible derived cache so current evidence can rebuild it.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.prepare("UPDATE quota_observations SET plan_type = NULL WHERE provenance = 'official-statusline'").run();
        this.prepare("DELETE FROM quota_observations WHERE provenance = 'derived-tokens'").run();
        this.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
          .run(fablePlanEvidenceMigration, 'true', iso());
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
        throw error;
      }
    }
    const fableProjectionMigration = 'migration.fable-projection-v1';
    if (!this.prepare('SELECT 1 FROM settings WHERE key = ?').get(fableProjectionMigration)) {
      // The Fable estimate is projected when a snapshot is built and is no
      // longer stored. Rows written by earlier versions were computed under
      // settings and evidence that may since have changed; the projection
      // rebuilds the current figure from official readings alone.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.prepare("DELETE FROM quota_observations WHERE provenance = 'derived-tokens'").run();
        this.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
          .run(fableProjectionMigration, 'true', iso());
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
        throw error;
      }
    }
    const fableNameMigration = 'migration.fable-name-v1';
    if (!this.prepare('SELECT 1 FROM settings WHERE key = ?').get(fableNameMigration)) {
      // Fable 5 and Fable 5.1 share one allowance, which Claude reports as
      // "Fable". Earlier versions named the source and its bucket after Fable 5.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.prepare("UPDATE sources SET name = 'Fable' WHERE id = 'claude-fable' AND name = 'Fable 5'").run();
        this.prepare("UPDATE quota_observations SET bucket_name = ? WHERE source_id = 'claude-fable' AND bucket_name = ?")
          .run(FABLE_BUCKET_NAME, LEGACY_FABLE_BUCKET_NAME);
        this.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
          .run(fableNameMigration, 'true', iso());
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
        throw error;
      }
    }
    this.canonicaliseCodexManualRows();
  }

  migrateAnalyticsRevisions() {
    // These revisions belong to the same SQLite transaction as their data.
    // They see collector-process writes and direct SQL, and roll back with
    // aborted imports. Status, cursor, backup and preference writes do not
    // invalidate unchanged ledger totals or cycle history.
    this.db.exec(`CREATE TABLE IF NOT EXISTS analytics_revisions (
      domain TEXT NOT NULL, source_id TEXT NOT NULL, bucket_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY(domain, source_id, bucket_id)
    ) WITHOUT ROWID;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS analytics_day_revisions(day TEXT PRIMARY KEY, revision INTEGER NOT NULL) WITHOUT ROWID;`);
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = action === 'UPDATE' ? ['OLD', 'NEW'] : [action === 'INSERT' ? 'NEW' : 'OLD'];
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS analytics_day_${action.toLowerCase()} AFTER ${action} ON usage_events BEGIN
        ${refs.map((ref) => `INSERT INTO analytics_day_revisions(day, revision) VALUES (substr(${ref}.occurred_at, 1, 10), 1)
          ON CONFLICT(day) DO UPDATE SET revision = revision + 1;`).join('\n')}
      END;`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS quota_compaction_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), through_at TEXT, dirty_at TEXT
    );
    INSERT OR IGNORE INTO quota_compaction_state(id, dirty_at) SELECT 1, MIN(observed_at) FROM quota_observations;
    CREATE TRIGGER IF NOT EXISTS compaction_insert AFTER INSERT ON quota_observations BEGIN
      UPDATE quota_compaction_state SET dirty_at = MIN(COALESCE(dirty_at, NEW.observed_at), NEW.observed_at) WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS compaction_update AFTER UPDATE ON quota_observations BEGIN
      UPDATE quota_compaction_state SET dirty_at = MIN(COALESCE(dirty_at, NEW.observed_at), NEW.observed_at, OLD.observed_at) WHERE id = 1;
    END;`);
    for (const [table, domain, scope] of [
      ['usage_events', 'usage', ['source_id']],
      ['quota_observations', 'quota', ['source_id', 'bucket_id']],
      ['price_catalog', 'price', []],
    ]) {
      const bump = (reference, condition = null) => {
        const source = scope.includes('source_id') ? `${reference}.source_id` : "''";
        const bucket = scope.includes('bucket_id') ? `${reference}.bucket_id` : "''";
        const values = `'${domain}', ${source}, ${bucket}, 1`;
        return `INSERT INTO analytics_revisions(domain, source_id, bucket_id, revision)
          ${condition ? `SELECT ${values} WHERE ${condition}` : `VALUES (${values})`}
          ON CONFLICT(domain, source_id, bucket_id) DO UPDATE SET revision = revision + 1;`;
      };
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const writes = [bump(action === 'INSERT' ? 'NEW' : 'OLD')];
        if (action === 'UPDATE' && scope.length) {
          writes.push(bump('NEW', scope.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')));
        }
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS analytics_${table}_${action.toLowerCase()}
          AFTER ${action} ON ${table} BEGIN ${writes.join('\n')} END;`);
      }
    }
  }

  canonicaliseCodexManualRows() {
    const official = this.prepare(`
      SELECT bucket_id FROM quota_observations
      WHERE source_id = 'codex' AND bucket_id NOT IN ('manual-weekly', 'codex:weekly')
        AND COALESCE(window_minutes, 0) >= 10000
        AND json_valid(metadata_json) AND json_extract(metadata_json, '$.limitId') = 'codex'
      ORDER BY observed_at DESC, bucket_id ASC LIMIT 1
    `).get();
    const target = official?.bucket_id || 'codex:weekly';
    this.prepare(`UPDATE OR IGNORE quota_observations SET bucket_id = ?
      WHERE source_id = 'codex' AND bucket_id = 'manual-weekly'`).run(target);
    this.prepare(`DELETE FROM quota_observations
      WHERE source_id = 'codex' AND bucket_id = 'manual-weekly'`).run();
  }

  seed() {
    const insertSource = this.prepare(`
      INSERT INTO sources(id, name, kind, status, metadata_json)
      VALUES (?, ?, ?, 'pending', '{}')
      ON CONFLICT(id) DO NOTHING
    `);
    for (const row of SOURCE_DEFINITIONS) insertSource.run(...row);

    const insertSetting = this.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, JSON.stringify(value), iso());
    }

    const insertPrice = this.prepare(`
      INSERT INTO price_catalog(
        model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url, is_seed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(model) DO NOTHING
    `);
    for (const row of PRICE_ROWS) {
      const astra = row[0] === 'gpt-6-astra';
      const newGpt6 = row[0] === 'gpt-6-sol' || row[0] === 'gpt-6-luna';
      const claudeEffective = { 'claude-fable-5-1': '2026-09-01', 'claude-opus-5-5': '2026-09-22' }[row[0]];
      const source = astra || newGpt6
        ? `https://developers.openai.com/api/docs/models/${row[0]}`
        : row[0].startsWith('claude')
        ? 'https://platform.claude.com/docs/en/about-claude/pricing'
        : 'https://developers.openai.com/api/docs/models/compare';
      insertPrice.run(...row, claudeEffective ?? (newGpt6 ? '2026-09-22' : astra ? '2026-09-04' : '2026-08-01'), source);
    }
    // Repair only the obsolete built-in Sonnet row. User-edited rows do not
    // match this complete old vector and are left alone.
    this.prepare(`UPDATE price_catalog SET input_usd_per_million = 2,
      cache_write_usd_per_million = 2.5, cache_write_1h_usd_per_million = 4,
      cache_read_usd_per_million = 0.2, output_usd_per_million = 10,
      effective_from = '2026-08-01'
      WHERE model = 'claude-sonnet-5' AND input_usd_per_million = 3
        AND cache_write_usd_per_million = 3.75 AND cache_read_usd_per_million = 0.3
        AND output_usd_per_million = 15`).run();
    if (this.addedOneHourPriceColumn) {
      const setOneHour = this.prepare(`UPDATE price_catalog
        SET cache_write_1h_usd_per_million = ?
        WHERE model = ? AND cache_write_1h_usd_per_million = 0`);
      for (const [model, , , oneHour] of PRICE_ROWS) setOneHour.run(oneHour, model);
    }
    this.repairSettings();
  }

  repairSettings() {
    const update = this.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?');
    const repaired = { ...DEFAULT_SETTINGS };
    for (const row of this.prepare('SELECT key, value_json FROM settings').all()) {
      const validate = settingValidator(row.key);
      if (!validate) continue;
      const stored = json(row.value_json, undefined);
      const value = row.key === 'allowanceChanges' && Array.isArray(stored)
        ? stored.filter((entry) => isAllowanceChange(entry, Infinity)).slice(-24) : stored;
      if (row.key === 'allowanceChanges' ? isAllowanceChangeList(value, Infinity) : validate(value)) {
        repaired[row.key] = normalizedSetting(row.key, value);
        if (JSON.stringify(repaired[row.key]) !== JSON.stringify(stored)) {
          update.run(JSON.stringify(repaired[row.key]), iso(), row.key);
        }
      }
      else update.run(JSON.stringify(DEFAULT_SETTINGS[row.key]), iso(), row.key);
    }
    if (repaired.activeStartHour >= repaired.activeEndHour) {
      update.run(JSON.stringify(DEFAULT_SETTINGS.activeStartHour), iso(), 'activeStartHour');
      update.run(JSON.stringify(DEFAULT_SETTINGS.activeEndHour), iso(), 'activeEndHour');
    }
    // USD is the canonical currency of the ledger. A stale GBP/EUR conversion
    // rate paired with the USD label would make every displayed total wrong.
    if (repaired.currency === 'USD' && repaired.usdToCurrency !== 1) {
      update.run(JSON.stringify(1), iso(), 'usdToCurrency');
    }
    const currencyRates = { ...repaired.currencyRates, USD: 1,
      [repaired.currency]: repaired.currency === 'USD' ? 1 : repaired.usdToCurrency };
    this.prepare('INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('currencyRates', JSON.stringify(currencyRates), iso());
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

  getSettings() {
    const result = { ...DEFAULT_SETTINGS };
    for (const row of this.prepare('SELECT key, value_json FROM settings').all()) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, row.key)) continue;
      result[row.key] = json(row.value_json, result[row.key]);
    }
    return result;
  }

  updateSettings(patch) {
    const statement = this.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    const current = this.getSettings();
    const normalizedPatch = { ...patch };
    const candidateCurrency = normalizedPatch.currency ?? current.currency;
    if (candidateCurrency === 'USD') {
      if (Object.hasOwn(normalizedPatch, 'usdToCurrency') && normalizedPatch.usdToCurrency !== 1) {
        throw new Error('USD conversion rate must be 1.');
      }
      // Selecting USD is one coherent setting change, not a currency label
      // followed by a separate rate edit the caller might forget to make.
      normalizedPatch.usdToCurrency = 1;
    }
    else if (candidateCurrency !== current.currency && !Object.hasOwn(normalizedPatch, 'usdToCurrency')) {
      const savedRate = current.currencyRates?.[candidateCurrency];
      if (!savedRate) throw new Error(`Enter a USD to ${candidateCurrency} conversion rate.`);
      normalizedPatch.usdToCurrency = savedRate;
    }
    if (Object.hasOwn(normalizedPatch, 'currency') || Object.hasOwn(normalizedPatch, 'usdToCurrency')) {
      normalizedPatch.currencyRates = { ...current.currencyRates, ...normalizedPatch.currencyRates,
        [current.currency]: current.usdToCurrency,
        [candidateCurrency]: normalizedPatch.usdToCurrency ?? current.usdToCurrency, USD: 1 };
    }
    const candidate = { ...current, ...normalizedPatch };
    if (candidate.activeStartHour >= candidate.activeEndHour) {
      throw new Error('Active day end must be later than its start.');
    }
    // Validate the complete patch before writing any part of it, so a rejected
    // cross-field update cannot leave settings half changed.
    for (const [key, value] of Object.entries(normalizedPatch)) {
      const validate = settingValidator(key);
      if (!validate) throw new Error(`Unknown setting: ${key}`);
      if (!validate(value)) throw new Error(`Invalid value for ${key}.`);
    }
    // One transaction: a disk error part-way through cannot leave a validated
    // patch half applied, and one fsync covers every key.
    this.transaction(() => {
      for (const [key, value] of Object.entries(normalizedPatch)) {
        statement.run(key, JSON.stringify(normalizedSetting(key, value)), iso());
      }
    });
    return this.getSettings();
  }

  // Omitting metadata keeps whatever the source already had. A failure path
  // reporting only a status must not erase facts it never gathered — the
  // Enable/Disable helper control reads one of them.
  setSourceStatus(id, status, detail, metadata, options = {}) {
    if (!KNOWN_SOURCE_IDS.has(id)) throw new Error(`Unknown source: ${id || 'missing'}.`);
    if (typeof status !== 'string' || !status.trim()) throw new Error('Source status is required.');
    const attemptedAt = iso();
    // The display status is not a reliable proxy for scan success: a provider
    // can be stale while a cached allowance remains visible, and a current
    // official limit can be retained despite an optional-history warning.
    const scanSucceeded = options.scanSucceeded
      ?? !['error', 'stale', 'degraded'].includes(status);
    const successfulAt = scanSucceeded ? attemptedAt : null;
    if (metadata === undefined) {
      this.prepare(`UPDATE sources SET status = ?, status_detail = ?,
        last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at)
        WHERE id = ?`)
        .run(status, detail || null, attemptedAt, successfulAt, id);
      return;
    }
    this.prepare(`
      UPDATE sources
      SET status = ?, status_detail = ?, metadata_json = ?,
        last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at)
      WHERE id = ?
    `).run(status, detail || null, JSON.stringify(metadata), attemptedAt, successfulAt, id);
  }

  recordObservation(observation) {
    if (!KNOWN_SOURCE_IDS.has(observation.sourceId)) throw new Error(`Unknown source: ${observation.sourceId || 'missing'}.`);
    if (typeof observation.bucketId !== 'string' || !observation.bucketId.trim()) {
      throw new Error('Observation bucket is required.');
    }
    const bucketName = optionalText(observation.bucketName, 'Observation bucket name');
    const planType = optionalText(observation.planType, 'Observation plan type');
    // The Fable estimate is a projection built with each snapshot; a stored
    // copy would outlive the settings and evidence it was computed from.
    if (observation.provenance === 'derived-tokens') throw new Error('Derived Fable estimates are projected, not stored.');
    const provenance = optionalText(observation.provenance, 'Observation provenance');
    let windowMinutes = null;
    if (observation.windowMinutes != null) {
      if (!['number', 'string'].includes(typeof observation.windowMinutes)) {
        throw new Error('Observation window must be a number.');
      }
      windowMinutes = Number(observation.windowMinutes);
      if (!Number.isSafeInteger(windowMinutes) || windowMinutes < 0 || windowMinutes > 31 * 24 * 60) {
        throw new Error('Observation window must be a non-negative whole number no longer than 31 days.');
      }
    }
    const confidence = Number(observation.confidence ?? 1);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Observation confidence must be between 0 and 1.');
    }
    const observedAt = validIso(observation.observedAt || Date.now(), 'Observation time');
    if (new Date(observedAt).getTime() > Date.now() + QUOTA_CLOCK_SKEW_MS) {
      throw new Error('Observation time must not be more than five minutes in the future.');
    }
    const resetsAt = validIso(observation.resetsAt, 'Reset time');
    const resetDistanceMs = new Date(resetsAt).getTime() - new Date(observedAt).getTime();
    if (resetDistanceMs < -5 * 60_000) {
      throw new Error('Reset time must not be earlier than the observation.');
    }
    if (resetDistanceMs > MAX_QUOTA_RESET_AHEAD_MS) {
      throw new Error('Reset time must not be more than 31 days after the observation.');
    }
    const usedPercent = Number(observation.usedPercent);
    const remainingPercent = Number(observation.remainingPercent ?? 100 - usedPercent);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      throw new Error('Usage percentage must be between 0 and 100.');
    }
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
      throw new Error('Remaining percentage must be between 0 and 100.');
    }
    if (Math.abs(usedPercent + remainingPercent - 100) > 0.1) {
      throw new Error('Usage and remaining percentages must sum to 100.');
    }
    if (observation.sourceId === 'codex' && observation.bucketId !== 'codex:weekly'
      && Number(observation.windowMinutes || 0) >= 10_000
      && observation.metadata?.limitId === 'codex'
      && observation.provenance !== 'manual-official') {
      this.prepare(`UPDATE OR IGNORE quota_observations SET bucket_id = ?
        WHERE source_id = 'codex' AND bucket_id IN ('manual-weekly', 'codex:weekly')`).run(observation.bucketId);
      this.prepare(`DELETE FROM quota_observations
        WHERE source_id = 'codex' AND bucket_id IN ('manual-weekly', 'codex:weekly')`).run();
    }
    // Values and provenance describe one reading and must be replaced together.
    // A generated estimate cannot displace a same-time official anchor.
    this.prepare(`
      INSERT INTO quota_observations(
        source_id, bucket_id, bucket_name, observed_at, used_percent, remaining_percent,
        resets_at, window_minutes, plan_type, provenance, confidence, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, bucket_id, observed_at) DO UPDATE SET
        bucket_name = excluded.bucket_name,
        used_percent = excluded.used_percent,
        remaining_percent = excluded.remaining_percent,
        resets_at = excluded.resets_at,
        window_minutes = excluded.window_minutes,
        plan_type = excluded.plan_type,
        provenance = excluded.provenance,
        confidence = excluded.confidence,
        metadata_json = excluded.metadata_json
    `).run(
      observation.sourceId,
      observation.bucketId,
      bucketName,
      observedAt,
      usedPercent,
      remainingPercent,
      resetsAt,
      windowMinutes || null,
      planType,
      provenance || 'official',
      confidence,
      JSON.stringify(observation.metadata || {}),
    );
    this.prepare(`UPDATE sources SET last_observation_at = ?
      WHERE id = ? AND (last_observation_at IS NULL OR last_observation_at < ?)`)
      .run(observedAt, observation.sourceId, observedAt);
  }

  recordUsageEvent(event) {
    if (!KNOWN_SOURCE_IDS.has(event.sourceId)) throw new Error(`Unknown source: ${event.sourceId || 'missing'}.`);
    if (typeof event.eventKey !== 'string' || !event.eventKey.trim()) throw new Error('Usage event key is required.');
    // Malformed JSON fields are rejected before SQLite binding. Coded SQLite
    // errors remain operational failures that must roll back the file cursor.
    const sessionId = optionalText(event.sessionId, 'Usage event session ID');
    const model = optionalText(event.model, 'Usage event model');
    const occurredAt = validIso(event.occurredAt, 'Event time');
    const token = (value) => {
      if (value == null) return 0;
      if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) {
        throw new Error('Usage event token counts must be non-negative whole numbers.');
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error('Usage event token counts must be non-negative whole numbers.');
      }
      return parsed;
    };
    const inputTokens = token(event.inputTokens);
    const cachedInputTokens = token(event.cachedInputTokens);
    const cacheWrite1hInputTokens = token(event.cacheWrite1hInputTokens);
    const cacheWriteInputTokens = token(event.cacheWriteInputTokens ?? token(event.cacheWrite5mInputTokens) + cacheWrite1hInputTokens);
    let cacheWrite5mInputTokens = token(event.cacheWrite5mInputTokens ?? Math.max(0, cacheWriteInputTokens - cacheWrite1hInputTokens));
    // Legacy rows explicitly stored zero in both duration fields. Preserve
    // their documented five-minute fallback while rejecting conflicting splits.
    if (cacheWrite5mInputTokens + cacheWrite1hInputTokens === 0) cacheWrite5mInputTokens = cacheWriteInputTokens;
    const outputTokens = token(event.outputTokens);
    const reasoningOutputTokens = token(event.reasoningOutputTokens);
    if (event.sourceId === 'codex' && cachedInputTokens > inputTokens) {
      throw new Error('Codex cached input tokens must be a subset of input tokens.');
    }
    if (cacheWrite5mInputTokens + cacheWrite1hInputTokens !== cacheWriteInputTokens) {
      throw new Error('Cache write durations must sum to the total cache write tokens.');
    }
    if (reasoningOutputTokens > outputTokens) {
      throw new Error('Usage event reasoning tokens must be a subset of output tokens.');
    }
    const reportedCostUsd = event.reportedCostUsd == null ? null : Number(event.reportedCostUsd);
    if (reportedCostUsd != null && (!Number.isFinite(reportedCostUsd) || reportedCostUsd < 0)) {
      throw new Error('Usage event reported cost must be zero or greater.');
    }
    const project = typeof event.project === 'string' && event.project.trim() ? event.project.trim() : null;
    const result = this.prepare(`
      INSERT INTO usage_events(
        event_key, source_id, occurred_at, session_id, model, project, input_tokens,
        cached_input_tokens, cache_write_input_tokens, cache_write_5m_input_tokens,
        cache_write_1h_input_tokens, output_tokens,
        reasoning_output_tokens, reported_cost_usd, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        occurred_at = excluded.occurred_at,
        session_id = excluded.session_id,
        model = excluded.model,
        project = COALESCE(excluded.project, usage_events.project),
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_input_tokens = excluded.cache_write_input_tokens,
        cache_write_5m_input_tokens = excluded.cache_write_5m_input_tokens,
        cache_write_1h_input_tokens = excluded.cache_write_1h_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        reported_cost_usd = excluded.reported_cost_usd,
        metadata_json = excluded.metadata_json
    `).run(
      event.eventKey,
      event.sourceId,
      occurredAt,
      sessionId,
      model,
      project,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      cacheWrite5mInputTokens,
      cacheWrite1hInputTokens,
      outputTokens,
      reasoningOutputTokens,
      reportedCostUsd,
      JSON.stringify(event.metadata || {}),
    );
    return result.changes;
  }

  getManualBucketId(sourceId) {
    if (sourceId === 'claude') return 'seven_day';
    if (sourceId === 'claude-fable') return 'fable_seven_day';
    if (sourceId !== 'codex') return 'manual-weekly';
    const row = this.prepare(`SELECT bucket_id FROM quota_observations
      WHERE source_id = 'codex' AND COALESCE(window_minutes, 0) >= 10000
        AND bucket_id NOT IN ('manual-weekly', 'codex:weekly')
        AND json_valid(metadata_json) AND json_extract(metadata_json, '$.limitId') = 'codex'
      ORDER BY observed_at DESC, bucket_id ASC LIMIT 1`).get();
    return row?.bucket_id || 'codex:weekly';
  }

  upsertDailyUsage(sourceId, usageDate, tokens) {
    if (!KNOWN_SOURCE_IDS.has(sourceId) || !isForecastDate(usageDate) || !Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error('Invalid daily usage date or token count.');
    }
    this.prepare(`
      INSERT INTO account_daily_usage(source_id, usage_date, tokens) VALUES (?, ?, ?)
      ON CONFLICT(source_id, usage_date) DO UPDATE SET tokens = excluded.tokens
    `).run(sourceId, usageDate, tokens);
  }

  // `size_bytes` is the byte cursor: how much of the file has been consumed.
  // `state` carries whatever an incremental reader needs to resume mid-file
  // (the Codex reader's current model, for instance), so a growing transcript
  // is parsed once, not once per refresh.
  getImportedFile(filePath) {
    const row = this.prepare('SELECT * FROM imported_files WHERE file_path = ?').get(filePath);
    if (!row) return null;
    return { ...row, state: json(row.state_json, null) };
  }

  markImportedFile(filePath, modifiedMs, sizeBytes, state = null) {
    this.prepare(`
      INSERT INTO imported_files(file_path, modified_ms, size_bytes, imported_at, state_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        modified_ms = excluded.modified_ms,
        size_bytes = excluded.size_bytes,
        imported_at = excluded.imported_at,
        state_json = excluded.state_json
    `).run(filePath, modifiedMs, sizeBytes, iso(), state == null ? null : JSON.stringify(state));
  }

  forgetImportedFile(filePath) {
    this.prepare('DELETE FROM imported_files WHERE file_path = ?').run(filePath);
  }

  // Forecasting reads a bounded window of recent polls, plus each bucket's
  // latest row so a dormant bucket still surfaces as expired rather than
  // vanishing. The full history stays in the table for cycle history and
  // backups; it is simply not re-forecast on every snapshot.
  // `tokenCapacity: false` skips the capacity estimate, which only the
  // dashboard shows; the tray and notifications never read it.
  getQuota(sourceId, settings = this.getSettings(), nowMs = Date.now(), { tokenCapacity = true } = {}) {
    const latestAllowed = iso(nowMs + QUOTA_CLOCK_SKEW_MS);
    const oldestRecent = iso(nowMs - FORECAST_LOOKBACK_MS);
    // Capture revisions before reading rows: a concurrent collector commit can
    // invalidate this result, but can never label old rows with a new revision.
    const quotaRevision = this.prepare("SELECT COALESCE(SUM(revision), 0) AS value FROM analytics_revisions WHERE domain = 'quota' AND source_id = ?").get(sourceId).value;
    const usable = (row) => {
      const parsed = normaliseObservation(row);
      return validQuotaTime(parsed.observedAt, parsed.resetsAt, row.window_minutes, nowMs);
    };
    const batch = Math.floor(nowMs / 900_000) * 900_000;
    const cached = !this.db.isTransaction ? this.quotaRowsCache.get(sourceId) : null;
    let candidates;
    if (cached?.revision === quotaRevision && cached.batch === batch) {
      candidates = cached.rows;
    } else {
      candidates = this.prepare(`
        SELECT * FROM quota_observations WHERE source_id = ? AND observed_at >= ? AND observed_at <= ?
        UNION
        SELECT q.* FROM (SELECT DISTINCT bucket_id FROM quota_observations WHERE source_id = ?) buckets
        JOIN quota_observations q ON q.id = (
          SELECT id FROM quota_observations WHERE source_id = ? AND bucket_id = buckets.bucket_id AND observed_at <= ?
          ORDER BY observed_at DESC, id DESC LIMIT 1)
        ORDER BY observed_at, id
      `).all(sourceId, iso(batch - FORECAST_LOOKBACK_MS), iso(batch + 900_000 + QUOTA_CLOCK_SKEW_MS),
        sourceId, sourceId, latestAllowed).map(prepareObservation);
      if (!this.db.isTransaction) this.quotaRowsCache.set(sourceId, { rows: candidates, revision: quotaRevision, batch });
    }
    // Recheck persisted rows before selecting current card data or forecasting.
    // Older app versions could store dates and windows now rejected on ingest.
    const rows = candidates.filter(usable);
    const presentBuckets = new Set(rows.map((row) => row.bucket_id));
    const missingBuckets = new Set(candidates.filter((row) => !presentBuckets.has(row.bucket_id)).map((row) => row.bucket_id));
    for (const bucketId of missingBuckets) {
      // A malformed latest row must not hide valid dormant history. Only these
      // buckets need an indexed, lazy search beyond the usual learning horizon.
      for (const row of this.prepare(`
        SELECT * FROM quota_observations
        WHERE source_id = ? AND bucket_id = ? AND observed_at < ?
        ORDER BY observed_at DESC, id DESC
      `).iterate(sourceId, bucketId, oldestRecent)) {
        if (usable(row)) { rows.push(row); break; }
      }
    }
    // Fable may have no stored rows and still have a projected estimate.
    if (!rows.length && sourceId !== 'claude-fable') return null;

    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.bucket_id)) grouped.set(row.bucket_id, []);
      grouped.get(row.bucket_id).push(row);
    }
    // A stale status-line restatement must not become the card's current
    // balance, a forecast reading or a token-capacity interval.
    const restatementOptions = { nowMs, freshReadGraceMs: freshReadGraceFor(settings) };
    for (const [bucketId, bucketRows] of grouped) {
      grouped.set(bucketId, withoutStaleRestatements(bucketRows, restatementOptions));
    }
    const schedule = {
      activeDays: settings.activeDays,
      startHour: settings.activeStartHour,
      endHour: settings.activeEndHour,
    };
    const forecastOptions = {
      now: nowMs,
      schedule,
      fallbackRate: settings.forecastFallbackRate,
      paceRiskThreshold: settings.paceRiskThreshold,
      hardLimitThreshold: settings.hardLimitThreshold,
      reservePercent: settings.reservePercent,
      excludedDates: settings.forecastExcludedDates,
      allowanceChanges: settings.allowanceChanges,
      freshReadGraceMs: restatementOptions.freshReadGraceMs,
      sourceId,
    };
    let windows = [...grouped.entries()].map(([bucketId, observations]) => {
      const latest = observations.at(-1);
      // Old backups may already have persisted invalid metadata; keep the
      // reading usable without rewriting the original historical evidence.
      const metadata = quotaMetadata(latest.metadata_json) || {};
      return {
        bucketId,
        bucketName: sourceId === 'codex'
          ? codexQuotaLabel(latest.bucket_name || bucketId, latest.window_minutes, metadata)
          : sourceId === 'claude-fable' && latest.bucket_name === LEGACY_FABLE_BUCKET_NAME
            ? FABLE_BUCKET_NAME
            : latest.bucket_name || bucketId,
        observedAt: latest.observed_at,
        usedPercent: latest.used_percent,
        remainingPercent: latest.remaining_percent,
        resetsAt: latest.resets_at,
        windowMinutes: latest.window_minutes,
        planType: latest.plan_type,
        provenance: latest.provenance,
        metadata,
      };
    });
    // Decide replacement from every window before omitting any forecast: a
    // live provider window in an alternate Fable bucket can prevent projection.
    const projected = sourceId === 'claude-fable'
      ? this.projectedFableWindow(windows, grouped.get(FABLE_BUCKET) || [], settings, forecastOptions, nowMs, tokenCapacity)
      : null;
    windows = windows.filter((window) => !projected || window.bucketId !== FABLE_BUCKET).map((window) => ({
      ...window,
      forecast: this.learnedForecast(sourceId, window.bucketId, grouped.get(window.bucketId), forecastOptions, quotaRevision),
      tokenCapacity: tokenCapacity && Number(window.windowMinutes) === 10_080
        ? this.getTokenCapacity(sourceId, window.bucketId, grouped.get(window.bucketId), settings, nowMs, quotaRevision)
        : null,
    }));
    if (projected) windows.push(projected);
    if (!windows.length) return null;
    // The shared rule orders the windows and names the headline, so the tray,
    // notifications, cycle history and cards follow the same window as the
    // top-level fields here even when every window was recorded in one scan.
    const selection = selectDisplayedWindows(windows, { nowMs });
    return { ...selection.primary, windows: [...selection.active, ...selection.expired] };
  }

  learnedForecast(sourceId, bucketId, observations, options, revision) {
    const { now, ...modelOptions } = options;
    const key = JSON.stringify([sourceId, bucketId, modelOptions,
      (options.allowanceChanges || []).filter((change) => Date.parse(change.at) <= now).length]);
    let cached = !this.db.isTransaction ? this.forecastModelCache.get(key) : null;
    if (!cached || cached.revision !== revision) {
      cached = { revision, models: new Map() };
      if (!this.db.isTransaction) {
        this.forecastModelCache.set(key, cached);
        if (this.forecastModelCache.size > 64) this.forecastModelCache.delete(this.forecastModelCache.keys().next().value);
      }
    }
    return forecastQuota(observations, { ...options, learningCache: cached.models, compactReadings: true });
  }

  // The Fable estimate as a window: built from the projection when no
  // provider-backed Fable window is live, never stored. The forecast learns
  // from the official rows plus the projection's own series, in the same row
  // shape, so a helper-only machine keeps a learned pace without persisting
  // estimates that would outlive the settings they were computed under.
  projectedFableWindow(windows, bucketRows, settings, forecastOptions, nowMs, includeTokenCapacity = true) {
    const current = selectDisplayedWindows(windows, { nowMs }).primary;
    if (current && Date.parse(current.resetsAt) > nowMs && isOfficialWindow(current)) return null;
    const projection = this.getFableProjection(settings, nowMs);
    if (!projection.available) return null;
    const point = (entry) => ({
      source_id: 'claude-fable', bucket_id: FABLE_BUCKET, bucket_name: FABLE_BUCKET_NAME,
      observed_at: entry.observedAt, used_percent: entry.usedPercent, remaining_percent: 100 - entry.usedPercent,
      resets_at: projection.resetsAt, window_minutes: projection.windowMinutes, plan_type: projection.planType,
      provenance: 'derived-tokens', confidence: projection.confidence, metadata_json: '{}',
      // Already expressed in the current allowance by the projection.
      allowance_scaled: true,
    });
    const forecast = forecastQuota([...bucketRows, ...projection.series.map(point)], forecastOptions);
    return {
      bucketId: FABLE_BUCKET,
      bucketName: FABLE_BUCKET_NAME,
      observedAt: iso(nowMs),
      usedPercent: projection.usedPercent,
      remainingPercent: 100 - projection.usedPercent,
      resetsAt: projection.resetsAt,
      windowMinutes: projection.windowMinutes,
      planType: projection.planType,
      provenance: 'derived-tokens',
      metadata: { sharedWithOverall: true, projected: true, calibration: projection.calibration },
      forecast,
      tokenCapacity: includeTokenCapacity ? this.getTokenCapacity('claude-fable', FABLE_BUCKET, bucketRows, settings, nowMs) : null,
    };
  }

  // Cached like token capacity: the inputs are Claude and Fable readings,
  // Claude usage and the allowance-change setting, all of which bump a
  // revision or change the key. The tail grows with wall time, so a value is
  // good for a minute and never past the window reset or a pending change.
  getFableProjection(settings, nowMs) {
    const projectionOptions = { freshReadGraceMs: freshReadGraceFor(settings) };
    if (this.db.isTransaction) return projectFableAllowance(this, nowMs, projectionOptions);
    const revision = this.prepare(`SELECT COALESCE(SUM(revision), 0) AS value FROM analytics_revisions
      WHERE (domain = 'quota' AND source_id IN ('claude', 'claude-fable')) OR (domain = 'usage' AND source_id = 'claude')`).get().value;
    const allowanceChanges = settings.allowanceChanges || [];
    const key = JSON.stringify([allowanceChanges, projectionOptions.freshReadGraceMs]);
    const cached = this.fableProjectionCache;
    if (cached && cached.revision === revision && cached.key === key && nowMs >= cached.evaluatedAt && nowMs < cached.expiresAt) return cached.value;
    const value = projectFableAllowance(this, nowMs, projectionOptions);
    let expiresAt = nowMs + 60_000;
    if (value.available) expiresAt = Math.min(expiresAt, Date.parse(value.resetsAt));
    for (const change of allowanceChanges) {
      const at = Date.parse(change.at);
      if (at > nowMs) expiresAt = Math.min(expiresAt, at);
    }
    // A future-dated event or reading is already in the revision but not yet
    // in the projection; it enters at its own timestamp without a write.
    const now = iso(nowMs);
    for (const row of [
      this.prepare("SELECT occurred_at AS at FROM usage_events WHERE source_id = 'claude' AND occurred_at > ? ORDER BY occurred_at ASC LIMIT 1").get(now),
      this.prepare("SELECT observed_at AS at FROM quota_observations WHERE source_id IN ('claude', 'claude-fable') AND observed_at > ? ORDER BY observed_at ASC LIMIT 1").get(now),
    ]) {
      const at = row ? Date.parse(row.at) : Number.NaN;
      if (Number.isFinite(at) && at > nowMs) expiresAt = Math.min(expiresAt, at);
    }
    this.fableProjectionCache = { value, revision, key, evaluatedAt: nowMs, expiresAt };
    return value;
  }

  // Collector status text only needs to know whether a source has a usable
  // reading at all and, with `activeWithinMs`, whether one is still running
  // and was taken recently. getQuota answers that too, but forecasts every
  // window of the source on the way past; this is an indexed probe that
  // walks newest-first and stops at the first usable row, or at the first
  // row older than the freshness bound, since everything after it is older.
  // For active windows, only each bucket's latest usable reading counts:
  // a corrected reset must supersede an older, apparently still-active one.
  hasUsableObservation(sourceId, nowMs = Date.now(), { activeWithinMs = null } = {}) {
    const rows = this.prepare(`SELECT bucket_id, observed_at, resets_at, window_minutes FROM quota_observations
      WHERE source_id = ? AND observed_at <= ? ORDER BY observed_at DESC, id DESC`)
      .iterate(sourceId, iso(nowMs + QUOTA_CLOCK_SKEW_MS));
    const seenBuckets = new Set();
    for (const row of rows) {
      const observedMs = Date.parse(row.observed_at);
      const resetMs = Date.parse(row.resets_at);
      if (!validQuotaTime(observedMs, resetMs, row.window_minutes, nowMs)) continue;
      if (activeWithinMs == null) return true;
      if (nowMs - observedMs >= activeWithinMs) return false;
      if (seenBuckets.has(row.bucket_id)) continue;
      seenBuckets.add(row.bucket_id);
      if (resetMs > nowMs) return true;
    }
    return false;
  }

  tokenCapacityEvidence(sourceId, nowMs) {
    // Claude and Fable share the same local ledger. Read each source's bounded
    // token history once, independent of API prices and the selected Costs period.
    const revision = this.prepare(`SELECT COALESCE(SUM(revision), 0) AS value
      FROM analytics_revisions WHERE domain = 'usage' AND source_id = ?`).get(sourceId).value;
    const cached = !this.db.isTransaction ? this.tokenCapacityEvidenceCache.get(sourceId) : null;
    if (cached && cached.revision === revision && nowMs >= cached.evaluatedAt && nowMs < cached.expiresAt) return cached;
    // The lower bound moves in quarter hours, not with every event ageing out.
    // The estimator applies its own horizon to these rows, so the few minutes
    // of older rows this keeps change no result.
    const since = Math.floor((nowMs - TOKEN_CAPACITY_LOOKBACK_MS) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
    const rows = this.prepare(`SELECT source_id, occurred_at, model,
      input_tokens, cached_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_output_tokens
      FROM usage_events WHERE source_id = ? AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at`).all(sourceId, iso(since), iso(nowMs));
    const next = this.prepare(`SELECT MIN(occurred_at) AS at FROM usage_events
      WHERE source_id = ? AND occurred_at > ?`).get(sourceId, iso(nowMs)).at;
    // Writes bump the usage revision (triggers cover every connection), so the
    // only time-driven changes are the quarter-hour lower bound passing the
    // oldest row and a future-dated row arriving. No wall-clock cap is needed.
    const oldest = rows.length ? Date.parse(rows[0].occurred_at) : Infinity;
    const expiresAt = Math.min(TOKEN_CAPACITY_LOOKBACK_MS + (Math.floor(oldest / QUARTER_HOUR_MS) + 1) * QUARTER_HOUR_MS,
      next ? Date.parse(next) : Infinity);
    const result = { rows, revision, evaluatedAt: nowMs, expiresAt };
    if (!this.db.isTransaction) this.tokenCapacityEvidenceCache.set(sourceId, result);
    return result;
  }

  getTokenCapacity(sourceId, bucketId, observations, settings, nowMs, capturedQuotaRevision = null) {
    const ledgerSource = sourceId === 'claude-fable' ? 'claude' : sourceId;
    const evidence = this.tokenCapacityEvidence(ledgerSource, nowMs);
    const quotaRevision = capturedQuotaRevision ?? this.prepare(`SELECT COALESCE(SUM(revision), 0) AS value
      FROM analytics_revisions WHERE domain = 'quota' AND source_id = ?`).get(sourceId).value;
    const excludedDates = settings.forecastExcludedDates || [];
    const allowanceChanges = settings.allowanceChanges || [];
    const key = JSON.stringify([sourceId, bucketId]);
    // Both learning settings change the estimate without touching a revision.
    // So does the set of readings: a held-back status-line reading is let in
    // once the provider has been silent past the grace, with nothing written.
    const exclusions = JSON.stringify([excludedDates, allowanceChanges, observations.map((row) => row.id ?? row.observed_at)]);
    const cached = !this.db.isTransaction ? this.tokenCapacityCache.get(key) : null;
    if (cached && cached.usageRevision === evidence.revision && cached.quotaRevision === quotaRevision
      && cached.exclusions === exclusions && nowMs >= cached.evaluatedAt && nowMs < cached.expiresAt) return cached.value;

    const value = estimateTokenCapacity({ sourceId, bucketId, observations, events: evidence.rows, nowMs, excludedDates, allowanceChanges });
    let expiresAt = evidence.expiresAt;
    // Clock skew permits a change a few minutes ahead. It starts applying at
    // that instant even when neither observations nor settings are rewritten.
    for (const change of allowanceChanges) {
      const at = Date.parse(change.at);
      if (at > nowMs) expiresAt = Math.min(expiresAt, at);
    }
    // Time can change eligibility without a write: future readings arrive,
    // history leaves the learning horizon, and current allowance expires.
    for (const row of observations) {
      const observed = Date.parse(row.observed_at);
      for (const boundary of [observed, observed + TOKEN_CAPACITY_LOOKBACK_MS + 1, Date.parse(row.resets_at)]) {
        if (Number.isFinite(boundary) && boundary > nowMs) expiresAt = Math.min(expiresAt, boundary);
      }
    }
    if (value.remainingAsOf) {
      expiresAt = Math.min(expiresAt, Date.parse(value.remainingAsOf) + TOKEN_CAPACITY_STALENESS_MS + 1);
    }
    if (!this.db.isTransaction) {
      // Bucket names are provider-controlled; stale buckets need not retain
      // unbounded cached results for the lifetime of the application.
      if (this.tokenCapacityCache.size >= 64 && !this.tokenCapacityCache.has(key)) this.tokenCapacityCache.delete(this.tokenCapacityCache.keys().next().value);
      this.tokenCapacityCache.set(key, { value, usageRevision: evidence.revision, quotaRevision,
        exclusions, evaluatedAt: nowMs, expiresAt });
    }
    return value;
  }

  // Analytics runs resolve the same handful of model names thousands of times.
  // Inside `withPriceCache` every lookup after the first is a Map hit and the
  // catalogue is read once; outside it, each call reads the live table.
  withPriceCache(run) {
    if (this.priceCache) return run();
    this.priceCache = { byModel: new Map(), rows: null };
    try {
      return run();
    } finally {
      this.priceCache = null;
    }
  }

  resolvePrice(model) {
    if (!model) return null;
    const cache = this.priceCache;
    if (cache?.byModel.has(model)) return cache.byModel.get(model);
    const resolved = this.lookupPrice(model, cache);
    if (cache) cache.byModel.set(model, resolved);
    return resolved;
  }

  lookupPrice(model, cache) {
    const direct = this.prepare('SELECT * FROM price_catalog WHERE model = ?').get(model);
    if (direct) return direct;
    const normalized = model.toLowerCase().trim();
    const rows = cache
      ? (cache.rows ??= this.prepare('SELECT * FROM price_catalog').all())
      : this.prepare('SELECT * FROM price_catalog').all();
    const exactInsensitive = rows.find((row) => row.model.toLowerCase() === normalized);
    if (exactInsensitive) return exactInsensitive;
    const candidates = rows
      .filter((row) => {
        const priceModel = row.model.toLowerCase();
        if (!normalized.startsWith(`${priceModel}-`)) return false;
        return VERSION_SUFFIX.test(normalized.slice(priceModel.length + 1));
      })
      .sort((a, b) => b.model.length - a.model.length || a.model.localeCompare(b.model));
    return candidates[0] || null;
  }

  getPriceCatalog() {
    return this.prepare(`
      SELECT model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url
      FROM price_catalog ORDER BY CASE WHEN model LIKE 'claude-%' THEN 2 ELSE 1 END, model
    `).all();
  }

  updatePrice(row) {
    const values = ['inputUsdPerMillion', 'cacheWriteUsdPerMillion', 'cacheWrite1hUsdPerMillion', 'cacheReadUsdPerMillion', 'outputUsdPerMillion']
      .map((key) => Number(row[key]));
    const model = priceModelName(row.model);
    if (!model) throw new Error(`Model name must be plain text of at most ${MAX_PRICE_MODEL_LENGTH} characters.`);
    if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1_000_000)) throw new Error('Every model price must be between zero and one million USD per million tokens.');
    const effectiveFrom = priceEffectiveFrom(row.effectiveFrom);
    if (!effectiveFrom) throw new Error('Effective date must be a calendar date in YYYY-MM-DD form.');
    const sourceUrl = priceSourceUrl(row.sourceUrl);
    if (sourceUrl === undefined) throw new Error('Source must be an http or https web address.');
    this.prepare(`
      INSERT INTO price_catalog(model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        input_usd_per_million = excluded.input_usd_per_million,
        cache_write_usd_per_million = excluded.cache_write_usd_per_million,
        cache_write_1h_usd_per_million = excluded.cache_write_1h_usd_per_million,
        cache_read_usd_per_million = excluded.cache_read_usd_per_million,
        output_usd_per_million = excluded.output_usd_per_million,
        effective_from = excluded.effective_from,
        source_url = excluded.source_url,
        is_seed = 0
    `).run(model, ...values, effectiveFrom, sourceUrl);
    return this.getPriceCatalog();
  }

  calculateCost(row) {
    // This dashboard answers the counterfactual "what would these tokens cost
    // at today's API catalogue?" A legacy/imported reported charge is useful
    // source metadata, but substituting it here would silently mix historical
    // invoices with current-catalogue estimates in the same total.
    const price = this.resolvePrice(row.model);
    if (!price) return { actualUsd: 0, withoutCacheUsd: 0, covered: false, longContext: false };
    const million = 1_000_000;
    // Reasoning tokens are a subset of output_tokens in provider usage schemas.
    const output = Number(row.output_tokens || 0);
    // OpenAI input totals include the cache-read subset. Claude's status-line
    // fields are mutually exclusive categories, so only Codex needs removal.
    const regularInput = row.source_id === 'codex'
      ? Math.max(0, Number(row.input_tokens || 0) - Number(row.cached_input_tokens || 0))
      : Number(row.input_tokens || 0);
    const cacheWriteTotal = Number(row.cache_write_input_tokens || 0);
    let cacheWrite5m = Number(row.cache_write_5m_input_tokens || 0);
    let cacheWrite1h = Number(row.cache_write_1h_input_tokens || 0);
    if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
    // Long-context pricing is a per-request rule. Collectors currently persist
    // each provider message/last_token_usage record as one usage event, so this
    // treats a row as one request. OpenAI input_tokens includes its cached-input
    // subset, and eligibility is based on the full prompt rather than only the
    // uncached portion. If collectors ever write aggregates, they must carry
    // an explicit request-context field instead of applying this rule to totals.
    // Resolve through the catalogue row so dated supported model suffixes inherit
    // the rule, while similarly priced models such as codex-auto-review do not.
    const requestInput = Number(row.input_tokens || 0) + cacheWriteTotal;
    const longContext = OPENAI_LONG_CONTEXT_MODELS.has(price.model)
      && (row.aggregateLongContext ?? requestInput > OPENAI_LONG_CONTEXT_THRESHOLD);
    const inputMultiplier = longContext ? 2 : 1;
    const outputMultiplier = longContext ? 1.5 : 1;
    const actualUsd = (
      regularInput * price.input_usd_per_million * inputMultiplier
      + cacheWrite5m * price.cache_write_usd_per_million * inputMultiplier
      + cacheWrite1h * price.cache_write_1h_usd_per_million * inputMultiplier
      + Number(row.cached_input_tokens || 0) * price.cache_read_usd_per_million * inputMultiplier
      + output * price.output_usd_per_million * outputMultiplier
    ) / million;
    const allInputWithoutCache = row.source_id === 'codex'
      ? Number(row.input_tokens || 0) + cacheWriteTotal
      : Number(row.input_tokens || 0) + cacheWriteTotal + Number(row.cached_input_tokens || 0);
    const withoutCacheUsd = (
      allInputWithoutCache * price.input_usd_per_million * inputMultiplier
      + output * price.output_usd_per_million * outputMultiplier
    ) / million;
    const breakdownUsd = {
      input: regularInput * price.input_usd_per_million * inputMultiplier / million,
      cacheRead: Number(row.cached_input_tokens || 0) * price.cache_read_usd_per_million * inputMultiplier / million,
      cacheWrite5m: cacheWrite5m * price.cache_write_usd_per_million * inputMultiplier / million,
      cacheWrite1h: cacheWrite1h * price.cache_write_1h_usd_per_million * inputMultiplier / million,
      output: output * price.output_usd_per_million * outputMultiplier / million,
    };
    return { actualUsd, withoutCacheUsd, covered: true, longContext, breakdownUsd };
  }

  getCostAnalytics(days = 30, settings = this.getSettings(), nowMs = Date.now()) {
    return this.getAnalytics(days, settings, nowMs).costs;
  }

  analyticsRevision() {
    return this.prepare("SELECT COALESCE(SUM(revision), 0) AS revision FROM analytics_revisions WHERE domain IN ('usage', 'price')")
      .get().revision;
  }

  cycleRevision(sourceId, bucketId) {
    const eventSource = sourceId === 'codex' ? 'codex' : 'claude';
    return this.prepare(`SELECT COALESCE(SUM(revision), 0) AS revision FROM analytics_revisions
      WHERE domain = 'price' OR (domain = 'usage' AND source_id = ?)
        OR (domain = 'quota' AND source_id = ? AND bucket_id = ?)`)
      .get(eventSource, sourceId, bucketId).revision;
  }

  getAnalytics(days, settings, nowMs) {
    // Cache the ledger separately from the time-sensitive forecast snapshot.
    // SQLite tracks both writes on this connection and collector-process commits.
    // Never cache transactional reads: a rollback must not preserve their totals.
    if (this.db.isTransaction) return this.withPriceCache(() => this.buildAnalytics(days, settings, nowMs));
    const revision = this.analyticsRevision();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const key = JSON.stringify([days, settings.currency, settings.usdToCurrency, timeZone]);
    const cached = this.costAnalyticsCache.get(key);
    if (cached && cached.revision === revision && nowMs >= cached.at && nowMs < cached.expiresAt) {
      this.costAnalyticsCache.delete(key);
      this.costAnalyticsCache.set(key, cached);
      return cached.value;
    }
    const nextEvent = this.prepare('SELECT occurred_at FROM usage_events WHERE occurred_at > ? ORDER BY occurred_at ASC LIMIT 1')
      .get(iso(nowMs));
    const value = this.withPriceCache(() => this.buildAnalytics(days, settings, nowMs));
    // The period starts at a local midnight, so it moves only when the day
    // changes; a future-dated record enters at its timestamp. Clock rollback
    // also forces a read.
    const expiresAt = Math.min(periodStart(0, nowMs), nextEvent ? Date.parse(nextEvent.occurred_at) : Infinity);
    this.costAnalyticsCache.delete(key);
    this.costAnalyticsCache.set(key, { at: nowMs, expiresAt, revision, value });
    if (this.costAnalyticsCache.size > 4) this.costAnalyticsCache.delete(this.costAnalyticsCache.keys().next().value);
    return value;
  }

  buildCostAnalytics(days, settings, nowMs) {
    return this.buildAnalytics(days, settings, nowMs).costs;
  }

  // All session aggregates stay in the same bounded, privately held cache as
  // their period's costs. Snapshots expose only eight highlights; paginated
  // requests search the complete ledger without re-costing it for each page.
  getSessionPage({ days = 30, query = '', page = 1, pageSize = 20 } = {}, nowMs = Date.now()) {
    const boundedInteger = (value, fallback, min, max) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
    };
    const period = boundedInteger(days, 30, 1, 365);
    const size = boundedInteger(pageSize, 20, 1, 100);
    const needle = typeof query === 'string' ? query.trim().slice(0, 500).toLowerCase() : '';
    const sessions = this.getAnalytics(period, this.getSettings(), nowMs).sessions;
    const matches = needle ? sessions.filter((row) => [row.sourceId,
      SOURCE_DEFINITIONS.find(([id]) => id === row.sourceId)?.[1], row.project, row.sessionId, row.model]
      .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) : sessions;
    const total = matches.length;
    const totalPages = Math.ceil(total / size);
    const selectedPage = boundedInteger(page, 1, 1, Math.max(1, totalPages));
    return { rows: matches.slice((selectedPage - 1) * size, selectedPage * size), total,
      page: selectedPage, pageSize: size, totalPages };
  }

  getTaskPage({ days = 30, query = '', page = 1, pageSize = 20 } = {}, nowMs = Date.now()) {
    const boundedInteger = (value, fallback, min, max) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
    };
    const period = boundedInteger(days, 30, 1, 365);
    const size = boundedInteger(pageSize, 20, 1, 100);
    const needle = typeof query === 'string' ? query.trim().slice(0, 500).toLowerCase() : '';
    const sessions = this.getAnalytics(period, this.getSettings(), nowMs).tasks;
    const matches = needle ? sessions.filter((row) => [row.sourceId,
      SOURCE_DEFINITIONS.find(([id]) => id === row.sourceId)?.[1], row.project, row.sessionId, row.taskId,
      ...row.agents.flatMap((agent) => [agent.agentId, agent.agentName, agent.agentRole, agent.model])]
      .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) : sessions;
    const total = matches.length;
    const totalPages = Math.ceil(total / size);
    const selectedPage = boundedInteger(page, 1, 1, Math.max(1, totalPages));
    return { rows: matches.slice((selectedPage - 1) * size, selectedPage * size), total,
      page: selectedPage, pageSize: size, totalPages };
  }

  analyticsEvents(since, until) {
    const revisions = new Map(this.prepare('SELECT day, revision FROM analytics_day_revisions WHERE day >= ? AND day <= ?')
      .all(since.slice(0, 10), until.slice(0, 10)).map((row) => [row.day, row.revision]));
    const result = [];
    const start = Date.parse(`${since.slice(0, 10)}T00:00:00.000Z`);
    for (let cursor = start; cursor <= Date.parse(until); cursor += DAY_MS) {
      const day = iso(cursor).slice(0, 10);
      const lower = cursor === start ? since : iso(cursor);
      const upper = iso(Math.min(cursor + DAY_MS - 1, Date.parse(until)));
      const revision = revisions.get(day) ?? 0;
      const cached = !this.db.isTransaction ? this.analyticsDayCache.get(day) : null;
      let rows = cached?.revision === revision && cached.lower === lower && cached.upper === upper ? cached.rows : null;
      if (!rows) {
        // Preserve per-request context tiers and legacy cache durations before
        // aggregation. Task metadata stays distinct so parent/agent attribution
        // cannot merge. Counts remain request counts, not aggregate row counts.
        rows = this.prepare(`SELECT MIN(event_key) AS event_key, source_id, session_id, model, project,
          ${ATTRIBUTION_METADATA} AS metadata_json,
          MIN(occurred_at) AS first_occurred_at, MAX(occurred_at) AS occurred_at, COUNT(*) AS event_count,
          input_tokens + cache_write_input_tokens > ${OPENAI_LONG_CONTEXT_THRESHOLD} AS aggregateLongContext,
          SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(cache_write_input_tokens) AS cache_write_input_tokens,
          SUM(CASE WHEN cache_write_5m_input_tokens + cache_write_1h_input_tokens = 0 THEN cache_write_input_tokens ELSE cache_write_5m_input_tokens END) AS cache_write_5m_input_tokens,
          SUM(cache_write_1h_input_tokens) AS cache_write_1h_input_tokens,
          SUM(output_tokens) AS output_tokens, SUM(reasoning_output_tokens) AS reasoning_output_tokens
          FROM usage_events WHERE occurred_at >= ? AND occurred_at <= ?
          GROUP BY source_id, session_id, CASE WHEN session_id IS NULL OR session_id = '' THEN event_key END,
            model, project, ${ATTRIBUTION_METADATA}, substr(occurred_at, 1, 13), CAST(substr(occurred_at, 15, 2) AS INTEGER) / 15, aggregateLongContext
          ORDER BY first_occurred_at, occurred_at`).all(lower, upper);
        if (!this.db.isTransaction) {
          this.analyticsDayCache.set(day, { revision, lower, upper, rows });
          if (this.analyticsDayCache.size > 367) this.analyticsDayCache.delete(this.analyticsDayCache.keys().next().value);
        }
      }
      // A spread passes every row as an argument, which overflows the call
      // stack once one day holds about 125,000 groups.
      for (const row of rows) result.push(row);
    }
    return result;
  }

  buildAnalytics(days, settings, nowMs) {
    const since = iso(periodStart(days, nowMs));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Aggregate one row at a time instead of retaining the entire raw ledger
    // alongside the model, project, and session summaries.
    const events = this.analyticsEvents(since, iso(nowMs));
    const byModelMap = new Map();
    const unpricedModelsMap = new Map();
    const byDayMap = new Map();
    const byProjectMap = new Map();
    const sessionMap = new Map();
    const taskUsage = new TaskUsage();
    const activityUsd = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const localPartsOf = createLocalPartsLookup(timeZone);
    let actualUsd = 0;
    let withoutCacheUsd = 0;
    let coveredTokens = 0;
    let totalTokens = 0;
    let requestCount = 0;

    for (const event of events) {
      requestCount += event.event_count;
      const cost = this.calculateCost(event);
      const eventTokens = event.source_id === 'codex'
        ? Number(event.input_tokens) + Number(event.cache_write_input_tokens) + Number(event.output_tokens)
        : Number(event.input_tokens) + Number(event.cached_input_tokens)
          + Number(event.cache_write_input_tokens) + Number(event.output_tokens);
      taskUsage.add(event, cost, eventTokens);
      totalTokens += eventTokens;
      if (cost.covered) coveredTokens += eventTokens;
      else if (eventTokens > 0) {
        // Keyed apart from any model actually named "Unknown", which can be priced.
        const unpricedKey = event.model ? `${event.source_id}|${event.model}` : `${event.source_id}|`;
        const unpriced = unpricedModelsMap.get(unpricedKey) || {
          sourceId: event.source_id,
          model: event.model || 'Unknown',
          tokens: 0,
          // Records without a model name: no catalogue price can apply to them.
          ...(event.model ? {} : { unnamed: true }),
        };
        unpriced.tokens += eventTokens;
        unpricedModelsMap.set(unpricedKey, unpriced);
      }
      actualUsd += cost.actualUsd;
      withoutCacheUsd += cost.withoutCacheUsd;
      const key = `${event.source_id}|${event.model || 'Unknown'}`;
      const model = byModelMap.get(key) || {
        sourceId: event.source_id,
        model: event.model || 'Unknown',
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        costUsd: 0,
        breakdownUsd: { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
        coveredTokens: 0,
        totalTokens: 0,
      };
      model.inputTokens += Number(event.input_tokens);
      model.cachedInputTokens += Number(event.cached_input_tokens);
      model.cacheWriteInputTokens += Number(event.cache_write_input_tokens);
      // Apply the same legacy TTL fallback as pricing before grouping records.
      const write5m = Number(event.cache_write_5m_input_tokens);
      const write1h = Number(event.cache_write_1h_input_tokens);
      model.cacheWrite5mInputTokens += write5m + write1h === 0 ? Number(event.cache_write_input_tokens) : write5m;
      model.cacheWrite1hInputTokens += Number(event.cache_write_1h_input_tokens);
      model.outputTokens += Number(event.output_tokens);
      model.reasoningOutputTokens += Number(event.reasoning_output_tokens);
      model.costUsd += cost.actualUsd;
      if (cost.breakdownUsd) {
        model.breakdownUsd.input += cost.breakdownUsd.input;
        model.breakdownUsd.cacheRead += cost.breakdownUsd.cacheRead;
        model.breakdownUsd.cacheWrite5m += cost.breakdownUsd.cacheWrite5m;
        model.breakdownUsd.cacheWrite1h += cost.breakdownUsd.cacheWrite1h;
        model.breakdownUsd.output += cost.breakdownUsd.output;
      }
      model.totalTokens += eventTokens;
      if (cost.covered) model.coveredTokens += eventTokens;
      byModelMap.set(key, model);

      // The chart and activity grid share one local-time conversion per row.
      const parts = localPartsOf(event.occurred_at);
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const dayRow = byDayMap.get(day) || { date: day, codexUsd: 0, claudeUsd: 0 };
      if (event.source_id === 'codex') dayRow.codexUsd += cost.actualUsd;
      else dayRow.claudeUsd += cost.actualUsd;
      byDayMap.set(day, dayRow);
      activityUsd[WEEKDAY_INDEX[parts.weekday] ?? 0][Number(parts.hour) % 24] += cost.actualUsd;

      const projectKey = event.project || '';
      const projectRow = byProjectMap.get(projectKey) || {
        project: event.project || null,
        costUsd: 0,
        totalTokens: 0,
        coveredTokens: 0,
        sessions: new Set(),
        sources: new Set(),
        lastActivity: event.occurred_at,
      };
      projectRow.costUsd += cost.actualUsd;
      projectRow.totalTokens += eventTokens;
      if (cost.covered) projectRow.coveredTokens += eventTokens;
      projectRow.sessions.add(`${event.source_id}|${event.session_id || event.event_key}`);
      projectRow.sources.add(event.source_id);
      if (event.occurred_at > projectRow.lastActivity) projectRow.lastActivity = event.occurred_at;
      byProjectMap.set(projectKey, projectRow);

      const sessionKey = `${event.source_id}|${event.session_id || event.event_key}|${event.model || 'Unknown'}`;
      const session = sessionMap.get(sessionKey) || {
        sourceId: event.source_id,
        sessionId: event.session_id || event.event_key,
        model: event.model || 'Unknown',
        project: event.project || null,
        occurredAt: event.occurred_at,
        totalTokens: 0,
        costUsd: 0,
        coveredTokens: 0,
      };
      session.totalTokens += eventTokens;
      session.costUsd += cost.actualUsd;
      if (cost.covered) session.coveredTokens += eventTokens;
      if (event.occurred_at > session.occurredAt) session.occurredAt = event.occurred_at;
      if (!session.project && event.project) session.project = event.project;
      sessionMap.set(sessionKey, session);
    }

    const rate = Number(settings.usdToCurrency || 1);
    const toCurrency = (value) => round(value * rate, 2);
    const byModel = [...byModelMap.values()].map((row) => ({
      ...row,
      totalTokens: row.totalTokens,
      cost: toCurrency(row.costUsd),
      // Keep category precision until display; rounding each event would erase
      // small charges. Price per event before grouping to preserve context tiers.
      costBreakdown: Object.fromEntries(Object.entries(row.breakdownUsd).map(([key, value]) => [key, value * rate])),
      costShare: actualUsd > 0 && row.coveredTokens > 0 ? row.costUsd / actualUsd : null,
      coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0,
    })).sort((a, b) => b.cost - a.cost);
    const chart = [...byDayMap.values()].map((row) => ({
      date: row.date,
      codex: toCurrency(row.codexUsd),
      claude: toCurrency(row.claudeUsd),
    }));
    const sessions = [...sessionMap.values()]
      .sort((a, b) => round(b.costUsd - a.costUsd, 8) || b.occurredAt.localeCompare(a.occurredAt)
        || a.sourceId.localeCompare(b.sourceId) || a.sessionId.localeCompare(b.sessionId) || a.model.localeCompare(b.model))
      .map((row) => ({ ...row, cost: toCurrency(row.costUsd), coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0 }));
    const byProject = [...byProjectMap.values()]
      .sort((a, b) => round(b.costUsd - a.costUsd, 8) || String(a.project || '').localeCompare(String(b.project || '')))
      .map((row) => ({
        project: row.project,
        cost: toCurrency(row.costUsd),
        totalTokens: row.totalTokens,
        coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0,
        sessionCount: row.sessions.size,
        sources: [...row.sources].sort(),
        lastActivity: row.lastActivity,
      }));
    const unpricedModels = [...unpricedModelsMap.values()]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.model.localeCompare(b.model));
    const isComplete = coveredTokens === totalTokens;

    return {
      sessions,
      tasks: taskUsage.finish(rate),
      costs: {
        periodDays: days,
        currency: settings.currency,
        actual: toCurrency(actualUsd),
        withoutCache: toCurrency(withoutCacheUsd),
        cacheSavings: toCurrency(Math.max(0, withoutCacheUsd - actualUsd)),
        cacheSavingsPercent: withoutCacheUsd > 0 ? Math.max(0, (withoutCacheUsd - actualUsd) / withoutCacheUsd) : 0,
        totalTokens,
        coverage: totalTokens ? coveredTokens / totalTokens : 0,
        isComplete,
        isLowerBound: !isComplete,
        unpricedModels,
        requestCount,
        byModel,
        byProject,
        chart,
        sessions: sessions.slice(0, 8),
        activityGrid: activityUsd.map((row) => row.map((value) => toCurrency(value))),
      },
    };
  }

  // One row per past allowance window of a source's primary bucket: when it
  // ran, how much of it was used, and what that window's tracked tokens would
  // have cost at the current catalogue. Windows are keyed by their reset time.
  getCycleHistory(sourceId, quota, settings = this.getSettings(), limit = 8, nowMs = Date.now()) {
    if (!quota) return [];
    if (this.db.isTransaction) return this.buildCycleHistory(sourceId, quota, settings, limit, nowMs);
    const revision = this.cycleRevision(sourceId, quota.bucketId);
    const key = JSON.stringify([sourceId, quota.bucketId, limit, settings.currency, settings.usdToCurrency]);
    const cached = this.cycleHistoryCache.get(key);
    if (cached && cached.revision === revision && nowMs >= cached.at && nowMs < cached.expiresAt) {
      this.cycleHistoryCache.delete(key);
      this.cycleHistoryCache.set(key, cached);
      return cached.value;
    }
    const value = this.buildCycleHistory(sourceId, quota, settings, limit, nowMs);
    const eventSource = sourceId === 'codex' ? 'codex' : 'claude';
    const modelFilter = sourceId === 'claude-fable' ? "AND LOWER(COALESCE(model, '')) LIKE '%fable%'" : '';
    // Current cycles end at now (exclusive). A future-dated imported event
    // enters its cycle one millisecond after its timestamp; a reset also
    // changes the current flag even when no database write occurs.
    const nextEvent = this.prepare(`SELECT occurred_at FROM usage_events
      WHERE source_id = ? AND occurred_at >= ? ${modelFilter}
      ORDER BY occurred_at ASC LIMIT 1`).get(eventSource, iso(nowMs));
    const expiresAt = Math.min(nextEvent ? Date.parse(nextEvent.occurred_at) + 1 : Infinity,
      ...value.filter((row) => row.current).map((row) => Date.parse(row.resetsAt)));
    this.cycleHistoryCache.delete(key);
    this.cycleHistoryCache.set(key, { at: nowMs, expiresAt, revision, value });
    if (this.cycleHistoryCache.size > 12) this.cycleHistoryCache.delete(this.cycleHistoryCache.keys().next().value);
    return value;
  }

  buildCycleHistory(sourceId, quota, settings = this.getSettings(), limit = 8, nowMs = Date.now()) {
    if (!quota) return [];
    const bucketId = quota.bucketId;
    const rows = this.prepare(`
      SELECT resets_at, window_minutes, MAX(used_percent) AS peak_used,
        MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at,
        COUNT(*) AS readings
      FROM quota_observations
      WHERE source_id = ? AND bucket_id = ?
      GROUP BY resets_at
      ORDER BY resets_at DESC
    `).iterate(sourceId, bucketId);
    // Before its first use, an idle allowance can roll its reset forward with
    // every poll. Fold those unused readings into the subsequently pinned
    // window as well as merging ordinary sub-minute timestamp jitter.
    // Apply the limit to merged windows, not timestamps: a busy current window
    // can have hundreds of jittered timestamps and must not hide older cycles.
    const merged = [];
    for (const row of rows) {
      const previous = merged.at(-1);
      const resetMs = new Date(row.resets_at).getTime();
      const previousReset = previous ? Date.parse(previous.resets_at) : NaN;
      const previousStart = previousReset - Number(previous?.window_minutes || 10_080) * 60_000;
      const sameDuration = previous && previous.window_minutes === row.window_minutes;
      const idleRoll = sameDuration && row.peak_used === 0 && resetMs < previousReset
        && row.last_observed_at < previous.first_observed_at
        && resetMs > previousStart
        && previousStart >= Date.parse(row.first_observed_at) - QUOTA_CLOCK_SKEW_MS;
      if (sameDuration && (Math.abs(previousReset - resetMs) <= 60_000 || idleRoll)) {
        previous.peak_used = Math.max(previous.peak_used, row.peak_used);
        previous.first_observed_at = row.first_observed_at < previous.first_observed_at ? row.first_observed_at : previous.first_observed_at;
        previous.last_observed_at = row.last_observed_at > previous.last_observed_at ? row.last_observed_at : previous.last_observed_at;
        previous.readings += row.readings;
        continue;
      }
      if (merged.length >= limit) break;
      merged.push({ ...row });
    }
    const rate = Number(settings.usdToCurrency || 1);
    const eventSource = sourceId === 'codex' ? 'codex' : 'claude';
    const modelFilter = sourceId === 'claude-fable' ? "AND LOWER(COALESCE(model, '')) LIKE '%fable%'" : '';
    const windows = merged.slice(0, limit).map((row, index) => {
      const resetMs = new Date(row.resets_at).getTime();
      const windowMinutes = Number(row.window_minutes) > 0 ? Number(row.window_minutes) : 10_080;
      const startMs = resetMs - windowMinutes * 60_000;
      // A replacement cycle can begin before the old scheduled reset (for
      // example after a banked reset credit). The old cycle must stop there,
      // and the half-open intervals assign boundary usage only to the new one.
      const newer = merged[index - 1];
      const newerStart = newer ? Date.parse(newer.resets_at) - Number(newer.window_minutes || 10_080) * 60_000 : Infinity;
      const endMs = Math.min(resetMs, newerStart);
      return {
        row,
        resetMs,
        endMs,
        windowMinutes,
        startIso: iso(startMs),
        endIso: iso(Math.min(endMs, nowMs)),
        usd: 0,
        tokens: 0,
      };
    });
    // One range query covers every window, and each event is costed once and
    // credited to the windows that contain it, instead of one query and a
    // full re-costing per window. Timestamps are normalised ISO strings, so
    // the comparison is the same text comparison the query used.
    if (windows.length) {
      this.withPriceCache(() => {
        for (const window of windows) {
          const events = this.prepare(`SELECT source_id, model,
            input_tokens + cache_write_input_tokens > ${OPENAI_LONG_CONTEXT_THRESHOLD} AS aggregateLongContext,
            SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
            SUM(cache_write_input_tokens) AS cache_write_input_tokens,
            SUM(CASE WHEN cache_write_5m_input_tokens + cache_write_1h_input_tokens = 0 THEN cache_write_input_tokens ELSE cache_write_5m_input_tokens END) AS cache_write_5m_input_tokens,
            SUM(cache_write_1h_input_tokens) AS cache_write_1h_input_tokens,
            SUM(output_tokens) AS output_tokens
            FROM usage_events WHERE source_id = ? AND occurred_at >= ? AND occurred_at < ? ${modelFilter}
            GROUP BY model, aggregateLongContext`).iterate(eventSource, window.startIso, window.endIso);
          for (const event of events) {
            window.usd += this.calculateCost(event).actualUsd;
            // Codex reports cached input as a subset of input; Claude reports it
            // separately. Same rule as buildCostAnalytics so the two tables agree.
            window.tokens += event.source_id === 'codex'
              ? Number(event.input_tokens) + Number(event.cache_write_input_tokens) + Number(event.output_tokens)
              : Number(event.input_tokens) + Number(event.cached_input_tokens)
                + Number(event.cache_write_input_tokens) + Number(event.output_tokens);
          }
        }
      });
    }
    return windows.map(({ row, endMs, windowMinutes, startIso, usd, tokens }) => ({
      resetsAt: row.resets_at,
      endsAt: iso(endMs),
      startsAt: startIso,
      windowMinutes,
      peakUsedPercent: round(Number(row.peak_used), 1),
      readings: Number(row.readings),
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      current: endMs > nowMs,
      cost: round(usd * rate, 2),
      tokens,
    }));
  }

  // Everything the Details ledger shows, as one CSV a spreadsheet can open.
  // Token counts and the current-catalogue equivalent in USD; no prompts. The
  // period is the dashboard's: the last N local calendar days. Given `write`,
  // text is handed over in batches as the ledger is read, so a long, busy
  // period is never held in memory as one string; otherwise it is returned.
  exportLedgerCsv(days = 90, nowMs = Date.now(), write = null) {
    const since = iso(periodStart(days, nowMs));
    const escape = (value) => {
      const text = value == null ? '' : String(value);
      // CSV quoting alone does not stop spreadsheet formulas. Guard text at
      // this sink, including prefixes hidden by whitespace/control characters
      // and full-width formula markers, while leaving numeric cells numeric.
      if (typeof value === 'string'
        && (/^[\s\p{Cc}\p{Cf}]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(text)
          || /^\s*[\p{Cc}\p{Cf}]/u.test(text))) {
        return `"'${text.replaceAll('"', '""')}"`;
      }
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const header = ['occurred_at', 'source', 'model', 'project', 'session_id', 'input_tokens', 'cached_input_tokens',
      'cache_write_5m_input_tokens', 'cache_write_1h_input_tokens', 'output_tokens', 'reasoning_output_tokens',
      'api_equivalent_usd', 'priced'];
    const chunks = [];
    const emit = write || ((text) => chunks.push(text));
    let batch = `${header.join(',')}\r\n`;
    let rows = 0;
    this.withPriceCache(() => {
      const events = this.prepare('SELECT * FROM usage_events WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at ASC')
        .iterate(since, iso(nowMs));
      for (const event of events) {
        const cost = this.calculateCost(event);
        let cacheWrite5m = Number(event.cache_write_5m_input_tokens || 0);
        const cacheWrite1h = Number(event.cache_write_1h_input_tokens || 0);
        if (cacheWrite5m + cacheWrite1h === 0) cacheWrite5m = Number(event.cache_write_input_tokens || 0);
        batch += `${[
          event.occurred_at, event.source_id, event.model, event.project, event.session_id,
          event.input_tokens, event.cached_input_tokens, cacheWrite5m, cacheWrite1h,
          event.output_tokens, event.reasoning_output_tokens,
          round(cost.actualUsd, 6), cost.covered ? 'yes' : 'no',
        ].map(escape).join(',')}\r\n`;
        rows += 1;
        if (batch.length >= CSV_BATCH_CHARS) {
          emit(batch);
          batch = '';
        }
      }
    });
    emit(batch);
    return write ? { rows, since } : { csv: chunks.join(''), rows, since };
  }

  // Housekeeping after a refresh: compact old polling rows so the table stops
  // growing with the refresh interval. Manual readings are never touched.
  compactObservations(nowMs = Date.now()) {
    const edge = new Date(nowMs - COMPACT_AFTER_MS);
    edge.setHours(0, 0, 0, 0);
    const cutoff = iso(edge.getTime());
    return this.transaction(() => {
      const state = this.prepare('SELECT * FROM quota_compaction_state WHERE id = 1').get();
      const lower = [state.through_at, state.dirty_at].filter(Boolean).sort()[0];
      if (!lower || lower >= cutoff) return { removed: 0, cutoff };
      const from = new Date(lower); from.setHours(0, 0, 0, 0);
      const buckets = new Map();
      for (const row of this.prepare('SELECT * FROM quota_observations WHERE observed_at >= ? AND observed_at < ? ORDER BY observed_at, id')
        .iterate(iso(from.getTime()), cutoff)) {
        const key = JSON.stringify([row.source_id, row.bucket_id, row.window_minutes]);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ ...normaliseObservation(row), id: row.id, original: row });
      }
      let removed = 0;
      const remove = this.prepare('DELETE FROM quota_observations WHERE id = ?');
      // Resolved once: the first compaction after an upgrade or a restore
      // scans all history, and a per-row zone lookup built a formatter each time.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      for (const rows of buckets.values()) {
        for (const cluster of clusterByWindow(rows)) {
          const days = new Map();
          for (const row of cluster.rows) {
            const day = dateKey(row.observedAt, timeZone);
            if (!days.has(day)) days.set(day, []);
            days.get(day).push(row);
          }
          for (const day of days.values()) {
            const peak = day.reduce((best, row) => row.usedPercent >= best.usedPercent ? row : best);
            const keep = new Set([day[0].id, day.at(-1).id, peak.id]);
            for (const row of day) if (!keep.has(row.id) && row.provenance !== 'manual-official') removed += remove.run(row.id).changes;
          }
        }
      }
      this.prepare('UPDATE quota_compaction_state SET through_at = ?, dirty_at = NULL WHERE id = 1').run(cutoff);
      return { removed, cutoff };
    });
  }

  getDailyUsage(days = 90, nowMs = Date.now()) {
    const since = dateKey(nowMs - days * 24 * 60 * 60 * 1000);
    return this.prepare(`
      SELECT source_id AS sourceId, usage_date AS date, tokens
      FROM account_daily_usage
      WHERE usage_date >= ?
      ORDER BY usage_date ASC, source_id ASC
    `).all(since);
  }

  getTraySnapshot(nowMs = Date.now(), { tokenCapacity = false } = {}) {
    const settings = this.getSettings();
    const sources = this.prepare('SELECT * FROM sources ORDER BY CASE id WHEN \'codex\' THEN 1 WHEN \'claude\' THEN 2 ELSE 3 END').all()
      .map((row) => ({ ...row, metadata: json(row.metadata_json, {}) }));
    const claude = this.getQuota('claude', settings, nowMs, { tokenCapacity });
    const quotas = {
      codex: this.getQuota('codex', settings, nowMs, { tokenCapacity }),
      claude,
      // Fable's limit sits inside the Claude weekly pool: whatever any model
      // has used of the week also caps what Fable can still use.
      fable: applySharedPool(this.getQuota('claude-fable', settings, nowMs, { tokenCapacity }), claude, { nowMs, settings }),
    };
    // A plan the provider names other than Max has no Fable allowance, so
    // with no Fable reading there is nothing for the verdict to wait for.
    const fableProjection = quotas.fable ? null : this.getFableProjection(settings, nowMs);
    const fableApplies = Boolean(quotas.fable)
      || !(fableProjection?.reason === 'fable-not-confirmed-in-shared-plan' && fableProjection.planType);
    const reportedResetCredits = quotas.codex?.metadata?.resetCredits;
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

  // Fable 5 and Fable 5.1 draw on one allowance; this splits this device's
  // Fable activity in the current Fable window by version, with what those
  // tokens are worth at today's API prices. Only tokens and money are split:
  // the provider reports one percentage for both.
  getFableActivity(fableQuota, settings = this.getSettings(), nowMs = Date.now()) {
    const resetMs = Date.parse(fableQuota?.resetsAt ?? '');
    const throughMs = nowMs;
    const sinceMs = Number.isFinite(resetMs) && resetMs > nowMs ? resetMs - 7 * DAY_MS : nowMs - 7 * DAY_MS;
    const rate = Number(settings.usdToCurrency || 1);
    const rows = this.prepare(`
      SELECT model, COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
        -- A row from before the five-minute/one-hour split counts as five-minute
        -- writes, row by row, as Costs does; summing first would lose it.
        COALESCE(SUM(CASE WHEN cache_write_5m_input_tokens + cache_write_1h_input_tokens = 0
          THEN cache_write_input_tokens ELSE cache_write_5m_input_tokens END), 0) AS cache_write_5m_input_tokens,
        COALESCE(SUM(cache_write_1h_input_tokens), 0) AS cache_write_1h_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM usage_events
      WHERE source_id = 'claude' AND occurred_at >= ? AND occurred_at <= ?
        AND LOWER(COALESCE(model, '')) LIKE '%fable%'
      GROUP BY model
    `).all(iso(sinceMs), iso(throughMs));
    const models = rows.map((row) => {
      const cost = this.calculateCost({ ...row, source_id: 'claude' });
      return {
        model: String(row.model),
        requests: Number(row.requests || 0),
        totalTokens: Number(row.input_tokens || 0) + Number(row.cached_input_tokens || 0)
          + Number(row.cache_write_input_tokens || 0) + Number(row.output_tokens || 0),
        cacheReadTokens: Number(row.cached_input_tokens || 0),
        cost: round(cost.actualUsd * rate, 4),
        covered: cost.covered,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
    return { since: iso(sinceMs), through: iso(throughMs), currency: settings.currency, models };
  }

  // The extra-usage setting the newest plan-usage read reported, from either
  // Claude source. A newer status-line or projected reading carries none, so
  // the headline window's metadata alone can miss the last Refresh.
  getClaudeExtraUsage(nowMs = Date.now()) {
    const row = this.prepare(`
      SELECT metadata_json, observed_at FROM quota_observations
      WHERE source_id IN ('claude', 'claude-fable') AND provenance = 'official-claude-usage'
        AND observed_at >= ? AND observed_at <= ? AND metadata_json LIKE '%"extraUsage"%'
      ORDER BY observed_at DESC, id DESC LIMIT 1
    `).get(iso(nowMs - FORECAST_LOOKBACK_MS), iso(nowMs + QUOTA_CLOCK_SKEW_MS));
    const extra = json(row?.metadata_json, {})?.extraUsage;
    if (!extra || typeof extra !== 'object' || typeof extra.isEnabled !== 'boolean') return null;
    const utilization = Number.isFinite(extra.utilization) ? extra.utilization : null;
    return { isEnabled: extra.isEnabled, utilization, observedAt: row.observed_at };
  }

  getDashboardSnapshot(days = 30, nowMs = Date.now()) {
    const snapshot = this.getTraySnapshot(nowMs, { tokenCapacity: true });
    const { settings, quotas } = snapshot;
    return {
      ...snapshot,
      fableActivity: this.getFableActivity(quotas.fable, settings, nowMs),
      claudeExtraUsage: this.getClaudeExtraUsage(nowMs),
      priceCatalog: this.getPriceCatalog(),
      costs: this.getCostAnalytics(days, settings, nowMs),
      desktopEstimates: require('./desktop-estimates.cjs').desktopAnalytics(this, days, settings, nowMs),
      cycles: {
        codex: this.getCycleHistory('codex', quotas.codex, settings, 8, nowMs),
        claude: this.getCycleHistory('claude', quotas.claude, settings, 8, nowMs),
        fable: this.getCycleHistory('claude-fable', quotas.fable, settings, 8, nowMs),
      },
      dailyUsage: this.getDailyUsage(Math.max(days, 90), nowMs),
      storage: {
        databasePath: this.databasePath,
        backupDirectory: this.backupDirectory,
        databaseSize: fs.existsSync(this.databasePath) ? fs.statSync(this.databasePath).size : 0,
      },
    };
  }

  // `keep` names a backup file this run must not prune — the one the caller is
  // about to restore from. Opening a restore point should never delete it.
  // `exportJson: false` writes the SQLite copy alone. The JSON export is also
  // skipped once it outgrows what readExport accepts: the SQLite copy
  // restores a ledger of any size, and the export would only cost time.
  createBackup(options = {}) {
    const stamp = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${require('node:crypto').randomUUID()}`;
    const databasePath = path.join(this.backupDirectory, `ai-usage-${stamp}.sqlite`);
    const exportPath = path.join(this.backupDirectory, `ai-usage-${stamp}.aiusage.json.gz`);
    const partialDatabase = `${databasePath}.partial`, partialExport = `${exportPath}.partial`;
    let exported = options.exportJson !== false;
    // The folder is shown in Settings and can be deleted while the app runs.
    fs.mkdirSync(this.backupDirectory, { recursive: true });
    this.sweepPartialBackups();
    try {
      this.db.prepare('VACUUM INTO ?').run(partialDatabase);
      if (exported) {
        const { writeExport, MAX_RESTORE_BYTES } = require('./backup-export.cjs');
        const copy = new DatabaseSync(partialDatabase, { readOnly: true });
        try {
          writeExport(partialExport, copy, backupSettings(copy), { maxBytes: MAX_RESTORE_BYTES });
        } catch (error) {
          if (error?.code !== 'EXPORT_TOO_LARGE') throw error;
          exported = false;
        } finally { copy.close(); }
        if (!exported) fs.rmSync(partialExport, { force: true });
      }
      fs.renameSync(partialDatabase, databasePath);
      if (exported) fs.renameSync(partialExport, exportPath);
      this.prepare('INSERT INTO backups(created_at, database_path, export_path) VALUES (?, ?, ?)')
        .run(iso(), databasePath, exported ? exportPath : '');
    } catch (error) {
      for (const file of [partialDatabase, partialExport, databasePath, exportPath]) {
        try { fs.unlinkSync(file); } catch { /* A later partial sweep retries locked files. */ }
      }
      throw error;
    }
    this.pruneBackups(this.getSettings().backupRetentionCount, options.keep);
    return { databasePath, exportPath: exported ? exportPath : null };
  }

  // Reading is a separate step so a caller can load the export into memory
  // before taking its own backup: creating one prunes old sets, and the file
  // the user chose from the backup folder can be among them.
  readExport(filePath) {
    if (/\.sqlite$/i.test(String(filePath || ''))) return this.readDatabaseBackup(filePath);
    return require('./backup-export.cjs').readExport(filePath);
  }

  // A SQLite backup restores a ledger of any size: its records are read as
  // the merge consumes them, in the export's shape, so restoreFromExport
  // applies the same validation and merge rules. The caller calls close().
  readDatabaseBackup(filePath) {
    if (!filePath || !fs.existsSync(filePath)) throw new Error('That backup file could not be found.');
    let database;
    try {
      database = new DatabaseSync(filePath, { readOnly: true });
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      if (!['settings', 'quota_observations', 'usage_events'].every((table) => tables.has(table))) throw new Error('Not an AI Usage database.');
      const rows = (table) => (tables.has(table) ? database.prepare(`SELECT * FROM ${table}`).iterate() : []);
      return {
        schemaVersion: 1,
        settings: storedSettings(database),
        observations: rows('quota_observations'),
        usageEvents: rows('usage_events'),
        dailyUsage: rows('account_daily_usage'),
        prices: [...rows('price_catalog')],
        desktopEstimates: [...rows('desktop_chat_estimates')],
        close: () => database.close(),
      };
    } catch {
      try { database?.close(); } catch { /* Report the unreadable file instead. */ }
      throw new Error('That file is not a readable AI Usage backup.');
    }
  }

  sweepPartialBackups(nowMs = Date.now()) {
    // Missing registrations can mean database recovery, not failed backups.
    // Completed files may be the only remaining history; only partials are disposable.
    for (const entry of fs.readdirSync(this.backupDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^ai-usage-\d{4}-\d{2}-\d{2}T[\dZ-]+-[\da-f-]{36}\.(?:sqlite|aiusage\.json\.gz)\.partial$/.test(entry.name)) continue;
      const file = path.join(this.backupDirectory, entry.name);
      try {
        if (nowMs - fs.statSync(file).mtimeMs <= DAY_MS) continue;
        fs.unlinkSync(file);
      } catch { /* Retry next maintenance. */ }
    }
  }

  restoreFromBackup(filePath) {
    const payload = this.readExport(filePath);
    try {
      return this.restoreFromExport(payload);
    } finally { payload.close?.(); }
  }

  // A backup nothing can read back is not a backup. Restore merges an export
  // into the live database rather than replacing it: for every table of
  // records, rows already present win, so restoring onto a partly collected
  // database can neither double count nor overwrite newer data. Settings are
  // the exception — they are replaced, and reported separately so the caller
  // can say so. Records the export cannot supply validly are skipped and
  // counted, never guessed, and one bad row never costs the others.
  restoreFromExport(payload) {
    const nowMs = Date.now();
    const unreadable = () => new Error('That file is not a readable AI Usage export.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw unreadable();
    const schemaVersion = Number(payload.schemaVersion);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 1) throw unreadable();
    if (schemaVersion > 1) throw new Error(`This backup was written by a newer version of AI Usage (schema ${schemaVersion}).`);
    // Arrays from a JSON export, or row iterators from a SQLite backup.
    const list = (value) => (Array.isArray(value)
      || (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') ? value : []);
    const knownSources = new Set(SOURCE_DEFINITIONS.map(([id]) => id));
    const counts = { settings: 0, observations: 0, usageEvents: 0, dailyUsage: 0, prices: 0, skipped: 0 };
    let restoredCodexEvents = 0;
    let restoredClaudeEvents = 0;

    const insertObservation = this.prepare(`
      INSERT OR IGNORE INTO quota_observations(
        source_id, bucket_id, bucket_name, observed_at, used_percent, remaining_percent,
        resets_at, window_minutes, plan_type, provenance, confidence, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvent = this.prepare(`
      INSERT INTO usage_events(
        event_key, source_id, occurred_at, session_id, model, project, input_tokens,
        cached_input_tokens, cache_write_input_tokens, cache_write_5m_input_tokens,
        cache_write_1h_input_tokens, output_tokens, reasoning_output_tokens,
        reported_cost_usd, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING
    `);
    // Existing daily totals and user-owned prices win a merge. Freshly seeded
    // defaults may yield to the export, so recovery restores catalogue edits.
    const insertDailyUsage = this.prepare(`
      INSERT INTO account_daily_usage(source_id, usage_date, tokens) VALUES (?, ?, ?)
      ON CONFLICT(source_id, usage_date) DO NOTHING
    `);
    const insertPrice = this.prepare(`
      INSERT INTO price_catalog(model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        input_usd_per_million = excluded.input_usd_per_million,
        cache_write_usd_per_million = excluded.cache_write_usd_per_million,
        cache_write_1h_usd_per_million = excluded.cache_write_1h_usd_per_million,
        cache_read_usd_per_million = excluded.cache_read_usd_per_million,
        output_usd_per_million = excluded.output_usd_per_million,
        effective_from = excluded.effective_from, source_url = excluded.source_url
      WHERE price_catalog.is_seed = 1 AND (
        price_catalog.input_usd_per_million IS NOT excluded.input_usd_per_million
        OR price_catalog.cache_write_usd_per_million IS NOT excluded.cache_write_usd_per_million
        OR price_catalog.cache_write_1h_usd_per_million IS NOT excluded.cache_write_1h_usd_per_million
        OR price_catalog.cache_read_usd_per_million IS NOT excluded.cache_read_usd_per_million
        OR price_catalog.output_usd_per_million IS NOT excluded.output_usd_per_million
        OR price_catalog.effective_from IS NOT excluded.effective_from
        OR price_catalog.source_url IS NOT excluded.source_url)
    `);
    const setSetting = this.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    const finiteNumber = (value) => {
      // Number(null), Number(''), Number(false) and Number([]) are all 0, so
      // coercing first would accept those as a legitimate zero.
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value !== 'string' || !value.trim()) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new Error(`The database was busy and the restore did not start: ${error.message}`);
    }
    try {
      const exported = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
      // Validate every key first, then check the cross-field schedule rule
      // against what would actually be written. Testing it against the raw
      // export let a rejected end hour vouch for a start hour that then
      // outlived it, leaving a start-after-end schedule updateSettings refuses.
      const accepted = {};
      for (const [exportedKey, value] of Object.entries(exported)) {
        const key = Object.hasOwn(SETTING_ALIASES, exportedKey) ? SETTING_ALIASES[exportedKey] : exportedKey;
        const validate = settingValidator(key);
        if (!validate || !validate(value)) {
          counts.skipped += 1;
          continue;
        }
        accepted[key] = normalizedSetting(key, value);
      }
      const merged = { ...this.getSettings(), ...accepted };
      if (merged.activeStartHour >= merged.activeEndHour) {
        for (const key of ['activeStartHour', 'activeEndHour']) {
          if (Object.hasOwn(accepted, key)) {
            delete accepted[key];
            counts.skipped += 1;
          }
        }
      }
      for (const [key, value] of Object.entries(accepted)) {
        setSetting.run(key, JSON.stringify(value), iso());
        counts.settings += 1;
      }

      for (const row of list(payload.observations)) {
        try {
          if (!knownSources.has(row.source_id) || typeof row.bucket_id !== 'string' || !row.bucket_id) throw unreadable();
          // Derived estimates are reproducible local cache, not source
          // evidence. In particular, old versions could derive them from an
          // unverified Max-plan assumption, so backups must not resurrect them.
          if (row.provenance === 'derived-tokens') throw unreadable();
          const usedPercent = finiteNumber(row.used_percent);
          if (usedPercent == null || usedPercent < 0 || usedPercent > 100) throw unreadable();
          const remainingPercent = row.remaining_percent == null ? 100 - usedPercent : finiteNumber(row.remaining_percent);
          // The same invariants recordObservation enforces on live readings: an
          // out-of-range remainder reaches the quota card unclamped, and a reset
          // before its observation makes the forecast permanently "expired".
          if (remainingPercent == null || remainingPercent < 0 || remainingPercent > 100) throw unreadable();
          if (Math.abs(usedPercent + remainingPercent - 100) > 0.1) throw unreadable();
          const observedAt = validIso(row.observed_at, 'Observation time');
          const resetsAt = validIso(row.resets_at, 'Reset time');
          const resetDistanceMs = new Date(resetsAt).getTime() - new Date(observedAt).getTime();
          if (resetDistanceMs < -5 * 60_000 || resetDistanceMs > MAX_QUOTA_RESET_AHEAD_MS) throw unreadable();
          const windowMinutes = row.window_minutes == null ? null : finiteNumber(row.window_minutes);
          const confidence = row.confidence == null ? 1 : finiteNumber(row.confidence);
          if (!validQuotaTime(new Date(observedAt).getTime(), new Date(resetsAt).getTime(), windowMinutes, nowMs)) throw unreadable();
          if (windowMinutes != null && (!Number.isSafeInteger(windowMinutes) || windowMinutes < 0 || windowMinutes > 31 * 24 * 60)) throw unreadable();
          if (confidence == null || confidence < 0 || confidence > 1) throw unreadable();
          const provenance = typeof row.provenance === 'string' && row.provenance ? row.provenance : 'official';
          // Older status-line helpers guessed the subscription label from local
          // configuration. It is not provider evidence and must not regain the
          // authority to enable Max-only shared-pool arithmetic after restore.
          const planType = provenance === 'official-statusline'
            ? null : typeof row.plan_type === 'string' ? row.plan_type : null;
          const metadata = quotaMetadata(row.metadata_json ?? {});
          if (!metadata) throw unreadable();
          counts.observations += insertObservation.run(
            row.source_id, row.bucket_id, typeof row.bucket_name === 'string' ? row.bucket_name : null,
            observedAt, usedPercent, remainingPercent, resetsAt,
            windowMinutes, planType, provenance, confidence,
            JSON.stringify(metadata),
          ).changes;
        } catch (error) {
          // Database errors may roll back the transaction. Continuing after
          // one would autocommit later records outside the failed restore.
          if (error?.code || !this.db.isTransaction) throw error;
          counts.skipped += 1;
        }
      }

      for (const row of list(payload.usageEvents)) {
        try {
          if (!knownSources.has(row.source_id) || typeof row.event_key !== 'string' || !row.event_key) throw unreadable();
          const tokens = (value) => {
            const parsed = value == null ? 0 : finiteNumber(value);
            if (!Number.isSafeInteger(parsed) || parsed < 0) throw unreadable();
            return parsed;
          };
          const cacheWrite1h = tokens(row.cache_write_1h_input_tokens);
          const cacheWriteTotal = tokens(row.cache_write_input_tokens ?? tokens(row.cache_write_5m_input_tokens) + cacheWrite1h);
          // Exports written before cache TTL was recorded carry only the total,
          // and the same "no detail means five-minute" rule the collectors and
          // calculateCost use has to hold here or the split stops adding up.
          let cacheWrite5m = row.cache_write_5m_input_tokens == null
            ? Math.max(0, cacheWriteTotal - cacheWrite1h)
            : tokens(row.cache_write_5m_input_tokens);
          if (cacheWrite5m + cacheWrite1h === 0) cacheWrite5m = cacheWriteTotal;
          const reportedCost = row.reported_cost_usd == null ? null : finiteNumber(row.reported_cost_usd);
          const outputTokens = tokens(row.output_tokens);
          const reasoningTokens = tokens(row.reasoning_output_tokens);
          const inputTokens = tokens(row.input_tokens);
          const cachedInputTokens = tokens(row.cached_input_tokens);
          if ((row.source_id === 'codex' && cachedInputTokens > inputTokens)
            || cacheWrite5m + cacheWrite1h !== cacheWriteTotal) throw unreadable();
          if (reasoningTokens > outputTokens
            || (row.reported_cost_usd != null && (reportedCost == null || reportedCost < 0))) throw unreadable();
          const inserted = insertEvent.run(
            row.event_key, row.source_id, validIso(row.occurred_at, 'Event time'),
            typeof row.session_id === 'string' ? row.session_id : null,
            typeof row.model === 'string' ? row.model : null,
            typeof row.project === 'string' && row.project.trim() ? row.project.trim() : null,
            inputTokens, cachedInputTokens,
            cacheWriteTotal, cacheWrite5m, cacheWrite1h,
            outputTokens, reasoningTokens,
            reportedCost,
            typeof row.metadata_json === 'string' ? row.metadata_json : JSON.stringify(row.metadata_json ?? {}),
          ).changes;
          counts.usageEvents += inserted;
          if (row.source_id === 'codex') restoredCodexEvents += inserted;
          if (row.source_id === 'claude') restoredClaudeEvents += inserted;
        } catch (error) {
          // Database errors may roll back the transaction. Continuing after
          // one would autocommit later records outside the failed restore.
          if (error?.code || !this.db.isTransaction) throw error;
          counts.skipped += 1;
        }
      }

      if (restoredCodexEvents) {
        // A pre-repair backup can restore duplicate token snapshots after the
        // source log's migration cursor was already completed. Recheck those
        // logs on the next scan using the collector's source proof and safety
        // backup; do not delete restored evidence here or disturb Claude cursors.
        // A Codex cursor is also known by its state, which only Codex writes, so
        // an archived rollout or a CODEX_HOME outside the profile is rechecked too.
        this.prepare(`UPDATE imported_files SET state_json = json_remove(state_json, '$.accountingVersion')
          WHERE (lower(replace(file_path, char(92), '/')) LIKE '%/.codex/sessions/%.jsonl'
              OR CASE WHEN json_valid(state_json) THEN json_type(state_json, '$.eventKeyVersion') END IS NOT NULL)
            AND CASE WHEN json_valid(state_json) THEN json_type(state_json, '$.accountingVersion') END IS NOT NULL`).run();
      }
      if (restoredClaudeEvents) {
        this.prepare(`UPDATE imported_files SET state_json = json_remove(state_json, '$.accountingVersion')
          WHERE CASE WHEN json_valid(state_json) THEN json_type(state_json, '$.accountingVersion') END IS NOT NULL
            AND (CASE WHEN json_valid(state_json) THEN json_extract(state_json, '$.collector') END = 'claude-transcript'
              OR lower(file_path) LIKE '%.claude%projects%.jsonl')`).run();
      }

      for (const row of list(payload.dailyUsage)) {
        try {
          const tokens = finiteNumber(row.tokens);
          if (!knownSources.has(row.source_id) || !isForecastDate(row.usage_date)
            || !Number.isSafeInteger(tokens) || tokens < 0) throw unreadable();
          counts.dailyUsage += insertDailyUsage.run(row.source_id, row.usage_date, tokens).changes;
        } catch (error) {
          // Database errors may roll back the transaction. Continuing after
          // one would autocommit later records outside the failed restore.
          if (error?.code || !this.db.isTransaction) throw error;
          counts.skipped += 1;
        }
      }

      for (const row of list(payload.prices)) {
        try {
          const values = [row.input_usd_per_million, row.cache_write_usd_per_million,
            row.cache_write_1h_usd_per_million ?? 0, row.cache_read_usd_per_million,
            row.output_usd_per_million].map(finiteNumber);
          const model = priceModelName(row.model);
          const effectiveFrom = priceEffectiveFrom(row.effective_from);
          // The URL is a convenience for the reader. One that cannot be kept
          // is dropped rather than costing a usable price row.
          const sourceUrl = priceSourceUrl(row.source_url) ?? null;
          if (!model || !effectiveFrom
            || values.some((value) => value == null || value < 0 || value > 1_000_000)) throw unreadable();
          counts.prices += insertPrice.run(model, ...values, effectiveFrom, sourceUrl).changes;
          this.prepare('UPDATE price_catalog SET is_seed = 0 WHERE model = ? AND is_seed = 1').run(model);
        } catch (error) {
          // Database errors may roll back the transaction. Continuing after
          // one would autocommit later records outside the failed restore.
          if (error?.code || !this.db.isTransaction) throw error;
          counts.skipped += 1;
        }
      }

      if (list(payload.desktopEstimates).length) {
        counts.desktopEstimates = 0;
        const models = require('./desktop-estimates.cjs').storedDesktopModels(this);
        for (const row of payload.desktopEstimates) {
          try {
            counts.desktopEstimates += require('./desktop-estimates.cjs').insertDesktopEstimate(this, row, models);
          } catch (error) {
            if (error?.code) throw error;
            counts.skipped += 1;
          }
        }
      }

      this.db.exec(`
        UPDATE sources SET last_observation_at = (
          SELECT MAX(observed_at) FROM quota_observations WHERE source_id = sources.id
        ) WHERE EXISTS (SELECT 1 FROM quota_observations WHERE source_id = sources.id)
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      // SQLite rolls back by itself on errors like SQLITE_FULL and SQLITE_IOERR,
      // after which an explicit ROLLBACK throws "no transaction is active" and
      // would replace the real failure with a meaningless one.
      try {
        this.db.exec('ROLLBACK');
      } catch { /* Already rolled back; the original error is the useful one. */ }
      throw error;
    }
    // Restored settings went in through the validators, but a corrupt row that
    // predates a validator still gets one last reconciliation, as on startup.
    this.repairSettings();
    return counts;
  }

  pruneBackups(retentionCount = DEFAULT_SETTINGS.backupRetentionCount, keepPath = null) {
    const keep = Math.max(1, Math.min(365, Number(retentionCount) || DEFAULT_SETTINGS.backupRetentionCount));
    const protectedPath = keepPath ? path.resolve(keepPath) : null;
    const rows = this.prepare('SELECT * FROM backups ORDER BY created_at DESC, id DESC').all();
    const root = path.resolve(this.backupDirectory);
    const removeFile = (filePath) => {
      if (!filePath) return true;
      const target = path.resolve(filePath);
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        return true;
      } catch {
        return false;
      }
    };
    let removed = 0;
    for (const row of rows.slice(keep)) {
      if (protectedPath && [row.database_path, row.export_path].some((value) => value && path.resolve(value) === protectedPath)) continue;
      const databaseRemoved = removeFile(row.database_path);
      const exportRemoved = removeFile(row.export_path);
      if (databaseRemoved && exportRemoved) {
        this.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
        removed += 1;
      }
    }
    return removed;
  }

  maybeCreateScheduledBackup() {
    const frequency = this.getSettings().backupFrequency;
    if (!frequency || frequency === 'off') return null;
    const intervals = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
    const interval = intervals[frequency] || intervals.daily;
    const attemptKey = 'maintenance.backup-attempt';
    const attempt = this.prepare('SELECT value_json FROM settings WHERE key = ?').get(attemptKey);
    if (attempt && Date.now() - Number(json(attempt.value_json, 0)) < 60 * 60_000) return null;
    const latest = this.prepare('SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1').get();
    if (latest && Date.now() - new Date(latest.created_at).getTime() < interval) return null;
    this.prepare('INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(attemptKey, JSON.stringify(Date.now()), iso());
    return this.createBackup();
  }
}

module.exports = { UsageStore, DEFAULT_SETTINGS };
