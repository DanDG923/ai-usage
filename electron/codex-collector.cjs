'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { findCodexBinary, providerProcessOptions } = require('./provider-executable.cjs');
const { planIncrementalRead, readCompleteLines } = require('./incremental-file.cjs');
const { epochToIso } = require('./time.cjs');

// Read from the manifest so the version reported to Codex cannot drift.
const APP_VERSION = require('../package.json').version;

// The exit message becomes the source's status text, which the dashboard and
// a desktop notification display. Only a short, single-line excerpt of the
// final stderr output is useful there; the full buffer stays in this process.
const MAX_STDERR_EXCERPT = 240;

function stderrExcerpt(stderr) {
  const text = String(stderr || '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_STDERR_EXCERPT ? `…${text.slice(-MAX_STDERR_EXCERPT)}` : text;
}

class JsonLineClient {
  constructor(binary, spawnProcess = spawn) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.failure = null;
    this.lines = null;
    this.child = spawnProcess(binary, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...providerProcessOptions(binary),
    });
    this.child.once('error', (error) => {
      this.fail(new Error(`Codex app server process error: ${error.message}`));
    });
    for (const pipe of ['stdin', 'stdout', 'stderr']) {
      this.child[pipe].on('error', (error) => {
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
      if (message.id == null) return;
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

  writeMessage(message) {
    if (this.closed) throw this.failure ?? new Error('Codex app server client is closed.');
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.fail(new Error(`Codex app server stdin write failed: ${error.message}`));
      });
    } catch (error) {
      const failure = new Error(`Codex app server stdin write failed: ${error.message}`);
      this.fail(failure);
      throw failure;
    }
  }

  request(method, params = null, timeoutMs = 20_000) {
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

  notify(method, params = {}) {
    this.writeMessage({ method, params });
  }

  close() {
    if (!this.closed) this.fail(new Error('Codex app server client was closed.'));
    if (!this.child.killed) this.child.kill();
  }
}

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

function recordRateLimit(store, raw, observedAt, provenance, extra = {}, { onRejected } = {}) {
  if (!raw) return 0;
  const sourceId = 'codex';
  const limitId = raw.limitId ?? raw.limit_id ?? 'codex';
  const limitName = raw.limitName ?? raw.limit_name ?? limitId;
  const planType = raw.planType ?? raw.plan_type ?? null;
  let count = 0;
  for (const [label, value] of [['primary', raw.primary], ['secondary', raw.secondary]]) {
    const window = quotaWindow(value);
    if (!window?.resetsAt) continue;
    const observation = {
      sourceId,
      bucketId: `${limitId}:${label}`,
      bucketName: window.windowMinutes >= 10_000 ? 'Weekly' : window.windowMinutes >= 240 ? 'Five hour' : limitName,
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
      // Historical logs can contain a stale window beside a valid one. The
      // importer reports that rejection and keeps reading; live reads retain
      // their fail-fast behaviour when no rejection handler is supplied.
      // Coded runtime/SQLite failures must still roll back the file so its
      // cursor cannot advance past records that failed to persist.
      if (!onRejected || error?.code) throw error;
      onRejected(error);
    }
  }
  return count;
}

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
      ? Object.values(limits.rateLimitsByLimitId)
      : [limits?.rateLimits].filter(Boolean);
    let observations = 0;
    for (const bucket of buckets) {
      observations += recordRateLimit(store, bucket, observedAt, 'official', { resetCredits });
    }
    // Daily account history is useful for context but must not make a valid,
    // newer allowance reading disappear when that optional endpoint fails.
    let dailyBuckets = 0;
    let usageWarning = null;
    try {
      const usage = await client.request('account/usage/read');
      for (const bucket of usage?.dailyUsageBuckets || []) {
        store.upsertDailyUsage('codex', bucket.startDate, bucket.tokens);
        dailyBuckets += 1;
      }
    } catch {
      usageWarning = 'Codex daily usage could not be read.';
    }
    return { observations, dailyBuckets, resetCredits, usageWarning };
  } finally {
    client.close();
  }
}

function listSessionFiles(root, cutoffMs) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= cutoffMs) result.push({ fullPath, stat });
        } catch { /* Session rotation can remove a file between calls. */ }
      }
    }
  }
  return result;
}

