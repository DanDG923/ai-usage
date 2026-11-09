'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { findCodexBinary, providerProcessOptions, providerHome } = require('./provider-executable.cjs');
const { IncrementalReadError, planIncrementalRead, readCompleteLines } = require('./incremental-file.cjs');
const { epochToIso } = require('./time.cjs');
const { MAX_QUOTA_RESET_AHEAD_MS } = require('./quota-time.cjs');
const { codexQuotaLabel, durationLabel } = require('./codex-quota-label.cjs');
const { CODEX } = require('./providers.mjs');
const { codexAgentMetadata, textId } = require('./task-usage.cjs');
const { errorCode } = require('./caught.cjs');

/** @typedef {import('./types').Store} Store */
/** @typedef {import('./types').IsoTime} IsoTime */
/** @typedef {import('node:sqlite').SQLInputValue} SQLInputValue */

/**
 * A request the app server has not answered yet.
 * @typedef {{ resolve: (result: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }} PendingRequest
 */

/** @typedef {ReturnType<typeof codexAgentMetadata>} AgentMetadata */

/**
 * What one rollout log's cursor carries from one read to the next: the
 * session, model and project set by earlier lines than the token counts that
 * need them, and what has already been kept. Cursors written by earlier
 * versions lack the later fields.
 * @typedef {object} SessionState
 * @property {string} sessionId
 * @property {string | null} model
 * @property {string | null} project
 * @property {number} agentAttributionVersion
 * @property {number} accountingVersion
 * @property {number} eventKeyVersion
 * @property {string | null} [ownId] The file's own session id, once its first session_meta is read.
 * @property {string} [copiedFrom] The parent session a fork's history was copied from.
 * @property {number} [copiedUntil] Token counts stamped up to here are the parent's.
 * @property {AgentMetadata} [agent]
 * @property {string | null} [taskId]
 * @property {{ fingerprint: string, eventKey: string } | null} [lastTokenSnapshot]
 * @property {string} [lastEventAt]
 * @property {number} [sameInstantEvents]
 * @property {Record<string, { reading: string, at: number }>} [keptRateLimits] The last rate-limit reading stored for each limit.
 */

/**
 * A token count as the ledger will record it.
 * @typedef {import('./types').UsageEventInput & {
 *   sessionId: string,
 *   metadata: { source: string, taskId: string | null } & Partial<AgentMetadata>,
 * }} CodexUsageEvent
 */

/**
 * What a scan of the local rollout logs did.
 * @typedef {object} SessionImportSummary
 * @property {number} importedFiles
 * @property {number} events
 * @property {number} observations
 * @property {number} rejected
 * @property {string | null} lastRejection
 * @property {number} duplicateEvents
 * @property {number} reconciledEvents
 * @property {ReturnType<Store['createBackup']> | null} reconciliationBackup The safety copy made before a repair, if one was needed.
 * @property {number} readErrors
 * @property {string | null} lastReadError
 */

/**
 * The counts of a scan that has not run, or failed before it returned.
 * @typedef {{ importedFiles: number, events: number, observations: number, readErrors?: undefined, lastReadError?: undefined }} NoSessionImport
 */

// Read from the manifest so the version reported to Codex cannot drift.
const APP_VERSION = require('../package.json').version;

// The exit message becomes the source's status text, which the dashboard and
// a desktop notification display. Only a short, single-line excerpt of the
// final stderr output is useful there; the full buffer stays in this process.
const MAX_STDERR_EXCERPT = 240;

