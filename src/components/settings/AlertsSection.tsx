import { Bell, BellOff } from 'lucide-react';
import { useDashboardActions } from '../../app/dashboard';
import { shortDate } from '../../lib';
import type { Settings, Snapshot } from '../../types';
import {
  NumericSetting,
  SelectSetting,
  SettingColumns,
  SettingRow,
  SettingsSection,
  ToggleRow,
  hourOptions,
} from './fields';

export function AlertsSection({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
}) {
  const { snooze } = useDashboardActions();
  const { settings } = snapshot;
  const snoozedUntil = settings.alertsSnoozedUntil ? Date.parse(settings.alertsSnoozedUntil) : Number.NaN;
  // Compared against the snapshot clock so the render stays pure; the main
  // process refreshes the snapshot when a snooze starts or ends.
  const snoozed = Number.isFinite(snoozedUntil) && snoozedUntil > Date.parse(snapshot.generatedAt);
  return (
    <SettingsSection
      id="alerts"
      title="Alerts"
      description="Choose which changes are important enough to surface from the tray."
    >
      <SettingColumns>
        <div className="setting-col">
          <NumericSetting
            label="Risk above safe pace"
            description="An allowance is at risk when recent use runs faster than this multiple of its safe pace."
            value={settings.paceRiskThreshold}
            min={0.1}
            max={20}
            step={0.1}
            suffix="× safe pace"
            onCommit={(value) => update({ paceRiskThreshold: value })}
          />
          <NumericSetting
            label="Usage watch threshold"
            description="An allowance is worth watching when a forecast expects more than this share of it to be used by the reset."
            value={settings.hardLimitThreshold}
            min={0}
            max={100}
            step={1}
            suffix="% used"
            onCommit={(value) => update({ hardLimitThreshold: value })}
          />
          <ToggleRow
            title="Risk notifications"
            description="Expected exhaustion, heavier-case risk, or sustained use above your configured safe pace."
            checked={settings.notifyDesktop}
            onChange={(checked) => update({ notifyDesktop: checked })}
          />
          <ToggleRow
            title="Reset notifications"
            description="When a weekly or five-hour window rolls over and the full allowance is available again."
            checked={settings.notifyResets}
            onChange={(checked) => update({ notifyResets: checked })}
          />
        </div>
        <div className="setting-col">
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
          <SelectSetting
            label="Digest time"
            description={
              settings.notifyDigest
                ? 'When the daily digest arrives.'
                : 'Turn on the daily digest to choose when it arrives.'
            }
            value={settings.digestHour}
            disabled={!settings.notifyDigest}
            onChange={(value) => void update({ digestHour: Number(value) })}
          >
            {hourOptions(0, 23)}
          </SelectSetting>
          <ToggleRow
            title="Launch with Windows"
            description="Keep the tray indicator ready for quick checks."
            checked={settings.launchAtLogin}
            onChange={(checked) => update({ launchAtLogin: checked })}
          />
          <SettingRow
            className={snoozed ? 'snooze-setting is-snoozed' : 'snooze-setting'}
            label={
              snoozed ? (
                <>
                  <BellOff aria-hidden="true" />
                  Alerts snoozed until <span className="setting-when">{shortDate(settings.alertsSnoozedUntil)}</span>
                </>
              ) : (
                'Snooze alerts'
              )
            }
            description={
              snoozed
                ? 'Nothing fires until then; the next collection judges afresh.'
                : 'Pause every notification for a while without changing the settings above.'
            }
          >
            <div className="action-row compact">
              {snoozed ? (
                <button type="button" className="btn" onClick={() => snooze(0)}>
                  <Bell aria-hidden="true" />
                  Resume alerts
                </button>
              ) : (
                [1, 6, 24].map((hours) => (
                  <button
                    key={hours}
                    type="button"
                    className="btn"
                    aria-label={`Snooze alerts for ${hours} hour${hours === 1 ? '' : 's'}`}
                    onClick={() => snooze(hours)}
                  >
                    {hours}h
                  </button>
                ))
              )}
            </div>
          </SettingRow>
        </div>
      </SettingColumns>
    </SettingsSection>
  );
}
