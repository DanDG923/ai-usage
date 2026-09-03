import { compactNumber, money, percent } from '../../lib';
import type { CostAnalytics } from '../../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from '../InfoTip';

/** Share of prompt-side tokens served from cache, across every priced or unpriced model. */
export function cacheHitRate(costs: CostAnalytics) {
  let cached = 0;
  let prompt = 0;
  for (const row of costs.byModel) {
    cached += row.cachedInputTokens;
    prompt += row.inputTokens + row.cacheWriteInputTokens;
    // Codex reports cached input as a subset of input; Claude reports it separately.
    if (row.sourceId !== 'codex') prompt += row.cachedInputTokens;
  }
  return prompt > 0 ? cached / prompt : null;
}

export function MetricRibbon({ costs, unpriced }: { costs: CostAnalytics; unpriced: string }) {
  const hitRate = cacheHitRate(costs);
  return (
    <section className="stat-row metric-ribbon" aria-label="Cost summary">
      <div>
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
        <span>Cache discount</span>
        <strong>{money(costs.cacheSavings, costs.currency)}</strong>
        <small>{percent(costs.cacheSavingsPercent * 100)} below the uncached value</small>
      </div>
      <div>
        <span>Cache hit rate</span>
        <strong>{hitRate == null ? '—' : percent(hitRate * 100)}</strong>
        <small>of prompt tokens read from cache</small>
      </div>
      <div>
        <span>Tokens tracked</span>
        <strong>{compactNumber(costs.totalTokens)}</strong>
        <small>across Codex and Claude</small>
      </div>
      <div>
        <span>Price coverage</span>
        <strong>{percent(costs.coverage * 100)}</strong>
        <small title={costs.isLowerBound ? `Unpriced: ${unpriced || 'unknown models'}` : undefined}>
          {costs.isLowerBound ? `Unpriced: ${unpriced || 'unknown models'}` : 'All tracked token categories priced'}
        </small>
      </div>
    </section>
  );
}