function readSessionLines(fullPath, readFile = fs.readFileSync) {
  try {
    return readFile(fullPath, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

// A Codex rollout log carries its session id, working directory, and model in
// earlier lines than the token counts that need them. That context is kept in
// the import cursor's state so an appended chunk can be parsed on its own.
function importLocalSessions(store, days = 120) {
  const root = path.join(process.env.USERPROFILE || '', '.codex', 'sessions');
  const files = listSessionFiles(root, Date.now() - days * 24 * 60 * 60 * 1000);
  let importedFiles = 0;
  let events = 0;
  let observations = 0;
  let rejected = 0;
  let lastRejection = null;

  for (const { fullPath, stat } of files) {
    const previous = store.getImportedFile(fullPath);
    const plan = planIncrementalRead(previous, stat);
    if (!plan) continue;
    // A cursor written before context was stored cannot resume mid-file.
    const resumable = plan.resumed && previous?.state && typeof previous.state === 'object';
    const startOffset = resumable ? plan.startOffset : 0;
    const state = resumable
      ? { ...previous.state }
      : { sessionId: path.basename(fullPath, '.jsonl'), model: null, project: null };
    let chunk;
    try {
      chunk = readCompleteLines(fullPath, startOffset, stat.size);
    } catch {
      continue;
    }
    // One commit per file: the rows and the cursor that says they were read
    // land together, and a first import no longer pays a WAL sync per event.
    store.transaction(() => {
      for (const line of chunk.lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type === 'session_meta') {
          if (entry.payload?.id) state.sessionId = entry.payload.id;
          if (typeof entry.payload?.cwd === 'string' && entry.payload.cwd.trim()) state.project = entry.payload.cwd.trim();
        }
        if (entry.type === 'turn_context') state.model = entry.payload?.model || state.model;
        if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
        const usage = entry.payload?.info?.last_token_usage;
        const sessionId = state.sessionId;
        const currentModel = state.model;
        if (usage) {
          // One malformed event must not stop the file; see the Claude importer.
          try {
            store.recordUsageEvent({
              eventKey: `codex:${sessionId}:${entry.timestamp}`,
              sourceId: 'codex',
              occurredAt: entry.timestamp,
              sessionId,
              model: currentModel,
              project: state.project,
              inputTokens: usage.input_tokens,
              cachedInputTokens: usage.cached_input_tokens,
              cacheWriteInputTokens: usage.cache_write_input_tokens,
              cacheWrite5mInputTokens: usage.cache_write_input_tokens,
              cacheWrite1hInputTokens: 0,
              outputTokens: usage.output_tokens,
              reasoningOutputTokens: usage.reasoning_output_tokens,
              metadata: { source: 'codex-session-log' },
            });
            events += 1;
          } catch (error) {
            if (error?.code) throw error;
            rejected += 1;
            lastRejection = error instanceof Error ? error.message : String(error);
          }
        }
        if (entry.payload?.rate_limits) {
          observations += recordRateLimit(store, entry.payload.rate_limits, entry.timestamp, 'local-official', {}, {
            onRejected: (error) => {
              rejected += 1;
              lastRejection = error instanceof Error ? error.message : String(error);
            },
          });
        }
      }
      store.markImportedFile(fullPath, stat.mtimeMs, startOffset + chunk.consumedBytes, state);
    });
    importedFiles += 1;
  }
  return { importedFiles, events, observations, rejected, lastRejection };
}

async function refreshCodex(store, {
  findBinary = findCodexBinary,
  importSessions = importLocalSessions,
  collectAppServer = collectFromAppServer,
} = {}) {
  const binary = findBinary();
  let local = { importedFiles: 0, events: 0, observations: 0 };
  let localWarning = null;
  try {
    local = importSessions(store);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown local error.');
    localWarning = `Codex local session scan failed: ${message}`;
  }
  if (!binary) {
    const status = localWarning ? 'error' : local.observations ? 'observing' : 'unavailable';
    const detail = localWarning
      ? `Codex executable was not found. ${localWarning}`
      : 'Codex executable was not found.';
    store.setSourceStatus('codex', status, detail, { ...local, localWarning });
    return { binary: null, appServer: null, local, localWarning };
  }

  try {
    const appServer = await collectAppServer(store, binary);
    const degraded = Boolean(appServer.usageWarning || localWarning);
    let detail = 'Connected through the local Codex app server.';
    if (appServer.usageWarning && localWarning) {
      detail = 'Official Codex allowance was updated; optional daily account history and local session records were unavailable.';
    } else if (appServer.usageWarning) {
      detail = 'Official Codex allowance was updated; optional daily account history was unavailable.';
    } else if (localWarning) {
      detail = 'Official Codex allowance was updated; local session records could not be scanned.';
    }
    store.setSourceStatus('codex', degraded ? 'degraded' : 'connected', detail, {
      binary,
      appServer,
      local,
      localWarning,
    }, { scanSucceeded: true });
    return { binary, appServer, local, localWarning };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown local error.');
    const localDetail = localWarning ? 'Local session records were also unavailable.' : 'Local records were scanned.';
    store.setSourceStatus('codex', local.observations ? 'observing' : 'error', `App server unavailable; ${localDetail} ${message}`, {
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
  readSessionLines,
  recordRateLimit,
  refreshCodex,
};
