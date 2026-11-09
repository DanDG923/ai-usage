'use strict';

const fs = require('node:fs');
const { claudeAgentMetadata } = require('./task-usage.cjs');
const path = require('node:path');
const { findClaudeBinary, providerHome } = require('./provider-executable.cjs');
const { createClaudeAgentSdkUsagePort } = require('./claude-agent-usage.cjs');
const { createFableUsageTracker, providerReadingFresh } = require('./fable-tracker.cjs');
const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS, validQuotaTime } = require('./quota-time.cjs');
const { CLAUDE, FABLE } = require('./providers.mjs');
const { isProviderProvenance } = require('./quota-provenance.mjs');
const { deriveFableEstimate } = require('./fable-projection.cjs');
const { evidenceTimes, freshReadGraceFor, latestEvidenceAt, withoutStaleRestatements } = require('./forecast.cjs');
const { IncrementalReadError, planIncrementalRead, readCompleteLines } = require('./incremental-file.cjs');
const { asIso, epochToIso } = require('./time.cjs');
const { claudeWindowDescriptor } = require('./claude-window-descriptors.cjs');

/** @typedef {import('./types').Store} Store */
/** @typedef {import('./types').IsoTime} IsoTime */
/** @typedef {import('./types').Ms} Ms */
/** @typedef {import('./types').ObservationRow} ObservationRow */
/** @typedef {import('./types').UsageEventRow} UsageEventRow */
/** @typedef {import('./types').StatuslineSessionRow} StatuslineSessionRow */
/** @typedef {import('./types').ImportedFileRow} ImportedFileRow */

/**
 * What an import of status-line readings did.
 * @typedef {object} InboxResult
 * @property {number} snapshots
 * @property {number} usageEvents
 * @property {number} observations
 * @property {number} claudeObservations
 * @property {number} fableObservations
 * @property {number} invalidRecords
 * @property {number} invalidResets
 * @property {number} rejectedRecords
 * @property {number} readErrors
 * @property {number} bytesRead
 * @property {IsoTime | null} latestObservationAt
 * @property {IsoTime | null} latestClaudeObservedAt
 * @property {IsoTime | null} latestFableObservedAt
 */

/**
 * One window of a status-line payload as it is compared between redraws: its
 * reading and reset, or the marker for a window the store would reject.
 * @typedef {[used: number, resetsAt: IsoTime] | 'unreadable'} WindowReading
 */

/** @typedef {Record<string, WindowReading>} StatusLineLimits */

/**
 * The bounds on when a session fetched the limits a redraw shows.
 * @typedef {{ fetchedAfter: IsoTime | null, seenSince: IsoTime | null }} FetchDating
 */

/**
 * A usage event built from a transcript message.
 * @typedef {import('./types').UsageEventInput & { metadata: Record<string, unknown> }} TranscriptUsageEvent
 */

/** @typedef {ReturnType<typeof usageRowFields>} TranscriptRow */

/**
 * What an import of Claude Code transcripts did.
 * @typedef {object} TranscriptImportSummary
 * @property {number} importedFiles
 * @property {number} usageEvents
 * @property {number} fableEvents
 * @property {number} [repairedEvents]
 * @property {ReturnType<Store['createBackup']> | null} [reconciliationBackup] The safety copy made before a repair, if one was needed.
 * @property {number} filesFound
 * @property {number} rejectedRows
 * @property {string | null} lastRejection
 * @property {number} readErrors
 * @property {string | null} lastReadError
 */

/**
 * A Claude window's reading, with the columns the freshness check reads.
 * @typedef {Required<Pick<ObservationRow, 'id'>> & Pick<ObservationRow, 'bucket_id' | 'observed_at' | 'resets_at' | 'window_minutes'
 *   | 'used_percent' | 'remaining_percent' | 'provenance' | 'fetched_after' | 'seen_since'>} PlanWindowRow
 */

/**
 * The latest accepted reading of one window, dated by its evidence.
 * @typedef {PlanWindowRow & { evidence_at: IsoTime, own_evidence_at: IsoTime, plan_read_ms: Ms | null }} PlanWindowReading
 */

/** @typedef {import('./fable-tracker.cjs').FableTracking} FableTracking */

/**
 * A plan-usage read the user asked for, as the source's metadata keeps it.
 * @typedef {{ at: IsoTime, succeeded?: boolean, fableCurrent?: boolean, provider?: FableTracking['provider'] | null }} PlanUsageRequest
 */

const MAX_INBOX_BYTES = 2 * 1024 * 1024;

/**
 * @template {object} T
 * @param {T} [overrides]
 * @returns {InboxResult & T}
 */
function emptyInboxResult(overrides = /** @type {T} */ ({})) {
  return {
    snapshots: 0,
    usageEvents: 0,
    observations: 0,
    claudeObservations: 0,
    fableObservations: 0,
    invalidRecords: 0,
    invalidResets: 0,
    rejectedRecords: 0,
    readErrors: 0,
    bytesRead: 0,
    latestObservationAt: null,
    latestClaudeObservedAt: null,
    latestFableObservedAt: null,
    ...overrides,
  };
}

/**
 * @param {IsoTime | null | undefined} left
 * @param {IsoTime | null | undefined} right
 * @returns {IsoTime | null}
 */
function laterIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

// A window's reading and reset as the store would record them, or null for
// one it would reject: not an object, no reading, a reading outside 0–100
// (a spend limit can pass 100), or a reset out of range.
const UNREADABLE = 'unreadable';
/**
 * @param {any} limit One window of a status-line payload.
 * @param {IsoTime} capturedAt
 * @returns {[used: number, resetsAt: IsoTime] | null}
 */
function recordableWindow(limit, capturedAt) {
  if (!limit || typeof limit !== 'object' || Array.isArray(limit) || limit.used_percentage == null) return null;
  const used = Number(limit.used_percentage);
  const resetsAt = epochToIso(limit.resets_at);
  if (!Number.isFinite(used) || used < 0 || used > 100 || !resetsAt) return null;
  const ahead = Date.parse(resetsAt) - Date.parse(capturedAt);
  return ahead >= -5 * 60_000 && ahead <= MAX_QUOTA_RESET_AHEAD_MS ? [used, resetsAt] : null;
}

// Each window, by name, to tell one response's limits from the next. A
// window the store would reject is kept as unreadable rather than dropped:
// it tells nothing about a response, and must not make the next redraw that
// shows it readable again look like a new one.
/**
 * @param {unknown} rateLimits The `rate_limits` of a status-line payload.
 * @param {IsoTime} capturedAt
 */
function statusLineLimits(rateLimits, capturedAt) {
  /** @type {StatusLineLimits} */
  const limits = {};
  if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) return limits;
  for (const [key, limit] of Object.entries(rateLimits)) {
    if (limit != null) limits[key] = recordableWindow(limit, capturedAt) ?? UNREADABLE;
  }
  return limits;
}
const readableWindow = (/** @type {unknown} */ value) => Array.isArray(value);
const sameWindow = (/** @type {WindowReading} */ a, /** @type {WindowReading} */ b) => (readableWindow(a) && readableWindow(b) ? a[0] === b[0] && a[1] === b[1] : a === b);

// Claude Code redraws its status line after each response and, at the
// interval the helper is installed with, every minute in between, always
// with the limits of the session's latest response. The payload does not say
// when those limits were fetched, so an idle session re-records old limits as
// if they were new. A session's API time grows only when a response arrives,
// and its limits change only with one. A redraw that shows a new response was
// therefore fetched after the session's previous redraw; one that shows the
// same limits keeps that date. A window Claude Code drops at its reset is not
// a response. Every redraw of one fetch also carries the first redraw that
// showed it (`seenSince`), which bounds the fetch from the other side. A
// session first seen with limits in hand cannot be dated (it began before the
// helper recorded sessions), but its redraws still share that first redraw,
// so an idle session cannot renew its own evidence. Every session's opening
// redraw has no limits, because they arrive with its first response.
/**
 * @param {Store} store
 * @param {Record<string, any>} payload A status-line payload.
 * @param {IsoTime} capturedAt
 * @returns {FetchDating}
 */
