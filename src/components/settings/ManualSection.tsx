import { Save } from 'lucide-react';
import { FormEvent, useId, useState } from 'react';
import type { ManualObservation } from '../../types';
import { SettingRow, SettingsSection } from './fields';

export function ManualSection({ onManual }: { onManual: (observation: ManualObservation) => Promise<boolean> }) {
  const id = useId();
  const [sourceId, setSourceId] = useState<ManualObservation['sourceId']>('claude-fable');
  const [used, setUsed] = useState('');
  const [reset, setReset] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!used || !reset) return;
    setSaving(true);
    try {
      const saved = await onManual({ sourceId, usedPercent: Number(used), resetsAt: new Date(reset).toISOString() });
      if (saved) setUsed('');
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection
      id="manual"
      title="Manual observation"
      description="Automatic sources are checked on every refresh. Record a provider percentage by hand only when an allowance is unavailable or to re-anchor a local Fable estimate."
    >
      <form className="manual-rows" onSubmit={submit}>
        <SettingRow
          label="Allowance"
          htmlFor={`${id}-source`}
          description="The weekly allowance this reading belongs to."
        >
          <select
            id={`${id}-source`}
            disabled={saving}
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value as ManualObservation['sourceId'])}
          >
            <option value="claude-fable">Fable 5 weekly</option>
            <option value="claude">Claude overall weekly</option>
            <option value="codex">Codex weekly</option>
          </select>
        </SettingRow>
        <SettingRow label="Used" htmlFor={`${id}-used`} description="The percentage the provider shows as used.">
          <div className="input-suffix">
            <input
              id={`${id}-used`}
              disabled={saving}
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
        </SettingRow>
        <SettingRow
          label="Resets at"
          htmlFor={`${id}-reset`}
          description="When the provider says this allowance resets."
        >
          <input
            id={`${id}-reset`}
            required
            disabled={saving}
            type="datetime-local"
            value={reset}
            onChange={(event) => setReset(event.target.value)}
          />
        </SettingRow>
        <div className="setting-row manual-submit">
          <div className="setting-control">
            <button disabled={saving} className="primary-button" type="submit">
              <Save aria-hidden="true" />
              {saving ? 'Saving observation…' : 'Record observation'}
            </button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}
