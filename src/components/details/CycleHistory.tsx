import { compactNumber, dayDate, money, percent } from '../../lib';
import type { CycleRow, Snapshot } from '../../types';

type CycleKey = keyof Snapshot['cycles'];
const LABELS: Record<CycleKey, string> = { codex: 'Codex', claude: 'Claude', fable: 'Fable 5' };

function CycleBars({ rows }: { rows: CycleRow[] }) {
  // Copy first; toReversed needs the ES2023 lib the renderer does not target.
  // oxlint-disable-next-line unicorn/no-array-reverse
  const ordered = [...rows].reverse();
  return (
    <div className="cycle-bars" role="img" aria-label="Peak allowance used per reset cycle">
      {ordered.map((row) => (
        <div
          key={row.resetsAt}
          className={`cycle-bar${row.current ? ' current' : ''}`}
          title={`${dayDate(row.endsAt ?? row.resetsAt)}: ${percent(row.peakUsedPercent)} used`}
        >
          <i style={{ height: `${Math.max(3, Math.min(100, row.peakUsedPercent))}%` }} />
        </div>
      ))}
    </div>
  );
}

export function CycleHistory({ cycles, currency }: { cycles: Snapshot['cycles']; currency: string }) {
  const keys = (Object.keys(LABELS) as CycleKey[]).filter((key) => cycles[key]?.length);
  return (
    <section className="panel table-panel cycle-panel">
      <div className="panel-heading">
        <div>
          <h2>Reset cycles</h2>
          <p>
            Each past window of the primary bucket: the peak percentage the provider reported and what that window's
            tokens are worth at the current catalogue. The open window is marked as current.
          </p>
        </div>
      </div>
      {keys.length === 0 ? (
        <div className="empty-chart">Reset history appears once a window has been observed through to its reset.</div>
      ) : (
        <div className="cycle-grid">
          {keys.map((key) => (
            <article key={key} className="cycle-card">
              <header>
                <strong>
                  <span className={`swatch ${key}`} aria-hidden="true" />
                  {LABELS[key]}
                </strong>
                <span>
                  {cycles[key].length} window{cycles[key].length === 1 ? '' : 's'}
                </span>
              </header>
              <CycleBars rows={cycles[key]} />
              <div className="table-scroll">
                <table className="cycle-table">
                  <thead>
                    <tr>
                      <th>Window ends</th>
                      <th className="num">Peak used</th>
                      <th className="num">Readings</th>
                      <th className="num">Tokens</th>
                      <th className="num">API-equivalent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycles[key].map((row) => (
                      <tr key={row.resetsAt} className={row.current ? 'current' : ''}>
                        <td>
                          {dayDate(row.endsAt ?? row.resetsAt)}
                          {row.endsAt && row.endsAt !== row.resetsAt ? <small>Reset early</small> : null}
                          {row.current ? <small> current</small> : null}
                        </td>
                        <td className="num">{percent(row.peakUsedPercent)}</td>
                        <td className="num">{row.readings}</td>
                        <td className="num">{compactNumber(row.tokens)}</td>
                        <td className="num">{money(row.cost, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