function datedStatusLineFetch(store, payload, capturedAt) {
  const undated = { fetchedAfter: null, seenSince: null };
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!sessionId) return undated;
  const apiMs = typeof payload.api_ms === 'number' && Number.isFinite(payload.api_ms) ? payload.api_ms : null;
  const limits = statusLineLimits(payload.rate_limits, capturedAt);
  const previous = /** @type {Omit<StatuslineSessionRow, 'session_id'> | undefined} */ (
    store.prepare('SELECT seen_at, api_ms, limits_json, fetched_after, seen_since FROM statusline_sessions WHERE session_id = ?').get(sessionId));
  // What the session's previous redraw stored.
  /** @type {StatusLineLimits} */
  let before = {};
  try { before = previous ? JSON.parse(previous.limits_json) : {}; } catch { /* Undated below. */ }
  const sameLimits = (/** @type {StatusLineLimits} */ a, /** @type {StatusLineLimits} */ b) => Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([key, value]) => key in b && sameWindow(value, b[key]));
  // A line imported again, or late: it shares the session's latest fetch only
  // if nothing has changed since, and cannot move the session backwards.
  if (previous && capturedAt <= previous.seen_at) {
    const same = sameLimits(limits, before) && apiMs === previous.api_ms;
    const shared = (/** @type {IsoTime | null} */ value) => (same && value && value <= capturedAt ? value : null);
    return { fetchedAfter: shared(previous.fetched_after), seenSince: shared(previous.seen_since) };
  }
  /** @type {IsoTime | null} */
  let fetchedAfter = null;
  /** @type {IsoTime | null} */
  let seenSince = null;
  if (Object.keys(limits).length) {
    // A readable window that is new, or that changed from a readable one, came
    // with a response; one that was unreadable before shows nothing either way.
    const newResponse = previous && ((apiMs != null && previous.api_ms != null && apiMs > previous.api_ms)
      || Object.entries(limits).some(([key, value]) => readableWindow(value)
        && (!(key in before) || (readableWindow(before[key]) && !sameWindow(value, before[key])))));
    if (newResponse) {
      fetchedAfter = previous.seen_at;
      seenSince = capturedAt;
    } else if (previous) {
      fetchedAfter = previous.fetched_after;
      seenSince = previous.seen_since;
    } else {
      seenSince = capturedAt;
    }
  }
  store.prepare(`INSERT INTO statusline_sessions(session_id, seen_at, api_ms, limits_json, fetched_after, seen_since) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET seen_at = excluded.seen_at, api_ms = excluded.api_ms,
      limits_json = excluded.limits_json, fetched_after = excluded.fetched_after, seen_since = excluded.seen_since`)
    .run(sessionId, capturedAt, apiMs, JSON.stringify(limits), fetchedAfter, seenSince);
  return { fetchedAfter, seenSince };
}

// Records every window of one status-line payload (a helper redraw or a
// Claude Code mod reading) as official status-line observations, dated by the
// fetch that delivered them, and counts them into `result`.
/**
 * @param {Store} store
 * @param {Record<string, any>} payload A status-line payload whose `rate_limits` is an object.
 * @param {IsoTime} capturedAt
 * @param {FetchDating} dating
 * @param {InboxResult} result Counted into.
 * @param {Record<string, unknown>} [extraMetadata]
 */
function recordStatusLineLimits(store, payload, capturedAt, { fetchedAfter, seenSince }, result, extraMetadata = {}) {
  const model = payload.model?.id || payload.model?.display_name || 'claude-unknown';
  const limits = payload.rate_limits;
  for (const [key, limit] of Object.entries(limits)) {
    if (!limit || limit.used_percentage == null || limit.resets_at == null) continue;
    const isFable = key.toLowerCase().includes('fable');
    const sourceId = isFable ? FABLE.id : CLAUDE.id;
    const descriptor = claudeWindowDescriptor(key);
    const minutes = isFable ? 10_080 : descriptor.windowMinutes;
    const bucketName = isFable ? FABLE.weeklyBucketName : descriptor.bucketName;
    const resetsAt = epochToIso(limit.resets_at);
    if (!resetsAt) {
      result.invalidResets += 1;
      continue;
    }
    try {
      store.recordObservation({
        sourceId,
        bucketId: isFable && [FABLE.weeklyBucket, 'fable_weekly'].includes(key.toLowerCase()) ? FABLE.weeklyBucket : isFable ? `fable:${key}` : key,
        bucketName,
        observedAt: capturedAt,
        usedPercent: Number(limit.used_percentage),
        remainingPercent: 100 - Number(limit.used_percentage),
        resetsAt,
        windowMinutes: minutes,
        // The documented status-line payload has no subscription/seat type.
        // Exact percentages are official; a Max-plan assertion would not be.
        planType: null,
        provenance: 'official-statusline',
        confidence: 1,
        metadata: { model, sharedWithOverall: isFable, ...extraMetadata },
        fetchedAfter,
        seenSince,
      });
    } catch (error) {
      if (error?.code) throw error;
      result.rejectedRecords += 1;
      continue;
    }
    result.observations += 1;
    result.latestObservationAt = laterIso(result.latestObservationAt, capturedAt);
    if (isFable) {
      result.fableObservations += 1;
      result.latestFableObservedAt = laterIso(result.latestFableObservedAt, capturedAt);
    } else {
      result.claudeObservations += 1;
      result.latestClaudeObservedAt = laterIso(result.latestClaudeObservedAt, capturedAt);
    }
  }
}

/**
 * @param {Store} store
 * @param {string} inboxPath
 * @param {{ rotations: string[] } | null} [state] Kept with the file's cursor.
 */
function importClaudeInboxFile(store, inboxPath, state = /** @type {any} */ (null)) {
  if (!fs.existsSync(inboxPath)) return emptyInboxResult();
  let stat;
  try {
    stat = fs.statSync(inboxPath);
  } catch {
    return emptyInboxResult({ readErrors: 1 });
  }
  const previous = store.getImportedFile(inboxPath);
  if (previous && previous.modified_ms === stat.mtimeMs && previous.size_bytes === stat.size) {
    return emptyInboxResult();
  }
  const sameSizeWasRewritten = previous && previous.size_bytes === stat.size && previous.modified_ms !== stat.mtimeMs;
  const startOffset = previous && stat.size >= previous.size_bytes && !sameSizeWasRewritten ? previous.size_bytes : 0;
  let chunk;
  try { chunk = readCompleteLines(inboxPath, startOffset, stat.size); }
  catch { return emptyInboxResult({ readErrors: 1 }); }
  const { lines, consumedBytes: completeBytes } = chunk;
  const result = emptyInboxResult({ bytesRead: completeBytes });
  // Persist a file's observations and cursor together. A storage failure must
  // leave the bytes available for retry, including already rotated inbox files.
  return store.transaction(() => {
    for (const line of lines) {
      let payload;
      try {
        payload = JSON.parse(line.replace(/^\uFEFF/, ''));
      } catch {
        result.invalidRecords += 1;
        continue;
      }
      result.snapshots += 1;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        result.rejectedRecords += 1;
        continue;
      }
      const capturedAt = epochToIso(payload.ai_usage_captured_at || payload.captured_at || stat.mtimeMs);
      // Every redraw with a time advances its session, including a session's
      // opening redraw, which has no limits yet. A limits value that is not an
      // object is rejected below without touching the session: read as no
      // limits, it would make the next unchanged redraw look like a new response.
      // So is a capture further ahead than the store accepts (a clock set back
      // since): every later redraw would look older than it until then.
      const limitsShaped = payload.rate_limits == null
        || (typeof payload.rate_limits === 'object' && !Array.isArray(payload.rate_limits));
      const capturable = capturedAt && Date.parse(capturedAt) <= Date.now() + QUOTA_CLOCK_SKEW_MS;
      const { fetchedAfter, seenSince } = capturable && limitsShaped
        ? datedStatusLineFetch(store, payload, capturedAt) : { fetchedAfter: null, seenSince: null };
      if (!capturedAt || !payload.rate_limits || typeof payload.rate_limits !== 'object' || Array.isArray(payload.rate_limits)) {
        result.rejectedRecords += 1;
        continue;
      }
      recordStatusLineLimits(store, payload, capturedAt, { fetchedAfter, seenSince }, result);
    }
    // Never rewrite the live helper file: doing so can race an in-flight append.
    // The durable byte cursor keeps refresh work incremental without risking data.
    store.markImportedFile(inboxPath, stat.mtimeMs, startOffset + completeBytes, state);
    return result;
  });
}

/**
 * @param {Store} store
 * @param {string} inboxPath
 */
