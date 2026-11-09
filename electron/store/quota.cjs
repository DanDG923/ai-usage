'use strict';

// Reading allowances back: the windows of a source with their forecasts,
// the projected Fable estimate and token capacity, each cached by revision.

/** @typedef {import('../../src/types').Quota} Quota */
/** @typedef {import('../../src/types').QuotaWindow} QuotaWindow */
/** @typedef {import('../../src/types').Settings} Settings */
/** @typedef {import('../../src/types').Forecast} Forecast */
/** @typedef {import('../../src/types').TokenCapacityEstimate} TokenCapacityEstimate */
/** @typedef {import('../types').ObservationRow} ObservationRow */
/** @typedef {import('../types').IsoTime} IsoTime */
/** @typedef {import('../types').Ms} Ms */
/** @typedef {Omit<QuotaWindow, 'forecast'>} WindowReading A window's latest reading, before it is forecast. */
/**
 * What every window of one source is forecast with.
 * @typedef {object} ForecastOptions
 * @property {Ms} now
 * @property {import('../types').Schedule} schedule
 * @property {number} fallbackRate
 * @property {number} paceRiskThreshold
 * @property {number} hardLimitThreshold
 * @property {number} reservePercent
 * @property {string[]} excludedDates
 * @property {import('../types').AllowanceChange[]} allowanceChanges
 * @property {number} freshReadGraceMs
 * @property {string} sourceId
 */
/** @typedef {import('../token-capacity.cjs').TokenEventRow} TokenEventRow */
/**
 * One source's recent token history, with the revision and times it holds for.
 * @typedef {{ rows: TokenEventRow[], revision: number, evaluatedAt: Ms, expiresAt: Ms }} TokenEvidence
 */

const { isOfficialWindow, selectDisplayedWindows } = require('../quota-selection.cjs');
const { FABLE_BUCKET, FABLE_BUCKET_NAME, projectFableAllowance } = require('../fable-projection.cjs');
const { codexQuotaLabel } = require('../codex-quota-label.cjs');
const { CLAUDE, CODEX, FABLE, ledgerSourceOf } = require('../providers.mjs');
const { forecastQuota, freshReadGraceFor, latestEvidenceAt, normaliseObservation, prepareObservation, withoutStaleRestatements } = require('../forecast.cjs');
const { estimateTokenCapacity, LOOKBACK_MS: TOKEN_CAPACITY_LOOKBACK_MS, STALENESS_MS: TOKEN_CAPACITY_STALENESS_MS } = require('../token-capacity.cjs');
const { QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS, validQuotaTime } = require('../quota-time.cjs');
const { LEGACY_FABLE_BUCKET_NAME, iso, quotaMetadata, QUARTER_HOUR_MS } = require('./shared.cjs');

// Claude dropped the 5-hour limit for verified Ultra (formerly Max 20x)
// accounts. A Refresh or a status-line reading records every window it
// carries at one instant, so one that carries the weekly window but no 5-hour
// window, fetched after the latest 5-hour figure, shows that window has ended:
// it must not stay on the card, or drive warnings, until its old reset. A
// later reading that carries one again (an account not yet verified) is newer
// than the omission and brings it back. A status-line figure was fetched no
// later than its session's first redraw of it; a redraw only omits after its
// recorded fetch, so an undated one, or a manual weekly entry, omits nothing.
// The omission must follow every kept 5-hour reading, not only the last: an
// older redraw that agrees with a newer Refresh is kept after it, and an
// omission between the two must not hide the window that Refresh confirmed.
const CLAUDE_SESSION_BUCKET = 'five_hour';
const OMITTING_PROVENANCES = new Set(['official-claude-usage', 'official-statusline']);
/**
 * @param {ObservationRow[] | undefined} sessionRows The 5-hour bucket's kept readings, oldest first.
 * @param {ObservationRow[]} rows Every usable reading of the source.
 * @param {Ms} nowMs
 */
