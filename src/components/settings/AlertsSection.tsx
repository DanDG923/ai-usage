import { shortDate } from '../../lib';
import type { Settings, Snapshot } from '../../types';
import { NumericSetting, SectionHeading, ToggleRow, hourOptions } from './fields';

export function AlertsSection({
  snapshot,
  update,
  onSnooze,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void>;
  onSnooze: (hours: number) => Promise<void>;
}) {
  const { settings } = snapshot;
  const snoozedUntil = settings.alertsSnoozedUntil ? Date.parse(settings.alertsSnoozedUntil) : Number.NaN;
  // Compared against the snapshot clock so the render stays pure; the main
  // process refreshes the snapshot when a snooze starts or ends.
  const snoozed = Number.isFinite(snoozedUntil) && snoozedUntil > Date.parse(snapshot.generatedAt);
  return (
    <section id="alerts" className="panel settings-section">
      <SectionHeading
        title="Alerts"
        description="Desktop notifications from the tray process. They fire after a collection, so they are only as current as the collection interval."
      />
      <div className="settings-fields alert-fields">
        <NumericSetting
          label="Risk above safe pace"
          value={settings.paceRiskThreshold}
          min={0.1}
          max={20}
          step={0.1}
          suffix="× safe pace"
          onCommit={(value) => update({ paceRiskThreshold: value })}
        />
        <NumericSetting
          label="Usage watch threshold"
          value={settings.hardLimitThreshold}
          min={0}
          max={100}
          step={1}
          suffix="% used"
          onCommit={(value) => update({ hardLimitThreshold: value })}
        />
      </div>
      <ToggleRow
        title="Pace notifications"
        description="When learned use is projected to reach the cap before reset. One notification per episode, with the earliest run-out time."
        checked={settings.notifyDesktop}
        onChange={(checked) => update({ notifyDesktop: checked })}
      />
      <ToggleRow
        title="Reset notifications"
        description="When a weekly or five-hour window rolls over and the full allowance is available again."
        checked={settings.notifyResets}
        onChange={(checked) => update({ notifyResets: checked })}
      />
      <ToggleRow
        title="Fallback notifications"
        description="When a collector that was healthy starts serving cached readings, so a stale dashboard is never a surprise."
        checked={settings.notifyFallback}
        onChange={(checked) => update({ notifyFallback: checked })}
      />
      <ToggleRow
        title="Daily digest"
        description="One summary a day with every allowance and the earliest run-out."
        checked={settings.notifyDigest}
        onChange={(checked) => update({ notifyDigest: checked })}
      />
      <div className="settings-fields digest-fields">
        <label>
          <span>Digest time</span>
          <select
            value={settings.digestHour}
            disabled={!settings.notifyDigest}
            onChange={(event) => update({ digestHour: Number(event.target.value) })}
          >
            {hourOptions(0, 23)}
          </select>
        </label>
      </div>
      <div className="snooze-row">
        <span>
          <strong>
            {snoozed ? `Alerts snoozed until ${shortDate(settings.alertsSnoozedUntil)}` : 'Snooze alerts'}
          </strong>
          <small>
            {snoozed
              ? 'Nothing fires until then; the next collection judges afresh.'
              : 'Pause every notification for a while without changing the settings above.'}
          </small>
        </span>
        <div className="action-row compact">
          {snoozed ? (
            <button className="secondary-button" onClick={() => onSnooze(0)}>
              Resume alerts
            </button>
          ) : (
            [1, 6, 24].map((hours) => (
              <button key={hours} className="secondary-button" onClick={() => onSnooze(hours)}>
                {hours}h
              </button>
            ))
          )}
        </div>
      </div>
      <ToggleRow
        title="Launch with Windows"
        description="Keep the tray indicator ready for quick checks."
        checked={settings.launchAtLogin}
        onChange={(checked) => update({ launchAtLogin: checked })}
      />
    </section>
  );
}
