import { Banknote, DatabaseZap, Gauge, Layers3 } from 'lucide-react';
import { compactNumber, money, percent } from '../../lib';
import type { CostAnalytics } from '../../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from '../InfoTip';

export function MetricRibbon({ costs, unpriced }: { costs: CostAnalytics; unpriced: string }) {
  return (
    <section className="metric-ribbon" aria-label="Cost summary">
      <div>
        <span className="metric-icon">
          <Banknote aria-hidden="true" />
        </span>
        <span>
          API-equivalent cost <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
        </span>
        <strong>
          {costs.isLowerBound ? '≥ ' : ''}
          {money(costs.actual, costs.currency)}
        </strong>
        <small>
          {costs.isLowerBound
            ? 'Lower bound from priced token records'
            : `${costs.requestCount.toLocaleString()} tracked updates`}
        </small>
      </div>
      <div>
        <span className="metric-icon amber">
          <DatabaseZap aria-hidden="true" />
        </span>
        <span>Cache discount</span>
        <strong>{money(costs.cacheSavings, costs.currency)}</strong>
        <small>{percent(costs.cacheSavingsPercent * 100)} below the uncached value</small>
      </div>
      <div>
        <span className="metric-icon violet">
          <Layers3 aria-hidden="true" />
        </span>
        <span>Tokens tracked</span>
        <strong>{compactNumber(costs.totalTokens)}</strong>
        <small>across Codex and Claude</small>
      </div>
      <div>
        <span className="metric-icon blue">
          <Gauge aria-hidden="true" />
        </span>
        <span>Price coverage</span>
        <strong>{percent(costs.coverage * 100)}</strong>
        <small>
          {costs.isLowerBound ? `Unpriced: ${unpriced || 'unknown models'}` : 'All tracked token categories priced'}
        </small>
      </div>
    </section>
  );
}
