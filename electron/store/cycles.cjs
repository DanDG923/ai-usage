'use strict';

// Reset-cycle history: what each past allowance window peaked at and what
// its tokens are worth today.

const { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS } = require('../quota-time.cjs');
const { CONTEXT_TIER_SQL } = require('./pricing.cjs');
const { iso, round } = require('./shared.cjs');

function cycleRevision(store, sourceId, bucketId) {
  const eventSource = sourceId === 'codex' ? 'codex' : 'claude';
  return store.prepare(`SELECT COALESCE(SUM(revision), 0) AS revision FROM analytics_revisions
      WHERE domain = 'price' OR (domain = 'usage' AND source_id = ?)
        OR (domain = 'quota' AND source_id = ? AND bucket_id = ?)`)
    .get(eventSource, sourceId, bucketId).revision;
}

// One row per past allowance window of a source's primary bucket: when it
// ran, how much of it was used, and what that window's tracked tokens would
// have cost at the current catalogue. Windows are keyed by their reset time.
function getCycleHistory(store, sourceId, quota, settings = store.getSettings(), limit = 8, nowMs = Date.now()) {
  if (!quota) return [];
  if (store.db.isTransaction) return store.buildCycleHistory(sourceId, quota, settings, limit, nowMs);
  const revision = store.cycleRevision(sourceId, quota.bucketId);
  const key = JSON.stringify([sourceId, quota.bucketId, limit, settings.currency, settings.usdToCurrency]);
  const cached = store.cycleHistoryCache.get(key);
  if (cached && cached.revision === revision && nowMs >= cached.at && nowMs < cached.expiresAt) {
    store.cycleHistoryCache.delete(key);
    store.cycleHistoryCache.set(key, cached);
    return cached.value;
  }
  const value = store.buildCycleHistory(sourceId, quota, settings, limit, nowMs);
  const eventSource = sourceId === 'codex' ? 'codex' : 'claude';
  const modelFilter = sourceId === 'claude-fable' ? "AND LOWER(COALESCE(model, '')) LIKE '%fable%'" : '';
  // Current cycles end at now (exclusive). A future-dated imported event
  // enters its cycle one millisecond after its timestamp; a reset also
  // changes the current flag even when no database write occurs.
  const nextEvent = store.prepare(`SELECT occurred_at FROM usage_events
      WHERE source_id = ? AND occurred_at >= ? ${modelFilter}
      ORDER BY occurred_at ASC LIMIT 1`).get(eventSource, iso(nowMs));
  // A stored reading dated beyond the clock-skew allowance joins its cycle
  // once the clock comes within that allowance of it.
  const nextReading = store.prepare(`SELECT observed_at FROM quota_observations
      WHERE source_id = ? AND bucket_id = ? AND observed_at > ?
      ORDER BY observed_at ASC LIMIT 1`).get(sourceId, quota.bucketId, iso(nowMs + QUOTA_CLOCK_SKEW_MS));
  const expiresAt = Math.min(nextEvent ? Date.parse(nextEvent.occurred_at) + 1 : Infinity,
    nextReading ? Date.parse(nextReading.observed_at) - QUOTA_CLOCK_SKEW_MS : Infinity,
    ...value.filter((row) => row.current).map((row) => Date.parse(row.resetsAt)));
  store.cycleHistoryCache.delete(key);
  store.cycleHistoryCache.set(key, { at: nowMs, expiresAt, revision, value });
  if (store.cycleHistoryCache.size > 12) store.cycleHistoryCache.delete(store.cycleHistoryCache.keys().next().value);
  return value;
}

