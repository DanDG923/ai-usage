'use strict';

// Everything the collectors write: source status, allowance readings, usage
// events, daily totals and import cursors, plus the compaction of old readings.

/** @typedef {import('../types').IsoTime} IsoTime */
/** @typedef {import('../types').ObservationRow} ObservationRow */
/** @typedef {import('../types').ImportedFileRow} ImportedFileRow */
/** @typedef {import('../types').Reading & { id: number, original: ObservationRow }} CompactionRow A stored reading with its times as numbers. */

const { normaliseObservation, clusterByWindow } = require('../forecast.cjs');
const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS } = require('../quota-time.cjs');
const { KNOWN_SOURCE_IDS, DAY_MS, iso, validIso, optionalText, json, dateKey } = require('./shared.cjs');
const { isForecastDate } = require('./settings.cjs');

// Beyond this age, keep each local day's endpoints and peak per bucket/window.
// Provider rebounds must not erase the maximum shown in reset-cycle history.
const COMPACT_AFTER_MS = 60 * DAY_MS;

// Omitting metadata keeps whatever the source already had. A failure path
// reporting only a status must not erase facts it never gathered — the
// Enable/Disable helper control reads one of them.
/**
 * @param {import('../store.cjs').Store} store
 * @param {string} id
 * @param {string} status
 * @param {string | null} [detail]
 * @param {Record<string, unknown>} [metadata]
 * @param {{ scanSucceeded?: boolean }} [options]
 */
function setSourceStatus(store, id, status, detail, metadata, options = {}) {
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
    store.prepare(`UPDATE sources SET status = ?, status_detail = ?,
        last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at)
        WHERE id = ?`)
      .run(status, detail || null, attemptedAt, successfulAt, id);
    return;
  }
  store.prepare(`
      UPDATE sources
      SET status = ?, status_detail = ?, metadata_json = ?,
        last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at)
      WHERE id = ?
    `).run(status, detail || null, JSON.stringify(metadata), attemptedAt, successfulAt, id);
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {import('../types').ObservationInput} observation
 */
