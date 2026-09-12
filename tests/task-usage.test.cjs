'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { importLocalSessions } = require('../electron/codex-collector.cjs');
const { importClaudeTranscripts } = require('../electron/claude-collector.cjs');
const NOW = Date.parse('2026-09-06T12:00:00Z');

function fixture(t) {
  const store = new UsageStore(':memory:', os.tmpdir());
  store.updateSettings({ currency: 'USD', usdToCurrency: 1 });
  t.after(() => store.close());
  return store;
}
function add(store, id, { metadata = {}, ...overrides } = {}) {
  store.recordUsageEvent({ eventKey: id, sourceId: 'codex', sessionId: 'root', model: 'gpt-5.6-sol',
    occurredAt: new Date(NOW - 1000).toISOString(), project: '/work/app', inputTokens: 1000,
    cachedInputTokens: 200, outputTokens: 100, reasoningOutputTokens: 50,
    metadata: { agentAttributionVersion: 1, agentKind: 'main', agentId: 'root', ...metadata }, ...overrides });
}

test('task accounting reconciles nested agents, model switches, cache and reasoning with the ledger', (t) => {
  const store = fixture(t);
  add(store, 'main');
  add(store, 'child', { sessionId: 'child', metadata: { agentKind: 'subagent', agentId: 'child', parentSessionId: 'root' } });
  add(store, 'grandchild', { sessionId: 'grandchild', metadata: { agentKind: 'subagent', agentId: 'grandchild', parentSessionId: 'child' } });
  add(store, 'child-switched', { sessionId: 'child', model: 'gpt-6-astra', metadata: { agentKind: 'subagent', agentId: 'child', parentSessionId: 'root' } });
  const task = store.getTaskPage({}, NOW).rows[0];
  assert.equal(store.getTaskPage({}, NOW).total, 1);
  assert.equal(task.subagentCount, 2);
  assert.equal(task.agents.length, 4);
  assert.equal(task.totalTokens, 4400);
  assert.equal(task.inputTokens, 3200);
  assert.equal(task.cachedInputTokens, 800);
  assert.equal(task.outputTokens, 400);
  assert.equal(task.reasoningOutputTokens, 200);
  assert.equal(task.main.totalTokens, 1100);
  assert.equal(task.subagent.totalTokens, 3300);
  assert.equal(task.usageCount, 4);
  assert.ok(Math.abs(task.agents.reduce((sum, row) => sum + row.cost, 0) - task.cost) < 1e-9);
  const costs = store.getCostAnalytics(30, store.getSettings(), NOW);
  assert.equal(Math.round(task.cost * 100) / 100, costs.actual);
  assert.equal(task.totalTokens, costs.totalTokens);
});

test('root turn attribution separates tasks without guessing where unlinked child usage belongs', (t) => {
  const store = fixture(t);
  add(store, 'turn-a', { metadata: { taskId: 'turn-a' } });
  add(store, 'turn-b', { metadata: { taskId: 'turn-b' } });
  add(store, 'child-a', { sessionId: 'child', metadata: { agentKind: 'subagent', agentId: 'child', rootSessionId: 'root', taskId: 'turn-a' } });
  add(store, 'unlinked', { sessionId: 'child-old', metadata: { agentKind: 'subagent', agentId: 'child-old', parentSessionId: 'root' } });
  const tasks = store.getTaskPage({}, NOW).rows;
  assert.equal(tasks.length, 3);
  assert.equal(tasks.find((row) => row.taskId === 'turn-a').totalTokens, 2200);
  assert.equal(tasks.find((row) => row.taskId === null).subagentCount, 1);
});

test('missing prices and legacy attribution remain visible; repricing and FX invalidate cached tasks', (t) => {
  const store = fixture(t);
  add(store, 'main');
  add(store, 'unpriced', { sessionId: 'child', model: 'future-model', metadata: { agentKind: 'subagent', agentId: 'child', parentSessionId: 'root' } });
  add(store, 'legacy', { metadata: { agentKind: null, agentId: null } });
  let task = store.getTaskPage({}, NOW).rows[0];
  assert.equal(task.coverage, 2 / 3);
  assert.equal(task.subagent.coverage, 0);
  assert.equal(task.unknown.usageCount, 1);
  assert.equal(task.unknown.totalTokens, 1100);
  const before = task.cost;
  store.updateSettings({ currency: 'GBP', usdToCurrency: 0.5 });
  task = store.getTaskPage({}, NOW).rows[0];
  assert.equal(task.cost, before * 0.5);
  store.updatePrice({ model: 'future-model', inputUsdPerMillion: 10, cacheReadUsdPerMillion: 1,
    cacheWriteUsdPerMillion: 12.5, cacheWrite1hUsdPerMillion: 20, outputUsdPerMillion: 50 });
  assert.equal(store.getTaskPage({}, NOW).rows[0].coverage, 1);
});

test('pagination searches complete task groups by agent, model and provider; cycles are bounded', (t) => {
  const store = fixture(t);
  for (let index = 0; index < 15; index += 1) add(store, `main-${index}`, { sessionId: `root-${index}` });
  add(store, 'named', { sessionId: 'child', metadata: { agentKind: 'subagent', agentId: 'child', agentName: 'Verifier', parentSessionId: 'root-14' } });
  assert.equal(store.getTaskPage({ pageSize: 10 }, NOW).totalPages, 2);
  const selected = store.getTaskPage({ query: 'verIFIER' }, NOW);
  assert.equal(selected.total, 1);
  assert.equal(selected.rows[0].agents.length, 2);
  assert.equal(store.getTaskPage({ query: 'claude' }, NOW).total, 0);
  add(store, 'cycle-a', { sessionId: 'cycle-a', metadata: { parentSessionId: 'cycle-b' } });
  add(store, 'cycle-b', { sessionId: 'cycle-b', metadata: { parentSessionId: 'cycle-a' } });
  assert.equal(store.getTaskPage({}, NOW).total, 17);
  assert.deepEqual(store.getTaskPage({ query: 'missing', page: 99 }, NOW), { rows: [], total: 0, totalPages: 0, pageSize: 20, page: 1 });
});

