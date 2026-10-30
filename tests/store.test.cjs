'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-test-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try { return run(store); } finally { store.close(); }
}

test('releasing dashboard caches preserves the complete rebuilt snapshot and stored ledger', () => withStore((store) => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  store.recordUsageEvent({ eventKey: 'cache-release', sourceId: 'codex', model: 'gpt-5.6-sol',
    occurredAt: new Date(now - 60_000).toISOString(), sessionId: 'one-session', inputTokens: 1000, outputTokens: 100 });
  const before = store.getDashboardSnapshot(30, now);
  assert.ok(store.costAnalyticsCache.size > 0);
  store.releaseDashboardCaches();
  assert.equal(store.costAnalyticsCache.size, 0);
  assert.equal(store.cycleHistoryCache.size, 0);
  assert.equal(store.analyticsDayCache.size, 0);
  assert.deepEqual(store.getDashboardSnapshot(30, now), before);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
}));

test('subscription visibility persists across reopening and backup restore without deleting usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-visibility-'));
  const dbPath = path.join(root, 'test.sqlite');
  let store = new UsageStore(dbPath, path.join(root, 'Backups'));
  try {
    assert.equal(store.getSettings().showCodexSubscription, true);
    assert.equal(store.getSettings().showClaudeSubscription, true);
    store.recordUsageEvent({ eventKey: 'keep-hidden-history', sourceId: 'claude', model: 'claude-opus-5',
      occurredAt: new Date().toISOString(), inputTokens: 1_000 });
    const before = store.getCostAnalytics(30);
    store.updateSettings({ showCodexSubscription: false, showClaudeSubscription: false });
    assert.throws(() => store.updateSettings({ showClaudeSubscription: 'false' }));
    assert.equal(store.getDashboardSnapshot().dashboardVerdict.label, 'No subscriptions shown');
    assert.deepEqual(store.getCostAnalytics(30), before);
    store.close();
    store = new UsageStore(dbPath, path.join(root, 'Backups'));
    assert.equal(store.getSettings().showCodexSubscription, false);
    assert.equal(store.getSettings().showClaudeSubscription, false);
    const restored = store.restoreFromExport({ schemaVersion: 1,
      settings: { showCodexSubscription: true, showClaudeSubscription: true } });
    assert.equal(restored.settings, 2);
    assert.equal(store.getSettings().showClaudeSubscription, true);
    assert.deepEqual(store.getCostAnalytics(30), before);
  } finally { store.close(); }
});

test('model categories preserve per-request context tiers, cache subsets and currency conversion', () => withStore((store) => {
  store.updateSettings({ currency: 'GBP', usdToCurrency: 0.8 });
  for (const [key, input] of [['short', 100_000], ['long', 300_000]]) {
    store.recordUsageEvent({ eventKey: key, sourceId: 'codex', model: 'gpt-5.6-sol',
      occurredAt: new Date().toISOString(), inputTokens: input, cachedInputTokens: 50_000,
      outputTokens: 10_000, reasoningOutputTokens: 5_000 });
  }
  const costs = store.getCostAnalytics(7);
  const row = costs.byModel[0];
  const expected = { input: 1.76, cacheRead: 0.048, cacheWrite5m: 0, cacheWrite1h: 0, output: 0.4 };
  for (const [key, amount] of Object.entries(expected)) assert.ok(Math.abs(row.costBreakdown[key] - amount) < 1e-10, key);
  assert.equal(row.costShare, 1);
  assert.equal(row.cost, 2.21);
  assert.equal(costs.actual, row.cost);
}));

test('model breakdown splits Claude cache durations, keeps tiny costs and respects the selected period', () => withStore((store) => {
  store.updateSettings({ currency: 'USD' });
  store.recordUsageEvent({ eventKey: 'categories', sourceId: 'claude', model: 'claude-fable-5',
    occurredAt: new Date().toISOString(), inputTokens: 100_000, cachedInputTokens: 200_000,
    cacheWriteInputTokens: 300_000, cacheWrite5mInputTokens: 100_000, cacheWrite1hInputTokens: 200_000,
    outputTokens: 1, reasoningOutputTokens: 1 });
  store.recordUsageEvent({ eventKey: 'old', sourceId: 'claude', model: 'claude-fable-5',
    occurredAt: new Date(Date.now() - 20 * 86400000).toISOString(), inputTokens: 1_000_000 });
  const row = store.getCostAnalytics(7).byModel[0];
  assert.deepEqual(row.costBreakdown, { input: 1, cacheRead: 0.2, cacheWrite5m: 1.25, cacheWrite1h: 4, output: 0.00005 });
  assert.equal(row.cost, 6.45);
  assert.equal(store.getCostAnalytics(30).byModel[0].costBreakdown.input, 11);
}));

test('unpriced model costs have no share and catalogue edits reprice all categories', () => withStore((store) => {
  store.updateSettings({ currency: 'USD' });
  store.recordUsageEvent({ eventKey: 'unknown', sourceId: 'claude', model: 'unknown-test',
    occurredAt: new Date().toISOString(), inputTokens: 1_000_000 });
  const unknown = store.getCostAnalytics(7).byModel[0];
  assert.equal(unknown.coverage, 0);
  assert.equal(unknown.costShare, null);
  assert.equal(unknown.costBreakdown.input, 0);
  store.updatePrice({ model: 'unknown-test', inputUsdPerMillion: 3, cacheWriteUsdPerMillion: 4,
    cacheWrite1hUsdPerMillion: 6, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 });
  const priced = store.getCostAnalytics(7).byModel[0];
  assert.equal(priced.costBreakdown.input, 3);
  assert.equal(priced.costShare, 1);
  assert.equal(priced.coverage, 1);
}));

test('Codex cached input is not charged twice', () => withStore((store) => {
  const cost = store.calculateCost({
    source_id: 'codex', model: 'codex-auto-review', input_tokens: 1_000_000,
    cached_input_tokens: 800_000, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, reported_cost_usd: null,
  });
  assert.equal(cost.actualUsd, 1.12);
  assert.equal(cost.withoutCacheUsd, 4);
}));

test('Claude token categories remain separate', () => withStore((store) => {
  const cost = store.calculateCost({
    source_id: 'claude', model: 'claude-fable-5', input_tokens: 200_000,
    cached_input_tokens: 800_000, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, reported_cost_usd: null,
  });
  assert.equal(cost.actualUsd, 2.8);
  assert.equal(cost.withoutCacheUsd, 10);
}));

