/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions -- Pointer tooltips supplement the keyboard-accessible data tables for each SVG. */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { inactiveRanges, isActiveAt, type Schedule } from '../budget';
import { niceScale } from '../chart-scale';
import type { CostAnalytics, DailyUsage, Point } from '../types';
import { LOCALE, compactNumber, dateTimeLabel, formatInt, money, percent, whenLabel } from '../lib';
import type { ProviderView } from '../provider-view';
import { recentDayKeys } from './details/cost-math';
import { spreadRunwayLabels } from './details/runway-labels';

// Built once: the charts label dozens of ticks and re-render on every mouse
// move, so constructing a formatter per label was the largest cost of a hover.
const WEEKDAY = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const WEEKDAY_DAY = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric' });
const HOUR = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
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

const RUNWAY_SIZES = {
  compact: { width: 360, height: 150, left: 32, right: 38, top: 10, bottom: 22, labelGap: 13, yTicks: [0, 50, 100] },
  full: {
    width: 800,
    height: 300,
    left: 42,
    right: 50,
    top: 24,
    bottom: 28,
    labelGap: 15,
    yTicks: [0, 25, 50, 75, 100],
  },
} as const;

export type RunwaySize = keyof typeof RUNWAY_SIZES;

function observedWindow(points: Point[], startAt: number) {
  const after = points.filter((point) => point.at >= startAt);
  const before = points.filter((point) => point.at < startAt).at(-1);
  return before ? [before, ...after] : after;
}

function boundedValueAt(points: Point[], at: number) {
  if (!points.length || at < points[0].at || at > points.at(-1)!.at) return null;
  return valueAt(points, at);
}

/** The instant the headline window opened: its reset minus its length, or its first reading. */
function windowStartOf(view: ProviderView) {
  const current = view.current!;
  const resetAt = Date.parse(current.resetsAt);
  if (current.windowMinutes && current.windowMinutes > 0 && Number.isFinite(resetAt)) {
    return resetAt - current.windowMinutes * 60_000;
  }
  return current.forecast.series.observed[0]?.at ?? resetAt - 7 * 86_400_000;
}

/** Whether a view has an expected and heavier projection worth drawing. */
function hasProjection(view: ProviderView) {
  return view.state !== 'unknown' && view.expectedRemaining != null && view.heavyRemaining != null;
}

export function runwaySummary(view: ProviderView) {
  const forecast = view.current?.forecast;
  if (!forecast || !hasProjection(view)) {
    return `${view.name}: forecast is learning; observed balance ${percent(view.remaining)}`;
  }
  const heavier = forecast.heavyExhaustsAt
    ? `a heavier week runs out ${dateTimeLabel(forecast.heavyExhaustsAt)}`
    : `a heavier week leaves ${percent(view.heavyRemaining)}`;
  const expected = forecast.exhaustsAt
    ? `expected to run out ${dateTimeLabel(forecast.exhaustsAt)}`
    : `expected ${percent(view.expectedRemaining)} at reset`;
  return `${view.name}: ${percent(view.remaining)} left now; ${expected}; ${heavier}`;
}

/**
 * Everything the runway needs that depends only on the view and schedule. The
 * axis runs from the window's opening to its own reset, so each provider is
 * drawn on its own clock rather than stretched onto another's calendar.
 */