/** @param {unknown} stderr */
function stderrExcerpt(stderr) {
  const text = String(stderr || '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_STDERR_EXCERPT ? `…${text.slice(-MAX_STDERR_EXCERPT)}` : text;
}

class JsonLineClient {
  /**
   * @param {string} binary
   * @param {typeof spawn} [spawnProcess]
   */
  constructor(binary, spawnProcess = spawn) {
    this.nextId = 1;
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    /** @type {Error | null} */
    this.failure = null;
    /** @type {import('node:readline').Interface | null} */
    this.lines = null;
    this.child = spawnProcess(binary, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...providerProcessOptions(binary),
    });
    this.child.once('error', (error) => {
      this.fail(new Error(`Codex app server process error: ${error.message}`));
    });
    for (const pipe of /** @type {const} */ (['stdin', 'stdout', 'stderr'])) {
      this.child[pipe].on('error', (/** @type {Error} */ error) => {
        this.fail(new Error(`Codex app server ${pipe} error: ${error.message}`));
      });
    }
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('error', (error) => {
      this.fail(new Error(`Codex app server output reader error: ${error.message}`));
    });
    this.lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.child.once('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const detail = stderrExcerpt(this.stderr);
      this.fail(new Error(`Codex app server exited with ${reason}.${detail ? ` ${detail}` : ''}`));
    });
  }

  /** @param {unknown} error */
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error instanceof Error ? error : new Error(String(error));
    if (this.lines) this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  /** @param {{ id?: number, method: string, params?: unknown }} message */
  writeMessage(message) {
    if (this.closed) throw this.failure ?? new Error('Codex app server client is closed.');
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.fail(new Error(`Codex app server stdin write failed: ${error.message}`));
      });
    } catch (error) {
      const failure = new Error(`Codex app server stdin write failed: ${/** @type {Error} */ (error).message}`);
      this.fail(failure);
      throw failure;
    }
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} The app server's result, in whatever shape the method answers with.
   */
  request(method, params = /** @type {any} */ (null), timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(this.failure ?? new Error('Codex app server client is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage({ id, method, params });
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   */
  notify(method, params = {}) {
    this.writeMessage({ method, params });
  }

  close() {
    if (!this.closed) this.fail(new Error('Codex app server client was closed.'));
    if (!this.child.killed) this.child.kill();
  }
}

/** @param {Record<string, any> | null | undefined} window One window of a rate-limit payload. */
function quotaWindow(window) {
  if (!window) return null;
  const rawUsedPercent = window.usedPercent ?? window.used_percent;
  if (rawUsedPercent == null || (typeof rawUsedPercent === 'string' && !rawUsedPercent.trim())) return null;
  const usedPercent = Number(rawUsedPercent);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  return {
    usedPercent,
    windowMinutes: Number(window.windowDurationMins ?? window.window_minutes ?? 0),
    resetsAt: epochToIso(window.resetsAt ?? window.resets_at),
  };
}

/**
 * @param {Store} store
 * @param {any} raw
 * @param {string} observedAt
 * @param {string} provenance
 * @param {object} [extra]
 * @param {{ onRejected?: (error: unknown) => void }} [options]
 */
function recordRateLimit(store, raw, observedAt, provenance, extra = {}, { onRejected } = {}) {
  if (!raw) return 0;
  const sourceId = CODEX.id;
  const limitId = raw.limitId ?? raw.limit_id ?? CODEX.mainLimitId;
  const limitName = raw.limitName ?? raw.limit_name ?? limitId;
  const planType = raw.planType ?? raw.plan_type ?? null;
  let count = 0;
  for (const [label, value] of [['primary', raw.primary], ['secondary', raw.secondary]]) {
    const window = quotaWindow(value);
    if (!window?.resetsAt) continue;
    const observation = {
      sourceId,
      bucketId: `${limitId}:${label}`,
      bucketName: codexQuotaLabel(durationLabel(window.windowMinutes, limitName),
        window.windowMinutes, { limitId, limitName }),
      observedAt,
      usedPercent: window.usedPercent,
      remainingPercent: 100 - window.usedPercent,
      resetsAt: window.resetsAt,
      windowMinutes: window.windowMinutes,
      planType,
      provenance,
      confidence: provenance === 'official' ? 1 : 0.92,
      metadata: { limitId, limitName, ...extra },
    };
    try {
      store.recordObservation(observation);
      count += 1;
    } catch (error) {
      // A reading can carry a window the store rejects beside a valid one.
      // The session-log import and the app-server read both report that
      // rejection and keep the rest; a caller with no rejection handler fails
      // fast. Coded runtime/SQLite failures always propagate, so the caller's
      // transaction rolls back and a log's cursor cannot advance past records
      // that failed to persist.
      if (!onRejected || errorCode(error)) throw error;
      onRejected(error);
    }
  }
  return count;
}

/**
 * @param {Store} store
 * @param {string} binary
 * @param {object} [options]
 * @param {(executable: string) => Pick<JsonLineClient, 'request' | 'notify' | 'close'>} [options.clientFactory]
 */
async function collectFromAppServer(store, binary, {
  clientFactory = (executable) => new JsonLineClient(executable),
} = {}) {
  const client = clientFactory(binary);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'ai-usage', title: 'AI Usage', version: APP_VERSION },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    const limits = await client.request('account/rateLimits/read');
    const observedAt = new Date().toISOString();
    const resetCredits = limits?.rateLimitResetCredits?.availableCount ?? null;
    const buckets = limits?.rateLimitsByLimitId && Object.keys(limits.rateLimitsByLimitId).length
      ? Object.entries(limits.rateLimitsByLimitId).map(([limitId, bucket]) => ({ ...bucket, limitId: bucket?.limitId ?? bucket?.limit_id ?? limitId }))
      : [limits?.rateLimits].filter(Boolean);
    let observations = 0;
    let rejected = 0;
    let lastRejection = null;
    // One response is stored whole, as a session log's records are: a window
    // the store rejects is counted and the others are kept, and a storage
    // failure leaves none of them behind to be reported as a failed read.
    store.transaction(() => {
      for (const bucket of buckets) {
        observations += recordRateLimit(store, bucket, observedAt, 'official', { resetCredits }, {
          onRejected: (error) => {
            rejected += 1;
            lastRejection = error instanceof Error ? error.message : String(error);
          },
        });
      }
    });
    // Daily account history is useful for context but must not make a valid,
    // newer allowance reading disappear when that optional endpoint fails.
    let dailyBuckets = 0;
    /** @type {string | null} */
    let usageWarning = null;
    try {
      const usage = await client.request('account/usage/read');
      for (const bucket of usage?.dailyUsageBuckets || []) {
        store.upsertDailyUsage(CODEX.id, bucket.startDate, bucket.tokens);
        dailyBuckets += 1;
      }
    } catch {
      usageWarning = 'Codex daily usage could not be read.';
    }
    return { observations, rejected, lastRejection, dailyBuckets, resetCredits, usageWarning };
  } finally {
    client.close();
  }
}