test('API-equivalent cost always uses the current catalogue instead of a saved reported charge', () => withStore((store) => {
  const cost = store.calculateCost({
    source_id: 'codex', model: 'codex-auto-review', input_tokens: 1_000_000,
    cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, reported_cost_usd: 999,
  });
  assert.equal(cost.actualUsd, 4);
  assert.equal(cost.withoutCacheUsd, 4);
}));

test('reasoning is an informational output subset, not an additional charge or token count', () => withStore((store) => {
  store.recordUsageEvent({
    eventKey: 'reasoning-subset', sourceId: 'codex', occurredAt: new Date().toISOString(),
    model: 'gpt-5.6-sol', inputTokens: 1_000, cachedInputTokens: 400,
    outputTokens: 100, reasoningOutputTokens: 40,
  });
  const costs = store.getCostAnalytics(1);
  assert.equal(costs.totalTokens, 1_100);
  assert.equal(costs.byModel[0].totalTokens, 1_100);
  assert.equal(costs.byModel[0].outputTokens, 100);
  assert.equal(costs.byModel[0].reasoningOutputTokens, 40);
  assert.equal(store.calculateCost(store.db.prepare('SELECT * FROM usage_events').get()).actualUsd, 0.00456);
}));

test('Claude five-minute and one-hour cache writes use separate prices', () => withStore((store) => {
  const cost = store.calculateCost({
    source_id: 'claude', model: 'claude-fable-5', input_tokens: 0,
    cached_input_tokens: 0, cache_write_input_tokens: 2_000_000,
    cache_write_5m_input_tokens: 1_000_000, cache_write_1h_input_tokens: 1_000_000,
    output_tokens: 0, reasoning_output_tokens: 0, reported_cost_usd: null,
  });
  assert.equal(cost.actualUsd, 32.5);
  assert.equal(cost.withoutCacheUsd, 20);
}));

test('GPT-5.6 requests above 272K input apply the published long-context multipliers', () => withStore((store) => {
  const cost = store.calculateCost({
    source_id: 'codex', model: 'gpt-5.6-sol', input_tokens: 300_000,
    cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 100_000, reasoning_output_tokens: 0, reported_cost_usd: null,
  });
  assert.equal(cost.actualUsd, 5.4);
  assert.equal(cost.withoutCacheUsd, 5.4);
  assert.equal(cost.longContext, true);
}));

test('GPT-5.6 long-context eligibility includes the cached part of prompt input', () => withStore((store) => {
  const cost = store.calculateCost({
    source_id: 'codex', model: 'gpt-5.6-sol', input_tokens: 280_000,
    cached_input_tokens: 100_000, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, reported_cost_usd: null,
  });
  assert.equal(cost.longContext, true);
  assert.equal(cost.actualUsd, 1.52);
  assert.equal(cost.withoutCacheUsd, 2.24);
}));

test('changing display currency also selects a coherent default conversion rate', () => withStore((store) => {
  store.updateSettings({ currency: 'USD' });
  assert.equal(store.getSettings().currency, 'USD');
  assert.equal(store.getSettings().usdToCurrency, 1);
  assert.throws(() => store.updateSettings({ currency: 'USD', usdToCurrency: 2 }), /USD conversion rate must be 1/);
}));

test('Astra catalogue seeding prices existing usage and preserves custom rates', () => withStore((store) => {
  store.updateSettings({ currency: 'USD' });
  store.db.prepare("DELETE FROM price_catalog WHERE model = 'gpt-6-astra'").run();
  store.recordUsageEvent({
    eventKey: 'astra-existing', sourceId: 'codex', occurredAt: new Date().toISOString(),
    model: 'gpt-6-astra', inputTokens: 100_000,
  });
  assert.equal(store.getCostAnalytics(1).isLowerBound, true);
  store.seed();
  const costs = store.getCostAnalytics(1);
  assert.equal(costs.actual, 1);
  assert.equal(costs.coverage, 1);
  assert.equal(costs.isComplete, true);
  assert.deepEqual(costs.unpricedModels, []);
  assert.equal(costs.byModel[0].model, 'gpt-6-astra');
  const price = store.resolvePrice('gpt-6-astra');
  assert.equal(price.effective_from, '2026-09-04');
  assert.equal(price.source_url, 'https://developers.openai.com/api/docs/models/gpt-6-astra');
  store.updatePrice({
    model: 'gpt-6-astra', inputUsdPerMillion: 12, cacheWriteUsdPerMillion: 15,
    cacheWrite1hUsdPerMillion: 15, cacheReadUsdPerMillion: 1.2, outputUsdPerMillion: 60,
  });
  store.seed();
  assert.equal(store.getCostAnalytics(1).actual, 1.2);
}));

test('Astra prices cached input, cache writes, and output at the exact long-context boundary', () => withStore((store) => {
  for (const model of ['gpt-6-astra', 'gpt-6-astra-20260904']) {
    const row = {
      source_id: 'codex', model, input_tokens: 172_000, cached_input_tokens: 100_000,
      cache_write_input_tokens: 100_000, cache_write_5m_input_tokens: 50_000,
      cache_write_1h_input_tokens: 50_000, output_tokens: 1_000,
    };
    const standard = store.calculateCost(row);
    assert.equal(standard.covered, true);
    assert.equal(standard.longContext, false);
    assert.equal(standard.actualUsd, 2.12);
    const long = store.calculateCost({ ...row, input_tokens: 172_001 });
    assert.equal(long.longContext, true);
    assert.equal(long.actualUsd, 4.21502);
  }
  assert.equal(store.resolvePrice('gpt-6-astra-unknown'), null);
}));

