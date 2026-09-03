import { compactNumber, money, percent, sourceLabel } from '../lib';
import type { Snapshot } from '../types';
import { CostChart, DailyUsageChart } from './Charts';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { ActivityHeatmap } from './details/ActivityHeatmap';
import { CycleHistory } from './details/CycleHistory';
import { MetricRibbon } from './details/MetricRibbon';
import { RecentRollups } from './details/RecentRollups';
import { ModelTable, ProjectTable, SessionTable } from './details/Tables';

export function Details({
  snapshot,
  days,
  onDays,
}: {
  snapshot: Snapshot;
  days: number;
  onDays: (days: number) => void;
}) {
  const c = snapshot.costs;
  const unpriced = c.unpricedModels
    .map((entry) => `${sourceLabel(entry.sourceId)} ${entry.model} (${compactNumber(entry.tokens)} tokens)`)
    .join(', ');
  const rateDisclosure =
    c.currency === 'USD'
      ? 'USD is the ledger currency.'
      : `${c.currency} uses the manually saved rate of ${snapshot.settings.usdToCurrency} per USD.`;
  const withoutCache = Math.max(c.withoutCache, c.actual, 1);
  return (
    <main className="page details-page" id="panel-details" role="tabpanel" aria-labelledby="tab-details">
      <section className="page-lead">
        <div>
          <h1>
            Costs{' '}
            <span className="lead-qualifier">
              last {c.periodDays} days, at API prices{' '}
              <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
            </span>
          </h1>
          <p>
            Every tracked token is repriced with the current catalogue row for its model. {rateDisclosure}
            {c.isLowerBound && ` The lower bound excludes ${unpriced || 'unpriced models'}.`}
          </p>
        </div>
        <div className="period-switch" role="group" aria-label="Period">
          {[7, 30, 90].map((period) => (
            <button
              key={period}
              className={days === period ? 'active' : ''}
              aria-pressed={days === period}
              disabled={snapshot.isPreview}
              title={snapshot.isPreview ? 'The browser preview uses one fixed 30-day example.' : undefined}
              onClick={() => onDays(period)}
            >
              {period}d
            </button>
          ))}
        </div>
      </section>
      <MetricRibbon costs={c} unpriced={unpriced} />
      <section className="details-grid">
        <article className="panel cost-panel">
          <div className="panel-heading">
            <div>
              <h2>Daily cost</h2>
              <p>API-equivalent value of each day's tracked tokens.</p>
            </div>
          </div>
          <CostChart costs={c} />
        </article>
        <article className="panel savings-panel">
          <div className="panel-heading">
            <div>
              <h2>Cache savings</h2>
            </div>
          </div>
          <div className="savings-figure">
            <strong>{percent(c.cacheSavingsPercent * 100)}</strong>
            <span>of the uncached value avoided</span>
          </div>
          <p>
            Cache reads with known prices are compared with the same tokens at the uncached input rate. The difference
            is the discount.
          </p>
          <div className="saving-bars">
            <div className="with-cache">
              <span>
                With cache <b>{money(c.actual, c.currency)}</b>
              </span>
              <i style={{ '--fill': `${Math.max(2, (c.actual / withoutCache) * 100)}%` } as React.CSSProperties} />
            </div>
            <div>
              <span>
                Without cache <b>{money(c.withoutCache, c.currency)}</b>
              </span>
              <i style={{ '--fill': '100%' } as React.CSSProperties} />
            </div>
          </div>
        </article>
      </section>
      <RecentRollups costs={c} />
      {c.activityGrid && <ActivityHeatmap grid={c.activityGrid} currency={c.currency} days={c.periodDays} />}
      <CycleHistory cycles={snapshot.cycles} currency={c.currency} />
      <ProjectTable costs={c} />
      <section className="panel table-panel daily-usage-panel">
        <div className="panel-heading">
          <div>
            <h2>Daily Codex usage</h2>
            <p>
              Daily token totals reported by the local Codex service for the selected period, separate from the
              reconstructed per-session costs.
            </p>
          </div>
        </div>
        <DailyUsageChart rows={snapshot.dailyUsage || []} days={days} />
      </section>
      <ModelTable costs={c} />
      <SessionTable costs={c} />
    </main>
  );
}
