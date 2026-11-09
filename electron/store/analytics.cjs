'use strict';

// API-equivalent cost analytics over the usage ledger: period totals,
// session and task pages, the CSV export and the Fable version split.

/** @typedef {import('../../src/types').CostAnalytics} CostAnalytics */
/** @typedef {{ sessions: import('../../src/types').SessionCost[], tasks: import('../../src/types').TaskCost[], costs: CostAnalytics }} Analytics One period's ledger, as cached. */
/** @typedef {import('../../src/types').DailyUsage} DailyUsage */
/** @typedef {import('../../src/types').FableActivity} FableActivity */
/** @typedef {import('../../src/types').SessionPage} SessionPage */
/** @typedef {import('../../src/types').TaskPage} TaskPage */

const { periodStart } = require('../time.cjs');
const { TaskUsage } = require('../task-usage.cjs');
const { SOURCE_DEFINITIONS, DAY_MS, iso, round, dateKey, createLocalPartsLookup, WEEKDAY_INDEX } = require('./shared.cjs');
const { CONTEXT_TIER_SQL } = require('./pricing.cjs');

// About a megabyte of ledger CSV is written at a time.
const CSV_BATCH_CHARS = 1 << 20;

// Analytics groups usage by the metadata that attributes it to a task or
// agent. Per-request fields such as Claude's requestId are unique to every
// event, so grouping on them would keep one aggregate row per request.
const ATTRIBUTION_METADATA = `CASE WHEN json_valid(metadata_json)
  THEN json_remove(metadata_json, '$.requestId', '$.entrypoint', '$.sidechain', '$.effort')
  ELSE metadata_json END`;

/**
 * @param {import('../store.cjs').Store} store
 * @returns {CostAnalytics}
 */
function getCostAnalytics(store, days = 30, settings = store.getSettings(), nowMs = Date.now()) {
  return store.getAnalytics(days, settings, nowMs).costs;
}