// inputUsd is the cost of 100,000 uncached input tokens at the model's rate.
for (const [model, standardUsd, longUsd, effectiveFrom, inputUsd] of [
  ['gpt-6-sol', 0.424, 0.843004, '2026-09-22', 0.2],
  ['gpt-6-luna', 0.0212, 0.0421502, '2026-09-22', 0.01],
  ['gpt-6.1-sol', 0.414, 0.823004, '2026-09-29', 0.2],
  ['gpt-6.1-terra', 0.207, 0.411502, '2026-10-26', 0.1],
]) {
  test(`${model} prices every token category at the long-context boundary`, () => withStore((store) => {
    for (const name of [model, `${model}-${effectiveFrom.replaceAll('-', '')}`, `${model}-${effectiveFrom}`]) {
      const row = {
        source_id: 'codex', model: name, input_tokens: 172_000, cached_input_tokens: 100_000,
        cache_write_input_tokens: 100_000, cache_write_5m_input_tokens: 50_000,
        cache_write_1h_input_tokens: 50_000, output_tokens: 1_000,
      };
      const standard = store.calculateCost(row);
      assert.equal(standard.covered, true);
      assert.equal(standard.longContext, false);
      assert.ok(Math.abs(standard.actualUsd - standardUsd) < 1e-12);
      const long = store.calculateCost({ ...row, input_tokens: 172_001 });
      assert.equal(long.longContext, true);
      assert.ok(Math.abs(long.actualUsd - longUsd) < 1e-12);
    }
    assert.equal(store.resolvePrice(`${model}-unknown`), null);
  }));

  test(`${model} upgrade prices existing history and preserves custom rates on reopen`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-test-'));
    const file = path.join(root, 'test.sqlite');
    let store = new UsageStore(file, path.join(root, 'Backups'));
    try {
      store.updateSettings({ currency: 'USD' });
      store.db.prepare('DELETE FROM price_catalog WHERE model = ?').run(model);
      store.recordUsageEvent({ eventKey: `${model}-existing`, sourceId: 'codex',
        occurredAt: new Date().toISOString(), model, inputTokens: 100_000 });
      assert.equal(store.getCostAnalytics(1).isLowerBound, true);
      const original = store.db.prepare('SELECT * FROM usage_events').all();
      store.close();
      store = new UsageStore(file, path.join(root, 'Backups'));
      assert.deepEqual(store.db.prepare('SELECT * FROM usage_events').all(), original);
      const costs = store.getCostAnalytics(1);
      assert.equal(costs.coverage, 1);
      assert.equal(costs.isComplete, true);
      assert.ok(Math.abs(costs.actual - inputUsd) < 1e-12);
      assert.deepEqual(costs.unpricedModels, []);
      assert.equal(store.resolvePrice(model).effective_from, effectiveFrom);
      assert.equal(store.resolvePrice(model).source_url, `https://developers.openai.com/api/docs/models/${model}`);
      store.updatePrice({ model, inputUsdPerMillion: 3, cacheWriteUsdPerMillion: 4,
        cacheWrite1hUsdPerMillion: 4, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 });
      store.close();
      store = new UsageStore(file, path.join(root, 'Backups'));
      assert.equal(store.getCostAnalytics(1).actual, 0.3);
      assert.equal(store.resolvePrice(model).is_seed, 0);
    } finally { store.close(); }
  });
}

test('scheduled backups are rate limited', () => withStore((store) => {
  const first = store.maybeCreateScheduledBackup();
  const second = store.maybeCreateScheduledBackup();
  assert.ok(first && fs.existsSync(first.databasePath) && fs.existsSync(first.exportPath));
  assert.equal(second, null);
}));

test('settings reject unknown keys and invalid numeric values', () => withStore((store) => {
  assert.throws(() => store.updateSettings({ usdToCurrency: 0 }), /Invalid value/);
  assert.throws(() => store.updateSettings({ forecastFallbackRate: Number.NaN }), /Invalid value/);
  assert.throws(() => store.updateSettings({ surpriseSetting: true }), /Unknown setting/);
  assert.equal(store.getSettings().usdToCurrency, 0.736);
}));

test('observations reject invalid dates and percentages', () => withStore((store) => {
  const base = { sourceId: 'claude', bucketId: 'seven_day', observedAt: '2026-08-29T10:00:00Z', usedPercent: 20, remainingPercent: 80, resetsAt: '2026-09-04T10:00:00Z' };
  assert.throws(() => store.recordObservation({ ...base, sourceId: 'mystery' }), /Unknown source/);
  assert.throws(() => store.recordObservation({ ...base, bucketId: '' }), /bucket/i);
  assert.throws(() => store.recordObservation({ ...base, resetsAt: null }), /Reset time/);
  assert.throws(() => store.recordObservation({ ...base, usedPercent: 120 }), /between 0 and 100/);
  assert.throws(() => store.recordObservation({ ...base, remainingPercent: 70 }), /sum to 100/);
  assert.throws(() => store.recordObservation({ ...base, confidence: 2 }), /confidence/i);
  assert.throws(() => store.recordObservation({ ...base, windowMinutes: -1 }), /window/i);
  assert.throws(() => store.recordObservation({ ...base, resetsAt: '1970-01-01T00:00:00Z' }), /supported date range/);
  assert.throws(() => store.recordObservation({ ...base, resetsAt: '2026-08-28T10:00:00Z' }), /earlier than the observation/);
  assert.throws(() => store.recordObservation({ ...base, resetsAt: '2026-10-29T10:00:00Z' }), /more than 31 days/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 0);
}));

test('usage events reject invalid sources, dates, token counts, and cost values', () => withStore((store) => {
  const base = { eventKey: 'valid-key', sourceId: 'claude', occurredAt: '2026-08-29T10:00:00Z', model: 'claude-fable-5', inputTokens: 10 };
  assert.throws(() => store.recordUsageEvent({ ...base, sourceId: 'mystery' }), /Unknown source/);
  assert.throws(() => store.recordUsageEvent({ ...base, occurredAt: 'not-a-date' }), /Event time/);
  assert.throws(() => store.recordUsageEvent({ ...base, inputTokens: -1 }), /token counts/);
  assert.throws(() => store.recordUsageEvent({ ...base, outputTokens: Number.NaN }), /token counts/);
  assert.throws(() => store.recordUsageEvent({ ...base, outputTokens: 5, reasoningOutputTokens: 6 }), /reasoning/i);
  assert.throws(() => store.recordUsageEvent({ ...base, reportedCostUsd: -1 }), /reported cost/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 0);
}));

test('incomplete API-equivalent totals are exposed as a lower bound with the unpriced models', () => withStore((store) => {
  store.recordUsageEvent({ eventKey: 'priced', sourceId: 'codex', occurredAt: new Date().toISOString(), model: 'gpt-5.6-sol', inputTokens: 1_000 });
  store.recordUsageEvent({ eventKey: 'unpriced', sourceId: 'codex', occurredAt: new Date().toISOString(), model: 'future-model', inputTokens: 3_000 });
  const costs = store.getCostAnalytics(1);
  assert.equal(costs.isComplete, false);
  assert.equal(costs.isLowerBound, true);
  assert.deepEqual(costs.unpricedModels, [{ sourceId: 'codex', model: 'future-model', tokens: 3_000 }]);
  assert.equal(costs.coverage, 0.25);
}));