/**
 * @param {string} root
 * @param {number} cutoffMs
 * @param {Set<string>} [legacyFiles]
 * @param {Set<string>} [movedLegacyNames]
 */
function listSessionFiles(root, cutoffMs, legacyFiles = new Set(), movedLegacyNames = new Set()) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length) {
    // The loop runs only while the stack holds a folder.
    const current = /** @type {string} */ (stack.pop());
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= cutoffMs || legacyFiles.has(path.resolve(fullPath).toLowerCase())
            || movedLegacyNames.has(entry.name.toLowerCase())) result.push({ fullPath, stat });
        } catch { /* Session rotation can remove a file between calls. */ }
      }
    }
  }
  return result;
}

// Rate-limit notifications repeat the last request's usage without advancing
// the cumulative counters. Only complete, valid counter snapshots establish
// that identity; older logs without totals retain their per-record behaviour.
/**
 * @param {Record<string, any> | null | undefined} info The `info` of a token_count record.
 * @param {unknown} sessionId
 * @param {unknown} model
 * @param {unknown} occurredAt
 */
function usageFingerprint(info, sessionId, model, occurredAt) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  if ((model != null && typeof model !== 'string') || !epochToIso(occurredAt)) return null;
  const snapshots = [info?.total_token_usage, info?.last_token_usage];
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
    'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
  const values = [];
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    if (['input_tokens', 'output_tokens', 'total_tokens'].some((field) => !Number.isSafeInteger(snapshot[field]))) return null;
    const tokens = fields.map((field) => snapshot[field] ?? 0);
    if (tokens.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
    if (snapshot.reasoning_output_tokens > snapshot.output_tokens) return null;
    values.push(tokens);
  }
  return JSON.stringify([sessionId, ...values]);
}

// A fork's rollout begins with its own session_meta; Codex then copies the
// parent's session_meta and history into it, stamped at the moment of the
// copy. The fork keeps its own identity, and token counts stamped with that
// copy are the parent's usage, recorded from the parent's own rollout.
const COPIED_HISTORY_MS = 1000;

/**
 * @param {Iterable<string>} lines
 * @param {SessionState} state Updated as the lines are read.
 * @param {(message: string) => void} [onRejected]
 * @returns {Generator<Record<string, any>, void, unknown>} Each record of the log that is an object.
 */
function* sessionEntries(lines, state, onRejected = /** @type {(message: string) => void} */ (() => {})) {
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch {
      // Only whole lines are read, so this is not a record still being
      // written. Counted, or a damaged log looks like a quiet one.
      if (line.trim()) onRejected('Codex session line is not valid JSON.');
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      onRejected('Codex session record must be an object.');
      continue;
    }
    if (entry.type === 'session_meta') {
      const id = entry.payload?.id;
      if (state.ownId && typeof id === 'string' && id && id !== state.ownId) {
        state.copiedFrom = id;
        state.copiedUntil = Date.parse(entry.timestamp) + COPIED_HISTORY_MS;
        continue;
      }
      if (id) state.sessionId = id;
      state.agent = codexAgentMetadata(entry.payload);
      state.taskId = null;
      state.lastTokenSnapshot = null;
      if (typeof entry.payload?.cwd === 'string' && entry.payload.cwd.trim()) state.project = entry.payload.cwd.trim();
      // The first valid id is the file's own. Cursors from earlier versions
      // carry no ownId and keep the identity they already recorded.
      if (state.ownId === null && typeof id === 'string' && id.trim()) state.ownId = id;
    }
    // `copiedUntil` is unset until a copied session_meta is read, and no time
    // compares as earlier than an unset one, so nothing is skipped before then.
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count'
      && Date.parse(entry.timestamp) <= /** @type {number} */ (state.copiedUntil)) continue;
    if (entry.type === 'turn_context') {
      state.model = entry.payload?.model || state.model;
      state.taskId = textId(entry.payload?.root_turn_id)
        || (state.agent?.agentKind === 'main' ? textId(entry.payload?.turn_id) : null);
    }
    if (entry.type === 'compacted' || (entry.type === 'event_msg' && entry.payload?.type === 'context_compacted')) {
      state.lastTokenSnapshot = null;
    }
    yield entry;
  }
}

// Rollout timestamps have millisecond resolution, and parallel tool turns can
// report two different token counts in the same millisecond. Keying on the
// timestamp alone upserted the second over the first, silently dropping its
// tokens. The ordinal lives in the cursor state, so a resumed read and a
// rescan from the start of the file assign every record the same key.
/**
 * @param {SessionState} state
 * @param {string} timestamp
 */
function eventKeyFor(state, timestamp) {
  if (state.lastEventAt === timestamp) state.sameInstantEvents = (state.sameInstantEvents || 0) + 1;
  else {
    state.lastEventAt = timestamp;
    state.sameInstantEvents = 0;
  }
  const base = `codex:${state.sessionId}:${timestamp}`;
  return state.sameInstantEvents ? `${base}#${state.sameInstantEvents}` : base;
}

