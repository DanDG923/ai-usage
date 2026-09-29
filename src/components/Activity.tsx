import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import { dateTimeLabel, percent, relativeTime, shortDate } from '../lib';
import type { ProviderView } from '../provider-view';
import { providerViews } from '../provider-view';
import type { Snapshot } from '../types';
import { DailyUsageChart } from './Charts';
import { ActivityHeatmap } from './details/ActivityHeatmap';
import { CycleHistory } from './details/CycleHistory';
import { RelativeTime } from './details/RelativeTime';
import '../pages.css';
import '../styles/activity.css';

/**
 * A source's standing as an icon and a word (Deck-StatesParts frame 15):
 * current is on track, a stale source or aged reading needs a refresh
 * (caution), a failing one is unavailable (warning), and an ended window
 * waits for a reading (neutral). A source that collected successfully is not
 * current while the balance it shows is older than the freshness rule allows.
 */
function sourceState(view: ProviderView) {
  const status = view.source?.status ?? 'waiting';
  if (view.expired) return { label: 'Needs reading', tone: 'unknown', icon: CircleDashed };
  if (status === 'error') return { label: 'Unavailable', tone: 'critical', icon: AlertOctagon };
  if (view.stale) return { label: 'Needs refresh', tone: 'watch', icon: AlertTriangle };
  if (status === 'connected') return { label: 'Current', tone: 'safe', icon: CheckCircle2 };
  return { label: status || 'Waiting', tone: 'unknown', icon: CircleDashed };
}

/**
 * Relative age first, because freshness is what the column is for, then the
 * exact instant. Past a day the relative form is already a date, so it is not
 * repeated.
 */
function ObservedAt({ value, nowMs }: { value: string; nowMs: number }) {
  const alreadyDated = relativeTime(value, nowMs) === shortDate(value);
  return (
    <>
      <RelativeTime value={value} nowMs={nowMs} />
      {alreadyDated ? null : <small>{dateTimeLabel(value)}</small>}
    </>
  );
}

/**
 * Current → expected at reset on one horizontal fuel tape: the solid part is
 * what should be left at the reset, the translucent part what is likely used
 * before it. Without a projection only the current level is drawn.
 */
function EvidenceTape({ view }: { view: ProviderView }) {
  const current = view.remaining;
  if (current == null) return null;
  const expected = view.expectedRemaining == null ? null : Math.min(current, view.expectedRemaining);
  const description =
    `${view.name}: ${percent(current)} left now` +
    (expected == null ? ', no expected level at reset yet.' : `, ${percent(expected)} expected at reset.`);
  return (
    <span className={`log-tape ${view.id}`} role="img" aria-label={description}>
      <i className="log-tape-used" style={{ width: `${current}%` }} />
      {expected != null && <i className="log-tape-left" style={{ width: `${expected}%` }} />}
    </span>
  );
}