test('adding a detected model price turns its lower bound into a complete token estimate', () => withStore((store) => {
  store.recordUsageEvent({ eventKey: 'new-model', sourceId: 'codex', occurredAt: new Date().toISOString(), model: 'future-model', inputTokens: 1_000_000 });
  assert.equal(store.getCostAnalytics(1).isLowerBound, true);

  store.updatePrice({
    model: 'future-model', inputUsdPerMillion: 2, cacheWriteUsdPerMillion: 2.5,
    cacheWrite1hUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
  });
  const costs = store.getCostAnalytics(1);
  assert.equal(costs.isComplete, true);
  assert.equal(costs.isLowerBound, false);
  assert.deepEqual(costs.unpricedModels, []);
  assert.equal(costs.actual, 1.47);
}));

test('price fallback is deterministic and does not guess ambiguous families', () => withStore((store) => {
  assert.equal(store.resolvePrice('gpt-5.6'), null);
  assert.equal(store.resolvePrice('gpt-5.6-sol-2026-08').model, 'gpt-5.6-sol');
  assert.equal(store.resolvePrice('claude-fable-5').model, 'claude-fable-5');
  assert.equal(store.resolvePrice('claude-fable-5-20260829').model, 'claude-fable-5');
  assert.equal(store.resolvePrice('my-claude-fable-5-proxy'), null);
  assert.equal(store.resolvePrice('claude-fable-5-proxy'), null);
}));

test('built-in Anthropic prices include current one-hour cache rates', () => withStore((store) => {
  const prices = Object.fromEntries(store.getPriceCatalog().map((row) => [row.model, row]));
  assert.deepEqual([
    prices['claude-fable-5'].input_usd_per_million, prices['claude-fable-5'].cache_write_usd_per_million,
    prices['claude-fable-5'].cache_write_1h_usd_per_million, prices['claude-fable-5'].cache_read_usd_per_million,
    prices['claude-fable-5'].output_usd_per_million,
  ], [10, 12.5, 20, 1, 50]);
  assert.deepEqual([
    prices['claude-sonnet-5'].input_usd_per_million, prices['claude-sonnet-5'].cache_write_usd_per_million,
    prices['claude-sonnet-5'].cache_write_1h_usd_per_million, prices['claude-sonnet-5'].cache_read_usd_per_million,
    prices['claude-sonnet-5'].output_usd_per_million,
  ], [2, 2.5, 4, 0.2, 10]);
}));

test('upgrade repairs old built-in prices and invalid settings but preserves custom values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-upgrade-'));
  const databasePath = path.join(root, 'test.sqlite');
  let store = new UsageStore(databasePath, path.join(root, 'Backups'));
  store.db.prepare(`UPDATE price_catalog SET input_usd_per_million = 3,
    cache_write_usd_per_million = 3.75, cache_write_1h_usd_per_million = 0,
    cache_read_usd_per_million = 0.3, output_usd_per_million = 15
    WHERE model = 'claude-sonnet-5'`).run();
  store.db.prepare("UPDATE price_catalog SET input_usd_per_million = 9.25 WHERE model = 'claude-opus-5'").run();
  store.db.prepare("UPDATE settings SET value_json = '0' WHERE key IN ('usdToCurrency', 'forecastFallbackRate')").run();
  store.db.prepare("UPDATE settings SET value_json = '99' WHERE key = 'activeStartHour'").run();
  store.close();
  store = new UsageStore(databasePath, path.join(root, 'Backups'));
  try {
    const prices = Object.fromEntries(store.getPriceCatalog().map((row) => [row.model, row]));
    assert.equal(prices['claude-sonnet-5'].input_usd_per_million, 2);
    assert.equal(prices['claude-sonnet-5'].cache_write_1h_usd_per_million, 4);
    assert.equal(prices['claude-opus-5'].input_usd_per_million, 9.25);
    assert.equal(store.getSettings().usdToCurrency, 0.736);
    assert.equal(store.getSettings().forecastFallbackRate, 0.35);
    assert.equal(store.getSettings().activeStartHour, 8);
  } finally { store.close(); }
});

test('a custom zero one-hour cache price survives subsequent launches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-zero-price-'));
  const databasePath = path.join(root, 'test.sqlite');
  let store = new UsageStore(databasePath, path.join(root, 'Backups'));
  const opus = store.getPriceCatalog().find((row) => row.model === 'claude-opus-5');
  store.updatePrice({
    model: opus.model, inputUsdPerMillion: opus.input_usd_per_million,
    cacheWriteUsdPerMillion: opus.cache_write_usd_per_million, cacheWrite1hUsdPerMillion: 0,
    cacheReadUsdPerMillion: opus.cache_read_usd_per_million, outputUsdPerMillion: opus.output_usd_per_million,
  });
  store.close();
  store = new UsageStore(databasePath, path.join(root, 'Backups'));
  try {
    assert.equal(store.getPriceCatalog().find((row) => row.model === 'claude-opus-5').cache_write_1h_usd_per_million, 0);
  } finally { store.close(); }
});

test('manual Codex weekly history merges into the official overall bucket', () => withStore((store) => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:weekly', observedAt: new Date(Date.now() - 60_000).toISOString(), usedPercent: 70, resetsAt: future, windowMinutes: 10_080, provenance: 'manual-official' });
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:secondary', observedAt: new Date().toISOString(), usedPercent: 20, resetsAt: future, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'codex' } });
  const quota = store.getQuota('codex');
  assert.equal(quota.bucketId, 'codex:secondary');
  assert.equal(quota.usedPercent, 20);
  assert.equal(quota.windows.length, 1);
}));

test('overall Codex quota wins equal-duration ties regardless of insert order', () => withStore((store) => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const observedAt = new Date().toISOString();
  store.recordObservation({ sourceId: 'codex', bucketId: 'model-x:secondary', observedAt, usedPercent: 60, resetsAt: future, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'model-x' } });
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:secondary', observedAt, usedPercent: 20, resetsAt: future, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'codex' } });
  assert.equal(store.getQuota('codex').bucketId, 'codex:secondary');
}));

