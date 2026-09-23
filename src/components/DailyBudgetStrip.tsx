import { paceLabel, type DailyBudget } from '../budget';
import type { ProviderId } from '../provider-view';

const position = (value: number, max: number) => `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(1)}%`;

/**
 * How much of the allowance fits in each remaining active day, with the
 * expected and heavier paces marked against it. A marker past the budget line
 * means that pace would not reach the reset with the reserve intact.
 */
export function DailyBudgetStrip({ budget, provider }: { budget: DailyBudget; provider: ProviderId }) {
  const max = budget.scaleMax;
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
      <div className="budget-strip-head">
        <span>
          {budget.reserve > 0
            ? `Daily budget, keeping ${Math.round(budget.reserve)}% in reserve`
            : 'Daily budget to reach reset'}
        </span>
        <strong>{paceLabel(budget.budget)} / active day</strong>
      </div>
      <div className="budget-track" role="img" aria-label={`${aria}.`}>
        <i className="budget-fill" style={{ width: position(budget.budget, max) }} />
        <i className="budget-line" style={{ left: position(budget.budget, max) }} />
        <i
          className={`budget-mark expected${expectedOver ? ' over' : ''}`}
          style={{ left: position(budget.expected, max) }}
        />
        {budget.heavier != null && (
          <i
            className={`budget-mark heavier${heavierOver ? ' over' : ''}`}
            style={{ left: position(budget.heavier, max) }}
          />
        )}
      </div>
      <div className="budget-key">
        <span>
          <i className="budget-key-mark expected" aria-hidden="true" />
          Expected {paceLabel(budget.expected)}
          {expectedOver ? ' · over budget' : ''}
        </span>
        {budget.heavier != null && (
          <span>
            <i className={`budget-key-mark heavier${heavierOver ? ' over' : ''}`} aria-hidden="true" />
            Heavier {paceLabel(budget.heavier)}
            {heavierOver ? ' · over budget' : ''}
          </span>
        )}
        <span className="budget-scale">0–{max}% / day</span>
      </div>
    </div>
  );
}
