'use strict';
require('../setup.cjs');
require('../setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const { readCompleteLines } = require('../../electron/incremental-file.cjs');
const { importClaudeTranscripts, importClaudeInbox, refreshClaude } = require('../../electron/claude-collector.cjs');
const { collectFromAppServer } = require('../../electron/codex-collector.cjs');
const { createClaudeAgentSdkUsagePort } = require('../../electron/claude-agent-usage.cjs');
const { createCollectorService } = require('../../electron/collector-service.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-review-collectors-'));
  const previous = Object.fromEntries(['USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  process.env.USERPROFILE = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  process.env.CODEX_HOME = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } fs.rmSync(root, { recursive: true, force: true }); });
  const write = (relative, rows) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    return file;
  };
  return { root, store, write };
}

test('chunked transcript reading preserves UTF-8, partial lines, and repeatable streaming passes', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'chunked.jsonl');
  fs.writeFileSync(file, '\uFEFF{"text":"£😀"}\r\n{"b":2}\n{"torn":');
  const read = readCompleteLines(file, 0, fs.statSync(file).size, { chunkBytes: 2, streaming: true });
  assert.deepEqual([...read.lines], ['{"text":"£😀"}', '{"b":2}']);
  const consumed = read.consumedBytes;
  assert.deepEqual([...read.lines], ['{"text":"£😀"}', '{"b":2}']);
  assert.equal(read.consumedBytes, consumed);
  fs.appendFileSync(file, '3}\n');
  assert.deepEqual(readCompleteLines(file, consumed, fs.statSync(file).size, { chunkBytes: 3 }).lines, ['{"torn":3}']);
});

test('a remainder above the V8 string limit streams without a remainder-sized allocation', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'large.jsonl');
  fs.writeFileSync(file, '');
  const megabyte = 1024 * 1024;
  // Model a large append without creating a half-gigabyte test artifact.
  t.mock.method(fs, 'readSync', (_fd, buffer, offset, length) => {
    assert.ok(buffer.length <= megabyte);
    buffer.fill(0x78, offset, offset + length);
    buffer[offset + length - 1] = 0x0a;
    return length;
  });
  const chunk = readCompleteLines(file, 0, 513 * megabyte, { streaming: true });
  let count = 0;
  for (const line of chunk.lines) { assert.equal(line.length, megabyte - 1); count += 1; }
  assert.equal(count, 513);
  assert.equal(chunk.consumedBytes, 513 * megabyte);
});

test('Claude forks and synthetic messages are skipped and exact historical copies repaired with a backup', (t) => {
  const { store, write } = fixture(t);
  const row = (id, sessionId = 'parent', model = 'claude-fable-5') => ({ type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
    sessionId, message: { id, model, usage: { input_tokens: 100, output_tokens: 10 } } });
  const copies = [row('response', 'child'), row('keep', 'child'), row('synthetic', 'child', '<synthetic>')];
  write('.claude/projects/p/parent.jsonl', [row('response')]);
  const file = write('.claude/projects/p/child.jsonl', copies.slice(0, 2));
  assert.equal(importClaudeTranscripts(store).usageEvents, 3);
  store.prepare("UPDATE usage_events SET input_tokens = 777 WHERE event_key = 'claude-transcript:child:keep'").run();
  write('.claude/projects/p/child.jsonl', copies.map((value) => ({ ...value, forkedFrom: 'parent' })));
  const old = new Date('2020-01-01'); fs.utimesSync(file, old, old);
  store.markImportedFile(file, old.getTime(), fs.statSync(file).size, { agentAttributionVersion: 1 });
  const result = importClaudeTranscripts(store);
  assert.equal(result.repairedEvents, 1);
  assert.equal(result.usageEvents, 0);
  const backup = store.readExport(result.reconciliationBackup.exportPath);
  assert.equal(backup.usageEvents.length, 3);
  const keys = store.prepare('SELECT event_key FROM usage_events ORDER BY event_key').all().map((value) => value.event_key);
  assert.deepEqual(keys, ['claude-transcript:child:keep', 'claude-transcript:parent:response']);
  assert.equal(importClaudeTranscripts(store).repairedEvents, 0);
  store.restoreFromExport(backup);
  assert.equal(importClaudeTranscripts(store).repairedEvents, 1, 'restoring old copies schedules a source-backed repair again');
});

