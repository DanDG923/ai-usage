import { Save } from 'lucide-react';
import { useState } from 'react';
import { LOCALE } from '../../lib';
import type { PriceRow, Settings, Snapshot } from '../../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from '../InfoTip';
import { NumericSetting, SectionHeading } from './fields';

const FIELDS = [
  'input_usd_per_million',
  'cache_write_usd_per_million',
  'cache_write_1h_usd_per_million',
  'cache_read_usd_per_million',
  'output_usd_per_million',
] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = {
  input_usd_per_million: 'input price',
  cache_write_usd_per_million: 'five minute cache write price',
  cache_write_1h_usd_per_million: 'one hour cache write price',
  cache_read_usd_per_million: 'cache read price',
  output_usd_per_million: 'output price',
};

// Built once: every catalogue row formats its effective date on every render
// of the Settings page, and constructing a formatter per row was the cost.
const EFFECTIVE_DATE = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function catalogRowNote(row: PriceRow) {
  const candidateDate = new Date(`${row.effective_from}T00:00:00Z`);
  const effective =
    /^\d{4}-\d{2}-\d{2}$/.test(row.effective_from) && Number.isFinite(candidateDate.getTime())
      ? EFFECTIVE_DATE.format(candidateDate)
      : row.effective_from;
  let source = 'local/manual source';
  if (row.source_url) {
    try {
      source = `source reference ${new URL(row.source_url).hostname}`;
    } catch {
      source = 'saved source reference';
    }
  }
  return `Row effective ${effective} · ${source}`;
}

