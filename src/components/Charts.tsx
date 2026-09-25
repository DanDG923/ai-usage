/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions -- Pointer tooltips supplement the keyboard-accessible data tables for each SVG. */
import { ChevronRight } from 'lucide-react';
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

// The icon set's warning triangle and critical octagon (24-unit grid), drawn
// inside SVG annotations where a component icon cannot go.
const ICON_CAUTION =
  'M10.3 4.2L2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z M12 9.5v4.5 M12 17.3v.2';
const ICON_WARNING = 'M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z M12 8v5 M12 16.2v.2';

function linePath(points: { x: number; y: number }[]) {
  if (!points.length) return '';
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/** A square turned on its corner: the heavier-week glyph wherever it appears. */
function diamond(cx: number, cy: number, size: number) {
  const x = cx.toFixed(1);
  const y = cy.toFixed(1);
  return `M${x},${(cy - size).toFixed(1)} L${(cx + size).toFixed(1)},${y} L${x},${(cy + size).toFixed(1)} L${(cx - size).toFixed(1)},${y} Z`;
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

// At most eight day labels, and at least this far apart (px between label
// centres) at the rendered width: a 10px B612 Mono label such as "Mon 21" or
// "21 Sept" is about 42px wide, and the last one is anchored at its end.
const MAX_DAY_LABELS = 8;
const DAY_LABEL_SPACING = 80;

/** Indices to label along a day axis so labels never crowd; `slot` is one day's width in px. */
function dayTicks(count: number, slot: number) {
  const step = Math.max(1, Math.ceil(count / MAX_DAY_LABELS), Math.ceil(DAY_LABEL_SPACING / Math.max(1, slot)));
  const ticks: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) ticks.unshift(index);
  return ticks;
}

/**
 * Where a hover readout sits: beside the guide while it is in the left part of
 * the chart, and mirrored to the other side once the guide passes 60%, so the
 * box never runs off the chart. `gap` is the distance from the guide to the
 * box's near edge; a negative gap lets the box overhang the guide instead.
 */
function tipStyle(x: number, width: number, top: number, gap: number): React.CSSProperties {
  const at = `${((x / Math.max(1, width)) * 100).toFixed(2)}%`;
  return x > width * 0.6
    ? { top, left: `calc(${at} - ${gap}px)`, transform: 'translateX(-100%)' }
    : { top, left: `calc(${at} + ${gap}px)` };
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

// Padding is sized for B612 Mono: the top holds the NOW and RESET captions,
// the left the right-aligned "100%" ticks, and the right the fuel tape at the
// reset plus leader lines and 12px end labels ("100%" is about 29px wide).
const RUNWAY_SIZES = {
  compact: { width: 360, height: 180, left: 38, right: 58, top: 22, bottom: 26, labelGap: 16, yTicks: [0, 50, 100] },
  full: {
    width: 800,
    height: 330,
    left: 48,
    right: 74,
    top: 34,
    bottom: 36,
    labelGap: 16,
    yTicks: [0, 25, 50, 75, 100],
  },
} as const;

/** The full chart writes each run-out as a line under the plot; each line adds this much height. */
const NOTE_LINE = 24;
/** Half the fuel tape's width; the tape is centred on the reset. */
const TAPE_HALF = 6;

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
  const projection = hasProjection(view);
  const resetAt = Date.parse(current.resetsAt);
  const nowAt = expected[0]?.at ?? observed.at(-1)?.at ?? resetAt;
  const lastProjection = projection ? Math.max(expected.at(-1)?.at ?? 0, heavy.at(-1)?.at ?? 0) : 0;
  const maxAt = Math.max(Number.isFinite(resetAt) ? resetAt : 0, lastProjection, nowAt + 3_600_000);
  const minAt = Math.min(windowStartOf(view), nowAt - 3_600_000);
  const inRange = (value?: string | null) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isFinite(at) && at >= nowAt && at <= maxAt ? at : null;
  };
  const exhaustsAt = projection ? inRange(current.forecast.exhaustsAt) : null;
  const heavyExhaustsAt = projection ? inRange(current.forecast.heavyExhaustsAt) : null;
  // The viewBox follows the rendered width, so labels keep their size on a
  // narrow card and on a full-width one; the height grows gently with it. The
  // full chart keeps a line under the plot for each run-out, also while the
  // heavier range is hidden, so toggling the range never moves the chart.
  const base = RUNWAY_SIZES[size];
  const notes = size === 'full' ? (exhaustsAt != null ? 1 : 0) + (heavyExhaustsAt != null ? 1 : 0) : 0;
  const frame =
    size === 'full'
      ? Math.round(Math.min(420, Math.max(base.height, width * 0.415)))
      : Math.round(Math.min(240, Math.max(base.height, width * 0.5)));
  const dims = { ...base, width, height: frame + notes * NOTE_LINE, bottom: base.bottom + notes * NOTE_LINE };
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
  // A faint line at each local midnight, so a night band reads as "the night of" a day.
  const midnights: number[] = [];
  const midnight = new Date(minAt);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);
  while (midnight.getTime() < maxAt) {
    midnights.push(x(midnight.getTime()));
    midnight.setDate(midnight.getDate() + 1);
  }
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
  const plotRight = dims.left + plotWidth;
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
    midnights,
    ticks,
    endLabels,
    // The destination: the fuel tape and the end labels stand at the reset.
    hasReset: Number.isFinite(resetAt),
    resetX: Number.isFinite(resetAt) ? Math.max(dims.left, Math.min(plotRight, x(resetAt))) : plotRight,
    // The card's balance: after a stale reading that is the estimate the
    // expected path starts from, not the last observation.
    nowValue: view.remaining ?? valueAt(observed, nowAt),
    exhaustsAt,
    heavyExhaustsAt,
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
 * One provider's allowance on its own clock, drawn as a flight plan that lands
 * on a fuel tape: what was used so far, the expected path to the reset and the
 * range a heavier week could take, then at the reset a tape showing what is
 * likely to be left and what is likely to be used before it. Hours outside the
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
  const plotBottom = dims.top + plotHeight;
  const { resetX } = layout;
  const tapeX = resetX - TAPE_HALF;
  const nowX = x(nowAt);
  // The tape reads the card's own figures, so it always agrees with them.
  const expectedAtReset = projection ? view.expectedRemaining : null;
  const heavyAtReset = projection && showHeavy ? view.heavyRemaining : null;
  const labelX = resetX + 18;
  const rings = [
    ...(showHeavy && layout.heavyExhaustsAt != null ? [x(layout.heavyExhaustsAt)] : []),
    ...(layout.exhaustsAt != null ? [x(layout.exhaustsAt)] : []),
  ];
  const placedLabels = spreadRunwayLabels(
    endLabels.filter((label) => label.kind === 'expected' || showHeavy).map((label) => ({ ...label, from: label.y })),
    dims.top,
    plotBottom,
    dims.labelGap,
  );
  const notes = [
    ...(layout.exhaustsAt != null
      ? [{ kind: 'expected' as const, text: `Expected to run out ${whenLabel(layout.exhaustsAt, nowAt)}` }]
      : []),
    ...(showHeavy && layout.heavyExhaustsAt != null
      ? [{ kind: 'heavy' as const, text: `Heavier week runs out ${whenLabel(layout.heavyExhaustsAt, nowAt)}` }]
      : []),
  ];

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
  const rows =
    size === 'full'
      ? (['observed', 'expected', 'heavy'] as const).flatMap((kind) =>
          kind !== 'observed' && !projection
            ? []
            : forecast.series[kind]
                .filter((point) => point.at >= minAt && point.at <= maxAt)
                .map((point, index) => ({ kind, point, key: `${kind}:${index}` })),
        )
      : [];

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
            {layout.midnights.map((at) => (
              <line key={at} className="runway-midnight" x1={at} x2={at} y1={dims.top} y2={plotBottom} />
            ))}
          </g>
          {dims.yTicks.map((value) => (
            <g key={value}>
              <line
                x1={dims.left}
                x2={dims.left + plotWidth}
                y1={y(value)}
                y2={y(value)}
                className={value === 0 ? 'runway-grid baseline' : 'runway-grid'}
              />
              <text className="runway-axis" x={dims.left - 8} y={y(value) + 3.5} textAnchor="end">
                {value}%
              </text>
            </g>
          ))}
          <g clipPath={`url(#${clipId})`}>
            {showHeavy && layout.band && <path d={layout.band} className="runway-band" />}
            {showHeavy && <path d={layout.heavyPath} className="runway-heavy" />}
            <path d={layout.expectedPath} className="runway-expected" />
            <path d={layout.observedPath} className="runway-observed" />
          </g>
          <line x1={nowX} x2={nowX} y1={dims.top - 10} y2={plotBottom} className="now-line" />
          {(!layout.hasReset || Math.abs(nowX - resetX) >= 42) && (
            <text className="runway-cap" x={Math.max(dims.left + 12, nowX)} y={dims.top - 14} textAnchor="middle">
              NOW
            </text>
          )}
          {nowValue != null && <circle className="runway-now" cx={nowX} cy={y(nowValue)} r="4" />}
          <g className="runway-tape">
            <rect className="runway-tape-well" x={tapeX} y={dims.top} width={TAPE_HALF * 2} height={plotHeight} />
            {nowValue != null && expectedAtReset != null && (
              <>
                <rect
                  className="runway-tape-used"
                  x={tapeX}
                  y={y(nowValue)}
                  width={TAPE_HALF * 2}
                  height={Math.max(0, y(expectedAtReset) - y(nowValue))}
                />
                <rect
                  className="runway-tape-reset"
                  x={tapeX}
                  y={y(expectedAtReset)}
                  width={TAPE_HALF * 2}
                  height={Math.max(0, plotBottom - y(expectedAtReset))}
                />
              </>
            )}
            {nowValue != null && expectedAtReset == null && (
              // Without a forecast the balance is outlined: neither what is left
              // at the reset nor what is used before it is known yet.
              <rect
                className="runway-tape-balance"
                x={tapeX + 0.5}
                y={y(nowValue)}
                width={TAPE_HALF * 2 - 1}
                height={Math.max(0, plotBottom - y(nowValue) - 0.5)}
              />
            )}
          </g>
          {reserve > 0 && (
            <g className="runway-reserve">
              <line x1={dims.left} x2={dims.left + plotWidth} y1={y(reserve)} y2={y(reserve)} />
              <line className="runway-bingo" x1={tapeX - 5} x2={tapeX + 17} y1={y(reserve)} y2={y(reserve)} />
              <text x={dims.left + 6} y={y(reserve) - 5}>
                Reserve {Math.round(reserve)}%
              </text>
            </g>
          )}
          {nowValue != null && (
            <path
              className="runway-tape-pointer"
              d={`M${(tapeX - 1).toFixed(1)},${y(nowValue).toFixed(1)} l-7,-5 v10 z`}
            />
          )}
          {layout.hasReset && (
            <text className="runway-cap" x={resetX} y={dims.top - 14} textAnchor="middle">
              RESET
            </text>
          )}
          {placedLabels.map((label) => (
            <g key={label.kind} className={`runway-end-label ${label.kind}`}>
              <path
                className="runway-leader"
                d={`M${(resetX + 8).toFixed(1)},${label.from.toFixed(1)} L${(labelX - 3).toFixed(1)},${label.y.toFixed(1)}`}
              />
              {label.kind === 'expected' ? (
                <circle className="runway-glyph expected" cx={labelX + 3} cy={label.y} r="3" />
              ) : (
                <path className="runway-glyph heavy" d={diamond(labelX + 3, label.y, 4)} />
              )}
              <text className={`runway-end ${label.kind}`} x={labelX + 10} y={label.y + 4}>
                {Math.round(label.value)}%
              </text>
            </g>
          ))}
          {expectedAtReset != null && (
            <circle className="runway-bug expected" cx={resetX} cy={y(expectedAtReset)} r="4.5" />
          )}
          {heavyAtReset != null && <path className="runway-bug heavy" d={diamond(resetX, y(heavyAtReset), 6)} />}
          {showHeavy && layout.heavyExhaustsAt != null && (
            <g className="runway-exhaust heavy">
              <circle className="runway-ring" cx={x(layout.heavyExhaustsAt)} cy={y(0)} r="9" />
            </g>
          )}
          {layout.exhaustsAt != null && (
            <g className="runway-exhaust expected">
              <circle className="runway-ring" cx={x(layout.exhaustsAt)} cy={y(0)} r="9" />
            </g>
          )}
          {ticks
            // A run-out ring on the baseline would sit on top of a day label right under it.
            .filter((tick) => !rings.some((ringX) => Math.abs(ringX - x(tick.at)) < 14))
            .map((tick) => (
              <text key={tick.at} className="runway-axis" x={x(tick.at)} y={plotBottom + 18} textAnchor="middle">
                {tick.label}
              </text>
            ))}
          {size === 'full' &&
            notes.map((note, index) => (
              <g
                key={note.kind}
                className={`runway-note ${note.kind}`}
                transform={`translate(${(resetX + 60).toFixed(1)} ${plotBottom + 44 + index * NOTE_LINE})`}
              >
                <svg x="-16" y="-12" width="15" height="15" viewBox="0 0 24 24">
                  <path d={note.kind === 'heavy' ? ICON_CAUTION : ICON_WARNING} />
                </svg>
                <text x="-22" y="0" textAnchor="end">
                  {note.text}
                </text>
              </g>
            ))}
          {hover && hoverAt != null && (
            <g className="runway-hover">
              <line className="chart-hover-line" x1={x(hoverAt)} x2={x(hoverAt)} y1={dims.top} y2={plotBottom} />
              {hover.observed != null && (
                <circle className="runway-hover-mark observed" cx={x(hoverAt)} cy={y(hover.observed)} r="4" />
              )}
              {hover.heavy != null && (
                <path className="runway-hover-mark heavy" d={diamond(x(hoverAt), y(hover.heavy), 5)} />
              )}
              {hover.expected != null && (
                <circle className="runway-hover-mark expected" cx={x(hoverAt)} cy={y(hover.expected)} r="4" />
              )}
            </g>
          )}
        </svg>
        {hover && hoverAt != null && (
          <div className={`chart-tip ${view.id}`} style={tipStyle(x(hoverAt), dims.width, dims.top + 6, 14)}>
            <strong>{WEEKDAY_DAY_MONTH_TIME.format(new Date(hoverAt))}</strong>
            {hover.observed != null && (
              <span>
                <i className="tip-glyph observed" aria-hidden="true" />
                Observed · {Math.round(hover.observed)}% left
              </span>
            )}
            {hover.expected != null && (
              <span>
                <i className="tip-glyph expected" aria-hidden="true" />
                Expected · {Math.round(hover.expected)}% left
              </span>
            )}
            {hover.heavy != null && (
              <span>
                <i className="tip-glyph heavy" aria-hidden="true" />
                Heavier week · {Math.round(hover.heavy)}% left
              </span>
            )}
            <small>{isActiveAt(hoverAt, schedule) ? 'Inside your active hours' : 'Outside active hours'}</small>
          </div>
        )}
      </div>
      {size === 'full' && (
        <details className="chart-data">
          <summary>
            <ChevronRight aria-hidden="true" />
            View runway data <span className="chart-data-count">· {rows.length} rows</span>
          </summary>
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
                {rows.map(({ kind, point, key }) => (
                  <tr key={key}>
                    <td>{WEEKDAY_DAY_MONTH_TIME.format(new Date(point.at))}</td>
                    <td>{kind === 'heavy' ? 'heavier week' : kind}</td>
                    <td>{percent(point.remaining, 1)}</td>
                  </tr>
                ))}
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

/** Anchor for a day label: the outermost labels keep inside the chart instead of centring off its edge. */
function dayAnchor(x: number, width: number) {
  if (x < 26) return 'start';
  if (x > width - 26) return 'end';
  return 'middle';
}

// The top holds the hover readout above the bars, with a leader down to the
// hovered day, so the readout never covers the data it describes.
const COST = { width: 880, height: 340, left: 48, right: 8, top: 80, bottom: 30 };

function costLayout(costs: CostAnalytics, todayMs: number, width: number) {
  if (!costs.chart.length) return null;
  const byDate = new Map(costs.chart.map((point) => [point.date, point]));
  const points = recentDayKeys(costs.periodDays, todayMs).map(
    (date) => byDate.get(date) || { date, codex: 0, claude: 0 },
  );
  const axis = niceScale(Math.max(...points.map((point) => point.codex + point.claude), 0.01));
  const max = axis.max;
  const plotWidth = width - COST.left - COST.right;
  const plotHeight = COST.height - COST.top - COST.bottom;
  const slot = plotWidth / Math.max(points.length, 1);
  const x = (index: number) => COST.left + slot * (index + 0.5);
  const y = (value: number) => COST.top + plotHeight - (value / max) * plotHeight;
  const format = axisFormat(points.length);
  return {
    points,
    x,
    y,
    slot,
    baseline: y(0),
    plotWidth,
    plotHeight,
    codexPath: linePath(points.map((point, index) => ({ x: x(index), y: y(point.codex) }))),
    claudePath: linePath(points.map((point, index) => ({ x: x(index), y: y(point.claude) }))),
    totalPath: linePath(points.map((point, index) => ({ x: x(index), y: y(point.codex + point.claude) }))),
    barWidth: Math.max(2, Math.min(32, slot * 0.66)),
    grid: axis.ticks.map((value) => ({
      y: y(value),
      label: axisMoney(value, costs.currency, axis.step),
    })),
    ticks: dayTicks(points.length, slot).map((index) => ({
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
  const [width, measure] = useMeasuredWidth(COST.width);
  const todayMs = todayNoon();
  const layout = useMemo(() => costLayout(costs, todayMs, width), [costs, todayMs, width]);
  if (!layout) return <div className="empty-chart tall">Token history will build this cost chart automatically.</div>;
  const { points, x, y, slot, baseline, plotHeight, codexPath, claudePath, totalPath, barWidth, grid, ticks } = layout;
  const hovered = hover == null ? null : points[hover];

  const moveHover = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const at = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.floor((at - COST.left) / slot);
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
      <div className="chart-canvas" ref={measure}>
        <svg
          ref={svgRef}
          className="cost-chart"
          viewBox={`0 0 ${width} ${COST.height}`}
          role="img"
          aria-label={`${costs.periodDays} day API equivalent cost history`}
          onMouseMove={moveHover}
          onMouseLeave={() => setHover(null)}
        >
          {grid.map((line, index) => (
            <g key={index}>
              <line x1={COST.left} x2={width - COST.right} y1={line.y} y2={line.y} className="chart-grid" />
              <text className="chart-axis" x={COST.left - 8} y={line.y + 3.5} textAnchor="end">
                {line.label}
              </text>
            </g>
          ))}
          {hover != null && (
            <rect className="chart-hover-band" x={x(hover) - slot / 2} y={COST.top} width={slot} height={plotHeight} />
          )}
          {mode === 'stacked' ? (
            <>
              {points.map((point, index) => (
                <g key={point.date} className={hover === index ? 'bar hovered' : 'bar'}>
                  <rect
                    x={x(index) - barWidth / 2}
                    y={y(point.codex)}
                    width={barWidth}
                    height={Math.max(0, baseline - y(point.codex))}
                    className="cost-codex-bar"
                  />
                  <rect
                    x={x(index) - barWidth / 2}
                    y={y(point.codex + point.claude)}
                    width={barWidth}
                    height={Math.max(0, y(point.codex) - y(point.codex + point.claude))}
                    className="cost-claude-bar"
                  />
                </g>
              ))}
              <path d={totalPath} className="cost-total-line" />
            </>
          ) : (
            <>
              <path
                d={`${totalPath} L${x(points.length - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`}
                className="total-area"
              />
              <path d={codexPath} className="cost-codex-line" />
              <path d={claudePath} className="cost-claude-line" />
              <path d={totalPath} className="cost-total-line" />
            </>
          )}
          {ticks.map((tick) => (
            <text
              key={tick.date}
              className="chart-axis"
              x={x(tick.index)}
              y={COST.height - 12}
              textAnchor={dayAnchor(x(tick.index), width)}
            >
              {tick.label}
            </text>
          ))}
          {hovered && hover != null && (
            <line
              className="chart-leader"
              x1={x(hover)}
              x2={x(hover)}
              y1={12}
              y2={y(hovered.codex + hovered.claude) - 2}
            />
          )}
        </svg>
        {hovered && hover != null && (
          <div className="chart-tip" style={tipStyle(x(hover), width, 4, -10)}>
            <strong>
              {dateLabel(hovered.date, WEEKDAY_DAY_MONTH)} · total{' '}
              {money(hovered.codex + hovered.claude, costs.currency)}
            </strong>
            <span>
              <i className="tip-swatch codex" aria-hidden="true" />
              Codex {money(hovered.codex, costs.currency)}
            </span>
            <span>
              <i className="tip-swatch claude" aria-hidden="true" />
              Claude {money(hovered.claude, costs.currency)}
            </span>
          </div>
        )}
      </div>
      <details className="chart-data">
        <summary>
          <ChevronRight aria-hidden="true" />
          View cost data <span className="chart-data-count">· Date / Codex / Claude + Fable / Total</span>
        </summary>
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
    </div>
  );
}

// The top holds the one-line hover readout above the bars.
const DAILY = { width: 640, height: 260, left: 44, right: 8, top: 44, bottom: 28 };

function dailyLayout(rows: DailyUsage[], days: number, todayMs: number, width: number) {
  if (!rows.length) return null;
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.date, (totals.get(row.date) || 0) + Number(row.tokens || 0));
  const points = recentDayKeys(days, todayMs).map((date) => ({ date, tokens: totals.get(date) || 0 }));
  const axis = niceScale(Math.max(...points.map((point) => point.tokens), 1));
  const max = axis.max;
  const plotWidth = width - DAILY.left - DAILY.right;
  const plotHeight = DAILY.height - DAILY.top - DAILY.bottom;
  const baseline = DAILY.top + plotHeight;
  const slot = plotWidth / Math.max(points.length, 1);
  const format = axisFormat(points.length);
  return {
    points,
    max,
    plotHeight,
    baseline,
    slot,
    barWidth: Math.max(2, Math.min(28, slot * 0.72)),
    x: (index: number) => DAILY.left + slot * (index + 0.5),
    grid: axis.ticks.map((value) => ({
      y: baseline - plotHeight * (value / max),
      label: compactNumber(value),
    })),
    ticks: dayTicks(points.length, slot).map((index) => ({
      index,
      date: points[index].date,
      label: dateLabel(points[index].date, format),
    })),
  };
}

export function DailyUsageChart({ rows, days }: { rows: DailyUsage[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, measure] = useMeasuredWidth(DAILY.width);
  const todayMs = todayNoon();
  const layout = useMemo(() => dailyLayout(rows, days, todayMs, width), [rows, days, todayMs, width]);
  if (!layout)
    return <div className="empty-chart">Daily account usage will appear when the local Codex service supplies it.</div>;
  const { points, max, plotHeight, baseline, slot, barWidth, x, grid, ticks } = layout;
  const hovered = hover == null ? null : points[hover];
  const barTop = (tokens: number) => baseline - (tokens / max) * plotHeight;

  const moveHover = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const at = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.floor((at - DAILY.left) / slot);
    setHover(index < 0 || index >= points.length ? null : index);
  };

  return (
    <div className="cost-chart-wrap">
      <div className="chart-canvas" ref={measure}>
        <svg
          ref={svgRef}
          className="daily-usage-chart"
          viewBox={`0 0 ${width} ${DAILY.height}`}
          role="img"
          aria-label="Official daily Codex token usage"
          onMouseMove={moveHover}
          onMouseLeave={() => setHover(null)}
        >
          {grid.map((line, index) => (
            <g key={index}>
              <line x1={DAILY.left} x2={width - DAILY.right} y1={line.y} y2={line.y} className="chart-grid" />
              <text className="chart-axis" x={DAILY.left - 8} y={line.y + 3.5} textAnchor="end">
                {line.label}
              </text>
            </g>
          ))}
          {hover != null && (
            <rect className="chart-hover-band" x={x(hover) - slot / 2} y={DAILY.top} width={slot} height={plotHeight} />
          )}
          {points.map((point, index) => (
            <rect
              key={point.date}
              x={x(index) - barWidth / 2}
              y={barTop(point.tokens)}
              width={barWidth}
              height={baseline - barTop(point.tokens)}
              className={`daily-usage-bar${hover === index ? ' hovered' : ''}`}
            />
          ))}
          {ticks.map((tick) => (
            <text
              key={tick.date}
              className="chart-axis"
              x={x(tick.index)}
              y={DAILY.height - 10}
              textAnchor={dayAnchor(x(tick.index), width)}
            >
              {tick.label}
            </text>
          ))}
          {hovered && hover != null && (
            <line className="chart-leader" x1={x(hover)} x2={x(hover)} y1={12} y2={barTop(hovered.tokens) - 2} />
          )}
        </svg>
        {hovered && hover != null && (
          <div className="chart-tip" style={tipStyle(x(hover), width, 4, -10)}>
            <strong>
              {dateLabel(hovered.date, WEEKDAY_DAY_MONTH)} · {formatInt(hovered.tokens)} tokens
            </strong>
          </div>
        )}
      </div>
      <details className="chart-data">
        <summary>
          <ChevronRight aria-hidden="true" />
          View daily token data <span className="chart-data-count">· {points.length} rows</span>
        </summary>
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
    </div>
  );
}
