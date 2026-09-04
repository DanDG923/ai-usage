import { compactNumber, money, percent, projectName, shortDate, sourceLabel } from '../../lib';
import type { CostAnalytics, ModelCost } from '../../types';

function ModelCategory({
  row,
  category,
  tokens,
  currency,
}: {
  row: ModelCost;
  category: keyof NonNullable<ModelCost['costBreakdown']>;
  tokens: number;
  currency: string;
}) {
  const value = row.costBreakdown?.[category];
  return (
    <>
      <strong>
        {row.coverage <= 0
          ? 'Unpriced'
          : value == null
            ? '—'
            : `${row.coverage < 1 ? '≥ ' : ''}${value > 0 && value < 0.01 ? '< ' + money(0.01, currency) : money(value, currency)}`}
      </strong>
      <small>{compactNumber(tokens)} tokens</small>
    </>
  );
}

export function EquivalentValue({ cost, coverage, currency }: { cost: number; coverage: number; currency: string }) {
  if (coverage <= 0)
    return (
      <span className="unpriced-cost">
        <strong>Unpriced</strong>
        <small>Excluded from lower bound</small>
      </span>
    );
  if (coverage < 1)
    return (
      <span className="unpriced-cost">
        <strong>≥ {money(cost, currency)}</strong>
        <small>Partly unpriced</small>
      </span>
    );
  return <strong>{money(cost, currency)}</strong>;
}

function matchesQuery(query: string | undefined, values: unknown[]) {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return true;
  return values.some((value) =>
    String(value ?? '')
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function ProjectTable({ costs, query }: { costs: CostAnalytics; query?: string }) {
  const rows = costs.byProject.filter((row) => matchesQuery(query, [row.project, ...row.sources]));
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>By project</h2>
          <p>Grouped by the working directory each session ran in. Only the folder path is recorded, never prompts.</p>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Sources</th>
              <th className="num">Sessions</th>
              <th>Last activity</th>
              <th className="num">Tokens</th>
              <th className="num">Coverage</th>
              <th className="num">API-equivalent</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.project ?? 'none'}>
                  <td>
                    <strong>{projectName(row.project)}</strong>
                    {row.project && (
                      <small className="path" title={row.project}>
                        {row.project}
                      </small>
                    )}
                  </td>
                  <td>{row.sources.map(sourceLabel).join(', ')}</td>
                  <td className="num">{row.sessionCount}</td>
                  <td>{shortDate(row.lastActivity)}</td>
                  <td className="num">{compactNumber(row.totalTokens)}</td>
                  <td className="num">{percent(row.coverage * 100)}</td>
                  <td className="num">
                    <EquivalentValue cost={row.cost} coverage={row.coverage} currency={costs.currency} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  Projects appear once local session records carry a working directory.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ModelTable({ costs, query }: { costs: CostAnalytics; query?: string }) {
  const rows = costs.byModel.filter((row) => matchesQuery(query, [row.sourceId, row.model]));
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Cost by model</h2>
          <p>Last {costs.periodDays} days · cost and token count for each category. Reasoning is included in output.</p>
        </div>
        <span className="table-note">Prices are editable under Settings</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Uncached input</th>
              <th className="num">Cache read</th>
              <th className="num">Write 5m</th>
              <th className="num">Write 1h</th>
              <th className="num">Output</th>
              <th className="num">Coverage</th>
              <th className="num">Share of priced cost</th>
              <th className="num">API-equivalent</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={`${row.sourceId}-${row.model}`}>
                  <td>
                    <span className={`table-provider ${row.sourceId}`}>{sourceLabel(row.sourceId)}</span>
                    <strong>{row.model}</strong>
                  </td>
                  <td className="num">
                    <ModelCategory
                      row={row}
                      category="input"
                      tokens={
                        row.sourceId === 'codex'
                          ? Math.max(0, row.inputTokens - row.cachedInputTokens)
                          : row.inputTokens
                      }
                      currency={costs.currency}
                    />
                  </td>
                  <td className="num">
                    <ModelCategory
                      row={row}
                      category="cacheRead"
                      tokens={row.cachedInputTokens}
                      currency={costs.currency}
                    />
                  </td>
                  <td className="num">
                    <ModelCategory
                      row={row}
                      category="cacheWrite5m"
                      tokens={
                        row.cacheWrite5mInputTokens ||
                        (row.cacheWrite1hInputTokens === 0 ? row.cacheWriteInputTokens : 0)
                      }
                      currency={costs.currency}
                    />
                  </td>
                  <td className="num">
                    <ModelCategory
                      row={row}
                      category="cacheWrite1h"
                      tokens={row.cacheWrite1hInputTokens}
                      currency={costs.currency}
                    />
                  </td>
                  <td className="num">
                    <ModelCategory row={row} category="output" tokens={row.outputTokens} currency={costs.currency} />
                    <small>{compactNumber(row.reasoningOutputTokens)} reasoning</small>
                  </td>
                  <td className="num">{percent(row.coverage * 100)}</td>
                  <td className="num">{row.costShare == null ? '—' : percent(row.costShare * 100)}</td>
                  <td className="num">
                    <EquivalentValue cost={row.cost} coverage={row.coverage} currency={costs.currency} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {query?.trim() ? 'No models match this filter.' : 'No token records in this period yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SessionTable({ costs, query }: { costs: CostAnalytics; query?: string }) {
  const rows = costs.sessions.filter((row) =>
    matchesQuery(query, [row.sourceId, row.project, row.sessionId, row.model]),
  );
  return (
    <section className="panel table-panel session-panel">
      <div className="panel-heading">
        <div>
          <h2>Largest sessions</h2>
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
            {rows.length ? (
              rows.map((row) => (
                <tr key={`${row.sourceId}-${row.sessionId}-${row.model}`}>
                  <td>
                    <span className={`source-dot ${row.sourceId}`} />
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
                  Sessions will appear after local logs are imported.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
