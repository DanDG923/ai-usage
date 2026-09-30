import { Search } from 'lucide-react';
import { useDeferredValue, useMemo } from 'react';
import { compactNumber, formatInt, money, percent, priceCoverage, sourceLabel } from '../lib';
import type { Snapshot } from '../types';
import { CostChart } from './Charts';
import { API_EQUIVALENT_EXPLAINER } from './InfoTip';
import { cacheHitRate, rollups } from './details/cost-math';
import { Disclosure } from './details/Disclosure';
import { ModelTable, ProjectTable } from './details/Tables';
import { TaskTable } from './details/TaskTable';
import { SessionTable } from './details/SessionTable';
import { DesktopEstimates } from './DesktopEstimates';
import '../pages.css';
import '../styles/costs.css';

/**
 * The fuel ledger: what the tracked tokens would have cost at API rates. The
 * readouts row and the daily cost instrument sit above the evidence tables;
 * every priced sum carries "≥ " while any recorded model is unpriced.
 */
export function Costs({
  snapshot,
  days,
  onDays,
  query,
  onQuery,
  onSnapshot,
}: {
  snapshot: Snapshot;
  days: number;
  onDays: (days: number) => void;
  query: string;
  onQuery: (query: string) => void;
  onSnapshot: (snapshot: Snapshot) => void;
}) {
  const tableQuery = useDeferredValue(query);
  const costs = snapshot.costs;
  const recent = useMemo(() => rollups(costs, new Date(snapshot.generatedAt)), [costs, snapshot.generatedAt]);
  const hitRate = useMemo(() => cacheHitRate(costs), [costs]);
  const weekChange = recent.weekChange == null ? null : recent.weekChange * 100;
  const unpriced = costs.unpricedModels
    .map((entry) => `${sourceLabel(entry.sourceId)} ${entry.model} (${compactNumber(entry.tokens)} tokens)`)
    .join(', ');
  // The "with cache" bar is drawn against the larger of the two figures. A
  // floor of one currency unit here drew 0.05 against 0.20 at 5%, not 25%.
  const barBase = Math.max(costs.withoutCache, costs.actual);
  const withCacheFill = barBase > 0 ? (costs.actual / barBase) * 100 : 0;
  // Unpriced tokens are left out of every priced sum, so each one is a floor.
  // The floor and its figure stay one text node.
  const floor = costs.isLowerBound ? '≥ ' : '';
  const priced = (value: number) => `${floor}${money(value, costs.currency)}`;

  return (
    <main className="page costs-page" id="panel-costs" role="tabpanel" aria-labelledby="tab-costs" tabIndex={-1}>
      <section className="page-lead costs-lead">
        <div className="costs-title">
          <h1>API-equivalent costs</h1>
          <p>Tracked Codex and Claude Code tokens, repriced at current API rates. Not an invoice.</p>
        </div>
        <div className="costs-period">
          <div className="seg period-switch" role="group" aria-label="Analysis period">
            {[7, 30, 90].map((period) => (
              <button
                key={period}
                type="button"
                className="btn"
                aria-pressed={days === period}
                disabled={snapshot.isPreview}
                onClick={() => onDays(period)}
              >
                {period}d
              </button>
            ))}
          </div>
          {snapshot.isPreview && <span>The browser preview uses a fixed 30-day example.</span>}
        </div>
      </section>
      <Disclosure summary="What’s included and what isn’t" className="lead-disclosure">
        <p>
          Costs include models found in local Codex and Claude Code token records, including Opus, Sonnet, and Haiku.
          Regular Claude desktop and web chats can be imported as{' '}
          <a href="#desktop-estimates">separate text estimates below</a>. Their usage can also count toward the account
          allowance shown on Overview.
        </p>
        <p>
          Price coverage measures the recorded tokens we can price. Even 100% does not mean every chat on your account
          was captured. Adding a model price does not import missing activity.
        </p>
        <p>{API_EQUIVALENT_EXPLAINER}</p>
      </Disclosure>

      <section className="cost-summary" aria-label="Cost summary">
        <div className="cost-primary">
          <span>Last {costs.periodDays} days</span>
          <strong>{priced(costs.actual)}</strong>
          <small>
            {costs.isLowerBound
              ? `Lower bound; excludes ${unpriced || 'unpriced models'}`
              : `${formatInt(costs.requestCount)} tracked usage updates`}
          </small>
        </div>
        <dl>
          <div>
            <dt>Last 7 days</dt>
            <dd>{priced(recent.week)}</dd>
            <small>
              {weekChange == null
                ? 'Previous week unavailable'
                : `${weekChange >= 0 ? '+' : ''}${Math.round(weekChange)}% vs previous week (full days)`}
            </small>
          </div>
          <div>
            <dt>Cache discount</dt>
            <dd>{priced(costs.cacheSavings)}</dd>
            <small>{percent(costs.cacheSavingsPercent * 100)} below uncached value</small>
          </div>
          <div>
            <dt>Cache hit rate</dt>
            <dd>{hitRate == null ? '—' : percent(hitRate * 100)}</dd>
            <small>of prompt-side tokens</small>
          </div>
          <div>
            <dt>Recorded token price coverage</dt>
            <dd>{costs.totalTokens > 0 ? priceCoverage(costs.coverage) : '—'}</dd>
            <small>
              {costs.totalTokens > 0
                ? costs.isLowerBound
                  ? 'Some recorded models are unpriced'
                  : 'Recorded tokens only'
                : 'No usage in this period'}
            </small>
          </div>
        </dl>
      </section>

      <section className="cost-workspace">
        <article className="panel cost-panel" aria-labelledby="daily-cost-heading">
          <div className="costs-head">
            <div>
              <h2 id="daily-cost-heading" className="pnl-title">
                Daily cost
              </h2>
              <p>API-equivalent value of each day’s locally tracked tokens.</p>
            </div>
          </div>
          <CostChart costs={costs} />
        </article>
        <article className="panel savings-panel" aria-labelledby="cache-savings-heading">
          <h2 id="cache-savings-heading" className="pnl-title">
            Cache savings
          </h2>
          <div className="savings-figure">
            <strong>{percent(costs.cacheSavingsPercent * 100)}</strong>
            <span>of uncached value avoided</span>
          </div>
          <p>Known cache reads are compared with those same tokens at the uncached input rate.</p>
          <div className="saving-bars">
            <div className="with-cache">
              <span>
                <span className="lbl">With cache</span>
                <span className="lead" aria-hidden="true" />
                <b>{priced(costs.actual)}</b>
              </span>
              <i aria-hidden="true" style={{ '--fill': `${Math.max(2, withCacheFill)}%` } as React.CSSProperties} />
            </div>
            <div className="without-cache">
              <span>
                <span className="lbl">Without cache</span>
                <span className="lead" aria-hidden="true" />
                <b>{priced(costs.withoutCache)}</b>
              </span>
              <i aria-hidden="true" style={{ '--fill': '100%' } as React.CSSProperties} />
            </div>
          </div>
        </article>
      </section>

      <section className="costs-evidence" aria-labelledby="cost-evidence-heading">
        <div className="table-tools">
          <div>
            <h2 id="cost-evidence-heading">Cost evidence</h2>
            <p>Search tasks, agents, projects, models, and sessions below.</p>
          </div>
          <label className="table-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Filter cost tables</span>
            <input
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Filter tables"
            />
          </label>
        </div>
        <TaskTable snapshot={snapshot} query={query} />
        <ModelTable costs={costs} query={tableQuery} />
        <ProjectTable costs={costs} query={tableQuery} />
        <div className="costs-pair">
          <SessionTable snapshot={snapshot} query={query} />
          <DesktopEstimates snapshot={snapshot} onSnapshot={onSnapshot} />
        </div>
      </section>
    </main>
  );
}
