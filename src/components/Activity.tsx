import { CheckCircle2, CircleAlert, Database, History } from 'lucide-react';
import { dateTimeLabel, percent, relativeTime, shortDate } from '../lib';
import { providerViews } from '../provider-view';
import type { Snapshot } from '../types';
import { DailyUsageChart } from './Charts';
import { ActivityHeatmap } from './details/ActivityHeatmap';
import { CycleHistory } from './details/CycleHistory';
import { RelativeTime } from './details/RelativeTime';
import '../pages.css';

function sourceState(status: string, expired: boolean) {
  if (expired) return { label: 'Needs reading', tone: 'watch', icon: CircleAlert };
  if (status === 'connected') return { label: 'Current', tone: 'safe', icon: CheckCircle2 };
  if (status === 'stale' || status === 'degraded') return { label: 'Needs refresh', tone: 'watch', icon: CircleAlert };
  if (status === 'error') return { label: 'Unavailable', tone: 'critical', icon: CircleAlert };
  return { label: status || 'Waiting', tone: 'unknown', icon: Database };
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

export function Activity({ snapshot, days }: { snapshot: Snapshot; days: number }) {
  const views = providerViews(snapshot);
  const nowMs = Date.parse(snapshot.generatedAt);
  const visibleCycles = {
    codex: snapshot.settings.showCodexSubscription !== false ? snapshot.cycles.codex : [],
    claude: snapshot.settings.showClaudeSubscription !== false ? snapshot.cycles.claude : [],
    fable: snapshot.settings.showClaudeSubscription !== false ? snapshot.cycles.fable : [],
  };
  const cycleCount = Object.values(visibleCycles).reduce((total, rows) => total + rows.length, 0);
  return (
    <main
      className="page activity-page"
      id="panel-activity"
      role="tabpanel"
      aria-labelledby="tab-activity"
      tabIndex={-1}
    >
      <section className="page-lead product-lead">
        <div>
          <h1>Activity and evidence</h1>
          <p>Source freshness, local usage patterns, and the reset history behind each allowance forecast.</p>
        </div>
        <div className="page-fact">
          <History aria-hidden="true" />
          <span>
            {cycleCount} reset cycle{cycleCount === 1 ? '' : 's'} shown
          </span>
        </div>
      </section>

      {views.length > 0 ? (
        <section className="panel evidence-panel">
          <div className="panel-heading">
            <div>
              <h2>Source evidence</h2>
              <p>Balances are never presented as current when their local source or observation is stale.</p>
            </div>
          </div>
          <div className="table-scroll compact-table-scroll">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Last observation</th>
                  <th>Provenance</th>
                  <th className="num">Current</th>
                  <th className="num">Expected at reset</th>
                </tr>
              </thead>
              <tbody>
                {views.map((view) => {
                  const state = sourceState(view.source?.status ?? 'waiting', view.expired);
                  const Icon = state.icon;
                  return (
                    <tr key={view.id}>
                      <td>
                        <span className={`source-dot ${view.id}`} aria-hidden="true" />
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
                      <td>{view.provenance.replaceAll('-', ' ')}</td>
                      <td className="num">
                        {view.remaining == null ? '—' : `${view.estimated ? '~' : ''}${percent(view.remaining)}`}
                        {view.expired && <small>Window expired</small>}
                      </td>
                      <td className="num">{percent(view.expectedRemaining)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="panel status-panel">
          <h2>No subscriptions shown</h2>
          <p>
            Show a subscription in Settings to see its allowance evidence and reset cycles. Your saved history is
            retained.
          </p>
        </section>
      )}

      <div className="activity-grid">
        {snapshot.costs.activityGrid ? (
          <ActivityHeatmap
            grid={snapshot.costs.activityGrid}
            currency={snapshot.costs.currency}
            days={snapshot.costs.periodDays}
          />
        ) : (
          <section className="panel activity-empty">
            <h2>When the work happens</h2>
            <p>Hourly activity appears after local token records have been collected.</p>
          </section>
        )}
        {snapshot.settings.showCodexSubscription !== false && (
          <section className="panel table-panel daily-usage-panel activity-daily-panel">
            <div className="panel-heading">
              <div>
                <h2>Daily Codex usage</h2>
                <p>
                  Official daily token totals from the local Codex service over the current {days}-day analysis period.
                </p>
              </div>
            </div>
            <DailyUsageChart rows={snapshot.dailyUsage || []} days={days} />
          </section>
        )}
      </div>

      {views.length > 0 && <CycleHistory cycles={visibleCycles} currency={snapshot.costs.currency} />}
    </main>
  );
}
