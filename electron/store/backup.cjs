'use strict';

// Backups: writing them, reading them back, merging one into the live
// database, pruning old sets and the daily schedule.

/** @typedef {import('../types').IsoTime} IsoTime */
/** @typedef {import('../types').Ms} Ms */
/** @typedef {Record<string, any>} RestoreRow One record of a backup. Nothing in it has been checked; the restore tests each field it reads. */
/**
 * What a restore merges: a JSON export as parsed from disk, or a SQLite
 * backup read into the same shape (see readDatabaseBackup). Its record lists
 * are arrays in an export and row iterators in a SQLite backup, and nothing
 * in it has been checked: restoreFromExport validates it field by field.
 * @typedef {Record<string, any>} RestorePayload
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MAX_QUOTA_RESET_AHEAD_MS, validQuotaTime } = require('../quota-time.cjs');
const { SOURCE_DEFINITIONS, DAY_MS, iso, validIso, json, quotaMetadata } = require('./shared.cjs');
const {
  DEFAULT_SETTINGS, SETTING_ALIASES, isForecastDate, normalizedSetting, settingValidator, backupSettings,
  storedSettings,
} = require('./settings.cjs');
const { priceModelName, priceEffectiveFrom, priceSourceUrl } = require('./pricing.cjs');

// When the last scheduled backup was tried, so a failing one is retried hourly.
const BACKUP_ATTEMPT_KEY = 'maintenance.backup-attempt';

// `keep` names a backup file this run must not prune — the one the caller is
// about to restore from. Opening a restore point should never delete it.
// `exportJson: false` writes the SQLite copy alone. The JSON export is also
// skipped once it outgrows what readExport accepts: the SQLite copy
// restores a ledger of any size, and the export would only cost time.
/**
 * @param {import('../store.cjs').Store} store
 * @param {{ exportJson?: boolean, keep?: string | null }} [options]
 */
