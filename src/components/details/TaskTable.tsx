import { compactNumber, formatInt, projectName, shortDate, sourceLabel } from '../../lib';
import type { SessionPageOptions, Snapshot, TaskCost, TaskUsageTotals } from '../../types';
import { Pagination, usePagedQuery } from './paging';
import { EquivalentValue, matchesQuery } from './Tables';

const EMPTY_TASKS: TaskCost[] = [];

// Module-level so the query hook can hold them as stable dependencies.
const matchesTask = (row: TaskCost, filter: string) =>
  matchesQuery(filter, [
    row.sourceId,
    sourceLabel(row.sourceId),
    row.project,
    row.sessionId,
    row.taskId,
    ...row.agents.flatMap((agent) => [agent.agentId, agent.agentName, agent.agentRole, agent.model]),
  ]);
const fetchTasks = (options: SessionPageOptions) => window.aiUsage?.getTasks?.(options);

export function TaskTable({ snapshot, query }: { snapshot: Snapshot; query: string }) {
  const { costs } = snapshot;
  const state = usePagedQuery({
    snapshot,
    query,
    examples: costs.tasks ?? EMPTY_TASKS,
    matches: matchesTask,
    fetch: fetchTasks,
    unavailable: 'Task history could not be loaded. Restart the app to reconnect.',
    failed: 'Task history could not be loaded.',
  });
  const { days, filter, preview, selectionKey, data, loading, error } = state;
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
          ) : error ? (
            <div className="session-error">
              <span role="alert">{error}</span>
              <button className="secondary-button" onClick={state.retry}>
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
      <Pagination state={state} groupLabel="Task pages" loadingLabel="Loading tasks…" unit="tasks / sessions" />
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