test('dashboard snapshots carry the backend verdict for every active allowance window', () => withStore((store) => {
  const observedAt = new Date().toISOString();
  const weeklyReset = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const shortReset = new Date(Date.now() + 4 * 3_600_000).toISOString();
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:secondary', bucketName: 'Codex weekly', observedAt, usedPercent: 0, resetsAt: weeklyReset, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'codex' } });
  store.recordObservation({ sourceId: 'codex', bucketId: 'model-x:secondary', bucketName: 'Model X four-hour', observedAt, usedPercent: 100, resetsAt: shortReset, windowMinutes: 240, provenance: 'official', metadata: { limitId: 'model-x' } });
  store.recordObservation({ sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Claude weekly', observedAt, usedPercent: 0, resetsAt: weeklyReset, windowMinutes: 10_080, provenance: 'official-statusline' });
  store.recordObservation({ sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable weekly', observedAt, usedPercent: 0, resetsAt: weeklyReset, windowMinutes: 10_080, provenance: 'official-statusline' });

  const snapshot = store.getDashboardSnapshot(30);
  assert.equal(snapshot.quotas.codex.bucketId, 'codex:secondary', 'the display primary remains the overall allowance');
  assert.equal(snapshot.dashboardVerdict.state, 'critical');
  assert.deepEqual(snapshot.dashboardVerdict.affected, ['Codex · Model X four-hour']);
  assert.equal(snapshot.dashboardVerdict.windowsChecked, 4);
}));

test('manual Codex history waits for the overall bucket and never contaminates a model limit', () => withStore((store) => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const first = new Date(Date.now() - 120_000).toISOString();
  const second = new Date(Date.now() - 60_000).toISOString();
  const third = new Date().toISOString();
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:weekly', observedAt: first, usedPercent: 10, resetsAt: future, windowMinutes: 10_080, provenance: 'manual-official' });
  store.recordObservation({ sourceId: 'codex', bucketId: 'model-x:secondary', observedAt: second, usedPercent: 40, resetsAt: future, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'model-x' } });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE bucket_id = 'codex:weekly'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE bucket_id = 'model-x:secondary'").get().count, 1);
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:secondary', observedAt: third, usedPercent: 20, resetsAt: future, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'codex' } });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE bucket_id = 'codex:weekly'").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE bucket_id = 'codex:secondary'").get().count, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE bucket_id = 'model-x:secondary'").get().count, 1);
  assert.equal(store.getQuota('codex').bucketId, 'codex:secondary');
}));

test('cost chart groups events by the configured local calendar day', () => withStore((store) => {
  // The event sits at 23:30 UTC on a British Summer Time date, which is 00:30
  // the next day locally. The analytics clock is pinned so the test cannot
  // expire as the calendar moves past the fixture.
  store.recordUsageEvent({ eventKey: 'bst-midnight', sourceId: 'claude', occurredAt: '2026-08-28T23:30:00Z', model: 'claude-opus-5', inputTokens: 100 });
  const row = store.getCostAnalytics(2, store.getSettings(), Date.parse('2026-08-30T12:00:00Z')).chart[0];
  assert.equal(row.date, '2026-08-29');
}));

test('backup retention removes only old managed backup sets', () => withStore((store) => {
  const paths = [];
  for (let index = 0; index < 4; index += 1) {
    const databasePath = path.join(store.backupDirectory, `old-${index}.sqlite`);
    const exportPath = path.join(store.backupDirectory, `old-${index}.aiusage.json`);
    fs.writeFileSync(databasePath, 'db');
    fs.writeFileSync(exportPath, 'json');
    store.db.prepare('INSERT INTO backups(created_at, database_path, export_path) VALUES (?, ?, ?)').run(`2026-08-2${index}T00:00:00Z`, databasePath, exportPath);
    paths.push({ databasePath, exportPath });
  }
  assert.equal(store.pruneBackups(2), 2);
  assert.equal(fs.existsSync(paths[0].databasePath), false);
  assert.equal(fs.existsSync(paths[1].exportPath), false);
  assert.equal(fs.existsSync(paths[2].databasePath), true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 2);
}));

test('a backup export restores into an empty database', () => withStore((source) => {
  source.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt: '2026-08-28T10:00:00.000Z', usedPercent: 42,
    resetsAt: '2026-09-02T10:00:00.000Z', windowMinutes: 10_080, provenance: 'official-statusline',
  });
  source.recordUsageEvent({
    eventKey: 'restore-me', sourceId: 'claude', occurredAt: '2026-08-28T10:00:00.000Z',
    sessionId: 'session-a', model: 'claude-opus-5', inputTokens: 1_000,
    cachedInputTokens: 500, cacheWriteInputTokens: 300, cacheWrite5mInputTokens: 200,
    cacheWrite1hInputTokens: 100, outputTokens: 400, reasoningOutputTokens: 120,
  });
  source.upsertDailyUsage('codex', '2026-08-28', 987_654);
  source.updateSettings({ currency: 'USD', refreshIntervalMinutes: 30 });
  const { exportPath } = source.createBackup();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-restore-'));
  const target = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const counts = target.restoreFromBackup(exportPath);
    assert.equal(counts.observations, 1);
    assert.equal(counts.usageEvents, 1);
    assert.equal(counts.dailyUsage, 1);
    assert.equal(counts.skipped, 0);
    assert.equal(target.getSettings().currency, 'USD');
    assert.equal(target.getSettings().refreshIntervalMinutes, 30);
    assert.equal(target.getQuota('claude').usedPercent, 42);
    const event = target.db.prepare("SELECT * FROM usage_events WHERE event_key = 'restore-me'").get();
    assert.equal(event.cache_write_5m_input_tokens, 200);
    assert.equal(event.cache_write_1h_input_tokens, 100);
    assert.equal(target.db.prepare("SELECT last_observation_at FROM sources WHERE id = 'claude'").get().last_observation_at, '2026-08-28T10:00:00.000Z');
  } finally {
    target.close();
  }
}));

test('restoring the same export twice does not double count', () => withStore((store) => {
  store.recordUsageEvent({
    eventKey: 'once-only', sourceId: 'codex', occurredAt: '2026-08-28T10:00:00.000Z',
    model: 'gpt-5.6-sol', inputTokens: 1_000, outputTokens: 100,
  });
  const { exportPath } = store.createBackup();
  assert.equal(store.restoreFromBackup(exportPath).usageEvents, 0);
  assert.equal(store.restoreFromBackup(exportPath).usageEvents, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
}));

test('an export missing cache TTL detail restores its write total as five-minute', () => withStore((store) => {
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    usageEvents: [{
      event_key: 'legacy-event', source_id: 'claude', occurred_at: '2026-08-28T10:00:00.000Z',
      model: 'claude-opus-5', input_tokens: 10, cache_write_input_tokens: 900, output_tokens: 5,
    }],
  });
  assert.equal(counts.usageEvents, 1);
  const event = store.db.prepare("SELECT * FROM usage_events WHERE event_key = 'legacy-event'").get();
  assert.equal(event.cache_write_5m_input_tokens, 900);
  assert.equal(event.cache_write_1h_input_tokens, 0);
}));

