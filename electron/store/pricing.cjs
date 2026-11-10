'use strict';

// The API price catalogue: built-in rates, long-context rules, and the cost
// of one usage row at today's catalogue prices.

/** @typedef {import('../../src/types').PriceRow} PriceRow */
/** @typedef {import('../types').PriceCatalogRow} PriceCatalogRow */
/**
 * What is priced: the token counts of one request, or of a sum of requests
 * of one model in one long-context tier. A usage_events row is one.
 * @typedef {object} PricedUsage
 * @property {string | null} [model]
 * @property {string} [source_id]
 * @property {number} [input_tokens]
 * @property {number} [cached_input_tokens]
 * @property {number} [cache_write_input_tokens]
 * @property {number} [cache_write_5m_input_tokens]
 * @property {number} [cache_write_1h_input_tokens]
 * @property {number} [output_tokens]
 * @property {number | null} [contextTier] On a sum: how many long-context thresholds each request's prompt is over.
 */
/**
 * A price as the settings screen sends it.
 * @typedef {object} PriceUpdate
 * @property {string} model
 * @property {number} inputUsdPerMillion
 * @property {number} cacheWriteUsdPerMillion
 * @property {number} cacheWrite1hUsdPerMillion
 * @property {number} cacheReadUsdPerMillion
 * @property {number} outputUsdPerMillion
 * @property {string | null} [effectiveFrom]
 * @property {string | null} [sourceUrl]
 */

const { cachedInputInsideInput } = require('../providers.mjs');
const { iso } = require('./shared.cjs');

// Long-context pricing by catalogue model: a request whose prompt is over
// `threshold` tokens pays `input` times every input and cache rate and
// `output` times the output rate, for the whole request. OpenAI's GPT-6 and
// GPT-5.6 models double input and raise output by half above 272,000; Claude
// Haiku 5.5's second rate card, for prompts over 100,000, is five times its first.
const OPENAI_LONG_CONTEXT = { threshold: 272_000, input: 2, output: 1.5 };
const LONG_CONTEXT_PRICING = new Map(/** @type {[string, typeof OPENAI_LONG_CONTEXT][]} */ ([
  ...['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
    .map((model) => [model, OPENAI_LONG_CONTEXT]),
  ['claude-haiku-5-5', { threshold: 100_000, input: 5, output: 5 }],
]));
const LONG_CONTEXT_THRESHOLDS = [...new Set([...LONG_CONTEXT_PRICING.values()].map((rule) => rule.threshold))]
  .sort((a, b) => a - b);
// How many thresholds a request's prompt is over, as calculateCost's
// contextTier. Queries that sum requests group by it, so no sum mixes requests
// either side of the threshold their model is priced by.
/** @param {string} promptSql */
function contextTierSql(promptSql) {
  return LONG_CONTEXT_THRESHOLDS.map((threshold) => `(${promptSql} > ${threshold})`).join(' + ');
}
// Codex input includes its cached subset; Claude's categories are exclusive,
// so cache reads join its prompt.
const CONTEXT_TIER_SQL = contextTierSql(`CASE WHEN source_id = 'codex'
  THEN input_tokens ELSE input_tokens + cached_input_tokens END + cache_write_input_tokens`);

// Catalogue text fields come from the settings screen or a restored export.
// They are stored and displayed, never dereferenced, so shape and length are
// all that is enforced here.
const MAX_PRICE_MODEL_LENGTH = 120;
const MAX_PRICE_SOURCE_URL_LENGTH = 2048;

/** @param {unknown} value */
function priceModelName(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > MAX_PRICE_MODEL_LENGTH || /[\p{Cc}\p{Cf}]/u.test(model)) return null;
  return model;
}

/** @param {unknown} value */
function priceEffectiveFrom(value) {
  if (value == null || value === '') return iso().slice(0, 10);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/** @param {unknown} value */
function priceSourceUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_PRICE_SOURCE_URL_LENGTH || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
  } catch {
    return undefined;
  }
  return value;
}