// Before forks kept their own identity, a fork's records were filed under
// its parent's session id. A rescan must not import them a second time.
/**
 * @param {Store} store
 * @param {SessionState} state
 * @param {string} eventKey
 */
function parentFiledKey(store, state, eventKey) {
  const prefix = `codex:${state.sessionId}:`;
  if (!state.copiedFrom || !eventKey.startsWith(prefix)) return null;
  const key = `codex:${state.copiedFrom}:${eventKey.slice(prefix.length)}`;
  return store.prepare('SELECT 1 AS found FROM usage_events WHERE event_key = ?').get(key) ? key : null;
}

// Session logs repeat the same rate-limit reading on almost every token
// count. A repeat is kept only when a quarter hour has passed since the last
// kept reading; every one stored is re-read by each later forecast.
const RATE_LIMIT_HEARTBEAT_MS = 15 * 60_000;

// Everything a stored reading carries except its time: a changed plan or
// limit name is a new reading, and must be validated like one.
/** @param {Record<string, any>} raw A rate-limit payload. */
function rateLimitReading(raw) {
  return JSON.stringify([raw.planType ?? raw.plan_type ?? null, raw.limitName ?? raw.limit_name ?? null,
    ...['primary', 'secondary'].map((label) => {
      const window = quotaWindow(raw[label]);
      return window ? [window.usedPercent, window.windowMinutes, window.resetsAt] : null;
    })]);
}

/**
 * @param {Record<string, any>} entry A token_count record with its last usage.
 * @param {SessionState} state
 * @returns {CodexUsageEvent}
 */
function codexUsageEvent(entry, state) {
  const usage = entry.payload.info.last_token_usage;
  return {
    eventKey: eventKeyFor(state, entry.timestamp),
    sourceId: CODEX.id, occurredAt: entry.timestamp, sessionId: state.sessionId,
    model: state.model, project: state.project,
    inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    cacheWrite5mInputTokens: usage.cache_write_input_tokens, cacheWrite1hInputTokens: 0,
    outputTokens: usage.output_tokens, reasoningOutputTokens: usage.reasoning_output_tokens,
    metadata: { source: 'codex-session-log', ...state.agent, taskId: state.taskId || null },
  };
}

// A repair may remove only the exact old importer row still matching the log.
// Manual/imported/conflicting edits are left alone, as are records whose source
// file is unavailable. Keep the same guard for the preflight and the DELETE.
const DUPLICATE_METADATA_FIELDS = /** @type {const} */ (['agentAttributionVersion', 'agentId', 'agentKind', 'parentSessionId',
  'rootSessionId', 'agentName', 'agentRole', 'taskId']);
const DUPLICATE_ROW_GUARD = `event_key = ? AND source_id = 'codex'
  AND occurred_at = ? AND session_id IS ? AND model IS ? AND project IS ?
  AND input_tokens = ? AND cached_input_tokens = ? AND cache_write_input_tokens = ?
  AND cache_write_5m_input_tokens = ? AND cache_write_1h_input_tokens = 0
  AND output_tokens = ? AND reasoning_output_tokens = ? AND reported_cost_usd IS NULL
  AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.source') = 'codex-session-log'
    AND ${DUPLICATE_METADATA_FIELDS.map((field) => `(json_type(metadata_json, '$.${field}') IS NULL OR json_extract(metadata_json, '$.${field}') IS ?)`).join('\n    AND ')}
    AND NOT EXISTS (SELECT 1 FROM json_each(metadata_json) WHERE key NOT IN ('source', ${DUPLICATE_METADATA_FIELDS.map((field) => `'${field}'`).join(', ')}))
    ELSE 0 END`;

/**
 * @param {CodexUsageEvent} event
 * @returns {SQLInputValue[]} The values DUPLICATE_ROW_GUARD binds, in order.
 */
function duplicateRowParameters(event) {
  return [event.eventKey, epochToIso(event.occurredAt), event.sessionId.trim(),
    typeof event.model === 'string' ? event.model.trim() || null : null,
    typeof event.project === 'string' ? event.project.trim() || null : null,
    event.inputTokens ?? 0, event.cachedInputTokens ?? 0, event.cacheWriteInputTokens ?? 0,
    event.cacheWrite5mInputTokens ?? 0, event.outputTokens ?? 0, event.reasoningOutputTokens ?? 0,
    ...DUPLICATE_METADATA_FIELDS.map((field) => event.metadata[field] ?? null)];
}

/**
 * @param {Store} store
 * @param {string} eventKey
 * @param {CodexUsageEvent} event
 */
function retainedSnapshotExists(store, eventKey, event) {
  return Boolean(store.prepare(`SELECT 1 AS found FROM usage_events
    WHERE event_key = ? AND source_id = 'codex' AND session_id IS ?
      AND input_tokens = ? AND cached_input_tokens = ? AND cache_write_input_tokens = ?
      AND cache_write_5m_input_tokens = ? AND cache_write_1h_input_tokens = 0
      AND output_tokens = ? AND reasoning_output_tokens = ?
      AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.source') END = 'codex-session-log'`)
    .get(eventKey, event.sessionId.trim(), event.inputTokens ?? 0, event.cachedInputTokens ?? 0,
      event.cacheWriteInputTokens ?? 0, event.cacheWrite5mInputTokens ?? 0,
      event.outputTokens ?? 0, event.reasoningOutputTokens ?? 0));
}

