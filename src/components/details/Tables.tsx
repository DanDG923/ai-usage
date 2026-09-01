import { FolderKanban } from 'lucide-react';
import { compactNumber, money, percent, projectName, shortDate, sourceLabel } from '../../lib';
import type { CostAnalytics } from '../../types';

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

export function ProjectTable({ costs }: { costs: CostAnalytics }) {
  const rows = costs.byProject;
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">By project</span>
          <h2>Where the work happened</h2>
          <p>
            Grouped by the working directory each session ran in. Only the folder path is recorded, never the prompts.
          </p>
        </div>
        <FolderKanban aria-hidden="true" />
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Sources</th>
              <th>Sessions</th>
              <th>Last activity</th>
              <th>Tokens</th>
              <th>Coverage</th>
              <th>API-equivalent</th>
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
                  <td>{row.sessionCount}</td>
                  <td>{shortDate(row.lastActivity)}</td>
                  <td>{compactNumber(row.totalTokens)}</td>
                  <td>{percent(row.coverage * 100)}</td>
                  <td>
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

export function ModelTable({ costs }: { costs: CostAnalytics }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Cost drivers</span>
          <h2>Provider and model detail</h2>
        </div>
        <span className="table-note">Prices are editable in Data &amp; settings</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Provider / model</th>
              <th>Input</th>
              <th>Cache read</th>
              <th>Write 5m</th>
              <th>Write 1h</th>
              <th>Output (reasoning subset)</th>
              <th>Coverage</th>
              <th>API-equivalent</th>
            </tr>
          </thead>
          <tbody>
            {costs.byModel.length ? (
              costs.byModel.map((row) => (
                <tr key={`${row.sourceId}-${row.model}`}>
                  <td>
                    <span className={`table-provider ${row.sourceId}`}>{sourceLabel(row.sourceId)}</span>
                    <strong>{row.model}</strong>
                  </td>
                  <td>{compactNumber(row.inputTokens)}</td>
                  <td className="mint">{compactNumber(row.cachedInputTokens)}</td>
                  <td>{compactNumber(row.cacheWrite5mInputTokens)}</td>
                  <td>{compactNumber(row.cacheWrite1hInputTokens)}</td>
                  <td>
                    {compactNumber(row.outputTokens)}{' '}
                    <small>({compactNumber(row.reasoningOutputTokens)} reasoning)</small>
                  </td>
                  <td>{percent(row.coverage * 100)}</td>
                  <td>
                    <EquivalentValue cost={row.cost} coverage={row.coverage} currency={costs.currency} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="empty-cell">
                  No token records in this period yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SessionTable({ costs }: { costs: CostAnalytics }) {
  return (
    <section className="panel table-panel session-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Largest sessions</span>
          <h2>Where the token value came from</h2>
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
              <th>Tokens</th>
              <th>API-equivalent</th>
            </tr>
          </thead>
          <tbody>
            {costs.sessions.length ? (
              costs.sessions.map((row) => (
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
                  <td>{compactNumber(row.totalTokens)}</td>
                  <td>
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
