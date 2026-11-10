import { STATE_WORD } from './lib';
import type { DashboardVerdict, FlyoutSnapshot, ForecastState, Quota, Settings, Source } from './types';

const STATES = Object.keys(STATE_WORD) as ForecastState[];

const WAITING_VERDICT: DashboardVerdict = {
  state: 'unknown',
  reason: null,
  label: 'Waiting for allowance readings',
  windowsChecked: 0,
  affected: [],
  details: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Only windows carrying a forecast can be drawn; anything else is treated as
// no reading rather than risking a render error in a glanceable surface.
function hasForecast(value: unknown) {
  return isRecord(value) && isRecord(value.forecast);
}

function normalizeQuota(value: unknown): Quota | null {
  if (!hasForecast(value)) return null;
  const quota = value as unknown as Quota;
  const windows = Array.isArray(quota.windows) ? quota.windows.filter(hasForecast) : [];
  return { ...quota, windows };
}

function normalizeVerdict(value: unknown): DashboardVerdict {
  if (!isRecord(value) || !STATES.includes(value.state as ForecastState)) return WAITING_VERDICT;
  const verdict = value as unknown as DashboardVerdict;
  return {
    ...verdict,
    label: typeof verdict.label === 'string' ? verdict.label : WAITING_VERDICT.label,
    affected: Array.isArray(verdict.affected) ? verdict.affected.filter((entry) => typeof entry === 'string') : [],
    details: Array.isArray(verdict.details) ? verdict.details.filter(isRecord) : [],
  };
}

/**
 * The flyout accepts whatever the main process sends and fills anything
 * missing with an explicit "no reading" shape, never with invented numbers.
 */
export function normalizeFlyoutSnapshot(value: unknown): FlyoutSnapshot | null {
  if (!isRecord(value)) return null;
  const quotas = isRecord(value.quotas) ? value.quotas : {};
  return {
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    timezone: typeof value.timezone === 'string' ? value.timezone : undefined,
    settings: (isRecord(value.settings) ? value.settings : {}) as Settings,
    sources: (Array.isArray(value.sources) ? value.sources.filter(isRecord) : []) as Source[],
    quotas: {
      codex: normalizeQuota(quotas.codex),
      claude: normalizeQuota(quotas.claude),
      fable: normalizeQuota(quotas.fable),
    },
    fableApplies: typeof value.fableApplies === 'boolean' ? value.fableApplies : undefined,
    dashboardVerdict: normalizeVerdict(value.dashboardVerdict),
  };
}