test('a failed Claude fork-repair backup preserves the copied row and its old cursor', (t) => {
  const { store, write } = fixture(t);
  const row = { type: 'assistant', timestamp: '2026-09-01T10:00:00Z', sessionId: 'child',
    message: { id: 'copy', model: 'claude-fable-5', usage: { input_tokens: 100, output_tokens: 10 } } };
  const file = write('.claude/projects/p/child.jsonl', [row]);
  importClaudeTranscripts(store);
  const stat = fs.statSync(file);
  store.markImportedFile(file, stat.mtimeMs, stat.size, { agentAttributionVersion: 1 });
  const cursor = store.getImportedFile(file);
  write('.claude/projects/p/child.jsonl', [{ ...row, forkedFrom: 'parent' }]);
  t.mock.method(store, 'createBackup', () => { throw new Error('Backup unavailable'); });
  assert.throws(() => importClaudeTranscripts(store), /Backup unavailable/);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
  assert.deepEqual(store.getImportedFile(file), cursor);
});

test('replayed rotated inbox evidence does not claim a fresh connection, and torn rotated tails expire', async (t) => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const { root, store, write } = fixture(t);
  const inbox = path.join(root, 'inbox.jsonl');
  write('inbox.jsonl.rotated-old', [{ captured_at: '2026-09-14T08:00:00Z', rate_limits: {
    seven_day: { used_percentage: 20, resets_at: '2026-09-18T12:00:00Z' },
  } }]);
  // Updated deliberately: plan usage is read only on an explicit user refresh now,
  // so this SDK-path test asks for one (readPlanUsage: true).
  await refreshClaude(store, inbox, { readPlanUsage: true, clock: () => new Date(now), usagePort: { read: async () => { throw new Error('Unavailable'); } },
    activityReader: { import: async () => ({ usageEvents: 0 }) } });
  assert.equal(store.prepare("SELECT status FROM sources WHERE id = 'claude'").get().status, 'stale');
  const torn = `${inbox}.rotated-torn`;
  fs.writeFileSync(torn, '{"unfinished":');
  const old = new Date(Date.now() - 2 * 3600_000); fs.utimesSync(torn, old, old);
  importClaudeInbox(store, inbox);
  assert.equal(fs.existsSync(torn), false);
});

test('Codex map keys retain separate bucket identity and duration labels', async (t) => {
  const { store } = fixture(t);
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const windows = Object.fromEntries([['eight', 480], ['day', 1440], ['three', 4320]].map(([id, minutes]) => [id, {
    primary: { usedPercent: 10, windowDurationMins: minutes, resetsAt: reset },
  }]));
  await collectFromAppServer(store, 'fixture', { clientFactory: () => ({ notify() {}, close() {},
    request: async (method) => method === 'account/rateLimits/read' ? { rateLimitsByLimitId: windows } : {},
  }) });
  const rows = store.prepare('SELECT bucket_id, bucket_name FROM quota_observations ORDER BY bucket_id').all();
  assert.deepEqual(rows.map((row) => row.bucket_id), ['day:primary', 'eight:primary', 'three:primary']);
  assert.deepEqual(rows.map((row) => row.bucket_name), ['day · Daily', 'eight · 8-hour', 'three · 3-day']);
});

test('an SDK response without fresh-fetch diagnostics fails once instead of retrying an unsupported signal', async () => {
  let attempts = 0;
  const port = createClaudeAgentSdkUsagePort({ findClaudeBinary: () => path.join(process.platform === 'win32' ? 'C:\\' : '/', 'fixture', 'claude.exe'), retryDelayMs: 0, loadSdk: async () => ({
    query: () => { attempts += 1; return { initializationResult: async () => ({}), return: async () => ({ done: true }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ subscription_type: 'max', rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 20, resets_at: '2026-09-18T12:00:00Z' } } }),
    }; },
  }) });
  await assert.rejects(port.read(), { code: 'claude-usage-unverified' });
  assert.equal(attempts, 1);
});

test('collector requests during an active scan coalesce into one trailing run', async () => {
  let release;
  let calls = 0;
  const service = createCollectorService({ openStore: () => ({}), collectors: { codex: async () => ({}),
    claude: async () => { calls += 1; if (calls === 1) await new Promise((resolve) => { release = resolve; }); return {}; },
  } });
  const first = service.handle({ type: 'refresh-claude' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.handle({ type: 'refresh-claude' });
  const third = service.handle({ type: 'refresh-claude' });
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2);
});

test('the installed Claude SDK exposes the query entry used by the adapter', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  assert.equal(typeof sdk.query, 'function');
});
