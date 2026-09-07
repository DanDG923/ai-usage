'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { UsageStore } = require('../electron/store.cjs');
const { importLocalSessions } = require('../electron/codex-collector.cjs');
const { importClaudeTranscripts, importClaudeInbox } = require('../electron/claude-collector.cjs');
const { createFableUsageTracker } = require('../electron/fable-tracker.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-accounting-'));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  t.after(() => {
    store.close();
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith('ai-usage-accounting-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const write = (relative, records) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${records.map(JSON.stringify).join('\n')}\n`);
    return file;
  };
  return { root, store, write };
}

const now = Date.now() - 60_000;
const timestamp = (index) => new Date(now + index * 1000).toISOString();
const tokens = (multiplier = 1) => ({ input_tokens: 100 * multiplier, cached_input_tokens: 20 * multiplier,
  cache_write_input_tokens: 0, output_tokens: 10 * multiplier, reasoning_output_tokens: 2 * multiplier,
  total_tokens: 110 * multiplier });
const context = [
  { type: 'session_meta', payload: { id: 'session-a', cwd: 'C:\\synthetic' } },
  { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
];
const tokenRecord = (index, cumulative = 1) => ({
  type: 'event_msg', timestamp: timestamp(index), payload: {
    type: 'token_count', info: { total_token_usage: tokens(cumulative), last_token_usage: tokens() },
    rate_limits: { limit_id: 'codex', primary: {
      used_percent: index + 10, window_minutes: 300, resets_at: Math.floor((now + 3600000) / 1000),
    } },
  },
});

function seedOldEvent(store, record, overrides = {}) {
  const usage = record.payload.info.last_token_usage;
  store.recordUsageEvent({ eventKey: `codex:session-a:${record.timestamp}`, sourceId: 'codex',
    occurredAt: record.timestamp, sessionId: 'session-a', model: 'gpt-5.6-sol', project: 'C:\\synthetic',
    inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens, cacheWrite5mInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens, reasoningOutputTokens: usage.reasoning_output_tokens,
    metadata: { source: 'codex-session-log' }, ...overrides });
}

function legacyCursor(store, file) {
  const stat = fs.statSync(file);
  store.markImportedFile(file, stat.mtimeMs, stat.size, {
    sessionId: 'session-a', model: 'gpt-5.6-sol', agentAttributionVersion: 1,
  });
}

test('Codex skips repeated cumulative snapshots across refreshes while preserving quotas and identical new requests', (t) => {
  const { store, write } = fixture(t);
  const file = write('.codex/sessions/rollout.jsonl', [...context, tokenRecord(1)]);
  assert.equal(importLocalSessions(store).events, 1);
  const cursor = store.getImportedFile(file);
  assert.equal(cursor.state.accountingVersion, 1);
  assert.ok(cursor.state.lastTokenSnapshot.fingerprint);
  fs.appendFileSync(file, `${[tokenRecord(2), tokenRecord(3, 2), tokenRecord(4, 2), tokenRecord(5, 1)]
    .map(JSON.stringify).join('\n')}\n`);
  const next = importLocalSessions(store);
  assert.equal(next.events, 2, 'increasing and reset cumulative totals remain new requests');
  assert.equal(next.duplicateEvents, 2);
  assert.equal(next.observations, 4, 'quota notifications remain useful even without new token usage');
  assert.equal(next.reconciliationBackup, null, 'clean import does not create a safety backup');
  assert.deepEqual({ ...store.prepare('SELECT COUNT(*) AS events, SUM(input_tokens + output_tokens) AS tokens FROM usage_events').get() },
    { events: 3, tokens: 330 });
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 5);
  assert.equal(importLocalSessions(store).importedFiles, 0);
});

test('same-timestamp snapshots preserve their first event and legacy logs without cumulative totals keep every request', (t) => {
  const { store, write } = fixture(t);
  const legacy = [tokenRecord(2), tokenRecord(3)];
  for (const record of legacy) delete record.payload.info.total_token_usage;
  write('.codex/sessions/rollout.jsonl', [...context, tokenRecord(1), tokenRecord(1), ...legacy]);
  const result = importLocalSessions(store);
  assert.equal(result.events, 3);
  assert.equal(result.duplicateEvents, 1);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 3);
});

test('compaction resets snapshot identity even when the first new request reports the same counters', (t) => {
  const { store, write } = fixture(t);
  write('.codex/sessions/rollout.jsonl', [...context, tokenRecord(1), { type: 'compacted' }, tokenRecord(2)]);
  assert.equal(importLocalSessions(store).events, 2);
});

