import { useEffect, useState } from 'react';
import { formatInt } from '../../lib';
import type { SessionPageOptions, Snapshot } from '../../types';

export const PAGE_SIZE = 10;

export type Paged<Row> = { rows: Row[]; total: number; page: number; pageSize: number; totalPages: number };

type Result<Row> = { key: string; selectionKey: string; data?: Paged<Row>; error?: string };

/**
 * One paged, filtered read of local history, shared by the session and task
 * tables so their debounce, cancellation, stale-response guard and page reset
 * cannot drift apart again.
 *
 * `matches` and `fetch` are effect dependencies, so callers must pass
 * module-level functions: a new function per render would re-issue the
 * request on every render. `fetch` returns undefined when the desktop bridge
 * is missing, which surfaces as the `unavailable` message.
 */
export function usePagedQuery<Row>({
  snapshot,
  query,
  examples,
  matches,
  fetch,
  unavailable,
  failed,
}: {
  snapshot: Snapshot;
  query: string;
  examples: Row[];
  matches: (row: Row, filter: string) => boolean;
  fetch: (options: SessionPageOptions) => Promise<Paged<Row>> | undefined;
  unavailable: string;
  failed: string;
}) {
  const { costs } = snapshot;
  const days = costs.periodDays;
  const filter = query.trim();
  const selectionKey = `${days}:${filter}`;
  const [selection, setSelection] = useState({ key: selectionKey, page: 1 });
  if (selection.key !== selectionKey) setSelection({ key: selectionKey, page: 1 });
  const page = selection.key === selectionKey ? selection.page : 1;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<Result<Row> | null>(null);
  const requestKey = JSON.stringify([selectionKey, page, snapshot.generatedAt, costs.currency, retry]);
  const preview = Boolean(snapshot.isPreview);

  useEffect(() => {
    let cancelled = false;
    // Give typing a short settling window before querying the local history.
    const timer = window.setTimeout(() => {
      const load = async (): Promise<Paged<Row>> => {
        if (preview && !window.aiUsage) {
          const matching = examples.filter((row) => matches(row, filter));
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
        const request = fetch({ days, query: filter, page, pageSize: PAGE_SIZE });
        if (!request) throw new Error(unavailable);
        return request;
      };
      void load().then(
        (data) => {
          if (!cancelled) setResult({ key: requestKey, selectionKey, data });
        },
        (error: unknown) => {
          if (!cancelled)
            setResult({ key: requestKey, selectionKey, error: error instanceof Error ? error.message : failed });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [days, examples, failed, fetch, filter, matches, page, preview, requestKey, selectionKey, unavailable]);

  // A response belongs only to the exact period, filter, page and snapshot
  // requested. An older response can never relabel the current search.
  const current = result?.key === requestKey ? result : null;
  const data = current?.data;
  const loading = !current;
  const pagination = data ?? (result?.selectionKey === selectionKey ? result.data : undefined);
  const first = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  return {
    days,
    filter,
    preview,
    selectionKey,
    data,
    loading,
    error: current?.error,
    pagination,
    first,
    last,
    retry: () => setRetry((value) => value + 1),
    goToPage: (next: number) => setSelection({ key: selectionKey, page: next }),
  };
}

export type PagedState = {
  data?: Paged<unknown>;
  pagination?: Paged<unknown>;
  loading: boolean;
  first: number;
  last: number;
  goToPage: (page: number) => void;
};

/**
 * The buttons stay focusable while a page loads, marked aria-disabled, so a
 * keyboard user paging quickly is not dropped out of the control group; the
 * click guards make a press during loading a no-op instead.
 */
export function Pagination({
  state,
  groupLabel,
  loadingLabel,
  unit,
}: {
  state: PagedState;
  groupLabel: string;
  loadingLabel: string;
  unit: string;
}) {
  const { pagination, data, loading, first, last, goToPage } = state;
  if (!pagination || pagination.total <= 0) return null;
  return (
    <div className="session-pagination">
      <span role="status">
        {loading ? loadingLabel : `${formatInt(first)}–${formatInt(last)} of ${formatInt(pagination.total)} ${unit}`}
      </span>
      <div className="action-row compact" role="group" aria-label={groupLabel}>
        <button
          className="secondary-button"
          disabled={!loading && pagination.page <= 1}
          aria-disabled={loading || pagination.page <= 1}
          onClick={() => {
            if (data && data.page > 1) goToPage(data.page - 1);
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
            if (data && data.page < data.totalPages) goToPage(data.page + 1);
          }}
        >
          Next
        </button>
      </div>
    </div>
  );
}
