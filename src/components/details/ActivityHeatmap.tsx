import { ChevronRight } from 'lucide-react';
import { money } from '../../lib';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STEPS = [1, 2, 3, 4, 5];

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/**
 * Which of the five heat steps a value falls in; 0 is an empty hour. The
 * square root keeps quiet hours visible next to a very busy one.
 */
function heatStep(value: number, max: number) {
  if (value <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil(Math.sqrt(value / max) * 5)));
}

/**
 * Where the busiest-hour callout sits over the grid: centred on its column,
 * or held to the nearer edge for the first and last few hours. The grid is a
 * 40px label column then 24 equal columns, each gap 2px.
 */
function calloutStyle(hour: number): React.CSSProperties {
  const edge = (index: number) => `calc(${42 + 2 * index}px + (100% - 88px) * ${index / 24})`;
  if (hour < 3) return { left: edge(hour) };
  if (hour > 20) return { right: `calc(100% - ${edge(hour + 1)} + 2px)` };
  return { left: `calc(${42 + 2 * hour}px + (100% - 88px) * ${(hour + 0.5) / 24})`, transform: 'translateX(-50%)' };
}

/**
 * Hour-by-weekday grid of API-equivalent cost on the Flight Deck heat ramp.
 * Rows are Monday to Sunday, columns are local hours. The grid arrives as
 * seven rows of 24 values with Sunday first (JavaScript weekday order); it is
 * rotated so the week starts on Monday. The busiest hour is ringed and named.
 */
export function ActivityHeatmap({ grid, currency, days }: { grid: number[][]; currency: string; days: number }) {
  const rows = [1, 2, 3, 4, 5, 6, 0].map((weekday) => grid[weekday] || []);
  const max = Math.max(1e-9, ...rows.flat());
  const total = rows.flat().reduce((sum, value) => sum + value, 0);
  if (total <= 0)
    return (
      <section className="pnl log-panel heatmap-panel" aria-labelledby="heatmap-heading">
        <div className="log-heading">
          <h2 className="pnl-title" id="heatmap-heading">
            When the work happens
          </h2>
        </div>
        <div className="empty-chart">Hourly activity appears after local token records have been collected.</div>
      </section>
    );
  const busiest = rows.reduce<{ day: number; hour: number; value: number }>(
    (best, row, day) => {
      row.forEach((value, hour) => {
        if (value > best.value) best = { day, hour, value };
      });
      return best;
    },
    { day: 0, hour: 0, value: -1 },
  );
  const busiestLabel = `${DAYS[busiest.day]} ${hourLabel(busiest.hour)}`;
  const busiestMoney = money(busiest.value, currency);
  return (
    <section className="pnl log-panel heatmap-panel" aria-labelledby="heatmap-heading">
      <div className="log-heading">
        <h2 className="pnl-title" id="heatmap-heading">
          When the work happens
        </h2>
        <p>
          API-equivalent cost by local hour and weekday over the last {days} days. Busiest: {busiestLabel},{' '}
          {busiestMoney}.
        </p>
      </div>
      <div className="heatmap-frame">
        <span className="heatmap-callout" style={calloutStyle(busiest.hour)} aria-hidden="true">
          {`${busiestLabel} · ${busiestMoney}`}
        </span>
        <div
          className="heatmap"
          role="img"
          aria-label={`Cost by hour of day and weekday over the last ${days} days; the busiest hour is ${busiestLabel} at ${busiestMoney}.`}
        >
          {rows.map((row, day) => (
            <div key={DAYS[day]} className="hm-row">
              <span className="hm-row-label">{DAYS[day]}</span>
              {Array.from({ length: 24 }, (_, hour) => {
                const value = row[hour] || 0;
                const isBusiest = day === busiest.day && hour === busiest.hour;
                return (
                  <i
                    key={hour}
                    className={`hm-cell h${heatStep(value, max)}${isBusiest ? ' busiest' : ''}`}
                    title={`${DAYS[day]} ${hourLabel(hour)} · ${money(value, currency)}`}
                    aria-label={`${DAYS[day]} ${hourLabel(hour)} · ${money(value, currency)}`}
                  />
                );
              })}
            </div>
          ))}
          <div className="hm-row hm-axis">
            <span />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="hm-col-label">
                {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="heatmap-foot">
        <details className="chart-data">
          <summary>
            <ChevronRight aria-hidden="true" />
            View hourly activity data <span className="chart-data-count">· {rows.length * 24} rows</span>
          </summary>
          <div className="table-scroll">
            <table>
              <caption>API-equivalent cost by weekday and hour</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Hour</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((row, day) =>
                  Array.from({ length: 24 }, (_, hour) => (
                    <tr key={`${day}:${hour}`}>
                      <td>{DAYS[day]}</td>
                      <td>{hourLabel(hour)}</td>
                      <td>{money(row[hour] || 0, currency)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </details>
        <div className="heatmap-legend" aria-hidden="true">
          Less
          {STEPS.map((step) => (
            <i key={step} className={`h${step}`} />
          ))}
          More
        </div>
      </div>
    </section>
  );
}