function sessionWindowOmitted(sessionRows, rows, nowMs) {
  // On the casts below: a list with a length has a last row, `latest` is only
  // set when there are session rows, and Number.isFinite is false for null,
  // so a time that passed it is a number.
  const latest = sessionRows?.length ? normaliseObservation(/** @type {ObservationRow} */ (sessionRows.at(-1))) : null;
  if (!latest || !(latest.resetsAt > nowMs)) return false;
  const fetchedBy = /** @type {ObservationRow[]} */ (sessionRows).reduce((newest, row) => {
    const reading = normaliseObservation(row);
    return Math.max(newest, reading.provenance === 'official-statusline' && Number.isFinite(reading.seenSince)
      ? Math.min(/** @type {number} */ (reading.seenSince), reading.observedAt) : reading.observedAt);
  }, -Infinity);
  const carried = new Set(rows.filter((row) => row.bucket_id === CLAUDE_SESSION_BUCKET)
    .map((row) => Date.parse(row.observed_at)));
  return rows.some((row) => {
    if (row.bucket_id !== 'seven_day' || !OMITTING_PROVENANCES.has(row.provenance)) return false;
    const reading = normaliseObservation(row);
    if (carried.has(reading.observedAt)) return false;
    const fetchedAfter = reading.provenance === 'official-statusline' ? reading.fetchedAfter : reading.observedAt;
    return Number.isFinite(fetchedAfter) && /** @type {number} */ (fetchedAfter) >= fetchedBy;
  });
}

// Forecasting reads a bounded window of recent polls, plus each bucket's
// latest row so a dormant bucket still surfaces as expired rather than
// vanishing. The full history stays in the table for cycle history and
// backups; it is simply not re-forecast on every snapshot.
// `tokenCapacity: false` skips the capacity estimate, which only the
// dashboard shows; the tray and notifications never read it.
/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @param {Settings} [settings]
 * @param {Ms} [nowMs]
 * @param {{ tokenCapacity?: boolean }} [options]
 * @returns {Quota | null}
 */
