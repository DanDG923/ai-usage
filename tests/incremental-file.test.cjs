'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planIncrementalRead, readCompleteLines } = require('../electron/incremental-file.cjs');
const { UsageStore } = require('../electron/store.cjs');
const { importLocalSessions } = require('../electron/codex-collector.cjs');

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
    assert.deepEqual(cursor.state, { sessionId: 'session-a', model: 'gpt-5.6-sol', project: 'C:\\work\\alpha' });
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