function createBackup(store, options = {}) {
  const stamp = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${require('node:crypto').randomUUID()}`;
  const databasePath = path.join(store.backupDirectory, `ai-usage-${stamp}.sqlite`);
  const exportPath = path.join(store.backupDirectory, `ai-usage-${stamp}.aiusage.json.gz`);
  const partialDatabase = `${databasePath}.partial`, partialExport = `${exportPath}.partial`;
  let exported = options.exportJson !== false;
  // The folder is shown in Settings and can be deleted while the app runs.
  fs.mkdirSync(store.backupDirectory, { recursive: true });
  store.sweepPartialBackups();
  try {
    store.db.prepare('VACUUM INTO ?').run(partialDatabase);
    if (exported) {
      const { writeExport, MAX_RESTORE_BYTES } = require('../backup-export.cjs');
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
    store.prepare('INSERT INTO backups(created_at, database_path, export_path) VALUES (?, ?, ?)')
      .run(iso(), databasePath, exported ? exportPath : '');
  } catch (error) {
    for (const file of [partialDatabase, partialExport, databasePath, exportPath]) {
      try { fs.unlinkSync(file); } catch { /* A later partial sweep retries locked files. */ }
    }
    throw error;
  }
  store.pruneBackups(store.getSettings().backupRetentionCount, options.keep);
  return { databasePath, exportPath: exported ? exportPath : null };
}

// Reading is a separate step so a caller can load the export into memory
// before taking its own backup: creating one prunes old sets, and the file
// the user chose from the backup folder can be among them.
/**
 * @param {import('../store.cjs').Store} store
 * @param {string} filePath
 * @returns {RestorePayload}
 */
function readExport(store, filePath) {
  if (/\.sqlite$/i.test(String(filePath || ''))) return store.readDatabaseBackup(filePath);
  return require('../backup-export.cjs').readExport(filePath);
}

// A SQLite backup restores a ledger of any size: its records are read as
// the merge consumes them, in the export's shape, so restoreFromExport
// applies the same validation and merge rules. The caller calls close().
/**
 * @param {import('../store.cjs').Store} store
 * @param {string} filePath
 * @returns {RestorePayload}
 */
function readDatabaseBackup(store, filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('That backup file could not be found.');
  /** @type {DatabaseSync | undefined} */
  let database;
  try {
    database = new DatabaseSync(filePath, { readOnly: true });
    const tables = new Set(/** @type {{ name: string }[]} */ (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name));
    if (!['settings', 'quota_observations', 'usage_events'].every((table) => tables.has(table))) throw new Error('Not an AI Usage database.');
    // On the two casts below: `database` was opened above and is never reassigned.
    /** @param {string} table */
    const rows = (table) => (tables.has(table) ? /** @type {DatabaseSync} */ (database).prepare(`SELECT * FROM ${table}`).iterate() : []);
    return {
      schemaVersion: 1,
      settings: storedSettings(database),
      observations: rows('quota_observations'),
      usageEvents: rows('usage_events'),
      dailyUsage: rows('account_daily_usage'),
      prices: [...rows('price_catalog')],
      desktopEstimates: [...rows('desktop_chat_estimates')],
      close: () => /** @type {DatabaseSync} */ (database).close(),
    };
  } catch {
    try { database?.close(); } catch { /* Report the unreadable file instead. */ }
    throw new Error('That file is not a readable AI Usage backup.');
  }
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {Ms} [nowMs]
 */
function sweepPartialBackups(store, nowMs = Date.now()) {
  // Missing registrations can mean database recovery, not failed backups.
  // Completed files may be the only remaining history; only partials are disposable.
  for (const entry of fs.readdirSync(store.backupDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^ai-usage-\d{4}-\d{2}-\d{2}T[\dZ-]+-[\da-f-]{36}\.(?:sqlite|aiusage\.json\.gz)\.partial$/.test(entry.name)) continue;
    const file = path.join(store.backupDirectory, entry.name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs <= DAY_MS) continue;
      fs.unlinkSync(file);
    } catch { /* Retry next maintenance. */ }
  }
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} filePath
 */
function restoreFromBackup(store, filePath) {
  const payload = store.readExport(filePath);
  try {
    return store.restoreFromExport(payload);
  } finally { payload.close?.(); }
}

// A backup nothing can read back is not a backup. Restore merges an export
// into the live database rather than replacing it: for every table of
// records, rows already present win, so restoring onto a partly collected
// database can neither double count nor overwrite newer data. Settings are
// the exception — they are replaced, and reported separately so the caller
// can say so. Records the export cannot supply validly are skipped and
// counted, never guessed, and one bad row never costs the others.
/**
 * @param {import('../store.cjs').Store} store
 * @param {RestorePayload} payload
 * @returns {import('../../src/types').RestoreCounts}
 */
function restoreFromExport(store, payload) {
  const nowMs = Date.now();
  const unreadable = () => new Error('That file is not a readable AI Usage export.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw unreadable();
  const schemaVersion = Number(payload.schemaVersion);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1) throw unreadable();
  if (schemaVersion > 1) throw new Error(`This backup was written by a newer version of AI Usage (schema ${schemaVersion}).`);
  // Arrays from a JSON export, or row iterators from a SQLite backup.
  /**
   * @param {any} value
   * @returns {Iterable<RestoreRow> & { length?: number }}
   */
  const list = (value) => (Array.isArray(value)
    || (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') ? value : []);
  const knownSources = new Set(SOURCE_DEFINITIONS.map(([id]) => id));
  /** @type {import('../../src/types').RestoreCounts} */
  const counts = { settings: 0, observations: 0, usageEvents: 0, dailyUsage: 0, prices: 0, skipped: 0 };
  let restoredCodexEvents = 0;
  let restoredClaudeEvents = 0;

  const insertObservation = store.prepare(`
      INSERT OR IGNORE INTO quota_observations(
        source_id, bucket_id, bucket_name, observed_at, used_percent, remaining_percent,
        resets_at, window_minutes, plan_type, provenance, confidence, metadata_json, fetched_after, seen_since
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  const insertEvent = store.prepare(`
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
  const insertDailyUsage = store.prepare(`
      INSERT INTO account_daily_usage(source_id, usage_date, tokens) VALUES (?, ?, ?)
      ON CONFLICT(source_id, usage_date) DO NOTHING
    `);
  const insertPrice = store.prepare(`
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
  const setSetting = store.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
  /** @param {unknown} value */
  const finiteNumber = (value) => {
    // Number(null), Number(''), Number(false) and Number([]) are all 0, so
    // coercing first would accept those as a legitimate zero.
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  try {
    store.db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    throw new Error(`The database was busy and the restore did not start: ${error.message}`);
  }
  try {
    const exported = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    // Validate every key first, then check the cross-field schedule rule
    // against what would actually be written. Testing it against the raw
    // export let a rejected end hour vouch for a start hour that then
    // outlived it, leaving a start-after-end schedule updateSettings refuses.
    /** @type {Record<string, unknown>} */
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
    const merged = { ...store.getSettings(), ...accepted };
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
        // A backup from before readings were dated, or an unusable date,
        // restores the reading undated rather than not at all.
        /** @param {unknown} value */
        const statusLineTime = (value) => {
          const ms = provenance === 'official-statusline' && typeof value === 'string' ? Date.parse(value) : Number.NaN;
          return Number.isFinite(ms) && ms <= Date.parse(observedAt) ? iso(ms) : null;
        };
        counts.observations += insertObservation.run(
          row.source_id, row.bucket_id, typeof row.bucket_name === 'string' ? row.bucket_name : null,
          observedAt, usedPercent, remainingPercent, resetsAt,
          windowMinutes, planType, provenance, confidence,
          JSON.stringify(metadata), statusLineTime(row.fetched_after), statusLineTime(row.seen_since),
        ).changes;
      } catch (error) {
        // Database errors may roll back the transaction. Continuing after
        // one would autocommit later records outside the failed restore.
        if (error?.code || !store.db.isTransaction) throw error;
        counts.skipped += 1;
      }
    }

    for (const row of list(payload.usageEvents)) {
      try {
        if (!knownSources.has(row.source_id) || typeof row.event_key !== 'string' || !row.event_key) throw unreadable();
        /** @param {unknown} value */
        const tokens = (value) => {
          const parsed = value == null ? 0 : finiteNumber(value);
          if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0) throw unreadable();
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
        if (error?.code || !store.db.isTransaction) throw error;
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
      store.prepare(`UPDATE imported_files SET state_json = json_remove(state_json, '$.accountingVersion')
          WHERE (lower(replace(file_path, char(92), '/')) LIKE '%/.codex/sessions/%.jsonl'
              OR CASE WHEN json_valid(state_json) THEN json_type(state_json, '$.eventKeyVersion') END IS NOT NULL)
            AND CASE WHEN json_valid(state_json) THEN json_type(state_json, '$.accountingVersion') END IS NOT NULL`).run();
    }
    if (restoredClaudeEvents) {
      store.prepare(`UPDATE imported_files SET state_json = json_remove(state_json, '$.accountingVersion')
          WHERE CASE WHEN json_valid(state_json) THEN json_type(state_json, '$.accountingVersion') END IS NOT NULL
            AND (CASE WHEN json_valid(state_json) THEN json_extract(state_json, '$.collector') END = 'claude-transcript'
              OR lower(file_path) LIKE '%.claude%projects%.jsonl')`).run();
    }

    for (const row of list(payload.dailyUsage)) {
      try {
        const tokens = finiteNumber(row.tokens);
        if (!knownSources.has(row.source_id) || !isForecastDate(row.usage_date)
          || tokens === null || !Number.isSafeInteger(tokens) || tokens < 0) throw unreadable();
        counts.dailyUsage += insertDailyUsage.run(row.source_id, row.usage_date, tokens).changes;
      } catch (error) {
        // Database errors may roll back the transaction. Continuing after
        // one would autocommit later records outside the failed restore.
        if (error?.code || !store.db.isTransaction) throw error;
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
        store.prepare('UPDATE price_catalog SET is_seed = 0 WHERE model = ? AND is_seed = 1').run(model);
      } catch (error) {
        // Database errors may roll back the transaction. Continuing after
        // one would autocommit later records outside the failed restore.
        if (error?.code || !store.db.isTransaction) throw error;
        counts.skipped += 1;
      }
    }

    if (list(payload.desktopEstimates).length) {
      counts.desktopEstimates = 0;
      const models = require('../desktop-estimates.cjs').storedDesktopModels(store);
      for (const row of payload.desktopEstimates) {
        try {
          counts.desktopEstimates += require('../desktop-estimates.cjs').insertDesktopEstimate(store, row, models);
        } catch (error) {
          if (error?.code) throw error;
          counts.skipped += 1;
        }
      }
    }

    store.db.exec(`
        UPDATE sources SET last_observation_at = (
          SELECT MAX(observed_at) FROM quota_observations WHERE source_id = sources.id
        ) WHERE EXISTS (SELECT 1 FROM quota_observations WHERE source_id = sources.id)
      `);
    store.db.exec('COMMIT');
  } catch (error) {
    // SQLite rolls back by itself on errors like SQLITE_FULL and SQLITE_IOERR,
    // after which an explicit ROLLBACK throws "no transaction is active" and
    // would replace the real failure with a meaningless one.
    try {
      store.db.exec('ROLLBACK');
    } catch { /* Already rolled back; the original error is the useful one. */ }
    throw error;
  }
  // Restored settings went in through the validators, but a corrupt row that
  // predates a validator still gets one last reconciliation, as on startup.
  store.repairSettings();
  return counts;
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {number} [retentionCount]
 * @param {string | null} [keepPath]
 * @returns {number} How many backup sets were removed.
 */
function pruneBackups(store, retentionCount = DEFAULT_SETTINGS.backupRetentionCount, keepPath = /** @type {string | null} */ (null)) {
  const keep = Math.max(1, Math.min(365, Number(retentionCount) || DEFAULT_SETTINGS.backupRetentionCount));
  const protectedPath = keepPath ? path.resolve(keepPath) : null;
  const rows = /** @type {import('../types').BackupRow[]} */ (store.prepare('SELECT * FROM backups ORDER BY created_at DESC, id DESC').all());
  const root = path.resolve(store.backupDirectory);
  /** @param {string} filePath */
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
      store.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
      removed += 1;
    }
  }
  return removed;
}

// Whether a scheduled backup is due, without writing anything. The window
// process asks this after every collection, so the storage worker is only
// started when there is a backup to make.
/**
 * @param {import('../store.cjs').Store} store
 * @param {Ms} [nowMs]
 */
function scheduledBackupDue(store, nowMs = Date.now()) {
  const frequency = store.getSettings().backupFrequency;
  if (!frequency || frequency === 'off') return false;
  /** @type {Record<string, number>} */
  const intervals = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
  const interval = intervals[frequency] || intervals.daily;
  const attempt = /** @type {{ value_json: string } | undefined} */ (store.prepare('SELECT value_json FROM settings WHERE key = ?').get(BACKUP_ATTEMPT_KEY));
  if (attempt && nowMs - Number(json(attempt.value_json, 0)) < 60 * 60_000) return false;
  const latest = /** @type {{ created_at: IsoTime } | undefined} */ (store.prepare('SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1').get());
  return !(latest && nowMs - new Date(latest.created_at).getTime() < interval);
}

/** @param {import('../store.cjs').Store} store */
function maybeCreateScheduledBackup(store) {
  if (!store.scheduledBackupDue()) return null;
  store.prepare('INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
    .run(BACKUP_ATTEMPT_KEY, JSON.stringify(Date.now()), iso());
  return store.createBackup();
}

module.exports = {
  createBackup, readExport, readDatabaseBackup, sweepPartialBackups, restoreFromBackup, restoreFromExport,
  pruneBackups, scheduledBackupDue, maybeCreateScheduledBackup,
};