// model, input, five-minute cache write, one-hour cache write, cache read, output
/** @type {[string, number, number, number, number, number][]} */
const PRICE_ROWS = [
  // Standard API rates verified 2026-09-04; OpenAI has one cache-write rate.
  ['gpt-6-astra', 10, 12.5, 12.5, 1, 50],
  // GPT-6.1 Sol standard rates verified 2026-10-01. It differs from GPT-6 Sol
  // only in cached input: $0.10 against $0.20 per MTok.
  ['gpt-6.1-sol', 2, 2.5, 2.5, 0.1, 10],
  // GPT-6.1 Terra standard rates verified 2026-10-30, released 2026-10-26:
  // exactly half of GPT-6.1 Sol in every category.
  ['gpt-6.1-terra', 1, 1.25, 1.25, 0.05, 5],
  // GPT-6 Sol and Luna standard rates verified 2026-09-22.
  ['gpt-6-sol', 2, 2.5, 2.5, 0.2, 10],
  ['gpt-6-luna', 0.1, 0.125, 0.125, 0.01, 0.5],
  ['gpt-5.6-sol', 4, 5, 5, 0.4, 20],
  ['codex-auto-review', 4, 5, 5, 0.4, 20],
  ['gpt-5.6-terra', 2, 2.5, 2.5, 0.2, 12],
  ['gpt-5.6-luna', 0.2, 0.25, 0.25, 0.02, 1.2],
  // Fable 5.2 standard rates verified 2026-11-10, released 2026-11-09: every
  // category is four fifths of Fable 5.1's, and the full 1M window is at
  // these rates, with no long-context tier.
  ['claude-fable-5-2', 8, 10, 16, 0.2, 40],
  // Fable 5.1 and Opus 5.5 standard rates verified 2026-09-26. Fable 5.1
  // differs from Fable 5 only in cache reads: $0.25 against $1 per MTok.
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  // Sonnet 5.5 standard rates verified 2026-10-07, the day its cache reads
  // fell from $0.20 to $0.10 per MTok; it differs from Sonnet 5 only there.
  ['claude-sonnet-5-5', 2, 2.5, 4, 0.1, 10],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  // Haiku 5.5 rates for prompts up to 100,000 tokens, verified 2026-10-07;
  // LONG_CONTEXT_PRICING applies the rates for longer prompts.
  ['claude-haiku-5-5', 0.1, 0.125, 0.2, 0.01, 0.5],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
];

// A catalogue model name followed by a date snapshot suffix, e.g. "-20260901".
// Only dates: a point release such as claude-fable-5-1 or claude-opus-5-5 is
// a different model with its own prices, and must show as unpriced until it
// has a row rather than silently borrowing its predecessor's.
const VERSION_SUFFIX = /^(?:\d{8}|\d{4}(?:-\d{2}){0,2})$/;

// Analytics runs resolve the same handful of model names thousands of times.
// Inside `withPriceCache` every lookup after the first is a Map hit and the
// catalogue is read once; outside it, each call reads the live table.
/**
 * @template T
 * @param {import('../store.cjs').Store} store
 * @param {() => T} run
 * @returns {T}
 */
function withPriceCache(store, run) {
  if (store.priceCache) return run();
  store.priceCache = { byModel: new Map(), rows: null };
  try {
    return run();
  } finally {
    store.priceCache = null;
  }
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string | null | undefined} model
 * @returns {PriceCatalogRow | null}
 */
function resolvePrice(store, model) {
  if (!model) return null;
  const cache = store.priceCache;
  if (cache?.byModel.has(model)) return cache.byModel.get(model);
  const resolved = store.lookupPrice(model, cache);
  if (cache) cache.byModel.set(model, resolved);
  return resolved;
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} model
 * @param {import('../store.cjs').Store['priceCache']} [cache]
 * @returns {PriceCatalogRow | null}
 */
