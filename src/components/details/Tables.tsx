import { memo } from 'react';
import { compactNumber, money, percent, priceCoverage, projectName, shortDate, sourceLabel } from '../../lib';
import type { CostAnalytics, ModelCost } from '../../types';

function ModelCategory({
  row,
  category,
  tokens,
  currency,
  note,
}: {
  row: ModelCost;
  category: keyof NonNullable<ModelCost['costBreakdown']>;
  tokens: number;
  currency: string;
  note?: string;
}) {
  const value = row.costBreakdown?.[category];
  return (
    <>
      <span className={row.coverage <= 0 ? 'costs-figure unpriced' : 'costs-figure'}>
        {row.coverage <= 0
          ? 'Unpriced'
          : value == null
            ? '—'
            : `${row.coverage < 1 ? '≥ ' : ''}${value > 0 && value < 0.01 ? '< ' + money(0.01, currency) : money(value, currency)}`}
      </span>
      <small>{note ? `${compactNumber(tokens)} tokens · ${note}` : `${compactNumber(tokens)} tokens`}</small>
    </>
  );
}

/**
 * An API-equivalent sum. Unpriced shows the word, never a guess; a partly
 * priced sum is a floor ("≥ ") and says so beneath.
 */
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
      <span className="partly-priced">
        <strong>{`≥ ${money(cost, currency)}`}</strong>
        <small>Partly unpriced</small>
      </span>
    );
  return <strong>{money(cost, currency)}</strong>;
}

/** A provider's swatch and name: the colour marks identity, the word carries it. */
export function SourceMark({ sourceId }: { sourceId: string }) {
  return (
    <span className="costs-source">
      <span className={`swatch ${sourceId}`} aria-hidden="true" />
      {sourceLabel(sourceId)}
    </span>
  );
}

export function matchesQuery(query: string | undefined, values: unknown[]) {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return true;
  return values.some((value) =>
    String(value ?? '')
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export const ProjectTable = memo(function ProjectTable({ costs, query }: { costs: CostAnalytics; query?: string }) {
  const rows = costs.byProject.filter((row) => matchesQuery(query, [row.project, ...row.sources]));
  return (
    <section className="panel costs-panel project-panel" aria-labelledby="projects-heading">
      <div className="costs-head">
        <div>
          <h3 id="projects-heading" className="pnl-title">
            By project
          </h3>
          <p>Grouped by the working directory each session ran in. Only the folder path is recorded, never prompts.</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="costs-table project-table">
          <caption className="sr-only">API-equivalent cost by project</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Sources</th>
              <th scope="col" className="num">
                Sessions
              </th>
              <th scope="col">Last activity</th>
              <th scope="col" className="num">
                Tokens
              </th>
              <th scope="col" className="num">
                Coverage
              </th>
              <th scope="col" className="num">
                API-equivalent
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.project ?? 'none'}>
                  <td className="costs-name">
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
                  <td className="num">{priceCoverage(row.coverage)}</td>
                  <td className="num">
                    <EquivalentValue cost={row.cost} coverage={row.coverage} currency={costs.currency} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {query?.trim()
                    ? 'No projects match this filter.'
                    : 'Projects appear once local session records carry a working directory.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
});

export const ModelTable = memo(function ModelTable({ costs, query }: { costs: CostAnalytics; query?: string }) {
  const rows = costs.byModel.filter((row) => matchesQuery(query, [row.sourceId, row.model]));
  return (
    <section className="panel costs-panel model-panel" aria-labelledby="models-heading">
      <div className="costs-head">
        <div>
          <h3 id="models-heading" className="pnl-title">
            Cost by model
          </h3>
          <p>Last {costs.periodDays} days · cost and token count for each category. Reasoning is included in output.</p>
        </div>
        <span className="costs-note">Prices are editable under Settings</span>
      </div>
      <div className="table-scroll">
        <table className="costs-table model-table">
          <caption className="sr-only">API-equivalent cost and tokens by model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="num">
                Uncached input
              </th>
              <th scope="col" className="num">
                Cache read
              </th>
              <th scope="col" className="num">
                Write 5m
              </th>
              <th scope="col" className="num">
                Write 1h
              </th>
              <th scope="col" className="num">
                Output
              </th>
              <th scope="col" className="num">
                Coverage
              </th>
              <th scope="col">Share of priced cost</th>
              <th scope="col" className="num">
                API-equivalent
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={`${row.sourceId}-${row.model}`} className={row.coverage <= 0 ? 'unpriced-row' : undefined}>
                  <td className="costs-name">
                    <SourceMark sourceId={row.sourceId} />
                    <span className="costs-model">{row.model}</span>
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
                      tokens={row.cacheWrite5mInputTokens}
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
                    <ModelCategory
                      row={row}
                      category="output"
                      tokens={row.outputTokens}
                      currency={costs.currency}
                      note={`${compactNumber(row.reasoningOutputTokens)} reasoning`}
                    />
                  </td>
                  <td className="num">{priceCoverage(row.coverage)}</td>
                  <td>
                    <span className="share">
                      <span className="share-bar" aria-hidden="true">
                        <i
                          style={
                            {
                              '--fill': `${row.costShare == null ? 0 : Math.min(100, row.costShare * 100)}%`,
                            } as React.CSSProperties
                          }
                        />
                      </span>
                      {row.costShare == null ? '—' : percent(row.costShare * 100)}
                    </span>
                  </td>
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
});
