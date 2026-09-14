'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { importLocalSessions } = require('../electron/codex-collector.cjs');
const { importClaudeTranscripts, importClaudeInbox } = require('../electron/claude-collector.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-storage-fault-'));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), root);
  const files = [];
  const directories = [];
  t.after(() => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    store.close();
    for (const file of [...files, ...['', '-wal', '-shm'].map((suffix) => path.join(root, `test.sqlite${suffix}`))]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    for (const directory of directories.toReversed()) fs.rmdirSync(directory);
    fs.rmdirSync(root);
  });
  const write = (parts, records) => {
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      fs.mkdirSync(directory);
      directories.push(directory);
    }
    const file = path.join(root, ...parts);
    fs.writeFileSync(file, `${records.map(JSON.stringify).join('\n')}\n`);
    files.push(file);
    return file;
  };
  return { store, root, write };
}

for (const source of ['codex', 'claude', 'inbox']) {
  for (const failAt of ['record', 'cursor']) {
    test(`${source} ${failAt} storage failure rolls back the file and retries every valid record`, (t) => {
      const { store, root, write } = fixture(t);
      const times = [Date.now() - 2000, Date.now() - 1000].map((ms) => new Date(ms).toISOString());
      let file;
      let importFile;
      if (source === 'codex') {
        file = write(['.codex', 'sessions', 'synthetic.jsonl'], times.map((timestamp) => ({
          type: 'event_msg', timestamp,
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
        })));
        importFile = () => importLocalSessions(store);
      } else if (source === 'claude') {
        file = write(['.claude', 'projects', 'synthetic.jsonl'], times.map((timestamp, index) => ({
          type: 'assistant', timestamp, sessionId: 'synthetic',
          message: { id: `message-${index}`, model: 'claude-fable-5', usage: { input_tokens: 100, output_tokens: 10 } },
        })));
        importFile = () => importClaudeTranscripts(store);
      } else {
        file = write(['inbox.jsonl.rotated-test'], times.map((captured_at) => ({
          captured_at,
          rate_limits: { seven_day: { used_percentage: 50, resets_at: new Date(Date.now() + 86400000).toISOString() } },
        })));
        importFile = () => importClaudeInbox(store, path.join(root, 'inbox.jsonl'));
      }
      const method = failAt === 'cursor' ? 'markImportedFile' : source === 'inbox' ? 'recordObservation' : 'recordUsageEvent';
      const original = store[method];
      const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
      let calls = 0;
      store[method] = function (...args) {
        calls += 1;
        if (failAt === 'cursor' || calls === 2) throw failure;
        return original.apply(this, args);
      };
      if (source === 'inbox') assert.equal(importFile().readErrors, 1);
      else assert.throws(importFile, (error) => error === failure);
      assert.equal(store.getImportedFile(file), null, 'the failed file has no durable cursor');
      const table = source === 'inbox' ? 'quota_observations' : 'usage_events';
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, 'earlier writes rolled back too');
      assert.equal(fs.existsSync(file), true, 'failed rotated inbox remains available for retry');

      store[method] = original;
      importFile();
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 2);
      if (source === 'inbox') {
        assert.equal(fs.existsSync(file), false, 'successfully imported rotation can be removed');
      } else {
        assert.equal(store.getImportedFile(file).size_bytes, fs.statSync(file).size);
        importFile();
        assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 2, 'retry cannot double-count');
      }
    });
  }
}

for (const source of ['codex', 'claude']) {
  for (const field of ['model', 'sessionId']) {
    test(`${source} rejects a malformed ${field} between valid rows without freezing the cursor`, (t) => {
      const { store, write } = fixture(t);
      const times = [0, 1, 2].map((index) => new Date(Date.now() - 3000 + index * 1000).toISOString());
      const records = times.flatMap((timestamp, index) => {
        const context = { sessionId: 'synthetic', model: source === 'codex' ? 'gpt-5.6-sol' : 'claude-fable-5' };
        if (index === 1) context[field] = { malformed: true };
        const usage = { input_tokens: 100, output_tokens: 10 };
        return source === 'codex' ? [
          { type: 'session_meta', timestamp, payload: { id: context.sessionId } },
          { type: 'turn_context', timestamp, payload: { model: context.model } },
          { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } } },
        ] : [{ type: 'assistant', timestamp, sessionId: context.sessionId,
          message: { id: `message-${index}`, model: context.model, usage } }];
      });
      const file = write(source === 'codex' ? ['.codex', 'sessions', 'synthetic.jsonl'] : ['.claude', 'projects', 'synthetic.jsonl'], records);
      const importFile = () => source === 'codex' ? importLocalSessions(store) : importClaudeTranscripts(store);
      const first = importFile();
      assert.equal(source === 'codex' ? first.events : first.usageEvents, 2);
      assert.equal(source === 'codex' ? first.rejected : first.rejectedRows, 1);
      assert.match(first.lastRejection, /must be text/);
      assert.equal(store.getImportedFile(file).size_bytes, fs.statSync(file).size);
      assert.deepEqual(store.db.prepare('SELECT occurred_at FROM usage_events ORDER BY occurred_at').all().map((row) => row.occurred_at), [times[0], times[2]]);
      const second = importFile();
      assert.equal(source === 'codex' ? second.events : second.usageEvents, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
    });
  }
}

test('a malformed Codex quota plan between valid readings is rejected before SQLite binding', (t) => {
  const { store, write } = fixture(t);
  const reset = new Date(Date.now() + 86400000).toISOString();
  const records = [0, 1, 2].map((index) => ({
    type: 'event_msg', timestamp: new Date(Date.now() - 3000 + index * 1000).toISOString(),
    payload: { type: 'token_count', rate_limits: { planType: index === 1 ? { malformed: true } : 'pro',
      primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: reset } } },
  }));
  const file = write(['.codex', 'sessions', 'synthetic.jsonl'], records);
  const first = importLocalSessions(store);
  assert.equal(first.observations, 2);
  assert.equal(first.rejected, 1);
  assert.match(first.lastRejection, /plan type must be text/);
  assert.equal(store.getImportedFile(file).size_bytes, fs.statSync(file).size);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 2);
  assert.equal(importLocalSessions(store).observations, 0);
});