test('a persisted snapshot cannot suppress usage when its retained ledger event no longer exists', (t) => {
  const { store, write } = fixture(t);
  const file = write('.codex/sessions/rollout.jsonl', [...context, tokenRecord(1)]);
  importLocalSessions(store);
  store.prepare('DELETE FROM usage_events').run();
  fs.appendFileSync(file, `${JSON.stringify(tokenRecord(2))}\n`);
  const result = importLocalSessions(store);
  assert.equal(result.events, 1);
  assert.equal(result.duplicateEvents, 0);
  assert.equal(store.prepare('SELECT event_key FROM usage_events').get().event_key, `codex:session-a:${timestamp(2)}`);
});

test('legacy source-backed duplicates are backed up and repaired once without deleting conflicting ledger rows', (t) => {
  const { store, write } = fixture(t);
  const records = Array.from({ length: 10 }, (_, index) => tokenRecord(index + 1));
  const file = write('.codex/sessions/rollout.jsonl', [...context, ...records]);
  records.forEach((record, index) => seedOldEvent(store, record,
    index === 2 ? { inputTokens: 999 }
      : index === 3 ? { metadata: { source: 'manual-import' } }
        : index === 4 ? { model: 'gpt-6-astra' }
          : index === 5 ? { sessionId: 'edited-session' }
            : index === 6 ? { project: 'C:\\corrected-project' }
              : index === 7 ? { metadata: { source: 'codex-session-log', taskId: 'corrected-task' } }
                : index === 8 ? { metadata: { source: 'codex-session-log', note: 'user annotation' } }
                  : index === 9 ? { metadata: { taskId: null, agentId: 'session-a', agentKind: 'main', source: 'codex-session-log' } } : {}));
  legacyCursor(store, file);
  const result = importLocalSessions(store);
  assert.equal(result.reconciledEvents, 2);
  assert.equal(result.duplicateEvents, 9);
  assert.ok(fs.existsSync(result.reconciliationBackup.exportPath));
  const backup = JSON.parse(fs.readFileSync(result.reconciliationBackup.exportPath, 'utf8'));
  assert.equal(backup.usageEvents.length, 10, 'the safety copy retains the complete pre-repair ledger');
  const backupDatabase = new DatabaseSync(result.reconciliationBackup.databasePath, { readOnly: true });
  try {
    assert.equal(backupDatabase.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backupDatabase.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 10);
  } finally { backupDatabase.close(); }
  const restored = new UsageStore(':memory:', path.join(path.dirname(file), 'RestoreBackups'));
  try {
    restored.restoreFromExport(backup);
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 10);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { restored.close(); }
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 8);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 10);
  assert.equal(store.getImportedFile(file).state.accountingVersion, 1);
  assert.equal(store.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const again = importLocalSessions(store);
  assert.equal(again.importedFiles, 0);
  assert.equal(again.reconciliationBackup, null);
});

test('restoring a pre-repair backup schedules source-backed reconciliation even when log bytes are unchanged', (t) => {
  const { store, write } = fixture(t);
  const records = [tokenRecord(1), tokenRecord(2)];
  const file = write('.codex/sessions/rollout.jsonl', [...context, ...records]);
  records.forEach((record) => seedOldEvent(store, record));
  legacyCursor(store, file);
  const first = importLocalSessions(store);
  const backup = JSON.parse(fs.readFileSync(first.reconciliationBackup.exportPath, 'utf8'));
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
  store.restoreFromExport(backup);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
  const restored = importLocalSessions(store);
  assert.equal(restored.reconciledEvents, 1);
  assert.ok(restored.reconciliationBackup);
  assert.notEqual(restored.reconciliationBackup.exportPath, first.reconciliationBackup.exportPath);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
  assert.equal(importLocalSessions(store).importedFiles, 0);
});

test('migration repairs previously imported old logs without importing untracked logs outside the live lookback', (t) => {
  const { store, write } = fixture(t);
  const records = [tokenRecord(1), tokenRecord(2)];
  const file = write('.codex/sessions/archived.jsonl', [...context, ...records]);
  const untracked = write('.codex/sessions/untracked.jsonl', [...context, tokenRecord(3, 2)]);
  const old = new Date(now - 200 * 86400000);
  for (const item of [file, untracked]) fs.utimesSync(item, old, old);
  records.forEach((record) => seedOldEvent(store, record));
  legacyCursor(store, file);
  const result = importLocalSessions(store);
  assert.equal(result.importedFiles, 1);
  assert.equal(result.reconciledEvents, 1);
  assert.equal(store.getImportedFile(file).state.accountingVersion, 1);
  assert.equal(store.getImportedFile(untracked), null);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
  assert.equal(importLocalSessions(store).importedFiles, 0, 'the old file needs no repeated migration');
});

