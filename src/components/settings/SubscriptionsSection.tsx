import type { Settings, Snapshot } from '../../types';
import { NumericSetting, SettingNote, SettingsSection, ToggleRow } from './fields';

export const SUBSCRIPTION_FEES_NOTE =
  'With a monthly fee set, the Overview compares the period’s API-equivalent value with the fees for the same number of days. Leave a fee at zero to hide the comparison. Fees are compared, never charged.';

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
      <SettingNote>
        Hiding a subscription keeps its saved history and cost totals. Background collection is unchanged.
      </SettingNote>
    </SettingsSection>
  );
}