function runwayLayout(view: ProviderView, schedule: Schedule, size: RunwaySize, width: number) {
  const current = view.current;
  if (!current || view.expired) return null;
  const { observed, expected, heavy } = current.forecast.series;
  if (!observed.length && !expected.length && !heavy.length) return null;
  // The viewBox follows the rendered width, so labels keep their size on a
  // narrow card and on a full-width one; the height grows gently with it.
  const base = RUNWAY_SIZES[size];
  const height =
    size === 'full'
      ? Math.round(Math.min(380, Math.max(base.height, width * 0.36)))
      : Math.round(Math.min(220, Math.max(base.height, width * 0.4)));
  const dims = { ...base, width, height };
  const projection = hasProjection(view);
  const resetAt = Date.parse(current.resetsAt);
  const nowAt = expected[0]?.at ?? observed.at(-1)?.at ?? resetAt;
  const lastProjection = projection ? Math.max(expected.at(-1)?.at ?? 0, heavy.at(-1)?.at ?? 0) : 0;
  const maxAt = Math.max(Number.isFinite(resetAt) ? resetAt : 0, lastProjection, nowAt + 3_600_000);
  const minAt = Math.min(windowStartOf(view), nowAt - 3_600_000);
  const plotWidth = dims.width - dims.left - dims.right;
  const plotHeight = dims.height - dims.top - dims.bottom;
  const x = (at: number) => dims.left + ((at - minAt) / Math.max(1, maxAt - minAt)) * plotWidth;
  const y = (remaining: number) => dims.top + (1 - Math.max(0, Math.min(100, remaining)) / 100) * plotHeight;
  const scale = (points: Point[]) => points.map((point) => ({ x: x(point.at), y: y(point.remaining) }));
  const expectedPoints = projection ? expected : [];
  const heavyPoints = projection ? heavy : [];
  // The band runs out along the expected path and back along the heavier one.
  // Copy first; toReversed needs the ES2023 lib the renderer does not target.
  // oxlint-disable-next-line unicorn/no-array-reverse
  const heavyBack = scale([...heavyPoints].reverse());
  const band =
    expectedPoints.length && heavyPoints.length
      ? `${linePath(scale(expectedPoints))} ${heavyBack.map((point) => `L${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')} Z`
      : '';
  const inactive = inactiveRanges(minAt, maxAt, schedule).map((range) => ({
    x: x(range.from),
    width: Math.max(0, x(range.to) - x(range.from)),
  }));
  const span = maxAt - minAt;
  const ticks: { at: number; label: string }[] = [];
  if (span <= 2 * 86_400_000) {
    const first = new Date(minAt);
    first.setMinutes(0, 0, 0);
    const stepHours = span <= 8 * 3_600_000 ? 1 : 6;
    for (let at = first.getTime(); at <= maxAt; at += 3_600_000) {
      if (at >= minAt && new Date(at).getHours() % stepHours === 0)
        ticks.push({ at, label: HOUR.format(new Date(at)) });
    }
  } else {
    const day = new Date(minAt);
    day.setHours(12, 0, 0, 0);
    for (let at = day.getTime(); at <= maxAt;) {
      if (at >= minAt) ticks.push({ at, label: (size === 'full' ? WEEKDAY_DAY : WEEKDAY).format(new Date(at)) });
      const next = new Date(at);
      next.setDate(next.getDate() + 1);
      at = next.getTime();
    }
  }
  const expectedEnd = expectedPoints.at(-1) ?? null;
  const heavyEnd = heavyPoints.at(-1) ?? null;
  // Spaced at render time, once the heavier label is known to be shown or not.
  const endLabels = [
    ...(expectedEnd ? [{ kind: 'expected' as const, value: expectedEnd.remaining, y: y(expectedEnd.remaining) }] : []),
    ...(heavyEnd ? [{ kind: 'heavy' as const, value: heavyEnd.remaining, y: y(heavyEnd.remaining) }] : []),
  ];
  const inRange = (value?: string | null) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isFinite(at) && at >= nowAt && at <= maxAt ? at : null;
  };
  return {
    dims,
    projection,
    nowAt,
    minAt,
    maxAt,
    x,
    y,
    plotWidth,
    plotHeight,
    observedPath: linePath(scale(observedWindow(observed, minAt))),
    expectedPath: linePath(scale(expectedPoints)),
    heavyPath: linePath(scale(heavyPoints)),
    band,
    inactive,
    ticks,
    endLabels,
    // The card's balance: after a stale reading that is the estimate the
    // expected path starts from, not the last observation.
    nowValue: view.remaining ?? valueAt(observed, nowAt),
    exhaustsAt: projection ? inRange(current.forecast.exhaustsAt) : null,
    heavyExhaustsAt: projection ? inRange(current.forecast.heavyExhaustsAt) : null,
  };
}

/**
 * The rendered width of a chart's box, so its viewBox can match it one to one.
 * A callback ref attaches whenever the element appears; server rendering and
 * browsers without ResizeObserver keep the initial width.
 */