function importClaudeInbox(store, inboxPath) {
  const directory = path.dirname(inboxPath);
  const base = path.basename(inboxPath);
  /** @type {string[]} */
  let rotated = [];
  try {
    rotated = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`${base}.rotated-`))
      .sort()
      .map((name) => path.join(directory, name));
  } catch { /* The inbox directory is created lazily by the helper. */ }
  // A session unseen for longer than any window lasts has nothing left to date.
  try {
    store.prepare('DELETE FROM statusline_sessions WHERE seen_at < ?').run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
  } catch { /* Pruned on a later import. */ }
  const total = emptyInboxResult();
  const numericKeys = /** @type {const} */ (['snapshots', 'usageEvents', 'observations', 'claudeObservations', 'fableObservations',
    'invalidRecords', 'invalidResets', 'rejectedRecords', 'readErrors', 'bytesRead']);
  // A rotated file with no cursor was rotated since the last import, so the
  // live inbox restarted from empty. Once it grows past the old cursor it
  // would look like an append and its first records would be skipped. Its
  // cursor is dropped before the rotated file (the only sign of the restart)
  // can be imported and deleted, including when the helper has not yet
  // created the new inbox. Reading it from the start is safe: observations
  // are upserted by reading time. The live cursor records the rotations it
  // has restarted for, so a rotated file that keeps failing to import
  // restarts the inbox once, not on every refresh.
  const rotations = rotated.map((filePath) => path.basename(filePath));
  const restartedFor = new Set(store.getImportedFile(inboxPath)?.state?.rotations ?? []);
  if (rotated.some((filePath, index) => !store.getImportedFile(filePath) && !restartedFor.has(rotations[index]))) {
    try {
      store.forgetImportedFile(inboxPath);
    } catch {
      // The rotated file is the only sign of the restart. Leave it unread, so
      // the next refresh retries the reset before it can be imported and removed.
      return emptyInboxResult({ readErrors: 1 });
    }
  }
  for (const filePath of [...rotated, inboxPath]) {
    let result;
    try {
      result = importClaudeInboxFile(store, filePath, filePath === inboxPath ? { rotations } : null);
    } catch {
      result = emptyInboxResult({ readErrors: 1 });
    }
    for (const key of numericKeys) total[key] += Number(result[key] || 0);
    total.latestObservationAt = laterIso(total.latestObservationAt, result.latestObservationAt);
    total.latestClaudeObservedAt = laterIso(total.latestClaudeObservedAt, result.latestClaudeObservedAt);
    total.latestFableObservedAt = laterIso(total.latestFableObservedAt, result.latestFableObservedAt);
    if (filePath !== inboxPath && fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const cursor = store.getImportedFile(filePath)?.size_bytes || 0;
        // Rotated writers are closed; allow one hour for a torn final record.
        // A failed complete-record import must still be retried.
        if (cursor >= stat.size || (!result.readErrors && Date.now() - stat.mtimeMs > 60 * 60_000)) {
          fs.unlinkSync(filePath);
          store.forgetImportedFile(filePath);
        }
      } catch { /* A future refresh safely retries cleanup. */ }
    }
  }
  return total;
}

// The Claude Code mod (claude-code-mod/) leaves one small file per reading:
// the limits a Claude Code session holds just after a response delivered
// them, and when the request for that response began. Unlike a status-line
// redraw, which cannot tell a new response from an idle repeat, a reading is
// written only after a response, so it carries its own fetch window.
const CLAUDE_CODE_READING_FORMAT = 'ai-usage-claude-code-reading';
const MAX_CLAUDE_CODE_READING_BYTES = 64 * 1024;
const MAX_CLAUDE_CODE_READINGS = 2_000;
// A request streams for minutes at most. A fetch window wider than this is
// not one request's, so the reading is kept undated rather than misdated.
const MAX_CLAUDE_CODE_FETCH_MS = 30 * 60_000;
// A file that does not parse may still be being written; it is retried until
// it is this old, then discarded.
const TORN_READING_GRACE_MS = 60_000;

/**
 * @param {Record<string, any>} payload A Claude Code mod reading.
 * @param {IsoTime} capturedAt
 * @returns {FetchDating}
 */
function claudeCodeReadingDating(payload, capturedAt) {
  const fetchedAfter = asIso(payload.fetched_after);
  const span = fetchedAfter ? Date.parse(capturedAt) - Date.parse(fetchedAfter) : Number.NaN;
  return span >= 0 && span <= MAX_CLAUDE_CODE_FETCH_MS
    ? { fetchedAfter, seenSince: capturedAt }
    : { fetchedAfter: null, seenSince: capturedAt };
}

/**
 * @param {InboxResult & Record<string, any>} total Added to, under whatever counts `result` carries.
 * @param {InboxResult} result
 */
function mergeInboxResult(total, result) {
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number') total[key] = (total[key] || 0) + value;
  }
  total.latestObservationAt = laterIso(total.latestObservationAt, result.latestObservationAt);
  total.latestClaudeObservedAt = laterIso(total.latestClaudeObservedAt, result.latestClaudeObservedAt);
  total.latestFableObservedAt = laterIso(total.latestFableObservedAt, result.latestFableObservedAt);
  return total;
}

/**
 * @param {Store} store
 * @param {string | null | undefined} directory Where the mod leaves its readings, if it is known.
 * @param {object} [options]
 * @param {Ms} [options.nowMs]
 */
function importClaudeCodeReadings(store, directory, { nowMs = Date.now() } = {}) {
  const result = emptyInboxResult({ files: 0 });
  if (!directory) return result;
  let names;
  try {
    // Of a backlog, the newest first: they are what makes Claude current. The
    // rest wait for the collections that follow.
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort().slice(-MAX_CLAUDE_CODE_READINGS);
  } catch (error) {
    // The mod creates the folder with its first reading.
    return error?.code === 'ENOENT' ? result : emptyInboxResult({ files: 0, readErrors: 1 });
  }
  for (const name of names) {
    const filePath = path.join(directory, name);
    let text;
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      text = stat.size > MAX_CLAUDE_CODE_READING_BYTES ? null : fs.readFileSync(filePath, 'utf8');
    } catch {
      result.readErrors += 1;
      continue;
    }
    /** @type {any} */
    let payload = null;
    try { payload = text == null ? null : JSON.parse(text.replace(/^﻿/, '')); } catch { /* Judged below. */ }
    if (payload === null && text != null && nowMs - stat.mtimeMs < TORN_READING_GRACE_MS) continue;
    result.files += 1;
    const capturedAt = payload && typeof payload === 'object' ? asIso(payload.captured_at) : null;
    const shaped = payload && payload.format === CLAUDE_CODE_READING_FORMAT && payload.version === 1
      && capturedAt && payload.rate_limits && typeof payload.rate_limits === 'object' && !Array.isArray(payload.rate_limits);
    try {
      if (!shaped) {
        result.invalidRecords += 1;
      } else if (Date.parse(capturedAt) > nowMs + QUOTA_CLOCK_SKEW_MS) {
        result.rejectedRecords += 1;
      } else {
        // Counted only once the reading's windows are stored together.
        const recorded = emptyInboxResult({ snapshots: 1 });
        store.transaction(() => recordStatusLineLimits(store, payload, capturedAt,
          claudeCodeReadingDating(payload, capturedAt), recorded, { channel: 'claude-code-mod' }));
        mergeInboxResult(result, recorded);
      }
    } catch {
      // Storage failed: keep the file so a later collection retries it.
      result.readErrors += 1;
      continue;
    }
    try { fs.unlinkSync(filePath); } catch { /* Imported again next time; observations are upserted. */ }
  }
  return result;
}

/**
 * @param {string} root
 * @param {Ms} cutoffMs
 * @param {Set<string>} [legacyFiles]
 */
function listTranscriptFiles(root, cutoffMs, legacyFiles = new Set()) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    // The loop runs only while the stack holds a folder.
    const current = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= cutoffMs || legacyFiles.has(path.resolve(fullPath).toLowerCase())) files.push({ fullPath, stat });
        } catch {
          // A session can disappear while Claude rotates its local records.
        }
      }
    }
  }
  return files;
}

/**
 * @param {TranscriptRow} row
 * @param {string} messageId
 * @param {string} fullPath
 * @returns {TranscriptUsageEvent}
 */
function transcriptEvent(row, messageId, fullPath) {
  const usage = row.message.usage;
  const model = row.message.model || 'claude-unknown';
  const cacheCreation = usage.cache_creation || {};
  let cacheWrite5m = Number(cacheCreation.ephemeral_5m_input_tokens || 0);
  const cacheWrite1h = Number(cacheCreation.ephemeral_1h_input_tokens || 0);
  const cacheWriteTotal = Number(usage.cache_creation_input_tokens || cacheWrite5m + cacheWrite1h);
  if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;

  return {
    eventKey: `claude-transcript:${row.sessionId || 'unknown-session'}:${messageId}`,
    sourceId: CLAUDE.id,
    occurredAt: row.timestamp,
    sessionId: row.sessionId || null,
    model,
    project: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : null,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    cacheWriteInputTokens: cacheWriteTotal,
    cacheWrite5mInputTokens: cacheWrite5m,
    cacheWrite1hInputTokens: cacheWrite1h,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    metadata: {
      source: 'claude-transcript',
      ...claudeAgentMetadata(row, fullPath),
      requestId: row.requestId || null,
      entrypoint: row.entrypoint || null,
      sidechain: Boolean(row.isSidechain),
      effort: row.effort || null,
    },
  };
}

// Repair only an untouched importer record whose source proves it was copied.
/**
 * @param {Store} store
 * @param {TranscriptUsageEvent} event
 */