function buildCycleHistory(store, sourceId, quota, settings = store.getSettings(), limit = 8, nowMs = Date.now()) {
  if (!quota) return [];
  const bucketId = quota.bucketId;
  const rows = store.prepare(`
      SELECT resets_at, window_minutes, MAX(used_percent) AS peak_used,
        MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at,
        COUNT(*) AS readings
      FROM quota_observations
      WHERE source_id = ? AND bucket_id = ?
        -- The same recheck getQuota applies with validQuotaTime: older app
        -- versions could store dates and windows now rejected on ingest.
        -- Stored times are toISOString() text, so julianday reads them
        -- exactly; rounding to whole milliseconds keeps the bounds exact.
        AND julianday(observed_at) <= julianday(?)
        AND CAST(ROUND((julianday(resets_at) - julianday(observed_at)) * 86400000) AS INTEGER) BETWEEN ? AND ?
        AND (window_minutes IS NULL
          OR (typeof(window_minutes) = 'integer' AND window_minutes BETWEEN 0 AND ?))
      GROUP BY resets_at
      ORDER BY resets_at DESC
    `).iterate(sourceId, bucketId, iso(nowMs + QUOTA_CLOCK_SKEW_MS),
    -QUOTA_CLOCK_SKEW_MS, MAX_QUOTA_RESET_AHEAD_MS, MAX_QUOTA_RESET_AHEAD_MS / 60_000);
  // Before its first use, an idle allowance can roll its reset forward with
  // every poll. Fold those unused readings into the subsequently pinned
  // window as well as merging ordinary sub-minute timestamp jitter.
  // Apply the limit to merged windows, not timestamps: a busy current window
  // can have hundreds of jittered timestamps and must not hide older cycles.
  const merged = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    const resetMs = new Date(row.resets_at).getTime();
    const previousReset = previous ? Date.parse(previous.resets_at) : NaN;
    const previousStart = previousReset - Number(previous?.window_minutes || 10_080) * 60_000;
    const sameDuration = previous && previous.window_minutes === row.window_minutes;
    const idleRoll = sameDuration && row.peak_used === 0 && resetMs < previousReset
      && row.last_observed_at < previous.first_observed_at
      && resetMs > previousStart
      && previousStart >= Date.parse(row.first_observed_at) - QUOTA_CLOCK_SKEW_MS;
    if (sameDuration && (Math.abs(previousReset - resetMs) <= 60_000 || idleRoll)) {
      previous.peak_used = Math.max(previous.peak_used, row.peak_used);
      previous.first_observed_at = row.first_observed_at < previous.first_observed_at ? row.first_observed_at : previous.first_observed_at;
      previous.last_observed_at = row.last_observed_at > previous.last_observed_at ? row.last_observed_at : previous.last_observed_at;
      previous.readings += row.readings;
      continue;
    }
    if (merged.length >= limit) break;
    merged.push({ ...row });
  }
  const rate = Number(settings.usdToCurrency || 1);
  const eventSource = sourceId === 'codex' ? 'codex' : 'claude';
  const modelFilter = sourceId === 'claude-fable' ? "AND LOWER(COALESCE(model, '')) LIKE '%fable%'" : '';
  const windows = merged.slice(0, limit).map((row, index) => {
    const resetMs = new Date(row.resets_at).getTime();
    const windowMinutes = Number(row.window_minutes) > 0 ? Number(row.window_minutes) : 10_080;
    const startMs = resetMs - windowMinutes * 60_000;
    // A replacement cycle can begin before the old scheduled reset (for
    // example after a banked reset credit). The old cycle must stop there,
    // and the half-open intervals assign boundary usage only to the new one.
    const newer = merged[index - 1];
    const newerStart = newer ? Date.parse(newer.resets_at) - Number(newer.window_minutes || 10_080) * 60_000 : Infinity;
    const endMs = Math.min(resetMs, newerStart);
    return {
      row,
      resetMs,
      endMs,
      windowMinutes,
      startIso: iso(startMs),
      endIso: iso(Math.min(endMs, nowMs)),
      usd: 0,
      tokens: 0,
    };
  });
  // One range query covers every window, and each event is costed once and
  // credited to the windows that contain it, instead of one query and a
  // full re-costing per window. Timestamps are normalised ISO strings, so
  // the comparison is the same text comparison the query used.
  if (windows.length) {
    store.withPriceCache(() => {
      for (const window of windows) {
        const events = store.prepare(`SELECT source_id, model,
            ${CONTEXT_TIER_SQL} AS contextTier,
            SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
            SUM(cache_write_input_tokens) AS cache_write_input_tokens,
            SUM(CASE WHEN cache_write_5m_input_tokens + cache_write_1h_input_tokens = 0 THEN cache_write_input_tokens ELSE cache_write_5m_input_tokens END) AS cache_write_5m_input_tokens,
            SUM(cache_write_1h_input_tokens) AS cache_write_1h_input_tokens,
            SUM(output_tokens) AS output_tokens
            FROM usage_events WHERE source_id = ? AND occurred_at >= ? AND occurred_at < ? ${modelFilter}
            GROUP BY model, contextTier`).iterate(eventSource, window.startIso, window.endIso);
        for (const event of events) {
          window.usd += store.calculateCost(event).actualUsd;
          // Codex reports cached input as a subset of input; Claude reports it
          // separately. Same rule as buildCostAnalytics so the two tables agree.
          window.tokens += event.source_id === 'codex'
            ? Number(event.input_tokens) + Number(event.cache_write_input_tokens) + Number(event.output_tokens)
            : Number(event.input_tokens) + Number(event.cached_input_tokens)
              + Number(event.cache_write_input_tokens) + Number(event.output_tokens);
        }
      }
    });
  }
  return windows.map(({ row, endMs, windowMinutes, startIso, usd, tokens }) => ({
    resetsAt: row.resets_at,
    endsAt: iso(endMs),
    startsAt: startIso,
    windowMinutes,
    peakUsedPercent: round(Number(row.peak_used), 1),
    readings: Number(row.readings),
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    current: endMs > nowMs,
    cost: round(usd * rate, 2),
    tokens,
  }));
}

module.exports = { cycleRevision, getCycleHistory, buildCycleHistory };
