export type Point = { at: number; remaining: number };

export type ForecastState = 'safe' | 'watch' | 'risk' | 'critical' | 'unknown';

export type Forecast = {
  state: ForecastState;
  expectedRemaining: number | null;
  heavyRemaining: number | null;
  confidence: number;
  learnedSamples: number;
  learnedDays: number;
  activeHoursLeft: number;
  safePace: number;
  recentPace: number;
  workingPace: number;
  windowPace: number | null;
  paceRatio: number;
  expired?: boolean;
  staleHours?: number;
  estimatedCurrentRemaining?: number | null;
  currentIsEstimated?: boolean;
  /** When the expected projection first reaches zero, if it does before reset. */
  exhaustsAt?: string | null;
  /** When the heavier projection first reaches zero, if it does before reset. */
  heavyExhaustsAt?: string | null;
  reservePercent?: number;
  /** Historical days with reduced influence on the expected forecast after an early reset. */
  resetAdjustment?: { resetAt: string; dates: string[]; weight: number };
  series: { observed: Point[]; expected: Point[]; heavy: Point[] };
};

export type TokenCapacityEstimate = {
  status: 'available' | 'learning' | 'unavailable';
  reason: string | null;
  weeklyTokens: number | null;
  weeklyRange: { low: number; high: number } | null;
  remainingTokens: number | null;
  remainingRange: { low: number; high: number } | null;
  remainingAsOf: string | null;
  confidence: 'low' | 'medium' | 'high';
  intervals: number;
  cycles: number;
  observedPercent: number;
  calibratedAt: string | null;
  modelMix: { model: string; share: number }[];
  tokenMix: { input: number; cacheRead: number; cacheWrite: number; output: number };
  warnings: string[];
};

export type QuotaWindow = {
  bucketId: string;
  bucketName: string;
  observedAt: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string;
  windowMinutes: number | null;
  planType: string | null;
  provenance: string;
  metadata: Record<string, unknown>;
  forecast: Forecast;
  /** Approximate token capacity at the observed workload mix, never a provider token quota. */
  tokenCapacity?: TokenCapacityEstimate | null;
};

export type Quota = QuotaWindow & { windows: QuotaWindow[] };

export type ForecastReason = 'expected-exhaustion' | 'heavy-exhaustion' | 'pace' | 'watch';

export type DashboardVerdictDetail = {
  sourceId: 'codex' | 'claude' | 'fable';
  sourceLabel: string;
  bucketId: string;
  bucketName: string;
  state: ForecastState;
  reasons: ForecastReason[];
  expectedRemaining: number | null;
  heavyRemaining: number | null;
  exhaustsAt: string | null;
  heavyExhaustsAt: string | null;
  paceRatio: number;
};

export type DashboardVerdict = {
  state: ForecastState;
  reason: ForecastReason | 'mixed' | null;
  label: string;
  windowsChecked: number;
  affected: string[];
  details: DashboardVerdictDetail[];
};

export type SourceId = 'codex' | 'claude' | 'claude-fable';

export type Source = {
  id: SourceId;
  name: string;
  kind: string;
  status: string;
  status_detail: string | null;
  last_observation_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  metadata: Record<string, unknown>;
};

export type ModelCost = {
  costBreakdown?: { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number };
  costShare?: number | null;
  sourceId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cost: number;
  coverage: number;
};

export type ProjectCost = {
  project: string | null;
  cost: number;
  totalTokens: number;
  coverage: number;
  sessionCount: number;
  sources: string[];
  lastActivity: string;
};

export type SessionCost = {
  sourceId: string;
  sessionId: string;
  model: string;
  project: string | null;
  occurredAt: string;
  totalTokens: number;
  cost: number;
  coverage: number;
};

export type SessionPageOptions = {
  days: number;
  query: string;
  page: number;
  pageSize: number;
};