function copiedEventRow(store, event) {
  const row = /** @type {UsageEventRow | undefined} */ (store.prepare('SELECT * FROM usage_events WHERE event_key = ?').get(event.eventKey));
  if (!row || row.source_id !== CLAUDE.id || row.reported_cost_usd != null) return null;
  const fields = { occurred_at: epochToIso(event.occurredAt), session_id: event.sessionId, model: event.model, project: event.project,
    input_tokens: Number(event.inputTokens || 0), cached_input_tokens: Number(event.cachedInputTokens || 0),
    cache_write_input_tokens: Number(event.cacheWriteInputTokens || 0), cache_write_5m_input_tokens: Number(event.cacheWrite5mInputTokens || 0),
    cache_write_1h_input_tokens: Number(event.cacheWrite1hInputTokens || 0), output_tokens: Number(event.outputTokens || 0),
    reasoning_output_tokens: Number(event.reasoningOutputTokens || 0) };
  // Every key of `fields` is a column of the row.
  if (Object.entries(fields).some(([key, value]) => row[/** @type {keyof typeof fields} */ (key)] !== value)) return null;
  let metadata;
  try { metadata = JSON.parse(row.metadata_json); } catch { return null; }
  if (metadata.source !== 'claude-transcript' || Object.entries(metadata).some(([key, value]) => event.metadata[key] !== value)) return null;
  return row;
}

// Only what transcriptEvent, agent attribution and the fork check read. A row
// also carries message content and tool inputs (file contents, commands) that
// can dwarf its usage; none of it is held while the rest of the file is read.
/**
 * @param {Record<string, any>} row An assistant record of a transcript.
 * @param {Record<string, any>} usage Its `message.usage`.
 */
function usageRowFields(row, usage) {
  return {
    sessionId: row.sessionId, timestamp: row.timestamp, cwd: row.cwd, requestId: row.requestId,
    entrypoint: row.entrypoint, isSidechain: row.isSidechain, effort: row.effort, agentId: row.agentId,
    forkedFrom: Boolean(row.forkedFrom),
    message: { id: row.message.id, model: row.message.model, usage },
  };
}

/**
 * @param {Store} store
 * @param {number} [days] How far back a transcript may have last changed and still be scanned.
 * @returns {TranscriptImportSummary}
 */
function importClaudeTranscripts(store, days = 120) {
  // CLAUDE_CONFIG_DIR relocates Claude Code's directory, projects included.
  const home = providerHome('CLAUDE_CONFIG_DIR', '.claude');
  if (!home) return { importedFiles: 0, usageEvents: 0, fableEvents: 0, filesFound: 0, rejectedRows: 0, lastRejection: null, readErrors: 0, lastReadError: null };
  const root = path.join(home, 'projects');
  const legacyFiles = new Set(/** @type {Pick<ImportedFileRow, 'file_path' | 'state_json'>[]} */ (
    store.prepare("SELECT file_path, state_json FROM imported_files").all())
    .filter((row) => {
      const relative = path.relative(root, row.file_path);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
      try { return JSON.parse(row.state_json || '{}').accountingVersion !== 1; } catch { return true; }
    }).map((row) => path.resolve(row.file_path).toLowerCase()));
  const files = listTranscriptFiles(root, Date.now() - days * 24 * 60 * 60 * 1000, legacyFiles);
  let importedFiles = 0;
  let usageEvents = 0;
  let fableEvents = 0;
  let repairedEvents = 0;
  /** @type {ReturnType<Store['createBackup']> | null} */
  let reconciliationBackup = null;
  let rejectedRows = 0;
  /** @type {string | null} */
  let lastRejection = null;
  let readErrors = 0;
  /** @type {string | null} */
  let lastReadError = null;

  for (const { fullPath, stat } of files) {
    const previous = store.getImportedFile(fullPath);
    const plan = planIncrementalRead(previous?.state?.agentAttributionVersion === 1 && previous.state.accountingVersion === 1 ? previous : null, stat);
    if (!plan) continue;
    // Every transcript row is self-describing (session, working directory,
    // usage), so an appended chunk needs no context from earlier lines. A
    // message streamed across two refreshes is upserted by its id either way.
    let chunk;
    try {
      chunk = readCompleteLines(fullPath, plan.startOffset, stat.size, { streaming: true });
    } catch (error) {
      // Retried next refresh; counted so the status can say data is missing.
      readErrors += 1;
      lastReadError = error?.code || (error instanceof Error ? error.message : String(error));
      continue;
    }
    /** @type {Map<string, TranscriptRow>} */
    const latestByMessage = new Map();
    /** @type {Pick<TranscriptImportSummary, 'rejectedRows' | 'lastRejection'>} */
    const beforeFile = { rejectedRows, lastRejection };
    try {
      for (const line of chunk.lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          rejectedRows += 1;
          lastRejection = 'Claude transcript record must be an object.';
          continue;
        }
        const usage = row.message?.usage;
        if (row.type !== 'assistant' || !usage) continue;
        const messageId = row.message?.id || row.requestId || row.uuid;
        if (!messageId || !row.timestamp) continue;
        latestByMessage.set(messageId, usageRowFields(row, usage));
      }
    } catch (error) {
      if (!(error instanceof IncrementalReadError)) throw error;
      ({ rejectedRows, lastRejection } = beforeFile);
      readErrors += 1;
      lastReadError = error.code || error.message;
      continue;
    }

    // Preserve a recovery copy before correcting previously imported forks.
    if (!reconciliationBackup && [...latestByMessage].some(([messageId, row]) =>
      (row.forkedFrom || row.message.model === '<synthetic>') && copiedEventRow(store, transcriptEvent(row, messageId, fullPath)))) {
      reconciliationBackup = store.createBackup();
    }
    // One commit per file: the rows and the cursor that says they were read
    // land together, and a first import no longer pays a WAL sync per message.
    store.transaction(() => {
      for (const [messageId, row] of latestByMessage) {
        const event = transcriptEvent(row, messageId, fullPath);
        const model = event.model;
        if (row.forkedFrom || model === '<synthetic>') {
          const held = copiedEventRow(store, event);
          if (held && reconciliationBackup) {
            // A stored row has its id, and the count of rows changed is a
            // plain number: the store does not ask SQLite for big integers.
            repairedEvents += /** @type {number} */ (store.prepare('DELETE FROM usage_events WHERE id = ? AND metadata_json = ?')
              .run(/** @type {number} */ (held.id), held.metadata_json).changes);
          }
          continue;
        }
        // One malformed message must not stop the file: the cursor still
        // advances, the row is counted as rejected, and the rest is imported.
        try {
          store.recordUsageEvent(event);
        } catch (error) {
          if (error?.code) throw error;
          rejectedRows += 1;
          lastRejection = error instanceof Error ? error.message : String(error);
          continue;
        }
        usageEvents += 1;
        if (String(model).toLowerCase().includes('fable')) fableEvents += 1;
      }
      store.markImportedFile(fullPath, stat.mtimeMs, plan.startOffset + chunk.consumedBytes, {
        collector: 'claude-transcript', agentAttributionVersion: 1, accountingVersion: 1,
      });
    });
    importedFiles += 1;
  }
  return { importedFiles, usageEvents, fableEvents, repairedEvents, reconciliationBackup, filesFound: files.length, rejectedRows, lastRejection, readErrors, lastReadError };
}


// Bumped whenever the script changes, so installed copies are rewritten.
// The inbox keeps only what the app reads: the capture time, the model, the
// limits, and the session id and API time that date them (a random id and a
// duration; no path, prompt or cost).
const HELPER_VERSION = 'AI_USAGE_HELPER_VERSION=1.0.5';

