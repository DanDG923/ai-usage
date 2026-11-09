/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions -- The modal handles Escape and traps Tab to keep keyboard focus inside the dialog. */
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Hourglass, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import '../settings.css';
import type { ClaudeSetupStatus } from '../types';

type StepState = 'done' | 'warn' | 'todo';

const STEP_ICON = { done: CheckCircle2, warn: AlertTriangle, todo: CircleDashed } as const;
// Spoken after the step's own words, which already say what is done.
const STEP_WORD = { done: 'Done', warn: 'Needs attention', todo: 'Not done yet' } as const;

/**
 * One checklist step: a green check and its word when done, a caution when the
 * check could not answer, a dashed ring while pending. The step being worked
 * on carries the ink bar.
 */
function SetupStep({
  title,
  state,
  current,
  children,
}: {
  title: string;
  state: StepState;
  current: boolean;
  children: React.ReactNode;
}) {
  const Icon = STEP_ICON[state];
  return (
    <li className="setup-step" data-state={state} aria-current={current ? 'step' : undefined}>
      <Icon aria-hidden="true" />
      <div>
        <strong>
          {title}
          <span className="sr-only">, {STEP_WORD[state]}</span>
        </strong>
        <p>{children}</p>
      </div>
    </li>
  );
}

export function ClaudeSetup({ requested, onClose }: { requested: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<ClaudeSetupStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Null until the user touches the checkbox: the default follows whether the
  // helper is already installed, so an upgrade never enables it unasked.
  const [helper, setHelper] = useState<boolean | null>(null);
  // Each opening starts from the helper's current state: a choice or a status
  // kept from an earlier opening could reinstall or remove the helper after it
  // was changed in Settings. The primary action stays disabled until the fresh
  // status arrives.
  const [opened, setOpened] = useState(requested);
  if (requested !== opened) {
    setOpened(requested);
    if (requested) {
      setHelper(null);
      setStatus(null);
    }
  }
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
    const bridge = window.aiUsage;
    if (!bridge) return;
    let active = true;
    // The full status check spawns the Claude CLI. A window that is only
    // deciding whether to show the guide asks for the saved dismissal first,
    // and once the guide has been dismissed nothing is spawned at all.
    const skip = requested ? Promise.resolve(false) : bridge.isClaudeSetupDismissed();
    skip
      .then(async (dismissed) => {
        if (!active) return;
        if (dismissed) {
          setHidden(true);
          return;
        }
        const next = await bridge.getClaudeSetup();
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
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Setup did not finish. Please try again.');
    } finally {
      setBusy('');
    }
  }
  function cancel() {
    // The bridge rethrows a failed request; report it like the other setup steps.
    window.aiUsage?.cancelClaudeSetup().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : 'Setup could not be cancelled. Please try again.');
    });
  }
  const installed = Boolean(status?.installed);
  const signedIn = status?.auth === 'signed-in';
  const signInUnchecked = status?.auth === 'unavailable' && installed;
  // Until the status arrives no step is being worked on.
  const currentStep = !status ? 0 : !installed ? 1 : !signedIn ? 2 : 3;
  return (
    <div className="scrim">
      <section
        ref={dialog}
        tabIndex={-1}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-setup-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            if (busy) cancel();
            else void act('skip');
            return;
          }
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
        <header className="setup-head">
          <span className="setup-eyebrow">Welcome to AI Usage</span>
          <h2 id="claude-setup-title">Connect Claude on this computer</h2>
          <p>
            AI Usage reads local Claude Code activity and checks your subscription allowance. Your Claude desktop
            sign-in may be separate.
          </p>
        </header>
        <ol className="setup-steps">
          <SetupStep title="1. Claude Code" state={installed ? 'done' : 'todo'} current={currentStep === 1}>
            {installed ? 'Found on this computer' : 'Install the official Claude Code app for your Windows account.'}
          </SetupStep>
          <SetupStep
            title="2. Your Claude account"
            state={signedIn ? 'done' : signInUnchecked ? 'warn' : 'todo'}
            current={currentStep === 2}
          >
            {signedIn
              ? 'Signed in'
              : signInUnchecked
                ? 'Unable to check sign-in. Retry the check.'
                : 'Sign in securely in your browser with your Claude subscription.'}
          </SetupStep>
          <SetupStep title="3. Start collecting" state="todo" current={currentStep === 3}>
            Refresh your allowance and import any local Claude Code usage. New computers start without local usage
            history.
          </SetupStep>
        </ol>
        {signedIn && (
          <label className="setup-helper">
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
        {!installed && (
          <p className="setup-note">
            <Info aria-hidden="true" />
            <span>
              Setup downloads Claude Code from Anthropic. Internet access is required. You do not need to install
              Node.js or npm.
            </span>
          </p>
        )}
        {busy && (
          <p className="setup-busy" role="status" aria-live="polite">
            <Hourglass aria-hidden="true" />
            {busy === 'install'
              ? 'Installing Claude Code. This may take a few minutes…'
              : busy === 'login'
                ? 'Finish signing in in your browser, then return here…'
                : 'Checking setup…'}
          </p>
        )}
        {error && (
          <p role="alert" className="setup-error">
            <AlertOctagon aria-hidden="true" />
            {error}
          </p>
        )}
        <div className="setup-actions">
          {!busy && (
            <button type="button" className="btn" onClick={() => void act('skip')}>
              Set up later
            </button>
          )}
          {busy && (
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={Boolean(busy)}
            aria-busy={busy === 'check' || undefined}
            onClick={() => void act('check')}
          >
            Check again
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={Boolean(busy) || !status}
            aria-busy={(Boolean(busy) && busy !== 'check') || undefined}
            onClick={() => void act(!status?.installed ? 'install' : status.auth === 'signed-in' ? 'finish' : 'login')}
          >
            {!status?.installed
              ? 'Install Claude Code'
              : status.auth === 'signed-in'
                ? 'Start collecting'
                : 'Sign in to Claude'}
          </button>
        </div>
        <small className="setup-foot">
          You can reopen this guide from Settings → Sources. Codex collection works independently when Codex is
          installed and signed in.
        </small>
      </section>
    </div>
  );
}
