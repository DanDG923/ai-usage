/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions -- Pointer tooltips supplement the keyboard-accessible data tables for each SVG. */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { CostAnalytics, DailyUsage, Point } from '../types';
import { LOCALE, compactNumber, formatInt, money, percent } from '../lib';
import type { ProviderView } from '../provider-view';
import { recentDayKeys } from './details/cost-math';
import { spreadRunwayLabels } from './details/runway-labels';

// Built once: the charts label dozens of ticks and re-render on every mouse
// move, so constructing a formatter per label was the largest cost of a hover.
const WEEKDAY_DAY = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric' });
const DAY_MONTH = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const WEEKDAY_DAY_MONTH = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const WEEKDAY_DAY_MONTH_TIME = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function linePath(points: { x: number; y: number }[]) {
  if (!points.length) return '';
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/** Local noon today, as a stable number the memoised layouts can key on. */
function todayNoon() {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return today.getTime();
}

function dateLabel(key: string, format: Intl.DateTimeFormat) {
  const [year, month, day] = key.split('-').map(Number);
  return format.format(new Date(year, month - 1, day, 12));
}

/** Weekday labels for short periods; dates once the axis holds more than 45 days. */
function axisFormat(count: number) {
  return count > 45 ? DAY_MONTH : WEEKDAY_DAY;
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

const RUNWAY = { width: 960, height: 360, left: 46, right: 112, top: 22, bottom: 42 };

function observedWindow(points: Point[], startAt: number) {
  const after = points.filter((point) => point.at >= startAt);
  const before = points.filter((point) => point.at < startAt).at(-1);
  return before ? [before, ...after] : after;
}

function boundedValueAt(points: Point[], at: number) {
  if (!points.length || at < points[0].at || at > points.at(-1)!.at) return null;
  return valueAt(points, at);
}

type Anchor = 'start' | 'middle' | 'end';

/**
 * Everything about the runway chart that depends only on the provider views:
 * the shared axis, the tick labels, and one path per series. Hover state
 * re-renders the component without recomputing any of it.
 */
function runwayLayout(views: ProviderView[], height: number) {
  const active = views.filter((view) => {
    const series = view.current?.forecast.series;
    return Boolean(
      !view.expired && series && (series.observed.length || series.expected.length || series.heavy.length),
    );
  });
  if (!active.length) return null;

  const expectedStarts = active
    .map((view) => view.current!.forecast.series.expected[0]?.at)
    .filter((at): at is number => Number.isFinite(at));
  const nowAt = expectedStarts.length
    ? Math.min(...expectedStarts)
    : Math.max(...active.flatMap((view) => view.current!.forecast.series.observed.map((point) => point.at)));
  const forecastEnds = active
    .flatMap((view) => [
      view.current!.forecast.series.expected.at(-1)?.at,
      view.current!.forecast.series.heavy.at(-1)?.at,
    ])
    .filter((at): at is number => Number.isFinite(at));
  const maxAt = forecastEnds.length ? Math.max(...forecastEnds) : nowAt + 86_400_000;
  const historySpan = Math.min(48 * 3_600_000, Math.max(6 * 3_600_000, (maxAt - nowAt) * 0.22));
  const minAt = nowAt - historySpan;
  const plotWidth = RUNWAY.width - RUNWAY.left - RUNWAY.right;
  const plotHeight = height - RUNWAY.top - RUNWAY.bottom;
  const x = (at: number) => RUNWAY.left + ((at - minAt) / Math.max(1, maxAt - minAt)) * plotWidth;
  const y = (remaining: number) => RUNWAY.top + (1 - remaining / 100) * plotHeight;
  const scale = (points: Point[]) => points.map((point) => ({ x: x(point.at), y: y(point.remaining) }));
  const futureSpan = maxAt - nowAt;
  const tickTimes = [minAt, nowAt, nowAt + futureSpan / 3, nowAt + (futureSpan * 2) / 3, maxAt];
  const ticks = tickTimes.map((at, index) => ({
    at,
    label: index === 1 ? 'Now' : WEEKDAY_DAY.format(new Date(at)),
    anchor: (index === 0 ? 'start' : index === tickTimes.length - 1 ? 'end' : 'middle') as Anchor,
  }));
  const series = active.map((view) => {
    const forecast = view.current!.forecast;
    return {
      view,
      forecast,
      observedPath: linePath(scale(observedWindow(forecast.series.observed, minAt))),
      heavyPath: linePath(scale(forecast.series.heavy)),
      expectedPath: linePath(scale(forecast.series.expected)),
      endpoint: forecast.series.expected.at(-1) ?? null,
      heavyEndpoint: forecast.series.heavy.at(-1) ?? null,
    };
  });
  const summary = active
    .map((view) =>
      view.state === 'unknown' || view.expectedRemaining == null || view.heavyRemaining == null
        ? `${view.name}: forecast is learning; observed balance ${percent(view.remaining)}`
        : `${view.name}: expected ${percent(view.expectedRemaining)}, heavier ${percent(view.heavyRemaining)} at its reset`,
    )
    .join('. ');
  const labels = spreadRunwayLabels(
    series.flatMap(({ view, endpoint }) => (endpoint ? [{ view, endpoint, y: y(endpoint.remaining) - 2 }] : [])),
    RUNWAY.top + 12,
    RUNWAY.top + plotHeight - 15,
  );
  return { series, labels, nowAt, minAt, maxAt, x, y, plotWidth, plotHeight, ticks, summary, height };
}

/**
 * The runway panel stretches to the height of the insights column beside it.
 * Follow the canvas box with the viewBox so the plot fills that height with
 * the x-axis on the panel's bottom edge, instead of letterboxing a fixed
 * aspect ratio. Width stays fixed so text and strokes keep their scale.
 */
function useRunwayHeight(): [number, React.RefCallback<HTMLDivElement>] {
  const [height, setHeight] = useState(RUNWAY.height);
  // A callback ref rather than an effect over a ref object: the canvas is not
  // rendered until the first observations exist, and an effect keyed on the
  // ref object ran once, saw no element, and never looked again. Attaching
  // when the element actually appears observes it whenever that happens, and
  // the returned cleanup disconnects when it goes away.
  const attach = useCallback<React.RefCallback<HTMLDivElement>>((canvas) => {
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1) return;
      setHeight(Math.max(RUNWAY.height, Math.round((rect.height / rect.width) * RUNWAY.width)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  return [height, attach];
}

/**
 * One truthful calendar chart for every provider. Series share the same date
 * axis, but each stops at its own reset instead of being stretched to imply
 * that unlike allowance windows end together.
 */
export function CombinedRunwayChart({ views }: { views: ProviderView[] }) {
  const plotClipId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const [canvasHeight, canvasRef] = useRunwayHeight();
  const layout = useMemo(() => runwayLayout(views, canvasHeight), [views, canvasHeight]);
  if (!layout) return <div className="empty-chart tall">Runway appears after the first allowance observations.</div>;
  const { series, labels, nowAt, minAt, maxAt, x, y, plotWidth, plotHeight, ticks, summary, height } = layout;
  const labelX = RUNWAY.width - RUNWAY.right + 16;

  const moveHover = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const canvasX = ((event.clientX - rect.left) / rect.width) * RUNWAY.width;
    const fraction = (canvasX - RUNWAY.left) / plotWidth;
    setHoverAt(fraction < 0 || fraction > 1 ? null : minAt + fraction * (maxAt - minAt));
  };

  const hoverLabel = hoverAt == null ? '' : WEEKDAY_DAY_MONTH_TIME.format(new Date(hoverAt));
  const tipLeft = hoverAt == null ? '0%' : `${Math.min(68, Math.max(2, (x(hoverAt) / RUNWAY.width) * 100 + 1))}%`;

  return (
    <div className="combined-runway-wrap">
      <div className="combined-runway-canvas" ref={canvasRef}>
        <svg
          ref={svgRef}
          className="combined-runway-chart"
          viewBox={`0 0 ${RUNWAY.width} ${height}`}
          role="img"
          aria-label={`Combined allowance runway on a shared calendar axis. ${summary}.`}
          onMouseMove={moveHover}
          onMouseLeave={() => setHoverAt(null)}
        >
          <defs>
            <clipPath id={plotClipId}>
              <rect x={RUNWAY.left} y={RUNWAY.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          {[0, 25, 50, 75, 100].map((value) => (
            <g key={value}>
              <line
                x1={RUNWAY.left}
                x2={RUNWAY.width - RUNWAY.right}
                y1={y(value)}
                y2={y(value)}
                className="grid-line"
              />
              <text x="5" y={y(value) + 4}>
                {value}%
              </text>
            </g>
          ))}
          {ticks.map((tick, index) => (
            <text key={index} x={x(tick.at)} y={height - 12} textAnchor={tick.anchor}>
              {tick.label}
            </text>
          ))}
          <line x1={x(nowAt)} x2={x(nowAt)} y1={RUNWAY.top} y2={RUNWAY.top + plotHeight} className="now-line" />
          {series.map(({ view, observedPath, heavyPath, expectedPath, endpoint, heavyEndpoint }) => (
            <g key={view.id} className={`combined-series ${view.id}`}>
              <g clipPath={`url(#${plotClipId})`}>
                <path d={observedPath} className="combined-observed" />
                <path d={heavyPath} className="combined-heavy" />
                <path d={expectedPath} className="combined-expected" />
              </g>
              {endpoint && (
                <circle cx={x(endpoint.at)} cy={y(endpoint.remaining)} r="3.8" className="combined-endpoint" />
              )}
              {heavyEndpoint && (
                <circle
                  cx={x(heavyEndpoint.at)}
                  cy={y(heavyEndpoint.remaining)}
                  r="2.8"
                  className="combined-heavy-endpoint"
                />
              )}
            </g>
          ))}
          {labels.map(({ view, endpoint, y: labelY }) => (
            <g key={view.id} className={`combined-series ${view.id}`}>
              <line
                className="combined-label-connector"
                x1={x(endpoint.at) + 6}
                y1={y(endpoint.remaining)}
                x2={labelX - 5}
                y2={labelY + 2}
              />
              <text x={labelX} y={labelY} className="combined-end-label">
                <tspan>{view.name}</tspan>
                <tspan x={labelX} dy="13">
                  {Math.round(endpoint.remaining)}%
                </tspan>
              </text>
            </g>
          ))}
          {hoverAt != null && (
            <line
              className="forecast-hover"
              x1={x(hoverAt)}
              x2={x(hoverAt)}
              y1={RUNWAY.top}
              y2={RUNWAY.top + plotHeight}
            />
          )}
        </svg>
      </div>
      {hoverAt != null && (
        <div className="combined-runway-tip" style={{ left: tipLeft }}>
          <strong>{hoverLabel}</strong>
          {series.map(({ view, forecast }) => {
            const observed = boundedValueAt(forecast.series.observed, hoverAt);
            const expected = boundedValueAt(forecast.series.expected, hoverAt);
            const heavy = boundedValueAt(forecast.series.heavy, hoverAt);
            if (observed == null && expected == null && heavy == null) return null;
            return (
              <span key={view.id}>
                <i className={`source-dot ${view.id}`} />
                {view.name}:{' '}
                {observed != null
                  ? `${Math.round(observed)}% observed`
                  : `${expected == null ? '—' : `${Math.round(expected)}% expected`} · ${heavy == null ? '—' : `${Math.round(heavy)}% heavy`}`}
              </span>
            );
          })}
        </div>
      )}
      <details className="chart-data">
        <summary>View runway data</summary>
        <div className="table-scroll">
          <table>
            <caption>Allowance runway observations and projections</caption>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Time</th>
                <th>Series</th>
                <th>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {series.flatMap(({ view, forecast }) =>
                (['observed', 'expected', 'heavy'] as const).flatMap((kind) =>
                  forecast.series[kind]
                    .filter((point) => point.at >= minAt && point.at <= maxAt)
                    .map((point, index) => (
                      <tr key={`${view.id}:${kind}:${index}`}>
                        <td>{view.name}</td>
                        <td>{WEEKDAY_DAY_MONTH_TIME.format(new Date(point.at))}</td>
                        <td>{kind}</td>
                        <td>{percent(point.remaining, 1)}</td>
                      </tr>
                    )),
                ),
              )}
            </tbody>
          </table>
        </div>
      </details>
      <p className="combined-runway-note">Shared calendar · each provider line ends at its own reset</p>
    </div>
  );
}

const COST = { width: 880, height: 270, left: 56, right: 44, top: 20, bottom: 44 };

function costLayout(costs: CostAnalytics, todayMs: number) {
  if (!costs.chart.length) return null;
  const byDate = new Map(costs.chart.map((point) => [point.date, point]));
  const points = recentDayKeys(costs.periodDays, todayMs).map(
    (date) => byDate.get(date) || { date, codex: 0, claude: 0 },
  );
  const max = Math.max(...points.map((point) => point.codex + point.claude), 1) * 1.15;
  const plotWidth = COST.width - COST.left - COST.right;
  const plotHeight = COST.height - COST.top - COST.bottom;
  const x = (index: number) => COST.left + (index * plotWidth) / Math.max(1, points.length - 1);
  const y = (value: number) => COST.top + plotHeight - (value / max) * plotHeight;
  const format = axisFormat(points.length);
  return {
    points,
    x,
    y,
    baseline: y(0),
    plotWidth,
    codexPath: linePath(points.map((point, index) => ({ x: x(index), y: y(point.codex) }))),
    claudePath: linePath(points.map((point, index) => ({ x: x(index), y: y(point.claude) }))),
    totalPath: linePath(points.map((point, index) => ({ x: x(index), y: y(point.codex + point.claude) }))),
    barWidth: Math.max(2, (plotWidth / Math.max(points.length, 1)) * 0.72),
    grid: [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      y: y(max * fraction),
      label: money(max * fraction, costs.currency),
    })),
    ticks: dayTicks(points.length).map((index) => ({
      index,
      date: points[index].date,
      label: dateLabel(points[index].date, format),
    })),
  };
}

export function CostChart({ costs }: { costs: CostAnalytics }) {
  const [mode, setMode] = useState<'lines' | 'stacked'>('stacked');
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const todayMs = todayNoon();
  const layout = useMemo(() => costLayout(costs, todayMs), [costs, todayMs]);
  if (!layout) return <div className="empty-chart tall">Token history will build this cost chart automatically.</div>;
  const { points, x, y, baseline, plotWidth, codexPath, claudePath, totalPath, barWidth, grid, ticks } = layout;
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
        {grid.map((line, index) => (
          <g key={index}>
            <line x1={COST.left} x2={COST.width - COST.right} y1={line.y} y2={line.y} className="grid-line" />
            <text x="4" y={line.y + 4}>
              {line.label}
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
        {ticks.map((tick) => (
          <text key={tick.date} x={x(tick.index)} y={COST.height - 14} textAnchor="middle">
            {tick.label}
          </text>
        ))}
        {hover != null && <line className="forecast-hover" x1={x(hover)} x2={x(hover)} y1={COST.top} y2={baseline} />}
      </svg>
      <details className="chart-data">
        <summary>View cost data</summary>
        <div className="table-scroll">
          <table>
            <caption>Daily API-equivalent cost</caption>
            <thead>
              <tr>
                <th>Date</th>
                <th>Codex</th>
                <th>Claude + Fable</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date}>
                  <td>{dateLabel(point.date, WEEKDAY_DAY_MONTH)}</td>
                  <td>{money(point.codex, costs.currency)}</td>
                  <td>{money(point.claude, costs.currency)}</td>
                  <td>{money(point.codex + point.claude, costs.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {hovered && hover != null && (
        <div className="forecast-tip" style={{ left: `${Math.min(84, Math.max(2, (x(hover) / COST.width) * 100))}%` }}>
          {dateLabel(hovered.date, WEEKDAY_DAY_MONTH)} · total {money(hovered.codex + hovered.claude, costs.currency)} ·
          Codex {money(hovered.codex, costs.currency)} · Claude {money(hovered.claude, costs.currency)}
        </div>
      )}
    </div>
  );
}

// Wider than the cost chart because it spans the full page; the viewBox keeps
// its text at a sensible on-screen size once scaled to the panel.
const DAILY = { width: 1320, height: 300, left: 64, right: 40, top: 14, bottom: 40 };

function dailyLayout(rows: DailyUsage[], days: number, todayMs: number) {
  if (!rows.length) return null;
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.date, (totals.get(row.date) || 0) + Number(row.tokens || 0));
  const points = recentDayKeys(days, todayMs).map((date) => ({ date, tokens: totals.get(date) || 0 }));
  const max = Math.max(...points.map((point) => point.tokens), 1);
  const plotWidth = DAILY.width - DAILY.left - DAILY.right;
  const plotHeight = DAILY.height - DAILY.top - DAILY.bottom;
  const baseline = DAILY.top + plotHeight;
  const format = axisFormat(points.length);
  return {
    points,
    max,
    plotHeight,
    baseline,
    slot: plotWidth / Math.max(points.length, 1),
    grid: [0, 0.5, 1].map((fraction) => ({
      y: baseline - plotHeight * fraction,
      label: compactNumber(max * fraction),
    })),
    ticks: dayTicks(points.length).map((index) => ({
      index,
      date: points[index].date,
      label: dateLabel(points[index].date, format),
    })),
  };
}

export function DailyUsageChart({ rows, days }: { rows: DailyUsage[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const todayMs = todayNoon();
  const layout = useMemo(() => dailyLayout(rows, days, todayMs), [rows, days, todayMs]);
  if (!layout)
    return <div className="empty-chart">Daily account usage will appear when the local Codex service supplies it.</div>;
  const { points, max, plotHeight, baseline, slot, grid, ticks } = layout;
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
        {grid.map((line, index) => (
          <g key={index}>
            <line x1={DAILY.left} x2={DAILY.width - DAILY.right} y1={line.y} y2={line.y} className="grid-line" />
            <text x="4" y={line.y + 4}>
              {line.label}
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
        {ticks.map((tick) => (
          <text key={tick.date} x={DAILY.left + tick.index * slot + slot / 2} y={DAILY.height - 10} textAnchor="middle">
            {tick.label}
          </text>
        ))}
      </svg>
      <details className="chart-data">
        <summary>View daily token data</summary>
        <div className="table-scroll">
          <table>
            <caption>Official daily Codex token usage</caption>
            <thead>
              <tr>
                <th>Date</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date}>
                  <td>{dateLabel(point.date, WEEKDAY_DAY_MONTH)}</td>
                  <td>{formatInt(point.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {hovered && hover != null && (
        <div
          className="forecast-tip"
          style={{ left: `${Math.min(84, Math.max(2, ((DAILY.left + hover * slot) / DAILY.width) * 100))}%` }}
        >
          {dateLabel(hovered.date, WEEKDAY_DAY_MONTH)} · {formatInt(hovered.tokens)} tokens
        </div>
      )}
    </div>
  );
}
