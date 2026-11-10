'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectFableAllowance } = require('../../electron/fable-projection.cjs');
const { UsageStore } = require('../../electron/store.cjs');

const HOUR = 3_600_000;
const MILLION = 1_000_000;
const NOW = Date.parse('2026-11-09T20:00:00Z');
const RESET = '2026-11-13T08:00:00.000Z';
const iso = (at) => new Date(at).toISOString();
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);

function fixture(t, name = 'fable-5-2') {
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
    eventKey: `fable-5-2:${key}`, sourceId: 'claude', occurredAt: iso(occurredAt), sessionId: `session-${key}`, model,
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

test('Fable 5.2 has its own price row: $8 input, $10 and $16 cache writes, $0.20 cache reads, $40 output', (t) => {
  const { store } = fixture(t);
  const fable = store.resolvePrice('claude-fable-5-2');
  assert.equal(fable.model, 'claude-fable-5-2');
  assert.deepEqual(rates(fable), [8, 10, 16, 0.2, 40]);
  assert.equal(fable.effective_from, '2026-11-09');
  assert.equal(fable.source_url, 'https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(fable.is_seed, 1);
  assert.deepEqual(rates(store.resolvePrice('claude-fable-5-1')), [10, 12.5, 20, 0.25, 50], 'Fable 5.1 keeps its own rates');
  for (const model of ['claude-fable-5-2-20261109', 'CLAUDE-FABLE-5-2']) {
    assert.equal(store.resolvePrice(model)?.model, 'claude-fable-5-2', model);
  }
  assert.equal(store.resolvePrice('claude-fable-5-3'), null, 'the next point release does not borrow it');
});

test('Fable 5.2 prices every category at its own rate, at any prompt length', (t) => {
  const { store } = fixture(t);
  const every = store.calculateCost({
    source_id: 'claude', model: 'claude-fable-5-2', input_tokens: MILLION, cached_input_tokens: MILLION,
    cache_write_input_tokens: 2 * MILLION, cache_write_5m_input_tokens: MILLION, cache_write_1h_input_tokens: MILLION,
    output_tokens: MILLION,
  });
  near(every.actualUsd, 8 + 0.2 + 10 + 16 + 40, 1e-9, 'every category');
  near(every.breakdownUsd.cacheRead, 0.2, 1e-12, 'cache reads at $0.20');
  near(every.breakdownUsd.cacheWrite1h, 16, 1e-12, 'one-hour writes at $16');
  // The full 1M window is at standard rates: no prompt-length tier.
  const long = store.calculateCost({ source_id: 'claude', model: 'claude-fable-5-2', input_tokens: 900_000 });
  assert.equal(long.longContext, false);
  near(long.actualUsd, 7.2, 1e-12, 'a 900,000-token prompt');
});

test('an existing database gains the Fable 5.2 row on reopen, reprices history and keeps custom rates', (t) => {
  const context = fixture(t, 'fable-5-2-upgrade');
  let store = context.store;
  store.db.prepare('DELETE FROM price_catalog WHERE model = ?').run('claude-fable-5-2');
  context.usage('old-fable', NOW - HOUR, 'claude-fable-5-2', { inputTokens: MILLION, cachedInputTokens: 10 * MILLION });
  assert.equal(store.resolvePrice('claude-fable-5-2'), null, 'without its row Fable 5.2 does not borrow Fable 5\'s');
  assert.deepEqual(context.costs().unpricedModels.map((row) => row.model), ['claude-fable-5-2']);

  store = context.reopen();
  const after = context.costs();
  assert.equal(after.isComplete, true);
  assert.equal(after.actual, 10, '$8 input and ten million cache reads at $0.20');
  store.updatePrice({ model: 'claude-fable-5-2', inputUsdPerMillion: 8, cacheWriteUsdPerMillion: 10,
    cacheWrite1hUsdPerMillion: 16, cacheReadUsdPerMillion: 0.25, outputUsdPerMillion: 40 });
  store = context.reopen();
  assert.equal(store.resolvePrice('claude-fable-5-2').is_seed, 0);
  assert.equal(context.costs().actual, 10.5, 'a custom rate survives the seed');
});

test('the Fable estimate weighs Fable 5.2 at its own rates, not Fable 5\'s', (t) => {
  // Ten overall points with no Fable reading: 5M Fable 5.2 cache reads are one
  // pressure unit, as are 250k Opus 5.5 input, so Fable has half the step,
  // doubled for its half share. As Fable 5 they were five units.
  const context = fixture(t, 'fable-5-2-share');
  context.claude(NOW - 25 * HOUR, 10);
  context.usage('fable', NOW - 20 * HOUR, 'claude-fable-5-2', { cachedInputTokens: 5 * MILLION });
  context.usage('opus', NOW - 19 * HOUR, 'claude-opus-5-5', { inputTokens: 250_000 });
  context.claude(NOW - HOUR, 20);
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.available, true);
  assert.equal(projection.calibration.method, 'overall-share');
  assert.equal(projection.calibration.profile, 'allowance-pressure-v4');
  near(projection.usedPercent, 10, 1e-9, 'Fable 5.2 with Opus 5.5');
});
