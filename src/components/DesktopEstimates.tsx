import { useState } from 'react';
import type { DesktopImportPreview, Snapshot } from '../types';
import { compactNumber, money } from '../lib';

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
      className="panel desktop-estimates"
      aria-labelledby="desktop-estimates-heading"
      aria-busy={busy}
      data-keep-awake={preview ? 'true' : undefined}
    >
      <div className="panel-heading">
        <div>
          <h2 id="desktop-estimates-heading">Claude desktop & web chat estimates</h2>
          <p>Separate from recorded costs and allowance forecasts. Last {snapshot.costs.periodDays} days.</p>
        </div>
        <span className="table-note">Manual export import · text only</span>
      </div>
      <div className="desktop-estimates-body">
        <p>
          In Claude, open Settings → Privacy → Export data. Download and extract the ZIP, then choose conversations.json
          here. Processing stays on this PC; conversation text and titles are never saved by AI Usage. Desktop and web
          chats cannot be distinguished in the export.
        </p>
        <details>
          <summary>How the estimate works</summary>
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
            models without prices can be priced in Settings → Pricing and data management → API pricing.
          </p>
        </details>
        {!preview ? (
          <div className="action-row">
            <button className="secondary-button" disabled={busy} onClick={choose}>
              {busy ? 'Working…' : 'Import Claude export…'}
            </button>
            {!!estimates?.storedReplies && (
              <button className="secondary-button" disabled={busy} onClick={clear}>
                Remove imported estimates…
              </button>
            )}
          </div>
        ) : (
          <div className="desktop-import-preview">
            <h3>Review chat import</h3>
            <p>
              {preview.conversations} conversations · {preview.replies} replies · {preview.skipped} unsupported or
              unusable entries skipped.
            </p>
            <p>
              {preview.models.length
                ? `Reply models found: ${preview.models.join(', ')}`
                : 'No reply model information was found.'}
            </p>
            <p>
              {preview.unknownModelReplies} replies have no model. {preview.excludedContentReplies} replies have missing
              prompts or excluded content.
            </p>
            {!!preview.unknownModelReplies && (
              <label className="desktop-model-choice">
                <span>Pricing assumption for replies with no model</span>
                <select value={assumedModel} disabled={busy} onChange={(event) => setAssumedModel(event.target.value)}>
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
              <p>
                This applies {assumedModel} to every reply missing a model in this import. It does not verify which
                model you used.
              </p>
            )}
            <div className="action-row">
              <button className="primary-button" disabled={busy} onClick={save}>
                {busy ? 'Working…' : 'Save chat estimates'}
              </button>
              <button className="secondary-button" disabled={busy} onClick={cancel}>
                Cancel import
              </button>
            </div>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        {!!estimates?.replies && (
          <p>
            <strong>{estimateMoney(estimates.estimatedCost, estimates.currency)}</strong> estimated visible-text value
            for priced replies · {estimates.replies} replies imported in this period · {estimates.unpricedReplies}{' '}
            unpriced. Excluded from the recorded cost total above.
          </p>
        )}
      </div>
      <div className="table-scroll">
        <table>
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
                  <td>
                    <strong>{row.model || 'Unknown model'}</strong>
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
                    {row.estimatedCost === null
                      ? 'Unpriced'
                      : `≈ ${estimateMoney(row.estimatedCost, estimates.currency)}`}
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
