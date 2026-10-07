import { useId, useState } from 'react';
import { LOCALE, localDateKey } from '../../lib';
import type { PriceRow, Settings, Snapshot } from '../../types';
import { API_EQUIVALENT_EXPLAINER, InfoTip } from '../InfoTip';
import {
  NumericSetting,
  SettingBlock,
  SettingColumns,
  SettingError,
  SettingNote,
  SettingRow,
  SettingsSection,
} from './fields';
import { unpricedModels } from './settings-sections';

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
      effective_from: localDateKey(new Date()),
      source_url: null,
    });
  };
  return (
    <tr className={unpricedSource ? 'unpriced-price-row' : ''}>
      <td>
        <span className="price-model">
          <strong>{row.model}</strong>
          {unpricedSource && <span className="unpriced-badge">Unpriced</span>}
        </span>
        <small>{unpricedSource ? `Detected from ${unpricedSource} · enter all prices` : catalogRowNote(row)}</small>
        {unpricedSource && templates.length > 0 && (
          <select
            className="fld copy-prices"
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
            className="fld num"
          />
        </td>
      ))}
      <td>
        <button
          type="button"
          className="btn price-save"
          aria-label={`Save ${row.model} prices`}
          disabled={!valid}
          onClick={save}
        >
          Save
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
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
  onPrice: (row: PriceRow) => Promise<void>;
}) {
  const { settings } = snapshot;
  const id = useId();
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null);
  const [rateDraft, setRateDraft] = useState('');
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [currencyError, setCurrencyError] = useState('');
  const chooseCurrency = async (currency: string, rate?: number) => {
    setSavingCurrency(true);
    setCurrencyError('');
    try {
      if ((await update({ currency, ...(rate != null ? { usdToCurrency: rate } : {}) })) === false) return;
      setPendingCurrency(null);
    } catch {
      setCurrencyError('Currency could not be saved. Try again.');
    } finally {
      setSavingCurrency(false);
    }
  };
  const unpricedRows = unpricedModels(snapshot).map((entry) => ({
    sourceId: entry.sourceId,
    row: {
      model: entry.model,
      input_usd_per_million: 0,
      cache_write_usd_per_million: 0,
      cache_write_1h_usd_per_million: 0,
      cache_read_usd_per_million: 0,
      output_usd_per_million: 0,
      // The editor dates the row when it is saved; reading the clock here,
      // during render, would make the placeholder differ between renders.
      effective_from: '',
      source_url: null,
    } satisfies PriceRow,
  }));
  const rateValid =
    rateDraft.trim() !== '' &&
    Number.isFinite(Number(rateDraft)) &&
    Number(rateDraft) >= 0.01 &&
    Number(rateDraft) <= 10000;
  return (
    <SettingsSection
      id="pricing"
      title="API pricing"
      description="USD per million tokens. Five-minute and one-hour cache writes are priced separately. Detected models without a price appear first so the estimate can be completed here."
    >
      <SettingColumns>
        <div className="setting-col">
          <SettingRow
            label="Display currency"
            htmlFor={`${id}-currency`}
            description="API-equivalent costs are shown in this currency. Catalogue prices below stay in USD."
          >
            <select
              id={`${id}-currency`}
              value={settings.currency}
              disabled={savingCurrency}
              onChange={(event) => {
                const currency = event.target.value;
                if (currency !== 'USD' && !settings.currencyRates?.[currency] && currency !== settings.currency) {
                  setPendingCurrency(currency);
                  setRateDraft('');
                } else void chooseCurrency(currency);
              }}
              className="fld"
            >
              <option value="GBP">GBP · £</option>
              <option value="USD">USD · $</option>
              <option value="EUR">EUR · €</option>
            </select>
            {currencyError && <SettingError>{currencyError}</SettingError>}
          </SettingRow>
        </div>
        <div className="setting-col">
          <NumericSetting
            label={settings.currency === 'USD' ? 'One USD equals (fixed)' : 'One USD equals (manual display rate)'}
            description={
              settings.currency === 'USD'
                ? 'USD is fixed at 1:1.'
                : `${settings.currency} uses this manually saved rate; exchange rates are not fetched automatically.`
            }
            disabled={settings.currency === 'USD'}
            value={settings.usdToCurrency}
            min={0.01}
            max={10_000}
            step={0.001}
            onCommit={(value) => update({ usdToCurrency: value })}
          />
        </div>
      </SettingColumns>
      {pendingCurrency && (
        <div className="setting-row pending-currency" role="group" aria-label={`Set ${pendingCurrency} display rate`}>
          <div className="setting-text">
            <label className="setting-label" htmlFor={`${id}-pending-rate`}>
              One USD equals ({pendingCurrency}, manual rate)
            </label>
            <div className="setting-description">
              {pendingCurrency} has no saved rate yet. Enter one to switch; the current currency stays until then.
            </div>
          </div>
          <span className="lead" aria-hidden="true" />
          <div className="setting-control">
            <input
              id={`${id}-pending-rate`}
              type="number"
              min="0.01"
              max="10000"
              step="0.001"
              value={rateDraft}
              onChange={(event) => setRateDraft(event.target.value)}
              className="fld num"
            />
            <div className="action-row compact">
              <button
                type="button"
                className="btn btn-p"
                disabled={savingCurrency || !rateValid}
                onClick={() => void chooseCurrency(pendingCurrency, Number(rateDraft))}
              >
                Save rate and switch
              </button>
              <button type="button" className="btn" disabled={savingCurrency} onClick={() => setPendingCurrency(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <SettingNote className="pricing-disclosure">
        <strong>
          Current catalogue, not historical tariffs{' '}
          <InfoTip label="What API-equivalent cost means">{API_EQUIVALENT_EXPLAINER}</InfoTip>
        </strong>
        <span>
          Every selected period is recalculated with the current row for each model. Effective dates and source
          references are shown for provenance, but earlier price versions are not retained.
        </span>
      </SettingNote>
      <SettingBlock className="table-scroll price-table">
        <table>
          <thead>
            <tr>
              <th>Model / provenance</th>
              <th className="num">Input</th>
              <th className="num">Write 5m</th>
              <th className="num">Write 1h</th>
              <th className="num">Cache read</th>
              <th className="num">Output</th>
              <th>
                <span className="sr-only">Save price</span>
              </th>
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
      </SettingBlock>
    </SettingsSection>
  );
}
