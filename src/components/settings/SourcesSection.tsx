import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, type LucideIcon } from 'lucide-react';
import { HEALTHY_SOURCE_STATUSES, shortDate } from '../../lib';
import type { Settings, Snapshot } from '../../types';
import { SelectSetting, SettingBlock, SettingColumns, SettingRow, SettingsSection } from './fields';

export function sourceMark(id: string) {
  return id === 'codex' ? 'Cx' : id === 'claude-fable' ? 'F5' : 'Cl';
}

// Statuses every consumer treats as stale data (see electron/store.cjs
// setSourceStatus); a failing collector is the critical one.
const STALE_STATUSES = new Set(['stale', 'degraded']);

export type SourceTone = 'ok' | 'caution' | 'warning' | 'unknown';

/** A collector status as a tone and its icon: connected, serving stale data, failing, or not reported yet. */
export function sourceTone(status: string): { tone: SourceTone; Icon: LucideIcon } {
  if (HEALTHY_SOURCE_STATUSES.has(status)) return { tone: 'ok', Icon: CheckCircle2 };
  if (status === 'error') return { tone: 'warning', Icon: AlertOctagon };
  if (STALE_STATUSES.has(status)) return { tone: 'caution', Icon: AlertTriangle };
  return { tone: 'unknown', Icon: CircleDashed };
}

/** The status word and its icon, in the status colour. */
export function SourceStatus({ status }: { status: string }) {
  const { tone, Icon } = sourceTone(status);
  return (
    <span className="source-status" data-tone={tone}>
      <Icon aria-hidden="true" />
      {status.replaceAll('-', ' ')}
    </span>
  );
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
        {snapshot.sources.map((source) => {
          const { tone } = sourceTone(source.status);
          return (
            <article className="source-card" data-tone={tone} key={source.id}>
              <header>
                <span className={`source-mark ${source.id}`} aria-hidden="true">
                  {sourceMark(source.id)}
                </span>
                <strong>{source.name}</strong>
                <SourceStatus status={source.status} />
              </header>
              <p>{source.status_detail || 'Waiting for a refresh.'}</p>
              <dl className="source-times fact-list">
                <div>
                  <dt>Evidence</dt>
                  <dd>{shortDate(source.last_observation_at)}</dd>
                </div>
                <div>
                  <dt>Scan</dt>
                  <dd>{shortDate(source.last_attempt_at)}</dd>
                </div>
                {['error', 'stale', 'degraded'].includes(source.status) && (
                  <div className="source-last-good">
                    <dt>Last good</dt>
                    <dd>{shortDate(source.last_success_at)}</dd>
                  </div>
                )}
              </dl>
              {source.id === 'claude' &&
                (source.metadata?.helperInstalled ? (
                  <button type="button" className="btn" onClick={onUninstallClaude}>
                    Disable helper
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={onInstallClaude}>
                    Enable fallback helper
                  </button>
                ))}
            </article>
          );
        })}
      </SettingBlock>
      <SettingColumns>
        <div className="setting-col">
          <SettingRow
            label="Claude Code setup"
            description="Install Claude Code and sign in so Claude allowances can be read. You can reopen this guide at any time."
          >
            <button type="button" className="btn" onClick={onSetupClaude}>
              Set up Claude
            </button>
          </SettingRow>
        </div>
        <div className="setting-col">
          <SelectSetting
            label="Collect automatically"
            description="Alerts, scheduled backups, and the forecast are only as current as the last collection. While this is on, the app also collects when the window is reopened and when Windows wakes. Collection runs in a separate process, so a slow scan never freezes the dashboard. Claude plan usage is read through Claude Code only when you press Refresh; local activity and the optional status-line helper are collected automatically."
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
        </div>
      </SettingColumns>
    </SettingsSection>
  );
}
