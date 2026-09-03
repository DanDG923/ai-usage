import { useEffect, useId, useRef, useState } from 'react';
import type { CostAnalytics, DailyUsage, Forecast, Point } from '../types';
import { compactNumber, money } from '../lib';

function linePath(points: { x: number; y: number }[]) {
  if (!points.length) return '';
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function periodDates(days: number) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - index));
    return localDateKey(date);
  });
}

function dateLabel(key: string, style: Intl.DateTimeFormatOptions) {
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', style).format(new Date(year, month - 1, day, 12));
}

/** Indices to label along a day axis so labels never crowd. */
function dayTicks(count: number, maxLabels = 8) {
  const step = Math.max(1, Math.ceil(count / maxLabels));
  const ticks: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) ticks.unshift(index);
  return ticks;
}

function valueAt(points: Point[], at: number): number | null {
  if (!points.length) return null;
  if (at <= points[0].at) return points[0].remaining;
  if (at >= points.at(-1)!.at) return points.at(-1)!.remaining;
  for (let index = 1; index < points.length; index += 1) {
    if (at <= points[index].at) {
      const prev = points[index - 1];
      const next = points[index];
      const fraction = (at - prev.at) / Math.max(1, next.at - prev.at);
      return prev.remaining + (next.remaining - prev.remaining) * fraction;
    }
  }
  return points.at(-1)!.remaining;
}

const PLOT_BASE = { width: 660, height: 196, left: 36, right: 12, top: 16, bottom: 26 };
const PLOT_MIN_HEIGHT = 150;
const PLOT_MAX_HEIGHT = 520;

/**
 * The forecast plot fills whatever height its card gives it. The viewBox
 * height follows the box's aspect ratio so the drawing stretches to the box
 * instead of letterboxing, while text and strokes keep their width-relative
 * size.
 */
function usePlotHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(PLOT_BASE.height);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width < 1 || box.height < 1) return;
      const next = Math.round(
        Math.max(PLOT_MIN_HEIGHT, Math.min(PLOT_MAX_HEIGHT, (PLOT_BASE.width * box.height) / box.width)),
      );
      setHeight((current) => (Math.abs(current - next) < 2 ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

export function ForecastChart({ forecast }: { forecast: Forecast }) {
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [plotRef, plotHeight] = usePlotHeight();
  const PLOT = { ...PLOT_BASE, height: plotHeight };
  // Two cards render this chart on one page; gradient ids must not collide.
  const gradientId = useId();
  const all = [...forecast.series.observed, ...forecast.series.expected, ...forecast.series.heavy];
  if (!all.length) return <div className="empty-chart">A forecast appears after the first observations.</div>;
  const minAt = Math.min(...all.map((point) => point.at));
  const maxAt = Math.max(...all.map((point) => point.at));
  const x = (at: number) =>
    PLOT.left + ((at - minAt) / Math.max(1, maxAt - minAt)) * (PLOT.width - PLOT.left - PLOT.right);
  const y = (remaining: number) => PLOT.top + (1 - remaining / 100) * (PLOT.height - PLOT.top - PLOT.bottom);
  const scale = (point: Point) => ({ x: x(point.at), y: y(point.remaining) });
  const observed = forecast.series.observed.map(scale);
  const expected = forecast.series.expected.map(scale);
  const heavy = forecast.series.heavy.map(scale);
  const nowAt = forecast.series.expected[0]?.at ?? forecast.series.observed.at(-1)?.at ?? minAt;
  const baseline = y(0);
  const area = expected.length
    ? `${linePath(expected)} L${expected.at(-1)!.x},${baseline} L${expected[0].x},${baseline} Z`
    : '';

  // Weekday ticks at local midnights, thinned so labels never crowd.
  const dayMs = 86_400_000;
  const spanDays = (maxAt - minAt) / dayMs;
  const step = Math.max(1, Math.ceil(spanDays / 6));
  const ticks: { at: number; label: string }[] = [];
  // Step by calendar day rather than by 24 hours so a DST change does not
  // shift every later tick to 23:00 of the previous day.
  const cursor = new Date(minAt);
  cursor.setHours(0, 0, 0, 0);
  for (; cursor.getTime() <= maxAt; cursor.setDate(cursor.getDate() + step)) {
    const time = cursor.getTime();
    if (time < minAt) continue;
    if (Math.abs(time - nowAt) < (step * dayMs) / 2) continue; // leave room for the Now label
    ticks.push({ at: time, label: new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(cursor) });
  }

  const moveHover = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    const plotFraction = (fraction * PLOT.width - PLOT.left) / (PLOT.width - PLOT.left - PLOT.right);
    if (plotFraction < 0 || plotFraction > 1) {
      setHoverAt(null);
      return;
    }
    setHoverAt(minAt + plotFraction * (maxAt - minAt));
  };
  const hoverExpected = hoverAt != null && hoverAt >= nowAt ? valueAt(forecast.series.expected, hoverAt) : null;
  const hoverHeavy = hoverAt != null && hoverAt >= nowAt ? valueAt(forecast.series.heavy, hoverAt) : null;
  const hoverObserved = hoverAt != null && hoverAt < nowAt ? valueAt(forecast.series.observed, hoverAt) : null;
  const hoverLabel =
    hoverAt == null
      ? ''
      : new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(
          new Date(hoverAt),
        );
  // Positioned as a share of the plot width so no layout read happens in render.
  const tipLeft = hoverAt == null ? '0%' : `${Math.min(70, Math.max(1, (x(hoverAt) / PLOT.width) * 100 + 1))}%`;
  const exhaustAt = forecast.exhaustsAt ? Date.parse(forecast.exhaustsAt) : null;

  return (
    <div className="forecast-wrap">
      <div className="forecast-plot" ref={plotRef}>
        <svg
          ref={svgRef}
          className="forecast-chart"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          role="img"
          aria-label="Learned remaining allowance forecast"
          onMouseMove={moveHover}
          onMouseLeave={() => setHoverAt(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop className="forecast-fill-stop" stopOpacity=".18" />
              <stop className="forecast-fill-stop" offset="1" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 50, 100].map((value) => (
            <g key={value}>
              <line x1={PLOT.left} x2={PLOT.width - PLOT.right} y1={y(value)} y2={y(value)} className="grid-line" />
              <text x="5" y={y(value) + 4}>
                {value}%
              </text>
            </g>
          ))}
          {ticks.map((tick) => (
            <text key={tick.at} x={x(tick.at)} y={PLOT.height - 8} textAnchor="middle">
              {tick.label}
            </text>
          ))}
          <line x1={x(nowAt)} x2={x(nowAt)} y1={PLOT.top - 2} y2={baseline} className="now-line" />
          <text x={x(nowAt)} y={PLOT.height - 8} textAnchor="middle" className="now-label">
            Now
          </text>
          {area && <path d={area} fill={`url(#${gradientId})`} />}
          <path d={linePath(observed)} className="observed-line" />
          <path d={linePath(expected)} className="expected-line" />
          <path d={linePath(heavy)} className="heavy-line" />
          {expected.length > 0 && (
            <circle cx={expected.at(-1)!.x} cy={expected.at(-1)!.y} r="3.5" className="expected-dot" />
          )}
          {heavy.length > 0 && <circle cx={heavy.at(-1)!.x} cy={heavy.at(-1)!.y} r="3.5" className="heavy-dot" />}
          {exhaustAt != null && exhaustAt >= minAt && exhaustAt <= maxAt && (
            <g className="exhaust-marker">
              <line x1={x(exhaustAt)} x2={x(exhaustAt)} y1={PLOT.top} y2={baseline} />
              <text x={x(exhaustAt)} y={PLOT.top - 4} textAnchor="middle">
                runs out
              </text>
            </g>
          )}
          {hoverAt != null && (
            <line className="forecast-hover" x1={x(hoverAt)} x2={x(hoverAt)} y1={PLOT.top} y2={baseline} />
          )}
        </svg>
      </div>
      {hoverAt != null && (
        <div className="forecast-tip" style={{ left: tipLeft }}>
          {hoverObserved != null
            ? `${hoverLabel} · observed ${Math.round(hoverObserved)}%`
            : `${hoverLabel} · expected ${hoverExpected == null ? '—' : `${Math.round(hoverExpected)}%`} · heavier ${hoverHeavy == null ? '—' : `${Math.round(hoverHeavy)}%`}`}
        </div>
      )}
      <div className="chart-key">
        <span className="k-observed">
          <i />
          Observed
        </span>
        <span className="k-expected">
          <i />
          Expected
        </span>
        <span className="k-heavy">
          <i />
          Heavier
        </span>
      </div>
    </div>
  );
}

const COST = { width: 880, height: 270, left: 56, right: 44, top: 20, bottom: 44 };

export function CostChart({ costs }: { costs: CostAnalytics }) {
  const [mode, setMode] = useState<'lines' | 'stacked'>('stacked');
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const source = costs.chart;
  if (!source.length)
    return <div className="empty-chart tall">Token history will build this cost chart automatically.</div>;
  const byDate = new Map(source.map((point) => [point.date, point]));
  const points = periodDates(costs.periodDays).map((date) => byDate.get(date) || { date, codex: 0, claude: 0 });
  const totals = points.map((point) => point.codex + point.claude);
  const max = Math.max(...totals, 1) * 1.15;
  const plotWidth = COST.width - COST.left - COST.right;
  const plotHeight = COST.height - COST.top - COST.bottom;
  const x = (index: number) => COST.left + (index * plotWidth) / Math.max(1, points.length - 1);
  const y = (value: number) => COST.top + plotHeight - (value / max) * plotHeight;
  const baseline = y(0);
  const codexPath = linePath(points.map((point, index) => ({ x: x(index), y: y(point.codex) })));
  const claudePath = linePath(points.map((point, index) => ({ x: x(index), y: y(point.claude) })));
  const totalPath = linePath(points.map((point, index) => ({ x: x(index), y: y(point.codex + point.claude) })));
  const barWidth = Math.max(2, (plotWidth / Math.max(points.length, 1)) * 0.72);
  const ticks = dayTicks(points.length);
  const hovered = hover == null ? null : points[hover];

  const moveHover = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const fraction = ((event.clientX - rect.left) / rect.width) * COST.width;
    const index = Math.round(((fraction - COST.left) / plotWidth) * (points.length - 1));
    setHover(index < 0 || index >= points.length ? null : index);
  };

  return (
    <div className="cost-chart-wrap">
      <div className="chart-toolbar">
        <div className="chart-legend">
          <span className="legend total">Total</span>
          <span className="legend codex">Codex</span>
          <span className="legend claude">Claude + Fable</span>
        </div>
        <div className="chart-mode" role="group" aria-label="Chart style">
          <button
            type="button"
            className={mode === 'stacked' ? 'active' : ''}
            aria-pressed={mode === 'stacked'}
            onClick={() => setMode('stacked')}
          >
            Stacked
          </button>
          <button
            type="button"
            className={mode === 'lines' ? 'active' : ''}
            aria-pressed={mode === 'lines'}
            onClick={() => setMode('lines')}
          >
            Lines
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="cost-chart"
        viewBox={`0 0 ${COST.width} ${COST.height}`}
        role="img"
        aria-label={`${costs.periodDays} day API equivalent cost history`}
        onMouseMove={moveHover}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1={COST.left}
              x2={COST.width - COST.right}
              y1={y(max * fraction)}
              y2={y(max * fraction)}
              className="grid-line"
            />
            <text x="4" y={y(max * fraction) + 4}>
              {money(max * fraction, costs.currency)}
            </text>
          </g>
        ))}
        {mode === 'stacked' ? (
          points.map((point, index) => (
            <g key={point.date} className={hover === index ? 'bar hovered' : 'bar'}>
              <rect
                x={x(index) - barWidth / 2}
                y={y(point.codex)}
                width={barWidth}
                height={Math.max(0, baseline - y(point.codex))}
                className="cost-codex-bar"
                rx="1.5"
              />
              <rect
                x={x(index) - barWidth / 2}
                y={y(point.codex + point.claude)}
                width={barWidth}
                height={Math.max(0, y(point.codex) - y(point.codex + point.claude))}
                className="cost-claude-bar"
                rx="1.5"
              />
            </g>
          ))
        ) : (
          <>
            <path
              d={`${totalPath} L${x(points.length - 1)},${baseline} L${COST.left},${baseline} Z`}
              className="total-area"
            />
            <path d={codexPath} className="cost-codex-line" />
            <path d={claudePath} className="cost-claude-line" />
            <path d={totalPath} className="cost-total-line" />
          </>
        )}
        {ticks.map((index) => (
          <text key={points[index].date} x={x(index)} y={COST.height - 14} textAnchor="middle">
            {dateLabel(
              points[index].date,
              points.length > 45 ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' },
            )}
          </text>
        ))}
        {hover != null && <line className="forecast-hover" x1={x(hover)} x2={x(hover)} y1={COST.top} y2={baseline} />}
      </svg>
      {hovered && hover != null && (
        <div className="forecast-tip" style={{ left: `${Math.min(84, Math.max(2, (x(hover) / COST.width) * 100))}%` }}>
          {dateLabel(hovered.date, { weekday: 'short', day: 'numeric', month: 'short' })} · total{' '}
          {money(hovered.codex + hovered.claude, costs.currency)} · Codex {money(hovered.codex, costs.currency)} ·
          Claude {money(hovered.claude, costs.currency)}
        </div>
      )}
    </div>
  );
}