function getQuota(store, sourceId, settings = store.getSettings(), nowMs = Date.now(), { tokenCapacity = true } = {}) {
  const latestAllowed = iso(nowMs + QUOTA_CLOCK_SKEW_MS);
  const oldestRecent = iso(nowMs - FORECAST_LOOKBACK_MS);
  // Capture revisions before reading rows: a concurrent collector commit can
  // invalidate this result, but can never label old rows with a new revision.
  const quotaRevision = /** @type {{ value: number }} */ (
    store.prepare("SELECT COALESCE(SUM(revision), 0) AS value FROM analytics_revisions WHERE domain = 'quota' AND source_id = ?").get(sourceId)).value;
  /** @param {ObservationRow} row */
  const usable = (row) => {
    const parsed = normaliseObservation(row);
    return validQuotaTime(parsed.observedAt, parsed.resetsAt, row.window_minutes, nowMs);
  };
  const batch = Math.floor(nowMs / 900_000) * 900_000;
  const cached = !store.db.isTransaction ? store.quotaRowsCache.get(sourceId) : null;
  /** @type {ObservationRow[]} */
  let candidates;
  if (cached?.revision === quotaRevision && cached.batch === batch) {
    candidates = cached.rows;
  } else {
    candidates = /** @type {ObservationRow[]} */ (store.prepare(`
        SELECT * FROM quota_observations WHERE source_id = ? AND observed_at >= ? AND observed_at <= ?
        UNION
        SELECT q.* FROM (SELECT DISTINCT bucket_id FROM quota_observations WHERE source_id = ?) buckets
        JOIN quota_observations q ON q.id = (
          SELECT id FROM quota_observations WHERE source_id = ? AND bucket_id = buckets.bucket_id AND observed_at <= ?
          ORDER BY observed_at DESC, id DESC LIMIT 1)
        ORDER BY observed_at, id
      `).all(sourceId, iso(batch - FORECAST_LOOKBACK_MS), iso(batch + 900_000 + QUOTA_CLOCK_SKEW_MS),
      sourceId, sourceId, latestAllowed)).map(prepareObservation);
    if (!store.db.isTransaction) store.quotaRowsCache.set(sourceId, { rows: candidates, revision: quotaRevision, batch });
  }
  // Recheck persisted rows before selecting current card data or forecasting.
  // Older app versions could store dates and windows now rejected on ingest.
  const rows = candidates.filter(usable);
  const presentBuckets = new Set(rows.map((row) => row.bucket_id));
  const missingBuckets = new Set(candidates.filter((row) => !presentBuckets.has(row.bucket_id)).map((row) => row.bucket_id));
  for (const bucketId of missingBuckets) {
    // A malformed latest row must not hide valid dormant history. Only these
    // buckets need an indexed, lazy search beyond the usual learning horizon.
    for (const row of /** @type {IterableIterator<ObservationRow>} */ (store.prepare(`
        SELECT * FROM quota_observations
        WHERE source_id = ? AND bucket_id = ? AND observed_at < ?
        ORDER BY observed_at DESC, id DESC
      `).iterate(sourceId, bucketId, oldestRecent))) {
      if (usable(row)) { rows.push(row); break; }
    }
  }
  // Fable may have no stored rows and still have a projected estimate.
  if (!rows.length && sourceId !== FABLE.id) return null;

  /** @type {Map<string, ObservationRow[]>} */
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.bucket_id)) grouped.set(row.bucket_id, []);
    // The line above put a list there if there was none.
    /** @type {ObservationRow[]} */ (grouped.get(row.bucket_id)).push(row);
  }
  // A stale status-line restatement must not become the card's current
  // balance, a forecast reading or a token-capacity interval. Readings are
  // compared in the allowance in force now, as the forecast compares them,
  // or one taken after a recorded change is held back for being lower than
  // a read of the old allowance.
  const restatementOptions = { nowMs, freshReadGraceMs: freshReadGraceFor(settings), allowanceChanges: settings.allowanceChanges, sourceId };
  for (const [bucketId, bucketRows] of grouped) {
    grouped.set(bucketId, withoutStaleRestatements(bucketRows, restatementOptions));
  }
  if (sourceId === CLAUDE.id && sessionWindowOmitted(grouped.get(CLAUDE_SESSION_BUCKET), rows, nowMs)) {
    grouped.delete(CLAUDE_SESSION_BUCKET);
  }
  const schedule = {
    activeDays: settings.activeDays,
    startHour: settings.activeStartHour,
    endHour: settings.activeEndHour,
  };
  /** @type {ForecastOptions} */
  const forecastOptions = {
    now: nowMs,
    schedule,
    fallbackRate: settings.forecastFallbackRate,
    paceRiskThreshold: settings.paceRiskThreshold,
    hardLimitThreshold: settings.hardLimitThreshold,
    reservePercent: settings.reservePercent,
    excludedDates: settings.forecastExcludedDates,
    allowanceChanges: settings.allowanceChanges,
    freshReadGraceMs: restatementOptions.freshReadGraceMs,
    sourceId,
  };
  const readings = [...grouped.entries()].map(([bucketId, observations]) => {
    // A bucket is grouped from at least one row, and its first is always kept.
    const latest = /** @type {ObservationRow} */ (observations.at(-1));
    // Old backups may already have persisted invalid metadata; keep the
    // reading usable without rewriting the original historical evidence.
    const metadata = quotaMetadata(latest.metadata_json) || {};
    return {
      bucketId,
      bucketName: sourceId === CODEX.id
        ? codexQuotaLabel(latest.bucket_name || bucketId, latest.window_minutes, metadata)
        : sourceId === FABLE.id && latest.bucket_name === LEGACY_FABLE_BUCKET_NAME
          ? FABLE_BUCKET_NAME
          : latest.bucket_name || bucketId,
      observedAt: latest.observed_at,
      // When this value was last known to hold. A status-line redraw is
      // recorded now but may carry limits its session fetched hours ago.
      // Readings agree in the allowance in force now, as the forecast's do.
      evidenceAt: iso(/** @type {number} */ (latestEvidenceAt(observations, { ...restatementOptions, known: true }))),
      usedPercent: latest.used_percent,
      remainingPercent: latest.remaining_percent,
      resetsAt: latest.resets_at,
      windowMinutes: latest.window_minutes,
      planType: latest.plan_type,
      provenance: latest.provenance,
      metadata,
    };
  });
  // Decide replacement from every window before omitting any forecast: a
  // live provider window in an alternate Fable bucket can prevent projection.
  const projected = sourceId === FABLE.id
    ? store.projectedFableWindow(readings, grouped.get(FABLE_BUCKET) || [], settings, forecastOptions, nowMs, tokenCapacity)
    : null;
  // Each reading was built from a bucket of `grouped`, so its rows are there.
  /** @type {QuotaWindow[]} */
  const windows = readings.filter((window) => !projected || window.bucketId !== FABLE_BUCKET).map((window) => ({
    ...window,
    forecast: store.learnedForecast(sourceId, window.bucketId, /** @type {ObservationRow[]} */ (grouped.get(window.bucketId)), forecastOptions, quotaRevision),
    tokenCapacity: tokenCapacity && Number(window.windowMinutes) === 10_080
      ? store.getTokenCapacity(sourceId, window.bucketId, /** @type {ObservationRow[]} */ (grouped.get(window.bucketId)), settings, nowMs, quotaRevision)
      : null,
  }));
  if (projected) windows.push(projected);
  if (!windows.length) return null;
  // The shared rule orders the windows and names the headline, so the tray,
  // notifications, cycle history and cards follow the same window as the
  // top-level fields here even when every window was recorded in one scan.
  const selection = selectDisplayedWindows(windows, { nowMs });
  // There is at least one window, so the selection names a headline.
  return { .../** @type {QuotaWindow} */ (selection.primary), windows: [...selection.active, ...selection.expired] };
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @param {string} bucketId
 * @param {ObservationRow[]} observations
 * @param {ForecastOptions} options
 * @param {number} revision The quota revision the observations were read at.
 * @returns {Forecast}
 */
