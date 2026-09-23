import { useId, useState } from 'react';
import type { Settings, Snapshot } from '../../types';
import { NumericSetting, SettingNote, SettingRow, SettingsSection, ToggleRow } from './fields';

export const SUBSCRIPTION_FEES_NOTE =
  'With a monthly fee set, the Overview compares the period’s API-equivalent value with the fees for the same number of days. Leave a fee at zero to hide the comparison. Fees are compared, never charged.';

export const CLAUDE_FREE_RESETS_NOTE =
  'Claude’s Usage settings can offer a free reset, for example to try a new model. No Claude API reports it, so record it here to see it on the Claude card. It hides itself after the expiry date and is never counted as allowance.';

/** The last day a recorded Claude free reset can be claimed; saved as soon as a date is picked. */
function FreeResetExpiry({
  value,
  disabled,
  onCommit,
}: {
  value: string | null;
  disabled: boolean;
  onCommit: (value: string | null) => Promise<void | boolean>;
}) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const save = async (next: string | null) => {
    setSaving(true);
    try {
      await onCommit(next);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow label="Expires on" htmlFor={id} description="Optional. Leave empty if Claude shows no expiry.">
      <div className="date-setting">
        <input
          id={id}
          type="date"
          value={value ?? ''}
          disabled={disabled || saving}
          onChange={(event) => {
            const next = event.target.value;
            if (/^d{4}-d{2}-d{2}$/.test(next)) void save(next);
          }}
        />
        {value && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || saving}
            onClick={() => void save(null)}
          >
            Clear
          </button>
        )}
      </div>
    </SettingRow>
  );
}

export function SubscriptionsSection({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
}) {
  const { settings } = snapshot;
  const showCodex = settings.showCodexSubscription !== false;
  const showClaude = settings.showClaudeSubscription !== false;
  return (
    <SettingsSection
      id="subscriptions"
      title="Subscriptions"
      description="Choose which subscriptions appear in your allowance views and alerts. You can show them again at any time."
    >
      <ToggleRow
        title="Show Codex"
        description="Codex allowances, forecasts, and reminders."
        checked={showCodex}
        onChange={(checked) => void update({ showCodexSubscription: checked })}
      />
      <ToggleRow
        title="Show Claude"
        description="Claude allowances, including Fable 5, forecasts, and reminders."
        checked={showClaude}
        onChange={(checked) => void update({ showClaudeSubscription: checked })}
      />
      {(showCodex || showClaude) && (
        <div
          id="subscription-fees"
          className="setting-group"
          role="group"
          aria-labelledby="subscription-fees-heading"
          aria-describedby="subscription-fees-note"
        >
          <div className="setting-group-head">
            <h3 id="subscription-fees-heading" tabIndex={-1}>
              Monthly fees
            </h3>
            <p id="subscription-fees-note">{SUBSCRIPTION_FEES_NOTE}</p>
          </div>
          {showCodex && (
            <NumericSetting
              label="Codex subscription (USD per month)"
              value={Number(settings.codexPlanUsdPerMonth) || 0}
              min={0}
              max={100_000}
              step={1}
              suffix="USD"
              onCommit={(value) => update({ codexPlanUsdPerMonth: value })}
            />
          )}
          {showClaude && (
            <NumericSetting
              label="Claude subscription (USD per month)"
              value={Number(settings.claudePlanUsdPerMonth) || 0}
              min={0}
              max={100_000}
              step={1}
              suffix="USD"
              onCommit={(value) => update({ claudePlanUsdPerMonth: value })}
            />
          )}
        </div>
      )}
      {showClaude && (
        <div
          id="claude-free-resets"
          className="setting-group"
          role="group"
          aria-labelledby="claude-free-resets-heading"
          aria-describedby="claude-free-resets-note"
        >
          <div className="setting-group-head">
            <h3 id="claude-free-resets-heading" tabIndex={-1}>
              Claude free resets
            </h3>
            <p id="claude-free-resets-note">{CLAUDE_FREE_RESETS_NOTE}</p>
          </div>
          <NumericSetting
            label="Free resets available"
            value={Number(settings.claudeFreeResets) || 0}
            min={0}
            max={10}
            step={1}
            onCommit={(value) =>
              update(
                value === 0 ? { claudeFreeResets: 0, claudeFreeResetsExpireOn: null } : { claudeFreeResets: value },
              )
            }
          />
          <FreeResetExpiry
            value={settings.claudeFreeResetsExpireOn ?? null}
            disabled={!(Number(settings.claudeFreeResets) > 0)}
            onCommit={(value) => update({ claudeFreeResetsExpireOn: value })}
          />
        </div>
      )}
      <SettingNote>
        Hiding a subscription keeps its saved history and cost totals. Background collection is unchanged.
      </SettingNote>
    </SettingsSection>
  );
}
