import { dateTimeLabel, percent, resetDistance, whenLabel } from '../lib';
import type { ProviderView } from '../provider-view';

const STATE_WORD: Record<ProviderView['state'], string> = {
  safe: 'On track',
  watch: 'Watch',
  risk: 'At risk',
  critical: 'Critical',
  unknown: 'Learning',
};

function scenarioBar(view: ProviderView) {
  const remaining = view.remaining ?? 0;
  const expectedRemaining = view.expectedRemaining ?? remaining;
  const heavyRemaining = view.heavyRemaining ?? expectedRemaining;
  const used = Math.max(0, 100 - remaining);
  const expectedUse = Math.max(0, remaining - expectedRemaining);
  const heavyUse = Math.max(0, expectedRemaining - heavyRemaining);
  const buffer = Math.max(0, 100 - used - expectedUse - heavyUse);
  return { used, expectedUse, heavyUse, buffer, expectedRemaining, heavyRemaining };
}

function consequence(view: ProviderView, nowMs: number) {
  const forecast = view.current?.forecast;
  if (!forecast) return 'Waiting for a first observation';
  if (forecast.exhaustsAt) return `Expected case runs out ${whenLabel(forecast.exhaustsAt, nowMs)}`;
  if (forecast.heavyExhaustsAt) return `Heavy case runs out ${whenLabel(forecast.heavyExhaustsAt, nowMs)}`;
  if (forecast.paceRatio > 1.05) return `${forecast.paceRatio.toFixed(1)}× safe pace`;
  if (view.expectedRemaining != null) return `${percent(view.expectedRemaining)} expected at reset`;
  return 'Learning from recent usage';
}

export function ProviderSummary({ view, nowMs }: { view: ProviderView; nowMs: number }) {
  if (!view.current || view.remaining == null) {
    return (
      <article className={`provider-summary ${view.id} unknown`} aria-label={`${view.name} allowance`}>
        <div className="provider-summary-head">
          <div>
            <h2>{view.name}</h2>
            <span>{view.subtitle}</span>
          </div>
          <span className="state-pill unknown">Learning</span>
        </div>
        <p className="provider-empty">Waiting for the provider’s first allowance observation.</p>
      </article>
    );
  }

  const bar = scenarioBar(view);
  const aria = `${view.name}: ${Math.round(view.remaining)}% left. Expected usage before reset ${Math.round(bar.expectedUse)} percentage points, leaving ${Math.round(bar.expectedRemaining)}%. Additional heavy usage ${Math.round(bar.heavyUse)} percentage points, leaving ${Math.round(bar.heavyRemaining)}%.`;
  return (
    <article className={`provider-summary ${view.id} ${view.state}`} aria-label={`${view.name} allowance`}>
      <div className="provider-summary-head">
        <div>
          <h2>{view.name}</h2>
          <span title={view.subtitle}>{view.subtitle}</span>
        </div>
        <span className={`state-pill ${view.state}`}>{STATE_WORD[view.state]}</span>
      </div>
      <div className="provider-primary">
        <strong>
          {view.estimated ? '~' : ''}
          {Math.round(view.remaining)}%
        </strong>
        <span>left</span>
        <small>{consequence(view, nowMs)}</small>
      </div>
      <div className="scenario-bar" role="img" aria-label={aria} title={aria}>
        <i className="scenario-used" style={{ width: `${bar.used}%` }} />
        <i className="scenario-expected" style={{ width: `${bar.expectedUse}%` }} />
        <i className="scenario-heavy" style={{ width: `${bar.heavyUse}%` }} />
        <i className="scenario-buffer" style={{ width: `${bar.buffer}%` }} />
      </div>
      <div className="provider-meta">
        <span>{view.estimated ? 'Estimated balance' : 'Current balance'}</span>
        <span title={dateTimeLabel(view.resetAt!)}>Resets in {resetDistance(view.resetAt!)}</span>
      </div>
    </article>
  );
}
