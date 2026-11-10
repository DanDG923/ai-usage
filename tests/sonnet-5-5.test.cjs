'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectFableAllowance } = require('../electron/fable-projection.cjs');
const { UsageStore } = require('../electron/store.cjs');

const HOUR = 3_600_000;
const MILLION = 1_000_000;
const NOW = Date.parse('2026-10-07T13:00:00Z');
const RESET = '2026-10-10T08:00:00.000Z';
const iso = (at) => new Date(at).toISOString();
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);

function fixture(t, name = 'sonnet-5-5') {
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
  context.usage = (key, occurredAt, model, tokens = {}) => context.store.recordUsageEvent({
    eventKey: `sonnet-5-5:${key}`, sourceId: 'claude', occurredAt: iso(occurredAt), sessionId: `session-${key}`, model,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, ...tokens,
  });
  context.claude = (observedAt, usedPercent) => context.store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(observedAt), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'overall' },
  });
  context.costs = () => context.store.getCostAnalytics(1, context.store.getSettings(), NOW);
  context.store.updateSettings({ currency: 'USD' });
  return context;
}

const rates = (price) => [price.input_usd_per_million, price.cache_write_usd_per_million,
  price.cache_write_1h_usd_per_million, price.cache_read_usd_per_million, price.output_usd_per_million];

test('Sonnet 5.5 has its own price row, with cache reads at $0.10', (t) => {
  const { store } = fixture(t);
  const sonnet = store.resolvePrice('claude-sonnet-5-5');
  assert.equal(sonnet.model, 'claude-sonnet-5-5');
  assert.deepEqual(rates(sonnet), [2, 2.5, 4, 0.1, 10]);
  assert.equal(sonnet.effective_from, '2026-10-07');
  assert.equal(sonnet.source_url, 'https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(sonnet.is_seed, 1);
  assert.deepEqual(rates(store.resolvePrice('claude-sonnet-5')), [2, 2.5, 4, 0.2, 10], 'Sonnet 5 keeps its own rates');
  for (const model of ['claude-sonnet-5-5-20260928', 'CLAUDE-SONNET-5-5']) {
    assert.equal(store.resolvePrice(model)?.model, 'claude-sonnet-5-5', model);
  }
  assert.equal(store.resolvePrice('claude-sonnet-5-6'), null, 'the next point release does not borrow it');
});

test('Sonnet 5.5 prices every category at its own rate, at any prompt length', (t) => {
  const { store } = fixture(t);
  const every = store.calculateCost({
    source_id: 'claude', model: 'claude-sonnet-5-5', input_tokens: MILLION, cached_input_tokens: MILLION,
    cache_write_input_tokens: 2 * MILLION, cache_write_5m_input_tokens: MILLION, cache_write_1h_input_tokens: MILLION,
    output_tokens: MILLION,
  });
  near(every.actualUsd, 2 + 0.1 + 2.5 + 4 + 10, 1e-9, 'every category');
  near(every.breakdownUsd.cacheRead, 0.1, 1e-12, 'cache reads at $0.10');
  // The full 1M window is at standard rates: no prompt-length tier.
  const long = store.calculateCost({ source_id: 'claude', model: 'claude-sonnet-5-5', input_tokens: 900_000 });
  assert.equal(long.longContext, false);
  near(long.actualUsd, 1.8, 1e-12, 'a 900,000-token prompt');
});

test('an existing database gains the Sonnet 5.5 row on reopen, reprices history and keeps custom rates', (t) => {
  const context = fixture(t, 'sonnet-5-5-upgrade');
  let store = context.store;
  store.db.prepare('DELETE FROM price_catalog WHERE model = ?').run('claude-sonnet-5-5');
  context.usage('old-sonnet', NOW - HOUR, 'claude-sonnet-5-5', { inputTokens: MILLION, cachedInputTokens: 10 * MILLION });
  assert.equal(store.resolvePrice('claude-sonnet-5-5'), null, 'without its row Sonnet 5.5 does not borrow Sonnet 5\'s');
  assert.deepEqual(context.costs().unpricedModels.map((row) => row.model), ['claude-sonnet-5-5']);

  store = context.reopen();
  const after = context.costs();
  assert.equal(after.isComplete, true);
  assert.equal(after.actual, 3, '$2 input and ten million cache reads at $0.10');
  store.updatePrice({ model: 'claude-sonnet-5-5', inputUsdPerMillion: 2, cacheWriteUsdPerMillion: 2.5,
    cacheWrite1hUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 10 });
  store = context.reopen();
  assert.equal(store.resolvePrice('claude-sonnet-5-5').is_seed, 0);
  assert.equal(context.costs().actual, 4, 'a custom rate survives the seed');
});

test('the Fable estimate weighs Sonnet 5.5 cache reads at $0.10, not Sonnet 5\'s $0.20', (t) => {
  // Ten overall points with no Fable reading: 4M Fable 5.1 cache reads are one
  // pressure unit, as are 10M Sonnet 5.5 cache reads, so Fable has half the
  // step, doubled for its half share. As Sonnet 5 they were two units.
  const context = fixture(t, 'sonnet-5-5-share');
  context.claude(NOW - 25 * HOUR, 10);
  context.usage('fable', NOW - 20 * HOUR, 'claude-fable-5-1', { cachedInputTokens: 4 * MILLION });
  context.usage('sonnet', NOW - 19 * HOUR, 'claude-sonnet-5-5', { cachedInputTokens: 10 * MILLION });
  context.claude(NOW - HOUR, 20);
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.available, true);
  assert.equal(projection.calibration.method, 'overall-share');
  assert.equal(projection.calibration.profile, 'allowance-pressure-v4');
  near(projection.usedPercent, 10, 1e-9, 'Fable 5.1 with Sonnet 5.5');
});
