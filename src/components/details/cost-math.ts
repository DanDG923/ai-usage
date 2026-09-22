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
  /** The last seven calendar days, today included: the same window as a 7-day period's total. */
  week: number;
  /**
   * The last seven full days against the seven before, as a fraction. Today is
   * partial, so leaving it out of both keeps a steady pace at zero change.
   * Null when the selected period does not reach back far enough.
   */
  weekChange: number | null;
};

/**
 * The last seven days and how the last full week compares with the one
 * before. Everything comes from the daily chart series, so it only covers
 * the selected period.
 */
export function rollups(costs: CostAnalytics, now = new Date()): Rollups {
  const byDate = new Map(costs.chart.map((point) => [point.date, point.codex + point.claude]));
  const sum = (keys: string[]) => keys.reduce((total, key) => total + (byDate.get(key) || 0), 0);
  const days = recentDayKeys(15, now.getTime());
  const previousWeek = costs.periodDays >= 15 ? sum(days.slice(0, 7)) : 0;
  return {
    week: sum(days.slice(8)),
    weekChange: previousWeek > 0 ? (sum(days.slice(7, 14)) - previousWeek) / previousWeek : null,
  };
}
