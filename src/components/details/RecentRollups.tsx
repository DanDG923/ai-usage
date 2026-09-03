import { money } from '../../lib';
import type { CostAnalytics } from '../../types';

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

function Delta({ current, previous }: { current: number; previous: number | null }) {
  if (previous == null) return <small>previous 7 days outside the period</small>;
  if (previous <= 0) return <small>nothing in the previous 7 days</small>;
  const change = (current - previous) / previous;
  const tone = change > 0.05 ? 'up' : change < -0.05 ? 'down' : '';
  const sign = change > 0 ? '+' : '';
  return (
    <small>
      <span className={`delta ${tone}`}>
        {sign}
        {Math.round(change * 100)}%
      </span>{' '}
      vs previous 7 days
    </small>
  );
}

export function RecentRollups({ costs }: { costs: CostAnalytics }) {
  const r = rollups(costs);
  const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date());
  return (
    <section className="stat-row rollup-row" aria-label="Recent totals">
      <div>
        <span>Today</span>
        <strong>{money(r.today, costs.currency)}</strong>
        <small>API-equivalent so far today</small>
      </div>
      <div>
        <span>Last 7 days</span>
        <strong>{money(r.week, costs.currency)}</strong>
        <Delta current={r.week} previous={r.previousWeek} />
      </div>
      <div>
        <span>{monthLabel} to date</span>
        <strong>{money(r.monthToDate, costs.currency)}</strong>
        <small>
          {r.monthDaysElapsed} of {r.monthDays} days
          {costs.periodDays < r.monthDaysElapsed ? ` · only the last ${costs.periodDays} are in view` : ''}
        </small>
      </div>
      <div>
        <span>Projected for {monthLabel}</span>
        <strong>{money(r.monthProjection, costs.currency)}</strong>
        <small>at the month-to-date daily average</small>
      </div>
    </section>
  );
}
