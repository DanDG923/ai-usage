import { CircleCheck, Eye, Hourglass, OctagonAlert, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

const NOTICE_LIFETIME_MS = 12_000;

/** Failures stay on screen until dismissed; confirmations clear themselves. */
function noticeIsSticky(notice: string) {
  return notice.startsWith('Refresh completed with') || /failed|could not/i.test(notice);
}

/**
 * How a notice is drawn. The words carry the meaning; the edge colour and the
 * icon repeat it: a failure is the warning red and stays, a refresh that fell
 * back to cached data is caution amber, the update-busy notice is neutral, and
 * every other confirmation is an ok check.
 */
function noticeLook(notice: string, failure: boolean) {
  if (failure) return { tone: 'warning', Icon: OctagonAlert };
  if (/fallback data/i.test(notice)) return { tone: 'caution', Icon: Eye };
  if (/finishing an update/i.test(notice)) return { tone: 'busy', Icon: Hourglass };
  return { tone: 'ok', Icon: CircleCheck };
}

/**
 * The notice text lives here rather than in App state: every handler in App
 * publishes to it, but only the toast needs to render when it changes. When
 * it was App state, each message and its twelve-second auto-clear re-rendered
 * whichever page was mounted, Settings and its price table included.
 */
export type NoticeChannel = {
  /** Publish a message; an empty string dismisses the current one. */
  show: (text: string) => void;
  fail: (text: string) => void;
  isFailure: () => boolean;
  current: () => string;
  subscribe: (listener: () => void) => () => void;
};

export function createNoticeChannel(): NoticeChannel {
  let notice = '';
  let failure = false;
  const listeners = new Set<() => void>();
  return {
    show(text) {
      const nextFailure = noticeIsSticky(text);
      if (text === notice && nextFailure === failure) return;
      failure = nextFailure;
      notice = text;
      for (const listener of listeners) listener();
    },
    fail(text) {
      failure = true;
      notice = text;
      for (const listener of listeners) listener();
    },
    isFailure: () => failure,
    current: () => notice,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function NoticeToast({ channel }: { channel: NoticeChannel }) {
  const notice = useSyncExternalStore(channel.subscribe, channel.current);

  const failure = useSyncExternalStore(channel.subscribe, channel.isFailure);

  // Informational notices clear themselves; the timer restarts whenever the
  // text changes so a newer message gets its full lifetime.
  useEffect(() => {
    if (!notice || failure) return;
    const timer = window.setTimeout(() => channel.show(''), NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice, failure, channel]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {!failure ? notice : ''}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {failure ? notice : ''}
      </div>
      {notice && <Toast notice={notice} failure={failure} onDismiss={() => channel.show('')} />}
    </>
  );
}

/** The visible toast; the live regions above announce it, so it has no role of its own. */
function Toast({ notice, failure, onDismiss }: { notice: string; failure: boolean; onDismiss: () => void }) {
  const { tone, Icon } = noticeLook(notice, failure);
  return (
    <div className={`toast ${tone}`}>
      <span className="toast-icon">
        <Icon aria-hidden="true" />
      </span>
      <span className="toast-text">{notice}</span>
      <button type="button" className="ibtn" aria-label="Dismiss message" title="Dismiss (Esc)" onClick={onDismiss}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
