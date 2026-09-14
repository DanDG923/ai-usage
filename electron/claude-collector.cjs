'use strict';

const fs = require('node:fs');
const { claudeAgentMetadata } = require('./task-usage.cjs');
const path = require('node:path');
const { findClaudeBinary, providerHome } = require('./provider-executable.cjs');
const { createClaudeAgentSdkUsagePort } = require('./claude-agent-usage.cjs');
const { createFableUsageTracker, OFFICIAL_PROVENANCES } = require('./fable-tracker.cjs');
const { planIncrementalRead, readCompleteLines } = require('./incremental-file.cjs');
const { epochToIso } = require('./time.cjs');
const { createAllowanceScaler } = require('./allowance-changes.cjs');
const { QUOTA_CLOCK_SKEW_MS, validQuotaTime } = require('./quota-time.cjs');

const MAX_INBOX_BYTES = 2 * 1024 * 1024;

function emptyInboxResult(overrides = {}) {
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

function laterIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function importClaudeInboxFile(store, inboxPath) {
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
  let buffer;
  try {
    buffer = fs.readFileSync(inboxPath);
  } catch {
    return emptyInboxResult({ readErrors: 1 });
  }
  const tail = buffer.subarray(startOffset);
  const finalNewline = tail.lastIndexOf(0x0a);
  if (finalNewline < 0) {
    store.markImportedFile(inboxPath, stat.mtimeMs, startOffset);
    return emptyInboxResult({ bytesRead: tail.length });
  }
  const completeBytes = finalNewline + 1;
  const chunk = tail.subarray(0, completeBytes).toString('utf8').replace(/^\uFEFF/, '');
  const lines = chunk.split(/\r?\n/).filter(Boolean);
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
      const capturedAt = epochToIso(payload.ai_usage_captured_at || payload.captured_at || new Date().toISOString());
      if (!capturedAt || !payload.rate_limits || typeof payload.rate_limits !== 'object' || Array.isArray(payload.rate_limits)) {
        result.rejectedRecords += 1;
        continue;
      }
      const model = payload.model?.id || payload.model?.display_name || 'claude-unknown';
      const limits = payload.rate_limits;
      for (const [key, limit] of Object.entries(limits)) {
        if (!limit || limit.used_percentage == null || limit.resets_at == null) continue;
        const isFable = key.toLowerCase().includes('fable');
        const sourceId = isFable ? 'claude-fable' : 'claude';
        const minutes = key.includes('five_hour') ? 300 : key.includes('seven_day') || isFable ? 10_080 : null;
        const bucketName = isFable ? 'Fable 5 weekly' : key === 'five_hour' ? 'Five hour' : key === 'seven_day' ? 'Weekly' : key.replaceAll('_', ' ');
        const resetsAt = epochToIso(limit.resets_at);
        if (!resetsAt) {
          result.invalidResets += 1;
          continue;
        }
        try {
          store.recordObservation({
            sourceId,
            bucketId: isFable && ['fable_seven_day', 'fable_weekly'].includes(key.toLowerCase()) ? 'fable_seven_day' : isFable ? `fable:${key}` : key,
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
            metadata: { model, sharedWithOverall: isFable },
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
    // Never rewrite the live helper file: doing so can race an in-flight append.
    // The durable byte cursor keeps refresh work incremental without risking data.
    store.markImportedFile(inboxPath, stat.mtimeMs, startOffset + completeBytes);
    return result;
  });
}

function importClaudeInbox(store, inboxPath) {
  const directory = path.dirname(inboxPath);
  const base = path.basename(inboxPath);
  let rotated = [];
  try {
    rotated = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`${base}.rotated-`))
      .sort()
      .map((name) => path.join(directory, name));
  } catch { /* The inbox directory is created lazily by the helper. */ }
  const total = emptyInboxResult();
  const numericKeys = ['snapshots', 'usageEvents', 'observations', 'claudeObservations', 'fableObservations',
    'invalidRecords', 'invalidResets', 'rejectedRecords', 'readErrors', 'bytesRead'];
  for (const filePath of [...rotated, inboxPath]) {
    let result;
    try {
      result = importClaudeInboxFile(store, filePath);
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
        if (cursor >= stat.size) {
          fs.unlinkSync(filePath);
          store.forgetImportedFile(filePath);
        }
      } catch { /* A future refresh safely retries cleanup. */ }
    }
  }
  return total;
}

function listTranscriptFiles(root, cutoffMs) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
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
          if (stat.mtimeMs >= cutoffMs) files.push({ fullPath, stat });
        } catch {
          // A session can disappear while Claude rotates its local records.
        }
      }
    }
  }
  return files;
}