// Wider than the cost chart because it spans the full page; the viewBox keeps
// its text at a sensible on-screen size once scaled to the panel.
const DAILY = { width: 1320, height: 300, left: 64, right: 40, top: 14, bottom: 40 };

export function DailyUsageChart({ rows, days }: { rows: DailyUsage[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length)
    return <div className="empty-chart">Daily account usage will appear when the local Codex service supplies it.</div>;
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.date, (totals.get(row.date) || 0) + Number(row.tokens || 0));
  const points = periodDates(days).map((date) => ({ date, tokens: totals.get(date) || 0 }));
  const max = Math.max(...points.map((point) => point.tokens), 1);
  const plotWidth = DAILY.width - DAILY.left - DAILY.right;
  const plotHeight = DAILY.height - DAILY.top - DAILY.bottom;
  const slot = plotWidth / Math.max(points.length, 1);
  const baseline = DAILY.top + plotHeight;
  const ticks = dayTicks(points.length);
  const hovered = hover == null ? null : points[hover];
  return (
    <div className="cost-chart-wrap">
      <svg
        className="daily-usage-chart"
        viewBox={`0 0 ${DAILY.width} ${DAILY.height}`}
        role="img"
        aria-label="Official daily Codex token usage"
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1={DAILY.left}
              x2={DAILY.width - DAILY.right}
              y1={baseline - plotHeight * fraction}
              y2={baseline - plotHeight * fraction}
              className="grid-line"
            />
            <text x="4" y={baseline - plotHeight * fraction + 4}>
              {compactNumber(max * fraction)}
            </text>
          </g>
        ))}
        {points.map((point, index) => {
          const height = (point.tokens / max) * plotHeight;
          return (
            <rect
              key={point.date}
              x={DAILY.left + index * slot + slot * 0.14}
              y={baseline - height}
              width={Math.max(2, slot * 0.72)}
              height={height}
              rx="2"
              className={`daily-usage-bar${hover === index ? ' hovered' : ''}`}
              onMouseEnter={() => setHover(index)}
            />
          );
        })}
        {ticks.map((index) => (
          <text
            key={points[index].date}
            x={DAILY.left + index * slot + slot / 2}
            y={DAILY.height - 10}
            textAnchor="middle"
          >
            {dateLabel(
              points[index].date,
              points.length > 45 ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' },
            )}
          </text>
        ))}
      </svg>
      {hovered && hover != null && (
        <div
          className="forecast-tip"
          style={{ left: `${Math.min(84, Math.max(2, ((DAILY.left + hover * slot) / DAILY.width) * 100))}%` }}
        >
          {dateLabel(hovered.date, { weekday: 'short', day: 'numeric', month: 'short' })} ·{' '}
          {hovered.tokens.toLocaleString()} tokens
        </div>
      )}
    </div>
  );
}