function PriceEditor({
  row,
  onSave,
  unpricedSource,
  templates,
}: {
  row: PriceRow;
  onSave: (row: PriceRow) => Promise<void>;
  unpricedSource?: string;
  templates: PriceRow[];
}) {
  const toDraft = (price: PriceRow) =>
    Object.fromEntries(FIELDS.map((key) => [key, String(price[key])])) as Record<Field, string>;
  const emptyDraft = () => Object.fromEntries(FIELDS.map((key) => [key, ''])) as Record<Field, string>;
  const [draft, setDraft] = useState(() => (unpricedSource ? emptyDraft() : toDraft(row)));
  // Depend on the values, not the row object: every snapshot arrives as a fresh
  // clone over IPC, and with automatic collection that would wipe a price the
  // user is still typing. The draft resets only when the saved values change.
  const saved = `${unpricedSource || ''}|${FIELDS.map((key) => row[key]).join('|')}`;
  const [savedKey, setSavedKey] = useState(saved);
  if (savedKey !== saved) {
    setSavedKey(saved);
    setDraft(unpricedSource ? emptyDraft() : toDraft(row));
  }
  const field = (key: Field) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  const valid = FIELDS.every(
    (key) => draft[key].trim() !== '' && Number.isFinite(Number(draft[key])) && Number(draft[key]) >= 0,
  );
  const save = () => {
    if (!valid) return;
    // Once a catalogue row is edited locally, its old official URL/date no
    // longer describes the saved values. Mark the replacement as today's
    // local row instead of displaying borrowed provenance.
    void onSave({
      ...row,
      ...Object.fromEntries(FIELDS.map((key) => [key, Number(draft[key])])),
      effective_from: new Date().toISOString().slice(0, 10),
      source_url: null,
    });
  };
  return (
    <tr className={unpricedSource ? 'unpriced-price-row' : ''}>
      <td>
        <strong>{row.model}</strong>
        <small>{unpricedSource ? `Detected from ${unpricedSource} · enter all prices` : catalogRowNote(row)}</small>
        {unpricedSource && templates.length > 0 && (
          <select
            className="copy-prices"
            aria-label={`Copy prices into ${row.model} from`}
            value=""
            onChange={(event) => {
              const template = templates.find((entry) => entry.model === event.target.value);
              if (template) setDraft(toDraft(template));
            }}
          >
            <option value="">Copy prices from…</option>
            {templates.map((template) => (
              <option key={template.model} value={template.model}>
                {template.model}
              </option>
            ))}
          </select>
        )}
      </td>
      {FIELDS.map((key) => (
        <td key={key}>
          <input
            aria-label={`${row.model} ${FIELD_LABELS[key]}`}
            placeholder={unpricedSource ? 'Required' : undefined}
            type="number"
            min="0"
            step="0.01"
            value={draft[key]}
            onChange={field(key)}
          />
        </td>
      ))}
      <td>
        <button className="price-save" aria-label={`Save ${row.model} prices`} disabled={!valid} onClick={save}>
          <Save aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

export function PricingSection({
  snapshot,
  update,
  onPrice,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void>;
  onPrice: (row: PriceRow) => Promise<void>;
}) {
  const { settings } = snapshot;
  const pricedModels = new Set(snapshot.priceCatalog.map((row) => row.model.toLowerCase()));
  const seenModels = new Set(pricedModels);
  const unpricedRows = [
    ...snapshot.costs.unpricedModels,
    ...(snapshot.desktopEstimates?.byModel ?? []).flatMap((entry) =>
      entry.model && entry.estimatedCost === null
        ? [{ model: entry.model, sourceId: 'Claude desktop/web export' }]
        : [],
    ),
  ]
    .filter((entry) => {
      const model = entry.model.toLowerCase();
      if (seenModels.has(model)) return false;
      seenModels.add(model);
      return true;
    })
    .map((entry) => ({
      sourceId: entry.sourceId,
      row: {
        model: entry.model,
        input_usd_per_million: 0,
        cache_write_usd_per_million: 0,
        cache_write_1h_usd_per_million: 0,
        cache_read_usd_per_million: 0,
        output_usd_per_million: 0,
        effective_from: new Date().toISOString().slice(0, 10),
        source_url: null,
      } satisfies PriceRow,
    }));
  return (
    <section id="pricing" className="panel settings-section">
      <SectionHeading
        title="API pricing"
        description="USD per million tokens. Five-minute and one-hour cache writes are priced separately. Detected models without a price appear first so the estimate can be completed here."
      />
      <div className="currency-row">
        <label>
          <span>Display currency</span>
          <select
            value={settings.currency}
            onChange={(event) =>
              update(
                event.target.value === 'USD' ? { currency: 'USD', usdToCurrency: 1 } : { currency: event.target.value },
              )
            }
          >
            <option value="GBP">GBP · £</option>
            <option value="USD">USD · $</option>
            <option value="EUR">EUR · €</option>
          </select>
        </label>
        <NumericSetting
          label={settings.currency === 'USD' ? 'One USD equals (fixed)' : 'One USD equals (manual display rate)'}
          disabled={settings.currency === 'USD'}
          value={settings.usdToCurrency}
          min={0.01}
          max={10_000}
          step={0.001}
          onCommit={(value) => update({ usdToCurrency: value })}
        />
      </div>
      <div className="settings-fields plan-fields">
        <NumericSetting
          label="Codex subscription (USD per month)"
          value={settings.codexPlanUsdPerMonth}
          min={0}
          max={100_000}
          step={1}
          onCommit={(value) => update({ codexPlanUsdPerMonth: value })}
        />
        <NumericSetting
          label="Claude subscription (USD per month)"
          value={settings.claudePlanUsdPerMonth}
          min={0}
          max={100_000}
          step={1}
          onCommit={(value) => update({ claudePlanUsdPerMonth: value })}
        />
      </div>
      <div className="learning-note">
        <span>
          <strong>Subscription value</strong>
          With a monthly fee set, the Overview compares the API-equivalent value of the period with the fees for the
          same number of days. Leave a fee at zero to hide the ratio. Fees are compared, not charged.
        </span>
      </div>
      <div className="pricing-disclosure">
        <span>
          <strong>
            Current catalogue, not historical tariffs{' '}
            <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
          </strong>
          Every selected period is recalculated with the current row for each model. Effective dates and source
          references are shown for provenance, but earlier price versions are not retained.{' '}
          {settings.currency === 'USD'
            ? 'USD is fixed at 1:1.'
            : `${settings.currency} uses the manually saved display rate above; exchange rates are not fetched automatically.`}
        </span>
      </div>
      <div className="table-scroll price-table">
        <table>
          <thead>
            <tr>
              <th>Model / provenance</th>
              <th>Input</th>
              <th>Write 5m</th>
              <th>Write 1h</th>
              <th>Cache read</th>
              <th>Output</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {unpricedRows.map(({ sourceId, row }) => (
              <PriceEditor
                key={`unpriced:${sourceId}:${row.model}`}
                row={row}
                unpricedSource={sourceId}
                onSave={onPrice}
                templates={snapshot.priceCatalog}
              />
            ))}
            {snapshot.priceCatalog.map((row) => (
              <PriceEditor key={row.model} row={row} onSave={onPrice} templates={[]} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
