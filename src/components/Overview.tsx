import { AlertTriangle, CheckCircle2, Gauge, ShieldCheck } from 'lucide-react';
import {
  compactNumber,
  dateTimeLabel,
  money,
  percent,
  shortDate,
  verdictSentence,
  whenLabel,
  windowLabel,
} from '../lib';
import { providerViews, type ProviderView } from '../provider-view';
import type { QuotaWindow, Snapshot } from '../types';
import { CombinedRunwayChart } from './Charts';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { ProviderSummary } from './ProviderSummary';
import { TokenCapacity } from './TokenCapacity';

type Insight = { tone: 'neutral' | 'good' | 'warm' | 'hot'; title: string; detail: string };

function hasForecast(view: ProviderView) {
  const forecast = view.current?.forecast;
  return Boolean(
    forecast &&
    !forecast.expired &&
    forecast.state !== 'unknown' &&
    view.expectedRemaining != null &&
    view.heavyRemaining != null,
  );
}

function names(views: ProviderView[]) {
  return views.map((view) => view.name).join(', ');
}

// Every active window earns its own line: the weekly headline and any shorter
// session window are separate allowances with separate resets.
function windowInsights(name: string, window: QuotaWindow, nowMs: number): Insight[] {
  const forecast = window.forecast;
  if (forecast.expired) return [];
  if (forecast.exhaustsAt) {
    return [
      {
        tone: 'hot',
        title: `${name} is expected to run out`,
        detail: `${whenLabel(forecast.exhaustsAt, nowMs)}, before its ${dateTimeLabel(window.resetsAt)} reset.`,
      },
    ];
  }
  if (forecast.heavyExhaustsAt) {
    return [
      {
        tone: 'warm',
        title: `${name} could run out under heavier usage`,
        detail: `Expected usage leaves ${percent(forecast.expectedRemaining)}; the heavier case reaches zero ${whenLabel(forecast.heavyExhaustsAt, nowMs)}.`,
      },
    ];
  }
  if (forecast.paceRatio > 1.05) {
    const reduction = Math.max(0, Math.round((1 - 1 / forecast.paceRatio) * 100));
    return [
      {
        tone: forecast.paceRatio > 1.2 ? 'warm' : 'neutral',
        title: `${name} is above its safe pace`,
        detail: `${forecast.paceRatio.toFixed(1)}× the sustainable pace. Reduce active usage by about ${reduction}% to return to plan.`,
      },
    ];
  }
  return [];
}

function insights(views: ProviderView[], snapshot: Snapshot, nowMs: number): Insight[] {
  const rows: Insight[] = [];
  for (const view of views) {
    const forecast = view.current?.forecast;
    if (!view.current || !forecast || forecast.expired) continue;
    rows.push(...windowInsights(view.name, view.current, nowMs));
    for (const window of view.secondaryWindows) {
      rows.push(...windowInsights(`${view.name} ${windowLabel(window.windowMinutes)} session`, window, nowMs));
    }
    if (view.stale) {
      rows.push({
        tone: 'warm',
        title: `${view.name} needs a current reading`,
        detail: 'The displayed balance is projected from the last successful local observation.',
      });
    }
  }
  const missing = views.filter((view) => !view.current || view.current.forecast.expired);
  const learning = views.filter((view) => view.current && !view.current.forecast.expired && !hasForecast(view));
  if (missing.length) {
    rows.push({
      tone: 'neutral',
      title: `Waiting for ${names(missing)} allowance readings`,
      detail:
        'Refresh the local sources or check their setup. These allowances cannot be assessed until a current observation is available.',
    });
  }
  if (learning.length) {
    rows.push({
      tone: 'neutral',
      title: `${names(learning)} forecasts are still learning`,
      detail: 'A balance is available, but there is not enough evidence to say how much will remain at reset.',
    });
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
              // Cycle history follows the backend's primary bucket, which is
              // also the longest window the summary card headlines.
              const quota = view.quota && !view.quota.forecast.expired ? view.quota : null;
              const cycle = quota
                ? rows.find(
                    (row) =>
                      row.current &&
                      Math.abs(Date.parse(row.resetsAt) - Date.parse(quota.resetsAt)) <= 60_000 &&
                      (!(quota.windowMinutes && quota.windowMinutes > 0) || row.windowMinutes === quota.windowMinutes),
                  )
                : null;
              const forecast = quota?.forecast;
              return (
                <tr key={view.id}>
                  <td>
                    <span className={`source-dot ${view.id}`} aria-hidden="true" />
                    <strong>{view.name}</strong>
                    {quota && <small>{quota.bucketName}</small>}
                  </td>
                  <td>{quota ? dateTimeLabel(quota.resetsAt) : '—'}</td>
                  <td className="num">{cycle ? percent(cycle.peakUsedPercent) : '—'}</td>
                  <td className="num">{cycle ? money(cycle.cost, snapshot.costs.currency) : '—'}</td>
                  <td className={`forecast-outcome ${forecast?.state ?? 'unknown'}`}>
                    {!quota
                      ? 'Awaiting current reading'
                      : forecast?.expectedRemaining == null
                        ? 'Learning'
                        : `${percent(forecast.expectedRemaining)} expected at reset`}
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

export function Overview({
  snapshot,
  refreshing,
  onRefresh,
  onSetupClaude,
  onSources,
}: {
  snapshot: Snapshot;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onSetupClaude: () => void;
  onSources: () => void;
}) {
  const nowMs = Date.parse(snapshot.generatedAt);
  const views = providerViews(snapshot);
  const verdict = verdictSentence(snapshot.dashboardVerdict, snapshot.quotas, snapshot.sources);
  const attention = insights(views, snapshot, nowMs);
  const unknown = views.filter((view) => !hasForecast(view));
  const waiting = views.every((view) => !view.current || view.current.forecast.expired);
  const needsReadings = unknown.length > 0 || views.some((view) => view.stale);
  const headline = waiting
    ? 'Waiting for allowance readings'
    : snapshot.dashboardVerdict.state === 'safe' && unknown.length
      ? 'Available allowances on track'
      : verdict.headline;
  const secondary = unknown.length
    ? `${names(unknown)} ${unknown.length === 1 ? 'needs' : 'need'} more evidence before all allowances can be assessed.`
    : verdict.secondary;
  const statusTone = waiting ? 'unknown' : snapshot.dashboardVerdict.state;
  const unpriced = snapshot.costs.unpricedModels.map((entry) => entry.model).join(', ');

  return (
    <main
      className="page overview-page"
      id="panel-overview"
      role="tabpanel"
      aria-labelledby="tab-overview"
      tabIndex={-1}
    >
      <section className={`overview-status ${statusTone}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h1>{headline}</h1>
          <p>{secondary || 'Forecasts compare expected and heavier usage through each provider’s next reset.'}</p>
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
            {needsReadings && (
              <div className="action-row compact insight-actions">
                <button className="secondary-button" disabled={refreshing} onClick={() => void onRefresh()}>
                  {refreshing ? 'Refreshing…' : 'Refresh allowances'}
                </button>
                <button className="secondary-button" onClick={onSources}>
                  View sources
                </button>
                {!snapshot.quotas.claude && !snapshot.isPreview && (
                  <button className="secondary-button" onClick={onSetupClaude}>
                    Set up Claude
                  </button>
                )}
              </div>
            )}
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

      <TokenCapacity snapshot={snapshot} />

      <RecentCycles views={views} snapshot={snapshot} />
      <p className="overview-freshness">
        Snapshot {shortDate(snapshot.generatedAt)} · {snapshot.timezone} · Local data only
      </p>
    </main>
  );
}
