'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TaskUsage } = require('../electron/task-usage.cjs');
const { UsageStore } = require('../electron/store.cjs');
const NOW = Date.parse('2026-09-06T12:00:00Z');

function event(id, parentSessionId, overrides = {}) {
  return { event_key: id, source_id: 'codex', session_id: id, model: 'gpt-5.6-sol',
    occurred_at: new Date(NOW - 1000).toISOString(), input_tokens: 10,
    cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0,
    metadata_json: JSON.stringify({ parentSessionId, agentKind: 'main' }), ...overrides };
}
function add(usage, row) { usage.add(row, { actualUsd: 1, covered: true }, 11); }
function countLookups(usage) {
  let count = 0;
  const get = usage.parents.get.bind(usage.parents);
  usage.parents.get = (key) => { count += 1; return get(key); };
  return () => count;
}

test('long chains and shared ancestry resolve in linear parent lookups in either row order', () => {
  for (const size of [256, 1024, 4096]) {
    for (const reverse of [false, true]) {
      const usage = new TaskUsage();
      const rows = Array.from({ length: size }, (_, index) => event(`s${index}`, index ? `s${index - 1}` : null));
      if (reverse) rows.reverse();
      for (const row of rows) add(usage, row);
      for (let index = 0; index < size; index += 1) add(usage, event(`leaf${index}`, `s${size - 1}`));
      const lookups = countLookups(usage);
      const tasks = usage.finish(0.5);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].sessionId, 's0');
      assert.equal(tasks[0].totalTokens, size * 22);
      assert.equal(tasks[0].cost, size);
      assert.ok(lookups() <= size * 2, `${size}, reverse=${reverse}: ${lookups()} parent lookups`);
    }
  }
});

test('long cycles and incoming tails keep each original session without repeated walks', () => {
  const size = 2048, usage = new TaskUsage();
  for (let index = 0; index < size; index += 1) {
    add(usage, event(`cycle${index}`, `cycle${(index + 1) % size}`));
    add(usage, event(`tail${index}`, index ? `tail${index - 1}` : 'cycle0'));
  }
  const lookups = countLookups(usage);
  const tasks = usage.finish(1);
  assert.equal(tasks.length, size * 2);
  assert.ok(tasks.every((row) => row.agents.length === 1 && row.sessionId === row.agents[0].sessionId));
  assert.equal(tasks.reduce((sum, row) => sum + row.totalTokens, 0), size * 22);
  assert.ok(lookups() <= size * 2, `${lookups()} parent lookups`);
});

test('explicit roots stay row-specific; missing parents, self parents and providers preserve grouping', () => {
  const usage = new TaskUsage();
  add(usage, event('shared', 'missing'));
  add(usage, event('shared', null, { event_key: 'explicit', metadata_json: JSON.stringify({ rootSessionId: 'explicit-root' }) }));
  add(usage, event('child', 'shared'));
  add(usage, event('shared', 'claude-root', { event_key: 'claude-shared', source_id: 'claude' }));
  add(usage, event('self', 'self'));
  const tasks = usage.finish(1);
  assert.equal(tasks.length, 4);
  assert.equal(tasks.find((row) => row.sessionId === 'missing').usageCount, 2);
  assert.equal(tasks.find((row) => row.sessionId === 'explicit-root').usageCount, 1);
  assert.equal(tasks.find((row) => row.sourceId === 'claude').sessionId, 'claude-root');
  assert.equal(tasks.find((row) => row.sessionId === 'self').usageCount, 1);
});

test('a later finish sees added and replaced parent edges and repaired cycles', () => {
  const usage = new TaskUsage();
  add(usage, event('child', 'parent'));
  assert.equal(usage.finish(1)[0].sessionId, 'parent');
  add(usage, event('parent', 'root'));
  assert.equal(usage.finish(1)[0].sessionId, 'root');
  add(usage, event('root', 'child'));
  assert.equal(usage.finish(1).length, 3);
  add(usage, event('root', 'new-root', { event_key: 'repair' }));
  assert.equal(usage.finish(1)[0].sessionId, 'new-root');
  assert.equal(usage.finish(1)[0].usageCount, 4);
});

test('restored chains remain linear through cold dashboard analytics and database reopen', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-chain-restore-'));
  const file = path.join(dir, 'usage.sqlite');
  let store = new UsageStore(file, dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.updateSettings({ currency: 'USD', usdToCurrency: 1 });
  const size = 1024;
  const rows = Array.from({ length: size }, (_, index) => event(`restore${index}`, index ? `restore${index - 1}` : null));
  for (let index = 0; index < size; index += 2) rows[index].metadata_json = JSON.parse(rows[index].metadata_json);
  const finish = TaskUsage.prototype.finish;
  let passes = 0;
  t.mock.method(TaskUsage.prototype, 'finish', function (rate) {
    const lookups = countLookups(this);
    const tasks = finish.call(this, rate);
    assert.ok(lookups() <= size, `${lookups()} parent lookups on cold analytics`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].sessionId, 'restore0');
    assert.equal(tasks[0].usageCount, size);
    passes += 1;
    return tasks;
  });
  assert.equal(store.restoreFromExport({ schemaVersion: 1, usageEvents: rows }).usageEvents, size);
  for (let pass = 0; pass < 2; pass += 1) {
    assert.equal(store.getDashboardSnapshot(30, NOW).costs.totalTokens, size * 11);
    const task = store.getTaskPage({}, NOW).rows[0];
    assert.equal(task.totalTokens, size * 11);
    assert.equal(task.agents.length, size);
    if (pass === 0) { store.close(); store = new UsageStore(file, dir); }
  }
  assert.ok(passes >= 2, 'both initial restore and reopened database computed cold analytics');
});