test('task bounds, rollback and provider identity preserve all usage exactly once', (t) => {
  const store = fixture(t);
  add(store, 'old', { occurredAt: new Date(NOW - 8 * 86400000).toISOString() });
  add(store, 'codex');
  add(store, 'claude', { sourceId: 'claude', model: 'claude-fable-5' });
  assert.equal(store.getTaskPage({ days: 7 }, NOW).total, 2);
  assert.throws(() => store.transaction(() => { add(store, 'rollback', { sessionId: 'transient' });
    assert.equal(store.getTaskPage({ days: 7 }, NOW).total, 3); throw new Error('rollback'); }), /rollback/);
  assert.equal(store.getTaskPage({ days: 7 }, NOW).total, 2);
  const result = store.getTaskPage({ page: -1, pageSize: 9999 }, NOW);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 100);
  assert.equal(result.rows.reduce((sum, row) => sum + row.totalTokens, 0), store.getCostAnalytics(30, store.getSettings(), NOW).totalTokens);
});

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-usage-'));
  const before = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  t.after(() => { if (before === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = before; fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function writeLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
}
const token = (timestamp) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
  last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 50 },
} } });

test('Codex imports modern root task IDs and legacy parent metadata, persists context and backfills old cursors', (t) => {
  const root = profile(t), store = fixture(t);
  const file = path.join(root, '.codex', 'sessions', 'child.jsonl');
  writeLines(file, [
    { type: 'session_meta', payload: { id: 'child', session_id: 'root', source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_nickname: 'Verifier' } } } } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol', turn_id: 'own-turn', root_turn_id: 'task-one' } },
    token(new Date(NOW - 2000).toISOString()),
  ]);
  const stat = fs.statSync(file);
  store.markImportedFile(file, stat.mtimeMs, stat.size, { sessionId: 'child', model: 'gpt-5.6-sol' });
  assert.equal(importLocalSessions(store).events, 1, 'unchanged legacy cursor is re-read once');
  assert.equal(importLocalSessions(store).events, 0);
  fs.appendFileSync(file, JSON.stringify(token(new Date(NOW - 1000).toISOString())) + '\n');
  assert.equal(importLocalSessions(store).events, 1);
  const task = store.getTaskPage({}, NOW).rows[0];
  assert.equal(task.taskId, 'task-one');
  assert.equal(task.sessionId, 'root');
  assert.equal(task.subagentCount, 1);
  assert.equal(task.agents[0].agentName, 'Verifier');
  assert.equal(task.main.usageCount, 0);
  assert.equal(task.activitySpanMs, 1000);
});

test('Claude nested and legacy agent transcripts retain identities through repeated imports and streamed updates', (t) => {
  const root = profile(t), store = fixture(t);
  const base = path.join(root, '.claude', 'projects', 'project');
  const row = (id, extra = {}) => ({ type: 'assistant', sessionId: 'root', timestamp: new Date(NOW - 1000).toISOString(),
    message: { id, model: 'claude-fable-5', content: [{ type: 'text', text: 'PRIVATE CONTENT' }],
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 100 } }, ...extra });
  const childFile = path.join(base, 'root', 'subagents', 'agent-worker.jsonl');
  writeLines(path.join(base, 'root.jsonl'), [row('main')]);
  writeLines(childFile, [row('child', { isSidechain: true, agentId: 'worker' })]);
  writeLines(path.join(base, 'agent-legacy.jsonl'), [row('legacy', { isSidechain: true })]);
  assert.equal(importClaudeTranscripts(store).usageEvents, 3);
  assert.equal(importClaudeTranscripts(store).usageEvents, 0);
  const changed = row('child', { isSidechain: true, agentId: 'worker' });
  changed.message.usage.output_tokens = 200;
  fs.appendFileSync(childFile, JSON.stringify(changed) + '\n');
  importClaudeTranscripts(store);
  const task = store.getTaskPage({}, NOW).rows[0];
  assert.equal(task.subagentCount, 2);
  assert.equal(task.usageCount, 3);
  assert.equal(task.totalTokens, 4900);
  assert.equal(task.main.totalTokens, 1600);
  assert.equal(task.subagent.totalTokens, 3300);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM usage_events').all()).includes('PRIVATE CONTENT'));
});

test('agent identifiers containing framing characters never merge with absent or other identifiers', (t) => {
  const store = fixture(t);
  // Each of these must stay its own agent row: an absent id, and ids that
  // contain the separator, a length-prefix lookalike, or a sentinel character.
  const ids = [null, '~', '1:a', 'a|b', '\u0001'];
  ids.forEach((agentId, index) => add(store, `event-${index}`, {
    sessionId: 'shared', metadata: { agentKind: 'subagent', agentId, parentSessionId: null, rootSessionId: 'shared' },
  }));
  const [task] = store.getTaskPage({ days: 30 }, NOW).rows;
  assert.equal(task.agents.length, ids.length);
  for (const agent of task.agents) assert.equal(agent.usageCount, 1);
  assert.deepEqual(new Set(task.agents.map((agent) => agent.agentId)), new Set(ids));
});
