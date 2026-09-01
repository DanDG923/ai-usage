import { Coins, DatabaseZap } from 'lucide-react';
import { compactNumber, money, percent, sourceLabel } from '../lib';
import type { Snapshot } from '../types';
import { CostChart, DailyUsageChart } from './Charts';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { CycleHistory } from './details/CycleHistory';
import { MetricRibbon } from './details/MetricRibbon';
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
      : `${c.currency} uses the manually saved display rate of ${snapshot.settings.usdToCurrency} per USD.`;
  return (
    <main className="page details-page" id="panel-details" role="tabpanel" aria-labelledby="tab-details">
      <section className="page-lead">
        <div>
          <span className="eyebrow">Local token ledger</span>
          <h1>
            {c.isLowerBound ? 'Priced token usage is worth at least ' : 'Tracked token usage is worth '}
            {money(c.actual, c.currency)}
            <span className="lead-qualifier">
              {' '}
              at API prices <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
            </span>
          </h1>
          <p>
            Every event in this period is repriced with the current catalogue row for its model. {rateDisclosure}
            {c.isLowerBound && ` The lower bound excludes ${unpriced || 'unpriced models'}.`} Reasoning is shown as a
            subset of output, never billed twice.
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
              <span className="eyebrow">Daily API-equivalent</span>
              <h2>Priced history</h2>
            </div>
            <Coins aria-hidden="true" />
          </div>
          <CostChart costs={c} />
        </article>
        <article className="panel savings-panel">
          <span className="eyebrow">The cache effect</span>
          <h2>{money(c.cacheSavings, c.currency)} discounted</h2>
          <p>
            Prompt and context cache reads with known prices are compared with their uncached token rate. The pale ring
            is the uncached equivalent.
          </p>
          <div
            className="saving-ring"
            style={{ '--fill': `${Math.min(100, c.cacheSavingsPercent * 100)}%` } as React.CSSProperties}
          >
            <div>
              <strong>{percent(c.cacheSavingsPercent * 100)}</strong>
              <span>avoided</span>
            </div>
          </div>
          <div className="saving-compare">
            <span>
              With cache <b>{money(c.actual, c.currency)}</b>
            </span>
            <span>
              Without <b>{money(c.withoutCache, c.currency)}</b>
            </span>
          </div>
        </article>
      </section>
      <CycleHistory cycles={snapshot.cycles} currency={c.currency} />
      <ProjectTable costs={c} />
      <section className="panel table-panel daily-usage-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Official account totals</span>
            <h2>Daily Codex usage</h2>
            <p>
              Daily token totals reported by the local Codex service for the selected period, separate from
              reconstructed per-session costs.
            </p>
          </div>
          <DatabaseZap aria-hidden="true" />
        </div>
        <DailyUsageChart rows={snapshot.dailyUsage || []} days={days} />
      </section>
      <ModelTable costs={c} />
      <SessionTable costs={c} />
    </main>
  );
}
