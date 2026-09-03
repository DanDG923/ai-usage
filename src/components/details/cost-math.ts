import type { CostAnalytics } from '../../types';

/** Share of prompt-side tokens served from cache, across every priced or unpriced model. */
export function cacheHitRate(costs: CostAnalytics) {
  let cached = 0;
  let prompt = 0;
  for (const row of costs.byModel) {
    cached += row.cachedInputTokens;
    prompt += row.inputTokens + row.cacheWriteInputTokens;
    // Codex reports cached input as a subset of input; Claude reports it separately.
    if (row.sourceId !== 'codex') prompt += row.cachedInputTokens;
  }
  return prompt > 0 ? cached / prompt : null;
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Day keys for the `count` days ending today, oldest first. */
function recentKeys(count: number, from = new Date()) {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(from);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    keys.push(localDateKey(date));
  }
  return keys;
}

export type Rollups = {
  today: number;
  week: number;
  /** Null when the selected period does not reach back far enough. */
  previousWeek: number | null;
  monthToDate: number;
  monthProjection: number;
  monthDaysElapsed: number;
  monthDays: number;
};

/**
 * Today, the last seven days against the seven before, and month to date
 * with a straight-line projection to the end of the month. Everything comes
 * from the daily chart series, so it only covers the selected period.
 */
export function rollups(costs: CostAnalytics, now = new Date()): Rollups {
  const byDate = new Map(costs.chart.map((point) => [point.date, point.codex + point.claude]));
  const sum = (keys: string[]) => keys.reduce((total, key) => total + (byDate.get(key) || 0), 0);
  const last14 = recentKeys(14, now);
  const week = sum(last14.slice(7));
  const previousWeek = costs.periodDays >= 14 ? sum(last14.slice(0, 7)) : null;
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthDaysElapsed = now.getDate();
  const monthKeys = recentKeys(monthDaysElapsed, now);
  const monthToDate = sum(monthKeys);
  const coveredDays = Math.min(monthDaysElapsed, costs.periodDays);
  const monthProjection = coveredDays > 0 ? (monthToDate / coveredDays) * monthDays : 0;
  return {
    today: byDate.get(last14[13]) || 0,
    week,
    previousWeek,
    monthToDate,
    monthProjection,
    monthDaysElapsed,
    monthDays,
  };
}
