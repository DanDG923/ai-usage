import { Download, Palette } from 'lucide-react';
import { useEffect, useState } from 'react';
import { shortDate } from '../../lib';
import type { Settings, Snapshot, Theme, UpdateStatus } from '../../types';
import { SectionHeading, ToggleRow } from './fields';

function updateLabel(status: UpdateStatus | null, version: string) {
  if (!status) return `Version ${version}`;
  switch (status.status) {
    case 'unavailable':
      return `Version ${version} · update checks are off in this build (no release feed configured)`;
    case 'checking':
      return `Version ${version} · checking…`;
    case 'available':
      return `Version ${version} · ${status.version ? `version ${status.version} is available` : 'an update is available'}`;
    case 'up-to-date':
      return `Version ${version} · up to date${status.checkedAt ? ` (checked ${shortDate(status.checkedAt)})` : ''}`;
    case 'error':
      return `Version ${version} · last check failed: ${status.error || 'unknown error'}`;
    default:
      return `Version ${version}`;
  }
}

export function AppearanceSection({
  snapshot,
  update,
  onCheckUpdates,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void>;
  onCheckUpdates: () => Promise<UpdateStatus | null>;
}) {
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.aiUsage
      ?.getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {});
    void window.aiUsage
      ?.getUpdateStatus?.()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const check = async () => {
    setChecking(true);
    try {
      const result = await onCheckUpdates();
      if (result) setStatus(result);
    } finally {
      setChecking(false);
    }
  };
  return (
    <section id="appearance" className="panel settings-section">
      <SectionHeading eyebrow="Appearance & updates" title="Theme and updates" icon={Palette} />
      <div className="settings-fields">
        <label>
          <span>Theme</span>
          <select value={snapshot.settings.theme} onChange={(event) => update({ theme: event.target.value as Theme })}>
            <option value="system">Follow Windows</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
      </div>
      <ToggleRow
        title="Check for updates automatically"
        description="Fetches a version manifest from the release feed shortly after launch and every few hours. No usage data is sent."
        checked={snapshot.settings.autoUpdate}
        onChange={(checked) => update({ autoUpdate: checked })}
      />
      <div className="snooze-row">
        <Download aria-hidden="true" />
        <span>
          <strong>{updateLabel(status, version || snapshot.isPreview ? version || 'preview' : version)}</strong>
          <small>Updates install through the standard setup program and keep the local database.</small>
        </span>
        <div className="action-row compact">
          <button
            className="secondary-button"
            disabled={checking || status?.status === 'unavailable' || Boolean(snapshot.isPreview)}
            onClick={() => {
              void check();
            }}
          >
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
    </section>
  );
}
