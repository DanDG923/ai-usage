import { compactNumber, projectName, shortDate, sourceLabel } from '../../lib';
import type { SessionPage, SessionPageOptions, Snapshot } from '../../types';
import { Pagination, usePagedQuery } from './paging';
import { EquivalentValue, SourceMark, matchesQuery } from './Tables';

type SessionRow = SessionPage['rows'][number];

// Module-level so the query hook can hold them as stable dependencies.
const matchesSession = (row: SessionRow, filter: string) =>
  matchesQuery(filter, [row.sourceId, sourceLabel(row.sourceId), row.project, row.sessionId, row.model]);
const fetchSessions = (options: SessionPageOptions) => window.aiUsage?.getSessions?.(options);

export function SessionTable({ snapshot, query }: { snapshot: Snapshot; query: string }) {
  const { costs } = snapshot;
  const state = usePagedQuery({
    snapshot,
    query,
    examples: costs.sessions,
    matches: matchesSession,
    fetch: fetchSessions,
    unavailable: 'Session history could not be loaded. Restart the app to reconnect.',
    failed: 'Session history could not be loaded.',
  });
  const { days, filter, preview, data, loading, error } = state;
  return (
    <section className="panel costs-panel session-panel" aria-busy={loading} aria-labelledby="sessions-heading">
      <div className="costs-head">
        <div>
          <h3 id="sessions-heading" className="pnl-title">
            Sessions
          </h3>
          <p>
            {preview
              ? 'Search the supplied example sessions.'
              : `All tracked sessions in the last ${days} days, largest first. Each model has its own row.`}
          </p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="costs-table session-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Project</th>
              <th>Session</th>
              <th>Model</th>
              <th>Last activity</th>
              <th className="num">Tokens</th>
              <th className="num">API-equivalent</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.length ? (
              data.rows.map((row) => (
                <tr key={`${row.sourceId}-${row.sessionId}-${row.model}`}>
                  <td>
                    <SourceMark sourceId={row.sourceId} />
                  </td>
                  <td className="costs-name">{projectName(row.project)}</td>
                  <td>
                    <code className="session-id" title={row.sessionId}>
                      {row.sessionId.slice(0, 8)}
                    </code>
                  </td>
                  <td>
                    <span className="costs-model">{row.model}</span>
                  </td>
                  <td>{shortDate(row.occurredAt)}</td>
                  <td className="num">{compactNumber(row.totalTokens)}</td>
                  <td className="num">
                    <EquivalentValue cost={row.cost} coverage={row.coverage} currency={costs.currency} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {loading ? (
                    <span role="status">Loading sessions…</span>
                  ) : error ? (
                    <div className="session-error">
                      <span role="alert">{error}</span>
                      <button type="button" className="btn" onClick={state.retry}>
                        Try again
                      </button>
                    </div>
                  ) : filter ? (
                    'No sessions match this filter.'
                  ) : preview ? (
                    'No example sessions are supplied.'
                  ) : (
                    'No tracked sessions in this period yet.'
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && error && (
        <div className="session-error">
          <span role="alert">{error} Showing the previous results.</span>
          <button type="button" className="btn" onClick={state.retry}>
            Try again
          </button>
        </div>
      )}
      <Pagination state={state} groupLabel="Session pages" loadingLabel="Loading sessions…" unit="results" />
    </section>
  );
}
