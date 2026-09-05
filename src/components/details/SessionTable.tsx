import { useEffect, useState } from 'react';
import { compactNumber, projectName, shortDate, sourceLabel } from '../../lib';
import type { SessionPage, Snapshot } from '../../types';
import { EquivalentValue, matchesQuery } from './Tables';

const PAGE_SIZE = 10;

type Result = { key: string; selectionKey: string; data?: SessionPage; error?: string };

export function SessionTable({ snapshot, query }: { snapshot: Snapshot; query: string }) {
  const { costs } = snapshot;
  const days = costs.periodDays;
  const filter = query.trim();
  const selectionKey = `${days}:${filter}`;
  const [selection, setSelection] = useState({ key: selectionKey, page: 1 });
  if (selection.key !== selectionKey) setSelection({ key: selectionKey, page: 1 });
  const page = selection.key === selectionKey ? selection.page : 1;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const requestKey = JSON.stringify([selectionKey, page, snapshot.generatedAt, costs.currency, retry]);
  const preview = Boolean(snapshot.isPreview);
  const examples = costs.sessions;

  useEffect(() => {
    let cancelled = false;
    // Give typing a short settling window before querying the local history.
    const timer = window.setTimeout(() => {
      const load = async (): Promise<SessionPage> => {
        if (preview && !window.aiUsage) {
          const matching = examples.filter((row) =>
            matchesQuery(filter, [row.sourceId, sourceLabel(row.sourceId), row.project, row.sessionId, row.model]),
          );
          const totalPages = Math.ceil(matching.length / PAGE_SIZE);
          const currentPage = Math.min(page, Math.max(1, totalPages));
          return {
            rows: matching.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
            total: matching.length,
            page: currentPage,
            pageSize: PAGE_SIZE,
            totalPages,
          };
        }
        if (!window.aiUsage?.getSessions)
          throw new Error('Session history could not be loaded. Restart the app to reconnect.');
        return window.aiUsage.getSessions({ days, query: filter, page, pageSize: PAGE_SIZE });
      };
      void load().then(
        (data) => {
          if (!cancelled) setResult({ key: requestKey, selectionKey, data });
        },
        (error: unknown) => {
          if (!cancelled)
            setResult({
              key: requestKey,
              selectionKey,
              error: error instanceof Error ? error.message : 'Session history could not be loaded.',
            });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [days, examples, filter, page, preview, requestKey, selectionKey]);

  // A response belongs only to the exact period, filter, page and snapshot
  // requested. An older response can never relabel the current search.
  const current = result?.key === requestKey ? result : null;
  const data = current?.data;
  const loading = !current;
  const pagination = data ?? (result?.selectionKey === selectionKey ? result.data : undefined);
  const first = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;
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
                  ) : current?.error ? (
                    <div className="session-error">
                      <span role="alert">{current.error}</span>
                      <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>
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
      {pagination && pagination.total > 0 && (
        <div className="session-pagination">
          <span role="status">
            {loading
              ? 'Loading sessions…'
              : `${first.toLocaleString()}–${last.toLocaleString()} of ${pagination.total.toLocaleString()} results`}
          </span>
          <div className="action-row compact" role="group" aria-label="Session pages">
            <button
              className="secondary-button"
              disabled={!loading && pagination.page <= 1}
              aria-disabled={loading || pagination.page <= 1}
              onClick={() => {
                if (data && data.page > 1) setSelection({ key: selectionKey, page: data.page - 1 });
              }}
            >
              Previous
            </button>
            <span>
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              className="secondary-button"
              disabled={!loading && pagination.page >= pagination.totalPages}
              aria-disabled={loading || pagination.page >= pagination.totalPages}
              onClick={() => {
                if (data && data.page < data.totalPages) setSelection({ key: selectionKey, page: data.page + 1 });
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
