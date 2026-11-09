'use strict';

// Opening the database, its schema and every migration, and the rows a new
// database starts with.

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { FABLE_BUCKET_NAME } = require('../fable-projection.cjs');
const { PROVIDERS } = require('../providers.mjs');
const { LEGACY_FABLE_BUCKET_NAME, iso } = require('./shared.cjs');
const { DEFAULT_SETTINGS, SETTING_ALIASES } = require('./settings.cjs');
const { PRICE_ROWS } = require('./pricing.cjs');

// SQLITE_CORRUPT and SQLITE_NOTADB: the file exists but SQLite cannot read it.
const UNREADABLE_DATABASE_CODES = new Set([11, 26]);

/** @param {string} databasePath */
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
    if (databasePath === ':memory:' || !UNREADABLE_DATABASE_CODES.has(Number(/** @type {{ errcode?: number } | null | undefined} */ (error)?.errcode) & 0xff)) throw error;
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

/** @param {import('../store.cjs').Store} store */
function migrate(store) {
  require('../desktop-estimates.cjs').migrateDesktopEstimates(store.db);
  store.db.exec(`
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
        fetched_after TEXT,
        seen_since TEXT,
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
      -- Each Claude Code session the status-line helper has seen: its latest
      -- redraw, the fetch its limits came from, and the first redraw that
      -- showed them, so the next redraw of the same limits can be dated by
      -- that fetch rather than by itself.
      CREATE TABLE IF NOT EXISTS statusline_sessions (
        session_id TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL,
        api_ms REAL,
        limits_json TEXT NOT NULL DEFAULT '{}',
        fetched_after TEXT,
        seen_since TEXT
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        database_path TEXT NOT NULL,
        export_path TEXT NOT NULL
      );
    `);
  store.transaction(() => {
  const sourceColumns = new Set(/** @type {{ name: string }[]} */ (store.prepare('PRAGMA table_info(sources)').all()).map((row) => row.name));
  if (!sourceColumns.has('last_attempt_at')) store.db.exec('ALTER TABLE sources ADD COLUMN last_attempt_at TEXT;');
  if (!sourceColumns.has('last_success_at')) store.db.exec('ALTER TABLE sources ADD COLUMN last_success_at TEXT;');
  const usageColumns = new Set(/** @type {{ name: string }[]} */ (store.prepare('PRAGMA table_info(usage_events)').all()).map((row) => row.name));
  const addedCacheBreakdown = !usageColumns.has('cache_write_5m_input_tokens') || !usageColumns.has('cache_write_1h_input_tokens');
  if (!usageColumns.has('cache_write_5m_input_tokens')) store.db.exec('ALTER TABLE usage_events ADD COLUMN cache_write_5m_input_tokens INTEGER NOT NULL DEFAULT 0;');
  if (!usageColumns.has('cache_write_1h_input_tokens')) store.db.exec('ALTER TABLE usage_events ADD COLUMN cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0;');
  if (!usageColumns.has('project')) store.db.exec('ALTER TABLE usage_events ADD COLUMN project TEXT;');
  const importColumns = new Set(/** @type {{ name: string }[]} */ (store.prepare('PRAGMA table_info(imported_files)').all()).map((row) => row.name));
  if (!importColumns.has('state_json')) store.db.exec('ALTER TABLE imported_files ADD COLUMN state_json TEXT;');
  // Earlier status-line readings stay undated; nothing recorded their fetch.
  const quotaColumns = new Set(/** @type {{ name: string }[]} */ (store.prepare('PRAGMA table_info(quota_observations)').all()).map((row) => row.name));
  if (!quotaColumns.has('fetched_after')) store.db.exec('ALTER TABLE quota_observations ADD COLUMN fetched_after TEXT;');
  if (!quotaColumns.has('seen_since')) store.db.exec('ALTER TABLE quota_observations ADD COLUMN seen_since TEXT;');
  const sessionColumns = new Set(/** @type {{ name: string }[]} */ (store.prepare('PRAGMA table_info(statusline_sessions)').all()).map((row) => row.name));
  if (!sessionColumns.has('seen_since')) store.db.exec('ALTER TABLE statusline_sessions ADD COLUMN seen_since TEXT;');
  if (!usageColumns.has('project')) {
    // Project attribution is read from the same local transcripts as the
    // token counts. Rescanning them once fills the new column in place.
    store.prepare("DELETE FROM imported_files WHERE lower(file_path) LIKE '%.claude%projects%.jsonl' OR lower(file_path) LIKE '%.codex%sessions%.jsonl'").run();
  }
  for (const [oldKey, newKey] of Object.entries(SETTING_ALIASES)) {
    const legacy = /** @type {{ value_json: string } | undefined} */ (store.prepare('SELECT value_json FROM settings WHERE key = ?').get(oldKey));
    if (!legacy) continue;
    store.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(newKey, legacy.value_json, iso());
    store.prepare('DELETE FROM settings WHERE key = ?').run(oldKey);
  }
  const priceColumns = new Set(/** @type {{ name: string }[]} */ (store.prepare('PRAGMA table_info(price_catalog)').all()).map((row) => row.name));
  // Existing prices are user-owned; only newly seeded defaults yield to restores.
  if (!priceColumns.has('is_seed')) store.db.exec('ALTER TABLE price_catalog ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0;');
  store.addedOneHourPriceColumn = !priceColumns.has('cache_write_1h_usd_per_million');
  if (!priceColumns.has('cache_write_1h_usd_per_million')) store.db.exec('ALTER TABLE price_catalog ADD COLUMN cache_write_1h_usd_per_million REAL NOT NULL DEFAULT 0;');
  store.migrateAnalyticsRevisions();
  if (addedCacheBreakdown) {
    // Existing Claude transcript events did not retain cache TTL detail. Make
    // the next refresh rebuild them from the local source of truth.
    store.prepare("DELETE FROM imported_files WHERE lower(file_path) LIKE '%.claude%projects%.jsonl'").run();
  }
  const dateMigration = 'migration.quota-date-cleanup-v1';
  if (!store.prepare('SELECT 1 FROM settings WHERE key = ?').get(dateMigration)) {
  store.db.exec(`
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
  store.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)').run(dateMigration, 'true', iso());
  }
  });
  const fablePlanEvidenceMigration = 'migration.fable-plan-evidence-v1';
  if (!store.prepare('SELECT 1 FROM settings WHERE key = ?').get(fablePlanEvidenceMigration)) {
    // Claude's status-line payload has never contained a subscription/seat
    // classification. Earlier builds stamped those rows as Max and could
    // derive a half-pool Fable estimate from that invented fact. Keep the
    // official percentages, remove the false plan claim, and discard only
    // the reproducible derived cache so current evidence can rebuild it.
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.prepare("UPDATE quota_observations SET plan_type = NULL WHERE provenance = 'official-statusline'").run();
      store.prepare("DELETE FROM quota_observations WHERE provenance = 'derived-tokens'").run();
      store.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(fablePlanEvidenceMigration, 'true', iso());
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      throw error;
    }
  }
  const fableProjectionMigration = 'migration.fable-projection-v1';
  if (!store.prepare('SELECT 1 FROM settings WHERE key = ?').get(fableProjectionMigration)) {
    // The Fable estimate is projected when a snapshot is built and is no
    // longer stored. Rows written by earlier versions were computed under
    // settings and evidence that may since have changed; the projection
    // rebuilds the current figure from official readings alone.
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.prepare("DELETE FROM quota_observations WHERE provenance = 'derived-tokens'").run();
      store.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(fableProjectionMigration, 'true', iso());
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      throw error;
    }
  }
  const fableNameMigration = 'migration.fable-name-v1';
  if (!store.prepare('SELECT 1 FROM settings WHERE key = ?').get(fableNameMigration)) {
    // Fable 5 and Fable 5.1 share one allowance, which Claude reports as
    // "Fable". Earlier versions named the source and its bucket after Fable 5.
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.prepare("UPDATE sources SET name = 'Fable' WHERE id = 'claude-fable' AND name = 'Fable 5'").run();
      store.prepare("UPDATE quota_observations SET bucket_name = ? WHERE source_id = 'claude-fable' AND bucket_name = ?")
        .run(FABLE_BUCKET_NAME, LEGACY_FABLE_BUCKET_NAME);
      store.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(fableNameMigration, 'true', iso());
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      throw error;
    }
  }
  store.canonicaliseCodexManualRows();
}

/** @param {import('../store.cjs').Store} store */
function migrateAnalyticsRevisions(store) {
  // These revisions belong to the same SQLite transaction as their data.
  // They see collector-process writes and direct SQL, and roll back with
  // aborted imports. Status, cursor, backup and preference writes do not
  // invalidate unchanged ledger totals or cycle history.
  store.db.exec(`CREATE TABLE IF NOT EXISTS analytics_revisions (
      domain TEXT NOT NULL, source_id TEXT NOT NULL, bucket_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY(domain, source_id, bucket_id)
    ) WITHOUT ROWID;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS analytics_day_revisions(day TEXT PRIMARY KEY, revision INTEGER NOT NULL) WITHOUT ROWID;`);
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    const refs = action === 'UPDATE' ? ['OLD', 'NEW'] : [action === 'INSERT' ? 'NEW' : 'OLD'];
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS analytics_day_${action.toLowerCase()} AFTER ${action} ON usage_events BEGIN
        ${refs.map((ref) => `INSERT INTO analytics_day_revisions(day, revision) VALUES (substr(${ref}.occurred_at, 1, 10), 1)
          ON CONFLICT(day) DO UPDATE SET revision = revision + 1;`).join('\n')}
      END;`);
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS quota_compaction_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), through_at TEXT, dirty_at TEXT
    );
    INSERT OR IGNORE INTO quota_compaction_state(id, dirty_at) SELECT 1, MIN(observed_at) FROM quota_observations;
    CREATE TRIGGER IF NOT EXISTS compaction_insert AFTER INSERT ON quota_observations BEGIN
      UPDATE quota_compaction_state SET dirty_at = MIN(COALESCE(dirty_at, NEW.observed_at), NEW.observed_at) WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS compaction_update AFTER UPDATE ON quota_observations BEGIN
      UPDATE quota_compaction_state SET dirty_at = MIN(COALESCE(dirty_at, NEW.observed_at), NEW.observed_at, OLD.observed_at) WHERE id = 1;
    END;`);
  for (const [table, domain, scope] of /** @type {[string, string, string[]][]} */ ([
    ['usage_events', 'usage', ['source_id']],
    ['quota_observations', 'quota', ['source_id', 'bucket_id']],
    ['price_catalog', 'price', []],
  ])) {
    /**
     * @param {string} reference
     * @param {string | null} [condition]
     */
    const bump = (reference, condition = /** @type {string | null} */ (null)) => {
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
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS analytics_${table}_${action.toLowerCase()}
          AFTER ${action} ON ${table} BEGIN ${writes.join('\n')} END;`);
    }
  }
}

