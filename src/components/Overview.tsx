import {
  AlertOctagon,
  AlertTriangle,
  AppWindow,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  RefreshCw,
} from 'lucide-react';
import { foldsInto, subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { bankedResetsFor } from '../banked-resets';
import { dailyBudget, paceLabel } from '../budget';
import {
  allowanceWindowLabel,
  capVisible,
  extraUsageAtLastRefresh,
  compactNumber,
  dateTimeLabel,
  money,
  percent,
  priceCoverage,
  quotaWindows,
  verdictSentence,
  whenLabel,
} from '../lib';
import { providerViews, type ProviderId, type ProviderView } from '../provider-view';
import { snapshotNowMs } from '../snapshot-time';
import type { ForecastState, QuotaWindow, Snapshot } from '../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { ProviderSummary } from './ProviderSummary';
import { STATE_WORD } from './StatePill';
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
function windowInsights(
  provider: ProviderId,
  name: string,
  window: QuotaWindow,
  nowMs: number,
  riskPace: number,
  included: string | null = null,
): Insight[] {
  const forecast = window.forecast;
  const about = { provider, bucketId: window.bucketId };
  if (forecast.expired) return [];
  // Fable draws on this window: one event, named once, with Fable included.
  if (included) {
    return windowInsights(provider, name, window, nowMs, riskPace).map((row) => ({
      ...row,
      title: `${row.title}, ${included} included`,
      detail: `${row.detail} Every Claude model shares this weekly limit.`,
    }));
  }
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
    // With no safe pace left the ratio is a placeholder, not a multiple.
    if (forecast.safePace <= 0) {
      return [
        {
          tone: 'warm',
          title: `${name} has no safe pace left`,
          detail: 'Nothing above the reserve is left for active use before the reset.',
          about,
        },
      ];
    }
    const reduction = Math.max(0, Math.round((1 - 1 / forecast.paceRatio) * 100));
    return [
      {
        // Warm only past the pace the user treats as a risk (Settings → Alerts),
        // the same line the verdict and its alerts use.
        tone: forecast.paceRatio > riskPace ? 'warm' : 'neutral',
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
  // When the Claude weekly limit, not Fable's own, drives Fable's forecast,
  // Fable's lines are Claude's: they are reported there, not twice.
  const fable = views.find((view) => view.id === 'fable')?.current ?? null;
  const claudeWindows = views.find((view) => view.id === 'claude')?.quota?.windows ?? [];
  const host = fable ? claudeWindows.find((window) => foldsInto(fable, window)) : undefined;
  const riskPace = Number(snapshot.settings.paceRiskThreshold) || 1.2;
  for (const view of views) {
    const forecast = view.current?.forecast;
    if (!view.current || !forecast || forecast.expired) continue;
    const folded = view.id === 'fable' && host != null;
    const included = (window: QuotaWindow) =>
      view.id === 'claude' && host?.bucketId === window.bucketId ? 'Fable' : null;
    if (!folded)
      rows.push(...windowInsights(view.id, view.name, view.current, nowMs, riskPace, included(view.current)));
    for (const window of view.secondaryWindows) {
      rows.push(
        ...windowInsights(
          view.id,
          `${view.name} ${allowanceWindowLabel(window)}`,
          window,
          nowMs,
          riskPace,
          included(window),
        ),
      );
    }
    if (view.stale) {
      rows.push({
        tone: 'warm',
        title: `${view.name} needs a current reading`,
        detail: 'The displayed balance is projected from the last successful local observation.',
      });
    }
  }
  // A plan without a Fable allowance has no Fable reading to wait for.
  const missing = views.filter(
    (view) =>
      (!view.current || view.current.forecast.expired) && !(view.id === 'fable' && snapshot.fableApplies === false),
  );
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

/*
 * The Master Caution lozenge. Act-now states (at risk, critical) fill it;
 * advisory ones (watch, on track) outline it in their colour; anything short
 * of a full assessment (waiting, learning, stale evidence, a partial
 * all-clear) keeps it neutral and dashed, never green.
 */
const STATUS_ICON = {
  safe: CheckCircle2,
  watch: AlertTriangle,
  risk: AlertTriangle,
  critical: AlertOctagon,
  unknown: CircleDashed,
} as const;

/** The status icon for a row in "Also worth knowing": the same icon and colour as its state. */
const INSIGHT_ICON = {
  hot: AlertOctagon,
  warm: AlertTriangle,
  neutral: CircleDashed,
  good: CheckCircle2,
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
  // Only unpriced usage of a counted plan makes its value a lower bound. Costs
  // file every source other than Codex under Claude, and so does this.
  const lowerBound = snapshot.costs.unpricedModels.some(
    (entry) => entry.tokens > 0 && plans.some(([id]) => (id === 'codex') === (entry.sourceId === 'codex')),
  );
  return { fees, multiple: value / fees, lowerBound, only: plans.length === 1 ? plans[0][1] : null };
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
  const nowMs = snapshotNowMs(snapshot);
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
        <section className="pnl overview-empty">
          <span className="overview-empty-icon" aria-hidden="true">
            <AppWindow />
          </span>
          <div>
            <h1>No subscriptions shown</h1>
            <p>
              Choose a subscription in Settings to show its allowances and forecasts. Your saved usage and cost history
              is still available.
            </p>
            <button type="button" className="btn" onClick={onSources}>
              Choose subscriptions
            </button>
          </div>
        </section>
      </main>
    );
  }
  // Every assessed allowance is on track, but some have no forecast yet: a
  // partial all-clear, which stays neutral rather than green.
  const partial = !waiting && snapshot.dashboardVerdict.state === 'safe' && unknown.length > 0;
  const headline = waiting
    ? 'Waiting for allowance readings'
    : partial
      ? 'Available allowances on track'
      : verdict.headline;
  const focus = waiting ? null : verdictFocus(views, snapshot, nowMs);
  const guidance = focus?.budget && focus.window.resetsAt ? { ...focus, budget: focus.budget } : null;
  const needsEvidence = unknown.length > 0;
  const secondary = needsEvidence
    ? `${names(unknown)} ${unknown.length === 1 ? 'needs' : 'need'} more evidence before all allowances can be assessed.`
    : verdict.secondary;
  const statusTone: ForecastState = waiting || partial ? 'unknown' : snapshot.dashboardVerdict.state;
  const StatusIcon = STATUS_ICON[statusTone] ?? CircleDashed;
  const SecondaryIcon = needsEvidence ? CircleDashed : CheckCircle2;
  const statusWord = waiting
    ? 'Awaiting data'
    : statusTone === 'unknown'
      ? !partial && snapshot.dashboardVerdict.label.startsWith('Allowance check needs current data')
        ? 'Needs reading'
        : 'Learning'
      : STATE_WORD[statusTone];
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
  const unpricedCount = snapshot.costs.unpricedModels.length;
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
      <section className="overview-status annunciator" data-tone={statusTone} role="status" aria-live="polite">
        <div className="annunciator-lozenge">
          <StatusIcon aria-hidden="true" />
          <span>{statusWord}</span>
        </div>
        <div className="annunciator-body">
          <h1>{headline}</h1>
          {guidance ? (
            <p className="status-guidance">
              Keep {guidance.label} under <b>{paceLabel(guidance.budget.budget)}</b> of its allowance per active day to
              reach its <b>{whenLabel(guidance.window.resetsAt, nowMs)}</b> reset. At your expected pace it uses{' '}
              <b>{paceLabel(guidance.budget.expected)}</b>.
            </p>
          ) : (
            !secondary && (
              <p className="status-note">
                Forecasts compare expected and heavier usage through each provider’s next reset.
              </p>
            )
          )}
          {secondary && (
            <p className={`status-secondary${needsEvidence ? ' unknown' : ' safe'}`}>
              <SecondaryIcon aria-hidden="true" />
              <span>{secondary}</span>
            </p>
          )}
        </div>
        {focus && onOpenProvider && (
          <div className="annunciator-action">
            <button
              type="button"
              className="btn btn-p btn-lg status-action"
              onClick={() => onOpenProvider(focus.view.id)}
            >
              Plan {focus.view.name} usage
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        )}
      </section>

      <section className="allowance-section" aria-labelledby="allowances-heading">
        <div className="allowance-section-head">
          <h2 id="allowances-heading" className="pnl-title">
            Allowances
          </h2>
          <ul className="runway-key" aria-label="Chart key">
            <li>
              <i className="key-observed" aria-hidden="true" />
              Observed
            </li>
            <li>
              <i className="key-expected" aria-hidden="true" />
              Expected
            </li>
            <li>
              <i className="key-band" aria-hidden="true" />
              Heavier-week range
            </li>
            {views.some((view) => capVisible(view.current)) && (
              <li>
                <i className="key-cap" aria-hidden="true" />
                Above the Claude weekly cap: not usable
              </li>
            )}
            <li>
              <i className="key-inactive" aria-hidden="true" />
              Outside active hours
            </li>
            <li className="key-tape-first">
              <i className="key-tape-reset" aria-hidden="true" />
              Left at reset
            </li>
            <li>
              <i className="key-tape-used" aria-hidden="true" />
              Likely used before reset
            </li>
            <li>
              <i className="key-expected-dot" aria-hidden="true" />
              Expected at reset
            </li>
            <li>
              <i className="key-heavier" aria-hidden="true" />
              Heavier week
            </li>
          </ul>
        </div>
        <div className="provider-card-grid">
          {views.map((view) => (
            <ProviderSummary
              key={view.id}
              view={view}
              nowMs={nowMs}
              settings={snapshot.settings}
              banked={bankedResetsFor(view.id, snapshot, nowMs)}
              extraUsage={view.id === 'fable' ? extraUsageAtLastRefresh(snapshot) : null}
              notInPlan={view.id === 'fable' && snapshot.fableApplies === false}
              onOpen={onOpenProvider ? () => onOpenProvider(view.id) : undefined}
            />
          ))}
        </div>
      </section>

      <div className="overview-lower">
        <section className="pnl attention-panel" aria-labelledby="attention-heading">
          <h2 id="attention-heading" className="pnl-title">
            Also worth knowing
          </h2>
          {attention.length ? (
            <div className="insight-list">
              {attention.map((row) => {
                const Icon = INSIGHT_ICON[row.tone];
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
            <div className="insight-actions">
              <button type="button" className="btn" disabled={refreshing} onClick={() => void onRefresh()}>
                <RefreshCw aria-hidden="true" className={refreshing ? 'spin' : undefined} />
                {refreshing ? 'Refreshing…' : 'Refresh allowances'}
              </button>
              <button type="button" className="btn" onClick={() => openSettings('sources')}>
                View sources
              </button>
              {snapshot.settings.showClaudeSubscription !== false && !snapshot.quotas.claude && !snapshot.isPreview && (
                <button type="button" className="btn" onClick={onSetupClaude}>
                  Set up Claude
                </button>
              )}
            </div>
          )}
        </section>

        <section className="pnl billing-summary" aria-labelledby="value-heading">
          <div className="ledger-head">
            <h2 id="value-heading" className="pnl-title">
              Last {snapshot.costs.periodDays} days at API prices
            </h2>
            <span>Calculated locally from your own usage records.</span>
          </div>
          <div className={`ledger${value ? '' : ' no-fees'}`}>
            <dl className="ledger-cell">
              <dt>
                <span>API-equivalent value</span>
                <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
              </dt>
              <dd className="ledger-value">
                {`${snapshot.costs.isLowerBound ? '≥ ' : ''}${money(snapshot.costs.actual, snapshot.costs.currency)}`}
              </dd>
              <dd className="ledger-note" title={unpriced ? `Unpriced: ${unpriced}` : undefined}>
                {snapshot.costs.isLowerBound
                  ? `Lower bound · ${compactNumber(unpricedCount)} model${unpricedCount === 1 ? '' : 's'} unpriced`
                  : `${snapshot.costs.periodDays}-day total`}
              </dd>
            </dl>
            <dl className="ledger-cell">
              <dt>
                <span>Saved by caching</span>
              </dt>
              <dd className="ledger-value">{money(snapshot.costs.cacheSavings, snapshot.costs.currency)}</dd>
              <dd className="ledger-note">{`${percent(snapshot.costs.cacheSavingsPercent * 100)} below uncached value`}</dd>
            </dl>
            <dl className="ledger-cell">
              <dt>
                <span>Price coverage</span>
              </dt>
              {/* With no usage there is nothing to price: not 0%, and not "all priced". */}
              <dd className="ledger-value">
                {snapshot.costs.totalTokens > 0 ? priceCoverage(snapshot.costs.coverage) : '—'}
              </dd>
              <dd className="ledger-note">
                {snapshot.costs.totalTokens > 0
                  ? unpriced
                    ? 'of recorded tokens'
                    : 'All tracked categories priced'
                  : 'No usage in this period'}
              </dd>
            </dl>
            {value && (
              <dl className="ledger-cell">
                <dt>
                  <span>Subscription value</span>
                </dt>
                <dd className="ledger-value">{`${value.lowerBound ? '≥ ' : ''}${value.multiple.toFixed(1)}×`}</dd>
                <dd className="ledger-note">
                  {`${value.only ? `${value.only} usage ` : ''}vs ${money(value.fees, snapshot.costs.currency)} of plan fees`}
                </dd>
              </dl>
            )}
          </div>
          {!value && (
            <div className="value-prompt">
              <span>Add your monthly plan fees to see how many times over each subscription pays for itself.</span>
              <button type="button" className="btn" onClick={() => openSettings('subscription-fees')}>
                Add fees
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
