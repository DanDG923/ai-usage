import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Hourglass,
  Info,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shortDate } from '../../lib';
import type { RenderingMode, Settings, Snapshot, Theme, UpdateStatus } from '../../types';
import { SelectSetting, SettingColumns, SettingsSection, ToggleRow } from './fields';

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

type UpdateTone = 'idle' | 'info' | 'busy' | 'ok' | 'caution' | 'warning';

/**
 * Where the update is, as an icon and a tone for the version box: idle and
 * busy stay grey, a waiting update is ink, ready and up to date are on track,
 * a sign-in problem is a caution and a failure is a warning.
 */
function updateMark(status: UpdateStatus | null, preview: boolean): { tone: UpdateTone; Icon: LucideIcon } {
  if (preview) return { tone: 'idle', Icon: Info };
  switch (status?.status) {
    case 'auth-required':
      return { tone: 'caution', Icon: AlertTriangle };
    case 'checking':
    case 'downloading':
      return { tone: 'busy', Icon: RefreshCw };
    case 'available':
      return { tone: 'info', Icon: Info };
    case 'downloaded':
      return status.error ? { tone: 'warning', Icon: AlertOctagon } : { tone: 'ok', Icon: CheckCircle2 };
    case 'installing':
      return { tone: 'busy', Icon: Hourglass };
    case 'up-to-date':
      return { tone: 'ok', Icon: CheckCircle2 };
    case 'error':
      return { tone: 'warning', Icon: AlertOctagon };
    default:
      return { tone: 'idle', Icon: Info };
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
  const [renderingMode, setRenderingMode] = useState<RenderingMode | null>(null);
  const [restarting, setRestarting] = useState(false);
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
      ?.getRenderingMode?.()
      .then((value) => {
        if (!cancelled) setRenderingMode(value);
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
  const requestedRendering = snapshot.settings.softwareRendering ? 'software' : 'hardware';
  const renderingForced = Boolean(renderingMode?.forced);
  const restartNeeded = Boolean(renderingMode && !renderingForced && renderingMode.active !== requestedRendering);
  const restart = async () => {
    const bridge = window.aiUsage;
    if (preview || !bridge?.relaunch || restarting) return;
    setRestarting(true);
    try {
      await bridge.relaunch();
    } catch {
      setRestarting(false);
    }
  };
  const progress =
    typeof status?.progress === 'number' && Number.isFinite(status.progress)
      ? Math.min(100, Math.max(0, status.progress))
      : undefined;

  const { tone: updateTone, Icon: UpdateIcon } = updateMark(status, preview);

  return (
    <SettingsSection
      id="appearance"
      title="Appearance & updates"
      description="Match Windows or choose a fixed theme, and control application updates."
    >
      <SettingColumns>
        <div className="setting-col">
          <SelectSetting
            label="Theme"
            description="Follow the Windows light or dark mode, or keep one theme."
            value={snapshot.settings.theme}
            onChange={(value) => void update({ theme: value as Theme })}
          >
            <option value="system">Follow Windows</option>
            <option value="dark">Dark</option>
            <option value="light">Daylight</option>
          </SelectSetting>
          <ToggleRow
            title="Lower memory use"
            description="Draws the dashboard with the processor instead of the graphics card. This keeps roughly 150 MB less in memory while AI Usage waits in the tray, at the cost of slightly smoother scrolling. Applies the next time AI Usage starts."
            checked={snapshot.settings.softwareRendering}
            onChange={(checked) => update({ softwareRendering: checked })}
          />
          {renderingForced && !snapshot.settings.softwareRendering ? (
            <div className="update-notice">
              <Info aria-hidden="true" />
              <span className="update-notice-text" role="status">
                <strong>Software rendering is forced on this PC</strong>
                <small>
                  The <code>AI_USAGE_DISABLE_GPU</code> environment variable keeps AI Usage drawing with the processor
                  on every start. Remove it to let this setting take effect.
                </small>
              </span>
            </div>
          ) : null}
          {restartNeeded ? (
            <div className="update-notice">
              <RefreshCw aria-hidden="true" />
              <span className="update-notice-text" role="status">
                <strong>Restart to apply the rendering change</strong>
                <small>
                  AI Usage keeps using the {renderingMode?.active === 'software' ? 'processor' : 'graphics card'} until
                  it restarts. Your history and settings are kept.
                </small>
              </span>
              <button
                type="button"
                className="btn"
                disabled={preview || restarting}
                aria-busy={restarting || undefined}
                onClick={() => void restart()}
              >
                {restarting ? 'Restarting…' : 'Restart AI Usage'}
              </button>
            </div>
          ) : null}
          <ToggleRow
            title="Check for updates automatically"
            description="Checks private GitHub releases shortly after launch and every few hours. Your usage history stays on this PC."
            checked={snapshot.settings.autoUpdate}
            onChange={(checked) => update({ autoUpdate: checked })}
          />
        </div>
        <div className="setting-col">
          <div className="update-summary" data-tone={updateTone}>
            <span className="update-status" role="status">
              <small className="update-version">Version {version || (preview ? 'preview' : '…')}</small>
              <strong className="update-label">
                <UpdateIcon aria-hidden="true" />
                {updateLabel(status)}
              </strong>
              <small className="update-description">{updateDescription(status, preview)}</small>
            </span>
            {downloading ? (
              <div className="update-progress">
                <progress aria-label="Update download progress" max={100} value={progress} />
                <span>{progress === undefined ? 'Starting download…' : `${Math.round(progress)}% downloaded`}</span>
              </div>
            ) : null}
            {status?.releaseNotes ? (
              <details className="update-release-notes">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  What’s new{status.version ? ` in version ${status.version}` : ''}
                </summary>
                <pre>{status.releaseNotes}</pre>
              </details>
            ) : null}
            <div className="action-row compact update-actions">
              <button
                type="button"
                className="btn"
                disabled={busy || downloaded || status?.status === 'unavailable' || preview}
                aria-busy={checking || undefined}
                onClick={() => void runAction('check')}
              >
                {checking
                  ? 'Checking…'
                  : status?.status === 'error' || status?.status === 'auth-required'
                    ? 'Check again'
                    : 'Check now'}
              </button>
              {status?.status === 'available' || downloading ? (
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={busy || preview}
                  aria-busy={downloading || undefined}
                  onClick={() => void runAction('download')}
                >
                  {downloading ? 'Downloading…' : 'Download update'}
                </button>
              ) : downloaded || installing ? (
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={busy || preview}
                  aria-busy={installing || undefined}
                  onClick={() => void runAction('install')}
                >
                  {installing ? 'Restarting…' : 'Restart and update'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </SettingColumns>
    </SettingsSection>
  );
}
