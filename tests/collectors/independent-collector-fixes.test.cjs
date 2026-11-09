'use strict';
require('../setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const { importLocalSessions } = require('../../electron/codex-collector.cjs');
const { importClaudeTranscripts } = require('../../electron/claude-collector.cjs');

const timestamp = '2026-09-01T10:00:00.000Z';
const context = (session = 'session-a') => [
  { type: 'session_meta', payload: { id: session, cwd: 'C:\\synthetic' } },
  { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
];
const codexEvent = (inputTokens, time = timestamp) => ({ type: 'event_msg', timestamp: time,
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: inputTokens, output_tokens: 10 } } } });
const claudeEvent = (id, session = 'session-a') => ({ type: 'assistant', timestamp, sessionId: session,
  message: { id, model: 'claude-fable-5', usage: { input_tokens: 100, output_tokens: 10 } } });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-independent-collector-fixes-'));
  const previous = Object.fromEntries(['USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  process.env.USERPROFILE = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  process.env.CODEX_HOME = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  t.after(() => {
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative, rows) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    return file;
  };
  return { store, write };
}

test('a restored Codex ledger without cursors preserves conflicting collision groups and single records', (t) => {
  const { store, write } = fixture(t);
  const singleTime = '2026-09-01T10:01:00.000Z';
  write('.codex/sessions/rollout.jsonl', [...context(), codexEvent(100), codexEvent(200), codexEvent(300, singleTime)]);
  for (const time of [timestamp, singleTime]) {
    store.recordUsageEvent({ eventKey: `codex:session-a:${time}`, sourceId: 'codex', occurredAt: time,
      sessionId: 'session-a', model: 'gpt-5.6-sol', project: 'C:\\synthetic', inputTokens: 777, outputTokens: 10,
      metadata: { source: 'manual', note: 'Retain my correction' } });
  }
  const before = store.prepare('SELECT * FROM usage_events ORDER BY event_key').all();
  const result = importLocalSessions(store);
  assert.equal(result.rejected, 3);
  assert.equal(result.events, 0);
  assert.equal(result.reconciliationBackup, null, 'preserving unchanged conflicting rows needs no backup');
  assert.deepEqual(store.prepare('SELECT * FROM usage_events ORDER BY event_key').all(), before);
});

test('cursorless Codex collision repair backs up verified historical collector rows before replacement', (t) => {
  const { store, write } = fixture(t);
  const file = write('.codex/sessions/rollout.jsonl', [...context(), codexEvent(200)]);
  importLocalSessions(store);
  store.prepare('DELETE FROM imported_files WHERE file_path = ?').run(file);
  write('.codex/sessions/rollout.jsonl', [...context(), codexEvent(100), codexEvent(200)]);
  const result = importLocalSessions(store);
  assert.ok(result.reconciliationBackup);
  assert.deepEqual(store.readExport(result.reconciliationBackup.exportPath).usageEvents.map((row) => row.input_tokens), [200]);
  assert.deepEqual(store.prepare('SELECT input_tokens FROM usage_events ORDER BY event_key').all().map((row) => row.input_tokens), [100, 200]);
});

test('cursorless Codex collision protection preserves matching keys owned by another provider', (t) => {
  const { store, write } = fixture(t);
  write('.codex/sessions/rollout.jsonl', [...context(), codexEvent(100), codexEvent(200)]);
  store.recordUsageEvent({ eventKey: `codex:session-a:${timestamp}`, sourceId: 'claude', occurredAt: timestamp,
    sessionId: 'session-a', model: 'claude-opus-5', inputTokens: 777, outputTokens: 10,
    metadata: { source: 'manual', note: 'Restored provider correction' } });
  const before = store.prepare('SELECT * FROM usage_events').all();
  const result = importLocalSessions(store);
  assert.equal(result.rejected, 2);
  assert.equal(result.events, 0);
  assert.equal(result.reconciliationBackup, null);
  assert.deepEqual(store.prepare('SELECT * FROM usage_events').all(), before);
});

