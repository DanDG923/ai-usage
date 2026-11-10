import { SOURCES, subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { selectDisplayedWindows } from '../../electron/quota-selection.mjs';
import { Ban, CircleDashed, Info } from 'lucide-react';
import { niceScale } from '../chart-scale';
import { compactNumber, percent, quotaWindows, shortDate } from '../lib';
import { snapshotNowMs } from '../snapshot-time';
import type { QuotaWindow, Snapshot, TokenCapacityEstimate } from '../types';

const PROVIDERS = SOURCES.map(({ id, label }) => ({ id, name: label }));

/** Token categories in display order, each with its mark in the mix bar (ink first, then greys). */
const TOKEN_CATEGORIES = [
  ['input', 'Uncached input'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['output', 'Output'],
] as const;

function capacityWindows(providerId: (typeof PROVIDERS)[number]['id'], snapshot: Snapshot) {
  // Display order is the shared rule, not the order the windows arrived in.
  const selection = selectDisplayedWindows(
    quotaWindows(snapshot.quotas[providerId]).filter((window) => window.windowMinutes === 10_080),
  );
  const weekly = [...selection.active, ...selection.expired];
  if (providerId !== 'codex') {
    // Claude also reports weekly pools with no token scope (OAuth apps). Such
    // a window would only ever show "Unavailable" beside a real estimate, so
    // keep it only when it is the sole weekly window and its reason matters.
    const supported = weekly.filter((window) => window.tokenCapacity?.status !== 'unavailable');
    return supported.length ? supported : weekly;
  }

  // Codex can also report separate model-specific limits under the same
  // "Weekly" label. Only the account-wide limit has a matching token scope.
  // Primary/secondary are provider slot names; the shared display order
  // already puts the live slot ahead of an expired one, so the first
  // account-limit window is the one the card headlines.
  return weekly
    .filter(
      (window) =>
        ['codex:weekly', 'codex:primary', 'codex:secondary'].includes(window.bucketId) &&
        (window.metadata?.limitId == null || window.metadata.limitId === 'codex'),
    )
    .slice(0, 1);
}

function estimateRange(range: { low: number; high: number } | null) {
  return range
    ? `Estimate range ${compactNumber(range.low)}–${compactNumber(range.high)} tokens`
    : 'Estimate range not yet available';
}

/**
 * The estimate on a token scale: a dot at the estimate and a whisker across
 * its range, for the full week and, while the reading is current, for what
 * remained at that reading. The words below it carry the same figures.
 */
function CapacityRange({
  name,
  estimate,
  remaining,
}: {
  name: string;
  estimate: TokenCapacityEstimate;
  remaining: boolean;
}) {
  const rows = [
    { label: 'Est. full week', value: estimate.weeklyTokens!, range: estimate.weeklyRange },
    ...(remaining
      ? [{ label: 'Est. remaining', value: estimate.remainingTokens!, range: estimate.remainingRange }]
      : []),
  ];
  const axis = niceScale(Math.max(...rows.map((row) => Math.max(row.value, row.range?.high ?? 0))), 5);
  const x = (value: number) => 118 + (Math.max(0, Math.min(axis.max, value)) / axis.max) * 312;
  const describe = (row: (typeof rows)[number]) =>
    `${row.label === 'Est. full week' ? 'full week' : 'remaining at reading'} about ${compactNumber(row.value)} tokens${
      row.range ? `, range ${compactNumber(row.range.low)} to ${compactNumber(row.range.high)}` : ''
    }`;
  return (
    <svg
      className="token-capacity-range"
      viewBox={`0 0 440 ${rows.length > 1 ? 92 : 60}`}
      role="img"
      aria-label={`${name} estimate: ${rows.map(describe).join('; ')}.`}
    >
      {axis.ticks.map((tick) => (
        <g key={tick} className="capacity-tick">
          <line x1={x(tick)} x2={x(tick)} y1="8" y2={rows.length > 1 ? 70 : 38} />
          <text x={x(tick)} y={rows.length > 1 ? 86 : 54} textAnchor="middle">
            {tick === 0 ? '0' : compactNumber(tick)}
          </text>
        </g>
      ))}
      {rows.map((row, index) => {
        const y = 26 + index * 32;
        return (
          <g key={row.label} className="capacity-row">
            <text className="capacity-label" x="0" y={y + 4}>
              {row.label}
            </text>
            {row.range && (
              <line className="capacity-whisker" x1={x(row.range.low)} x2={x(row.range.high)} y1={y} y2={y} />
            )}
            <circle className="capacity-dot" cx={x(row.value)} cy={y} r="5" />
            <text className="capacity-value" x={x(row.value)} y={y - 10} textAnchor="middle">
              {`≈ ${compactNumber(row.value)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function CalibrationDetail({ estimate, open }: { estimate: TokenCapacityEstimate; open: boolean }) {
  const hasMix = Object.values(estimate.tokenMix).some((share) => share > 0);
  return (
    <details className="token-capacity-details" open={open || undefined}>
      <summary>Evidence and usage mix</summary>
      <div className="token-capacity-details-body">
        <div className="token-capacity-evidence">
          <p>
            {estimate.intervals} matched {estimate.intervals === 1 ? 'interval' : 'intervals'} across {estimate.cycles}{' '}
            {estimate.cycles === 1 ? 'cycle' : 'cycles'} · {estimate.observedPercent.toFixed(1)} percentage points of
            allowance change matched.
            {estimate.calibratedAt ? ` Last calibrated ${shortDate(estimate.calibratedAt)}.` : ''}
          </p>
          {estimate.modelMix.length > 0 && (
            <div>
              <h4 className="lbl">Recent model mix</h4>
              <ul className="token-capacity-mix" aria-label="Recent model mix by recorded tokens">
                {estimate.modelMix.map(({ model, share }) => (
                  <li key={model}>
                    <span>{model}</span>
                    <i className="lead" aria-hidden="true" />
                    <strong>{percent(share * 100)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {estimate.warnings.length > 0 && (
            <ul className="token-capacity-warnings">
              {estimate.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>
                  <Info aria-hidden="true" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {hasMix && (
          <div className="token-capacity-tokens">
            <h4 className="lbl">Recorded token mix</h4>
            <div
              className="token-mix-bar"
              role="img"
              aria-label={`Recorded token mix: ${TOKEN_CATEGORIES.map(([key, label]) => `${label.toLowerCase()} ${percent(estimate.tokenMix[key] * 100)}`).join(', ')}.`}
            >
              {TOKEN_CATEGORIES.map(([key]) =>
                estimate.tokenMix[key] > 0 ? (
                  <i key={key} className={`mix-${key}`} style={{ flexGrow: estimate.tokenMix[key] }} />
                ) : null,
              )}
            </div>
            <dl className="token-capacity-mix">
              {TOKEN_CATEGORIES.map(([key, label]) => (
                <div key={key}>
                  <dt>
                    <i className={`mix-${key}`} aria-hidden="true" />
                    {label}
                  </dt>
                  <i className="lead" aria-hidden="true" />
                  <dd>{percent(estimate.tokenMix[key] * 100)}</dd>
                </div>
              ))}
            </dl>
            <p>Cache categories are counted once. Output includes any recorded reasoning tokens.</p>
          </div>
        )}
      </div>
    </details>
  );
}

function CapacityCard({
  provider,
  window,
  timezone,
  nowMs,
  single,
}: {
  provider: (typeof PROVIDERS)[number];
  window: QuotaWindow | null;
  timezone: string;
  nowMs: number;
  /** On a provider's own page the evidence sits beside the estimate, open. */
  single: boolean;
}) {
  const estimate = window?.tokenCapacity;
  const available = estimate?.status === 'available' && estimate.weeklyTokens != null;
  const expired = Boolean(window?.forecast.expired) || (window != null && Date.parse(window.resetsAt) <= nowMs);
  const remaining = available && !expired && estimate.remainingTokens != null && estimate.remainingAsOf;
  const state = available ? 'available' : estimate?.status === 'unavailable' || !window ? 'unavailable' : 'learning';
  const status = available
    ? `${estimate.confidence.charAt(0).toUpperCase()}${estimate.confidence.slice(1)} confidence`
    : state === 'unavailable'
      ? 'Unavailable'
      : 'Learning';
  const reason =
    estimate?.reason ||
    (!window
      ? 'A weekly allowance reading is needed before token capacity can be estimated.'
      : 'Collecting enough matching allowance readings and local token usage to estimate this window.');

  return (
    <article className={`token-capacity-card ${provider.id}`} data-state={state}>
      <div className="token-capacity-main">
        <header>
          <span className={`swatch ${provider.id}`} aria-hidden="true" />
          <div>
            <h3>{provider.name}</h3>
            <p>{window?.bucketName || 'Weekly allowance'}</p>
          </div>
          <span className="token-capacity-confidence badge">
            {state === 'learning' && <CircleDashed aria-hidden="true" />}
            {state === 'unavailable' && <Ban aria-hidden="true" />}
            {status}
          </span>
        </header>
        {available ? (
          <>
            <CapacityRange name={provider.name} estimate={estimate} remaining={Boolean(remaining)} />
            <dl className="token-capacity-values">
              <div>
                <dt>Est. full week</dt>
                <dd className="token-capacity-figure">{`≈ ${compactNumber(estimate.weeklyTokens!)} tokens`}</dd>
                <dd>{estimateRange(estimate.weeklyRange)}</dd>
                {estimate.calibratedAt && (
                  <dd className="token-capacity-calibrated">Calibrated {shortDate(estimate.calibratedAt)}</dd>
                )}
              </div>
              <div>
                <dt>Est. remaining at reading</dt>
                {remaining ? (
                  <>
                    <dd className="token-capacity-figure">{`≈ ${compactNumber(estimate.remainingTokens!)} tokens`}</dd>
                    <dd>{estimateRange(estimate.remainingRange)}</dd>
                  </>
                ) : (
                  <dd className="token-capacity-pending">Needs current reading</dd>
                )}
              </div>
            </dl>
            <p className="token-capacity-asof">
              {remaining
                ? `Allowance reading ${shortDate(estimate.remainingAsOf)} · ${timezone}. This is not a live token balance.`
                : 'A fresh official weekly allowance reading is needed to estimate the remaining tokens.'}
            </p>
            {estimate.reason && <p className="token-capacity-reason">{estimate.reason}</p>}
          </>
        ) : (
          <p className="token-capacity-reason">{reason}</p>
        )}
      </div>
      {estimate && <CalibrationDetail estimate={estimate} open={single} />}
    </article>
  );
}

export function TokenCapacity({
  snapshot,
  provider: only,
}: {
  snapshot: Snapshot;
  /** Limit the panel to one provider, as on that provider's detail page. */
  provider?: (typeof PROVIDERS)[number]['id'];
}) {
  // A provider with no allowance reading at all has nothing to estimate yet;
  // the provider strip already explains how to connect it.
  const providers = PROVIDERS.filter(
    (provider) =>
      (!only || provider.id === only) &&
      subscriptionVisible(snapshot.settings, provider.id) &&
      snapshot.quotas[provider.id],
  );
  if (!providers.length) return null;
  return (
    <section className={`pnl token-capacity-panel${only ? ' single' : ''}`} aria-labelledby="token-capacity-heading">
      <div className="token-capacity-head">
        <div>
          <h2 id="token-capacity-heading">Weekly token capacity</h2>
          <p>
            Estimated token capacity at your recent usage mix. Model, caching, and workload changes can move the
            estimate.
          </p>
        </div>
        {snapshot.isPreview && <span className="badge">Example estimates</span>}
      </div>
      <div className="token-capacity-grid">
        {providers.flatMap((provider) => {
          // A risky five-hour summary must not replace the separate weekly
          // estimate. Longer windows must not be described as a week's tokens.
          const weekly = capacityWindows(provider.id, snapshot);
          return (weekly.length ? weekly : [null]).map((window) => (
            <CapacityCard
              key={`${provider.id}:${window?.bucketId || 'missing'}`}
              provider={provider}
              window={window}
              timezone={snapshot.timezone}
              nowMs={snapshotNowMs(snapshot)}
              single={Boolean(only)}
            />
          ));
        })}
      </div>
      <p className="token-capacity-caveat">
        Estimates are not a guaranteed provider token quota. Local records may miss web, cloud, or other-device
        activity. Confidence describes consistency in the available local evidence. These windows can share the same
        allowance pool; their capacities must not be added together.
      </p>
    </section>
  );
}