test('a restore reports unusable records instead of storing them', () => withStore((store) => {
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    settings: { currency: 'XYZ', backupRetentionCount: 12 },
    observations: [
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '1970-01-01T00:00:00.000Z', used_percent: 5, resets_at: '2026-09-02T10:00:00.000Z' },
      { source_id: 'not-a-source', bucket_id: 'seven_day', observed_at: '2026-08-28T10:00:00.000Z', used_percent: 5, resets_at: '2026-09-02T10:00:00.000Z' },
    ],
    prices: [{ model: 'broken-model', input_usd_per_million: -1, cache_write_usd_per_million: 1, cache_read_usd_per_million: 1, output_usd_per_million: 1 }],
  });
  assert.equal(counts.observations, 0);
  assert.equal(counts.settings, 1);
  assert.equal(counts.skipped, 4);
  assert.equal(store.getSettings().currency, 'GBP');
  assert.equal(store.getSettings().backupRetentionCount, 12);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM price_catalog WHERE model = 'broken-model'").get().count, 0);
}));

test('a file that is not an AI Usage export is refused', () => withStore((store) => {
  const notAnExport = path.join(store.backupDirectory, 'random.json');
  fs.writeFileSync(notAnExport, JSON.stringify({ hello: 'world' }));
  assert.throws(() => store.restoreFromBackup(notAnExport), /not a readable AI Usage export/);
  assert.throws(() => store.restoreFromBackup(path.join(store.backupDirectory, 'missing.json')), /could not be found/);
  assert.throws(() => store.restoreFromExport({ schemaVersion: 2 }), /newer version of AI Usage/);
}));

test('taking a safety backup never prunes the backup being restored', () => withStore((store) => {
  // Retention is exactly filled, so the safety backup is the one that pushes
  // the oldest set out — and the oldest set is what the user picked.
  store.updateSettings({ backupRetentionCount: 3 });
  store.recordUsageEvent({
    eventKey: 'old-history', sourceId: 'codex', occurredAt: '2026-08-20T10:00:00.000Z',
    model: 'gpt-5.6-sol', inputTokens: 999, outputTokens: 1,
  });
  const oldest = store.createBackup();
  store.db.prepare("DELETE FROM usage_events WHERE event_key = 'old-history'").run();
  store.createBackup();
  store.createBackup();

  // The restore handler's sequence: read first, then back up, keeping the pick.
  const payload = store.readExport(oldest.exportPath);
  store.createBackup({ keep: oldest.exportPath });
  assert.equal(fs.existsSync(oldest.exportPath), true, 'the chosen export must survive its own restore');
  assert.equal(store.restoreFromExport(payload).usageEvents, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE event_key = 'old-history'").get().count, 1);
}));

test('restoring an older export never rolls back newer daily totals or edited prices', () => withStore((store) => {
  store.upsertDailyUsage('codex', '2026-08-20', 1_000);
  store.updatePrice({ model: 'claude-opus-5', inputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1, cacheWrite1hUsdPerMillion: 1, cacheReadUsdPerMillion: 1, outputUsdPerMillion: 1 });
  const { exportPath } = store.createBackup();
  store.upsertDailyUsage('codex', '2026-08-20', 9_999);
  store.updatePrice({ model: 'claude-opus-5', inputUsdPerMillion: 42, cacheWriteUsdPerMillion: 42, cacheWrite1hUsdPerMillion: 42, cacheReadUsdPerMillion: 42, outputUsdPerMillion: 42 });

  const counts = store.restoreFromBackup(exportPath);
  assert.equal(counts.dailyUsage, 0);
  assert.equal(counts.prices, 0);
  assert.equal(store.db.prepare("SELECT tokens FROM account_daily_usage WHERE usage_date = '2026-08-20'").get().tokens, 9_999);
  assert.equal(store.db.prepare("SELECT input_usd_per_million AS price FROM price_catalog WHERE model = 'claude-opus-5'").get().price, 42);
}));

test('a daily total that is not a number is skipped, not treated as zero', () => withStore((store) => {
  store.upsertDailyUsage('codex', '2026-08-20', 5_000);
  for (const tokens of [null, '', false, [], {}, 'abc']) {
    const counts = store.restoreFromExport({
      schemaVersion: 1,
      dailyUsage: [{ source_id: 'codex', usage_date: '2026-08-21', tokens }],
    });
    assert.equal(counts.dailyUsage, 0);
    assert.equal(counts.skipped, 1);
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM account_daily_usage WHERE usage_date = '2026-08-21'").get().count, 0);
  assert.equal(store.db.prepare("SELECT tokens FROM account_daily_usage WHERE usage_date = '2026-08-20'").get().tokens, 5_000);
}));

test('one unusable row cannot discard the rest of a restore', () => withStore((store) => {
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    usageEvents: Array.from({ length: 5 }, (_, index) => ({
      event_key: `bulk-${index}`, source_id: 'claude', occurred_at: '2026-08-28T10:00:00.000Z',
      model: 'claude-opus-5', input_tokens: 10, output_tokens: 5,
    })),
    dailyUsage: [{ source_id: 'codex', usage_date: true, tokens: 10 }],
    prices: [
      // A price SQLite could not bind: the object used to escape the loop and
      // roll the whole restore back. The optional URL is coerced away instead
      // of costing a usable price row; an unusable number is skipped.
      { model: 'url-model', input_usd_per_million: 1, cache_write_usd_per_million: 1, cache_read_usd_per_million: 1, output_usd_per_million: 1, source_url: { href: 'https://example.test' } },
      { model: 'broken-model', input_usd_per_million: {}, cache_write_usd_per_million: 1, cache_read_usd_per_million: 1, output_usd_per_million: 1 },
      { model: 'good-model', input_usd_per_million: 2, cache_write_usd_per_million: 2, cache_read_usd_per_million: 2, output_usd_per_million: 2 },
    ],
  });
  assert.equal(counts.usageEvents, 5);
  assert.equal(counts.prices, 2);
  assert.equal(counts.skipped, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 5);
  assert.equal(store.db.prepare("SELECT source_url FROM price_catalog WHERE model = 'url-model'").get().source_url, null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM price_catalog WHERE model = 'broken-model'").get().count, 0);
}));

test('a restore cannot leave a schedule whose start is not before its end', () => withStore((store) => {
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    settings: { activeStartHour: 23, activeEndHour: 30 },
  });
  const settings = store.getSettings();
  assert.equal(settings.activeStartHour, 8);
  assert.equal(settings.activeEndHour, 22);
  assert.ok(settings.activeStartHour < settings.activeEndHour);
  assert.equal(counts.settings, 0);
  assert.equal(counts.skipped, 2);
}));

