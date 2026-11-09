import { CircleCheck, Eye, Hourglass, OctagonAlert, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import type { NoticeTone } from '../notices';

const NOTICE_LIFETIME_MS = 12_000;

/**
 * The icon for each tone. The words carry the meaning; the edge colour and
 * the icon repeat it. Only a warning is a failure: it stays on screen until
 * dismissed and is announced as an alert; every other tone clears itself.
 */
const NOTICE_ICONS: Record<NoticeTone, typeof CircleCheck> = {
  warning: OctagonAlert,
  caution: Eye,
  busy: Hourglass,
  ok: CircleCheck,
};

/**
 * The notice text lives here rather than in App state: every handler in App
 * publishes to it, but only the toast needs to render when it changes. When
 * it was App state, each message and its twelve-second auto-clear re-rendered
 * whichever page was mounted, Settings and its price table included.
 *
 * Each notice is published with its tone; the toast never infers it from the
 * wording, so a confirmation that mentions something "could not" be done is
 * still drawn as a confirmation.
 */
export type NoticeChannel = {
  /** Publish a message with the tone it is drawn in. */
  show: (text: string, tone: NoticeTone) => void;
  /** Publish a failure: shorthand for show(text, 'warning'). */
  fail: (text: string) => void;
  /** Dismiss the current message. */
  dismiss: () => void;
  tone: () => NoticeTone;
  isFailure: () => boolean;
  current: () => string;
  subscribe: (listener: () => void) => () => void;
};

export function createNoticeChannel(): NoticeChannel {
  let notice = '';
  let tone: NoticeTone = 'ok';
  const listeners = new Set<() => void>();
  const publish = (text: string, nextTone: NoticeTone) => {
    if (text === notice && nextTone === tone) return;
    notice = text;
    tone = nextTone;
    for (const listener of listeners) listener();
  };
  return {
    show: publish,
    fail: (text) => publish(text, 'warning'),
    dismiss: () => publish('', 'ok'),
    tone: () => tone,
    isFailure: () => tone === 'warning',
    current: () => notice,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function NoticeToast({ channel }: { channel: NoticeChannel }) {
  // The server snapshot is the same read, so the toast can also be rendered to markup.
  const notice = useSyncExternalStore(channel.subscribe, channel.current, channel.current);
  const tone = useSyncExternalStore(channel.subscribe, channel.tone, channel.tone);
  const failure = tone === 'warning';

  // Informational notices clear themselves; the timer restarts whenever the
  // text changes so a newer message gets its full lifetime.
  useEffect(() => {
    if (!notice || failure) return;
    const timer = window.setTimeout(() => channel.dismiss(), NOTICE_LIFETIME_MS);
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
      {notice && <Toast notice={notice} tone={tone} onDismiss={channel.dismiss} />}
    </>
  );
}

/** The visible toast; the live regions above announce it, so it has no role of its own. */
function Toast({ notice, tone, onDismiss }: { notice: string; tone: NoticeTone; onDismiss: () => void }) {
  const Icon = NOTICE_ICONS[tone];
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
