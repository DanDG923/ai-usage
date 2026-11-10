import { AppWindow, CheckCircle2, ChevronRight, CircleDashed, RefreshCw } from 'lucide-react';
import { subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { bankedResetsFor } from '../banked-resets';
import { paceLabel } from '../budget';
import { capVisible, extraUsageAtLastRefresh, compactNumber, money, percent, priceCoverage, whenLabel } from '../lib';
import { overviewStatus, subscriptionValue, type Insight } from '../overview-view';
import { providerViews, type ProviderId } from '../provider-view';
import { snapshotNowMs } from '../snapshot-time';
import type { ForecastState, Snapshot } from '../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { ProviderSummary } from './ProviderSummary';
import { ALERT_STATE_ICON } from './StatePill';
import '../styles/pages/overview.css';

/** The state whose icon a row in "Also worth knowing" carries: the same icon and colour as that state. */
const INSIGHT_STATE: Record<Insight['tone'], ForecastState> = {
  hot: 'critical',
  warm: 'risk',
  neutral: 'unknown',
  good: 'safe',
};

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
  if (!views.length) {
    return (
      <main>
        <div
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
                Choose a subscription in Settings to show its allowances and forecasts. Your saved usage and cost
                history is still available.
              </p>
              <button type="button" className="btn" onClick={onSources}>
                Choose subscriptions
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }
  const status = overviewStatus(snapshot, views, nowMs);
  const { focus, guidance, secondary, needsEvidence, attention } = status;
  // The Master Caution lozenge draws watch as the warning triangle.
  const StatusIcon = ALERT_STATE_ICON[status.tone] ?? CircleDashed;
  const SecondaryIcon = needsEvidence ? CircleDashed : CheckCircle2;
  const unpriced = snapshot.costs.unpricedModels.map((entry) => entry.model).join(', ');
  const unpricedCount = snapshot.costs.unpricedModels.length;
  const value = subscriptionValue(snapshot);
  const openSettings = (section: string) => (onOpenSettings ? onOpenSettings(section) : onSources());

  return (
    <main>
      <div
        className="page overview-page"
        id="panel-overview"
        role="tabpanel"
        aria-labelledby="tab-overview"
        tabIndex={-1}
      >
        <section className="overview-status annunciator" data-tone={status.tone} role="status" aria-live="polite">
          <div className="annunciator-lozenge">
            <StatusIcon aria-hidden="true" />
            <span>{status.word}</span>
          </div>
          <div className="annunciator-body">
            <h1>{status.headline}</h1>
            {guidance ? (
              <p className="status-guidance">
                Keep {guidance.label} under <b>{paceLabel(guidance.budget.budget)}</b> of its allowance per active day
                to reach its <b>{whenLabel(guidance.window.resetsAt, nowMs)}</b> reset. At your expected pace it uses{' '}
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
                  const Icon = ALERT_STATE_ICON[INSIGHT_STATE[row.tone]];
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
            {status.needsReadings && (
              <div className="insight-actions">
                <button type="button" className="btn" disabled={refreshing} onClick={() => void onRefresh()}>
                  <RefreshCw aria-hidden="true" className={refreshing ? 'spin' : undefined} />
                  {refreshing ? 'Refreshing…' : 'Refresh allowances'}
                </button>
                <button type="button" className="btn" onClick={() => openSettings('sources')}>
                  View sources
                </button>
                {subscriptionVisible(snapshot.settings, 'claude') && !snapshot.quotas.claude && !snapshot.isPreview && (
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
      </div>
    </main>
  );
}
