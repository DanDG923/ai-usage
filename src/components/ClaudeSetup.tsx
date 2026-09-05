import { useEffect, useRef, useState } from 'react';
import type { ClaudeSetupStatus } from '../types';

export function ClaudeSetup({
  requested,
  onClose,
  onRefresh,
}: {
  requested: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<ClaudeSetupStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Null until the user touches the checkbox: the default follows whether the
  // helper is already installed, so an upgrade never enables it unasked.
  const [helper, setHelper] = useState<boolean | null>(null);
  const helperChecked = helper ?? Boolean(status?.helperInstalled);
  const dialog = useRef<HTMLElement>(null);
  const visible = Boolean(window.aiUsage) && !(hidden && !requested) && Boolean(status || requested || error);
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      previous?.focus();
    };
  }, [visible]);
  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);
  useEffect(() => {
    let active = true;
    window.aiUsage
      ?.getClaudeSetup()
      .then((next) => {
        if (active) {
          setStatus(next);
          setHidden(next.dismissed && !requested);
        }
      })
      .catch(() => {
        if (active) setError('Setup could not be checked. Reopen setup to try again.');
      });
    return () => {
      active = false;
    };
  }, [requested]);
  if (!visible) return null;

  async function act(action: 'install' | 'login' | 'finish' | 'check' | 'skip') {
    if (!window.aiUsage) return;
    setError('');
    setBusy(action);
    try {
      const next = await window.aiUsage.configureClaude(action, helperChecked);
      setStatus(next);
      if (action === 'finish' || action === 'skip') {
        setHidden(true);
        onClose();
      }
      if (action === 'finish') await onRefresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Setup did not finish. Please try again.');
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="claude-setup-backdrop">
      <section
        ref={dialog}
        tabIndex={-1}
        className="panel claude-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-setup-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <span className="eyebrow">Welcome to AI Usage</span>
        <h2 id="claude-setup-title">Connect Claude on this computer</h2>
        <p>
          AI Usage reads local Claude Code activity and checks your subscription allowance. Your Claude desktop sign-in
          may be separate.
        </p>
        <ol className="claude-setup-steps">
          <li>
            <strong>1. Claude Code</strong>
            <span>
              {status?.installed
                ? 'Found on this computer'
                : 'Install the official Claude Code app for your Windows account.'}
            </span>
          </li>
          <li>
            <strong>2. Your Claude account</strong>
            <span>
              {status?.auth === 'signed-in'
                ? 'Signed in'
                : status?.auth === 'unavailable' && status?.installed
                  ? 'Unable to check sign-in. Retry the check.'
                  : 'Sign in securely in your browser with your Claude subscription.'}
            </span>
          </li>
          <li>
            <strong>3. Start collecting</strong>
            <span>
              Refresh your allowance and import any local Claude Code usage. New computers start without local usage
              history.
            </span>
          </li>
        </ol>
        {status?.auth === 'signed-in' && (
          <label className="claude-setup-helper">
            <input
              type="checkbox"
              checked={helperChecked}
              onChange={(event) => setHelper(event.target.checked)}
              disabled={Boolean(busy)}
            />
            <span>
              Enable the fallback allowance helper. Uncheck to disable it and restore your previous status line. Restart
              Claude Code after changing this setting.
            </span>
          </label>
        )}
        {!status?.installed && (
          <p className="claude-setup-note">
            Setup downloads Claude Code from Anthropic. Internet access is required. You do not need to install Node.js
            or npm.
          </p>
        )}
        {busy && (
          <p role="status" aria-live="polite">
            {busy === 'install'
              ? 'Installing Claude Code. This may take a few minutes…'
              : busy === 'login'
                ? 'Finish signing in in your browser, then return here…'
                : 'Checking setup…'}
          </p>
        )}
        {error && (
          <p role="alert" className="claude-setup-error">
            {error}
          </p>
        )}
        <div className="claude-setup-actions">
          {!busy && (
            <button className="secondary-button" onClick={() => void act('skip')}>
              Set up later
            </button>
          )}
          {busy && (
            <button className="secondary-button" onClick={() => void window.aiUsage?.cancelClaudeSetup()}>
              Cancel
            </button>
          )}
          <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void act('check')}>
            Check again
          </button>
          <button
            className="refresh-button"
            disabled={Boolean(busy) || !status}
            onClick={() => void act(!status?.installed ? 'install' : status.auth === 'signed-in' ? 'finish' : 'login')}
          >
            {!status?.installed
              ? 'Install Claude Code'
              : status.auth === 'signed-in'
                ? 'Start collecting'
                : 'Sign in to Claude'}
          </button>
        </div>
        <small>
          You can reopen this guide from Settings → Sources. Codex collection works independently when Codex is
          installed and signed in.
        </small>
      </section>
    </div>
  );
}