// Return exactly one complete prefix before failing, so the Codex transaction
// has persisted events/observations that must be rolled back. Descriptor
// tracking is path-specific and cannot interfere with SQLite safety backups.
function failRead(t, file, failAt) {
  const open = fs.openSync;
  const read = fs.readSync;
  const descriptors = new Set();
  t.mock.method(fs, 'openSync', function (name, ...args) {
    const fd = open.call(this, name, ...args);
    if (name === file) descriptors.add(fd); else descriptors.delete(fd);
    return fd;
  });
  t.mock.method(fs, 'readSync', function (fd, buffer, offset, length, position) {
    if (!descriptors.has(fd)) return read.call(this, fd, buffer, offset, length, position);
    if (position >= failAt) throw Object.assign(new Error('Synthetic transcript read failure'), { code: 'EIO' });
    return read.call(this, fd, buffer, offset, Math.min(length, failAt - position), position);
  });
}

for (const source of ['codex', 'claude']) {
  for (const partial of [false, true]) {
    test(`${source} ${partial ? 'partial' : 'initial'} streaming read failure rolls back the file and imports healthy transcripts`, (t) => {
      const { store, write } = fixture(t);
      const folder = source === 'codex' ? '.codex/sessions' : '.claude/projects';
      const collect = source === 'codex' ? importLocalSessions : importClaudeTranscripts;
      const initial = source === 'codex' ? [...context(), codexEvent(50)] : [claudeEvent('original')];
      const file = write(`${folder}/a-failing.jsonl`, initial);
      collect(store);
      const cursor = store.getImportedFile(file);
      const rowsBefore = store.prepare('SELECT * FROM usage_events ORDER BY event_key').all();
      const addedEvent = source === 'codex' ? codexEvent(100, '2026-09-01T10:01:00.000Z') : claudeEvent('new');
      if (source === 'codex') addedEvent.payload.rate_limits = { primary: { used_percent: 10, window_minutes: 300,
        resets_at: Date.parse('2026-09-01T15:00:00.000Z') / 1000 } };
      // The rejected primitive also tests that rolled-back diagnostic counters
      // do not leak into the successful file's result.
      const prefix = [false, addedEvent].map(JSON.stringify).join('\n') + '\n';
      fs.appendFileSync(file, prefix + JSON.stringify({ end: true }) + '\n');
      const healthy = source === 'codex' ? [...context('healthy'), codexEvent(200)] : [claudeEvent('healthy', 'healthy')];
      const healthyFile = write(`${folder}/z-healthy.jsonl`, healthy);
      failRead(t, file, cursor.size_bytes + (partial ? Buffer.byteLength(prefix) : 0));
      const result = collect(store);
      assert.equal(result.readErrors, 1);
      assert.equal(result.lastReadError, 'EIO');
      assert.equal(result.importedFiles, 1);
      assert.equal(result.events ?? result.usageEvents, 1);
      assert.equal(result.rejected ?? result.rejectedRows, 0);
      assert.equal(result.lastRejection, null);
      assert.equal(result.observations ?? 0, 0);
      assert.equal(result.fableEvents ?? 0, source === 'claude' ? 1 : 0);
      assert.deepEqual(store.getImportedFile(file), cursor);
      assert.ok(store.getImportedFile(healthyFile));
      assert.deepEqual(store.prepare("SELECT * FROM usage_events WHERE session_id = 'session-a' ORDER BY event_key").all(), rowsBefore);
      assert.equal(store.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 0);
      assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
      t.mock.restoreAll();
      const retry = collect(store);
      assert.equal(retry.readErrors, 0);
      assert.equal(retry.importedFiles, 1);
      assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 3);
      assert.ok(store.getImportedFile(file).size_bytes > cursor.size_bytes);
    });
  }
}

test('Codex migration preflight read failure leaves historical rows and cursor intact and continues', (t) => {
  const { store, write } = fixture(t);
  const file = write('.codex/sessions/a-failing.jsonl', [...context(), codexEvent(100), codexEvent(200)]);
  importLocalSessions(store);
  const cursor = store.getImportedFile(file);
  store.markImportedFile(file, cursor.modified_ms, cursor.size_bytes, { ...cursor.state, eventKeyVersion: 0 });
  const legacyCursor = store.getImportedFile(file);
  const before = store.prepare('SELECT * FROM usage_events ORDER BY event_key').all();
  write('.codex/sessions/z-healthy.jsonl', [...context('healthy'), codexEvent(400)]);
  failRead(t, file, 100);
  const result = importLocalSessions(store);
  assert.equal(result.readErrors, 1);
  assert.equal(result.events, 1);
  assert.equal(result.reconciliationBackup, null);
  assert.deepEqual(store.getImportedFile(file), legacyCursor);
  assert.deepEqual(store.prepare("SELECT * FROM usage_events WHERE session_id = 'session-a' ORDER BY event_key").all(), before);
});