test('restored observations honour the same invariants as live readings', () => withStore((store) => {
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    observations: [
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T10:00:00.000Z', used_percent: 10, remaining_percent: 999, resets_at: '2026-09-02T10:00:00.000Z' },
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T11:00:00.000Z', used_percent: 10, resets_at: '2026-08-27T10:00:00.000Z' },
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T12:00:00.000Z', used_percent: 10, resets_at: '2026-09-02T10:00:00.000Z' },
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T13:00:00.000Z', used_percent: 10, remaining_percent: 80, resets_at: '2026-09-02T10:00:00.000Z' },
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T14:00:00.000Z', used_percent: 10, resets_at: '2026-09-02T10:00:00.000Z', confidence: 2 },
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T15:00:00.000Z', used_percent: 10, resets_at: '2026-09-02T10:00:00.000Z', window_minutes: 10.5 },
      { source_id: 'claude', bucket_id: 'seven_day', observed_at: '2026-08-28T16:00:00.000Z', used_percent: 10, resets_at: '2026-10-02T10:00:00.000Z', window_minutes: 10_080 },
      { source_id: 'claude-fable', bucket_id: 'fable_seven_day', observed_at: '2026-08-28T17:00:00.000Z', used_percent: 5, resets_at: '2026-09-02T10:00:00.000Z', provenance: 'derived-tokens' },
    ],
  });
  assert.equal(counts.observations, 1);
  assert.equal(counts.skipped, 7);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count, 1);
}));

test('legacy status-line backups cannot restore an unverified Max plan claim', () => withStore((store) => {
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    observations: [{
      source_id: 'claude', bucket_id: 'seven_day', bucket_name: 'Claude weekly',
      observed_at: '2026-08-28T10:00:00.000Z', used_percent: 20,
      resets_at: '2026-09-02T10:00:00.000Z', window_minutes: 10_080,
      plan_type: 'max', provenance: 'official-statusline',
    }],
  });
  assert.equal(counts.observations, 1);
  assert.equal(store.db.prepare("SELECT plan_type FROM quota_observations WHERE source_id = 'claude'").get().plan_type, null);
}));

test('restored token ledgers reject fractional, unsafe, inconsistent, and negative values', () => withStore((store) => {
  const base = { source_id: 'claude', occurred_at: '2026-08-28T10:00:00.000Z', model: 'claude-fable-5' };
  const counts = store.restoreFromExport({
    schemaVersion: 1,
    usageEvents: [
      { ...base, event_key: 'good', input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 },
      { ...base, event_key: 'fractional', input_tokens: 1.5 },
      { ...base, event_key: 'unsafe', input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, event_key: 'reasoning', output_tokens: 5, reasoning_output_tokens: 6 },
      { ...base, event_key: 'cost', reported_cost_usd: -1 },
    ],
    dailyUsage: [
      { source_id: 'claude', usage_date: '2026-08-28', tokens: 12 },
      { source_id: 'claude', usage_date: '2026-08-29', tokens: 1.2 },
    ],
  });
  assert.equal(counts.usageEvents, 1);
  assert.equal(counts.dailyUsage, 1);
  assert.equal(counts.skipped, 5);
}));

test('a source status without metadata keeps what the source already knew', () => withStore((store) => {
  store.setSourceStatus('claude', 'connected', 'All good.', { helperInstalled: true, transcripts: 12 });
  store.setSourceStatus('claude', 'error', 'Claude refresh failed.');
  const source = store.db.prepare("SELECT status, status_detail, metadata_json FROM sources WHERE id = 'claude'").get();
  assert.equal(source.status, 'error');
  assert.equal(source.status_detail, 'Claude refresh failed.');
  assert.deepEqual(JSON.parse(source.metadata_json), { helperInstalled: true, transcripts: 12 });
  store.setSourceStatus('claude', 'connected', 'Back.', {});
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT metadata_json FROM sources WHERE id = 'claude'").get().metadata_json), {});
}));

