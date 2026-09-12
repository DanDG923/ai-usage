import { useEffect, useSyncExternalStore } from 'react';

const NOTICE_LIFETIME_MS = 12_000;

/** Failures stay on screen until dismissed; confirmations clear themselves. */
function noticeIsSticky(notice: string) {
  return notice.startsWith('Refresh completed with') || /failed|could not/i.test(notice);
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
  current: () => string;
  subscribe: (listener: () => void) => () => void;
};

export function createNoticeChannel(): NoticeChannel {
  let notice = '';
  const listeners = new Set<() => void>();
  return {
    show(text) {
      if (text === notice) return;
      notice = text;
      for (const listener of listeners) listener();
    },
    current: () => notice,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function NoticeToast({ channel }: { channel: NoticeChannel }) {
  const notice = useSyncExternalStore(channel.subscribe, channel.current);

  // Informational notices clear themselves; the timer restarts whenever the
  // text changes so a newer message gets its full lifetime.
  useEffect(() => {
    if (!notice || noticeIsSticky(notice)) return;
    const timer = window.setTimeout(() => channel.show(''), NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice, channel]);

  if (!notice) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{notice}</span>
      <button aria-label="Dismiss message" onClick={() => channel.show('')}>
        ×
      </button>
    </div>
  );
}
