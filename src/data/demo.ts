import type { CycleRow, Forecast, Quota, Snapshot, TokenCapacityEstimate } from '../types';

const now = Date.now();
const day = 86_400_000;

function forecast(remaining: number, expected: number, heavy: number, seed: number, resetDays: number): Forecast {
  const reset = now + resetDays * day;
  const observed = Array.from({ length: 11 }, (_, index) => ({
    at: now - (10 - index) * day * 0.25,
    remaining: Math.min(100, remaining + (10 - index) * seed * 0.34),
  }));
  const expectedSeries = Array.from({ length: 20 }, (_, index) => ({
    at: now + (index * (reset - now)) / 19,
    remaining: Math.max(0, remaining - (index * (remaining - expected)) / 19),
  }));
  const heavySeries = Array.from({ length: 20 }, (_, index) => ({
    at: now + (index * (reset - now)) / 19,
    remaining: Math.max(0, remaining - (index * (remaining - heavy)) / 19),
  }));
  const crossing = (series: { at: number; remaining: number }[]) =>
    series.find((point) => point.remaining <= 0)?.at ?? null;
  return {
    state: expected <= 0 ? 'critical' : heavy <= 0 ? 'risk' : expected < 20 ? 'watch' : 'safe',
    expectedRemaining: expected,
    heavyRemaining: heavy,
    confidence: 0.89,
    learnedSamples: 247,
    learnedDays: 29,
    activeHoursLeft: 82,
    safePace: remaining / 82,
    recentPace: seed,
    workingPace: seed * 1.65,
    windowPace: seed * 0.82,
    paceRatio: seed / (remaining / 82),
    exhaustsAt: crossing(expectedSeries) ? new Date(crossing(expectedSeries)!).toISOString() : null,
    heavyExhaustsAt: crossing(heavySeries) ? new Date(crossing(heavySeries)!).toISOString() : null,
    reservePercent: 0,
    series: { observed, expected: expectedSeries, heavy: heavySeries },
  };
}

// Synthetic browser-preview examples only, never an account token allowance.
function exampleCapacity(name: string, remaining: number): TokenCapacityEstimate {
  const learning = name === 'Fable 5';
  const weeklyTokens = name === 'Codex' ? 18_200_000 : 9_600_000;
  const factor = remaining / 100;
  return {
    status: learning ? 'learning' : 'available',
    reason: learning ? 'More matching official weekly readings and local usage are needed for this estimate.' : null,
    weeklyTokens: learning ? null : weeklyTokens,
    weeklyRange: learning ? null : { low: weeklyTokens * 0.7, high: weeklyTokens * 1.35 },
    remainingTokens: learning ? null : weeklyTokens * factor,
    remainingRange: learning ? null : { low: weeklyTokens * 0.7 * factor, high: weeklyTokens * 1.35 * factor },
    remainingAsOf: learning ? null : new Date(now - 4 * 60_000).toISOString(),
    confidence: name === 'Codex' ? 'medium' : 'low',
    intervals: learning ? 1 : 12,
    cycles: learning ? 1 : 3,
    observedPercent: learning ? 6 : 92,
    calibratedAt: new Date(now - 4 * 60_000).toISOString(),
    modelMix: learning
      ? [{ model: 'claude-fable-5', share: 1 }]
      : [
          { model: name === 'Codex' ? 'gpt-6-astra' : 'claude-opus-5', share: 0.7 },
          { model: name === 'Codex' ? 'gpt-5.6-sol' : 'claude-sonnet-5', share: 0.3 },
        ],
    tokenMix: { input: 0.22, cacheRead: 0.62, cacheWrite: 0.04, output: 0.12 },
    warnings: [
      'Synthetic preview figures, not your actual account capacity.',
      'Local usage may omit other devices and apps.',
    ],
  };
}

