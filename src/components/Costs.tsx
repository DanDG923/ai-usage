import { Search } from 'lucide-react';
import { useDeferredValue, useMemo } from 'react';
import { compactNumber, money, percent, sourceLabel } from '../lib';
import type { Snapshot } from '../types';
import { CostChart } from './Charts';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { cacheHitRate, rollups } from './details/cost-math';
import { ModelTable, ProjectTable } from './details/Tables';
import { TaskTable } from './details/TaskTable';
import { SessionTable } from './details/SessionTable';
import { DesktopEstimates } from './DesktopEstimates';

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
  const previous = recent.previousWeek;
  const weekChange = previous && previous > 0 ? ((recent.week - previous) / previous) * 100 : null;
  const unpriced = costs.unpricedModels
    .map((entry) => `${sourceLabel(entry.sourceId)} ${entry.model} (${compactNumber(entry.tokens)} tokens)`)
    .join(', ');
  const withoutCache = Math.max(costs.withoutCache, costs.actual, 1);

  return (
    <main className="page costs-page" id="panel-costs" role="tabpanel" aria-labelledby="tab-costs" tabIndex={-1}>
      <section className="page-lead product-lead">
        <div>
          <h1>API-equivalent costs</h1>
          <p>
            Tracked tokens repriced with the current local catalogue—not a subscription invoice.{' '}
            <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
          </p>
        </div>
        <div className="period-switch" role="group" aria-label="Analysis period">
          {[7, 30, 90].map((period) => (
            <button
              key={period}
              className={days === period ? 'active' : ''}
              aria-pressed={days === period}
              disabled={snapshot.isPreview}
              title={snapshot.isPreview ? 'The browser preview uses a fixed 30-day example.' : undefined}
              onClick={() => onDays(period)}
            >
              {period}d
            </button>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="cost-scope-heading">
        <div className="panel-heading">
          <div>
            <h2 id="cost-scope-heading">Which usage is included?</h2>
            <p>
              Costs include models found in local Codex and Claude Code token records, including Opus, Sonnet, and
              Haiku. Regular Claude desktop and web chats can be imported as{' '}
              <a href="#desktop-estimates">separate text estimates below</a>. Their usage can also count toward the
              account allowance shown on Overview.
            </p>
            <p>
              Price coverage measures the recorded tokens we can price. Even 100% does not mean every chat on your
              account was captured. Adding a model price does not import missing activity.
            </p>
          </div>
        </div>
      </section>

      <section className="cost-summary" aria-label="Cost summary">
        <div className="cost-primary">
          <span>Last {costs.periodDays} days</span>
          <strong>
            {costs.isLowerBound ? '≥ ' : ''}
            {money(costs.actual, costs.currency)}
          </strong>
          <small>
            {costs.isLowerBound
              ? `Lower bound; excludes ${unpriced || 'unpriced models'}`
              : `${costs.requestCount.toLocaleString()} tracked usage updates`}
          </small>
        </div>
        <dl>
          <div>
            <dt>Last 7 days</dt>
            <dd>{money(recent.week, costs.currency)}</dd>
            <small>
              {weekChange == null
                ? 'Previous week unavailable'
                : `${weekChange >= 0 ? '+' : ''}${Math.round(weekChange)}% vs previous week`}
            </small>
          </div>
          <div>
            <dt>Cache discount</dt>
            <dd>{money(costs.cacheSavings, costs.currency)}</dd>
            <small>{percent(costs.cacheSavingsPercent * 100)} below uncached value</small>
          </div>
          <div>
            <dt>Cache hit rate</dt>
            <dd>{hitRate == null ? '—' : percent(hitRate * 100)}</dd>
            <small>of prompt-side tokens</small>
          </div>
          <div>
            <dt>Recorded token price coverage</dt>
            <dd>{percent(costs.coverage * 100)}</dd>
            <small>{costs.isLowerBound ? 'Some recorded models are unpriced' : 'Recorded tokens only'}</small>
          </div>
        </dl>
      </section>

      <section className="cost-workspace">
        <article className="panel cost-panel">
          <div className="panel-heading">
            <div>
              <h2>Daily cost</h2>
              <p>API-equivalent value of each day’s locally tracked tokens.</p>
            </div>
          </div>
          <CostChart costs={costs} />
        </article>
        <article className="panel savings-panel">
          <div className="panel-heading compact-heading">
            <h2>Cache savings</h2>
          </div>
          <div className="savings-figure">
            <strong>{percent(costs.cacheSavingsPercent * 100)}</strong>
            <span>of uncached value avoided</span>
          </div>
          <p>Known cache reads are compared with those same tokens at the uncached input rate.</p>
          <div className="saving-bars">
            <div className="with-cache">
              <span>
                With cache <b>{money(costs.actual, costs.currency)}</b>
              </span>
              <i style={{ '--fill': `${Math.max(2, (costs.actual / withoutCache) * 100)}%` } as React.CSSProperties} />
            </div>
            <div>
              <span>
                Without cache <b>{money(costs.withoutCache, costs.currency)}</b>
              </span>
              <i style={{ '--fill': '100%' } as React.CSSProperties} />
            </div>
          </div>
        </article>
      </section>

      <div className="table-tools">
        <div>
          <h2>Cost evidence</h2>
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
      <SessionTable snapshot={snapshot} query={query} />
      <DesktopEstimates snapshot={snapshot} onSnapshot={onSnapshot} />
    </main>
  );
}
