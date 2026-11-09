'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { desktopAnalytics, saveDesktopEstimates } = require('../../electron/desktop-estimates.cjs');
const { projectFableAllowance } = require('../../electron/fable-projection.cjs');
const { UsageStore } = require('../../electron/store.cjs');
const { iso, near } = require('../helpers/time.cjs');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MILLION = 1_000_000;
const NOW = Date.parse('2026-10-07T13:00:00Z');
const RESET = '2026-10-10T08:00:00.000Z';

function fixture(t, name = 'haiku-5-5') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ai-usage-${name}-`));
  const file = path.join(root, 'db.sqlite');
  const backups = path.join(root, 'Backups');
  const context = { store: new UsageStore(file, backups) };
  context.reopen = () => {
    context.store.close();
    context.store = new UsageStore(file, backups);
    return context.store;
  };
  t.after(() => { context.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  context.usage = (key, occurredAt, model, tokens = {}, sourceId = 'claude') => context.store.recordUsageEvent({
    eventKey: `haiku-5-5:${key}`, sourceId, occurredAt: iso(occurredAt), sessionId: 'one-session', model,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, ...tokens,
  });
  context.claude = (observedAt, usedPercent, resetsAt = RESET) => context.store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(observedAt), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'overall' },
  });
  context.costs = () => context.store.getCostAnalytics(1, context.store.getSettings(), NOW);
  context.store.updateSettings({ currency: 'USD' });
  return context;
}

const rates = (price) => [price.input_usd_per_million, price.cache_write_usd_per_million,
  price.cache_write_1h_usd_per_million, price.cache_read_usd_per_million, price.output_usd_per_million];

// ---------------------------------------------------------------------------
// Prices.

test('Haiku 5.5 has its own price row and launch date', (t) => {
  const { store } = fixture(t);
  const haiku = store.resolvePrice('claude-haiku-5-5');
  assert.equal(haiku.model, 'claude-haiku-5-5');
  assert.deepEqual(rates(haiku), [0.1, 0.125, 0.2, 0.01, 0.5]);
  assert.equal(haiku.effective_from, '2026-10-07');
  assert.equal(haiku.source_url, 'https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(haiku.is_seed, 1);
  assert.deepEqual(rates(store.resolvePrice('claude-haiku-4-5')), [1, 1.25, 2, 0.1, 5], 'Haiku 4.5 keeps its own rates');
  for (const model of ['claude-haiku-5-5-20261007', 'claude-haiku-5-5-2026-10-07', 'CLAUDE-HAIKU-5-5']) {
    assert.equal(store.resolvePrice(model)?.model, 'claude-haiku-5-5', model);
  }
  for (const model of ['claude-haiku-5', 'claude-haiku-5-6', 'claude-haiku-5-5-fast']) {
    assert.equal(store.resolvePrice(model), null, `${model} must not borrow Haiku 5.5's price`);
  }
});

// 100,000 prompt tokens exactly, made of every Claude category.
const atThreshold = (model = 'claude-haiku-5-5') => ({
  source_id: 'claude', model, input_tokens: 20_000, cached_input_tokens: 50_000,
  cache_write_input_tokens: 30_000, cache_write_5m_input_tokens: 10_000, cache_write_1h_input_tokens: 20_000,
  output_tokens: 1_000,
});