/** @param {import('../store.cjs').Store} store */
function canonicaliseCodexManualRows(store) {
  const official = /** @type {{ bucket_id: string } | undefined} */ (store.prepare(`
      SELECT bucket_id FROM quota_observations
      WHERE source_id = 'codex' AND bucket_id NOT IN ('manual-weekly', 'codex:weekly')
        AND COALESCE(window_minutes, 0) >= 10000
        AND json_valid(metadata_json) AND json_extract(metadata_json, '$.limitId') = 'codex'
      ORDER BY observed_at DESC, bucket_id ASC LIMIT 1
    `).get());
  const target = official?.bucket_id || 'codex:weekly';
  store.prepare(`UPDATE OR IGNORE quota_observations SET bucket_id = ?
      WHERE source_id = 'codex' AND bucket_id = 'manual-weekly'`).run(target);
  store.prepare(`DELETE FROM quota_observations
      WHERE source_id = 'codex' AND bucket_id = 'manual-weekly'`).run();
}

/** @param {import('../store.cjs').Store} store */
function seed(store) {
  const insertSource = store.prepare(`
      INSERT INTO sources(id, name, kind, status, metadata_json)
      VALUES (?, ?, ?, 'pending', '{}')
      ON CONFLICT(id) DO NOTHING
    `);
  for (const provider of PROVIDERS) insertSource.run(provider.id, provider.label, provider.kind);

  const insertSetting = store.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, JSON.stringify(value), iso());
  }

  const insertPrice = store.prepare(`
      INSERT INTO price_catalog(
        model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url, is_seed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(model) DO NOTHING
    `);
  for (const row of PRICE_ROWS) {
    // OpenAI rows sourced from the model's own page, with their effective
    // dates; the other OpenAI rows cite the comparison page.
    const openAiEffective = {
      'gpt-6-astra': '2026-09-04', 'gpt-6.1-sol': '2026-09-29', 'gpt-6.1-terra': '2026-10-26',
      'gpt-6-sol': '2026-09-22', 'gpt-6-luna': '2026-09-22',
    }[row[0]];
    const claudeEffective = {
      'claude-fable-5-1': '2026-09-01', 'claude-opus-5-5': '2026-09-22',
      'claude-sonnet-5-5': '2026-10-07', 'claude-haiku-5-5': '2026-10-07',
    }[row[0]];
    const source = openAiEffective
      ? `https://developers.openai.com/api/docs/models/${row[0]}`
      : row[0].startsWith('claude')
      ? 'https://platform.claude.com/docs/en/about-claude/pricing'
      : 'https://developers.openai.com/api/docs/models/compare';
    insertPrice.run(...row, openAiEffective ?? claudeEffective ?? '2026-08-01', source);
  }
  // Repair only the obsolete built-in Sonnet row. User-edited rows do not
  // match this complete old vector and are left alone.
  store.prepare(`UPDATE price_catalog SET input_usd_per_million = 2,
      cache_write_usd_per_million = 2.5, cache_write_1h_usd_per_million = 4,
      cache_read_usd_per_million = 0.2, output_usd_per_million = 10,
      effective_from = '2026-08-01'
      WHERE model = 'claude-sonnet-5' AND input_usd_per_million = 3
        AND cache_write_usd_per_million = 3.75 AND cache_read_usd_per_million = 0.3
        AND output_usd_per_million = 15`).run();
  if (store.addedOneHourPriceColumn) {
    const setOneHour = store.prepare(`UPDATE price_catalog
        SET cache_write_1h_usd_per_million = ?
        WHERE model = ? AND cache_write_1h_usd_per_million = 0`);
    for (const [model, , , oneHour] of PRICE_ROWS) setOneHour.run(oneHour, model);
  }
  store.repairSettings();
}

module.exports = { openDatabase, migrate, migrateAnalyticsRevisions, canonicaliseCodexManualRows, seed };
