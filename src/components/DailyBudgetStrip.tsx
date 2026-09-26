import { AlertOctagon, AlertTriangle } from 'lucide-react';
import { paceLabel, type DailyBudget } from '../budget';
import { niceScale } from '../chart-scale';
import type { ProviderId } from '../provider-view';

/**
 * The gauge's axis: round ticks that end exactly on the budget's scale, so the
 * scale label and the last tick agree. Four intervals are preferred, then five
 * or three; a scale none of them fits is drawn to the next round step.
 */
function gaugeScale(scaleMax: number) {
  for (const intervals of [4, 5, 3, 6]) {
    const axis = niceScale(scaleMax, intervals);
    if (Math.abs(axis.max - scaleMax) < 1e-9) return axis;
  }
  return niceScale(scaleMax);
}

/**
 * How much of the allowance fits in each remaining active day, drawn as a
 * fuel-flow gauge: the budget index on a linear per-day scale, with the
 * expected pace as a dot and the heavier pace as a diamond. A marker past the
 * index means that pace would not reach the reset with the reserve intact.
 */
export function DailyBudgetStrip({
  budget,
  provider,
  heading = true,
  note = null,
}: {
  budget: DailyBudget;
  provider: ProviderId;
  /** Off where the page already shows the budget figure beside the gauge. */
  heading?: boolean;
  /** One line under the legend, such as Fable's budget being Claude weekly's. */
  note?: string | null;
}) {
  const axis = gaugeScale(budget.scaleMax);
  const max = axis.max;
  // Positions along the track as a share of its width; markers past the scale rest at its end.
  const at = (value: number) => `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(2)}%`;
  const heavierOver = budget.heavier != null && !budget.heavierFits;
  const expectedOver = !budget.expectedFits;
  const describe = (name: string, value: number, fits: boolean) =>
    `${name} pace ${paceLabel(value)}${fits ? ', within budget' : ', over budget'}`;
  const aria = [
    `Daily budget ${paceLabel(budget.budget)} per active day${budget.reserve > 0 ? `, keeping ${Math.round(budget.reserve)}% in reserve` : ''}`,
    describe('Expected', budget.expected, budget.expectedFits),
    budget.heavier == null ? null : describe('Heavier', budget.heavier, budget.heavierFits),
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <div className={`budget-strip ${provider}`}>
      {heading && (
        <div className="budget-strip-head">
          <span>
            {budget.reserve > 0
              ? `Daily budget, keeping ${Math.round(budget.reserve)}% in reserve`
              : 'Daily budget to reach reset'}
          </span>
          <strong>
            <span className="budget-figure">{paceLabel(budget.budget)}</span> / active day
          </strong>
        </div>
      )}
      <div className="budget-gauge-frame">
        <svg className="budget-gauge" width="100%" height="44" role="img" aria-label={`${aria}.`}>
          <rect className="budget-gauge-track" x="0" y="12" width="100%" height="10" />
          <rect className="budget-gauge-zone" x="0" y="12" width={at(budget.budget)} height="10" />
          {axis.ticks.map((value) => (
            <g key={value} className="budget-gauge-tick">
              <line x1={at(value)} x2={at(value)} y1="24" y2="28" />
              <text x={at(value)} y="40" textAnchor="middle">
                {value}
              </text>
            </g>
          ))}
          <line className="budget-gauge-index" x1={at(budget.budget)} x2={at(budget.budget)} y1="5" y2="29" />
          {budget.heavier != null && (
            <svg x={at(budget.heavier)} y="17" overflow="visible">
              <path className="budget-gauge-mark heavier" d="M0,-6 L6,0 L0,6 L-6,0 Z" />
            </svg>
          )}
          <circle className="budget-gauge-mark expected" cx={at(budget.expected)} cy="17" r="5" />
        </svg>
      </div>
      <div className="budget-legend">
        <span className={`budget-legend-item expected${expectedOver ? ' over' : ''}`}>
          <svg className="budget-glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" />
          </svg>
          {expectedOver && <AlertOctagon className="budget-over-icon" aria-hidden="true" />}
          <span>
            Expected {paceLabel(budget.expected)}
            {expectedOver ? ' · over budget' : ''}
          </span>
        </span>
        {budget.heavier != null && (
          <span className={`budget-legend-item heavier${heavierOver ? ' over' : ''}`}>
            <svg className="budget-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6,1 L11,6 L6,11 L1,6 Z" />
            </svg>
            {heavierOver && <AlertTriangle className="budget-over-icon" aria-hidden="true" />}
            <span>
              Heavier {paceLabel(budget.heavier)}
              {heavierOver ? ' · over budget' : ''}
            </span>
          </span>
        )}
        <span className="budget-scale">0–{max}% / day</span>
      </div>
      {note && <p className="budget-note">{note}</p>}
    </div>
  );
}
