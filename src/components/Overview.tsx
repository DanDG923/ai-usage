import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Gauge,
  ShieldCheck,
} from 'lucide-react';
import { subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { bankedResetsFor } from '../banked-resets';
import { dailyBudget, paceLabel } from '../budget';
import {
  allowanceWindowLabel,
  compactNumber,
  dateTimeLabel,
  money,
  percent,
  priceCoverage,
  quotaWindows,
  shortDate,
  verdictSentence,
  whenLabel,
} from '../lib';
import { providerViews, type ProviderId, type ProviderView } from '../provider-view';
import type { QuotaWindow, Snapshot } from '../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { ProviderSummary } from './ProviderSummary';
import '../overview.css';

type Insight = {
  tone: 'neutral' | 'good' | 'warm' | 'hot';
  title: string;
  detail: string;
  /** The allowance window the insight is about, when it is about one. */
  about?: { provider: ProviderId; bucketId: string };
};

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
function windowInsights(provider: ProviderId, name: string, window: QuotaWindow, nowMs: number): Insight[] {
  const forecast = window.forecast;
  const about = { provider, bucketId: window.bucketId };
  if (forecast.expired) return [];
  if (forecast.exhaustsAt) {
    return [
      {
        tone: 'hot',
        title: `${name} is expected to run out`,
        detail: `${whenLabel(forecast.exhaustsAt, nowMs)}, before its ${dateTimeLabel(window.resetsAt)} reset.`,
        about,
      },
    ];
  }
  if (forecast.heavyExhaustsAt) {
    return [
      {
        tone: 'warm',
        title: `${name} could run out under heavier usage`,
        detail: `Expected usage leaves ${percent(forecast.expectedRemaining)}; the heavier case reaches zero ${whenLabel(forecast.heavyExhaustsAt, nowMs)}.`,
        about,
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
        about,
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
    rows.push(...windowInsights(view.id, view.name, view.current, nowMs));
    for (const window of view.secondaryWindows) {
      rows.push(...windowInsights(view.id, `${view.name} ${allowanceWindowLabel(window)}`, window, nowMs));
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
  // Banked and free resets appear on their provider's card instead.
  const severity = { hot: 0, warm: 1, neutral: 2, good: 3 };
  return rows.sort((a, b) => severity[a.tone] - severity[b.tone]);
}

/**
 * The allowance the status line is about: the backend verdict's first affected
 * window that is still shown, with its budget when the forecast supports one.
 */
function verdictFocus(views: ProviderView[], snapshot: Snapshot, nowMs: number) {
  if (snapshot.dashboardVerdict.state === 'safe') return null;
  for (const detail of snapshot.dashboardVerdict.details ?? []) {
    if (detail.state === 'safe') continue;
    const view = views.find((entry) => entry.id === detail.sourceId);
    if (!view?.current) continue;
    const window =
      quotaWindows(view.quota).find((entry) => entry.bucketId === detail.bucketId && !entry.forecast.expired) ??
      view.current;
    const secondary = window.bucketId !== view.current.bucketId;
    return {
      view,
      window,
      label: secondary ? `${view.name} ${allowanceWindowLabel(window)}` : view.name,
      budget: dailyBudget(window, snapshot.settings, nowMs),
    };
  }
  return null;
}

const STATUS_ICON = {
  safe: CheckCircle2,
  watch: AlertTriangle,
  risk: AlertTriangle,
  critical: AlertOctagon,
  unknown: CircleDashed,
} as const;

/**
 * The period's API-equivalent value of each visible subscription with a fee,
 * as a multiple of those fees. A plan that is hidden or has no fee is left out
 * of both sides, so its usage is never credited to another plan's fee.
 */
function subscriptionValue(snapshot: Snapshot) {
  const settings = snapshot.settings;
  const plans = (
    [
      ['codex', 'Codex', settings.codexPlanUsdPerMonth],
      ['claude', 'Claude', settings.claudePlanUsdPerMonth],
    ] as const
  ).filter(([id, , fee]) => subscriptionVisible(settings, id) && Number(fee) > 0);
  if (!plans.length) return null;
  const monthlyUsd = plans.reduce((sum, [, , fee]) => sum + Number(fee), 0);
  const fees = monthlyUsd * (Number(settings.usdToCurrency) || 1) * (snapshot.costs.periodDays / (365.25 / 12));
  const value = snapshot.costs.chart.reduce((sum, day) => sum + plans.reduce((total, [id]) => total + day[id], 0), 0);
  return { fees, multiple: value / fees, only: plans.length === 1 ? plans[0][1] : null };
}

export function Overview({
  snapshot,
  refreshing,
  onRefresh,
  onSetupClaude,
  onSources,
  onOpenProvider,
  onOpenSettings,
}: {
  snapshot: Snapshot;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onSetupClaude: () => void;
  onSources: () => void;
  onOpenProvider?: (provider: ProviderId) => void;
  /** Opens Settings at a section; falls back to onSources when absent. */
  onOpenSettings?: (section: string) => void;
}) {
  const nowMs = Date.parse(snapshot.generatedAt);
  const views = providerViews(snapshot);
  const verdict = verdictSentence(
    snapshot.dashboardVerdict,
    {
      codex: snapshot.settings.showCodexSubscription !== false ? snapshot.quotas.codex : null,
      claude: snapshot.settings.showClaudeSubscription !== false ? snapshot.quotas.claude : null,
      fable: snapshot.settings.showClaudeSubscription !== false ? snapshot.quotas.fable : null,
    },
    snapshot.sources,
  );
  const allInsights = insights(views, snapshot, nowMs);
  // A plan without a Fable allowance has no Fable evidence to wait for.
  const unknown = views.filter(
    (view) => !hasForecast(view) && !(view.id === 'fable' && snapshot.fableApplies === false),
  );
  const waiting = views.every((view) => !view.current || view.current.forecast.expired);
  const needsReadings = unknown.length > 0 || views.some((view) => view.stale);
  if (!views.length) {
    return (
      <main
        className="page overview-page"
        id="panel-overview"
        role="tabpanel"
        aria-labelledby="tab-overview"
        tabIndex={-1}
      >
        <section className="panel status-panel">
          <h1>No subscriptions shown</h1>
          <p>
            Choose a subscription in Settings to show its allowances and forecasts. Your saved usage and cost history is
            still available.
          </p>
          <button className="secondary-button" onClick={onSources}>
            Choose subscriptions
          </button>
        </section>
      </main>
    );
  }
  const headline = waiting
    ? 'Waiting for allowance readings'
    : snapshot.dashboardVerdict.state === 'safe' && unknown.length
      ? 'Available allowances on track'
      : verdict.headline;
  const focus = waiting ? null : verdictFocus(views, snapshot, nowMs);
  const guidance =
    focus?.budget && focus.window.resetsAt
      ? `Keep ${focus.label} under ${paceLabel(focus.budget.budget)} of its allowance per active day to reach its ${whenLabel(focus.window.resetsAt, nowMs)} reset. At your expected pace it uses ${paceLabel(focus.budget.expected)}.`
      : '';
  const secondary = unknown.length
    ? `${names(unknown)} ${unknown.length === 1 ? 'needs' : 'need'} more evidence before all allowances can be assessed.`
    : verdict.secondary;
  const statusTone = waiting ? 'unknown' : snapshot.dashboardVerdict.state;
  const StatusIcon = STATUS_ICON[statusTone] ?? CircleDashed;
  // The status line already states its window; list everything else once.
  const attention = allInsights.filter(
    (row) =>
      !(
        focus &&
        row.about &&
        row.about.provider === focus.view.id &&
        row.about.bucketId === focus.window.bucketId &&
        (row.tone === 'hot' || row.tone === 'warm')
      ),
  );
  const unpriced = snapshot.costs.unpricedModels.map((entry) => entry.model).join(', ');
  const value = subscriptionValue(snapshot);
  const openSettings = (section: string) => (onOpenSettings ? onOpenSettings(section) : onSources());

  return (
    <main
      className="page overview-page"
      id="panel-overview"
      role="tabpanel"
      aria-labelledby="tab-overview"
      tabIndex={-1}
    >
      <section className={`overview-status ${statusTone}`} role="status" aria-live="polite">
        <span className="status-icon" aria-hidden="true">
          <StatusIcon />
        </span>
        <div>
          <h1>{headline}</h1>
          <p>
            {[guidance, secondary].filter(Boolean).join(' ') ||
              'Forecasts compare expected and heavier usage through each provider’s next reset.'}
          </p>
        </div>
        {focus && onOpenProvider && (
          <button type="button" className="primary-button status-action" onClick={() => onOpenProvider(focus.view.id)}>
            Plan {focus.view.name} usage
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </section>

      <section className="allowance-section" aria-labelledby="allowances-heading">
        <div className="allowance-section-head">
          <h2 id="allowances-heading">Allowances</h2>
          <div className="runway-key" role="group" aria-label="Chart key">
            <span>
              <i className="key-observed" aria-hidden="true" />
              Observed
            </span>
            <span>
              <i className="key-expected" aria-hidden="true" />
              Expected
            </span>
            <span>
              <i className="key-band" aria-hidden="true" />
              Heavier-week range
            </span>
            <span>
              <i className="key-inactive" aria-hidden="true" />
              Outside active hours
            </span>
          </div>
        </div>
        <div className="provider-card-grid">
          {views.map((view) => (
            <ProviderSummary
              key={view.id}
              view={view}
              nowMs={nowMs}
              settings={snapshot.settings}
              banked={bankedResetsFor(view.id, snapshot, nowMs)}
              onOpen={onOpenProvider ? () => onOpenProvider(view.id) : undefined}
            />
          ))}
        </div>
      </section>

      <div className="overview-lower">
        <section className="panel attention-panel" aria-labelledby="attention-heading">
          <div className="panel-heading compact-heading">
            <h2 id="attention-heading">Also worth knowing</h2>
          </div>
          {attention.length ? (
            <div className="insight-list">
              {attention.map((row) => {
                const Icon = row.tone === 'hot' || row.tone === 'warm' ? AlertTriangle : Gauge;
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
          ) : (
            <div className="insight-list">
              <article className="insight good">
                <CheckCircle2 aria-hidden="true" />
                <div>
                  <strong>Nothing else needs attention</strong>
                  <p>Every other allowance keeps its expected and heavier projections above zero until reset.</p>
                </div>
              </article>
            </div>
          )}
          {needsReadings && (
            <div className="action-row compact insight-actions">
              <button className="secondary-button" disabled={refreshing} onClick={() => void onRefresh()}>
                {refreshing ? 'Refreshing…' : 'Refresh allowances'}
              </button>
              <button className="secondary-button" onClick={onSources}>
                View sources
              </button>
              {snapshot.settings.showClaudeSubscription !== false && !snapshot.quotas.claude && !snapshot.isPreview && (
                <button className="secondary-button" onClick={onSetupClaude}>
                  Set up Claude
                </button>
              )}
            </div>
          )}
        </section>

        <section className="panel billing-summary" aria-labelledby="value-heading">
          <div className="panel-heading compact-heading">
            <h2 id="value-heading">Last {snapshot.costs.periodDays} days at API prices</h2>
          </div>
          <dl>
            <div className="billing-primary">
              <dt>
                API-equivalent value{' '}
                <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
              </dt>
              <dd>
                {snapshot.costs.isLowerBound ? '≥ ' : ''}
                {money(snapshot.costs.actual, snapshot.costs.currency)}
              </dd>
              <small title={unpriced ? `Unpriced: ${unpriced}` : undefined}>
                {snapshot.costs.isLowerBound
                  ? `Lower bound · ${compactNumber(snapshot.costs.unpricedModels.length)} model${snapshot.costs.unpricedModels.length === 1 ? '' : 's'} unpriced`
                  : `${snapshot.costs.periodDays}-day total`}
              </small>
            </div>
            <div>
              <dt>Saved by caching</dt>
              <dd>{money(snapshot.costs.cacheSavings, snapshot.costs.currency)}</dd>
              <small>{percent(snapshot.costs.cacheSavingsPercent * 100)} below uncached value</small>
            </div>
            <div>
              <dt>Price coverage</dt>
              <dd>{priceCoverage(snapshot.costs.coverage)}</dd>
              <small>{unpriced ? 'of recorded tokens' : 'All tracked categories priced'}</small>
            </div>
            {value && (
              <div>
                <dt>Subscription value</dt>
                <dd>
                  {snapshot.costs.isLowerBound ? '≥ ' : ''}
                  {value.multiple.toFixed(1)}×
                </dd>
                <small>
                  {value.only ? `${value.only} usage ` : ''}vs {money(value.fees, snapshot.costs.currency)} of plan fees
                </small>
              </div>
            )}
          </dl>
          {!value && (
            <div className="value-prompt">
              <span>Add your monthly plan fees to see how many times over each subscription pays for itself.</span>
              <button type="button" className="text-button" onClick={() => openSettings('subscription-fees')}>
                Add fees
              </button>
            </div>
          )}
          <div className="local-assurance">
            <ShieldCheck aria-hidden="true" />
            <span>Calculated locally from your own usage records.</span>
          </div>
        </section>
      </div>

      <p className="overview-freshness">
        Snapshot {shortDate(snapshot.generatedAt)} · {snapshot.timezone} · Local data only
      </p>
    </main>
  );
}