function useMeasuredWidth(initial: number): [number, React.RefCallback<HTMLDivElement>] {
  const [width, setWidth] = useState(initial);
  const attach = useCallback<React.RefCallback<HTMLDivElement>>((node) => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const measured = node.getBoundingClientRect().width;
      if (measured >= 1) setWidth(Math.round(Math.max(280, Math.min(1600, measured))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [width, attach];
}

/**
 * One provider's allowance on its own clock: what was used so far, the expected
 * path to the reset, and the range a heavier week could take. Hours outside the
 * active schedule are shaded, which is why the projections flatten overnight.
 */
export function RunwayChart({
  view,
  schedule,
  size = 'compact',
  showHeavy = true,
  reserve = 0,
}: {
  view: ProviderView;
  schedule: Schedule;
  size?: RunwaySize;
  showHeavy?: boolean;
  reserve?: number;
}) {
  const clipId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const [width, measure] = useMeasuredWidth(RUNWAY_SIZES[size].width);
  const layout = useMemo(() => runwayLayout(view, schedule, size, width), [view, schedule, size, width]);
  if (!view.current || view.expired) return null;
  if (!layout)
    return <div className="empty-chart runway-empty">Runway appears after the first allowance observations.</div>;
  const { dims, projection, nowAt, minAt, maxAt, x, y, plotWidth, plotHeight, ticks, endLabels, nowValue } = layout;
  const forecast = view.current.forecast;
  const interactive = size === 'full';
  const labelX = dims.left + plotWidth + 6;

  const moveHover = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const fraction = (((event.clientX - rect.left) / rect.width) * dims.width - dims.left) / plotWidth;
    setHoverAt(fraction < 0 || fraction > 1 ? null : minAt + fraction * (maxAt - minAt));
  };
  const hover =
    hoverAt == null
      ? null
      : {
          observed: hoverAt <= nowAt ? boundedValueAt(forecast.series.observed, hoverAt) : null,
          expected: projection && hoverAt >= nowAt ? boundedValueAt(forecast.series.expected, hoverAt) : null,
          heavy: projection && showHeavy && hoverAt >= nowAt ? boundedValueAt(forecast.series.heavy, hoverAt) : null,
        };

  return (
    <figure className={`runway-figure ${size}`}>
      <div className="runway-canvas" ref={measure}>
        <svg
          ref={svgRef}
          className={`runway-chart ${size} ${view.id}`}
          viewBox={`0 0 ${dims.width} ${dims.height}`}
          role="img"
          aria-label={`${runwaySummary(view)}.`}
          onMouseMove={interactive ? moveHover : undefined}
          onMouseLeave={interactive ? () => setHoverAt(null) : undefined}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={dims.left} y={dims.top - 1} width={plotWidth} height={plotHeight + 2} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            {layout.inactive.map((range) => (
              <rect
                key={range.x}
                className="runway-inactive"
                x={range.x}
                y={dims.top}
                width={range.width}
                height={plotHeight}
              />
            ))}
          </g>
          {dims.yTicks.map((value) => (
            <g key={value}>
              <line
                x1={dims.left}
                x2={dims.left + plotWidth}
                y1={y(value)}
                y2={y(value)}
                className={value === 0 ? 'grid-line baseline' : 'grid-line'}
              />
              <text className="runway-axis" x="0" y={y(value) + 3.5}>
                {value}%
              </text>
            </g>
          ))}
          {reserve > 0 && (
            <g className="runway-reserve">
              <line x1={dims.left} x2={dims.left + plotWidth} y1={y(reserve)} y2={y(reserve)} />
              <text x={dims.left + 4} y={y(reserve) - 5}>
                Reserve {Math.round(reserve)}%
              </text>
            </g>
          )}
          <g clipPath={`url(#${clipId})`}>
            {showHeavy && layout.band && <path d={layout.band} className="runway-band" />}
            {showHeavy && <path d={layout.heavyPath} className="runway-heavy" />}
            <path d={layout.expectedPath} className="runway-expected" />
            <path d={layout.observedPath} className="runway-observed" />
          </g>
          <line x1={x(nowAt)} x2={x(nowAt)} y1={dims.top} y2={dims.top + plotHeight} className="now-line" />
          {size === 'full' && (
            <text className="runway-axis" x={x(nowAt)} y={dims.top - 8} textAnchor="middle">
              Now
            </text>
          )}
          {nowValue != null && (
            <circle className="runway-now" cx={x(nowAt)} cy={y(nowValue)} r={size === 'full' ? 5 : 4} />
          )}
          {showHeavy && layout.heavyExhaustsAt != null && (
            <g className="runway-exhaust heavy">
              <circle cx={x(layout.heavyExhaustsAt)} cy={y(0)} r={size === 'full' ? 5 : 4} />
              {size === 'full' && (
                <text
                  x={x(layout.heavyExhaustsAt)}
                  y={y(0) - 12}
                  // Near the reset the label would run into the end labels, so it reads leftwards.
                  textAnchor={x(layout.heavyExhaustsAt) > dims.left + plotWidth * 0.7 ? 'end' : 'middle'}
                >
                  Heavier week runs out {whenLabel(layout.heavyExhaustsAt, nowAt)}
                </text>
              )}
            </g>
          )}
          {layout.exhaustsAt != null && (
            <g className="runway-exhaust expected">
              <circle cx={x(layout.exhaustsAt)} cy={y(0)} r={size === 'full' ? 5 : 4} />
            </g>
          )}
          {spreadRunwayLabels(
            endLabels.filter((label) => label.kind === 'expected' || showHeavy),
            dims.top + 6,
            dims.top + plotHeight,
            dims.labelGap,
          ).map((label) => (
            <text key={label.kind} className={`runway-end ${label.kind}`} x={labelX} y={label.y + 3.5}>
              {Math.round(label.value)}%
            </text>
          ))}
          {ticks.map((tick) => (
            <text key={tick.at} className="runway-axis" x={x(tick.at)} y={dims.height - 6} textAnchor="middle">
              {tick.label}
            </text>
          ))}
          {hoverAt != null && (
            <line className="forecast-hover" x1={x(hoverAt)} x2={x(hoverAt)} y1={dims.top} y2={dims.top + plotHeight} />
          )}
        </svg>
        {hover && hoverAt != null && (
          <div
            className="runway-tip"
            style={{ left: `${Math.min(74, Math.max(1, (x(hoverAt) / dims.width) * 100 + 1.5))}%` }}
          >
            <strong>{WEEKDAY_DAY_MONTH_TIME.format(new Date(hoverAt))}</strong>
            {hover.observed != null && <span>Observed · {Math.round(hover.observed)}% left</span>}
            {hover.expected != null && <span>Expected · {Math.round(hover.expected)}% left</span>}
            {hover.heavy != null && <span>Heavier week · {Math.round(hover.heavy)}% left</span>}
            <small>{isActiveAt(hoverAt, schedule) ? 'Inside your active hours' : 'Outside active hours'}</small>
          </div>
        )}
      </div>
      {size === 'full' && (
        <details className="chart-data">
          <summary>View runway data</summary>
          <div className="table-scroll">
            <table>
              <caption>{view.name} allowance observations and projections</caption>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Series</th>
                  <th>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {(['observed', 'expected', 'heavy'] as const).flatMap((kind) =>
                  kind !== 'observed' && !projection
                    ? []
                    : forecast.series[kind]
                        .filter((point) => point.at >= minAt && point.at <= maxAt)
                        .map((point, index) => (
                          <tr key={`${kind}:${index}`}>
                            <td>{WEEKDAY_DAY_MONTH_TIME.format(new Date(point.at))}</td>
                            <td>{kind === 'heavy' ? 'heavier week' : kind}</td>
                            <td>{percent(point.remaining, 1)}</td>
                          </tr>
                        )),
                )}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

const axisMoneyFormats = new Map<string, Intl.NumberFormat>();

/** Axis money: whole units when every step is whole ("£20"), otherwise pence ("£2.50"). */
function axisMoney(value: number, currency: string, step: number) {
  const digits = Number.isInteger(step) ? 0 : 2;
  const key = `${currency}|${digits}`;
  let format = axisMoneyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    axisMoneyFormats.set(key, format);
  }
  return format.format(value);
}

const COST = { width: 880, height: 270, left: 56, right: 44, top: 20, bottom: 44 };

function costLayout(costs: CostAnalytics, todayMs: number) {
  if (!costs.chart.length) return null;
  const byDate = new Map(costs.chart.map((point) => [point.date, point]));
  const points = recentDayKeys(costs.periodDays, todayMs).map(
    (date) => byDate.get(date) || { date, codex: 0, claude: 0 },
  );
  const axis = niceScale(Math.max(...points.map((point) => point.codex + point.claude), 0.01));
  const max = axis.max;
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
    grid: axis.ticks.map((value) => ({
      y: y(value),
      label: axisMoney(value, costs.currency, axis.step),
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
  const axis = niceScale(Math.max(...points.map((point) => point.tokens), 1));
  const max = axis.max;
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
    grid: axis.ticks.map((value) => ({
      y: baseline - plotHeight * (value / max),
      label: compactNumber(value),
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