function quota(
  name: string,
  remaining: number,
  expected: number,
  heavy: number,
  resetDays: number,
  seed: number,
): Quota {
  const q = {
    bucketId: name === 'Codex' ? 'codex:weekly' : `${name.toLowerCase()}-weekly`,
    bucketName: `${name} weekly`,
    observedAt: new Date(now - 4 * 60_000).toISOString(),
    usedPercent: 100 - remaining,
    remainingPercent: remaining,
    resetsAt: new Date(now + resetDays * day).toISOString(),
    windowMinutes: 10_080,
    planType: name === 'Codex' ? 'pro' : 'max',
    provenance: 'preview',
    metadata: {},
    forecast: forecast(remaining, expected, heavy, seed, resetDays),
    tokenCapacity: exampleCapacity(name, remaining),
  };
  return { ...q, windows: [q] };
}

function cycles(resetDays: number, peaks: number[], costs: number[]): CycleRow[] {
  return peaks.map((peak, index) => {
    const resetsAt = now + resetDays * day - index * 7 * day;
    return {
      resetsAt: new Date(resetsAt).toISOString(),
      startsAt: new Date(resetsAt - 7 * day).toISOString(),
      windowMinutes: 10_080,
      peakUsedPercent: peak,
      readings: index === 0 ? 212 : 640,
      firstObservedAt: new Date(resetsAt - 7 * day).toISOString(),
      lastObservedAt: new Date(Math.min(now, resetsAt)).toISOString(),
      current: index === 0,
      cost: costs[index],
      tokens: Math.round(costs[index] * 120_000),
    };
  });
}

const chart = Array.from({ length: 30 }, (_, index) => ({
  date: new Date(now - (29 - index) * day).toISOString().slice(0, 10),
  codex: 12 + Math.sin(index / 2.8) * 8 + index * 0.6,
  claude: 8 + Math.cos(index / 3.2) * 5 + index * 0.32,
}));

const PROJECT_A = 'C:\\Users\\you\\Documents\\Codex\\ai-usage';
const PROJECT_B = 'C:\\Users\\you\\Documents\\Claude\\architecture-review';

