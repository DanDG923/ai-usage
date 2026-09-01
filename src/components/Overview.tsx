import { ArrowDownRight } from 'lucide-react';
import { compactNumber, money, percent, primaryWindow, shortDate } from '../lib';
import type { Snapshot } from '../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from './InfoTip';
import { QuotaCard } from './QuotaCard';

function fableActivity(snapshot: Snapshot) {
  const automatic = snapshot.sources.find((source) => source.id === 'claude-fable')?.metadata?.automatic;
  if (!automatic || typeof automatic !== 'object' || Array.isArray(automatic)) return null;
  const activity = (automatic as Record<string, unknown>).activity;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;
  const row = activity as Record<string, unknown>;
  const healthValue = (automatic as Record<string, unknown>).health;
  const health =
    healthValue && typeof healthValue === 'object' && !Array.isArray(healthValue)
      ? (healthValue as Record<string, unknown>)
      : {};
  const numeric = (key: string) => (typeof row[key] === 'number' && Number.isFinite(row[key]) ? Number(row[key]) : 0);
  const requests = numeric('requests');
  const tokens =
    numeric('inputTokens') + numeric('cachedInputTokens') + numeric('cacheWriteInputTokens') + numeric('outputTokens');
  return {
    requests,
    tokens,
    officialSource: typeof health.officialSource === 'string' ? health.officialSource : null,
    activitySource: typeof health.activitySource === 'string' ? health.activitySource : null,
    activityLastSuccessfulAt:
      typeof health.activityLastSuccessfulAt === 'string' ? health.activityLastSuccessfulAt : null,
  };
}

function fableCardProps(snapshot: Snapshot) {
  const fable = primaryWindow(snapshot.quotas.fable);
  const fableSource = snapshot.sources.find((source) => source.id === 'claude-fable');
  const activity = fableActivity(snapshot);
  const allowanceStale = activity?.officialSource
    ? activity.officialSource !== 'connected'
    : Boolean(fableSource && ['stale', 'degraded', 'error'].includes(fableSource.status));
  const activityStale = Boolean(activity?.activitySource && activity.activitySource !== 'current');
  const derived = fable?.provenance === 'derived-tokens';
  const manual = fable?.provenance === 'manual-official';
  const measurement = !fable
    ? 'awaiting data'
    : derived
      ? `${allowanceStale ? 'stale ' : ''}local estimate`
      : manual
        ? 'manual observation'
        : `${allowanceStale ? 'stale ' : ''}provider reading`;
  const activitySummary =
    activity && (activity.requests || activity.tokens)
      ? `${compactNumber(activity.requests)} local request${activity.requests === 1 ? '' : 's'} · ${compactNumber(activity.tokens)} tracked tokens`
      : 'no local Fable activity in the current lookback';
  const notes: React.ReactNode[] = [];
  if (derived)
    notes.push(
      'Estimated from local activity and calibrated allowance history; the provider figure replaces it whenever a model-scoped window is returned.',
    );
  if (allowanceStale && fable)
    notes.push(
      <span className="note-warm">
        The latest allowance refresh is {fableSource?.status}; balances are projected from the reading observed{' '}
        {shortDate(fable.observedAt)}.
      </span>,
    );
  if (activityStale)
    notes.push(
      <span className="note-warm">
        The latest local activity import failed; counts are from the last successful import
        {activity?.activityLastSuccessfulAt ? ` at ${shortDate(activity.activityLastSuccessfulAt)}` : ''}.
      </span>,
    );
  notes.push(`This device · ${activityStale ? 'cached · ' : ''}${activitySummary}`);
  return {
    measurement,
    notes,
    emptyText: `Automatic collection has not exposed a current Fable allowance yet. This device: ${activitySummary}. A manual observation remains an optional fallback in Data & settings.`,
  };
}

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const unpricedModels = snapshot.costs.unpricedModels.map((entry) => entry.model).join(', ');
  const fable = fableCardProps(snapshot);
  const nowMs = Date.parse(snapshot.generatedAt);
  return (
    <main className="page overview-page" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
      <section className="qc-grid">
        <QuotaCard kind="codex" quota={snapshot.quotas.codex} nowMs={nowMs} resetCredits={snapshot.resetCredits} />
        <QuotaCard kind="claude" quota={snapshot.quotas.claude} nowMs={nowMs} />
        <QuotaCard
          kind="fable"
          quota={snapshot.quotas.fable}
          nowMs={nowMs}
          measurement={fable.measurement}
          notes={fable.notes}
          emptyText={fable.emptyText}
        />
      </section>
      <section className="value-strip" aria-label="API-equivalent cost summary">
        <div>
          <span>
            API-equivalent cost · last {snapshot.costs.periodDays} days{' '}
            <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
          </span>
          <strong>
            {snapshot.costs.isLowerBound ? 'At least ' : ''}
            {money(snapshot.costs.actual, snapshot.costs.currency)}
          </strong>
          {snapshot.costs.isLowerBound && <small>lower bound: some models are unpriced</small>}
        </div>
        <ArrowDownRight aria-hidden="true" />
        <div>
          <span>Without cache</span>
          <strong>{money(snapshot.costs.withoutCache, snapshot.costs.currency)}</strong>
        </div>
        <div className="savings">
          <span>Cache discount</span>
          <strong>{money(snapshot.costs.cacheSavings, snapshot.costs.currency)}</strong>
          <small>{percent(snapshot.costs.cacheSavingsPercent * 100)} avoided</small>
        </div>
        <div className="coverage">
          <span>Price coverage</span>
          <strong>{percent(snapshot.costs.coverage * 100)}</strong>
          <small>
            {snapshot.costs.isLowerBound
              ? `Unpriced: ${unpricedModels || 'unknown models'}`
              : 'All tracked token categories priced'}
          </small>
        </div>
      </section>
    </main>
  );
}
