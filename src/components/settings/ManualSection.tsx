import { Save } from 'lucide-react';
import { FormEvent, useState } from 'react';
import type { ManualObservation } from '../../types';
import { SectionHeading } from './fields';

export function ManualSection({ onManual }: { onManual: (observation: ManualObservation) => Promise<void> }) {
  const [sourceId, setSourceId] = useState<ManualObservation['sourceId']>('claude-fable');
  const [used, setUsed] = useState('');
  const [reset, setReset] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!used || !reset) return;
    setSaving(true);
    try {
      await onManual({ sourceId, usedPercent: Number(used), resetsAt: new Date(reset).toISOString() });
      setUsed('');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section id="manual" className="panel settings-section">
      <SectionHeading
        title="Manual observation"
        description="Automatic sources are checked on every refresh. Record a provider percentage by hand only when an allowance is unavailable or to re-anchor a local Fable estimate."
      />
      <form className="manual-form" onSubmit={submit}>
        <label>
          <span>Allowance</span>
          <select
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value as ManualObservation['sourceId'])}
          >
            <option value="claude-fable">Fable 5 weekly</option>
            <option value="claude">Claude overall weekly</option>
            <option value="codex">Codex weekly</option>
          </select>
        </label>
        <label>
          <span>Used</span>
          <div className="input-suffix">
            <input
              required
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={used}
              onChange={(event) => setUsed(event.target.value)}
            />
            <span>%</span>
          </div>
        </label>
        <label>
          <span>Resets at</span>
          <input required type="datetime-local" value={reset} onChange={(event) => setReset(event.target.value)} />
        </label>
        <button disabled={saving} className="primary-button" type="submit">
          <Save aria-hidden="true" />
          Record observation
        </button>
      </form>
    </section>
  );
}