function learnedForecast(store, sourceId, bucketId, observations, options, revision) {
  const { now, ...modelOptions } = options;
  const key = JSON.stringify([sourceId, bucketId, modelOptions,
    (options.allowanceChanges || []).filter((change) => Date.parse(change.at) <= now).length]);
  let cached = !store.db.isTransaction ? store.forecastModelCache.get(key) : null;
  if (!cached || cached.revision !== revision) {
    cached = { revision, models: new Map() };
    if (!store.db.isTransaction) {
      store.forecastModelCache.set(key, cached);
      if (store.forecastModelCache.size > 64) store.forecastModelCache.delete(store.forecastModelCache.keys().next().value);
    }
  }
  return forecastQuota(observations, { ...options, learningCache: cached.models, compactReadings: true });
}

// The Fable estimate as a window: built from the projection when no
// provider-backed Fable window is live, never stored. The forecast learns
// from the official rows plus the projection's own series, in the same row
// shape, so a helper-only machine keeps a learned pace without persisting
// estimates that would outlive the settings they were computed under.
/**
 * @param {import('../store.cjs').Store} store
 * @param {WindowReading[]} windows
 * @param {ObservationRow[]} bucketRows
 * @param {Settings} settings
 * @param {ForecastOptions} forecastOptions
 * @param {Ms} nowMs
 * @param {boolean} [includeTokenCapacity]
 * @returns {QuotaWindow | null}
 */
