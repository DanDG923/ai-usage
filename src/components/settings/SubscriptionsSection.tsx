import type { Settings, Snapshot } from '../../types';
import { SectionHeading, ToggleRow } from './fields';

export function SubscriptionsSection({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
}) {
  return (
    <section className="panel settings-section" aria-label="Subscriptions">
      <SectionHeading
        title="Subscriptions"
        description="Choose which subscriptions appear in your allowance views and alerts. You can show them again at any time."
      />
      <ToggleRow
        title="Show Codex"
        description="Codex allowances, forecasts, and reminders."
        checked={snapshot.settings.showCodexSubscription !== false}
        onChange={(checked) => void update({ showCodexSubscription: checked })}
      />
      <ToggleRow
        title="Show Claude"
        description="Claude allowances, including Fable 5, forecasts, and reminders."
        checked={snapshot.settings.showClaudeSubscription !== false}
        onChange={(checked) => void update({ showClaudeSubscription: checked })}
      />
      <p className="field-note">
        Hiding a subscription keeps its saved history and cost totals. Background collection is unchanged.
      </p>
    </section>
  );
}