function importClaudeTranscripts(store, days = 120) {
  // CLAUDE_CONFIG_DIR relocates Claude Code's directory, projects included.
  const home = providerHome('CLAUDE_CONFIG_DIR', '.claude');
  if (!home) return { importedFiles: 0, usageEvents: 0, fableEvents: 0, filesFound: 0, rejectedRows: 0, lastRejection: null, readErrors: 0, lastReadError: null };
  const root = path.join(home, 'projects');
  const files = listTranscriptFiles(root, Date.now() - days * 24 * 60 * 60 * 1000);
  let importedFiles = 0;
  let usageEvents = 0;
  let fableEvents = 0;
  let rejectedRows = 0;
  let lastRejection = null;
  let readErrors = 0;
  let lastReadError = null;

  for (const { fullPath, stat } of files) {
    const previous = store.getImportedFile(fullPath);
    const plan = planIncrementalRead(previous?.state?.agentAttributionVersion === 1 ? previous : null, stat);
    if (!plan) continue;
    // Every transcript row is self-describing (session, working directory,
    // usage), so an appended chunk needs no context from earlier lines. A
    // message streamed across two refreshes is upserted by its id either way.
    let chunk;
    try {
      chunk = readCompleteLines(fullPath, plan.startOffset, stat.size);
    } catch (error) {
      // Retried next refresh; counted so the status can say data is missing.
      readErrors += 1;
      lastReadError = error?.code || (error instanceof Error ? error.message : String(error));
      continue;
    }
    const latestByMessage = new Map();
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
      latestByMessage.set(messageId, row);
    }

    // One commit per file: the rows and the cursor that says they were read
    // land together, and a first import no longer pays a WAL sync per message.
    store.transaction(() => {
      for (const [messageId, row] of latestByMessage) {
        const usage = row.message.usage;
        const model = row.message.model || 'claude-unknown';
        const cacheCreation = usage.cache_creation || {};
        let cacheWrite5m = Number(cacheCreation.ephemeral_5m_input_tokens || 0);
        const cacheWrite1h = Number(cacheCreation.ephemeral_1h_input_tokens || 0);
        const cacheWriteTotal = Number(usage.cache_creation_input_tokens || cacheWrite5m + cacheWrite1h);
        if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
        // One malformed message must not stop the file: the cursor still
        // advances, the row is counted as rejected, and the rest is imported.
        try {
          store.recordUsageEvent({
            eventKey: `claude-transcript:${row.sessionId || 'unknown-session'}:${messageId}`,
            sourceId: 'claude',
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
          });
        } catch (error) {
          if (error?.code) throw error;
          rejectedRows += 1;
          lastRejection = error instanceof Error ? error.message : String(error);
          continue;
        }
        usageEvents += 1;
        if (String(model).toLowerCase().includes('fable')) fableEvents += 1;
      }
      store.markImportedFile(fullPath, stat.mtimeMs, plan.startOffset + chunk.consumedBytes, { agentAttributionVersion: 1 });
    });
    importedFiles += 1;
  }
  return { importedFiles, usageEvents, fableEvents, filesFound: files.length, rejectedRows, lastRejection, readErrors, lastReadError };
}

const FABLE_BUCKET = 'fable_seven_day';
const OVERALL_BUCKET = 'seven_day';
// Fable's cap is half the overall weekly allowance: spending all of Fable is
// spending half the week. So one point of Fable is half a point of the overall
// pool, and a Fable estimate at a given instant cannot exceed twice the overall
// percentage observed at that same instant.
const FABLE_ALLOWANCE_SHARE = 0.5;

// Versioned allowance-pressure weights are deliberately independent of the
// user-editable API price catalogue. They are only a stable attribution model
// for splitting a provider-reported allowance step between Claude model
// families; changing display prices or FX must never rewrite subscription use.
const ALLOWANCE_PRESSURE_V1 = [
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
];

// Longest name first so a dated variant matches its exact family, not a
// shorter prefix. Built once; the per-model answer is remembered because the
// pressure scan asks for it once per usage event.
const ALLOWANCE_PROFILES = ALLOWANCE_PRESSURE_V1
  .map(([name, input, write5m, write1h, read, output]) => ({ name, input, write5m, write1h, read, output }))
  .sort((a, b) => b.name.length - a.name.length);
const allowanceProfiles = new Map();

function allowanceProfile(model) {
  const normalized = String(model || '').toLowerCase().trim();
  let profile = allowanceProfiles.get(normalized);
  if (profile === undefined) {
    profile = ALLOWANCE_PROFILES.find((entry) => normalized === entry.name || normalized.startsWith(`${entry.name}-`)) || null;
    allowanceProfiles.set(normalized, profile);
  }
  return profile;
}

