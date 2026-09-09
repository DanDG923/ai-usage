import { subscriptionVisible } from '../../electron/dashboard-decision.mjs';
import { compactNumber, percent, quotaWindows, shortDate } from '../lib';
import type { QuotaWindow, Snapshot, TokenCapacityEstimate } from '../types';

const PROVIDERS = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' },
  { id: 'fable', name: 'Fable 5' },
] as const;

const TOKEN_CATEGORIES = [
  ['input', 'Uncached input'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['output', 'Output'],
] as const;

function capacityWindows(providerId: (typeof PROVIDERS)[number]['id'], snapshot: Snapshot) {
  const weekly = quotaWindows(snapshot.quotas[providerId]).filter((window) => window.windowMinutes === 10_080);
  if (providerId !== 'codex') {
    // Claude also reports weekly pools with no token scope (OAuth apps). Such
    // a window would only ever show "Unavailable" beside a real estimate, so
    // keep it only when it is the sole weekly window and its reason matters.
    const supported = weekly.filter((window) => window.tokenCapacity?.status !== 'unavailable');
    return supported.length ? supported : weekly;
  }

  // Codex can also report separate model-specific limits under the same
  // "Weekly" label. Only the account-wide limit has a matching token scope.
  // Primary/secondary are provider slot names, so retain the newest live
  // weekly reading if the account limit has moved between those slots.
  const nowMs = Date.parse(snapshot.generatedAt);
  const expired = (window: QuotaWindow) => window.forecast.expired || Date.parse(window.resetsAt) <= nowMs;
  return weekly
    .filter(
      (window) =>
        ['codex:weekly', 'codex:primary', 'codex:secondary'].includes(window.bucketId) &&
        (window.metadata?.limitId == null || window.metadata.limitId === 'codex'),
    )
    .sort(
      (a, b) =>
        Number(expired(a)) - Number(expired(b)) ||
        Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
        a.bucketId.localeCompare(b.bucketId),
    )
    .slice(0, 1);
}

function estimateRange(range: { low: number; high: number } | null) {
  return range
    ? `Estimate range ${compactNumber(range.low)}–${compactNumber(range.high)} tokens`
    : 'Estimate range not yet available';
}

function CalibrationDetail({ estimate }: { estimate: TokenCapacityEstimate }) {
  return (
    <details className="token-capacity-details">
      <summary>Evidence and usage mix</summary>
      <div>
        <p>
          {estimate.intervals} matched {estimate.intervals === 1 ? 'interval' : 'intervals'} across {estimate.cycles}{' '}
          {estimate.cycles === 1 ? 'cycle' : 'cycles'} · {estimate.observedPercent.toFixed(1)} percentage points of
          allowance change matched.
          {estimate.calibratedAt ? ` Last calibrated ${shortDate(estimate.calibratedAt)}.` : ''}
        </p>
        {estimate.modelMix.length > 0 && (
          <>
            <h4>Recent model mix</h4>
            <ul className="token-capacity-mix" aria-label="Recent model mix by recorded tokens">
              {estimate.modelMix.map(({ model, share }) => (
                <li key={model}>
                  <span>{model}</span>
                  <strong>{percent(share * 100)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
        {Object.values(estimate.tokenMix).some((share) => share > 0) && (
          <>
            <h4>Recorded token mix</h4>
            <dl className="token-capacity-mix">
              {TOKEN_CATEGORIES.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{percent(estimate.tokenMix[key] * 100)}</dd>
                </div>
              ))}
            </dl>
            <p>Cache categories are counted once. Output includes any recorded reasoning tokens.</p>
          </>
        )}
        {estimate.warnings.length > 0 && (
          <ul className="token-capacity-warnings">
            {estimate.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
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
}: {
  provider: (typeof PROVIDERS)[number];
  window: QuotaWindow | null;
  timezone: string;
  nowMs: number;
}) {
  const estimate = window?.tokenCapacity;
  const available = estimate?.status === 'available' && estimate.weeklyTokens != null;
  const expired = Boolean(window?.forecast.expired) || (window != null && Date.parse(window.resetsAt) <= nowMs);
  const remaining = available && !expired && estimate.remainingTokens != null && estimate.remainingAsOf;
  const status = available
    ? `${estimate.confidence.charAt(0).toUpperCase()}${estimate.confidence.slice(1)} confidence`
    : estimate?.status === 'unavailable' || !window
      ? 'Unavailable'
      : 'Learning';
  const reason =
    estimate?.reason ||
    (!window
      ? 'A weekly allowance reading is needed before token capacity can be estimated.'
      : 'Collecting enough matching allowance readings and local token usage to estimate this window.');

  return (
    <article className={`token-capacity-card ${provider.id}`}>
      <header>
        <div>
          <h3>
            <span className={`source-dot ${provider.id}`} aria-hidden="true" />
            {provider.name}
          </h3>
          <p>{window?.bucketName || 'Weekly allowance'}</p>
        </div>
        <span className="token-capacity-confidence">{status}</span>
      </header>
      {available ? (
        <>
          <dl className="token-capacity-values">
            <div>
              <dt>Est. full week</dt>
              <dd>
                ≈ {compactNumber(estimate.weeklyTokens!)} <small>tokens</small>
              </dd>
              <small>{estimateRange(estimate.weeklyRange)}</small>
              {estimate.calibratedAt && <small>Calibrated {shortDate(estimate.calibratedAt)}</small>}
            </div>
            <div>
              <dt>Est. remaining at reading</dt>
              <dd className={remaining ? undefined : 'token-capacity-pending'}>
                {remaining ? (
                  <>
                    ≈ {compactNumber(estimate.remainingTokens!)} <small>tokens</small>
                  </>
                ) : (
                  'Needs current reading'
                )}
              </dd>
              {remaining && <small>{estimateRange(estimate.remainingRange)}</small>}
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
      {estimate && <CalibrationDetail estimate={estimate} />}
    </article>
  );
}

export function TokenCapacity({ snapshot }: { snapshot: Snapshot }) {
  // A provider with no allowance reading at all has nothing to estimate yet;
  // the provider strip already explains how to connect it.
  const providers = PROVIDERS.filter(
    (provider) => subscriptionVisible(snapshot.settings, provider.id) && snapshot.quotas[provider.id],
  );
  if (!providers.length) return null;
  return (
    <section className="panel token-capacity-panel" aria-labelledby="token-capacity-heading">
      <div className="panel-heading">
        <div>
          <h2 id="token-capacity-heading">Weekly token capacity</h2>
          <p>
            Estimated token capacity at your recent usage mix. Model, caching, and workload changes can move the
            estimate.
          </p>
        </div>
        {snapshot.isPreview && <span className="table-note">Example estimates</span>}
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
              nowMs={Date.parse(snapshot.generatedAt)}
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