function recordObservation(store, observation) {
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
  /** @type {number | null} */
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
  // Only a status-line reading is dated by the fetch its session made; see
  // the Claude inbox import. Every other reading is evidence of its own time.
  // `seenSince` is the session's first redraw showing the same limits.
  /**
   * @param {IsoTime | null | undefined} value
   * @param {string} label
   */
  const statusLineTime = (value, label) => {
    if (value == null || provenance !== 'official-statusline') return null;
    const at = validIso(value, label);
    if (Date.parse(at) > Date.parse(observedAt)) throw new Error('Limits cannot be fetched after the reading that shows them.');
    return at;
  };
  const fetchedAfter = statusLineTime(observation.fetchedAfter, 'Fetch time');
  const seenSince = statusLineTime(observation.seenSince, 'First redraw time');
  if (observation.sourceId === 'codex' && observation.bucketId !== 'codex:weekly'
    && Number(observation.windowMinutes || 0) >= 10_000
    && observation.metadata?.limitId === 'codex'
    && observation.provenance !== 'manual-official') {
    store.prepare(`UPDATE OR IGNORE quota_observations SET bucket_id = ?
        WHERE source_id = 'codex' AND bucket_id IN ('manual-weekly', 'codex:weekly')`).run(observation.bucketId);
    store.prepare(`DELETE FROM quota_observations
        WHERE source_id = 'codex' AND bucket_id IN ('manual-weekly', 'codex:weekly')`).run();
  }
  // Values and provenance describe one reading and must be replaced together.
  // A generated estimate cannot displace a same-time official anchor. A
  // status-line line imported again (a re-read inbox) may no longer be
  // datable; it keeps the date its first import found. Another session's
  // redraw in the same millisecond is a different reading and never
  // inherits a fetch that was not its own.
  const sameStatusLineReading = `excluded.provenance = 'official-statusline' AND quota_observations.provenance = 'official-statusline'
          AND excluded.used_percent IS quota_observations.used_percent AND excluded.resets_at IS quota_observations.resets_at
          AND excluded.window_minutes IS quota_observations.window_minutes`;
  store.prepare(`
      INSERT INTO quota_observations(
        source_id, bucket_id, bucket_name, observed_at, used_percent, remaining_percent,
        resets_at, window_minutes, plan_type, provenance, confidence, metadata_json, fetched_after, seen_since
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, bucket_id, observed_at) DO UPDATE SET
        bucket_name = excluded.bucket_name,
        used_percent = excluded.used_percent,
        remaining_percent = excluded.remaining_percent,
        resets_at = excluded.resets_at,
        window_minutes = excluded.window_minutes,
        plan_type = excluded.plan_type,
        provenance = excluded.provenance,
        confidence = excluded.confidence,
        metadata_json = excluded.metadata_json,
        fetched_after = CASE WHEN ${sameStatusLineReading}
          THEN COALESCE(excluded.fetched_after, quota_observations.fetched_after) ELSE excluded.fetched_after END,
        seen_since = CASE WHEN ${sameStatusLineReading}
          THEN COALESCE(excluded.seen_since, quota_observations.seen_since) ELSE excluded.seen_since END
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
    fetchedAfter,
    seenSince,
  );
  store.prepare(`UPDATE sources SET last_observation_at = ?
      WHERE id = ? AND (last_observation_at IS NULL OR last_observation_at < ?)`)
    .run(observedAt, observation.sourceId, observedAt);
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {import('../types').UsageEventInput} event
 * @returns {number} How many rows the write changed.
 */
function recordUsageEvent(store, event) {
  if (!KNOWN_SOURCE_IDS.has(event.sourceId)) throw new Error(`Unknown source: ${event.sourceId || 'missing'}.`);
  if (typeof event.eventKey !== 'string' || !event.eventKey.trim()) throw new Error('Usage event key is required.');
  // Malformed JSON fields are rejected before SQLite binding. Coded SQLite
  // errors remain operational failures that must roll back the file cursor.
  const sessionId = optionalText(event.sessionId, 'Usage event session ID');
  const model = optionalText(event.model, 'Usage event model');
  const occurredAt = validIso(event.occurredAt, 'Event time');
  /** @param {unknown} value */
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
  const result = store.prepare(`
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

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @returns {string}
 */
function getManualBucketId(store, sourceId) {
  if (sourceId === 'claude') return 'seven_day';
  if (sourceId === 'claude-fable') return 'fable_seven_day';
  if (sourceId !== 'codex') return 'manual-weekly';
  const row = /** @type {{ bucket_id: string } | undefined} */ (store.prepare(`SELECT bucket_id FROM quota_observations
      WHERE source_id = 'codex' AND COALESCE(window_minutes, 0) >= 10000
        AND bucket_id NOT IN ('manual-weekly', 'codex:weekly')
        AND json_valid(metadata_json) AND json_extract(metadata_json, '$.limitId') = 'codex'
      ORDER BY observed_at DESC, bucket_id ASC LIMIT 1`).get());
  return row?.bucket_id || 'codex:weekly';
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @param {string} usageDate A calendar date, YYYY-MM-DD.
 * @param {number} tokens
 */
function upsertDailyUsage(store, sourceId, usageDate, tokens) {
  if (!KNOWN_SOURCE_IDS.has(sourceId) || !isForecastDate(usageDate) || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error('Invalid daily usage date or token count.');
  }
  store.prepare(`
      INSERT INTO account_daily_usage(source_id, usage_date, tokens) VALUES (?, ?, ?)
      ON CONFLICT(source_id, usage_date) DO UPDATE SET tokens = excluded.tokens
    `).run(sourceId, usageDate, tokens);
}

// `size_bytes` is the byte cursor: how much of the file has been consumed.
// `state` carries whatever an incremental reader needs to resume mid-file
// (the Codex reader's current model, for instance), so a growing transcript
// is parsed once, not once per refresh.
/**
 * @param {import('../store.cjs').Store} store
 * @param {string} filePath
 * @returns {(ImportedFileRow & { state: any }) | null} `state` is the reader's own JSON, in whatever shape it saved.
 */
function getImportedFile(store, filePath) {
  const row = /** @type {ImportedFileRow | undefined} */ (store.prepare('SELECT * FROM imported_files WHERE file_path = ?').get(filePath));
  if (!row) return null;
  return { ...row, state: json(row.state_json, null) };
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} filePath
 * @param {number} modifiedMs
 * @param {number} sizeBytes
 * @param {unknown} [state]
 */
function markImportedFile(store, filePath, modifiedMs, sizeBytes, state = /** @type {any} */ (null)) {
  store.prepare(`
      INSERT INTO imported_files(file_path, modified_ms, size_bytes, imported_at, state_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        modified_ms = excluded.modified_ms,
        size_bytes = excluded.size_bytes,
        imported_at = excluded.imported_at,
        state_json = excluded.state_json
    `).run(filePath, modifiedMs, sizeBytes, iso(), state == null ? null : JSON.stringify(state));
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} filePath
 */
function forgetImportedFile(store, filePath) {
  store.prepare('DELETE FROM imported_files WHERE file_path = ?').run(filePath);
}

// Housekeeping after a refresh: compact old polling rows so the table stops
// growing with the refresh interval. Manual readings are never touched.
/**
 * @param {import('../store.cjs').Store} store
 * @param {import('../types').Ms} [nowMs]
 */
function compactObservations(store, nowMs = Date.now()) {
  const edge = new Date(nowMs - COMPACT_AFTER_MS);
  edge.setHours(0, 0, 0, 0);
  const cutoff = iso(edge.getTime());
  return store.transaction(() => {
    const state = /** @type {{ through_at: IsoTime | null, dirty_at: IsoTime | null }} */ (
      store.prepare('SELECT * FROM quota_compaction_state WHERE id = 1').get());
    const lower = [state.through_at, state.dirty_at].filter(Boolean).sort()[0];
    if (!lower || lower >= cutoff) return { removed: 0, cutoff };
    const from = new Date(lower); from.setHours(0, 0, 0, 0);
    /** @type {Map<string, CompactionRow[]>} */
    const buckets = new Map();
    for (const row of /** @type {IterableIterator<ObservationRow & { id: number }>} */ (
      store.prepare('SELECT * FROM quota_observations WHERE observed_at >= ? AND observed_at < ? ORDER BY observed_at, id')
      .iterate(iso(from.getTime()), cutoff))) {
      const key = JSON.stringify([row.source_id, row.bucket_id, row.window_minutes]);
      if (!buckets.has(key)) buckets.set(key, []);
      // The line above put a list there if there was none.
      /** @type {CompactionRow[]} */ (buckets.get(key)).push({ ...normaliseObservation(row), id: row.id, original: row });
    }
    let removed = 0;
    const remove = store.prepare('DELETE FROM quota_observations WHERE id = ?');
    // Resolved once: the first compaction after an upgrade or a restore
    // scans all history, and a per-row zone lookup built a formatter each time.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const rows of buckets.values()) {
      for (const cluster of clusterByWindow(rows)) {
        /** @type {Map<string, CompactionRow[]>} */
        const days = new Map();
        for (const row of cluster.rows) {
          const day = dateKey(row.observedAt, timeZone);
          if (!days.has(day)) days.set(day, []);
          // The line above put a list there if there was none.
          /** @type {CompactionRow[]} */ (days.get(day)).push(row);
        }
        for (const day of days.values()) {
          const peak = day.reduce((best, row) => row.usedPercent >= best.usedPercent ? row : best);
          // A day is only in the map with at least one row, so it has a last one.
          const keep = new Set([day[0].id, /** @type {CompactionRow} */ (day.at(-1)).id, peak.id]);
          for (const row of day) if (!keep.has(row.id) && row.provenance !== 'manual-official') removed += remove.run(row.id).changes;
        }
      }
    }
    store.prepare('UPDATE quota_compaction_state SET through_at = ?, dirty_at = NULL WHERE id = 1').run(cutoff);
    return { removed, cutoff };
  });
}

module.exports = {
  setSourceStatus, recordObservation, recordUsageEvent, getManualBucketId, upsertDailyUsage, getImportedFile,
  markImportedFile, forgetImportedFile, compactObservations,
};
