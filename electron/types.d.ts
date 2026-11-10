// Shapes the main process passes around, written once. The files in electron/
// are JavaScript; they name these in JSDoc comments, as
// `import('./types').ObservationRow`. What the renderer receives is declared in
// src/types.ts and is re-exported here so both sides read the same definition.

export type {
  AllowanceChange, ClaudeExtraUsage, CostAnalytics, CycleRow, DailyUsage, DashboardVerdict, FableActivity, Forecast,
  ForecastState, Point, PriceRow, Quota, QuotaWindow, SessionCost, SessionPage, Settings, SharedPool, SharedPoolApplied,
  Snapshot, Source, TaskCost, TaskPage, TokenCapacityEstimate, DesktopEstimates, ModelCost, RestoreCounts,
  SessionPageOptions, UpdateStatus,
} from '../src/types';

import type { Snapshot } from '../src/types';

/** The handle on the database: electron/store.cjs. */
export type Store = import('./store.cjs').Store;

type StatementSync = import('node:sqlite').StatementSync;
type SqlValue = import('node:sqlite').SQLInputValue;
type StatementResult = { changes: number; lastInsertRowid: number };

/**
 * A prepared statement as the store hands it out. The store never asks SQLite
 * for big integers, so a write reports its row count as a number.
 */
export type Statement = Omit<StatementSync, 'run'> & {
  run(...anonymousParameters: SqlValue[]): StatementResult;
  run(namedParameters: Record<string, SqlValue>, ...anonymousParameters: SqlValue[]): StatementResult;
};

/** A subscription as the database and the collectors name it: an id in electron/providers.mjs. */
export type SourceId = import('./providers.mjs').ProviderId;

/** A time as SQLite stores it: an ISO 8601 string in UTC. */
export type IsoTime = string;

/** A time as arithmetic uses it: milliseconds since the epoch. */
export type Ms = number;

// ---- Rows, as SELECT * returns them ----

/** quota_observations: one allowance reading. */
export type ObservationRow = {
  id?: number;
  source_id: string;
  bucket_id: string;
  bucket_name: string | null;
  observed_at: IsoTime;
  used_percent: number;
  remaining_percent: number;
  resets_at: IsoTime;
  window_minutes: number | null;
  plan_type: string | null;
  provenance: string;
  confidence: number;
  metadata_json: string;
  /** The earliest moment a status-line reading's limits can have been fetched. */
  fetched_after?: IsoTime | null;
  /** The first redraw in which its session showed the same limits. */
  seen_since?: IsoTime | null;
};

/**
 * A point of the projected Fable estimate, shaped like a row so the forecast
 * can learn from it. It is already expressed in the current allowance.
 */
export type ProjectedObservationRow = ObservationRow & { allowance_scaled?: boolean };

/** usage_events: the tokens of one request. */
export type UsageEventRow = {
  id?: number;
  event_key: string;
  source_id: string;
  occurred_at: IsoTime;
  session_id: string | null;
  model: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  cache_write_5m_input_tokens: number;
  cache_write_1h_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  reported_cost_usd: number | null;
  metadata_json: string;
  project: string | null;
};

/** sources: one row per subscription, with what its collector last reported. */
export type SourceRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  status_detail: string | null;
  last_observation_at: IsoTime | null;
  last_attempt_at: IsoTime | null;
  last_success_at: IsoTime | null;
  metadata_json: string;
};

/** price_catalog: USD per million tokens for one model. */
export type PriceCatalogRow = {
  model: string;
  input_usd_per_million: number;
  cache_write_usd_per_million: number;
  cache_write_1h_usd_per_million: number;
  cache_read_usd_per_million: number;
  output_usd_per_million: number;
  effective_from: string;
  source_url: string | null;
  is_seed: number;
};

/** imported_files: how far a transcript or session log has been read. */
export type ImportedFileRow = {
  file_path: string;
  modified_ms: number;
  size_bytes: number;
  imported_at: IsoTime;
  state_json: string | null;
};

/** account_daily_usage. */
export type DailyUsageRow = { source_id: string; usage_date: string; tokens: number };

/** backups. An export too large to write leaves export_path empty. */
export type BackupRow = { id: number; created_at: IsoTime; database_path: string; export_path: string };

/** desktop_chat_estimates: one imported Claude desktop or web reply. */
export type DesktopEstimateRow = {
  event_key: string;
  occurred_at: IsoTime;
  model: string | null;
  model_origin: string;
  input_tokens: number;
  output_tokens: number;
  excluded_content: number;
  input_missing: number;
  method: string;
};

/** statusline_sessions: what a Claude Code session's status line last showed. */
export type StatuslineSessionRow = {
  session_id: string;
  seen_at: IsoTime;
  api_ms: number | null;
  limits_json: string;
  fetched_after: IsoTime | null;
  seen_since: IsoTime | null;
};

// ---- What the collectors hand the store ----

/** The argument of store.recordObservation. */
export type ObservationInput = {
  sourceId: string;
  bucketId: string;
  bucketName?: string | null;
  observedAt: IsoTime;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: IsoTime;
  windowMinutes?: number | null;
  planType?: string | null;
  provenance?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown> | null;
  fetchedAfter?: IsoTime | null;
  seenSince?: IsoTime | null;
};

/** The argument of store.recordUsageEvent. */
export type UsageEventInput = {
  eventKey: string;
  sourceId: string;
  occurredAt: IsoTime;
  sessionId?: string | null;
  model?: string | null;
  project?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  reportedCostUsd?: number | null;
  metadata?: Record<string, unknown> | null;
};

// ---- The forecast ----

/** The hours and weekdays a person expects to be working. */
export type Schedule = { activeDays: number[]; startHour: number; endHour: number };

/**
 * A reading with its times as numbers, as quota-evidence.cjs's normaliseObservation
 * returns it. A reading may arrive either as a row or already in this shape.
 */
export type Reading = {
  observedAt: Ms;
  fetchedAfter: Ms | null;
  seenSince: Ms | null;
  resetsAt: Ms;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  provenance: string;
  resetEvidence: boolean;
  sourceId: string | undefined;
  bucketId: string | undefined;
  allowanceScaled: boolean;
};

/** Either form a reading is accepted in. */
export type ReadingLike = ObservationRow | Reading | Record<string, any>;

// ---- Snapshots ----

/** What the tray, the flyout and notifications are drawn from. */
export type TraySnapshot = Pick<
  Snapshot,
  'generatedAt' | 'timezone' | 'settings' | 'sources' | 'quotas' | 'fableApplies' | 'dashboardVerdict' | 'resetCredits'
>;