export const demoSnapshot: Snapshot = {
  generatedAt: new Date(now).toISOString(),
  timezone: 'Europe/London',
  isPreview: true,
  resetCredits: 1,
  priceCatalog: [
    {
      model: 'gpt-6-astra',
      input_usd_per_million: 10,
      cache_write_usd_per_million: 12.5,
      cache_write_1h_usd_per_million: 12.5,
      cache_read_usd_per_million: 1,
      output_usd_per_million: 50,
      effective_from: '2026-09-04',
      source_url: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    },
    {
      model: 'gpt-5.6-sol',
      input_usd_per_million: 4,
      cache_write_usd_per_million: 5,
      cache_write_1h_usd_per_million: 5,
      cache_read_usd_per_million: 0.4,
      output_usd_per_million: 20,
      effective_from: '2026-08-01',
      source_url: 'https://developers.openai.com/api/docs/models/compare',
    },
    {
      model: 'gpt-5.6-terra',
      input_usd_per_million: 2,
      cache_write_usd_per_million: 2.5,
      cache_write_1h_usd_per_million: 2.5,
      cache_read_usd_per_million: 0.2,
      output_usd_per_million: 12,
      effective_from: '2026-08-01',
      source_url: 'https://developers.openai.com/api/docs/models/compare',
    },
    {
      model: 'claude-fable-5',
      input_usd_per_million: 10,
      cache_write_usd_per_million: 12.5,
      cache_write_1h_usd_per_million: 20,
      cache_read_usd_per_million: 1,
      output_usd_per_million: 50,
      effective_from: '2026-08-01',
      source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    },
    {
      model: 'claude-opus-5',
      input_usd_per_million: 5,
      cache_write_usd_per_million: 6.25,
      cache_write_1h_usd_per_million: 10,
      cache_read_usd_per_million: 0.5,
      output_usd_per_million: 25,
      effective_from: '2026-08-01',
      source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    },
  ],
  settings: {
    showCodexSubscription: true,
    showClaudeSubscription: true,
    currency: 'GBP',
    usdToCurrency: 0.736,
    activeDays: [1, 2, 3, 4, 5, 6, 0],
    activeStartHour: 8,
    activeEndHour: 22,
    forecastFallbackRate: 0.35,
    forecastExcludedDates: [],
    allowanceChanges: [],
    paceRiskThreshold: 1.2,
    hardLimitThreshold: 90,
    reservePercent: 0,
    codexPlanUsdPerMonth: 200,
    claudePlanUsdPerMonth: 200,
    notifyDesktop: true,
    notifyResets: true,
    notifyFallback: true,
    notifyDigest: false,
    digestHour: 9,
    alertsSnoozedUntil: null,
    launchAtLogin: false,
    theme: 'system',
    softwareRendering: true,
    autoUpdate: true,
    backupFrequency: 'daily',
    backupRetentionCount: 30,
    refreshIntervalMinutes: 15,
  },
  sources: [
    {
      id: 'codex',
      name: 'Codex',
      kind: 'codex',
      status: 'connected',
      status_detail: 'Official local quota and session records found.',
      last_observation_at: new Date(now - 4 * 60_000).toISOString(),
      last_attempt_at: new Date(now - 2 * 60_000).toISOString(),
      last_success_at: new Date(now - 2 * 60_000).toISOString(),
      metadata: {
        binary: 'C:\\Users\\you\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
        appServer: { observations: 2, dailyBuckets: 30, resetCredits: 1, usageWarning: null },
        local: { importedFiles: 3, events: 412, observations: 18 },
        localWarning: null,
      },
    },
    {
      id: 'claude',
      name: 'Claude',
      kind: 'claude',
      status: 'connected',
      status_detail: 'Official Claude allowance evidence was refreshed; scanned 96 transcript messages.',
      last_observation_at: new Date(now - 11 * 60_000).toISOString(),
      last_attempt_at: new Date(now - 2 * 60_000).toISOString(),
      last_success_at: new Date(now - 2 * 60_000).toISOString(),
      metadata: {
        binary: 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd',
        provider: {
          kind: 'observed',
          attemptSucceeded: true,
          durationMs: 1840,
          errorCode: null,
          overallWindowsRecorded: 4,
        },
        transcripts: { filesFound: 12, importedFiles: 2, usageEvents: 96, fableEvents: 31 },
        statusLine: { snapshots: 0, observations: 0, invalidRecords: 0, rejectedRecords: 0, readErrors: 0 },
        helperInstalled: false,
      },
    },
    {
      id: 'claude-fable',
      name: 'Fable 5',
      kind: 'fable',
      status: 'connected',
      status_detail: 'Official model-scoped Fable allowance and actual local activity.',
      last_observation_at: new Date(now - 11 * 60_000).toISOString(),
      last_attempt_at: new Date(now - 2 * 60_000).toISOString(),
      last_success_at: new Date(now - 2 * 60_000).toISOString(),
      metadata: {
        automatic: {
          allowance: { kind: 'official', source: 'claude-usage-model-scoped' },
          activity: {
            requests: 146,
            inputTokens: 4_900_000,
            cachedInputTokens: 22_000_000,
            cacheWriteInputTokens: 1_500_000,
            outputTokens: 3_600_000,
          },
          health: {
            state: 'current',
            officialSource: 'connected',
            activitySource: 'current',
            activityDurationMs: 420,
            detail: '',
          },
        },
        fableDerived: { derived: false, reason: 'official-model-scoped' },
      },
    },
  ],
  quotas: {
    codex: quota('Codex', 78, 30, 3, 6.3, 0.78),
    claude: quota('Claude', 95, 84, 79, 4.5, 0.13),
    fable: quota('Fable 5', 72, 41, 0, 4.5, 0.49),
  },
  dashboardVerdict: {
    state: 'risk',
    reason: 'heavy-exhaustion',
    label: 'Fable 5 could reach its limit under heavier usage',
    windowsChecked: 3,
    affected: ['Fable 5 · Fable 5 weekly'],
    details: [
      {
        sourceId: 'fable',
        sourceLabel: 'Fable 5',
        bucketId: 'fable_seven_day',
        bucketName: 'Fable 5 weekly',
        state: 'risk',
        reasons: ['heavy-exhaustion'],
        expectedRemaining: 41,
        heavyRemaining: 0,
        exhaustsAt: null,
        heavyExhaustsAt: new Date(now + 4.2 * day).toISOString(),
        paceRatio: 0.56,
      },
    ],
  },
  cycles: {
    codex: cycles(6.3, [22, 91, 74, 68], [212.4, 1_102.3, 864.1, 790.7]),
    claude: cycles(4.5, [5, 34, 41, 29], [61.2, 302.9, 388.6, 240.1]),
    fable: cycles(4.5, [28, 88, 63], [398.7, 1_212.5, 840.2]),
  },
  dailyUsage: Array.from({ length: 30 }, (_, index) => ({
    sourceId: 'codex',
    date: new Date(now - (29 - index) * day).toISOString().slice(0, 10),
    tokens: Math.round(2_400_000 + Math.sin(index / 2.4) * 1_100_000 + index * 90_000),
  })),
  costs: {
    periodDays: 30,
    currency: 'GBP',
    actual: 1755.87,
    withoutCache: 11957.87,
    cacheSavings: 10202,
    cacheSavingsPercent: 0.853,
    totalTokens: 286_400_000,
    coverage: 0.96,
    isComplete: false,
    isLowerBound: true,
    unpricedModels: [{ sourceId: 'codex', model: 'preview-unpriced-model', tokens: 11_456_000 }],
    requestCount: 1842,
    chart,
    activityGrid: Array.from({ length: 7 }, (_, weekday) =>
      Array.from({ length: 24 }, (__, hour) => {
        const working = hour >= 8 && hour < 22 && weekday !== 0;
        const peak = Math.exp(-((hour - 15) ** 2) / 18) * (weekday === 6 ? 0.5 : 1);
        return working ? Math.round(peak * 14 * 100) / 100 : 0;
      }),
    ),
    byModel: [
      {
        sourceId: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 30_200_000,
        cachedInputTokens: 23_400_000,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 11_500_000,
        reasoningOutputTokens: 8_400_000,
        totalTokens: 41_700_000,
        cost: 1128.32,
        costBreakdown: { input: 80, cacheRead: 18.72, cacheWrite5m: 0, cacheWrite1h: 0, output: 1029.6 },
        costShare: 1128.32 / 1755.87,
        coverage: 1,
      },
      {
        sourceId: 'codex',
        model: 'preview-unpriced-model',
        inputTokens: 11_456_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 11_456_000,
        cost: 0,
        costShare: null,
        coverage: 0,
      },
      {
        sourceId: 'claude',
        model: 'claude-fable-5',
        inputTokens: 4_900_000,
        cachedInputTokens: 22_000_000,
        cacheWriteInputTokens: 1_500_000,
        cacheWrite5mInputTokens: 300_000,
        cacheWrite1hInputTokens: 1_200_000,
        outputTokens: 3_600_000,
        reasoningOutputTokens: 0,
        totalTokens: 32_000_000,
        cost: 398.74,
        costBreakdown: { input: 39.2, cacheRead: 17.6, cacheWrite5m: 3, cacheWrite1h: 19.2, output: 319.74 },
        costShare: 398.74 / 1755.87,
        coverage: 1,
      },
      {
        sourceId: 'claude',
        model: 'claude-opus-5',
        inputTokens: 7_100_000,
        cachedInputTokens: 31_200_000,
        cacheWriteInputTokens: 1_900_000,
        cacheWrite5mInputTokens: 600_000,
        cacheWrite1hInputTokens: 1_300_000,
        outputTokens: 4_700_000,
        reasoningOutputTokens: 0,
        totalTokens: 44_900_000,
        cost: 228.81,
        costBreakdown: { input: 40, cacheRead: 20, cacheWrite5m: 3, cacheWrite1h: 15, output: 150.81 },
        costShare: 228.81 / 1755.87,
        coverage: 0.88,
      },
    ],
    byProject: [
      {
        project: PROJECT_A,
        cost: 1231.74,
        totalTokens: 53_156_000,
        coverage: 0.93,
        sessionCount: 14,
        sources: ['claude', 'codex'],
        lastActivity: new Date(now - day).toISOString(),
      },
      {
        project: PROJECT_B,
        cost: 398.74,
        totalTokens: 32_000_000,
        coverage: 1,
        sessionCount: 3,
        sources: ['claude'],
        lastActivity: new Date(now - 2 * day).toISOString(),
      },
      {
        project: null,
        cost: 125.39,
        totalTokens: 44_900_000,
        coverage: 0.88,
        sessionCount: 6,
        sources: ['claude'],
        lastActivity: new Date(now - 5 * day).toISOString(),
      },
    ],
    sessions: [
      {
        sourceId: 'codex',
        sessionId: '01a04d90-3c5b-75f3-8a4a-92f3d526ee94',
        model: 'gpt-5.6-sol',
        project: PROJECT_A,
        occurredAt: new Date(now - day).toISOString(),
        totalTokens: 18_400_000,
        cost: 103.42,
        coverage: 1,
      },
      {
        sourceId: 'claude',
        sessionId: '1bd5df09-8254-4a7d-b876-03a42af95e83',
        model: 'claude-fable-5',
        project: PROJECT_B,
        occurredAt: new Date(now - 2 * day).toISOString(),
        totalTokens: 5_200_000,
        cost: 64.18,
        coverage: 1,
      },
    ],
  },
  storage: {
    databasePath: 'C:\\Users\\you\\AppData\\Roaming\\AI Usage\\ai-usage.sqlite',
    backupDirectory: 'Documents\\AI Usage\\Backups',
    databaseSize: 3_480_576,
  },
};

