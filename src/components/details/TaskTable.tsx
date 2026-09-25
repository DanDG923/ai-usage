import { ChevronRight } from 'lucide-react';
import { compactNumber, formatInt, money, projectName, shortDate, sourceLabel } from '../../lib';
import type { SessionPageOptions, Snapshot, TaskCost, TaskUsageTotals } from '../../types';
import { Disclosure } from './Disclosure';
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
      <div className="costs-head">
        <div>
          <h3 id="tasks-heading" className="pnl-title">
            Tasks &amp; sub-agents
          </h3>
          <p>
            Expand a task to compare its agents. Values cover the selected {days} days and use your API pricing
            settings.
          </p>
        </div>
        <span className="badge">API-equivalent · not subscription charges</span>
      </div>
      <Disclosure summary="How tasks are grouped" className="task-grouping">
        <p>
          Task IDs are used when recorded; otherwise usage is grouped by session. Unlinked usage stays separate.
          Activity spans measure first to last recorded usage, including idle time—not execution time.
        </p>
      </Disclosure>
      {data?.rows.length ? (
        <div className="task-list">
          {/* Column labels for sighted readers; each summary names its own figures. */}
          <div className="task-columns" aria-hidden="true">
            <span />
            <span>Task</span>
            <span>Agents</span>
            <span>Tokens</span>
            <span>API-equivalent</span>
          </div>
          {data.rows.map((task) => (
            <details className="task-card" key={`${selectionKey}:${task.key}`}>
              <summary>
                <span className="task-toggle" aria-hidden="true">
                  <ChevronRight />
                </span>
                <span className="task-identity">
                  <strong>
                    <span className={`swatch ${task.sourceId}`} aria-hidden="true" />
                    {projectName(task.project)}
                  </strong>
                  <small>
                    {sourceLabel(task.sourceId)} · {task.taskId ? 'Task' : 'Session breakdown'} ·{' '}
                    <code title={task.taskId || task.sessionId}>{(task.taskId || task.sessionId).slice(0, 16)}</code>
                  </small>
                </span>
                <span className="task-agents">
                  {`${task.subagentCount} recorded ${task.subagentCount === 1 ? 'sub-agent' : 'sub-agents'}`}
                </span>
                <span className="task-tokens">{`${compactNumber(task.totalTokens)} total tokens`}</span>
                <span className="task-total">
                  <EquivalentValue cost={task.cost} coverage={task.coverage} currency={costs.currency} />
                  <span className="sr-only">API-equivalent</span>
                </span>
              </summary>
              <div className="task-detail">
                <div className="task-split">
                  <UsageSubtotal kind="main" label="Main agent" usage={task.main} currency={costs.currency} />
                  <UsageSubtotal kind="subagent" label="Sub-agents" usage={task.subagent} currency={costs.currency} />
                  {task.unknown.usageCount > 0 ? (
                    <UsageSubtotal
                      kind="unknown"
                      label="Unattributed agent usage"
                      usage={task.unknown}
                      currency={costs.currency}
                    />
                  ) : null}
                  <SplitBar task={task} currency={costs.currency} />
                </div>
                <p className="task-guidance">
                  {formatInt(task.usageCount)} usage records · Activity span: {activitySpan(task.activitySpanMs)}
                  {task.occurredAt ? ` · Last activity: ${shortDate(task.occurredAt)}` : ''} · Session:{' '}
                  <code>{task.sessionId}</code>
                </p>
                <div className="table-scroll">
                  <table className="costs-table agent-table">
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
                            <small>
                              {agent.agentId ? (
                                <>
                                  <code title={agent.agentId}>{agent.agentId.slice(0, 16)}</code>
                                  {' · '}
                                </>
                              ) : null}
                              {agent.model}
                              {agent.agentRole ? ` · ${agent.agentRole}` : ''}
                              {agent.parentSessionId ? (
                                <>
                                  {' · '}
                                  <span title={agent.parentSessionId}>
                                    Parent: {agent.parentSessionId.slice(0, 16)}
                                  </span>
                                </>
                              ) : null}
                            </small>
                            <small>Activity span: {activitySpan(agent.activitySpanMs)}</small>
                          </td>
                          <td className="num">{compactNumber(agent.inputTokens)}</td>
                          <td className="num">{compactNumber(agent.cachedInputTokens)}</td>
                          <td className="num">{compactNumber(agent.cacheWriteInputTokens)}</td>
                          <td className="num">
                            {compactNumber(agent.outputTokens)}
                            <small>{`${compactNumber(agent.reasoningOutputTokens)} reasoning included`}</small>
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
          ))}
        </div>
      ) : (
        <div className="empty-cell">
          {loading ? (
            <span role="status">Loading tasks…</span>
          ) : error ? (
            <div className="session-error">
              <span role="alert">{error}</span>
              <button type="button" className="btn" onClick={state.retry}>
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
      {data && error && (
        <div className="session-error">
          <span role="alert">{error} Showing the previous results.</span>
          <button type="button" className="btn" onClick={state.retry}>
            Try again
          </button>
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

type SplitKind = 'main' | 'subagent' | 'unknown';

function UsageSubtotal({
  kind,
  label,
  usage,
  currency,
}: {
  kind: SplitKind;
  label: string;
  usage: TaskUsageTotals;
  currency: string;
}) {
  return (
    <div className="task-subtotal">
      <span className="lbl">
        <i className={`task-key ${kind}`} aria-hidden="true" />
        {label}
      </span>
      <span className="task-subtotal-figure">
        {usage.usageCount > 0 ? (
          <EquivalentValue cost={usage.cost} coverage={usage.coverage} currency={currency} />
        ) : (
          <strong>No recorded usage</strong>
        )}
        <small>{`${compactNumber(usage.totalTokens)} tokens`}</small>
      </span>
    </div>
  );
}

/**
 * How the task's priced value divides between the main agent, its
 * sub-agents and any unattributed usage. Monochrome: these are roles, not
 * providers or states. Drawn only when some of the value is priced.
 */
function SplitBar({ task, currency }: { task: TaskCost; currency: string }) {
  const parts = (
    [
      ['main', 'main agent', task.main],
      ['subagent', 'sub-agents', task.subagent],
      ['unknown', 'unattributed usage', task.unknown],
    ] as const
  ).filter(([, , usage]) => usage.usageCount > 0 && usage.coverage > 0 && usage.cost > 0);
  if (!parts.length) return <span className="task-split-bar" aria-hidden="true" />;
  const label = parts
    .map(([, name, usage]) => `${name} ${usage.coverage < 1 ? 'at least ' : ''}${money(usage.cost, currency)}`)
    .join(', ');
  return (
    <span className="task-split-bar" role="img" aria-label={`Split of this task’s API-equivalent value: ${label}.`}>
      {parts.map(([kind, , usage]) => (
        <i key={kind} className={`task-key ${kind}`} style={{ flexGrow: usage.cost }} />
      ))}
    </span>
  );
}