test('source health separates the latest scan attempt and success from the latest evidence', () => withStore((store) => {
  assert.throws(() => store.setSourceStatus('mystery', 'ready', 'No such source.'), /Unknown source/);

  store.setSourceStatus('claude', 'error', 'Temporary failure.');
  let source = store.db.prepare("SELECT * FROM sources WHERE id = 'claude'").get();
  assert.match(source.last_attempt_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(source.last_success_at, null);
  assert.equal(source.last_observation_at, null);

  store.setSourceStatus('claude', 'ready', 'Scan completed.', { filesFound: 0 });
  source = store.db.prepare("SELECT * FROM sources WHERE id = 'claude'").get();
  assert.match(source.last_success_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(source.last_attempt_at, source.last_success_at);
  assert.equal(source.last_observation_at, null);

  const lastGood = source.last_success_at;
  store.setSourceStatus('claude', 'stale', 'Cached evidence only.');
  source = store.db.prepare("SELECT * FROM sources WHERE id = 'claude'").get();
  assert.equal(source.last_success_at, lastGood);
  assert.match(source.last_attempt_at, /^\d{4}-\d{2}-\d{2}T/);

  store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', observedAt: '2026-08-29T10:00:00Z',
    usedPercent: 25, resetsAt: '2026-09-03T10:00:00Z', windowMinutes: 10_080,
  });
  source = store.getDashboardSnapshot().sources.find((entry) => entry.id === 'claude');
  assert.equal(source.last_observation_at, '2026-08-29T10:00:00.000Z');
  assert.match(source.last_attempt_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(source.last_success_at, /^\d{4}-\d{2}-\d{2}T/);
}));

test('the automatic collection interval rejects values a timer cannot use', () => withStore((store) => {
  assert.equal(store.updateSettings({ refreshIntervalMinutes: 0 }).refreshIntervalMinutes, 0);
  assert.equal(store.updateSettings({ refreshIntervalMinutes: 240 }).refreshIntervalMinutes, 240);
  assert.throws(() => store.updateSettings({ refreshIntervalMinutes: 1 }), /Invalid value/);
  assert.throws(() => store.updateSettings({ refreshIntervalMinutes: 600 }), /Invalid value/);
  assert.throws(() => store.updateSettings({ refreshIntervalMinutes: 12.5 }), /Invalid value/);
  assert.equal(store.getSettings().refreshIntervalMinutes, 240);
}));

test('official daily account usage is exposed in dashboard snapshots', () => withStore((store) => {
  store.upsertDailyUsage('codex', '2026-08-29', 123456);
  const snapshot = store.getDashboardSnapshot(30, Date.parse('2026-08-30T12:00:00Z'));
  assert.equal(snapshot.dailyUsage.length, 1);
  assert.equal(snapshot.dailyUsage[0].sourceId, 'codex');
  assert.equal(snapshot.dailyUsage[0].date, '2026-08-29');
  assert.equal(snapshot.dailyUsage[0].tokens, 123456);
}));

test('the Claude primary window is the shared weekly pool, not a model-scoped bucket recorded in the same scan', () => withStore((store) => {
  const observedAt = new Date().toISOString();
  const weeklyReset = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const shortReset = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const record = (bucketId, bucketName, windowMinutes, resetsAt, scope, usedPercent) => store.recordObservation({
    sourceId: 'claude', bucketId, bucketName, observedAt, usedPercent, resetsAt, windowMinutes,
    provenance: 'official-claude-usage', metadata: { scope, source: 'claude-usage' },
  });
  record('model_scoped:fable%205', 'Fable 5 weekly', 10_080, weeklyReset, 'model', 70);
  record('seven_day_opus', 'Opus weekly', 10_080, weeklyReset, 'model', 55);
  record('seven_day', 'Weekly', 10_080, weeklyReset, 'overall', 20);
  record('five_hour', '5-hour', 300, shortReset, 'overall', 10);
  const quota = store.getQuota('claude');
  assert.equal(quota.bucketId, 'seven_day');
  assert.deepEqual(quota.windows.slice(0, 2).map((window) => window.bucketId), ['seven_day', 'five_hour']);
}));

test('reset-cycle token totals use the same per-source rule as the cost ledger', () => withStore((store) => {
  // Keep the event strictly before the cycle's exclusive upper bound, even
  // when insertion and the read finish within the same clock millisecond.
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const resetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  store.recordObservation({ sourceId: 'codex', bucketId: 'codex:secondary', bucketName: 'Codex weekly', observedAt, usedPercent: 30, resetsAt, windowMinutes: 10_080, provenance: 'official', metadata: { limitId: 'codex' } });
  store.recordUsageEvent({ eventKey: 'codex-1', sourceId: 'codex', occurredAt: observedAt, model: 'gpt-5.6-sol', inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 100 });
  const [cycle] = store.getCycleHistory('codex', store.getQuota('codex'));
  assert.equal(cycle.current, true);
  // Codex reports cached input as a subset of input, so 400 is not added again.
  assert.equal(cycle.tokens, 1_100);
  assert.equal(store.getCostAnalytics(1).totalTokens, 1_100);
}));

test('cost analytics carry a local hour-by-weekday activity grid', () => withStore((store) => {
  // 23:30 UTC on Friday 28 August 2026 is 00:30 BST on Saturday in Europe/London.
  store.recordUsageEvent({ eventKey: 'bst-saturday', sourceId: 'claude', occurredAt: '2026-08-28T23:30:00Z', model: 'claude-opus-5', inputTokens: 1_000_000 });
  const costs = store.getCostAnalytics(2, store.getSettings(), Date.parse('2026-08-30T12:00:00Z'));
  assert.equal(costs.activityGrid.length, 7);
  assert.ok(costs.activityGrid.every((row) => row.length === 24));
  assert.ok(costs.activityGrid[6][0] > 0, 'Saturday 00:00 local carries the cost');
  assert.equal(costs.activityGrid[5][23], 0, 'nothing lands in the UTC slot');
  const total = costs.activityGrid.flat().reduce((sum, value) => sum + value, 0);
  assert.equal(total, costs.actual);
}));

test('subscription fee settings are validated like every other numeric setting', () => withStore((store) => {
  store.updateSettings({ codexPlanUsdPerMonth: 200, claudePlanUsdPerMonth: 100 });
  assert.equal(store.getSettings().codexPlanUsdPerMonth, 200);
  assert.throws(() => store.updateSettings({ codexPlanUsdPerMonth: -1 }), /codexPlanUsdPerMonth/);
  assert.throws(() => store.updateSettings({ claudePlanUsdPerMonth: 'free' }), /claudePlanUsdPerMonth/);
}));

test('the store refuses a relative database path', () => {
  assert.throws(() => new UsageStore('-', path.join(os.tmpdir(), 'ai-usage-backups')), /must be absolute/);
  assert.throws(() => new UsageStore('relative/ai-usage.sqlite', path.join(os.tmpdir(), 'ai-usage-backups')), /must be absolute/);
});

test('an unreadable database file is set aside under a dated name and a fresh one is opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-corrupt-'));
  const databasePath = path.join(root, 'ai-usage.sqlite');
  fs.writeFileSync(databasePath, Buffer.from('definitely not a SQLite file, but long enough to be opened as one........'));
  fs.writeFileSync(`${databasePath}-wal`, 'stale wal');
  const store = new UsageStore(databasePath, path.join(root, 'Backups'));
  try {
    assert.match(store.recoveredFrom, /ai-usage\.sqlite\.corrupt-\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.existsSync(store.recoveredFrom), true, 'the unreadable file is preserved');
    assert.equal(fs.readFileSync(store.recoveredFrom, 'utf8').startsWith('definitely not'), true);
    assert.equal(store.getSettings().theme, 'system', 'the replacement is a seeded, working database');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 0);
  } finally {
    store.close();
  }
  // A healthy database opens as before and reports no recovery.
  const reopened = new UsageStore(databasePath, path.join(root, 'Backups'));
  try { assert.equal(reopened.recoveredFrom, null); } finally { reopened.close(); }
});

test('settings patches are written atomically', () => withStore((store) => {
  const original = store.updateSettings;
  // Validation passes; the write itself fails after the first key.
  let calls = 0;
  const prepare = store.prepare.bind(store);
  store.prepare = (sql) => {
    const statement = prepare(sql);
    if (!/INSERT INTO settings/.test(sql)) return statement;
    return { run: (...args) => { calls += 1; if (calls === 2) throw new Error('disk full'); return statement.run(...args); } };
  };
  try {
    assert.throws(() => store.updateSettings({ theme: 'dark', reservePercent: 25 }), /disk full/);
  } finally {
    store.prepare = prepare;
    store.updateSettings = original;
  }
  const settings = store.getSettings();
  assert.equal(settings.theme, 'system', 'the first key of a failed patch is rolled back');
  assert.equal(settings.reservePercent, 0);
}));
