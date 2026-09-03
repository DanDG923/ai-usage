import { money } from '../../lib';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Hour-by-weekday grid of API-equivalent cost. Rows are Monday to Sunday,
 * columns are local hours. The grid arrives as seven rows of 24 values with
 * Sunday first (JavaScript weekday order); it is rotated so the week starts
 * on Monday.
 */
export function ActivityHeatmap({ grid, currency, days }: { grid: number[][]; currency: string; days: number }) {
  const rows = [1, 2, 3, 4, 5, 6, 0].map((weekday) => grid[weekday] || []);
  const max = Math.max(1e-9, ...rows.flat());
  const total = rows.flat().reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const busiest = rows.reduce<{ day: number; hour: number; value: number }>(
    (best, row, day) => {
      row.forEach((value, hour) => {
        if (value > best.value) best = { day, hour, value };
      });
      return best;
    },
    { day: 0, hour: 0, value: -1 },
  );
  return (
    <section className="panel table-panel heatmap-panel">
      <div className="panel-heading">
        <div>
          <h2>When the work happens</h2>
          <p>
            API-equivalent cost by local hour and weekday over the last {days} days. Busiest: {DAYS[busiest.day]}{' '}
            {String(busiest.hour).padStart(2, '0')}:00, {money(busiest.value, currency)}.
          </p>
        </div>
      </div>
      <div className="heatmap" role="img" aria-label="Cost by hour of day and weekday">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="hm-col-label">
            {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
          </span>
        ))}
        {rows.map((row, day) => (
          <div key={DAYS[day]} style={{ display: 'contents' }}>
            <span className="hm-row-label">{DAYS[day]}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = row[hour] || 0;
              const level = value > 0 ? Math.max(12, Math.round(Math.sqrt(value / max) * 100)) : 0;
              return (
                <i
                  key={hour}
                  className="hm-cell"
                  style={{ '--level': level } as React.CSSProperties}
                  title={`${DAYS[day]} ${String(hour).padStart(2, '0')}:00 · ${money(value, currency)}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="heatmap-legend">
        Less
        {[0, 25, 50, 75, 100].map((level) => (
          <i key={level} style={{ '--level': level } as React.CSSProperties} />
        ))}
        More
      </div>
    </section>
  );
}
