import { shortDate } from '../../lib';
import type { Settings, Snapshot } from '../../types';
import { SelectSetting, SettingBlock, SettingRow, SettingsSection } from './fields';

export function sourceMark(id: string) {
  return id === 'codex' ? 'Cx' : id === 'claude-fable' ? 'F5' : 'Cl';
}

export function SourcesSection({
  snapshot,
  update,
  onInstallClaude,
  onUninstallClaude,
  onSetupClaude,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
  onInstallClaude: () => Promise<void>;
  onUninstallClaude: () => Promise<void>;
  onSetupClaude: () => void;
}) {
  return (
    <SettingsSection
      id="sources"
      title="Sources"
      description="Local activity files and official provider allowance checks. Setup can install Claude Code and help you sign in."
    >
      <SettingBlock className="source-list">
        {snapshot.sources.map((source) => (
          <div className="source-row" key={source.id}>
            <span className={`source-mark ${source.id}`} aria-hidden="true">
              {sourceMark(source.id)}
            </span>
            <div>
              <strong>{source.name}</strong>
              <span>{source.status_detail || 'Waiting for a refresh.'}</span>
            </div>
            <div className="source-times">
              <span className={`connection ${source.status}`}>{source.status.replaceAll('-', ' ')}</span>
              <small>Evidence · {shortDate(source.last_observation_at)}</small>
              <small>Scan · {shortDate(source.last_attempt_at)}</small>
              {['error', 'stale', 'degraded'].includes(source.status) && (
                <small>Last good · {shortDate(source.last_success_at)}</small>
              )}
            </div>
            {source.id === 'claude' &&
              (source.metadata?.helperInstalled ? (
                <button className="secondary-button" onClick={onUninstallClaude}>
                  Disable helper
                </button>
              ) : (
                <button className="secondary-button" onClick={onInstallClaude}>
                  Enable fallback helper
                </button>
              ))}
          </div>
        ))}
      </SettingBlock>
      <SettingRow
        label="Claude Code setup"
        description="Install Claude Code and sign in so Claude allowances can be read. You can reopen this guide at any time."
      >
        <div className="action-row compact">
          <button className="secondary-button" onClick={onSetupClaude}>
            Set up Claude
          </button>
        </div>
      </SettingRow>
      <SelectSetting
        label="Collect automatically"
        description="Alerts, scheduled backups, and the forecast are only as current as the last collection. While this is on, the app also collects when the window is reopened and when Windows wakes. Collection runs in a separate process, so a slow scan never freezes the dashboard."
        value={snapshot.settings.refreshIntervalMinutes}
        onChange={(value) => void update({ refreshIntervalMinutes: Number(value) })}
      >
        <option value={0}>Only when I refresh</option>
        <option value={5}>Every 5 minutes</option>
        <option value={10}>Every 10 minutes</option>
        <option value={15}>Every 15 minutes</option>
        <option value={30}>Every 30 minutes</option>
        <option value={60}>Every hour</option>
        <option value={240}>Every 4 hours</option>
      </SelectSetting>
    </SettingsSection>
  );
}