// Version 1.0.34 introduced ordinal keys without invalidating old cursors.
// Before replaying a collision, verify every held row against its source group.
// Conflicting/manual rows stay untouched, including the rest of that group.
/**
 * @param {Store} store
 * @param {Iterable<string>} lines
 * @param {SessionState} initialState
 * @param {object} checks
 * @param {boolean} checks.checkCollisions
 * @param {boolean} checks.checkDuplicates
 * @param {boolean} checks.protectSingles
 */
function collisionMigration(store, lines, initialState, { checkCollisions, checkDuplicates, protectSingles }) {
  /** @type {Map<string, CodexUsageEvent[]>} */
  const groups = new Map();
  const state = { ...initialState };
  let backupNeeded = false;
  for (const entry of sessionEntries(lines, state)) {
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count' || !entry.payload?.info?.last_token_usage) continue;
    const event = codexUsageEvent(entry, state);
    if (checkDuplicates) {
      const fingerprint = usageFingerprint(entry.payload.info, state.sessionId, state.model, entry.timestamp);
      const previous = state.lastTokenSnapshot;
      if (fingerprint && fingerprint === previous?.fingerprint) {
        if (!backupNeeded && event.eventKey !== previous.eventKey
          && store.prepare(`SELECT 1 AS found FROM usage_events WHERE ${DUPLICATE_ROW_GUARD}`).get(...duplicateRowParameters(event))) backupNeeded = true;
      } else {
        state.lastTokenSnapshot = fingerprint ? { fingerprint, eventKey: event.eventKey } : null;
      }
    }
    if (checkCollisions) {
      const base = `codex:${state.sessionId}:${entry.timestamp}`;
      if (!groups.has(base)) groups.set(base, []);
      // Set on the line above when it was missing.
      /** @type {CodexUsageEvent[]} */ (groups.get(base)).push(event);
    }
  }
  /** @type {Set<string>} */
  const blocked = new Set();
  for (const [base, events] of groups) {
    if (events.length < 2 && !protectSingles) continue;
    let held = false;
    let conflict = false;
    for (const event of events) {
      if (!store.prepare('SELECT 1 FROM usage_events WHERE event_key = ?').get(event.eventKey)) continue;
      held = true;
      // An old unsuffixed row could contain any of the counts at this instant.
      const candidates = event.eventKey === base ? events : [event];
      if (!candidates.some((candidate) => {
        try {
          return store.prepare(`SELECT 1 FROM usage_events WHERE ${DUPLICATE_ROW_GUARD}`)
            .get(...duplicateRowParameters({ ...candidate, eventKey: event.eventKey }));
        } catch (error) {
          if (errorCode(error)) throw error;
          return false;
        }
      })) conflict = true;
    }
    if (conflict) for (const event of events) blocked.add(event.eventKey);
    else if (held && events.length > 1) backupNeeded = true;
  }
  return { blocked, backupNeeded };
}

const normalizedPath = (/** @type {string} */ filePath) => path.resolve(filePath).replaceAll('\\', '/').toLowerCase();

// Archiving a thread in Codex moves its rollout from sessions/ to
// archived_sessions/, and unarchiving moves it back. It is the same log, so it
// keeps its cursor: whatever was appended before the move is still imported,
// and nothing already imported is read again. Rollout names carry their start
// time and session id, so a cursor under the other folder for a file that is no
// longer there is this log's. A copy whose original is still in place is not.
/**
 * @param {Store} store
 * @param {string} fullPath
 * @param {string[]} prefixes The folders rollouts live in, normalized, each ending in a slash.
 */
