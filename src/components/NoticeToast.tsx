import { CircleCheck, Eye, Hourglass, type LucideIcon, OctagonAlert, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

const NOTICE_LIFETIME_MS = 12_000;

/**
 * How a notice is drawn. The words carry the meaning; the edge colour and the
 * icon repeat it: a failure is the warning red and stays, a refresh that fell
 * back to cached data is caution amber, the update-busy notice is neutral, and
 * every other confirmation is an ok check.
 */
export type NoticeTone = 'ok' | 'caution' | 'busy' | 'warning';

/**
 * A message and how it is drawn. The publisher states the tone: it is never
 * read back out of the wording, where a success that mentions something that
 * "could not" be done would be taken for a failure.
 */
export type Notice = { text: string; tone: NoticeTone };

const TONE_ICON: Record<NoticeTone, LucideIcon> = {
  ok: CircleCheck,
  caution: Eye,
  busy: Hourglass,
  warning: OctagonAlert,
};

/** Failures stay on screen until dismissed; every other notice clears itself. */
export function noticeIsSticky(notice: Notice) {
  return notice.tone === 'warning';
}

/**
 * The notice lives here rather than in App state: every handler in App
 * publishes to it, but only the toast needs to render when it changes. When
 * it was App state, each message and its twelve-second auto-clear re-rendered
 * whichever page was mounted, Settings and its price table included.
 */
export type NoticeChannel = {
  /** Publish a message with its tone. */
  show: (notice: Notice) => void;
  /** Publish a failure: the warning tone, kept until dismissed. */
  fail: (text: string) => void;
  dismiss: () => void;
  current: () => Notice | null;
  subscribe: (listener: () => void) => () => void;
};

export function createNoticeChannel(): NoticeChannel {
  let notice: Notice | null = null;
  const listeners = new Set<() => void>();
  // The same message published again keeps the notice already shown, so its
  // remaining lifetime is not restarted.
  const publish = (next: Notice | null) => {
    if (next?.text === notice?.text && next?.tone === notice?.tone) return;
    notice = next;
    for (const listener of listeners) listener();
  };
  return {
    show: ({ text, tone }) => publish(text ? { text, tone } : null),
    fail: (text) => publish(text ? { text, tone: 'warning' } : null),
    dismiss: () => publish(null),
    current: () => notice,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function NoticeToast({ channel }: { channel: NoticeChannel }) {
  const notice = useSyncExternalStore(channel.subscribe, channel.current, channel.current);
  const failure = Boolean(notice && noticeIsSticky(notice));

  // Informational notices clear themselves; the timer restarts whenever the
  // notice changes so a newer message gets its full lifetime.
  useEffect(() => {
    if (!notice || noticeIsSticky(notice)) return;
    const timer = window.setTimeout(channel.dismiss, NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice, channel]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notice && !failure ? notice.text : ''}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {notice && failure ? notice.text : ''}
      </div>
      {notice && <Toast notice={notice} onDismiss={channel.dismiss} />}
    </>
  );
}

/** The visible toast; the live regions above announce it, so it has no role of its own. */
function Toast({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const Icon = TONE_ICON[notice.tone];
  return (
    <div className={`toast ${notice.tone}`}>
      <span className="toast-icon">
        <Icon aria-hidden="true" />
      </span>
      <span className="toast-text">{notice.text}</span>
      <button type="button" className="ibtn" aria-label="Dismiss message" title="Dismiss (Esc)" onClick={onDismiss}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
