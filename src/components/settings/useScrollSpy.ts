import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SettingsSectionId } from './settings-sections';

// Below this width the section list is a sticky strip under the command bar.
export const NARROW_SETTINGS = '(max-width: 900px)';
// A section chosen from the list stays highlighted while the page scrolls to
// it, and after it arrives, until the reader scrolls again. This bounds the
// wait when no scroll event reports the end of that movement.
const SETTLE_MS = 1500;

type Hold = 'none' | 'moving' | 'arrived';

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function bandTop() {
  const command =
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--command-height')) || 56;
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia(NARROW_SETTINGS).matches;
  return Math.round(command + (narrow ? 72 : 28));
}

// Closed disclosures hide their content without removing its boxes, so a
// plain layout check is not enough.
function isRendered(element: HTMLElement) {
  if (typeof element.checkVisibility === 'function') return element.checkVisibility();
  return element.getClientRects().length > 0 && !element.closest('details:not([open]), [hidden]');
}

/**
 * Scroll-spy for the Settings sections. A section is "in view" while it
 * crosses the band between the command bar and the middle of the window; the
 * first such section in page order is active. Once the end of the page is
 * visible the last rendered section is active, so short closing sections can
 * still be highlighted. `select` marks a section chosen from the navigation.
 */
export function useScrollSpy(
  ids: readonly SettingsSectionId[],
  rootRef: RefObject<HTMLElement | null>,
  endRef: RefObject<HTMLElement | null>,
) {
  const [active, setActive] = useState<SettingsSectionId>(ids[0]);
  const hold = useRef<Hold>('none');
  const settleTimer = useRef<number | undefined>(undefined);
  const pickRef = useRef<() => void>(() => {});

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver !== 'function') return;
    const slots = ids.flatMap((id) => {
      const element = root.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
      return element ? [{ id, element }] : [];
    });
    const inBand = new Set<SettingsSectionId>();
    let atEnd = false;
    const pick = () => {
      if (hold.current !== 'none') return;
      const next =
        atEnd && window.scrollY > 0
          ? slots.filter(({ element }) => isRendered(element)).at(-1)?.id
          : slots.find(({ id }) => inBand.has(id))?.id;
      if (next) setActive(next);
    };
    pickRef.current = pick;
    let observers: IntersectionObserver[] = [];
    const observe = () => {
      for (const observer of observers) observer.disconnect();
      inBand.clear();
      const band = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.settingsSection as SettingsSectionId;
            if (entry.isIntersecting) inBand.add(id);
            else inBand.delete(id);
          }
          pick();
        },
        { rootMargin: `-${bandTop()}px 0px -55% 0px` },
      );
      for (const { element } of slots) band.observe(element);
      observers = [band];
      const end = endRef.current;
      if (end) {
        const edge = new IntersectionObserver(([entry]) => {
          atEnd = Boolean(entry?.isIntersecting);
          pick();
        });
        edge.observe(end);
        observers.push(edge);
      }
    };
    observe();
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_SETTINGS) : null;
    media?.addEventListener('change', observe);
    const arrived = () => {
      if (hold.current === 'moving') hold.current = 'arrived';
    };
    // The reader's own scrolling hands the highlight back to the observer,
    // which has kept track of every section meanwhile: at once for the wheel,
    // touch and keys, or on the first scroll after arrival for the scroll bar.
    const scrolled = () => {
      if (hold.current !== 'arrived') return;
      hold.current = 'none';
      pick();
    };
    const intent = () => {
      hold.current = 'none';
    };
    const intentKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) intent();
    };
    window.addEventListener('scrollend', arrived);
    window.addEventListener('scroll', scrolled, { passive: true });
    window.addEventListener('wheel', intent, { passive: true });
    window.addEventListener('touchstart', intent, { passive: true });
    window.addEventListener('keydown', intentKey);
    return () => {
      for (const observer of observers) observer.disconnect();
      media?.removeEventListener('change', observe);
      window.removeEventListener('scrollend', arrived);
      window.removeEventListener('scroll', scrolled);
      window.removeEventListener('wheel', intent);
      window.removeEventListener('touchstart', intent);
      window.removeEventListener('keydown', intentKey);
      window.clearTimeout(settleTimer.current);
    };
  }, [ids, rootRef, endRef]);

  const select = useCallback((id: SettingsSectionId) => {
    hold.current = 'moving';
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      if (hold.current === 'moving') hold.current = 'arrived';
    }, SETTLE_MS);
    setActive(id);
  }, []);

  /** Lets the observer choose again, e.g. after a search changed which sections show. */
  const release = useCallback(() => {
    hold.current = 'none';
    pickRef.current();
  }, []);

  return { active, select, release };
}