test('a Haiku 5.5 prompt of 100,000 tokens uses the first rate card and one more token the second', (t) => {
  const { store } = fixture(t);
  for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5-20261007']) {
    const standard = store.calculateCost(atThreshold(model));
    assert.equal(standard.covered, true);
    assert.equal(standard.longContext, false, model);
    // 20k × 0.10 + 10k × 0.125 + 20k × 0.20 + 50k × 0.01 + 1k × 0.50, per million.
    near(standard.actualUsd, 0.00825, 1e-12, `${model} up to 100,000`);
    near(standard.withoutCacheUsd, 0.0105, 1e-12, `${model} without cache`);

    // Uncached input, cache reads and cache writes all count towards the
    // prompt, and the second card applies to every category of the request.
    for (const [extra, tokens] of [
      ['input', { input_tokens: 20_001 }],
      ['cache read', { cached_input_tokens: 50_001 }],
      ['cache write', { cache_write_input_tokens: 30_001, cache_write_5m_input_tokens: 10_001 }],
    ]) {
      const long = store.calculateCost({ ...atThreshold(model), ...tokens });
      assert.equal(long.longContext, true, `${model}: one more ${extra} token`);
      near(long.actualUsd, 0.04125, 1e-6, `${model}: one more ${extra} token`);
    }
    const long = store.calculateCost({ ...atThreshold(model), input_tokens: 20_001 });
    near(long.breakdownUsd.input, 20_001 * 0.5 / MILLION, 1e-15, 'input at $0.50');
    near(long.breakdownUsd.cacheWrite5m, 10_000 * 0.625 / MILLION, 1e-15, 'five-minute writes at $0.625');
    near(long.breakdownUsd.cacheWrite1h, 20_000 * 1 / MILLION, 1e-15, 'one-hour writes at $1');
    near(long.breakdownUsd.cacheRead, 50_000 * 0.05 / MILLION, 1e-15, 'cache reads at $0.05');
    near(long.breakdownUsd.output, 1_000 * 2.5 / MILLION, 1e-15, 'output at $2.50');
  }
  // The rule follows the catalogue row: Haiku 4.5 has one card at any length.
  const haiku45 = store.calculateCost({ ...atThreshold('claude-haiku-4-5'), input_tokens: 900_000 });
  assert.equal(haiku45.longContext, false);
});

