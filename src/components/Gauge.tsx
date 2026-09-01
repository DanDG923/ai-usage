import { percent } from '../lib';
import type { Forecast } from '../types';

const RADIUS = 50;
const CENTER = 59;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SWEEP = 0.78; // 280° arc with the gap at the bottom
const START_DEG = 129.6;
const ARC = SWEEP * CIRCUMFERENCE;

function pointOnArc(fraction: number, radius: number) {
  const angle = ((START_DEG + 360 * SWEEP * fraction) * Math.PI) / 180;
  return [CENTER + Math.cos(angle) * radius, CENTER + Math.sin(angle) * radius];
}

export function Gauge({
  remaining,
  expected,
  state,
  estimated = false,
}: {
  remaining: number;
  expected: number | null;
  state: Forecast['state'];
  estimated?: boolean;
}) {
  const fill = Math.max(0, Math.min(100, remaining)) / 100;
  const tick = expected == null ? null : Math.max(0, Math.min(100, expected)) / 100;
  const [ox, oy] = tick == null ? [0, 0] : pointOnArc(tick, RADIUS + 5);
  const [ix, iy] = tick == null ? [0, 0] : pointOnArc(tick, RADIUS - 8);
  return (
    <div className={`gauge ${state}`}>
      <svg
        viewBox="0 0 118 118"
        role="img"
        aria-label={`${estimated ? 'approximately ' : ''}${Math.round(remaining)}% of the allowance left${expected == null ? '' : `, ${Math.round(expected)}% expected at reset`}`}
      >
        <g transform={`rotate(${START_DEG} ${CENTER} ${CENTER})`}>
          <circle
            className="gauge-track"
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            strokeWidth="9"
            strokeDasharray={`${ARC} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
          />
          <circle
            className="gauge-low"
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            strokeWidth="9"
            strokeDasharray={`${ARC * 0.15} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
          />
          {fill > 0.01 && (
            <circle
              className="gauge-fill"
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              strokeWidth="9"
              strokeDasharray={`${ARC * fill} ${CIRCUMFERENCE}`}
              strokeLinecap="round"
            />
          )}
        </g>
        {tick != null && <line className="gauge-tick" x1={ix} y1={iy} x2={ox} y2={oy} strokeWidth="2" />}
      </svg>
      <div className="gauge-value">
        <div>
          <b>
            {estimated ? '~' : ''}
            {Math.round(remaining)}%
          </b>
          <span>{estimated ? 'estimated left' : 'left'}</span>
        </div>
      </div>
    </div>
  );
}

export function PaceBullet({ forecast }: { forecast: Forecast }) {
  const { recentPace, safePace, activeHoursLeft } = forecast;
  const reserve = forecast.reservePercent ?? 0;
  const span = 1.5; // the track runs 0 → 1.5× the safe pace
  // Positive usage against no safe budget should fill the bar and read hot;
  // treating a zero denominator as a zero ratio produced a green sliver.
  const ratio = safePace > 0 ? recentPace / safePace : recentPace > 0 ? span : 0;
  const width = Math.max(2, Math.min(100, (ratio / span) * 100));
  const tone = ratio <= 1 ? '' : ratio <= 1.2 ? 'warm' : 'hot';
  return (
    <div className="pace-bullet">
      <div className="pb-labels">
        <b>Recent pace {percent(recentPace, 2)}/h</b>
        <span>
          safe ≤ {percent(safePace, 2)}/h{reserve > 0 ? ` keeping ${Math.round(reserve)}% back` : ''} ·{' '}
          {Math.round(activeHoursLeft)} active hours left
        </span>
      </div>
      <div
        className="pb-track"
        role="img"
        aria-label={`Recent pace ${percent(recentPace, 2)} per active hour against a safe pace of ${percent(safePace, 2)}`}
      >
        <div className={`pb-fill ${tone}`} style={{ width: `${width}%` }} />
        <div className="pb-thresh" style={{ left: `${(1 / span) * 100}%` }} />
      </div>
    </div>
  );
}

export function MeterBar({
  fillPercent,
  tickPercent,
  label,
}: {
  fillPercent: number;
  tickPercent: number | null;
  label: string;
}) {
  return (
    <div className="pb-track" role="img" aria-label={label}>
      <div className="pb-fill" style={{ width: `${Math.max(2, Math.min(100, fillPercent))}%` }} />
      {tickPercent != null && (
        <div className="pb-thresh" style={{ left: `${Math.max(0, Math.min(100, tickPercent))}%` }} />
      )}
    </div>
  );
}
