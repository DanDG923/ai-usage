import { useEffect, useRef, useState } from 'react';
import { shortDate } from '../../lib';
import type { Settings, Snapshot, Theme, UpdateStatus } from '../../types';
import { SectionHeading, ToggleRow } from './fields';
import './updates.css';

function updateLabel(status: UpdateStatus | null) {
  switch (status?.status) {
    case 'unavailable':
      return 'Updates are unavailable in this build';
    case 'auth-required':
      return 'GitHub sign-in needed';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return status.version ? `Version ${status.version} is available` : 'An update is available';
    case 'downloading':
      return 'Downloading update…';
    case 'downloaded':
      return status.version ? `Version ${status.version} is ready to install` : 'Update is ready to install';
    case 'installing':
      return 'Preparing to restart and update…';
    case 'up-to-date':
      return `Up to date${status.checkedAt ? ` · checked ${shortDate(status.checkedAt)}` : ''}`;
    case 'error':
      return 'The update could not finish';
    default:
      return 'Private updates from GitHub';
  }
}

function updateDescription(status: UpdateStatus | null, preview: boolean) {
  if (preview) return 'Update controls are available in the installed Windows app.';
  switch (status?.status) {
    case 'unavailable':
      return status.reason || 'Install the Windows setup version to receive updates here.';
    case 'auth-required':
      return 'GitHub sign-in is unavailable. Sign in with GitHub CLI using an account that can read the private repository, then check again.';
    case 'error':
      return `${status.error || 'Please check your connection.'} Check again to retry.`;
    case 'downloading':
      return 'You can keep using AI Usage while the update downloads.';
    case 'downloaded':
      return status.error
        ? `${status.error} The downloaded update is kept. Choose Restart and update to try again.`
        : 'Restart when you are ready. A safety backup is created first, and your history and settings are kept.';
    case 'installing':
      return 'Saving a safety backup before restarting. AI Usage will reopen after the update.';
    default:
      return status?.auth === 'github-cli'
        ? 'Connected through your GitHub sign-in. Downloads stay private; you choose when to download and restart.'
        : 'Uses your local GitHub sign-in to access private releases. You choose when to download and restart.';
  }
}

export function AppearanceSection({
  snapshot,
  update,
  onCheckUpdates,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
  onCheckUpdates: () => Promise<UpdateStatus | null>;
}) {
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [pending, setPending] = useState<'check' | 'download' | 'install' | null>(null);
  const statusRevision = useRef(0);
  const mounted = useRef(false);
  const actionPending = useRef(false);
  const preview = Boolean(snapshot.isPreview);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const bridge = preview ? undefined : window.aiUsage;
    const unsubscribe = bridge?.onUpdateStatus?.((value) => {
      statusRevision.current += 1;
      setStatus(value);
    });
    const initialRevision = statusRevision.current;
    void bridge
      ?.getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {});
    void bridge
      ?.getUpdateStatus()
      .then((value) => {
        // A delayed initial read must not replace an update event or a user action.
        if (!cancelled && statusRevision.current === initialRevision) setStatus(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      mounted.current = false;
      statusRevision.current += 1;
      unsubscribe?.();
    };
  }, [preview]);

  const runAction = async (action: 'check' | 'download' | 'install') => {
    const bridge = window.aiUsage;
    if (preview || !bridge || actionPending.current) return;
    actionPending.current = true;
    const revision = ++statusRevision.current;
    setPending(action);
    try {
      const result = await (action === 'check'
        ? onCheckUpdates()
        : action === 'download'
          ? bridge.downloadUpdate()
          : bridge.installUpdate());
      if (mounted.current && statusRevision.current === revision) {
        setStatus(result || { status: 'error', available: false, error: 'The update check failed.' });
      }
    } catch {
      if (mounted.current && statusRevision.current === revision) {
        setStatus({ status: 'error', available: false, error: 'The update request failed.' });
      }
    } finally {
      actionPending.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const downloading = status?.status === 'downloading' || pending === 'download';
  const installing = status?.status === 'installing' || pending === 'install';
  const checking = status?.status === 'checking' || pending === 'check';
  const busy = Boolean(pending) || downloading || installing || checking;
  const downloaded = status?.status === 'downloaded';
  const progress =
    typeof status?.progress === 'number' && Number.isFinite(status.progress)
      ? Math.min(100, Math.max(0, status.progress))
      : undefined;

  return (
    <section id="appearance" className="panel settings-section">
      <SectionHeading title="Appearance & updates" />
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
        description="Checks private GitHub releases shortly after launch and every few hours. Your usage history stays on this PC."
        checked={snapshot.settings.autoUpdate}
        onChange={(checked) => update({ autoUpdate: checked })}
      />
      <div className="snooze-row update-summary">
        <span role="status">
          <small>Version {version || (preview ? 'preview' : '…')}</small>
          <strong>{updateLabel(status)}</strong>
          <small>{updateDescription(status, preview)}</small>
        </span>
        <div className="action-row compact">
          <button
            className="secondary-button"
            disabled={busy || downloaded || status?.status === 'unavailable' || preview}
            onClick={() => void runAction('check')}
          >
            {checking
              ? 'Checking…'
              : status?.status === 'error' || status?.status === 'auth-required'
                ? 'Check again'
                : 'Check now'}
          </button>
          {status?.status === 'available' || downloading ? (
            <button className="primary-button" disabled={busy || preview} onClick={() => void runAction('download')}>
              {downloading ? 'Downloading…' : 'Download update'}
            </button>
          ) : downloaded || installing ? (
            <button className="primary-button" disabled={busy || preview} onClick={() => void runAction('install')}>
              {installing ? 'Restarting…' : 'Restart and update'}
            </button>
          ) : null}
        </div>
      </div>
      {downloading ? (
        <div className="update-progress">
          <progress aria-label="Update download progress" max={100} value={progress} />
          <span>{progress === undefined ? 'Starting download…' : `${Math.round(progress)}% downloaded`}</span>
        </div>
      ) : null}
      {status?.releaseNotes ? (
        <details className="update-release-notes">
          <summary>What’s new{status.version ? ` in version ${status.version}` : ''}</summary>
          <pre>{status.releaseNotes}</pre>
        </details>
      ) : null}
    </section>
  );
}