function projectedFableWindow(store, windows, bucketRows, settings, forecastOptions, nowMs, includeTokenCapacity = true) {
  const current = selectDisplayedWindows(windows, { nowMs }).primary;
  if (current && Date.parse(String(current.resetsAt)) > nowMs && isOfficialWindow(current)) return null;
  const projection = store.getFableProjection(settings, nowMs);
  if (!projection.available) return null;
  /**
   * @param {{ observedAt: IsoTime, usedPercent: number }} entry
   * @returns {import('../types').ProjectedObservationRow}
   */
  const point = (entry) => ({
    source_id: FABLE.id, bucket_id: FABLE_BUCKET, bucket_name: FABLE_BUCKET_NAME,
    observed_at: entry.observedAt, used_percent: entry.usedPercent, remaining_percent: 100 - entry.usedPercent,
    resets_at: projection.resetsAt, window_minutes: projection.windowMinutes, plan_type: projection.planType,
    provenance: 'derived-tokens', confidence: projection.confidence, metadata_json: '{}',
    // Already expressed in the current allowance by the projection.
    allowance_scaled: true,
  });
  const forecast = forecastQuota([...bucketRows, ...projection.series.map(point)], forecastOptions);
  return {
    bucketId: FABLE_BUCKET,
    bucketName: FABLE_BUCKET_NAME,
    observedAt: iso(nowMs),
    usedPercent: projection.usedPercent,
    remainingPercent: 100 - projection.usedPercent,
    resetsAt: projection.resetsAt,
    windowMinutes: projection.windowMinutes,
    planType: projection.planType,
    provenance: 'derived-tokens',
    metadata: { sharedWithOverall: true, projected: true, calibration: projection.calibration },
    forecast,
    tokenCapacity: includeTokenCapacity ? store.getTokenCapacity(FABLE.id, FABLE_BUCKET, bucketRows, settings, nowMs) : null,
  };
}

// Cached like token capacity: the inputs are Claude and Fable readings,
// Claude usage and the allowance-change setting, all of which bump a
// revision or change the key. The tail grows with wall time, so a value is
// good for a minute and never past the window reset or a pending change.
/**
 * @param {import('../store.cjs').Store} store
 * @param {Settings} settings
 * @param {Ms} nowMs
 * @returns {import('../fable-projection.cjs').FableProjection}
 */
function getFableProjection(store, settings, nowMs) {
  const projectionOptions = { freshReadGraceMs: freshReadGraceFor(settings) };
  if (store.db.isTransaction) return projectFableAllowance(store, nowMs, projectionOptions);
  const revision = /** @type {{ value: number }} */ (store.prepare(`SELECT COALESCE(SUM(revision), 0) AS value FROM analytics_revisions
      WHERE (domain = 'quota' AND source_id IN ('claude', 'claude-fable')) OR (domain = 'usage' AND source_id = 'claude')`).get()).value;
  const allowanceChanges = settings.allowanceChanges || [];
  const key = JSON.stringify([allowanceChanges, projectionOptions.freshReadGraceMs]);
  const cached = store.fableProjectionCache;
  if (cached && cached.revision === revision && cached.key === key && nowMs >= cached.evaluatedAt && nowMs < cached.expiresAt) return cached.value;
  const value = projectFableAllowance(store, nowMs, projectionOptions);
  let expiresAt = nowMs + 60_000;
  if (value.available) expiresAt = Math.min(expiresAt, Date.parse(String(value.resetsAt)));
  for (const change of allowanceChanges) {
    const at = Date.parse(change.at);
    if (at > nowMs) expiresAt = Math.min(expiresAt, at);
  }
  // A future-dated event or reading is already in the revision but not yet
  // in the projection; it enters at its own timestamp without a write.
  const now = iso(nowMs);
  for (const row of /** @type {({ at: IsoTime } | undefined)[]} */ ([
    store.prepare("SELECT occurred_at AS at FROM usage_events WHERE source_id = 'claude' AND occurred_at > ? ORDER BY occurred_at ASC LIMIT 1").get(now),
    store.prepare("SELECT observed_at AS at FROM quota_observations WHERE source_id IN ('claude', 'claude-fable') AND observed_at > ? ORDER BY observed_at ASC LIMIT 1").get(now),
  ])) {
    const at = row ? Date.parse(row.at) : Number.NaN;
    if (Number.isFinite(at) && at > nowMs) expiresAt = Math.min(expiresAt, at);
  }
  store.fableProjectionCache = { value, revision, key, evaluatedAt: nowMs, expiresAt };
  return value;
}

