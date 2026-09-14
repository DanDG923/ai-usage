import { compactNumber, projectName, shortDate, sourceLabel } from '../../lib';
import type { SessionPage, SessionPageOptions, Snapshot } from '../../types';
import { Pagination, usePagedQuery } from './paging';
import { EquivalentValue, matchesQuery } from './Tables';

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
    <section className="panel table-panel session-panel" aria-busy={loading} aria-labelledby="sessions-heading">
      <div className="panel-heading">
        <div>
          <h2 id="sessions-heading">Sessions</h2>
          <p>
            {preview
              ? 'Search the supplied example sessions.'
              : `All tracked sessions in the last ${days} days, largest first. Each model has its own row.`}
          </p>
        </div>
      </div>
      <div className="table-scroll">
        <table>
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
                    <span className={`source-dot ${row.sourceId}`} aria-hidden="true" />
                    {sourceLabel(row.sourceId)}
                  </td>
                  <td>
                    <strong>{projectName(row.project)}</strong>
                  </td>
                  <td>
                    <code className="session-id" title={row.sessionId}>
                      {row.sessionId.slice(0, 8)}
                    </code>
                  </td>
                  <td>{row.model}</td>
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
                      <button className="secondary-button" onClick={state.retry}>
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
          <button className="secondary-button" onClick={state.retry}>
            Try again
          </button>
        </div>
      )}
      <Pagination state={state} groupLabel="Session pages" loadingLabel="Loading sessions…" unit="results" />
    </section>
  );
}
