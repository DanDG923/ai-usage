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

/**
 * Local day keys for the `count` days ending on the day of `anchorMs`, oldest
 * first. Stepping from local noon keeps the keys correct across DST changes.
 * The daily charts and the weekly roll-ups share this so their axes agree.
 */
export function recentDayKeys(count: number, anchorMs: number) {
  const anchor = new Date(anchorMs);
  anchor.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchor);
    date.setDate(anchor.getDate() - offset);
    keys.push(localDateKey(date));
  }
  return keys;
}

export type Rollups = {
  week: number;
  /** Null when the selected period does not reach back far enough. */
  previousWeek: number | null;
};

/**
 * The last seven days against the seven before. Everything comes from the
 * daily chart series, so it only covers the selected period.
 */
export function rollups(costs: CostAnalytics, now = new Date()): Rollups {
  const byDate = new Map(costs.chart.map((point) => [point.date, point.codex + point.claude]));
  const sum = (keys: string[]) => keys.reduce((total, key) => total + (byDate.get(key) || 0), 0);
  const last14 = recentDayKeys(14, now.getTime());
  return {
    week: sum(last14.slice(7)),
    previousWeek: costs.periodDays >= 14 ? sum(last14.slice(0, 7)) : null,
  };
}