function allowancePressure(store, modelLike, sinceIso, untilIso) {
  const rows = store.prepare(`
    SELECT * FROM usage_events
    WHERE source_id = 'claude' AND occurred_at >= ? AND occurred_at < ?
      ${modelLike == null ? '' : "AND LOWER(COALESCE(model, '')) LIKE ?"}
  `).all(...(modelLike == null
    ? [sinceIso, untilIso]
    : [sinceIso, untilIso, `%${String(modelLike).toLowerCase()}%`]));
  let pressure = 0;
  let tokens = 0;
  let coveredTokens = 0;
  let coveredEvents = 0;
  for (const row of rows) {
    const profile = allowanceProfile(row.model);
    const cacheWriteTotal = Number(row.cache_write_input_tokens || 0);
    let cacheWrite5m = Number(row.cache_write_5m_input_tokens || 0);
    const cacheWrite1h = Number(row.cache_write_1h_input_tokens || 0);
    if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
    const eventTokens = Number(row.input_tokens || 0) + Number(row.cached_input_tokens || 0)
      + cacheWriteTotal + Number(row.output_tokens || 0);
    tokens += eventTokens;
    if (!profile) continue;
    coveredEvents += 1;
    coveredTokens += eventTokens;
    pressure += (
      Number(row.input_tokens || 0) * profile.input
      + cacheWrite5m * profile.write5m
      + cacheWrite1h * profile.write1h
      + Number(row.cached_input_tokens || 0) * profile.read
      + Number(row.output_tokens || 0) * profile.output
    ) / 1_000_000;
  }
  return {
    pressure,
    events: rows.length,
    coveredEvents,
    tokens,
    coveredTokens,
    complete: rows.length === coveredEvents && tokens === coveredTokens,
  };
}

// Two official Fable readings bound an interval exactly the way two overall
// readings do, and between them the Fable rate needs no share assumption at
// all: the percentage moved this much, the local Fable value was this many
// fixed allowance-pressure units, and their ratio is the rate. Pairs must share a reset — a delta
// across a reset is meaningless — but a rate learned in one window carries
// into the next, because it is a property of pricing and caps, not the week.
function fablePairCalibration(store, nowMs, usedOf = rawUsedPercent) {
  const sinceIso = new Date(nowMs - 21 * 24 * 60 * 60 * 1000).toISOString();
  const readings = store.getOfficialObservations('claude-fable', FABLE_BUCKET, OFFICIAL_PROVENANCES, sinceIso);
  let deltaSum = 0;
  let pressureSum = 0;
  let pairs = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const before = readings[index - 1];
    const after = readings[index];
    if (Math.abs(new Date(after.resets_at).getTime() - new Date(before.resets_at).getTime()) > 60_000) continue;
    // Backward movement is a correction or a mistyped reading, not consumption.
    const delta = usedOf(after) - usedOf(before);
    // Equal displayed readings are interval-censored: real use may have moved
    // by less than the provider's rounding precision. Treating them as a
    // measured zero rate would freeze every later estimate.
    if (!Number.isFinite(delta) || delta <= 0) continue;
    const measured = allowancePressure(store, 'fable', before.observed_at, after.observed_at);
    if (!(measured.pressure > 0) || !measured.complete) continue;
    deltaSum += delta;
    pressureSum += measured.pressure;
    pairs += 1;
  }
  return pressureSum > 0
    ? { ratePerPressure: deltaSum / pressureSum, pairs, measuredPressure: pressureSum }
    : { ratePerPressure: null, pairs: 0, measuredPressure: 0 };
}

// Every step the overall percentage takes is split between the models that
// caused it, in proportion to fixed allowance-pressure units. Each step is bounded
// by two official readings, so only tokens between those readings matter — a
// week of history this machine never saw cannot distort it.
function fableStepsFromOverall(store, readings, fromMs, toMs, usedOf = rawUsedPercent) {
  const steps = [];
  let rejectedCoverage = 0;
  let highWater = readings.length ? usedOf(readings[0]) : NaN;
  for (let index = 1; index < readings.length; index += 1) {
    const before = readings[index - 1];
    const after = readings[index];
    const atMs = new Date(after.observed_at).getTime();
    // Provider percentages jitter and correct backwards. Consumption is only a
    // new same-window high-water mark; a rebound to an already-seen value adds
    // nothing a second time.
    const afterUsed = usedOf(after);
    if (!Number.isFinite(afterUsed) || !Number.isFinite(highWater)) continue;
    const priorHighWater = highWater;
    highWater = Math.max(highWater, afterUsed);
    // Readings before an anchor still establish the high-water baseline, even
    // though their movement is already included in that anchor.
    if (!(atMs > fromMs) || atMs > toMs) continue;
    const deltaOverall = Math.max(0, afterUsed - priorHighWater);
    if (!(deltaOverall > 0)) continue;
    const fable = allowancePressure(store, 'fable', before.observed_at, after.observed_at);
    const all = allowancePressure(store, null, before.observed_at, after.observed_at);
    if (!all.complete) {
      rejectedCoverage += 1;
      continue;
    }
    if (!(all.pressure > 0)) continue;
    const share = Math.min(1, fable.pressure / all.pressure);
    steps.push({
      at: after.observed_at,
      deltaOverall,
      share,
      deltaFable: (deltaOverall * share) / FABLE_ALLOWANCE_SHARE,
      fablePressure: fable.pressure,
    });
  }
  return { steps, rejectedCoverage };
}