function movedRolloutCursor(store, fullPath, prefixes) {
  const target = normalizedPath(fullPath);
  const name = `/${path.basename(target)}`;
  const rows = /** @type {{ file_path: string }[]} */ (store.prepare(`SELECT file_path FROM imported_files
    WHERE substr(lower(replace(file_path, char(92), '/')), -?) = ?`).all(name.length, name));
  for (const { file_path: candidate } of rows) {
    const normalized = normalizedPath(candidate);
    if (normalized === target || !prefixes.some((prefix) => normalized.startsWith(prefix))) continue;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// A Codex rollout log carries its session id, working directory, and model in
// earlier lines than the token counts that need them. That context is kept in
// the import cursor's state so an appended chunk can be parsed on its own.
/**
 * @param {Store} store
 * @param {number} [days] How far back a log may have last changed and still be scanned.
 * @returns {SessionImportSummary}
 */
function importLocalSessions(store, days = 120) {
  // CODEX_HOME relocates the whole Codex directory; honour it the way the
  // CLI does. Without an absolute home there is nothing safe to scan.
  const home = providerHome('CODEX_HOME', '.codex');
  if (!home) {
    return { importedFiles: 0, events: 0, observations: 0, rejected: 0, lastRejection: null,
      duplicateEvents: 0, reconciledEvents: 0, reconciliationBackup: null, readErrors: 0, lastReadError: null };
  }
  // Live threads, and threads archived in Codex, which keep their rollout.
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  const prefixes = roots.map((root) => `${normalizedPath(root)}/`);
  // The live scan has a lookback, but a one-time accounting repair must also
  // reach older ledger records whose original, previously imported logs still
  // exist. Do not expand collection to brand-new ancient transcripts.
  const legacyQuery = store.prepare(`SELECT file_path FROM imported_files
    WHERE substr(lower(replace(file_path, char(92), '/')), 1, ?) = ?
      AND CASE WHEN json_valid(state_json) THEN
        COALESCE(json_extract(state_json, '$.accountingVersion'), 0) != 1
        OR COALESCE(json_extract(state_json, '$.agentAttributionVersion'), 0) != 1
        OR COALESCE(json_extract(state_json, '$.eventKeyVersion'), 0) != 1
        ELSE 1 END`);
  const legacyRows = prefixes.flatMap((prefix) => /** @type {{ file_path: string }[]} */ (legacyQuery.all(prefix.length, prefix)));
  const legacyFiles = new Set(legacyRows.map((row) => path.resolve(row.file_path).toLowerCase()));
  // Archiving or unarchiving keeps a log's old modification time, so a legacy
  // log past the lookback must keep its exemption under its new folder, or its
  // cursor is never adopted and its rows never repaired. As in
  // movedRolloutCursor, the name is this log's only once its original is gone.
  const movedLegacyNames = new Set(legacyRows.filter((row) => !fs.existsSync(row.file_path))
    .map((row) => path.basename(row.file_path).toLowerCase()));
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = roots.flatMap((root) => listSessionFiles(root, cutoffMs, legacyFiles, movedLegacyNames));
  let importedFiles = 0;
  let events = 0;
  let observations = 0;
  let rejected = 0;
  /** @type {string | null} */
  let lastRejection = null;
  let duplicateEvents = 0;
  let reconciledEvents = 0;
  /** @type {SessionImportSummary['reconciliationBackup']} */
  let reconciliationBackup = null;
  // A rollout the OS refused to open (antivirus scan, OneDrive hydration) is
  // retried next refresh; counting it keeps "connected" honest meanwhile.
  let readErrors = 0;
  /** @type {string | null} */
  let lastReadError = null;

  for (const { fullPath, stat } of files) {
    let previous = store.getImportedFile(fullPath);
    const movedFrom = previous ? null : movedRolloutCursor(store, fullPath, prefixes);
    if (movedFrom) previous = store.getImportedFile(movedFrom);
    const currentCursor = previous?.state?.agentAttributionVersion === 1 && previous.state.accountingVersion === 1
      && previous.state.eventKeyVersion === 1;
    const plan = planIncrementalRead(currentCursor ? previous : null, stat);
    if (!plan) {
      // Moved with nothing new: the cursor follows the log to its new place.
      if (movedFrom) {
        store.transaction(() => {
          // There is no plan only when a cursor was passed in, so `previous` is set.
          store.markImportedFile(fullPath, stat.mtimeMs, stat.size, /** @type {NonNullable<typeof previous>} */ (previous).state);
          store.forgetImportedFile(movedFrom);
        });
      }
      continue;
    }
    // A cursor written before context was stored cannot resume mid-file.
    const resumable = plan.resumed && previous?.state && typeof previous.state === 'object';
    const startOffset = resumable ? plan.startOffset : 0;
    // A read resumes only from a cursor, so `previous` is set when it does.
    /** @type {SessionState} */
    const state = resumable
      ? { .../** @type {NonNullable<typeof previous>} */ (previous).state }
      : { sessionId: path.basename(fullPath, '.jsonl'), model: null, project: null, agentAttributionVersion: 1, accountingVersion: 1, eventKeyVersion: 1, ownId: null };
    let chunk;
    try {
      chunk = readCompleteLines(fullPath, startOffset, stat.size, { streaming: true });
    } catch (error) {
      readErrors += 1;
      lastReadError = /** @type {NodeJS.ErrnoException} */ (error)?.code || (error instanceof Error ? error.message : String(error));
      continue;
    }
    /** @type {Pick<SessionImportSummary, 'events' | 'observations' | 'rejected' | 'lastRejection' | 'duplicateEvents' | 'reconciledEvents'>} */
    const beforeFile = { events, observations, rejected, lastRejection, duplicateEvents, reconciledEvents };
    try {
      // VACUUM-backed safety copies must happen outside the file transaction.
      // A clean first import makes no backup unless source-verified historical
      // records need a repair. Current cursors skip this read-only preflight.
      // Restored ledgers and moved logs can have historical events but no cursor.
      // Keys are globally unique: restored/manual rows may use another source
      // while retaining a Codex key. Probe the indexed key namespace itself.
      const missingHistoricalCursor = !previous && Boolean(store.prepare("SELECT 1 FROM usage_events WHERE event_key >= 'codex:' AND event_key < 'codex;' LIMIT 1").get());
      const checkCollisions = (previous && previous.state?.eventKeyVersion !== 1) || missingHistoricalCursor;
      const checkDuplicates = (previous || missingHistoricalCursor) && !currentCursor && !plan.resumed && !reconciliationBackup;
      // Share one preflight scan for both repairs. Normal current-cursor reads
      // retain their single streaming pass.
      const migration = checkCollisions || checkDuplicates
        ? collisionMigration(store, chunk.lines, state, { checkCollisions, checkDuplicates, protectSingles: missingHistoricalCursor })
        : { blocked: new Set(), backupNeeded: false };
      if (!reconciliationBackup && migration.backupNeeded) {
        reconciliationBackup = store.createBackup();
      }
      const recordLocalRateLimit = (/** @type {Record<string, any>} */ entry) => recordRateLimit(store, entry.payload.rate_limits, entry.timestamp, 'local-official', {}, {
        onRejected: (error) => {
          rejected += 1;
          lastRejection = error instanceof Error ? error.message : String(error);
        },
      });
      // One commit per file: the rows and the cursor that says they were read
      // land together, and a first import no longer pays a WAL sync per event.
      store.transaction(() => {
        /** @type {Map<string, Record<string, any>>} */
        const repeatedRateLimits = new Map();
        for (const entry of sessionEntries(chunk.lines, state, (message) => { rejected += 1; lastRejection = message; })) {
          if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
          const usage = entry.payload?.info?.last_token_usage;
          if (usage) {
            const event = codexUsageEvent(entry, state);
            const fingerprint = usageFingerprint(entry.payload.info, state.sessionId, state.model, entry.timestamp);
            const previousSnapshot = state.lastTokenSnapshot;
            const duplicate = fingerprint && fingerprint === previousSnapshot?.fingerprint
              && retainedSnapshotExists(store, previousSnapshot.eventKey, event);
            const parentKey = !migration.blocked.has(event.eventKey) && !duplicate ? parentFiledKey(store, state, event.eventKey) : null;
            if (migration.blocked.has(event.eventKey)) {
              state.lastTokenSnapshot = null;
              rejected += 1;
              lastRejection = 'A same-time Codex record conflicts with its source log; its counts were preserved.';
            } else if (duplicate) {
              duplicateEvents += 1;
              if (reconciliationBackup && event.eventKey !== previousSnapshot.eventKey) {
                // The count of rows changed is a plain number: the store does
                // not ask SQLite for big integers.
                reconciledEvents += /** @type {number} */ (store.prepare(`DELETE FROM usage_events WHERE ${DUPLICATE_ROW_GUARD}`)
                  .run(...duplicateRowParameters(event)).changes);
              }
            } else if (parentKey) {
              duplicateEvents += 1;
              state.lastTokenSnapshot = fingerprint ? { fingerprint, eventKey: parentKey } : null;
            } else {
              // One malformed event must not stop the file; see the Claude importer.
              try {
                store.recordUsageEvent(event);
                state.lastTokenSnapshot = fingerprint ? { fingerprint, eventKey: event.eventKey } : null;
                events += 1;
              } catch (error) {
                if (errorCode(error)) throw error;
                state.lastTokenSnapshot = null;
                rejected += 1;
                lastRejection = error instanceof Error ? error.message : String(error);
              }
            }
          }
          if (entry.payload?.rate_limits) {
            const raw = entry.payload.rate_limits;
            const limitId = raw.limitId ?? raw.limit_id ?? CODEX.mainLimitId;
            const reading = rateLimitReading(raw);
            const kept = state.keptRateLimits?.[limitId];
            const at = Date.parse(entry.timestamp);
            if (kept && kept.reading === reading && at - kept.at < RATE_LIMIT_HEARTBEAT_MS) {
              repeatedRateLimits.set(limitId, entry);
            } else {
              repeatedRateLimits.delete(limitId);
              observations += recordLocalRateLimit(entry);
              state.keptRateLimits = { ...state.keptRateLimits, [limitId]: { reading, at } };
            }
          }
        }
        // The last reading of each limit is kept, so the newest local reading
        // is never older than the log.
        for (const [limitId, entry] of repeatedRateLimits) {
          observations += recordLocalRateLimit(entry);
          // A reading counts as repeated only against one already kept for its limit.
          state.keptRateLimits = { ...state.keptRateLimits, [limitId]: { .../** @type {NonNullable<SessionState['keptRateLimits']>} */ (state.keptRateLimits)[limitId], at: Date.parse(entry.timestamp) } };
        }
        store.markImportedFile(fullPath, stat.mtimeMs, startOffset + chunk.consumedBytes, state);
        if (movedFrom) store.forgetImportedFile(movedFrom);
      });
      importedFiles += 1;
    } catch (error) {
      if (!(error instanceof IncrementalReadError)) throw error;
      // The transaction rolled back any rows read before the failure. Keep
      // the returned counters in step with the committed ledger and cursor.
      ({ events, observations, rejected, lastRejection, duplicateEvents, reconciledEvents } = beforeFile);
      readErrors += 1;
      lastReadError = error.code || error.message;
    }
  }
  return { importedFiles, events, observations, rejected, lastRejection, duplicateEvents, reconciledEvents, reconciliationBackup, readErrors, lastReadError };
}

// Whether Codex has an allowance reading whose window is still running, from
// the app server or a session log. A run's count of new rows cannot answer
// that: it is zero whenever nothing was appended since the last refresh. No
// window runs longer than the bound, so it only limits how far back to look.
/**
 * @param {Store} store
 * @param {number} [nowMs]
 */
function hasActiveReading(store, nowMs = Date.now()) {
  return store.hasUsableObservation(CODEX.id, nowMs, { activeWithinMs: MAX_QUOTA_RESET_AHEAD_MS });
}

const withoutFullStop = (/** @type {unknown} */ text) => String(text || 'unknown reason').replace(/\.$/, '');

/**
 * @param {Store} store
 * @param {object} [options]
 * @param {typeof findCodexBinary} [options.findBinary]
 * @param {typeof importLocalSessions} [options.importSessions]
 * @param {typeof collectFromAppServer} [options.collectAppServer]
 */
async function refreshCodex(store, {
  findBinary = findCodexBinary,
  importSessions = importLocalSessions,
  collectAppServer = collectFromAppServer,
} = {}) {
  const binary = findBinary();
  /** @type {SessionImportSummary | NoSessionImport} */
  let local = { importedFiles: 0, events: 0, observations: 0 };
  /** @type {string | null} */
  let localWarning = null;
  let localScanFailed = false;
  try {
    local = importSessions(store);
    if (local.readErrors > 0) {
      localWarning = `${local.readErrors} Codex session log${local.readErrors === 1 ? '' : 's'} could not be read (${local.lastReadError || 'unknown error'}); they will be retried.`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown local error.');
    localWarning = `Codex local session scan failed: ${message}`;
    localScanFailed = true;
  }
  if (!binary) {
    // As below for a failing app server: session logs can keep supplying
    // readings without an executable to start, and the status follows whether
    // one is still in force, not whether this run imported new rows.
    const status = localWarning ? 'error' : hasActiveReading(store) ? 'observing' : 'unavailable';
    const detail = localWarning
      ? `Codex executable was not found. ${localWarning}`
      : 'Codex executable was not found.';
    store.setSourceStatus(CODEX.id, status, detail, { ...local, localWarning });
    return { binary: null, appServer: null, local, localWarning };
  }

  try {
    const appServer = await collectAppServer(store, binary);
    if (!appServer.observations) {
      // The app server answered, but with no window that could be recorded:
      // an empty or unrecognised response, or one the store rejected. The
      // allowance was not read, so the source is not current and this is not
      // a good scan. An earlier reading still in force stays on the dashboard
      // as one this refresh did not replace; without one the allowance is
      // unknown, and no figure stands in for it.
      const active = hasActiveReading(store);
      const cause = appServer.rejected
        ? `The Codex app server's allowance reading could not be recorded (${withoutFullStop(appServer.lastRejection)})`
        : 'The Codex app server returned no allowance reading';
      const standing = active
        ? '; the last recorded reading is still active but was not replaced.'
        : ', and no earlier reading is still active, so the Codex allowance is unknown.';
      store.setSourceStatus(CODEX.id, active ? 'stale' : 'unavailable',
        `${cause}${standing}${localWarning ? ' Local session records could not be scanned.' : ''}`, {
          binary,
          appServer,
          local,
          localWarning,
        }, { scanSucceeded: false });
      return { binary, appServer, local, localWarning };
    }
    // The official allowance was read, so the source is current. Optional
    // extras that failed go in the detail: every consumer reads 'degraded' as
    // stale data and would flip the verdict and send a cached-data alert.
    let detail = 'Connected through the local Codex app server.';
    if (appServer.usageWarning && localWarning) {
      detail = 'Official Codex allowance was updated; optional daily account history and local session records were unavailable.';
    } else if (appServer.usageWarning) {
      detail = 'Official Codex allowance was updated; optional daily account history was unavailable.';
    } else if (localWarning) {
      detail = 'Official Codex allowance was updated; local session records could not be scanned.';
    }
    if (appServer.rejected) {
      detail += ` ${appServer.rejected} allowance window${appServer.rejected === 1 ? '' : 's'} in the reading ${appServer.rejected === 1 ? 'was' : 'were'} rejected and left unchanged (${withoutFullStop(appServer.lastRejection)}).`;
    }
    store.setSourceStatus(CODEX.id, 'connected', detail, {
      binary,
      appServer,
      local,
      localWarning,
    }, { scanSucceeded: true });
    return { binary, appServer, local, localWarning };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown local error.');
    const localDetail = localWarning ? 'Local session records were also unavailable.' : 'Local records were scanned.';
    // While the app server keeps failing, the status says whether a reading is
    // still in force, not whether this run happened to import new rows: that
    // changes from one refresh to the next and would raise a cached-data
    // notification each time. A run in which the local scan failed as well
    // observed nothing.
    const status = !localScanFailed && hasActiveReading(store) ? 'observing' : 'error';
    store.setSourceStatus(CODEX.id, status, `App server unavailable; ${localDetail} ${message}`, {
      binary,
      local,
      localWarning,
    }, { scanSucceeded: false });
    return { binary, appServer: null, local, localWarning, warning: message };
  }
}

module.exports = { stderrExcerpt,
  collectFromAppServer,
  JsonLineClient,
  findCodexBinary,
  importLocalSessions,
  recordRateLimit,
  refreshCodex,
};