// Collector status text only needs to know whether a source has a usable
// reading at all and, with `activeWithinMs`, whether one is still running
// and was taken recently. getQuota answers that too, but forecasts every
// window of the source on the way past; this is an indexed probe that
// walks newest-first and stops at the first usable row, or at the first
// row older than the freshness bound, since everything after it is older.
// For active windows, only each bucket's latest usable reading counts:
// a corrected reset must supersede an older, apparently still-active one.
/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @param {Ms} [nowMs]
 * @param {{ activeWithinMs?: number | null }} [options]
 * @returns {boolean}
 */
function hasUsableObservation(store, sourceId, nowMs = Date.now(), { activeWithinMs = /** @type {number | null} */ (null) } = {}) {
  const rows = /** @type {IterableIterator<Pick<ObservationRow, 'bucket_id' | 'observed_at' | 'resets_at' | 'window_minutes'>>} */ (
    store.prepare(`SELECT bucket_id, observed_at, resets_at, window_minutes FROM quota_observations
      WHERE source_id = ? AND observed_at <= ? ORDER BY observed_at DESC, id DESC`)
    .iterate(sourceId, iso(nowMs + QUOTA_CLOCK_SKEW_MS)));
  const seenBuckets = new Set();
  for (const row of rows) {
    const observedMs = Date.parse(row.observed_at);
    const resetMs = Date.parse(row.resets_at);
    if (!validQuotaTime(observedMs, resetMs, row.window_minutes, nowMs)) continue;
    if (activeWithinMs == null) return true;
    if (nowMs - observedMs >= activeWithinMs) return false;
    if (seenBuckets.has(row.bucket_id)) continue;
    seenBuckets.add(row.bucket_id);
    if (resetMs > nowMs) return true;
  }
  return false;
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @param {Ms} nowMs
 * @returns {TokenEvidence}
 */
function tokenCapacityEvidence(store, sourceId, nowMs) {
  // Claude and Fable share the same local ledger. Read each source's bounded
  // token history once, independent of API prices and the selected Costs period.
  const revision = /** @type {{ value: number }} */ (store.prepare(`SELECT COALESCE(SUM(revision), 0) AS value
      FROM analytics_revisions WHERE domain = 'usage' AND source_id = ?`).get(sourceId)).value;
  const cached = !store.db.isTransaction ? store.tokenCapacityEvidenceCache.get(sourceId) : null;
  if (cached && cached.revision === revision && nowMs >= cached.evaluatedAt && nowMs < cached.expiresAt) return cached;
  // The lower bound moves in quarter hours, not with every event ageing out.
  // The estimator applies its own horizon to these rows, so the few minutes
  // of older rows this keeps change no result.
  const since = Math.floor((nowMs - TOKEN_CAPACITY_LOOKBACK_MS) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  const rows = /** @type {TokenEventRow[]} */ (store.prepare(`SELECT source_id, occurred_at, model,
      input_tokens, cached_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_output_tokens
      FROM usage_events WHERE source_id = ? AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at`).all(sourceId, iso(since), iso(nowMs)));
  const next = /** @type {{ at: IsoTime | null }} */ (store.prepare(`SELECT MIN(occurred_at) AS at FROM usage_events
      WHERE source_id = ? AND occurred_at > ?`).get(sourceId, iso(nowMs))).at;
  // Writes bump the usage revision (triggers cover every connection), so the
  // only time-driven changes are the quarter-hour lower bound passing the
  // oldest row and a future-dated row arriving. No wall-clock cap is needed.
  const oldest = rows.length ? Date.parse(rows[0].occurred_at) : Infinity;
  const expiresAt = Math.min(TOKEN_CAPACITY_LOOKBACK_MS + (Math.floor(oldest / QUARTER_HOUR_MS) + 1) * QUARTER_HOUR_MS,
    next ? Date.parse(next) : Infinity);
  const result = { rows, revision, evaluatedAt: nowMs, expiresAt };
  if (!store.db.isTransaction) store.tokenCapacityEvidenceCache.set(sourceId, result);
  return result;
}

/**
 * @param {import('../store.cjs').Store} store
 * @param {string} sourceId
 * @param {string} bucketId
 * @param {ObservationRow[]} observations
 * @param {Settings} settings
 * @param {Ms} nowMs
 * @param {number | null} [capturedQuotaRevision]
 * @returns {TokenCapacityEstimate}
 */
function getTokenCapacity(store, sourceId, bucketId, observations, settings, nowMs, capturedQuotaRevision = /** @type {number | null} */ (null)) {
  const ledgerSource = ledgerSourceOf(sourceId);
  const evidence = store.tokenCapacityEvidence(ledgerSource, nowMs);
  const quotaRevision = capturedQuotaRevision ?? /** @type {{ value: number }} */ (store.prepare(`SELECT COALESCE(SUM(revision), 0) AS value
      FROM analytics_revisions WHERE domain = 'quota' AND source_id = ?`).get(sourceId)).value;
  const excludedDates = settings.forecastExcludedDates || [];
  const allowanceChanges = settings.allowanceChanges || [];
  const key = JSON.stringify([sourceId, bucketId]);
  // Both learning settings change the estimate without touching a revision.
  // So does the set of readings: a held-back status-line reading is let in
  // once the provider has been silent past the grace, with nothing written.
  const exclusions = JSON.stringify([excludedDates, allowanceChanges, observations.map((row) => row.id ?? row.observed_at)]);
  const cached = !store.db.isTransaction ? store.tokenCapacityCache.get(key) : null;
  if (cached && cached.usageRevision === evidence.revision && cached.quotaRevision === quotaRevision
    && cached.exclusions === exclusions && nowMs >= cached.evaluatedAt && nowMs < cached.expiresAt) return cached.value;

  const value = estimateTokenCapacity({ sourceId, bucketId, observations, events: evidence.rows, nowMs, excludedDates, allowanceChanges });
  let expiresAt = evidence.expiresAt;
  // Clock skew permits a change a few minutes ahead. It starts applying at
  // that instant even when neither observations nor settings are rewritten.
  for (const change of allowanceChanges) {
    const at = Date.parse(change.at);
    if (at > nowMs) expiresAt = Math.min(expiresAt, at);
  }
  // Time can change eligibility without a write: future readings arrive,
  // history leaves the learning horizon, and current allowance expires.
  for (const row of observations) {
    const observed = Date.parse(row.observed_at);
    for (const boundary of [observed, observed + TOKEN_CAPACITY_LOOKBACK_MS + 1, Date.parse(row.resets_at)]) {
      if (Number.isFinite(boundary) && boundary > nowMs) expiresAt = Math.min(expiresAt, boundary);
    }
  }
  if (value.remainingAsOf) {
    expiresAt = Math.min(expiresAt, Date.parse(value.remainingAsOf) + TOKEN_CAPACITY_STALENESS_MS + 1);
  }
  if (!store.db.isTransaction) {
    // Bucket names are provider-controlled; stale buckets need not retain
    // unbounded cached results for the lifetime of the application.
    if (store.tokenCapacityCache.size >= 64 && !store.tokenCapacityCache.has(key)) store.tokenCapacityCache.delete(store.tokenCapacityCache.keys().next().value);
    store.tokenCapacityCache.set(key, { value, usageRevision: evidence.revision, quotaRevision,
      exclusions, evaluatedAt: nowMs, expiresAt });
  }
  return value;
}

module.exports = {
  getQuota, learnedForecast, projectedFableWindow, getFableProjection, hasUsableObservation, tokenCapacityEvidence,
  getTokenCapacity,
};