function rawUsedPercent(row) {
  return Number(row.used_percent);
}

// Every percentage the derivation reads is expressed in the current Claude
// allowance. Readings taken before a recorded allowance change are a share of
// the earlier allowance; without the rescale the step at the change would be
// calibrated as Fable consumption and the earlier pairs would run too cool.
function allowanceAdjustedUsed(store, nowMs) {
  const scaler = createAllowanceScaler(store.getSettings().allowanceChanges, 'claude', {
    bucketId: OVERALL_BUCKET, windowMinutes: 10_080, nowMs,
  });
  if (!scaler) return rawUsedPercent;
  return (row) => {
    const used = rawUsedPercent(row);
    const observedMs = new Date(row.observed_at).getTime();
    return Number.isFinite(used) && Number.isFinite(observedMs) ? used * scaler(observedMs) : used;
  };
}

// A settings change that rescales Claude's history changes what the local
// Fable estimate should say now, not at the next refresh: a derived row that
// already absorbed an allowance jump would otherwise headline the Fable card
// until then, indefinitely under "Only when I refresh". Re-derive at once,
// but only when a derived row is what the card shows; an official reading
// needs no local estimate and must not be displaced by one.
function rederiveFableEstimate(store, nowMs = Date.now()) {
  const latest = displayedFableReading(store, nowMs);
  if (!latest || latest.provenance !== 'derived-tokens') return { derived: false, reason: 'no-derived-estimate' };
  let result;
  try {
    result = deriveFableEstimate(store, nowMs);
  } catch (error) {
    return { derived: false, reason: `derive-failed: ${error.message}` };
  }
  const resetMs = Date.parse(latest.resets_at);
  if (result.derived || result.reason === 'unchanged' || !(resetMs > nowMs)) return result;
  // Under the new setting there is nothing to estimate from, so the figure
  // computed under the old allowance has no replacement. A known-wrong
  // percentage must not stay on the card: discard this live window's derived
  // rows and let the card report the estimate as unavailable until evidence
  // returns. An expired window is already labelled as history and stays, and
  // official and manual readings are never touched.
  const discarded = store.prepare(`DELETE FROM quota_observations WHERE source_id = 'claude-fable' AND bucket_id = ?
    AND provenance = 'derived-tokens' AND resets_at >= ? AND resets_at <= ?`)
    .run(FABLE_BUCKET, new Date(resetMs - 60_000).toISOString(), new Date(resetMs + 60_000).toISOString()).changes;
  return { ...result, discarded: Number(discarded || 0) };
}

// The row the Fable card headlines: the newest reading that passes the same
// time checks getQuota applies. An upgraded or restored database can hold a
// newer malformed official row the card rejects; it must not hide the derived
// row the card actually shows.
function displayedFableReading(store, nowMs) {
  const rows = store.prepare(`SELECT provenance, observed_at, resets_at, window_minutes FROM quota_observations
    WHERE source_id = 'claude-fable' AND bucket_id = ? AND observed_at <= ? ORDER BY observed_at DESC, id DESC`)
    .iterate(FABLE_BUCKET, new Date(nowMs + QUOTA_CLOCK_SKEW_MS).toISOString());
  for (const row of rows) {
    if (validQuotaTime(Date.parse(row.observed_at), Date.parse(row.resets_at), row.window_minutes, nowMs)) return row;
  }
  return null;
}