test('a failed safety backup leaves every legacy ledger row and cursor unchanged', (t) => {
  const { store, write } = fixture(t);
  const records = [tokenRecord(1), tokenRecord(2)];
  const file = write('.codex/sessions/rollout.jsonl', [...context, ...records]);
  records.forEach((record) => seedOldEvent(store, record));
  legacyCursor(store, file);
  const before = store.prepare('SELECT * FROM usage_events ORDER BY event_key').all();
  const previous = store.getImportedFile(file);
  let backupAttempts = 0;
  store.createBackup = () => { backupAttempts += 1; throw new Error('Synthetic backup write failure'); };
  assert.throws(() => importLocalSessions(store), /Synthetic backup write failure/);
  assert.equal(backupAttempts, 1);
  assert.deepEqual(store.prepare('SELECT * FROM usage_events ORDER BY event_key').all(), before);
  assert.deepEqual(store.getImportedFile(file), previous);
});

test('repair cannot delete the retained same-timestamp row, and failed cursor writes roll back duplicate deletion', (t) => {
  const { store, write } = fixture(t);
  const first = tokenRecord(1), duplicate = tokenRecord(2);
  const file = write('.codex/sessions/rollout.jsonl', [...context, first, first, duplicate]);
  seedOldEvent(store, first);
  seedOldEvent(store, duplicate);
  legacyCursor(store, file);
  const original = store.markImportedFile;
  store.markImportedFile = () => { throw Object.assign(new Error('Synthetic SQLite failure'), { code: 'ERR_SQLITE_ERROR' }); };
  assert.throws(() => importLocalSessions(store), /Synthetic SQLite failure/);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
  assert.equal(store.getImportedFile(file).state.accountingVersion, undefined);
  store.markImportedFile = original;
  assert.equal(importLocalSessions(store).reconciledEvents, 1);
  assert.equal(store.prepare('SELECT event_key FROM usage_events').get().event_key, `codex:session-a:${first.timestamp}`);
});

for (const source of ['codex', 'claude', 'inbox']) {
  test(`${source} rejects null and other nonobject JSON records and advances past them`, (t) => {
    const { store, write } = fixture(t);
    const malformed = [null, [], 42, 'not a record', false];
    let records, relative, importFile;
    if (source === 'codex') {
      records = [...context, tokenRecord(1), ...malformed, tokenRecord(2, 2)];
      relative = '.codex/sessions/rollout.jsonl';
      importFile = () => importLocalSessions(store);
    } else if (source === 'claude') {
      const row = (index) => ({ type: 'assistant', timestamp: timestamp(index), sessionId: 'session-a',
        message: { id: `message-${index}`, model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 10 } } });
      records = [row(1), ...malformed, row(2)];
      relative = '.claude/projects/rollout.jsonl';
      importFile = () => importClaudeTranscripts(store);
    } else {
      const row = (index) => ({ captured_at: timestamp(index), rate_limits: {
        seven_day: { used_percentage: 20, resets_at: new Date(now + 86400000).toISOString() },
      } });
      records = [row(1), ...malformed, row(2)];
      relative = 'inbox.jsonl';
      importFile = () => importClaudeInbox(store, file);
    }
    const file = write(relative, records);
    const result = importFile();
    assert.equal(result.rejected ?? result.rejectedRows ?? result.rejectedRecords, 5);
    const table = source === 'inbox' ? 'quota_observations' : 'usage_events';
    assert.equal(store.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 2);
    assert.equal(store.getImportedFile(file).size_bytes, fs.statSync(file).size);
    const second = importFile();
    assert.equal(second.events ?? second.usageEvents, 0);
  });
}

for (const slow of ['provider', 'activity']) {
  test(`diagnostics stop each timer at settlement when ${slow} is slower and the other operation rejects`, async (t) => {
    const { store } = fixture(t);
    const baseline = Date.now();
    let wallClock = baseline;
    t.mock.method(Date, 'now', () => wallClock);
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    };
    const provider = deferred(), activity = deferred();
    const tracker = createFableUsageTracker({ store, clock: () => new Date(baseline),
      usagePort: { read: () => provider.promise }, activityReader: { import: () => activity.promise } });
    const refresh = tracker.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    wallClock += 20;
    (slow === 'provider' ? activity : provider).reject(new Error('Synthetic fast failure'));
    await new Promise((resolve) => setImmediate(resolve));
    wallClock += 100;
    if (slow === 'provider') provider.resolve({ rate_limits_available: false, reason: 'Synthetic unavailable quota' });
    else activity.resolve({ usageEvents: 0, filesFound: 0 });
    const result = await refresh;
    assert.equal(result.provider.durationMs, slow === 'provider' ? 120 : 20);
    assert.equal(result.health.activityDurationMs, slow === 'activity' ? 120 : 20);
  });
}
