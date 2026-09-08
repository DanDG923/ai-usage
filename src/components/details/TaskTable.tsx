import { useEffect, useState } from 'react';
import { compactNumber, formatInt, projectName, shortDate, sourceLabel } from '../../lib';
import type { TaskCost, TaskPage, Snapshot, TaskUsageTotals } from '../../types';
import { EquivalentValue, matchesQuery } from './Tables';

const PAGE_SIZE = 10;
const EMPTY_TASKS: TaskCost[] = [];

type Result = { key: string; selectionKey: string; data?: TaskPage; error?: string };

export function TaskTable({ snapshot, query }: { snapshot: Snapshot; query: string }) {
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
  const examples = costs.tasks ?? EMPTY_TASKS;

  useEffect(() => {
    let cancelled = false;
    // Give typing a short settling window before querying the local history.
    const timer = window.setTimeout(() => {
      const load = async (): Promise<TaskPage> => {
        if (preview && !window.aiUsage) {
          const matching = examples.filter((row) =>
            matchesQuery(filter, [
              row.sourceId,
              sourceLabel(row.sourceId),
              row.project,
              row.sessionId,
              row.taskId,
              ...row.agents.flatMap((agent) => [agent.agentId, agent.agentName, agent.agentRole, agent.model]),
            ]),
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
        if (!window.aiUsage?.getTasks)
          throw new Error('Task history could not be loaded. Restart the app to reconnect.');
        return window.aiUsage.getTasks({ days, query: filter, page, pageSize: PAGE_SIZE });
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
              error: error instanceof Error ? error.message : 'Task history could not be loaded.',
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
    <section className="panel task-panel" aria-busy={loading} aria-labelledby="tasks-heading">
      <div className="panel-heading">
        <div>
          <h2 id="tasks-heading">Tasks &amp; sub-agents</h2>
          <p>
            Expand a task to compare its agents. Values cover the selected {days} days and use your API pricing
            settings.
          </p>
        </div>
        <span className="table-note">API-equivalent · not subscription charges</span>
      </div>
      <p className="task-guidance">
        Task IDs are used when recorded; otherwise usage is grouped by session. Unlinked usage stays separate. Activity
        spans measure first to last recorded usage, including idle time—not execution time.
      </p>
      {data?.rows.length ? (
        data.rows.map((task) => (
          <details className="task-card" key={`${selectionKey}:${task.key}`}>
            <summary>
              <span className="task-identity">
                <strong>{projectName(task.project)}</strong>
                <small>
                  {sourceLabel(task.sourceId)} · {task.taskId ? 'Task' : 'Session breakdown'}
                </small>
                <code title={task.taskId || task.sessionId}>{(task.taskId || task.sessionId).slice(0, 16)}</code>
              </span>
              <span>
                <strong>{task.subagentCount}</strong>
                <small>recorded {task.subagentCount === 1 ? 'sub-agent' : 'sub-agents'}</small>
              </span>
              <span>
                <strong>{compactNumber(task.totalTokens)}</strong>
                <small>total tokens</small>
              </span>
              <span className="task-total">
                <EquivalentValue cost={task.cost} coverage={task.coverage} currency={costs.currency} />
                <small>API-equivalent</small>
              </span>
            </summary>
            <div className="task-detail">
              <div className="task-split">
                <UsageSubtotal label="Main agent" usage={task.main} currency={costs.currency} />
                <UsageSubtotal label="Sub-agents" usage={task.subagent} currency={costs.currency} />
                {task.unknown.usageCount > 0 ? (
                  <UsageSubtotal label="Unattributed agent usage" usage={task.unknown} currency={costs.currency} />
                ) : null}
              </div>
              <p className="task-guidance">
                {formatInt(task.usageCount)} usage records · Activity span: {activitySpan(task.activitySpanMs)}
                {task.occurredAt ? ` · Last activity: ${shortDate(task.occurredAt)}` : ''}
                <br />
                Session: <code>{task.sessionId}</code>
              </p>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">Agent usage for {task.taskId || task.sessionId}</caption>
                  <thead>
                    <tr>
                      <th>Agent / model</th>
                      <th className="num">Uncached input</th>
                      <th className="num">Cache read</th>
                      <th className="num">Cache write</th>
                      <th className="num">Output</th>
                      <th className="num">Records</th>
                      <th className="num">API-equivalent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {task.agents.map((agent) => (
                      <tr key={agent.key}>
                        <td className="task-agent-name">
                          <strong>
                            {agent.agentKind === 'main'
                              ? 'Main agent'
                              : agent.agentKind === 'unknown'
                                ? 'Unattributed'
                                : agent.agentName || 'Sub-agent'}
                          </strong>
                          {agent.agentId ? <code title={agent.agentId}>{agent.agentId.slice(0, 16)}</code> : null}
                          <small>
                            {agent.model}
                            {agent.agentRole ? ` · ${agent.agentRole}` : ''}
                          </small>
                          <small>Activity span: {activitySpan(agent.activitySpanMs)}</small>
                          {agent.parentSessionId ? (
                            <small title={agent.parentSessionId}>Parent: {agent.parentSessionId.slice(0, 16)}</small>
                          ) : null}
                        </td>
                        <td className="num">{compactNumber(agent.inputTokens)}</td>
                        <td className="num">{compactNumber(agent.cachedInputTokens)}</td>
                        <td className="num">{compactNumber(agent.cacheWriteInputTokens)}</td>
                        <td className="num">
                          {compactNumber(agent.outputTokens)}
                          <small>{compactNumber(agent.reasoningOutputTokens)} reasoning included</small>
                        </td>
                        <td className="num">{formatInt(agent.usageCount)}</td>
                        <td className="num">
                          <EquivalentValue cost={agent.cost} coverage={agent.coverage} currency={costs.currency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="task-guidance">
                Each model used by an agent has its own row. Cache reads and writes are counted once; reasoning is
                included in output. Usage records are logged token updates, not a count of user messages.
              </p>
            </div>
          </details>
        ))
      ) : (
        <div className="empty-cell">
          {loading ? (
            <span role="status">Loading tasks…</span>
          ) : current?.error ? (
            <div className="session-error">
              <span role="alert">{current.error}</span>
              <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>
                Try again
              </button>
            </div>
          ) : filter ? (
            'No tasks match this filter.'
          ) : preview ? (
            'No example tasks are supplied.'
          ) : (
            'Tasks appear after local session records are collected.'
          )}
        </div>
      )}
      {pagination && pagination.total > 0 ? (
        <div className="session-pagination">
          <span role="status">
            {loading
              ? 'Loading tasks…'
              : `${formatInt(first)}–${formatInt(last)} of ${formatInt(pagination.total)} tasks / sessions`}
          </span>
          <div className="action-row compact" role="group" aria-label="Task pages">
            <button
              className="secondary-button"
              disabled={loading || pagination.page <= 1}
              onClick={() => {
                if (data) setSelection({ key: selectionKey, page: data.page - 1 });
              }}
            >
              Previous
            </button>
            <span>
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              className="secondary-button"
              disabled={loading || pagination.page >= pagination.totalPages}
              onClick={() => {
                if (data) setSelection({ key: selectionKey, page: data.page + 1 });
              }}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function activitySpan(milliseconds: number | null) {
  if (milliseconds == null) return 'Not enough records';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function UsageSubtotal({ label, usage, currency }: { label: string; usage: TaskUsageTotals; currency: string }) {
  return (
    <div>
      <small>{label}</small>
      {usage.usageCount > 0 ? (
        <EquivalentValue cost={usage.cost} coverage={usage.coverage} currency={currency} />
      ) : (
        <strong>No recorded usage</strong>
      )}
      <small>{compactNumber(usage.totalTokens)} tokens</small>
    </div>
  );
}