// When Claude does not expose a model-scoped Fable allowance, a labelled local
// estimate can be derived — but never from a guessed token rate. Two derivations exist, and
// both use only intervals bounded by official readings, so history this
// machine never recorded cannot distort the result:
//   * When two official Fable readings bound a measured interval, the rate
//     between them — Fable percent per allowance-pressure unit — is direct
//     evidence, and it projects the latest anchor forward. This is the only
//     method that keeps moving while the status line is not feeding readings,
//     which is every session run outside the terminal.
//   * Otherwise, every official step the overall figure takes is split between
//     the models that caused it by allowance pressure, and Fable's share,
//     doubled (its cap is half the overall weekly allowance), is its movement.
// At the same timestamp, Fable cannot exceed twice the overall percentage.
// That ceiling must never be carried forward across later local activity: the
// unobserved overall percentage moves too. A manual Fable reading re-anchors
// the running total whenever one is present.
function deriveFableEstimate(store, nowMs = Date.now()) {
  // Read the bucket directly rather than through getQuota, which forecasts
  // every window of every source on the way past.
  const overallWindow = store.getRecentQuotaObservations('claude', OVERALL_BUCKET, OFFICIAL_PROVENANCES, 1)[0];
  if (!overallWindow) return { derived: false, reason: 'no-overall-reading' };
  // Anthropic includes Fable in the shared weekly pool on Max and qualifying
  // premium seats, while Pro and standard seats use credits instead. The local
  // status line does not identify seat class, so anything short of an
  // affirmative Max classification is insufficient evidence for half-pool
  // arithmetic. The structured
  // model-scoped provider window remains authoritative for every plan.
  const planType = String(overallWindow.plan_type || '').trim().toLowerCase();
  if (planType !== 'max') {
    return { derived: false, reason: 'fable-not-confirmed-in-shared-plan' };
  }
  const usedOf = allowanceAdjustedUsed(store, nowMs);
  const resetMs = new Date(overallWindow.resets_at).getTime();
  const windowMinutes = Number(overallWindow.window_minutes) > 0 ? Number(overallWindow.window_minutes) : 10_080;
  const windowMs = windowMinutes * 60_000;
  const overallUsed = usedOf(overallWindow);
  const overallObservedMs = new Date(overallWindow.observed_at).getTime();
  if (!Number.isFinite(resetMs) || !Number.isFinite(overallUsed) || !Number.isFinite(overallObservedMs)) {
    return { derived: false, reason: 'invalid-overall-reading' };
  }
  if (resetMs <= nowMs) return { derived: false, reason: 'overall-window-expired' };
  const windowStartMs = resetMs - windowMs;

  const readings = store.getOfficialObservations('claude', OVERALL_BUCKET, OFFICIAL_PROVENANCES, new Date(windowStartMs).toISOString())
    .filter((row) => Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000);

  // An official Fable reading inside this window is the best possible start.
  // Without one the window starts at zero, which is right after a reset and
  // an understatement on a machine that joined the window late — reported as
  // lower confidence rather than papered over.
  const anchor = store.getRecentQuotaObservations('claude-fable', FABLE_BUCKET, OFFICIAL_PROVENANCES, 1)
    .find((row) => new Date(row.observed_at).getTime() >= windowStartMs
      && Math.abs(new Date(row.resets_at).getTime() - resetMs) <= 60_000) || null;
  const baseUsed = anchor ? usedOf(anchor) : 0;
  const baseAtMs = anchor ? new Date(anchor.observed_at).getTime() : windowStartMs;

  // Structural ceiling at the timestamp of the latest overall observation.
  // Activity after that instant is deliberately added outside the ceiling.
  const ceiling = Math.min(100, overallUsed / FABLE_ALLOWANCE_SHARE);

  // Two rates can move the estimate off its base. A rate measured between two
  // official Fable readings is direct evidence and needs no share assumption,
  // so when one exists it wins. The overall-share split is the fallback — and
  // it needs the overall figure to actually step, which an integer percentage
  // on a machine that mostly runs without the status line may never do.
  const pair = fablePairCalibration(store, nowMs, usedOf);
  let raw;
  let method;
  let steps = [];
  let stepped = 0;
  let tail = 0;
  let ratePerPressure = null;
  let clamped = false;
  if (pair.ratePerPressure != null) {
    method = 'fable-anchor-pair';
    ratePerPressure = pair.ratePerPressure;
    let boundedBase = baseUsed;
    let totalPressure = 0;
    if (baseAtMs < overallObservedMs) {
      const bounded = allowancePressure(store, 'fable', new Date(baseAtMs).toISOString(), new Date(overallObservedMs).toISOString());
      if (!bounded.complete) return { derived: false, reason: 'insufficient-activity-coverage' };
      totalPressure += bounded.pressure;
      const boundedRaw = baseUsed + ratePerPressure * bounded.pressure;
      boundedBase = Math.min(boundedRaw, ceiling);
      clamped = boundedRaw > ceiling + 0.01;
    } else if (baseAtMs === overallObservedMs) {
      boundedBase = Math.min(baseUsed, ceiling);
      clamped = baseUsed > ceiling + 0.01;
    }
    const tailFromMs = Math.max(baseAtMs, overallObservedMs);
    if (nowMs > tailFromMs) {
      const projected = allowancePressure(store, 'fable', new Date(tailFromMs).toISOString(), new Date(nowMs).toISOString());
      if (!projected.complete) return { derived: false, reason: 'insufficient-activity-coverage' };
      totalPressure += projected.pressure;
      tail = ratePerPressure * projected.pressure;
    }
    if (!anchor && !(totalPressure > 0)) return { derived: false, reason: 'no-measured-steps' };
    raw = boundedBase + tail;
  } else {
    if (readings.length < 2) return { derived: false, reason: 'not-enough-overall-readings' };
    method = 'overall-share';
    const steppedResult = fableStepsFromOverall(store, readings, baseAtMs, nowMs, usedOf);
    steps = steppedResult.steps;
    stepped = steps.reduce((total, step) => total + step.deltaFable, 0);
    if (!anchor && steps.length === 0) return {
      derived: false,
      reason: steppedResult.rejectedCoverage ? 'insufficient-activity-coverage' : 'no-measured-steps',
    };

    // Between the last official reading and now the overall figure is unknown,
    // so the movement is projected from the rate the steps themselves measured
    // — Fable percent per allowance-pressure unit, calibrated only on intervals
    // this machine fully recorded.
    const measuredPressure = steps.reduce((total, step) => total + step.fablePressure, 0);
    ratePerPressure = measuredPressure > 0 ? stepped / measuredPressure : null;
    // The tail starts wherever bounded evidence ends: after the last overall
    // reading, but never before the anchor — value the anchor already includes
    // must not be projected a second time.
    const tailFromMs = Math.max(new Date(readings.at(-1).observed_at).getTime(), baseAtMs);
    const tailResult = allowancePressure(store, 'fable', new Date(tailFromMs).toISOString(), new Date(nowMs).toISOString());
    if (!tailResult.complete) return { derived: false, reason: 'insufficient-activity-coverage' };
    tail = ratePerPressure != null ? ratePerPressure * tailResult.pressure : 0;
    const contemporaneousRaw = baseUsed + stepped;
    const boundedBase = baseAtMs <= overallObservedMs ? Math.min(contemporaneousRaw, ceiling) : contemporaneousRaw;
    clamped = baseAtMs <= overallObservedMs && contemporaneousRaw > ceiling + 0.01;
    raw = boundedBase + tail;
  }

  const usedPercent = Math.max(0, Math.min(raw, 100));
  clamped = clamped || raw > 100 + 0.01;

  const latest = store.getRecentQuotaObservations('claude-fable', FABLE_BUCKET, null, 1)[0];
  if (latest && latest.provenance === 'derived-tokens'
    && Math.abs(Number(latest.used_percent) - usedPercent) < 0.05
    && Math.abs(new Date(latest.resets_at).getTime() - resetMs) <= 60_000) {
    return { derived: false, reason: 'unchanged' };
  }
  // Confidence follows the evidence: directly measured Fable intervals are
  // stronger than shared-pool splits, and an anchor strengthens either.
  const confidence = method === 'fable-anchor-pair'
    ? Math.min(0.92, (anchor ? 0.6 : 0.45) + Math.min(pair.pairs, 4) * 0.08)
    : Math.min(0.9, 0.35 + Math.min(steps.length, 10) * 0.05 + (anchor ? 0.15 : 0));
  store.recordObservation({
    sourceId: 'claude-fable',
    bucketId: FABLE_BUCKET,
    bucketName: 'Fable 5 weekly',
    observedAt: new Date(nowMs).toISOString(),
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: new Date(resetMs).toISOString(),
    windowMinutes,
    planType,
    provenance: 'derived-tokens',
    confidence,
    metadata: {
      sharedWithOverall: true,
      calibration: {
        method,
        allowanceShare: FABLE_ALLOWANCE_SHARE,
        overallUsedPercent: overallUsed,
        ceiling,
        clamped,
        anchoredAt: anchor ? anchor.observed_at : null,
        measuredSteps: steps.length,
        measuredPairs: pair.pairs,
        profile: 'allowance-pressure-v1',
        pairMeasuredPressure: pair.measuredPressure,
        steppedPercent: stepped,
        projectedTailPercent: tail,
        percentPerPressureUnit: ratePerPressure,
      },
    },
  });
  return { derived: true, usedPercent, ceiling, clamped, method, measuredSteps: steps.length, measuredPairs: pair.pairs, anchored: Boolean(anchor) };
}

