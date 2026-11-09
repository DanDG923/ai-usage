'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const os = require('node:os');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const NOW = Date.parse('2026-09-05T12:00:00Z');
const DAY = 86400000;

function fixture(t) {
  const store = new UsageStore(':memory:', os.tmpdir());
  t.after(() => store.close());
  store.updateSettings({ currency: 'USD' });
  return store;
}
function add(store, index, overrides = {}) {
  store.recordUsageEvent({ eventKey: `event-${index}`, sourceId: 'claude', model: 'claude-fable-5',
    sessionId: `session-${index}`, project: `C:\\work\\project-${index}`,
    occurredAt: new Date(NOW - index * 1000).toISOString(), inputTokens: (index + 1) * 1000, ...overrides });
}
const page = (store, options = {}, now = NOW) => store.getSessionPage(options, now);

test('session pages cover the entire period while snapshots retain only eight highlights', (t) => {
  const store = fixture(t);
  for (let index = 0; index < 35; index += 1) add(store, index);
  const first = page(store, { pageSize: 10 });
  assert.deepEqual([first.total, first.page, first.pageSize, first.totalPages, first.rows.length], [35, 1, 10, 4, 10]);
  const all = Array.from({ length: 4 }, (_, index) => page(store, { page: index + 1, pageSize: 10 }).rows).flat();
  assert.equal(new Set(all.map((row) => row.sessionId)).size, 35);
  assert.deepEqual(all.map((row) => row.sessionId), Array.from({ length: 35 }, (_, index) => `session-${34 - index}`));
  assert.deepEqual(store.getDashboardSnapshot(30, NOW).costs.sessions, all.slice(0, 8));
  assert.deepEqual(page(store, { page: 999, pageSize: 10 }).rows, all.slice(30));
});

test('search finds low-cost sessions by case-insensitive project, model, provider and session ID', (t) => {
  const store = fixture(t);
  for (let index = 0; index < 20; index += 1) add(store, index);
  add(store, 99, { sourceId: 'codex', sessionId: 'unique-session', model: 'gpt-5.6-sol', project: 'C:\\Work\\Needle', inputTokens: 1 });
  for (const query of [' nEeDlE ', 'Unique-Session', 'GPT-5.6-SOL', 'CODEX']) {
    const result = page(store, { query });
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].sessionId, 'unique-session');
  }
  assert.equal(page(store, { query: 'Claude' }).total, 20);
  assert.deepEqual(page(store, { query: 'no-such-session', page: 8 }), { rows: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
});

test('sessions aggregate per provider, ID and model with ledger-consistent costs and coverage', (t) => {
  const store = fixture(t);
  add(store, 1, { sessionId: 'shared', inputTokens: 100000 });
  add(store, 2, { sessionId: 'shared', inputTokens: 200000 });
  add(store, 3, { sessionId: 'shared', sourceId: 'codex', model: 'gpt-5.6-sol', inputTokens: 100000 });
  add(store, 4, { sessionId: 'shared', model: 'unknown-model', inputTokens: 500 });
  add(store, 5, { sessionId: null, project: null, inputTokens: 0 });
  const result = page(store);
  assert.equal(result.total, 4);
  assert.equal(result.rows[0].cost, 3);
  assert.equal(result.rows[0].totalTokens, 300000);
  assert.equal(result.rows[0].coverage, 1);
  assert.equal(result.rows.find((row) => row.model === 'unknown-model').coverage, 0);
  assert.equal(result.rows.find((row) => row.sessionId === 'event-5').project, null);
});

test('page navigation and search share a bounded aggregation cache and refresh on writes and price changes', (t) => {
  const store = fixture(t);
  for (let index = 0; index < 25; index += 1) add(store, index);
  let builds = 0;
  const original = store.buildAnalytics;
  store.buildAnalytics = function (...args) { builds += 1; return original.apply(this, args); };
  page(store);
  page(store, { page: 2 });
  page(store, { query: 'session-3' });
  store.getCostAnalytics(30, store.getSettings(), NOW);
  assert.equal(builds, 1, 'pages, searches and snapshot costs share one aggregation');
  add(store, 30);
  assert.equal(page(store).total, 26);
  assert.equal(builds, 2);
  store.updatePrice({ model: 'claude-fable-5', inputUsdPerMillion: 20, cacheWriteUsdPerMillion: 25,
    cacheWrite1hUsdPerMillion: 40, cacheReadUsdPerMillion: 2, outputUsdPerMillion: 100 });
  assert.equal(page(store).rows[0].cost, 0.62);
  store.updateSettings({ currency: 'GBP', usdToCurrency: 0.5 });
  assert.equal(page(store).rows[0].cost, 0.31);
  for (const days of [1, 7, 14, 30, 60, 90, 365]) page(store, { days });
  assert.equal(store.costAnalyticsCache.size, 4);
});

test('session period boundaries and rollback never expose stale or uncommitted sessions', (t) => {
  const store = fixture(t);
  // A 7-day period is the last seven local calendar days, today included.
  const start = new Date(NOW);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const nextDay = new Date(NOW);
  nextDay.setHours(24, 0, 0, 0);
  add(store, 1, { occurredAt: start.toISOString() });
  add(store, 3, { occurredAt: new Date(start.getTime() - 1).toISOString() });
  assert.equal(page(store, { days: 7 }).total, 1);
  assert.equal(page(store, { days: 7 }, nextDay.getTime()).total, 0);
  assert.equal(page(store, { days: 7 }, NOW).total, 1);
  assert.throws(() => store.transaction(() => {
    add(store, 2);
    assert.equal(page(store, { days: 7 }).total, 2);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(page(store, { days: 7 }).total, 1);
});

test('session page inputs are bounded before querying the ledger', (t) => {
  const store = fixture(t);
  add(store, 1, { occurredAt: new Date(NOW - 400 * DAY).toISOString() });
  assert.equal(page(store, { days: 9999, pageSize: 9999 }).pageSize, 100);
  assert.equal(page(store, { days: 9999 }).total, 0);
  assert.equal(page(store, { pageSize: -10, page: -4 }).pageSize, 1);
  assert.equal(page(store, { pageSize: NaN, page: Infinity, query: {} }).pageSize, 20);
});
