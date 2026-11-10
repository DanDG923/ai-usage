'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planIncrementalRead, readCompleteLines } = require('../../electron/incremental-file.cjs');
const { UsageStore } = require('../../electron/store.cjs');
const { importLocalSessions } = require('../../electron/codex-collector.cjs');

test('planIncrementalRead resumes appended files and restarts rewritten or truncated ones', () => {
  assert.deepEqual(planIncrementalRead(null, { mtimeMs: 1, size: 10 }), { startOffset: 0, resumed: false });
  assert.equal(planIncrementalRead({ modified_ms: 1, size_bytes: 10 }, { mtimeMs: 1, size: 10 }), null);
  assert.deepEqual(planIncrementalRead({ modified_ms: 1, size_bytes: 10 }, { mtimeMs: 2, size: 25 }), { startOffset: 10, resumed: true });
  assert.deepEqual(planIncrementalRead({ modified_ms: 1, size_bytes: 10 }, { mtimeMs: 2, size: 10 }), { startOffset: 0, resumed: false });
  assert.deepEqual(planIncrementalRead({ modified_ms: 1, size_bytes: 10 }, { mtimeMs: 2, size: 4 }), { startOffset: 0, resumed: false });
});

test('readCompleteLines returns only whole lines after the cursor and reports the bytes consumed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-incremental-'));
  const file = path.join(root, 'log.jsonl');
  fs.writeFileSync(file, '\uFEFF{"a":1}\n{"b":2}\n{"partial":');
  const size = fs.statSync(file).size;
  const first = readCompleteLines(file, 0, size);
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
  fs.appendFileSync(file, '3}\n');
  const grown = fs.statSync(file).size;
  const second = readCompleteLines(file, first.consumedBytes, grown);
  assert.deepEqual(second.lines, ['{"partial":3}']);
  assert.equal(first.consumedBytes + second.consumedBytes, grown);
  assert.deepEqual(readCompleteLines(file, grown, grown), { lines: [], consumedBytes: 0 });
});

test('Codex session logs import incrementally with the working directory carried in cursor state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-inc-'));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const sessions = path.join(root, '.codex', 'sessions', '2026', '09', '01');
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-a.jsonl');
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  fs.writeFileSync(file, [
    line({ timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'session-a', cwd: 'C:\\work\\alpha' } }),
    line({ timestamp: '2026-09-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    line({ timestamp: '2026-09-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1 } } } }),
  ].join(''));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const first = importLocalSessions(store);
    assert.equal(first.events, 1);
    const cursor = store.getImportedFile(file);
    assert.equal(cursor.size_bytes, fs.statSync(file).size);
    assert.equal(cursor.state.sessionId, 'session-a');
    assert.equal(cursor.state.model, 'gpt-5.6-sol');
    assert.equal(cursor.state.project, 'C:\\work\\alpha');
    assert.equal(cursor.state.agentAttributionVersion, 1);
    assert.equal(cursor.state.agent.agentKind, 'main');
    assert.equal(store.db.prepare('SELECT project FROM usage_events').get().project, 'C:\\work\\alpha');

    assert.equal(importLocalSessions(store).events, 0);

    // Append a second token count with no session or model context in the chunk.
    fs.appendFileSync(file, line({ timestamp: '2026-09-01T10:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } } } }));
    const second = importLocalSessions(store);
    assert.equal(second.events, 1);
    const rows = store.db.prepare('SELECT session_id, model, project FROM usage_events ORDER BY occurred_at').all();
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[1] }, { session_id: 'session-a', model: 'gpt-5.6-sol', project: 'C:\\work\\alpha' });
  } finally {
    store.close();
    process.env.USERPROFILE = previousProfile;
  }
});

test('a rejected Codex quota window does not discard valid token records or stall the file cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-invalid-'));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const sessions = path.join(root, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-invalid-quota.jsonl');
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const entries = [
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      ...[0, 1].map((index) => ({
        timestamp: `2026-09-01T10:0${index}:00.000Z`,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 100, output_tokens: 5 } },
          rate_limits: index === 0 ? {
            limit_id: 'codex',
            // A cached/reset window can be invalid while the other is valid.
            primary: { used_percent: 20, window_minutes: 300, resets_at: Date.parse('2026-08-31T10:00:00Z') / 1000 },
            secondary: { used_percent: 40, window_minutes: 10080, resets_at: Date.parse('2026-09-05T10:00:00Z') / 1000 },
          } : undefined,
        },
      })),
    ];
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const result = importLocalSessions(store);
    assert.equal(result.events, 2);
    assert.equal(result.observations, 1);
    assert.equal(result.rejected, 1);
    assert.match(result.lastRejection, /Reset time must not be earlier/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
    assert.equal(store.getImportedFile(file).size_bytes, fs.statSync(file).size);
    assert.equal(importLocalSessions(store).importedFiles, 0);
  } finally {
    store.close();
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});