function makeHelperScript(inboxPath) {
  const target = inboxPath.replaceAll("'", "''");
  return `# AI_USAGE_HELPER_VERSION=1.0.3\n$ErrorActionPreference = 'SilentlyContinue'\n$raw = [Console]::In.ReadToEnd()\nif ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }\ntry {\n  $data = $raw | ConvertFrom-Json\n  $safeModel = [ordered]@{}\n  if ($null -ne $data.model.id) { $safeModel.id = $data.model.id }\n  if ($null -ne $data.model.display_name) { $safeModel.display_name = $data.model.display_name }\n  $safe = [ordered]@{\n    ai_usage_captured_at = [DateTime]::UtcNow.ToString('o')\n    model = $safeModel\n    rate_limits = $data.rate_limits\n  }\n  $line = $safe | ConvertTo-Json -Depth 30 -Compress\n  $target = '${target}'\n  $parent = Split-Path -Parent $target\n  New-Item -ItemType Directory -Force -Path $parent | Out-Null\n  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -ge ${MAX_INBOX_BYTES})) {\n    $rotated = $target + '.rotated-' + ([DateTime]::UtcNow.ToString('yyyyMMddHHmmssffff')) + '-' + $PID\n    Move-Item -LiteralPath $target -Destination $rotated -ErrorAction SilentlyContinue\n  }\n  $utf8 = New-Object System.Text.UTF8Encoding($false)\n  [System.IO.File]::AppendAllText($target, $line + [Environment]::NewLine, $utf8)\n  $parts = @()\n  if ($null -ne $data.rate_limits.five_hour.used_percentage) { $parts += ('5h: {0:N0}%' -f $data.rate_limits.five_hour.used_percentage) }\n  if ($null -ne $data.rate_limits.seven_day.used_percentage) { $parts += ('7d: {0:N0}%' -f $data.rate_limits.seven_day.used_percentage) }\n  $fable = $data.rate_limits.PSObject.Properties | Where-Object { $_.Name -match 'fable' } | Select-Object -First 1\n  if ($fable) { $parts += ('Fable: {0:N0}%' -f $fable.Value.used_percentage) }\n  $modelLabel = if ($data.model.display_name) { $data.model.display_name } else { 'Claude' }\n  if ($parts.Count -gt 0) { Write-Output ('[{0}] | {1}' -f $modelLabel, ($parts -join ' ')) } else { Write-Output ('[{0}]' -f $modelLabel) }\n} catch {\n  Write-Output '[Claude]'\n}\n`;
}