/** @param {string} inboxPath */
function makeHelperScript(inboxPath) {
  // PowerShell ends a single-quoted string at any of its four typographic
  // single quotes as well as at ', so a profile folder such as O’Brien needs
  // every one doubled, not only the ASCII quote.
  const target = inboxPath.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&');
  return `# ${HELPER_VERSION}\n$ErrorActionPreference = 'SilentlyContinue'\n$raw = [Console]::In.ReadToEnd()\nif ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }\ntry {\n  $data = $raw | ConvertFrom-Json\n  $safeModel = [ordered]@{}\n  if ($null -ne $data.model.id) { $safeModel.id = $data.model.id }\n  if ($null -ne $data.model.display_name) { $safeModel.display_name = $data.model.display_name }\n  $safe = [ordered]@{\n    ai_usage_captured_at = [DateTime]::UtcNow.ToString('o')\n    session_id = $data.session_id\n    api_ms = $data.cost.total_api_duration_ms\n    model = $safeModel\n    rate_limits = $data.rate_limits\n  }\n  $line = $safe | ConvertTo-Json -Depth 30 -Compress\n  $target = '${target}'\n  $parent = Split-Path -Parent $target\n  New-Item -ItemType Directory -Force -Path $parent | Out-Null\n  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -ge ${MAX_INBOX_BYTES})) {\n    $rotated = $target + '.rotated-' + ([DateTime]::UtcNow.ToString('yyyyMMddHHmmssffff')) + '-' + $PID\n    Move-Item -LiteralPath $target -Destination $rotated -ErrorAction SilentlyContinue\n  }\n  $utf8 = New-Object System.Text.UTF8Encoding($false)\n  [System.IO.File]::AppendAllText($target, $line + [Environment]::NewLine, $utf8)\n  $parts = @()\n  if ($null -ne $data.rate_limits.five_hour.used_percentage) { $parts += ('5h: {0:N0}%' -f $data.rate_limits.five_hour.used_percentage) }\n  if ($null -ne $data.rate_limits.seven_day.used_percentage) { $parts += ('7d: {0:N0}%' -f $data.rate_limits.seven_day.used_percentage) }\n  $fable = $data.rate_limits.PSObject.Properties | Where-Object { $_.Name -match 'fable' } | Select-Object -First 1\n  if ($fable) { $parts += ('Fable: {0:N0}%' -f $fable.Value.used_percentage) }\n  $modelLabel = if ($data.model.display_name) { $data.model.display_name } else { 'Claude' }\n  if ($parts.Count -gt 0) { Write-Output ('[{0}] | {1}' -f $modelLabel, ($parts -join ' ')) } else { Write-Output ('[{0}]' -f $modelLabel) }\n} catch {\n  Write-Output '[Claude]'\n}\n`;
}

// Claude Code runs the helper with Windows PowerShell 5.1, which reads a
// script without a byte-order mark in the ANSI code page: a profile folder
// with any non-ASCII character (José, or O’Brien with a typographic
// apostrophe) became a different path. With the mark it reads UTF-8.
/**
 * @param {string} helperPath
 * @param {string} inboxPath
 */
function writeHelperScript(helperPath, inboxPath) {
  fs.writeFileSync(helperPath, `\uFEFF${makeHelperScript(inboxPath)}`, 'utf8');
}

/**
 * @param {string} helperPath
 * @param {string} inboxPath
 */
function updateManagedHelper(helperPath, inboxPath) {
  if (!fs.existsSync(helperPath)) return false;
  try {
    const current = fs.readFileSync(helperPath, 'utf8');
    if (current.includes(HELPER_VERSION)) return false;
    if (!current.includes('ai_usage_captured_at') || !current.includes('ai-usage')) return false;
    writeHelperScript(helperPath, inboxPath);
    return true;
  } catch {
    return false;
  }
}

// The configuration folder the transcript scan reads, so the helper is
// installed, found and removed in the settings Claude Code actually uses when
// CLAUDE_CONFIG_DIR relocates them.
function helperPaths() {
  const claudeDirectory = providerHome('CLAUDE_CONFIG_DIR', '.claude');
  if (!claudeDirectory) throw new Error('Windows user profile was not found.');
  return {
    claudeDirectory,
    settingsPath: path.join(claudeDirectory, 'settings.json'),
    helperPath: path.join(claudeDirectory, 'ai-usage-statusline.ps1'),
    previousStatusLinePath: path.join(claudeDirectory, 'ai-usage-previous-statusline.json'),
  };
}

/**
 * @param {any} statusLine The `statusLine` of Claude Code's settings, whatever it holds.
 * @param {string | null | undefined} helperPath
 */
function isManagedStatusLine(statusLine, helperPath) {
  if (statusLine?.type !== 'command' || typeof helperPath !== 'string' || !helperPath) return false;
  const command = String(statusLine.command || '');
  const match = command.match(/(?:^|\s)-File\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const target = match?.[1] || match?.[2] || match?.[3];
  if (!target) return false;
  // Windows paths are case-insensitive. Exact target ownership matters: a
  // user's unrelated script may legitimately have the same basename.
  return path.resolve(target).toLowerCase() === path.resolve(helperPath).toLowerCase();
}

function isClaudeHelperInstalled() {
  const { settingsPath, helperPath } = helperPaths();
  return fs.existsSync(helperPath) && isManagedStatusLine(readClaudeSettings(settingsPath).statusLine, helperPath);
}

// Enabling and disabling the helper both back up Claude's settings first, but
// an unchanged file needs no second copy: without this, every click left
// another timestamped backup in .claude for ever. The comparison and the copy
// are both byte-exact — decoding as UTF-8 would mangle a settings file written
// in another encoding and destroy the only pristine copy at the same time.
/** @param {string} settingsPath */
function backupClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  const current = fs.readFileSync(settingsPath);
  const directory = path.dirname(settingsPath);
  const prefix = `${path.basename(settingsPath)}.ai-usage-backup-`;
  /** @type {string[]} */
  let existing = [];
  try {
    existing = fs.readdirSync(directory).filter((name) => name.startsWith(prefix));
  } catch { /* The directory is created moments earlier; a new backup is fine. */ }
  for (const name of existing) {
    try {
      if (fs.readFileSync(path.join(directory, name)).equals(current)) return path.join(directory, name);
    } catch { /* An unreadable old backup must not block a new one. */ }
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  // Two changes inside one millisecond must not overwrite each other's backup.
  let backupPath = `${settingsPath}.ai-usage-backup-${stamp}`;
  for (let suffix = 2; fs.existsSync(backupPath); suffix += 1) {
    backupPath = `${settingsPath}.ai-usage-backup-${stamp}-${suffix}`;
  }
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

// Claude's settings.json is written by other tools too. A UTF-8 BOM is legal
// there and common from PowerShell, but JSON.parse rejects it — and an
// unreadable settings file must never be silently replaced with an empty one.
/**
 * @param {string} settingsPath
 * @returns {Record<string, any>} Claude Code's settings, which belong to it and to the user.
 */
function readClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath);
  const bytes = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  const text = bytes.toString('utf8');
  const unreadable = new Error(`Claude's settings file could not be read: ${settingsPath}. Fix or move that file, then try again.`);
  // Decoding a file that is not valid UTF-8 substitutes U+FFFD, which is a
  // legal JSON string character — so the parse would succeed and we would
  // write the damage back. Round-tripping the bytes catches that first.
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw unreadable;
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadable;
  return parsed;
}

/**
 * @param {string} previousStatusLinePath
 * @param {string} helperPath
 * @returns {Record<string, any> | null}
 */