// Browser-preview examples only; installed windows always use the local ledger.
demoSnapshot.costs.tasks = demoSnapshot.costs.sessions.map((session, index) => {
  const totals = (share: number, usageCount: number) => ({
    inputTokens: Math.round(session.totalTokens * share * 0.6),
    cachedInputTokens: Math.round(session.totalTokens * share * 0.3),
    cacheWriteInputTokens: 0,
    outputTokens: Math.round(session.totalTokens * share * 0.1),
    reasoningOutputTokens: Math.round(session.totalTokens * share * 0.04),
    totalTokens: Math.round(session.totalTokens * share),
    usageCount,
    cost: session.cost * share,
    coverage: share ? 1 : 0,
    startedAt: usageCount ? new Date(Date.parse(session.occurredAt) - 30 * 60_000).toISOString() : null,
    occurredAt: usageCount ? session.occurredAt : null,
    activitySpanMs: usageCount ? 30 * 60_000 : null,
  });
  const main = totals(0.6, 4);
  const subagent = totals(0.4, 2);
  return {
    ...totals(1, 6),
    key: `example-task-${index}`,
    sourceId: session.sourceId,
    sessionId: session.sessionId,
    taskId: index === 0 ? 'example-task-review' : null,
    project: session.project,
    subagentCount: 1,
    main,
    subagent,
    unknown: totals(0, 0),
    agents: [
      {
        ...main,
        key: 'main',
        sessionId: session.sessionId,
        agentId: session.sessionId,
        agentKind: 'main',
        agentName: null,
        agentRole: null,
        parentSessionId: null,
        model: session.model,
      },
      {
        ...subagent,
        key: 'worker',
        sessionId: `${session.sessionId}-worker`,
        agentId: 'example-verifier',
        agentKind: 'subagent',
        agentName: 'Verifier',
        agentRole: 'reviewer',
        parentSessionId: session.sessionId,
        model: session.model,
      },
    ],
  };
});