/** @param {import('../store.cjs').Store} store */
function analyticsRevision(store) {
  return store.prepare("SELECT COALESCE(SUM(revision), 0) AS revision FROM analytics_revisions WHERE domain IN ('usage', 'price')")
    .get().revision;
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {Analytics}
 */
function getAnalytics(store, days, settings, nowMs) {
  // Cache the ledger separately from the time-sensitive forecast snapshot.
  // SQLite tracks both writes on this connection and collector-process commits.
  // Never cache transactional reads: a rollback must not preserve their totals.
  if (store.db.isTransaction) return store.withPriceCache(() => store.buildAnalytics(days, settings, nowMs));
  const revision = store.analyticsRevision();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = JSON.stringify([days, settings.currency, settings.usdToCurrency, timeZone]);
  const cached = store.costAnalyticsCache.get(key);
  if (cached && cached.revision === revision && nowMs >= cached.at && nowMs < cached.expiresAt) {
    store.costAnalyticsCache.delete(key);
    store.costAnalyticsCache.set(key, cached);
    return cached.value;
  }
  const nextEvent = store.prepare('SELECT occurred_at FROM usage_events WHERE occurred_at > ? ORDER BY occurred_at ASC LIMIT 1')
    .get(iso(nowMs));
  const value = store.withPriceCache(() => store.buildAnalytics(days, settings, nowMs));
  // The period starts at a local midnight, so it moves only when the day
  // changes; a future-dated record enters at its timestamp. Clock rollback
  // also forces a read.
  const expiresAt = Math.min(periodStart(0, nowMs), nextEvent ? Date.parse(nextEvent.occurred_at) : Infinity);
  store.costAnalyticsCache.delete(key);
  store.costAnalyticsCache.set(key, { at: nowMs, expiresAt, revision, value });
  if (store.costAnalyticsCache.size > 4) store.costAnalyticsCache.delete(store.costAnalyticsCache.keys().next().value);
  return value;
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {CostAnalytics}
 */
function buildCostAnalytics(store, days, settings, nowMs) {
  return store.buildAnalytics(days, settings, nowMs).costs;
}

// All session aggregates stay in the same bounded, privately held cache as
// their period's costs. Snapshots expose only eight highlights; paginated
// requests search the complete ledger without re-costing it for each page.
/**
 * @param {import('../store.cjs').Store} store
 * @returns {SessionPage}
 */
function getSessionPage(store, { days = 30, query = '', page = 1, pageSize = 20 } = {}, nowMs = Date.now()) {
  const boundedInteger = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  const period = boundedInteger(days, 30, 1, 365);
  const size = boundedInteger(pageSize, 20, 1, 100);
  const needle = typeof query === 'string' ? query.trim().slice(0, 500).toLowerCase() : '';
  const sessions = store.getAnalytics(period, store.getSettings(), nowMs).sessions;
  const matches = needle ? sessions.filter((row) => [row.sourceId,
    SOURCE_DEFINITIONS.find(([id]) => id === row.sourceId)?.[1], row.project, row.sessionId, row.model]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) : sessions;
  const total = matches.length;
  const totalPages = Math.ceil(total / size);
  const selectedPage = boundedInteger(page, 1, 1, Math.max(1, totalPages));
  return { rows: matches.slice((selectedPage - 1) * size, selectedPage * size), total,
    page: selectedPage, pageSize: size, totalPages };
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {TaskPage}
 */
function getTaskPage(store, { days = 30, query = '', page = 1, pageSize = 20 } = {}, nowMs = Date.now()) {
  const boundedInteger = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  const period = boundedInteger(days, 30, 1, 365);
  const size = boundedInteger(pageSize, 20, 1, 100);
  const needle = typeof query === 'string' ? query.trim().slice(0, 500).toLowerCase() : '';
  const sessions = store.getAnalytics(period, store.getSettings(), nowMs).tasks;
  const matches = needle ? sessions.filter((row) => [row.sourceId,
    SOURCE_DEFINITIONS.find(([id]) => id === row.sourceId)?.[1], row.project, row.sessionId, row.taskId,
    ...row.agents.flatMap((agent) => [agent.agentId, agent.agentName, agent.agentRole, agent.model])]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) : sessions;
  const total = matches.length;
  const totalPages = Math.ceil(total / size);
  const selectedPage = boundedInteger(page, 1, 1, Math.max(1, totalPages));
  return { rows: matches.slice((selectedPage - 1) * size, selectedPage * size), total,
    page: selectedPage, pageSize: size, totalPages };
}

/** @param {import('../store.cjs').Store} store */
function analyticsEvents(store, since, until) {
  const revisions = new Map(store.prepare('SELECT day, revision FROM analytics_day_revisions WHERE day >= ? AND day <= ?')
    .all(since.slice(0, 10), until.slice(0, 10)).map((row) => [row.day, row.revision]));
  const result = [];
  const start = Date.parse(`${since.slice(0, 10)}T00:00:00.000Z`);
  for (let cursor = start; cursor <= Date.parse(until); cursor += DAY_MS) {
    const day = iso(cursor).slice(0, 10);
    const lower = cursor === start ? since : iso(cursor);
    const upper = iso(Math.min(cursor + DAY_MS - 1, Date.parse(until)));
    const revision = revisions.get(day) ?? 0;
    const cached = !store.db.isTransaction ? store.analyticsDayCache.get(day) : null;
    let rows = cached?.revision === revision && cached.lower === lower && cached.upper === upper ? cached.rows : null;
    if (!rows) {
      // Preserve per-request context tiers and legacy cache durations before
      // aggregation. Task metadata stays distinct so parent/agent attribution
      // cannot merge. Counts remain request counts, not aggregate row counts.
      rows = store.prepare(`SELECT MIN(event_key) AS event_key, source_id, session_id, model, project,
          ${ATTRIBUTION_METADATA} AS metadata_json,
          MIN(occurred_at) AS first_occurred_at, MAX(occurred_at) AS occurred_at, COUNT(*) AS event_count,
          ${CONTEXT_TIER_SQL} AS contextTier,
          SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(cache_write_input_tokens) AS cache_write_input_tokens,
          SUM(CASE WHEN cache_write_5m_input_tokens + cache_write_1h_input_tokens = 0 THEN cache_write_input_tokens ELSE cache_write_5m_input_tokens END) AS cache_write_5m_input_tokens,
          SUM(cache_write_1h_input_tokens) AS cache_write_1h_input_tokens,
          SUM(output_tokens) AS output_tokens, SUM(reasoning_output_tokens) AS reasoning_output_tokens
          FROM usage_events WHERE occurred_at >= ? AND occurred_at <= ?
          GROUP BY source_id, session_id, CASE WHEN session_id IS NULL OR session_id = '' THEN event_key END,
            model, project, ${ATTRIBUTION_METADATA}, substr(occurred_at, 1, 13), CAST(substr(occurred_at, 15, 2) AS INTEGER) / 15, contextTier
          ORDER BY first_occurred_at, occurred_at`).all(lower, upper);
      if (!store.db.isTransaction) {
        store.analyticsDayCache.set(day, { revision, lower, upper, rows });
        if (store.analyticsDayCache.size > 367) store.analyticsDayCache.delete(store.analyticsDayCache.keys().next().value);
      }
    }
    // A spread passes every row as an argument, which overflows the call
    // stack once one day holds about 125,000 groups.
    for (const row of rows) result.push(row);
  }
  return result;
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {Analytics}
 */
function buildAnalytics(store, days, settings, nowMs) {
  const since = iso(periodStart(days, nowMs));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Aggregate one row at a time instead of retaining the entire raw ledger
  // alongside the model, project, and session summaries.
  const events = store.analyticsEvents(since, iso(nowMs));
  const byModelMap = new Map();
  const unpricedModelsMap = new Map();
  const byDayMap = new Map();
  const byProjectMap = new Map();
  const sessionMap = new Map();
  const taskUsage = new TaskUsage();
  const activityUsd = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const localPartsOf = createLocalPartsLookup(timeZone);
  let actualUsd = 0;
  let withoutCacheUsd = 0;
  let coveredTokens = 0;
  let totalTokens = 0;
  let requestCount = 0;

  for (const event of events) {
    requestCount += event.event_count;
    const cost = store.calculateCost(event);
    const eventTokens = event.source_id === 'codex'
      ? Number(event.input_tokens) + Number(event.cache_write_input_tokens) + Number(event.output_tokens)
      : Number(event.input_tokens) + Number(event.cached_input_tokens)
        + Number(event.cache_write_input_tokens) + Number(event.output_tokens);
    taskUsage.add(event, cost, eventTokens);
    totalTokens += eventTokens;
    if (cost.covered) coveredTokens += eventTokens;
    else if (eventTokens > 0) {
      // Keyed apart from any model actually named "Unknown", which can be priced.
      const unpricedKey = event.model ? `${event.source_id}|${event.model}` : `${event.source_id}|`;
      const unpriced = unpricedModelsMap.get(unpricedKey) || {
        sourceId: event.source_id,
        model: event.model || 'Unknown',
        tokens: 0,
        // Records without a model name: no catalogue price can apply to them.
        ...(event.model ? {} : { unnamed: true }),
      };
      unpriced.tokens += eventTokens;
      unpricedModelsMap.set(unpricedKey, unpriced);
    }
    actualUsd += cost.actualUsd;
    withoutCacheUsd += cost.withoutCacheUsd;
    const key = `${event.source_id}|${event.model || 'Unknown'}`;
    const model = byModelMap.get(key) || {
      sourceId: event.source_id,
      model: event.model || 'Unknown',
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      costUsd: 0,
      breakdownUsd: { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
      coveredTokens: 0,
      totalTokens: 0,
    };
    model.inputTokens += Number(event.input_tokens);
    model.cachedInputTokens += Number(event.cached_input_tokens);
    model.cacheWriteInputTokens += Number(event.cache_write_input_tokens);
    // Apply the same legacy TTL fallback as pricing before grouping records.
    const write5m = Number(event.cache_write_5m_input_tokens);
    const write1h = Number(event.cache_write_1h_input_tokens);
    model.cacheWrite5mInputTokens += write5m + write1h === 0 ? Number(event.cache_write_input_tokens) : write5m;
    model.cacheWrite1hInputTokens += Number(event.cache_write_1h_input_tokens);
    model.outputTokens += Number(event.output_tokens);
    model.reasoningOutputTokens += Number(event.reasoning_output_tokens);
    model.costUsd += cost.actualUsd;
    if (cost.breakdownUsd) {
      model.breakdownUsd.input += cost.breakdownUsd.input;
      model.breakdownUsd.cacheRead += cost.breakdownUsd.cacheRead;
      model.breakdownUsd.cacheWrite5m += cost.breakdownUsd.cacheWrite5m;
      model.breakdownUsd.cacheWrite1h += cost.breakdownUsd.cacheWrite1h;
      model.breakdownUsd.output += cost.breakdownUsd.output;
    }
    model.totalTokens += eventTokens;
    if (cost.covered) model.coveredTokens += eventTokens;
    byModelMap.set(key, model);

    // The chart and activity grid share one local-time conversion per row.
    const parts = localPartsOf(event.occurred_at);
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const dayRow = byDayMap.get(day) || { date: day, codexUsd: 0, claudeUsd: 0 };
    if (event.source_id === 'codex') dayRow.codexUsd += cost.actualUsd;
    else dayRow.claudeUsd += cost.actualUsd;
    byDayMap.set(day, dayRow);
    activityUsd[WEEKDAY_INDEX[parts.weekday] ?? 0][Number(parts.hour) % 24] += cost.actualUsd;

    const projectKey = event.project || '';
    const projectRow = byProjectMap.get(projectKey) || {
      project: event.project || null,
      costUsd: 0,
      totalTokens: 0,
      coveredTokens: 0,
      sessions: new Set(),
      sources: new Set(),
      lastActivity: event.occurred_at,
    };
    projectRow.costUsd += cost.actualUsd;
    projectRow.totalTokens += eventTokens;
    if (cost.covered) projectRow.coveredTokens += eventTokens;
    projectRow.sessions.add(`${event.source_id}|${event.session_id || event.event_key}`);
    projectRow.sources.add(event.source_id);
    if (event.occurred_at > projectRow.lastActivity) projectRow.lastActivity = event.occurred_at;
    byProjectMap.set(projectKey, projectRow);

    const sessionKey = `${event.source_id}|${event.session_id || event.event_key}|${event.model || 'Unknown'}`;
    const session = sessionMap.get(sessionKey) || {
      sourceId: event.source_id,
      sessionId: event.session_id || event.event_key,
      model: event.model || 'Unknown',
      project: event.project || null,
      occurredAt: event.occurred_at,
      totalTokens: 0,
      costUsd: 0,
      coveredTokens: 0,
    };
    session.totalTokens += eventTokens;
    session.costUsd += cost.actualUsd;
    if (cost.covered) session.coveredTokens += eventTokens;
    if (event.occurred_at > session.occurredAt) session.occurredAt = event.occurred_at;
    if (!session.project && event.project) session.project = event.project;
    sessionMap.set(sessionKey, session);
  }

  const rate = Number(settings.usdToCurrency || 1);
  const toCurrency = (value) => round(value * rate, 2);
  const byModel = [...byModelMap.values()].map((row) => ({
    ...row,
    totalTokens: row.totalTokens,
    cost: toCurrency(row.costUsd),
    // Keep category precision until display; rounding each event would erase
    // small charges. Price per event before grouping to preserve context tiers.
    costBreakdown: Object.fromEntries(Object.entries(row.breakdownUsd).map(([key, value]) => [key, value * rate])),
    costShare: actualUsd > 0 && row.coveredTokens > 0 ? row.costUsd / actualUsd : null,
    coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0,
  })).sort((a, b) => b.cost - a.cost);
  const chart = [...byDayMap.values()].map((row) => ({
    date: row.date,
    codex: toCurrency(row.codexUsd),
    claude: toCurrency(row.claudeUsd),
  }));
  const sessions = [...sessionMap.values()]
    .sort((a, b) => round(b.costUsd - a.costUsd, 8) || b.occurredAt.localeCompare(a.occurredAt)
      || a.sourceId.localeCompare(b.sourceId) || a.sessionId.localeCompare(b.sessionId) || a.model.localeCompare(b.model))
    .map((row) => ({ ...row, cost: toCurrency(row.costUsd), coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0 }));
  const byProject = [...byProjectMap.values()]
    .sort((a, b) => round(b.costUsd - a.costUsd, 8) || String(a.project || '').localeCompare(String(b.project || '')))
    .map((row) => ({
      project: row.project,
      cost: toCurrency(row.costUsd),
      totalTokens: row.totalTokens,
      coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0,
      sessionCount: row.sessions.size,
      sources: [...row.sources].sort(),
      lastActivity: row.lastActivity,
    }));
  const unpricedModels = [...unpricedModelsMap.values()]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.model.localeCompare(b.model));
  const isComplete = coveredTokens === totalTokens;

  return {
    sessions,
    tasks: taskUsage.finish(rate),
    costs: {
      periodDays: days,
      currency: settings.currency,
      actual: toCurrency(actualUsd),
      withoutCache: toCurrency(withoutCacheUsd),
      cacheSavings: toCurrency(Math.max(0, withoutCacheUsd - actualUsd)),
      cacheSavingsPercent: withoutCacheUsd > 0 ? Math.max(0, (withoutCacheUsd - actualUsd) / withoutCacheUsd) : 0,
      totalTokens,
      coverage: totalTokens ? coveredTokens / totalTokens : 0,
      isComplete,
      isLowerBound: !isComplete,
      unpricedModels,
      requestCount,
      byModel,
      byProject,
      chart,
      sessions: sessions.slice(0, 8),
      activityGrid: activityUsd.map((row) => row.map((value) => toCurrency(value))),
    },
  };
}

// Everything the Details ledger shows, as one CSV a spreadsheet can open.
// Token counts and the current-catalogue equivalent in USD; no prompts. The
// period is the dashboard's: the last N local calendar days. Given `write`,
// text is handed over in batches as the ledger is read, so a long, busy
// period is never held in memory as one string; otherwise it is returned.
/** @param {import('../store.cjs').Store} store */
function exportLedgerCsv(store, days = 90, nowMs = Date.now(), write = null) {
  const since = iso(periodStart(days, nowMs));
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    // CSV quoting alone does not stop spreadsheet formulas. Guard text at
    // this sink, including prefixes hidden by whitespace/control characters
    // and full-width formula markers, while leaving numeric cells numeric.
    if (typeof value === 'string'
      && (/^[\s\p{Cc}\p{Cf}]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(text)
        || /^\s*[\p{Cc}\p{Cf}]/u.test(text))) {
      return `"'${text.replaceAll('"', '""')}"`;
    }
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = ['occurred_at', 'source', 'model', 'project', 'session_id', 'input_tokens', 'cached_input_tokens',
    'cache_write_5m_input_tokens', 'cache_write_1h_input_tokens', 'output_tokens', 'reasoning_output_tokens',
    'api_equivalent_usd', 'priced'];
  const chunks = [];
  const emit = write || ((text) => chunks.push(text));
  let batch = `${header.join(',')}\r\n`;
  let rows = 0;
  store.withPriceCache(() => {
    const events = store.prepare('SELECT * FROM usage_events WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at ASC')
      .iterate(since, iso(nowMs));
    for (const event of events) {
      const cost = store.calculateCost(event);
      let cacheWrite5m = Number(event.cache_write_5m_input_tokens || 0);
      const cacheWrite1h = Number(event.cache_write_1h_input_tokens || 0);
      if (cacheWrite5m + cacheWrite1h === 0) cacheWrite5m = Number(event.cache_write_input_tokens || 0);
      batch += `${[
          event.occurred_at, event.source_id, event.model, event.project, event.session_id,
          event.input_tokens, event.cached_input_tokens, cacheWrite5m, cacheWrite1h,
          event.output_tokens, event.reasoning_output_tokens,
          round(cost.actualUsd, 6), cost.covered ? 'yes' : 'no',
        ].map(escape).join(',')}\r\n`;
      rows += 1;
      if (batch.length >= CSV_BATCH_CHARS) {
        emit(batch);
        batch = '';
      }
    }
  });
  emit(batch);
  return write ? { rows, since } : { csv: chunks.join(''), rows, since };
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {DailyUsage[]}
 */
function getDailyUsage(store, days = 90, nowMs = Date.now()) {
  const since = dateKey(nowMs - days * 24 * 60 * 60 * 1000);
  return store.prepare(`
      SELECT source_id AS sourceId, usage_date AS date, tokens
      FROM account_daily_usage
      WHERE usage_date >= ?
      ORDER BY usage_date ASC, source_id ASC
    `).all(since);
}

// Fable 5 and Fable 5.1 draw on one allowance; this splits this device's
// Fable activity in the current Fable window by version, with what those
// tokens are worth at today's API prices. Only tokens and money are split:
// the provider reports one percentage for both.
/**
 * @param {import('../store.cjs').Store} store
 * @returns {FableActivity}
 */
function getFableActivity(store, fableQuota, settings = store.getSettings(), nowMs = Date.now()) {
  const resetMs = Date.parse(fableQuota?.resetsAt ?? '');
  const throughMs = nowMs;
  const sinceMs = Number.isFinite(resetMs) && resetMs > nowMs ? resetMs - 7 * DAY_MS : nowMs - 7 * DAY_MS;
  const rate = Number(settings.usdToCurrency || 1);
  const rows = store.prepare(`
      SELECT model, COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
        -- A row from before the five-minute/one-hour split counts as five-minute
        -- writes, row by row, as Costs does; summing first would lose it.
        COALESCE(SUM(CASE WHEN cache_write_5m_input_tokens + cache_write_1h_input_tokens = 0
          THEN cache_write_input_tokens ELSE cache_write_5m_input_tokens END), 0) AS cache_write_5m_input_tokens,
        COALESCE(SUM(cache_write_1h_input_tokens), 0) AS cache_write_1h_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM usage_events
      WHERE source_id = 'claude' AND occurred_at >= ? AND occurred_at <= ?
        AND LOWER(COALESCE(model, '')) LIKE '%fable%'
      GROUP BY model
    `).all(iso(sinceMs), iso(throughMs));
  const models = rows.map((row) => {
    const cost = store.calculateCost({ ...row, source_id: 'claude' });
    return {
      model: String(row.model),
      requests: Number(row.requests || 0),
      totalTokens: Number(row.input_tokens || 0) + Number(row.cached_input_tokens || 0)
        + Number(row.cache_write_input_tokens || 0) + Number(row.output_tokens || 0),
      cacheReadTokens: Number(row.cached_input_tokens || 0),
      cost: round(cost.actualUsd * rate, 4),
      covered: cost.covered,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
  return { since: iso(sinceMs), through: iso(throughMs), currency: settings.currency, models };
}

module.exports = {
  getCostAnalytics, analyticsRevision, getAnalytics, buildCostAnalytics, getSessionPage, getTaskPage, analyticsEvents,
  buildAnalytics, exportLedgerCsv, getDailyUsage, getFableActivity,
};
