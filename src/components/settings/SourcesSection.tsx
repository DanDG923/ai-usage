import { Clock3, PlugZap } from 'lucide-react';
import { shortDate } from '../../lib';
import type { Settings, Snapshot } from '../../types';
import { SectionHeading } from './fields';

export function SourcesSection({
  snapshot,
  update,
  onInstallClaude,
  onUninstallClaude,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void>;
  onInstallClaude: () => Promise<void>;
  onUninstallClaude: () => Promise<void>;
}) {
  return (
    <section id="sources" className="panel settings-section">
      <SectionHeading
        eyebrow="Collectors"
        title="Local data sources"
        description="The app reads files and official local usage surfaces already on this PC."
        icon={PlugZap}
      />
      <div className="source-list">
        {snapshot.sources.map((source) => (
          <div className="source-row" key={source.id}>
            <span className={`source-mark ${source.id}`}>{source.name.slice(0, 1)}</span>
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
      </div>
      <div className="settings-fields">
        <label>
          <span>Collect automatically</span>
          <select
            value={snapshot.settings.refreshIntervalMinutes}
            onChange={(event) => update({ refreshIntervalMinutes: Number(event.target.value) })}
          >
            <option value={0}>Only when I refresh</option>
            <option value={5}>Every 5 minutes</option>
            <option value={10}>Every 10 minutes</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={240}>Every 4 hours</option>
          </select>
        </label>
      </div>
      <div className="learning-note">
        <Clock3 aria-hidden="true" />
        <span>
          <strong>Background collection</strong>
          Alerts, scheduled backups, and the forecast are only as current as the last collection. While this is on, the
          app also collects when the window is reopened and when Windows wakes. Collection runs in a separate process,
          so a slow scan never freezes the dashboard.
        </span>
      </div>
    </section>
  );
}