export function Activity({ snapshot, days }: { snapshot: Snapshot; days: number }) {
  const views = providerViews(snapshot);
  const nowMs = Date.parse(snapshot.generatedAt);
  const visibleCycles = {
    codex: snapshot.settings.showCodexSubscription !== false ? snapshot.cycles.codex : [],
    claude: snapshot.settings.showClaudeSubscription !== false ? snapshot.cycles.claude : [],
    fable: snapshot.settings.showClaudeSubscription !== false ? snapshot.cycles.fable : [],
  };
  const cycleCount = Object.values(visibleCycles).reduce((total, rows) => total + rows.length, 0);
  const showDaily = snapshot.settings.showCodexSubscription !== false;
  const tapeKey = views.some((view) => view.remaining != null && view.expectedRemaining != null);
  return (
    <main
      className="page activity-page"
      id="panel-activity"
      role="tabpanel"
      aria-labelledby="tab-activity"
      tabIndex={-1}
    >
      <section className="page-lead product-lead log-lead">
        <div>
          <h1>Activity and evidence</h1>
          <p>Source freshness, local usage patterns, and the reset history behind each allowance forecast.</p>
        </div>
        <span className="badge log-count">
          {cycleCount} reset cycle{cycleCount === 1 ? '' : 's'} shown
        </span>
      </section>

      {views.length > 0 ? (
        <section className="pnl log-panel log-evidence" aria-labelledby="evidence-log-heading">
          <div className="log-heading">
            <h2 className="pnl-title" id="evidence-log-heading">
              Source evidence
            </h2>
            <p>Balances are never presented as current when their local source or observation is stale.</p>
          </div>
          <div className="log-scroll">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th className="log-col-provider">Provider</th>
                  <th className="log-col-status">Status</th>
                  <th className="log-col-time">Last observation</th>
                  <th className="log-col-provenance">Provenance</th>
                  <th className="log-col-tape">Current → expected at reset</th>
                </tr>
              </thead>
              <tbody>
                {views.map((view) => {
                  const state = sourceState(view);
                  const Icon = state.icon;
                  return (
                    <tr key={view.id}>
                      <td className="log-provider">
                        <span className={`swatch ${view.id}`} aria-hidden="true" />
                        <strong>{view.name}</strong>
                        <small>{view.subtitle}</small>
                      </td>
                      <td>
                        <span className={`evidence-state ${state.tone}`}>
                          <Icon aria-hidden="true" />
                          {state.label}
                        </span>
                      </td>
                      <td className="evidence-time">
                        {view.current ? <ObservedAt value={view.current.observedAt} nowMs={nowMs} /> : 'Not observed'}
                        <small>
                          {view.source?.last_success_at ? (
                            <>
                              Source succeeded <RelativeTime value={view.source.last_success_at} nowMs={nowMs} />
                            </>
                          ) : (
                            'No successful source reading yet'
                          )}
                        </small>
                      </td>
                      <td>
                        <span className="chip">{view.provenance.replaceAll('-', ' ')}</span>
                      </td>
                      <td className="log-tape-cell">
                        <span className="log-tape-row">
                          <strong className="num">
                            {view.remaining == null ? '—' : `${view.estimated ? '~' : ''}${percent(view.remaining)}`}
                          </strong>
                          <EvidenceTape view={view} />
                          <span className="num">{percent(view.expectedRemaining)}</span>
                        </span>
                        {view.expired && <small>Window expired</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {tapeKey && (
            <div className="log-tape-key" aria-hidden="true">
              <span>
                <i className="left" />
                Left at reset
              </span>
              <span>
                <i className="used" />
                Likely used before reset
              </span>
            </div>
          )}
        </section>
      ) : (
        <section className="pnl log-panel log-none">
          <h2 className="pnl-title">No subscriptions shown</h2>
          <p>
            Show a subscription in Settings to see its allowance evidence and reset cycles. Your saved history is
            retained.
          </p>
        </section>
      )}

      <div className="log-grid">
        {snapshot.costs.activityGrid ? (
          <ActivityHeatmap
            grid={snapshot.costs.activityGrid}
            currency={snapshot.costs.currency}
            days={snapshot.costs.periodDays}
          />
        ) : (
          <section className="pnl log-panel heatmap-panel" aria-labelledby="heatmap-heading">
            <div className="log-heading">
              <h2 className="pnl-title" id="heatmap-heading">
                When the work happens
              </h2>
            </div>
            <div className="empty-chart">Hourly activity appears after local token records have been collected.</div>
          </section>
        )}
        {showDaily && (
          <section className="pnl log-panel log-daily" aria-labelledby="daily-usage-heading">
            <div className="log-heading">
              <h2 className="pnl-title" id="daily-usage-heading">
                Daily Codex usage
              </h2>
              <p>
                Official daily token totals from the local Codex service over the current {days}-day analysis period.
              </p>
            </div>
            <DailyUsageChart rows={snapshot.dailyUsage || []} days={days} />
          </section>
        )}
      </div>

      {views.length > 0 && <CycleHistory cycles={visibleCycles} currency={snapshot.costs.currency} />}
    </main>
  );
}
