import { AlertTriangle, CheckCircle2, Gauge, ShieldCheck } from 'lucide-react';
import { compactNumber, dateTimeLabel, money, percent, shortDate, verdictSentence, whenLabel } from '../lib';
import { providerViews, type ProviderView } from '../provider-view';
import type { Snapshot } from '../types';
import { CombinedRunwayChart } from './Charts';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { ProviderSummary } from './ProviderSummary';

type Insight = { tone: 'neutral' | 'good' | 'warm' | 'hot'; title: string; detail: string };

function insights(views: ProviderView[], snapshot: Snapshot, nowMs: number): Insight[] {
  const rows: Insight[] = [];
  for (const view of views) {
    const forecast = view.current?.forecast;
    if (!forecast) continue;
    if (forecast.exhaustsAt) {
      rows.push({
        tone: 'hot',
        title: `${view.name} is expected to run out`,
        detail: `${whenLabel(forecast.exhaustsAt, nowMs)}, before its ${dateTimeLabel(view.resetAt!)} reset.`,
      });
    } else if (forecast.heavyExhaustsAt) {
      rows.push({
        tone: 'warm',
        title: `${view.name} could run out under heavier usage`,
        detail: `Expected usage leaves ${percent(forecast.expectedRemaining)}; the heavier case reaches zero ${whenLabel(forecast.heavyExhaustsAt, nowMs)}.`,
      });
    } else if (forecast.paceRatio > 1.05) {
      const reduction = Math.max(0, Math.round((1 - 1 / forecast.paceRatio) * 100));
      rows.push({
        tone: forecast.paceRatio > 1.2 ? 'warm' : 'neutral',
        title: `${view.name} is above its safe pace`,
        detail: `${forecast.paceRatio.toFixed(1)}× the sustainable pace. Reduce active usage by about ${reduction}% to return to plan.`,
      });
    }
    if (view.stale) {
      rows.push({
        tone: 'warm',
        title: `${view.name} needs a current reading`,
        detail: 'The displayed balance is projected from the last successful local observation.',
      });
    }
  }
  if (snapshot.resetCredits > 0) {
    rows.push({
      tone: 'neutral',
      title: `${snapshot.resetCredits} Codex reset credit${snapshot.resetCredits === 1 ? '' : 's'} banked`,
      detail: 'Credits are recorded as context and are never treated as allowance or redeemed automatically.',
    });
  }
  if (!rows.length) {
    rows.push({
      tone: 'good',
      title: 'No allowance needs attention',
      detail: 'Expected and heavier projections remain above zero through their next resets.',
    });
  }
  return rows.slice(0, 4);
}

