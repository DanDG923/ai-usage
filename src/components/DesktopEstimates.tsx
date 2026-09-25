import { AlertOctagon, Info, Upload } from 'lucide-react';
import { useState } from 'react';
import type { DesktopImportPreview, Snapshot } from '../types';
import { compactNumber, formatInt, money } from '../lib';
import { Disclosure } from './details/Disclosure';

function estimateMoney(value: number, currency: string) {
  return value > 0 && value < 0.01 ? `< ${money(0.01, currency)}` : money(value, currency);
}

export function DesktopEstimates({
  snapshot,
  onSnapshot,
}: {
  snapshot: Snapshot;
  onSnapshot: (value: Snapshot) => void;
}) {
  const [preview, setPreview] = useState<DesktopImportPreview | null>(null);
  const [assumedModel, setAssumedModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const estimates = snapshot.desktopEstimates;
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The chat import could not be completed.');
    } finally {
      setBusy(false);
    }
  };
  const choose = () =>
    perform(async () => {
      if (!window.aiUsage) {
        setNotice('Open the desktop app to import a local export.');
        return;
      }
      const selected = await window.aiUsage.previewDesktopExport();
      if (selected) {
        setPreview(selected);
        setAssumedModel('');
      }
    });
  const save = () =>
    perform(async () => {
      if (!preview || !window.aiUsage) return;
      const result = await window.aiUsage.importDesktopExport(preview.id, assumedModel || null);
      if (result.snapshot) onSnapshot(result.snapshot);
      setPreview(null);
      setNotice(
        `Imported ${result.result.imported} reply estimates; ${result.result.duplicates} already imported replies were kept unchanged.`,
      );
    });
  const cancel = () =>
    perform(async () => {
      if (preview) await window.aiUsage?.cancelDesktopExport(preview.id);
      setPreview(null);
    });
  const clear = () =>
    perform(async () => {
      const result = await window.aiUsage?.clearDesktopEstimates();
      if (result && !result.cancelled) {
        if (result.snapshot) onSnapshot(result.snapshot);
        setNotice('Imported estimates removed. A safety backup was saved.');
      }
    });
  return (
    <section
      id="desktop-estimates"
      className="panel costs-panel desktop-estimates"
      aria-labelledby="desktop-estimates-heading"
      aria-busy={busy}
      data-keep-awake={preview ? 'true' : undefined}
    >
      <div className="costs-head">
        <div>
          <h3 id="desktop-estimates-heading" className="pnl-title">
            Claude desktop & web chat estimates
          </h3>
          <p>Separate from recorded costs and allowance forecasts. Last {snapshot.costs.periodDays} days.</p>
        </div>
        <span className="badge">Manual export import · text only</span>
      </div>
      <div className="desktop-estimates-body">
        <p>
          Import conversations.json from a Claude data export. Processing stays on this PC; conversation text and titles
          are never saved by AI Usage.
        </p>
        <Disclosure summary="How to export your chats">
          <p>
            In Claude, open Settings → Privacy → Export data. Download and extract the ZIP, then choose
            conversations.json here. Processing stays on this PC; conversation text and titles are never saved by AI
            Usage. Desktop and web chats cannot be distinguished in the export.
          </p>
        </Disclosure>
        <Disclosure summary="How the estimate works">
          <p>
            We divide the character count of each visible prompt and reply by four, round up, and apply the current
            model’s input and output prices. This rough text-value estimate counts the immediate prompt only; it does
            not reconstruct repeated conversation context, system prompts, caching, images, attachments, tools, or
            hidden reasoning. It is not a measure of actual subscription consumption. Accuracy varies by language and
            content.
          </p>
          <p>
            Only models explicitly attached to replies are used. A conversation’s current model cannot identify earlier
            replies after a model switch. Missing models remain unpriced unless you select an assumption during import.
            Reimports preserve existing replies and assumptions; remove estimates and reimport to replace them. Named
            models without prices can be priced in Settings → API pricing.
          </p>
        </Disclosure>
        {!preview ? (
          <div className="costs-actions">
            <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={choose}>
              <Upload aria-hidden="true" />
              {busy ? 'Working…' : 'Import Claude export…'}
            </button>
            {!!estimates?.storedReplies && (
              <button type="button" className="btn" disabled={busy} onClick={clear}>
                Remove imported estimates…
              </button>
            )}
          </div>
        ) : (
          <div className="desktop-import-preview" role="group" aria-labelledby="desktop-import-heading">
            <h4 id="desktop-import-heading" className="pnl-title">
              Review chat import
            </h4>
            <dl className="desktop-import-facts">
              <div className="cr">
                <dt>Conversations</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{formatInt(preview.conversations)}</dd>
              </div>
              <div className="cr">
                <dt>Replies</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{formatInt(preview.replies)}</dd>
              </div>
              <div className="cr">
                <dt>Unsupported or unusable entries skipped</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{formatInt(preview.skipped)}</dd>
              </div>
              <div className="cr">
                <dt>Replies with no model</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{formatInt(preview.unknownModelReplies)}</dd>
              </div>
              <div className="cr">
                <dt>Replies with missing prompts or excluded content</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{formatInt(preview.excludedContentReplies)}</dd>
              </div>
            </dl>
            <p>
              {preview.models.length
                ? `Reply models found: ${preview.models.join(', ')}`
                : 'No reply model information was found.'}
            </p>
            {!!preview.unknownModelReplies && (
              <label className="desktop-model-choice">
                <span className="lbl">Pricing assumption for replies with no model</span>
                <select
                  className="fld"
                  value={assumedModel}
                  disabled={busy}
                  onChange={(event) => setAssumedModel(event.target.value)}
                >
                  <option value="">Keep unknown and unpriced</option>
                  {snapshot.priceCatalog
                    .filter((row) => row.model.startsWith('claude-'))
                    .map((row) => (
                      <option key={row.model} value={row.model}>
                        Assume {row.model}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {assumedModel && (
              <p className="desktop-import-caution">
                <Info aria-hidden="true" />
                <span>
                  This applies {assumedModel} to every reply missing a model in this import. It does not verify which
                  model you used.
                </span>
              </p>
            )}
            <div className="costs-actions">
              <button type="button" className="btn btn-p" disabled={busy} aria-busy={busy} onClick={save}>
                {busy ? 'Working…' : 'Save chat estimates'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={cancel}>
                Cancel import
              </button>
            </div>
          </div>
        )}
        {notice && (
          <p className="costs-message" role="status">
            <Info aria-hidden="true" />
            <span>{notice}</span>
          </p>
        )}
        {error && (
          <p className="costs-message is-error" role="alert">
            <AlertOctagon aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        {!!estimates?.replies && (
          <p className="desktop-estimate-total">
            <strong>{estimateMoney(estimates.estimatedCost, estimates.currency)}</strong> estimated visible-text value
            for priced replies · {estimates.replies} replies imported in this period · {estimates.unpricedReplies}{' '}
            unpriced. Excluded from the recorded cost total above.
          </p>
        )}
      </div>
      <div className="table-scroll">
        <table className="costs-table desktop-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Model evidence</th>
              <th className="num">Replies</th>
              <th className="num">Est. prompt tokens</th>
              <th className="num">Est. reply tokens</th>
              <th className="num">Est. text value</th>
            </tr>
          </thead>
          <tbody>
            {estimates?.byModel.length ? (
              estimates.byModel.map((row) => (
                <tr key={`${row.model}-${row.modelOrigin}`}>
                  <td className="costs-name">
                    <span className="costs-model">{row.model || 'Unknown model'}</span>
                    {!!row.incompleteReplies && (
                      <small>{row.incompleteReplies} with missing prompts or excluded content</small>
                    )}
                  </td>
                  <td>
                    {row.modelOrigin === 'exported'
                      ? 'From export'
                      : row.modelOrigin === 'assumed'
                        ? 'User assumption'
                        : 'Not supplied'}
                  </td>
                  <td className="num">{row.replies}</td>
                  <td className="num">{compactNumber(row.inputTokens)}</td>
                  <td className="num">{compactNumber(row.outputTokens)}</td>
                  <td className="num">
                    {row.estimatedCost === null ? (
                      <span className="costs-figure unpriced">Unpriced</span>
                    ) : (
                      <strong>{`≈ ${estimateMoney(row.estimatedCost, estimates.currency)}`}</strong>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty-cell">
                  {estimates?.storedReplies
                    ? 'No imported replies fall within this period. Choose a longer period above.'
                    : 'Import a Claude export to add desktop and web chat estimates.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
