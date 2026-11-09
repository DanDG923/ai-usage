import { cycleEndedEarly } from '../../cycle-match';
import { compactNumber, dayDate, money, percent } from '../../lib';
import type { CycleRow, Snapshot } from '../../types';

type CycleKey = keyof Snapshot['cycles'];
const LABELS: Record<CycleKey, string> = { codex: 'Codex', claude: 'Claude', fable: 'Fable' };

/** "Mon 14 Sept: 74% used", with the open window named, for the tooltip and the text alternative. */
function cycleLabel(row: CycleRow) {
  return `${dayDate(row.endsAt ?? row.resetsAt)}: ${percent(row.peakUsedPercent)} used${row.current ? ' (current)' : ''}`;
}

/** "14 Sept": the bar's date without its weekday, so each label fits under its bar. */
function barDate(row: CycleRow) {
  return dayDate(row.endsAt ?? row.resetsAt).replace(/^\S+\s/, '');
}

/**
 * Peak use per window in the provider's colour, oldest first: past windows are
 * tinted, the open one is solid. The top rule marks the full allowance and the
 * bars are clamped to it; each bar carries its figure and its end date.
 */
function CycleBars({ rows, provider }: { rows: CycleRow[]; provider: CycleKey }) {
  // Copy first; toReversed needs the ES2023 lib the renderer does not target.
  // oxlint-disable-next-line unicorn/no-array-reverse
  const ordered = [...rows].reverse();
  const description = `${LABELS[provider]} peak allowance used per reset cycle, oldest first: ${ordered.map(cycleLabel).join('; ')}.`;
  return (
    <div className={`cycle-bars ${provider}`} role="img" aria-label={description}>
      <span className="cycle-limit" aria-hidden="true">
        <span>100%</span>
      </span>
      <span className="cycle-zero" aria-hidden="true">
        0%
      </span>
      {ordered.map((row) => {
        const height = Math.max(3, Math.min(100, row.peakUsedPercent));
        return (
          <div
            key={row.resetsAt}
            className={`cycle-bar${row.current ? ' current' : ''}`}
            title={cycleLabel(row)}
            aria-label={cycleLabel(row)}
          >
            <i style={{ height: `${height}%` }}>
              <b className={height >= 85 ? 'inside' : undefined}>{percent(row.peakUsedPercent)}</b>
            </i>
            <small>{barDate(row)}</small>
          </div>
        );
      })}
    </div>
  );
}

export function CycleHistory({ cycles, currency }: { cycles: Snapshot['cycles']; currency: string }) {
  const keys = (Object.keys(LABELS) as CycleKey[]).filter((key) => cycles[key]?.length);
  return (
    <section className="log-cycles" aria-labelledby="cycles-heading">
      <div className="log-cycles-heading">
        <h2 id="cycles-heading">Reset cycles</h2>
        <p>
          Each past window of the primary bucket: the peak percentage the provider reported and what that window's
          tokens are worth at the current catalogue. The open window is marked as current.
        </p>
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
              <CycleBars rows={cycles[key]} provider={key} />
              <div className="table-scroll">
                <table className="cycle-table">
                  <caption className="sr-only">{LABELS[key]} reset windows, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Window ends</th>
                      <th scope="col" className="num">
                        Peak used
                      </th>
                      <th scope="col" className="num">
                        Readings
                      </th>
                      <th scope="col" className="num">
                        Tokens
                      </th>
                      <th scope="col" className="num">
                        API-equivalent
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycles[key].map((row) => (
                      <tr key={row.resetsAt} className={row.current ? 'current' : ''}>
                        <td>
                          <span className="cycle-when">
                            {dayDate(row.endsAt ?? row.resetsAt)}
                            {row.current ? <span className="chip">Current</span> : null}
                          </span>
                          {cycleEndedEarly(row) ? <small>Reset early</small> : null}
                        </td>
                        <td className="num cycle-peak">{percent(row.peakUsedPercent)}</td>
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