function RecentCycles({ views, snapshot }: { views: ProviderView[]; snapshot: Snapshot }) {
  return (
    <section className="panel recent-cycles-panel">
      <div className="panel-heading compact-heading">
        <div>
          <h2>Current cycles</h2>
          <p>A compact evidence check; complete cycle history is under Activity.</p>
        </div>
      </div>
      <div className="table-scroll compact-table-scroll">
        <table className="overview-cycle-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Reset</th>
              <th className="num">Peak used</th>
              <th className="num">API-equivalent</th>
              <th>Forecast</th>
            </tr>
          </thead>
          <tbody>
            {views.map((view) => {
              const rows = snapshot.cycles[view.id] ?? [];
              const cycle = rows.find((row) => row.current) ?? rows[0];
              return (
                <tr key={view.id}>
                  <td>
                    <span className={`source-dot ${view.id}`} aria-hidden="true" />
                    <strong>{view.name}</strong>
                  </td>
                  <td>{cycle ? dateTimeLabel(cycle.resetsAt) : view.resetAt ? dateTimeLabel(view.resetAt) : '—'}</td>
                  <td className="num">{cycle ? percent(cycle.peakUsedPercent) : '—'}</td>
                  <td className="num">{cycle ? money(cycle.cost, snapshot.costs.currency) : '—'}</td>
                  <td className={`forecast-outcome ${view.state}`}>
                    {view.expectedRemaining == null
                      ? 'Learning'
                      : `${percent(view.expectedRemaining)} expected at reset`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const nowMs = Date.parse(snapshot.generatedAt);
  const views = providerViews(snapshot);
  const verdict = verdictSentence(snapshot.dashboardVerdict, snapshot.quotas);
  const attention = insights(views, snapshot, nowMs);
  const unpriced = snapshot.costs.unpricedModels.map((entry) => entry.model).join(', ');

  return (
    <main
      className="page overview-page"
      id="panel-overview"
      role="tabpanel"
      aria-labelledby="tab-overview"
      tabIndex={-1}
    >
      <section className={`overview-status ${snapshot.dashboardVerdict.state}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h1>{verdict.headline}</h1>
          <p>
            {verdict.secondary || 'Forecasts compare expected and heavier usage through each provider’s next reset.'}
          </p>
        </div>
      </section>

      <section className="provider-strip" aria-label="Allowance summaries">
        <div className="provider-strip-head">
          <h2>Allowances</h2>
          <div className="scenario-key" aria-label="Forecast bar key">
            <span>
              <i className="expected" />
              Expected usage
            </span>
            <span>
              <i className="heavy" />
              Additional heavy usage
            </span>
          </div>
        </div>
        <div className="provider-summary-grid">
          {views.map((view) => (
            <ProviderSummary key={view.id} view={view} nowMs={nowMs} />
          ))}
        </div>
      </section>

      <div className="overview-workspace">
        <section className="panel runway-panel">
          <div className="panel-heading runway-heading">
            <div>
              <h2>Allowance runway</h2>
              <p>Observed balance, expected forecast, and a heavier-usage case on the same 0–100% scale.</p>
            </div>
            <div className="chart-key" aria-label="Chart line key">
              <span className="k-observed">
                <i />
                Observed
              </span>
              <span className="k-expected">
                <i />
                Expected
              </span>
              <span className="k-heavy">
                <i />
                Heavier
              </span>
            </div>
          </div>
          <CombinedRunwayChart views={views} />
        </section>

        <aside className="overview-insights" aria-label="Overview insights">
          <section className="panel attention-panel">
            <div className="panel-heading compact-heading">
              <h2>What needs attention</h2>
            </div>
            <div className="insight-list">
              {attention.map((row) => {
                const Icon =
                  row.tone === 'hot' || row.tone === 'warm'
                    ? AlertTriangle
                    : row.tone === 'good'
                      ? CheckCircle2
                      : Gauge;
                return (
                  <article key={`${row.title}-${row.detail}`} className={`insight ${row.tone}`}>
                    <Icon aria-hidden="true" />
                    <div>
                      <strong>{row.title}</strong>
                      <p>{row.detail}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel billing-summary">
            <div className="panel-heading compact-heading">
              <h2>This billing period</h2>
            </div>
            <dl>
              <div className="billing-primary">
                <dt>
                  API-equivalent <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
                </dt>
                <dd>
                  {snapshot.costs.isLowerBound ? '≥ ' : ''}
                  {money(snapshot.costs.actual, snapshot.costs.currency)}
                </dd>
                <small>{snapshot.costs.isLowerBound ? 'Lower bound' : `${snapshot.costs.periodDays}-day total`}</small>
              </div>
              <div>
                <dt>Cache discount</dt>
                <dd>{money(snapshot.costs.cacheSavings, snapshot.costs.currency)}</dd>
                <small>{percent(snapshot.costs.cacheSavingsPercent * 100)} below uncached value</small>
              </div>
              <div>
                <dt>Price coverage</dt>
                <dd>{percent(snapshot.costs.coverage * 100)}</dd>
                <small title={unpriced ? `Unpriced: ${unpriced}` : undefined}>
                  {unpriced
                    ? `${compactNumber(snapshot.costs.unpricedModels.length)} unpriced model${snapshot.costs.unpricedModels.length === 1 ? '' : 's'}`
                    : 'All tracked categories priced'}
                </small>
              </div>
            </dl>
            <div className="local-assurance">
              <ShieldCheck aria-hidden="true" />
              <span>Calculated locally from your own usage records.</span>
            </div>
          </section>
        </aside>
      </div>

      <RecentCycles views={views} snapshot={snapshot} />
      <p className="overview-freshness">
        Snapshot {shortDate(snapshot.generatedAt)} · {snapshot.timezone} · Local data only
      </p>
    </main>
  );
}