function updateManagedHelper(helperPath, inboxPath) {
  if (!fs.existsSync(helperPath)) return false;
  try {
    const current = fs.readFileSync(helperPath, 'utf8');
    if (current.includes('AI_USAGE_HELPER_VERSION=1.0.3')) return false;
    if (!current.includes('ai_usage_captured_at') || !current.includes('ai-usage')) return false;
    fs.writeFileSync(helperPath, makeHelperScript(inboxPath), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function helperPaths() {
  const home = process.env.USERPROFILE;
  if (!home) throw new Error('Windows user profile was not found.');
  const claudeDirectory = path.join(home, '.claude');
  return {
    claudeDirectory,
    settingsPath: path.join(claudeDirectory, 'settings.json'),
    helperPath: path.join(claudeDirectory, 'ai-usage-statusline.ps1'),
    previousStatusLinePath: path.join(claudeDirectory, 'ai-usage-previous-statusline.json'),
  };
}

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
function backupClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  const current = fs.readFileSync(settingsPath);
  const directory = path.dirname(settingsPath);
  const prefix = `${path.basename(settingsPath)}.ai-usage-backup-`;
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
  fs.writeFileSync(helperPath, makeHelperScript(inboxPath), 'utf8');
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

async function refreshClaude(store, inboxPath, options = {}) {
  const binary = findClaudeBinary();
  let statusLine;
  try {
    statusLine = importClaudeInbox(store, inboxPath);
  } catch (error) {
    // The status-line helper is an optional fallback. Its inbox must never
    // prevent the primary SDK read or the independent transcript import.
    statusLine = emptyInboxResult({ readErrors: 1, error: error.message });
  }
  const usagePort = options.usagePort || createClaudeAgentSdkUsagePort({
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
    fallbackObservedAt: statusLine.latestFableObservedAt,
  });
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
      fableDerived = deriveFableEstimate(store);
    } catch (error) {
      // A bad Fable estimate must never take down the whole Claude refresh.
      fableDerived = { derived: false, reason: `derive-failed: ${error.message}` };
    }
  }
  // One definition of where the helper lives, shared with install and uninstall:
  // a second guess here would drive the Enable/Disable button from a path the
  // other two do not use.
  let helperPath = null;
  try { ({ helperPath } = helperPaths()); } catch { /* No Windows profile; nothing is installed. */ }
  let helperInstalled = false;
  try { helperInstalled = isClaudeHelperInstalled(); } catch { /* Unreadable settings cannot confirm an active helper. */ }
  const helperUpdated = helperInstalled ? updateManagedHelper(helperPath, inboxPath) : false;
  // Existence probes, not getQuota: the status text needs a yes or no, and
  // getQuota forecasts every window of the source to produce one.
  const hasQuota = store.hasUsableObservation('claude', Date.now(), { activeWithinMs: 8 * 24 * 60 * 60 * 1000 });
  const providerScanSucceeded = Boolean(fableTracking.provider?.attemptSucceeded
    && ['observed', 'unavailable'].includes(fableTracking.provider.kind));
  const activityCurrent = fableTracking.health.activitySource === 'current';
  const hasFreshClaudeEvidence = statusLine.claudeObservations > 0
    || Number(fableTracking.provider?.overallWindowsRecorded || 0) > 0;
  const claudeScanSucceeded = (hasFreshClaudeEvidence || providerScanSucceeded) && activityCurrent;
  const fableObserved = store.hasUsableObservation('claude-fable');
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
  const claudeStatus = !activityCurrent ? 'degraded'
    : hasFreshClaudeEvidence ? 'connected'
    : hasQuota ? 'stale'
      : transcripts.usageEvents ? 'observing'
        : binary ? 'ready' : 'awaiting-installation';
  const claudeDetail = (!activityCurrent
    ? `${hasFreshClaudeEvidence ? 'Official Claude allowance evidence was refreshed, but' : 'The allowance check completed, but'} the local transcript activity import failed; previously tracked token activity remains available. ${fableTracking.health.detail || ''}`
    : hasFreshClaudeEvidence
    ? `Official Claude allowance evidence was refreshed; scanned ${transcripts.usageEvents} transcript messages.`
    : hasQuota
      ? `The last official Claude allowance is still active, but this refresh did not replace it; scanned ${transcripts.usageEvents} transcript messages.`
      : transcripts.usageEvents
        ? `Scanned ${transcripts.usageEvents} Claude transcript messages; the provider did not return a current allowance${binary ? '.' : ' and no Claude Code executable was found.'}`
        : binary
          ? `Claude Code was found. Automatic plan usage was checked, but no current allowance or local transcript activity was available. ${helperInstalled ? 'The minimized fallback status-line helper is installed.' : 'The status-line helper is available as an optional fallback for overall Claude allowance.'}`
          : 'Claude Code is not currently installed or available locally.') + extraUsageDetail;
  store.setSourceStatus('claude', claudeStatus, claudeDetail, {
    binary,
    inboxPath,
    statusLine,
    transcripts,
    helperInstalled,
    helperUpdated,
    provider: fableTracking.provider,
  }, { scanSucceeded: claudeScanSucceeded });
  const fableAuto = fableDerived.derived || fableDerived.reason === 'unchanged' || fableDerived.reason === 'no-new-tokens';
  const providerCurrent = hasProviderScopedFable && fableTracking.health.officialSource === 'connected';
  const providerStale = hasProviderScopedFable && !providerCurrent;
  const fableStatus = !activityCurrent ? 'degraded'
    : providerCurrent ? 'connected'
    : providerStale ? 'stale'
      : fableAuto ? 'estimating'
        : fableObserved ? 'observing'
          : fableTracking.activity.requests ? 'activity-only' : 'waiting';
  const fableDetail = !activityCurrent
    ? `${providerCurrent ? 'The official model-scoped Fable allowance is current, but' : 'The allowance check completed, but'} the actual local activity import failed; previously tracked counts are retained. ${fableTracking.health.detail || ''}`
    : providerCurrent
    ? `Official model-scoped Fable allowance is collected automatically; ${fableTracking.activity.requests} local Fable usage event${fableTracking.activity.requests === 1 ? '' : 's'} are in the current window.`
    : providerStale
      ? 'The last official model-scoped Fable allowance is still valid, but this refresh could not replace it. Local activity remains available.'
      : fableAuto
        ? 'Fable allowance is estimated from actual local token activity and calibrated official history; it will switch to the provider figure whenever model-scoped usage is available.'
        : fableObserved
          ? 'Fable 5 has allowance history, but the provider did not return a current model-scoped reading.'
          : fableTracking.activity.requests
            ? `Imported ${fableTracking.activity.requests} actual local Fable usage event${fableTracking.activity.requests === 1 ? '' : 's'}; the provider did not return a model-scoped allowance.`
            : 'Waiting for actual local Fable activity or a provider model-scoped allowance.';
  const fableScanSucceeded = activityCurrent && (providerCurrent || fableAuto
    || (!providerStale && (providerScanSucceeded || activityCurrent)));
  store.setSourceStatus('claude-fable', fableStatus, fableDetail, {
    sharedWithOverall: true,
    modelId: 'claude-fable-5',
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
  return { binary, statusLine, transcripts, helperInstalled, helperUpdated, fableObserved, fableDerived, fableTracking,
    ...(!activityCurrent ? { warning: fableTracking.health.detail || 'Local transcript activity is incomplete.' } : {}) };
}

module.exports = { deriveFableEstimate, epochToIso, findClaudeBinary, importClaudeInbox, importClaudeTranscripts, installClaudeHelper, isClaudeHelperInstalled, makeHelperScript, rederiveFableEstimate, refreshClaude, uninstallClaudeHelper };