function readPreviousStatusLine(previousStatusLinePath, helperPath) {
  if (!fs.existsSync(previousStatusLinePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(previousStatusLinePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Never hand back our own command as though it were the user's.
    return isManagedStatusLine(parsed, helperPath) ? null : parsed;
  } catch {
    return null;
  }
}

/** @param {string} inboxPath */
function installClaudeHelper(inboxPath) {
  const { claudeDirectory, settingsPath, helperPath, previousStatusLinePath } = helperPaths();
  fs.mkdirSync(claudeDirectory, { recursive: true });
  // Back up before reading, so a file we then refuse to touch is preserved too.
  backupClaudeSettings(settingsPath);
  const settings = readClaudeSettings(settingsPath);
  if (settings.statusLine && !isManagedStatusLine(settings.statusLine, helperPath)) {
    fs.writeFileSync(previousStatusLinePath, `${JSON.stringify(settings.statusLine, null, 2)}\n`, 'utf8');
  } else if (!settings.statusLine && fs.existsSync(previousStatusLinePath)) {
    // Nothing to preserve now means the preserved copy is stale: the user
    // removed their status line by hand since it was taken. Keeping it would
    // let a later disable resurrect a command they deliberately deleted.
    fs.unlinkSync(previousStatusLinePath);
  }
  delete settings.aiUsagePreviousStatusLine;
  writeHelperScript(helperPath, inboxPath);
  settings.statusLine = {
    type: 'command',
    command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${helperPath}"`,
    padding: 1,
    refreshInterval: 60,
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { helperPath, settingsPath, previousStatusLinePreserved: fs.existsSync(previousStatusLinePath), restartRequired: true };
}

// The helper takes over a global Claude Code setting, so there has to be a way
// back out. A status line the user has since pointed elsewhere is left alone —
// and so is the helper script, because some other scope may still invoke it:
// only what this app installed is ours to remove. Settings are restored before
// the script is deleted, so a failure can never leave Claude pointing at a file
// that is gone, and a script that cannot be deleted is reported, not thrown.
function uninstallClaudeHelper() {
  const { settingsPath, helperPath, previousStatusLinePath } = helperPaths();
  const settings = readClaudeSettings(settingsPath);
  const managed = isManagedStatusLine(settings.statusLine, helperPath);
  let restoredPreviousStatusLine = false;
  let statusLineRemoved = false;
  let helperScriptRemoved = false;
  if (!managed) {
    return { helperPath, settingsPath, managed, restoredPreviousStatusLine, statusLineRemoved, helperScriptRemoved, restartRequired: false };
  }
  backupClaudeSettings(settingsPath);
  const previous = readPreviousStatusLine(previousStatusLinePath, helperPath);
  if (previous) {
    settings.statusLine = previous;
    restoredPreviousStatusLine = true;
  } else {
    delete settings.statusLine;
    statusLineRemoved = true;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  // The preserved copy is only discarded once it has been handed back.
  if (restoredPreviousStatusLine && fs.existsSync(previousStatusLinePath)) fs.unlinkSync(previousStatusLinePath);
  try {
    if (fs.existsSync(helperPath)) fs.unlinkSync(helperPath);
    helperScriptRemoved = true;
  } catch { /* Locked by a running status line or a scanner; settings are already safe. */ }
  return { helperPath, settingsPath, managed, restoredPreviousStatusLine, statusLineRemoved, helperScriptRemoved, restartRequired: true };
}

// The latest provider reading (SDK or status line; never a manual entry) of
// each Claude window that is still running, and whether all of them are
// recent by the dashboard verdict's freshness rule. An automatic refresh does
// not read plan usage, so this is how it judges the Claude source.
// Readings are judged as the card shows them: a lower status-line reading
// that restates limits a session fetched earlier is held back there (lower in
// the allowance in force now, not in a share of an earlier one), so it
// can make Claude neither current here nor a failed Refresh successful. Each
// window is as recent as its evidence (`evidence_at`), not its latest redraw,
// and a redraw from a session first seen with limits in hand is known only
// from the start of the window it shows.
// `emptyReadMs` is a later read that succeeded without returning any window,
// which omitted every window stored before it.
/**
 * @param {Store} store
 * @param {Ms} nowMs
 * @param {number} graceMs How long an undated lower reading waits for the provider's next read.
 * @param {Ms | null} [emptyReadMs]
 * @returns {{ lastReadAt: IsoTime | null, staleReadAt: IsoTime | null, fresh: boolean, windows: PlanWindowReading[] }}
 */
function latestPlanUsageReading(store, nowMs, graceMs, emptyReadMs = /** @type {number | null} */ (null)) {
  const rows = /** @type {PlanWindowRow[]} */ (store.prepare(`SELECT id, bucket_id, observed_at, resets_at, window_minutes, used_percent, remaining_percent, provenance, fetched_after, seen_since
    FROM quota_observations WHERE source_id = 'claude' AND observed_at <= ? AND observed_at >= ? ORDER BY observed_at ASC, id ASC`)
    .all(new Date(nowMs + QUOTA_CLOCK_SKEW_MS).toISOString(), new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString()));
  /** @type {Map<string, PlanWindowRow[]>} */
  const buckets = new Map();
  for (const row of rows) {
    if (!validQuotaTime(Date.parse(row.observed_at), Date.parse(row.resets_at), row.window_minutes, nowMs)) continue;
    if (!buckets.has(row.bucket_id)) buckets.set(row.bucket_id, []);
    // Set on the line above when it was missing.
    /** @type {PlanWindowRow[]} */ (buckets.get(row.bucket_id)).push(row);
  }
  /** @type {Map<string, PlanWindowReading>} */
  const latest = new Map();
  /** @type {number | null} */
  let lastPlanUsageReadMs = null;
  const restatementOptions = { nowMs, freshReadGraceMs: graceMs, allowanceChanges: store.getSettings().allowanceChanges, sourceId: CLAUDE.id };
  for (const [bucketId, bucketRows] of buckets) {
    // The rows kept come back as they were given.
    /** @type {PlanWindowRow[]} */
    const accepted = withoutStaleRestatements(bucketRows, restatementOptions)
      .filter((/** @type {PlanWindowRow} */ row) => isProviderProvenance(row.provenance));
    // One plan-usage read records every window it returns at the same instant.
    const planUsageRead = accepted.findLast((row) => row.provenance === 'official-claude-usage');
    const planReadMs = planUsageRead ? Date.parse(planUsageRead.observed_at) : null;
    if (planReadMs != null) lastPlanUsageReadMs = Math.max(lastPlanUsageReadMs ?? -Infinity, planReadMs);
    if (accepted.length) {
      const evidenceOptions = { ...restatementOptions, known: true };
      // `accepted` is not empty here, so its last reading and its evidence both exist.
      latest.set(bucketId, { .../** @type {PlanWindowRow} */ (accepted.at(-1)), evidence_at: new Date(/** @type {number} */ (latestEvidenceAt(accepted, evidenceOptions))).toISOString(),
        own_evidence_at: new Date(/** @type {number} */ (evidenceTimes(accepted, evidenceOptions).at(-1))).toISOString(), plan_read_ms: planReadMs });
    }
  }
  if (Number.isFinite(emptyReadMs) && !((lastPlanUsageReadMs ?? 0) >= /** @type {number} */ (emptyReadMs))) lastPlanUsageReadMs = emptyReadMs;
  // A window the latest plan-usage read did not return (a model or app limit
  // the provider stopped reporting) keeps its older row until it resets, and
  // Refresh cannot renew it, so it does not decide whether Claude is current.
  // A later redraw renews it only with a fetch no older than that read; a
  // window the read did return stays, whatever redraws of it followed.
  const active = [...latest.values()].filter((row) => Date.parse(row.resets_at) > nowMs
    && (lastPlanUsageReadMs == null || row.plan_read_ms === lastPlanUsageReadMs
      || Date.parse(row.own_evidence_at) >= lastPlanUsageReadMs));
  if (!active.length) return { lastReadAt: null, staleReadAt: null, fresh: false, windows: [] };
  const lastReadAt = active.reduce((last, row) => laterIso(last, row.evidence_at), /** @type {IsoTime | null} */ (null));
  // The oldest reading that is out of date, which the stale detail quotes.
  const staleReadAt = active.filter((row) => !providerReadingFresh(row, nowMs))
    .reduce((oldest, row) => (!oldest || Date.parse(row.evidence_at) < Date.parse(oldest) ? row.evidence_at : oldest), /** @type {IsoTime | null} */ (null));
  return { lastReadAt, staleReadAt, fresh: !staleReadAt, windows: active };
}

/** @param {IsoTime} value */
function readingTime(value) {
  return new Date(value).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Why a Refresh could not read plan usage, as a sentence for the status line.
// A missing sign-in is said in words, since it is something to act on; any
// other failure is named by its code, as Diagnostics names it.
/**
 * @param {{ errorCode?: string | null } | null | undefined} provider The provider outcome of the request that failed.
 * @param {string} refresh How the sentence names that request.
 */
function planUsageFailure(provider, refresh) {
  const reason = provider?.errorCode === 'claude-usage-signed-out'
    ? ' because Claude Code did not report your Claude subscription sign-in'
    : provider?.errorCode ? ` (${provider.errorCode})` : '';
  return ` ${refresh} could not read Claude plan usage${reason}.`;
}

// When a plan-usage read succeeded without returning any overall window.
/**
 * @param {PlanUsageRequest | null} request
 * @returns {Ms | null}
 */
function emptyPlanUsageReadMs(request) {
  const provider = request?.provider;
  // A provider outcome was read from a request, so the request is there.
  return provider?.attemptSucceeded === true && ['observed', 'unavailable'].includes(provider.kind)
    && Number(provider.overallWindowsRecorded) === 0 ? Date.parse(/** @type {PlanUsageRequest} */ (request).at) : null;
}

// The outcome of the last plan-usage read the user asked for, which an
// automatic run carries forward so a failed Refresh stays visible until a
// newer reading replaces it.
/**
 * @param {Store} store
 * @returns {PlanUsageRequest | null}
 */
function previousPlanUsageRequest(store) {
  try {
    const row = /** @type {{ metadata_json: string } | undefined} */ (store.prepare("SELECT metadata_json FROM sources WHERE id = 'claude'").get());
    const request = JSON.parse(row?.metadata_json || '{}')?.planUsage?.lastRequest;
    return request && typeof request === 'object' && typeof request.at === 'string' ? request : null;
  } catch { return null; }
}

// Claude plan usage is read through the user's own Claude Code (the Agent
// SDK) only when `options.readPlanUsage` is true, which only an explicit user
// refresh sets. Otherwise no usage port is created, nothing contacts
// Anthropic, and the status-line inbox and the transcript import still run.
/**
 * @param {Store} store
 * @param {string} inboxPath
 * @param {object} [options]
 * @param {boolean} [options.readPlanUsage]
 * @param {string | null} [options.claudeCodeReadingsDirectory]
 * @param {import('./fable-tracker.cjs').UsagePort} [options.usagePort]
 * @param {import('./fable-tracker.cjs').ActivityReader} [options.activityReader]
 * @param {() => Date | number | string} [options.clock]
 * @param {AbortSignal} [options.signal]
 */
async function refreshClaude(store, inboxPath, options = {}) {
  const readPlanUsage = options.readPlanUsage === true;
  const binary = findClaudeBinary();
  // Rows this collection's status-line import adds are numbered after every
  // row stored before it; a line imported again only updates its existing row.
  const importedAfterId = /** @type {{ id: number }} */ (store.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM quota_observations').get()).id;
  let statusLine;
  try {
    statusLine = importClaudeInbox(store, inboxPath);
  } catch (error) {
    // The status-line helper is an optional fallback. Its inbox must never
    // prevent the primary SDK read or the independent transcript import.
    statusLine = emptyInboxResult({ readErrors: 1, error: error.message });
  }
  // Readings the Claude Code mod left, each dated by the request that fetched it.
  let claudeCodeReadings;
  try {
    claudeCodeReadings = importClaudeCodeReadings(store, options.claudeCodeReadingsDirectory);
  } catch (error) {
    claudeCodeReadings = emptyInboxResult({ files: 0, readErrors: 1, error: error.message });
  }
  const usagePort = !readPlanUsage ? null : options.usagePort || createClaudeAgentSdkUsagePort({
    // Reuse this refresh's discovery result so the SDK launches precisely the
    // external Claude binary whose presence the source status reports.
    findClaudeBinary: () => binary,
  });
  const fableTracker = createFableUsageTracker({
    store,
    usagePort,
    activityReader: options.activityReader || { import: async () => importClaudeTranscripts(store) },
    clock: options.clock,
  });
  const fableTracking = await fableTracker.refresh({
    signal: options.signal,
    fallbackObservedAt: laterIso(statusLine.latestFableObservedAt, claudeCodeReadings.latestFableObservedAt),
  });
  // One reading of the clock for every time check below, so an injected
  // clock governs the whole status and no probe falls back to wall time.
  const nowMs = options.clock ? new Date(options.clock()).getTime() : Date.now();
  const transcripts = fableTracking.imports || {
    importedFiles: 0,
    usageEvents: 0,
    fableEvents: fableTracking.activity.requests,
    filesFound: 0,
  };
  let fableDerived;
  const hasProviderScopedFable = fableTracking.allowance.kind === 'official'
    && ['claude-usage-model-scoped', 'claude-statusline-model-scoped'].includes(fableTracking.allowance.source);
  if (hasProviderScopedFable) {
    fableDerived = { derived: false, reason: 'official-model-scoped' };
  } else {
    try {
      // Read-only: the estimate is projected when the snapshot is built.
      fableDerived = deriveFableEstimate(store, nowMs);
    } catch (error) {
      // A bad Fable estimate must never take down the whole Claude refresh.
      fableDerived = { derived: false, reason: `derive-failed: ${error.message}` };
    }
  }
  // One definition of where the helper lives, shared with install and uninstall:
  // a second guess here would drive the Enable/Disable button from a path the
  // other two do not use.
  /** @type {string | null} */
  let helperPath = null;
  try { ({ helperPath } = helperPaths()); } catch { /* No Windows profile; nothing is installed. */ }
  let helperInstalled = false;
  try { helperInstalled = isClaudeHelperInstalled(); } catch { /* Unreadable settings cannot confirm an active helper. */ }
  // The helper is found installed only where its path was.
  const helperUpdated = helperInstalled ? updateManagedHelper(/** @type {string} */ (helperPath), inboxPath) : false;
  // Existence probes, not getQuota: the status text needs a yes or no, and
  // getQuota forecasts every window of the source to produce one.
  const hasQuota = store.hasUsableObservation(CLAUDE.id, nowMs, { activeWithinMs: 8 * 24 * 60 * 60 * 1000 });
  const providerScanSucceeded = Boolean(fableTracking.provider?.attemptSucceeded
    && ['observed', 'unavailable'].includes(fableTracking.provider.kind));
  const activityCurrent = fableTracking.health.activitySource === 'current';
  // The last plan-usage read the user asked for: this one, or the one an
  // earlier Refresh recorded. A read that returned no overall window at all
  // omitted every window stored before it, as it omits any it does not return.
  const requestAt = new Date(nowMs).toISOString();
  const previousRequest = readPlanUsage ? null : previousPlanUsageRequest(store);
  const emptyReadMs = emptyPlanUsageReadMs(readPlanUsage ? { at: requestAt, provider: fableTracking.provider } : previousRequest);
  const acceptedReading = latestPlanUsageReading(store, nowMs, freshReadGraceFor(store.getSettings()), emptyReadMs);
  // A helper import stands in for the provider only when this collection
  // imported a reading the card shows, captured in the last few minutes. One
  // an earlier collection imported is not new evidence, however recent. The
  // import renews only the windows it reports, so every active window must
  // then be current, as an automatic run would judge it.
  // An idle session's redraw is imported as a new row, but it carries limits
  // fetched long ago, so its own fetch is what must be recent, and known to
  // be: a session first seen with limits in hand may have fetched them long
  // before its first redraw. The window's evidence may come from an earlier
  // read that agrees with it, which is not new evidence from this collection.
  const helperRefreshed = acceptedReading.fresh && acceptedReading.windows.some((row) => {
    const ageMs = nowMs - Date.parse(row.own_evidence_at);
    return row.provenance === 'official-statusline' && row.fetched_after != null && row.id > importedAfterId
      && ageMs >= -60_000 && ageMs <= 5 * 60_000;
  });
  const hasFreshClaudeEvidence = helperRefreshed || Number(fableTracking.provider?.overallWindowsRecorded || 0) > 0;
  // Plan usage not requested: judge the last reading by its age, and count
  // the run a success when its local work succeeded.
  const planReading = readPlanUsage ? null : acceptedReading;
  // Whether it brought the Fable allowance up to date is kept apart: a read
  // can return every overall window and still omit the model-scoped one.
  // Null only on an automatic run with no earlier Refresh on record.
  /** @type {PlanUsageRequest | null} */
  const lastRequest = readPlanUsage
    ? { at: requestAt, succeeded: hasFreshClaudeEvidence || providerScanSucceeded, provider: fableTracking.provider,
      fableCurrent: fableTracking.health.officialSource === 'connected' }
    : previousRequest;
  // A failed Refresh that no reading has since replaced.
  // A missing time parses as no time at all, which is never the later one.
  const failedSince = (/** @type {IsoTime | null | undefined} */ observedAt) => !readPlanUsage && lastRequest?.succeeded === false
    && !(Date.parse(/** @type {IsoTime} */ (observedAt)) >= Date.parse(lastRequest.at));
  // Likewise a Refresh that left the Fable allowance out of date. A request
  // recorded before this was kept says nothing either way.
  const fableMissedSince = (/** @type {IsoTime | null | undefined} */ observedAt) => !readPlanUsage && lastRequest?.fableCurrent === false
    && !(Date.parse(/** @type {IsoTime} */ (observedAt)) >= Date.parse(lastRequest.at));
  const lastRequestFailed = failedSince(planReading?.lastReadAt);
  // Automatic runs judge all active windows even when this run just imported
  // fresh evidence.
  const claudeFresh = readPlanUsage ? hasFreshClaudeEvidence : Boolean(planReading?.fresh) && !lastRequestFailed;
  const claudeScanSucceeded = readPlanUsage
    ? (hasFreshClaudeEvidence || providerScanSucceeded) && activityCurrent
    : activityCurrent;
  const fableObserved = store.hasUsableObservation(FABLE.id, nowMs);
  const extraUsage = fableTracking.provider?.extraUsage;
  let extraUsageDetail = '';
  if (extraUsage) {
    if (!extraUsage.isEnabled) {
      extraUsageDetail = ' Extra usage credits are disabled.';
    } else if (extraUsage.usedCredits != null && extraUsage.monthlyLimit != null) {
      const unit = extraUsage.currency ? ` ${extraUsage.currency}` : ' credits';
      const utilization = extraUsage.utilization == null ? '' : ` (${extraUsage.utilization}% used)`;
      extraUsageDetail = ` Extra usage credits: ${extraUsage.usedCredits} of ${extraUsage.monthlyLimit}${unit} used${utilization}.`;
    } else if (extraUsage.usedCredits != null) {
      const unit = extraUsage.currency ? ` ${extraUsage.currency}` : ' credits';
      extraUsageDetail = ` Extra usage credits used: ${extraUsage.usedCredits}${unit}.`;
    } else {
      extraUsageDetail = ' Extra usage credits are enabled; the provider did not return a current balance.';
    }
  }
  const helperSentence = helperInstalled ? 'The minimized fallback status-line helper is installed.' : 'The status-line helper is available as an optional fallback for overall Claude allowance.';
  const claudeStatus = !activityCurrent ? 'degraded'
    : claudeFresh ? 'connected'
    : hasQuota ? 'stale'
      : transcripts.usageEvents ? 'observing'
        : binary ? 'ready' : 'awaiting-installation';
  // This Refresh's failure, said on both cards. A failed activity import
  // already quotes it through the tracker's detail.
  // This run read plan usage, so the request is its own.
  const refreshFailure = readPlanUsage && activityCurrent && /** @type {PlanUsageRequest} */ (lastRequest).succeeded === false
    ? planUsageFailure(/** @type {PlanUsageRequest} */ (lastRequest).provider, 'This Refresh') : '';
  const lastRead = planReading?.lastReadAt ? readingTime(planReading.lastReadAt) : null;
  const staleRead = planReading?.staleReadAt ? readingTime(planReading.staleReadAt) : null;
  const claudeDetail = !readPlanUsage ? (!activityCurrent
    ? `Claude plan usage is read only when you press Refresh, and the local transcript activity import failed; previously tracked token activity remains available. ${fableTracking.health.detail || ''}`
    : claudeFresh
    ? `Claude plan usage was last read ${lastRead || 'moments ago'}; it is read again when you press Refresh. Scanned ${transcripts.usageEvents} transcript messages.`
    : hasQuota
      ? `${staleRead ? `The last Claude plan usage reading (${staleRead}) is still active but out of date; press Refresh to read it again.` : 'The last official Claude allowance is still active but out of date; press Refresh to read plan usage.'} Scanned ${transcripts.usageEvents} transcript messages.`
      : transcripts.usageEvents
        ? `Scanned ${transcripts.usageEvents} Claude transcript messages. Claude plan usage is read when you press Refresh${binary ? '.' : ', but no Claude Code executable was found.'}`
        : binary
          ? `Claude Code was found. Plan usage is read when you press Refresh; no local transcript activity was available. ${helperSentence}`
          : 'Claude Code is not currently installed or available locally. Plan usage is read through Claude Code when you press Refresh.')
      // Outside the group: inside it, `+` would bind only to the last branch.
      // Only a request on record can have failed.
      + (lastRequestFailed ? planUsageFailure(/** @type {PlanUsageRequest} */ (lastRequest).provider, 'The last Refresh') : '')
    : (!activityCurrent
    ? `${hasFreshClaudeEvidence ? 'Official Claude allowance evidence was refreshed, but' : 'The allowance check completed, but'} the local transcript activity import failed; previously tracked token activity remains available. ${fableTracking.health.detail || ''}`
    : hasFreshClaudeEvidence
    ? `Official Claude allowance evidence was refreshed; scanned ${transcripts.usageEvents} transcript messages.`
    : hasQuota
      ? `The last official Claude allowance is still active, but this refresh did not replace it; scanned ${transcripts.usageEvents} transcript messages.`
      : transcripts.usageEvents
        ? `Scanned ${transcripts.usageEvents} Claude transcript messages; the provider did not return a current allowance${binary ? '.' : ' and no Claude Code executable was found.'}`
        : binary
          ? `Claude Code was found. Automatic plan usage was checked, but no current allowance or local transcript activity was available. ${helperSentence}`
          : 'Claude Code is not currently installed or available locally.')
      + refreshFailure
      // A failure of this Refresh is a failure of its own request.
      + (refreshFailure && /** @type {PlanUsageRequest} */ (lastRequest).provider?.errorCode === 'claude-usage-signed-out' ? ' If Claude Code is signed in, press Refresh again.' : '')
      + extraUsageDetail;
  store.setSourceStatus(CLAUDE.id, claudeStatus, claudeDetail, {
    binary,
    inboxPath,
    statusLine,
    claudeCodeReadings,
    transcripts,
    helperInstalled,
    helperUpdated,
    // Diagnostics show "not attempted" when this run did not read plan usage.
    provider: readPlanUsage ? fableTracking.provider : null,
    planUsage: { requested: readPlanUsage, lastReadAt: planReading?.lastReadAt ?? null, lastRequest },
  }, { scanSucceeded: claudeScanSucceeded });
  const fableAuto = fableDerived.derived;
  // Only an official allowance has these times. Every use below is of one
  // that is official and provider-scoped, or passes a missing time on.
  const fableEvidenceAt = /** @type {Partial<import('./fable-tracker.cjs').OfficialAllowance>} */ (fableTracking.allowance).evidenceAt
    ?? /** @type {Partial<import('./fable-tracker.cjs').OfficialAllowance>} */ (fableTracking.allowance).observedAt;
  const fableMissed = hasProviderScopedFable && fableMissedSince(fableEvidenceAt);
  const providerCurrent = hasProviderScopedFable && fableTracking.health.officialSource === 'connected'
    && !failedSince(fableEvidenceAt) && !fableMissed;
  const providerStale = hasProviderScopedFable && !providerCurrent;
  const fableStatus = !activityCurrent ? 'degraded'
    : providerCurrent ? 'connected'
    : providerStale ? 'stale'
      : fableAuto ? 'estimating'
        : fableObserved ? 'observing'
          : fableTracking.activity.requests ? 'activity-only' : 'waiting';
  const fableEvents = `${fableTracking.activity.requests} local Fable usage event${fableTracking.activity.requests === 1 ? '' : 's'}`;
  // An official allowance always carries the time of its evidence.
  const fableReadAt = hasProviderScopedFable ? readingTime(/** @type {IsoTime} */ (fableEvidenceAt)) : null;
  // As on the Claude card, a failed Refresh stays explained until a newer
  // Fable reading replaces it; without one, until a Refresh succeeds.
  const fableRefreshFailure = refreshFailure
    // Only a request on record can have failed.
    || (failedSince(hasProviderScopedFable ? fableEvidenceAt : null) ? planUsageFailure(/** @type {PlanUsageRequest} */ (lastRequest).provider, 'The last Refresh') : '');
  const fableDetail = !activityCurrent
    ? `${providerCurrent ? 'The official model-scoped Fable allowance is current, but' : readPlanUsage ? 'The allowance check completed, but' : 'Plan usage is read only when you press Refresh, and'} the actual local activity import failed; previously tracked counts are retained. ${fableTracking.health.detail || ''}`
    : providerCurrent && !readPlanUsage
    ? `Official model-scoped Fable allowance was last read ${fableReadAt}; it is read again when you press Refresh. ${fableEvents} are in the current window.`
    : providerCurrent
    ? `Official model-scoped Fable allowance is collected automatically; ${fableEvents} are in the current window.`
    : (fableMissed
      ? `The last official model-scoped Fable allowance (${fableReadAt}) is still valid, but the last Refresh could not replace it. Local activity remains available.`
    : providerStale && !readPlanUsage
      ? `The last official model-scoped Fable allowance (${fableReadAt}) is still valid but out of date; press Refresh to read it again. Local activity remains available.`
    : providerStale
      ? 'The last official model-scoped Fable allowance is still valid, but this refresh could not replace it. Local activity remains available.'
      : fableAuto
        ? 'Fable allowance is estimated from actual local token activity and calibrated official history; it will switch to the provider figure whenever model-scoped usage is available.'
        : fableObserved
          ? 'Fable has allowance history, but the provider did not return a current model-scoped reading.'
          : fableTracking.activity.requests
            ? `Imported ${fableTracking.activity.requests} actual local Fable usage event${fableTracking.activity.requests === 1 ? '' : 's'}; the provider did not return a model-scoped allowance.`
            : 'Waiting for actual local Fable activity or a provider model-scoped allowance.') + fableRefreshFailure;
  // Successful local activity collection is useful without an allowance.
  // A stale provider-scoped reading still requires a provider refresh, unless
  // this run was never asked to read the provider.
  const fableScanSucceeded = activityCurrent && (!providerStale || !readPlanUsage);
  store.setSourceStatus(FABLE.id, fableStatus, fableDetail, {
    sharedWithOverall: true,
    models: (fableTracking.activity.models || []).map((entry) => entry.model),
    transcriptEvents: fableTracking.activity.requests,
    fableDerived,
    automatic: {
      allowance: fableTracking.allowance,
      activity: fableTracking.activity,
      health: fableTracking.health,
      provider: fableTracking.provider,
      refreshedAt: fableTracking.refreshedAt,
    },
  }, { scanSucceeded: fableScanSucceeded });
  return { binary, statusLine, claudeCodeReadings, transcripts, helperInstalled, helperUpdated, fableObserved, fableDerived, fableTracking,
    ...(!activityCurrent ? { warning: fableTracking.health.detail || 'Local transcript activity is incomplete.' } : {}) };
}

module.exports = { CLAUDE_CODE_READING_FORMAT, deriveFableEstimate, epochToIso, findClaudeBinary, helperPaths, importClaudeCodeReadings, importClaudeInbox, importClaudeTranscripts, readClaudeSettings, installClaudeHelper, isClaudeHelperInstalled, makeHelperScript, refreshClaude, uninstallClaudeHelper };