// One request at the threshold, one just over it, both in one session hour:
// $0.06 and $0.3000005, where pricing their sum as one request gives $0.60.
function twoRequests(context, at) {
  context.usage('short', at, 'claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 100_000 });
  context.usage('long', at + 60_000, 'claude-haiku-5-5', { inputTokens: 100_001, outputTokens: 100_000 });
}

test('Costs price each Haiku 5.5 request by its own prompt length', (t) => {
  const context = fixture(t);
  twoRequests(context, NOW - HOUR);
  // A 150,000-token GPT-6 Sol prompt is over Haiku's threshold but not its own.
  context.usage('sol-150k', NOW - HOUR, 'gpt-6-sol', { inputTokens: 150_000 }, 'codex');
  context.usage('sol-300k', NOW - HOUR + 60_000, 'gpt-6-sol', { inputTokens: 300_000 }, 'codex');
  const costs = context.costs();
  const byModel = Object.fromEntries(costs.byModel.map((row) => [row.model, row]));
  const haiku = byModel['claude-haiku-5-5'];
  assert.equal(haiku.cost, 0.36);
  near(haiku.costBreakdown.input, 0.0100000 + 0.0500005, 1e-12, 'input');
  near(haiku.costBreakdown.output, 0.05 + 0.25, 1e-12, 'output');
  assert.equal(haiku.coverage, 1);
  // $0.30 on the standard rates and $1.20 on GPT-6 Sol's own long-context ones.
  assert.equal(byModel['gpt-6-sol'].cost, 1.5);
  assert.equal(costs.isComplete, true);
  assert.deepEqual(costs.unpricedModels, []);
});

test('cycle history prices each Haiku 5.5 request by its own prompt length', (t) => {
  const context = fixture(t);
  context.claude(NOW - 2 * DAY, 10);
  twoRequests(context, NOW - DAY);
  const { store } = context;
  const [current] = store.getCycleHistory('claude', { bucketId: 'seven_day' }, store.getSettings(), 8, NOW);
  assert.equal(current.current, true);
  assert.equal(current.cost, 0.36);
  assert.equal(current.tokens, 400_001);
});

test('desktop and web chat estimates price each Haiku 5.5 reply by its own prompt length', (t) => {
  const { store } = fixture(t);
  const reply = (key, inputTokens, outputTokens) => ({
    event_key: key.repeat(64), occurred_at: iso(NOW - HOUR), model: 'claude-haiku-5-5', model_origin: 'exported',
    input_tokens: inputTokens, output_tokens: outputTokens, excluded_content: 0, input_missing: 0,
    method: 'visible-prompt-reply-chars-v1',
  });
  // 60k in and 10k out at $0.10 / $0.50, then 150k in and 10k out at five
  // times both: $0.011 and $0.10, where pricing their sum on the first card
  // would give $0.031.
  assert.deepEqual(saveDesktopEstimates(store, [reply('a', 60_000, 10_000), reply('b', 150_000, 10_000)]),
    { imported: 2, duplicates: 0 });
  const analytics = desktopAnalytics(store, 30, store.getSettings(), NOW);
  assert.equal(analytics.byModel.length, 1);
  assert.equal(analytics.byModel[0].replies, 2);
  near(analytics.byModel[0].estimatedCost, 0.011 + 0.1, 1e-12, 'by model');
  near(analytics.estimatedCost, 0.011 + 0.1, 1e-12, 'total');
  assert.equal(analytics.unpricedReplies, 0);
});

test('an existing database gains the Haiku 5.5 row on reopen, reprices history and keeps custom rates', (t) => {
  const context = fixture(t, 'haiku-5-5-upgrade');
  let store = context.store;
  store.db.prepare('DELETE FROM price_catalog WHERE model = ?').run('claude-haiku-5-5');
  context.usage('old-haiku', NOW - HOUR, 'claude-haiku-5-5', { inputTokens: MILLION, outputTokens: 100_000 });
  assert.equal(store.resolvePrice('claude-haiku-5-5'), null, 'without its row Haiku 5.5 does not borrow another price');
  const before = context.costs();
  assert.equal(before.isLowerBound, true);
  assert.deepEqual(before.unpricedModels.map((row) => row.model), ['claude-haiku-5-5']);
  const events = store.db.prepare('SELECT * FROM usage_events ORDER BY event_key').all();

  store = context.reopen();
  assert.deepEqual(store.db.prepare('SELECT * FROM usage_events ORDER BY event_key').all(), events, 'history is not rewritten');
  const after = context.costs();
  assert.equal(after.isComplete, true);
  assert.deepEqual(after.unpricedModels, []);
  // A million-token prompt is on the second card: $0.50 input, $2.50 output.
  assert.equal(after.actual, 0.75);
  assert.equal(store.resolvePrice('claude-haiku-5-5').effective_from, '2026-10-07');

  store.updatePrice({ model: 'claude-haiku-5-5', inputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 0.25,
    cacheWrite1hUsdPerMillion: 0.4, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1 });
  store = context.reopen();
  assert.equal(store.resolvePrice('claude-haiku-5-5').is_seed, 0);
  assert.equal(store.resolvePrice('claude-haiku-5-5').input_usd_per_million, 0.2, 'a custom rate survives the seed');
  assert.equal(context.costs().actual, 1.5, 'the long-prompt multiplier applies to the custom rates');
});

// ---------------------------------------------------------------------------
// Allowance pressure v3.

// Ten overall points with no Fable reading, split between 4M Fable 5.1 cache
// reads (one pressure unit) and Haiku 5.5 activity.
function shareScenario(t, haikuModel, haikuTokens) {
  const context = fixture(t, 'haiku-5-5-share');
  context.claude(NOW - 25 * HOUR, 10);
  context.usage('fable', NOW - 20 * HOUR, 'claude-fable-5-1', { cachedInputTokens: 4 * MILLION });
  context.usage('haiku', NOW - 19 * HOUR, haikuModel, haikuTokens);
  context.claude(NOW - HOUR, 20);
  return projectFableAllowance(context.store, NOW);
}

test('Haiku 5.5 activity takes its share of the week instead of making the Fable estimate unavailable', (t) => {
  for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5-20261007']) {
    // Ten million input tokens are one pressure unit at $0.10, whatever the
    // prompt length: half of ten overall points, doubled for Fable's half share.
    const projection = shareScenario(t, model, { inputTokens: 10 * MILLION });
    assert.equal(projection.available, true, model);
    assert.equal(projection.calibration.method, 'overall-share');
    assert.equal(projection.calibration.profile, 'allowance-pressure-v3');
    near(projection.usedPercent, 10, 1e-9, model);
  }
  near(shareScenario(t, 'claude-haiku-5-5', { cachedInputTokens: 100 * MILLION, outputTokens: 2 * MILLION })
    .usedPercent, 10 / 3 / 0.5, 1e-9, 'cache reads at $0.01 and output at $0.50');
});

test('an undated Haiku 5.5 variant is unpriced but still weighed as Haiku 5.5 in the Fable estimate', (t) => {
  // Pricing takes only date suffixes; attribution falls back to the family,
  // so the week stays covered rather than the estimate being withheld.
  const projection = shareScenario(t, 'claude-haiku-5-5-fast', { inputTokens: 10 * MILLION });
  assert.equal(projection.available, true);
  near(projection.usedPercent, 10, 1e-9, 'weighed as Haiku 5.5');
  const { store } = fixture(t);
  assert.equal(store.resolvePrice('claude-haiku-5-5-fast'), null);
});