export type SessionPage = {
  rows: SessionCost[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type TaskUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  usageCount: number;
  cost: number;
  coverage: number;
  startedAt: string | null;
  occurredAt: string | null;
  activitySpanMs: number | null;
};

export type TaskAgent = TaskUsageTotals & {
  key: string;
  sessionId: string;
  agentId: string | null;
  agentKind: 'main' | 'subagent' | 'unknown';
  agentName: string | null;
  agentRole: string | null;
  parentSessionId: string | null;
  model: string;
};

export type TaskCost = TaskUsageTotals & {
  key: string;
  sourceId: string;
  sessionId: string;
  taskId: string | null;
  project: string | null;
  subagentCount: number;
  main: TaskUsageTotals;
  subagent: TaskUsageTotals;
  unknown: TaskUsageTotals;
  agents: TaskAgent[];
};

export type TaskPage = Omit<SessionPage, 'rows'> & { rows: TaskCost[] };

export type CostAnalytics = {
  periodDays: number;
  currency: string;
  actual: number;
  withoutCache: number;
  cacheSavings: number;
  cacheSavingsPercent: number;
  totalTokens: number;
  coverage: number;
  isComplete: boolean;
  isLowerBound: boolean;
  unpricedModels: { sourceId: string; model: string; tokens: number }[];
  requestCount: number;
  byModel: ModelCost[];
  byProject: ProjectCost[];
  chart: { date: string; codex: number; claude: number }[];
  sessions: SessionCost[];
  tasks?: TaskCost[];
  /** Seven rows (Sunday first) of 24 hourly API-equivalent values in the display currency. */
  activityGrid?: number[][];
};

export type CycleRow = {
  resetsAt: string;
  /** Actual cycle end when an early reset supersedes the scheduled reset. */
  endsAt?: string;
  startsAt: string;
  windowMinutes: number;
  peakUsedPercent: number;
  readings: number;
  firstObservedAt: string;
  lastObservedAt: string;
  current: boolean;
  cost: number;
  tokens: number;
};

export type DailyUsage = { sourceId: string; date: string; tokens: number };

export type Theme = 'system' | 'dark' | 'light';

/** A main weekly allowance change (including Claude's shared Fable pool); independent windows are unaffected. */
export type AllowanceChange = {
  source: 'claude' | 'codex';
  /** ISO instant of the change, chosen between the last old-allowance reading and the first new one. */
  at: string;
  /** The earlier allowance as a percentage of the one that replaced it, e.g. 150 when a 50% boost ended. */
  previousAllowancePercent: number;
};

export type Settings = {
  showCodexSubscription: boolean;
  showClaudeSubscription: boolean;
  currency: string;
  usdToCurrency: number;
  currencyRates?: Record<string, number>;
  activeDays: number[];
  activeStartHour: number;
  activeEndHour: number;
  forecastFallbackRate: number;
  /** Local calendar dates excluded from forecast learning, with usage history retained. */
  forecastExcludedDates: string[];
  /** Allowance size changes, in time order; learning rescales earlier readings to the current allowance. */
  allowanceChanges: AllowanceChange[];
  paceRiskThreshold: number;
  hardLimitThreshold: number;
  reservePercent: number;
  /** Monthly subscription fees in USD; zero means not set. */
  codexPlanUsdPerMonth: number;
  claudePlanUsdPerMonth: number;
  notifyDesktop: boolean;
  notifyResets: boolean;
  notifyFallback: boolean;
  notifyDigest: boolean;
  digestHour: number;
  alertsSnoozedUntil: string | null;
  launchAtLogin: boolean;
  theme: Theme;
  /** Draw with the CPU instead of the graphics card; applied at the next launch. */
  softwareRendering: boolean;
  autoUpdate: boolean;
  backupFrequency: string;
  backupRetentionCount: number;
  refreshIntervalMinutes: number;
};

export type RestoreCounts = {
  desktopEstimates?: number;
  settings: number;
  observations: number;
  usageEvents: number;
  dailyUsage: number;
  prices: number;
  skipped: number;
};

export type PriceRow = {
  model: string;
  input_usd_per_million: number;
  cache_write_usd_per_million: number;
  cache_write_1h_usd_per_million: number;
  cache_read_usd_per_million: number;
  output_usd_per_million: number;
  effective_from: string;
  source_url: string | null;
};

export type Snapshot = {
  desktopEstimates?: DesktopEstimates;
  generatedAt: string;
  timezone: string;
  settings: Settings;
  sources: Source[];
  quotas: { codex: Quota | null; claude: Quota | null; fable: Quota | null };
  dashboardVerdict: DashboardVerdict;
  resetCredits: number;
  priceCatalog: PriceRow[];
  costs: CostAnalytics;
  cycles: { codex: CycleRow[]; claude: CycleRow[]; fable: CycleRow[] };
  dailyUsage: DailyUsage[];
  storage: { databasePath: string; backupDirectory: string; databaseSize: number };
  isPreview?: boolean;
};

export type ManualObservation = {
  sourceId: SourceId;
  usedPercent: number;
  resetsAt: string;
  observedAt?: string;
  note?: string;
};

export type RenderingMode = {
  /** How this running instance draws; changes apply at the next launch. */
  active: 'software' | 'hardware';
  requested: 'software' | 'hardware';
};

export type UpdateStatus = {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'error'
    | 'unavailable'
    | 'auth-required'
    | 'downloading'
    | 'downloaded'
    | 'installing';
  available: boolean;
  checkedAt?: string | null;
  version?: string | null;
  error?: string | null;
  progress?: number | null;
  releaseNotes?: string | null;
  auth?: 'github-cli' | null;
  reason?: string | null;
};

export type Bridge = {
  reportRendererError?(error: { message: string; componentStack: string }): Promise<void>;
  previewDesktopExport(): Promise<DesktopImportPreview | null>;
  cancelDesktopExport(previewId: string): Promise<void>;
  importDesktopExport(
    previewId: string,
    assumedModel: string | null,
  ): Promise<{
    result: { imported: number; duplicates: number };
    snapshot: Snapshot;
  }>;
  clearDesktopEstimates(): Promise<{ cancelled: boolean; snapshot?: Snapshot }>;
  getClaudeSetup(): Promise<ClaudeSetupStatus>;
  /** The saved dismissal flag alone; unlike getClaudeSetup it runs no Claude command. */
  isClaudeSetupDismissed(): Promise<boolean>;
  configureClaude(
    action: 'install' | 'login' | 'finish' | 'check' | 'skip',
    enableHelper: boolean,
  ): Promise<ClaudeSetupStatus>;
  cancelClaudeSetup(): Promise<void>;
  /** Null while storage is closed for an update; the previous snapshot stays valid. */
  getSnapshot(days?: number): Promise<Snapshot | null>;
  getTasks(options: SessionPageOptions): Promise<TaskPage>;
  getSessions(options: SessionPageOptions): Promise<SessionPage>;
  refresh(): Promise<{
    snapshot?: Snapshot;
    backupError?: string | null;
    collectors: Record<string, { error?: string; warning?: string }>;
  }>;
  updateSettings(patch: Partial<Settings>): Promise<{ snapshot: Snapshot }>;
  updatePrice(price: {
    model: string;
    inputUsdPerMillion: number;
    cacheWriteUsdPerMillion: number;
    cacheWrite1hUsdPerMillion: number;
    cacheReadUsdPerMillion: number;
    outputUsdPerMillion: number;
    effectiveFrom?: string;
    sourceUrl?: string | null;
  }): Promise<{ snapshot: Snapshot }>;
  addManualObservation(observation: ManualObservation): Promise<Snapshot>;
  installClaudeHelper(): Promise<{ snapshot?: Snapshot }>;
  uninstallClaudeHelper(): Promise<{
    snapshot?: Snapshot;
    result: {
      managed: boolean;
      restoredPreviousStatusLine: boolean;
      statusLineRemoved: boolean;
      helperScriptRemoved: boolean;
    };
  }>;
  createBackup(): Promise<{ snapshot?: Snapshot; result: { databasePath: string; exportPath: string } }>;
  restoreBackup(): Promise<{
    cancelled: boolean;
    snapshot?: Snapshot;
    result?: RestoreCounts;
    safetyBackup?: { databasePath: string; exportPath: string };
  }>;
  openBackupDirectory(): Promise<void>;
  exportCsv(days: number): Promise<{ cancelled: boolean; filePath?: string; rows?: number; days?: number }>;
  copySummary(): Promise<{ text: string }>;
  snoozeAlerts(hours: number): Promise<{ snapshot: Snapshot }>;
  getVersion(): Promise<string>;
  getRenderingMode?(): Promise<RenderingMode>;
  relaunch?(): Promise<void>;
  checkForUpdates(): Promise<UpdateStatus>;
  getUpdateStatus(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  onUpdated?(callback: (snapshot: Snapshot) => void): () => void;
  onPrepareSleep?(callback: () => boolean): () => void;
};

export type DesktopImportPreview = {
  id: string;
  conversations: number;
  replies: number;
  skipped: number;
  unknownModelReplies: number;
  excludedContentReplies: number;
  models: string[];
};

export type DesktopEstimates = {
  periodDays: number;
  currency: string;
  estimatedCost: number;
  replies: number;
  storedReplies: number;
  unpricedReplies: number;
  byModel: {
    model: string | null;
    modelOrigin: 'exported' | 'assumed' | 'unknown';
    replies: number;
    inputTokens: number;
    outputTokens: number;
    incompleteReplies: number;
    estimatedCost: number | null;
  }[];
};

declare global {
  interface Window {
    aiUsage?: Bridge;
  }
}

export type ClaudeSetupStatus = {
  installed: boolean;
  auth: 'signed-in' | 'signed-out' | 'unavailable';
  helperInstalled: boolean;
  dismissed: boolean;
  busy: boolean;
};