function lookupPrice(store, model, cache) {
  const direct = /** @type {PriceCatalogRow | undefined} */ (store.prepare('SELECT * FROM price_catalog WHERE model = ?').get(model));
  if (direct) return direct;
  const normalized = model.toLowerCase().trim();
  const rows = /** @type {PriceCatalogRow[]} */ (cache
    ? (cache.rows ??= store.prepare('SELECT * FROM price_catalog').all())
    : store.prepare('SELECT * FROM price_catalog').all());
  const exactInsensitive = rows.find((row) => row.model.toLowerCase() === normalized);
  if (exactInsensitive) return exactInsensitive;
  const candidates = rows
    .filter((row) => {
      const priceModel = row.model.toLowerCase();
      if (!normalized.startsWith(`${priceModel}-`)) return false;
      return VERSION_SUFFIX.test(normalized.slice(priceModel.length + 1));
    })
    .sort((a, b) => b.model.length - a.model.length || a.model.localeCompare(b.model));
  return candidates[0] || null;
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {PriceRow[]}
 */
function getPriceCatalog(store) {
  return /** @type {PriceRow[]} */ (store.prepare(`
      SELECT model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url
      FROM price_catalog ORDER BY CASE WHEN model LIKE 'claude-%' THEN 2 ELSE 1 END, model
    `).all());
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {PriceUpdate} row
 * @returns {PriceRow[]}
 */
function updatePrice(store, row) {
  const values = /** @type {const} */ (['inputUsdPerMillion', 'cacheWriteUsdPerMillion', 'cacheWrite1hUsdPerMillion', 'cacheReadUsdPerMillion', 'outputUsdPerMillion'])
    .map((key) => Number(row[key]));
  const model = priceModelName(row.model);
  if (!model) throw new Error(`Model name must be plain text of at most ${MAX_PRICE_MODEL_LENGTH} characters.`);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1_000_000)) throw new Error('Every model price must be between zero and one million USD per million tokens.');
  const effectiveFrom = priceEffectiveFrom(row.effectiveFrom);
  if (!effectiveFrom) throw new Error('Effective date must be a calendar date in YYYY-MM-DD form.');
  const sourceUrl = priceSourceUrl(row.sourceUrl);
  if (sourceUrl === undefined) throw new Error('Source must be an http or https web address.');
  store.prepare(`
      INSERT INTO price_catalog(model, input_usd_per_million, cache_write_usd_per_million,
        cache_write_1h_usd_per_million, cache_read_usd_per_million,
        output_usd_per_million, effective_from, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        input_usd_per_million = excluded.input_usd_per_million,
        cache_write_usd_per_million = excluded.cache_write_usd_per_million,
        cache_write_1h_usd_per_million = excluded.cache_write_1h_usd_per_million,
        cache_read_usd_per_million = excluded.cache_read_usd_per_million,
        output_usd_per_million = excluded.output_usd_per_million,
        effective_from = excluded.effective_from,
        source_url = excluded.source_url,
        is_seed = 0
    `).run(model, ...values, effectiveFrom, sourceUrl);
  return store.getPriceCatalog();
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {PricedUsage} row
 */
function calculateCost(store, row) {
  // This dashboard answers the counterfactual "what would these tokens cost
  // at today's API catalogue?" A legacy/imported reported charge is useful
  // source metadata, but substituting it here would silently mix historical
  // invoices with current-catalogue estimates in the same total.
  const price = store.resolvePrice(row.model);
  if (!price) return { actualUsd: 0, withoutCacheUsd: 0, covered: false, longContext: false };
  const million = 1_000_000;
  // Reasoning tokens are a subset of output_tokens in provider usage schemas.
  const output = Number(row.output_tokens || 0);
  // OpenAI input totals include the cache-read subset. Claude's status-line
  // fields are mutually exclusive categories, so only Codex needs removal.
  const cachedInsideInput = cachedInputInsideInput(row.source_id);
  const regularInput = cachedInsideInput
    ? Math.max(0, Number(row.input_tokens || 0) - Number(row.cached_input_tokens || 0))
    : Number(row.input_tokens || 0);
  const cacheWriteTotal = Number(row.cache_write_input_tokens || 0);
  let cacheWrite5m = Number(row.cache_write_5m_input_tokens || 0);
  let cacheWrite1h = Number(row.cache_write_1h_input_tokens || 0);
  if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
  // Long-context pricing is a per-request rule. Collectors currently persist
  // each provider message/last_token_usage record as one usage event, so this
  // treats a row as one request. Eligibility is based on the full prompt,
  // cached part included, rather than only the uncached portion. A sum of
  // requests carries CONTEXT_TIER_SQL's contextTier instead; if collectors
  // ever write aggregates, they must carry an explicit request-context field
  // instead of applying this rule to totals.
  // Resolve through the catalogue row so dated supported model suffixes inherit
  // the rule, while similarly priced models such as codex-auto-review do not.
  const promptTokens = cachedInsideInput
    ? Number(row.input_tokens || 0) + cacheWriteTotal
    : Number(row.input_tokens || 0) + cacheWriteTotal + Number(row.cached_input_tokens || 0);
  const rule = LONG_CONTEXT_PRICING.get(price.model);
  const longContext = rule !== undefined && (row.contextTier != null
    ? row.contextTier > LONG_CONTEXT_THRESHOLDS.indexOf(rule.threshold)
    : promptTokens > rule.threshold);
  const inputMultiplier = rule && longContext ? rule.input : 1;
  const outputMultiplier = rule && longContext ? rule.output : 1;
  const actualUsd = (
    regularInput * price.input_usd_per_million * inputMultiplier
    + cacheWrite5m * price.cache_write_usd_per_million * inputMultiplier
    + cacheWrite1h * price.cache_write_1h_usd_per_million * inputMultiplier
    + Number(row.cached_input_tokens || 0) * price.cache_read_usd_per_million * inputMultiplier
    + output * price.output_usd_per_million * outputMultiplier
  ) / million;
  const withoutCacheUsd = (
    promptTokens * price.input_usd_per_million * inputMultiplier
    + output * price.output_usd_per_million * outputMultiplier
  ) / million;
  const breakdownUsd = {
    input: regularInput * price.input_usd_per_million * inputMultiplier / million,
    cacheRead: Number(row.cached_input_tokens || 0) * price.cache_read_usd_per_million * inputMultiplier / million,
    cacheWrite5m: cacheWrite5m * price.cache_write_usd_per_million * inputMultiplier / million,
    cacheWrite1h: cacheWrite1h * price.cache_write_1h_usd_per_million * inputMultiplier / million,
    output: output * price.output_usd_per_million * outputMultiplier / million,
  };
  return { actualUsd, withoutCacheUsd, covered: true, longContext, breakdownUsd };
}

module.exports = {
  contextTierSql, CONTEXT_TIER_SQL, priceModelName, priceEffectiveFrom, priceSourceUrl, PRICE_ROWS, withPriceCache,
  resolvePrice, lookupPrice, getPriceCatalog, updatePrice, calculateCost,
};
