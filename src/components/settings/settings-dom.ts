import { resolveSettingsTarget } from './settings-sections';

const SEARCHABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title'] as const;

/**
 * Everything a person can read in an element, including collapsed and hidden
 * parts: text nodes are joined with spaces so words in neighbouring elements
 * never run together, and accessible names written only as attributes count too.
 */
export function elementSearchText(element: Element) {
  const parts: string[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) parts.push(node.nodeValue);
      continue;
    }
    for (const name of SEARCHABLE_ATTRIBUTES) {
      const value = (node as Element).getAttribute(name);
      if (value) parts.push(value);
    }
  }
  return parts.join(' ');
}

export function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The slot of the section that holds an element, or null when it is outside the Settings sections. */
export function settingsSlotOf(element: Element | null) {
  return element?.closest<HTMLElement>('[data-settings-section]') ?? null;
}

/** The Settings element a link target names, after resolving aliases. */
export function settingsTargetElement(target: string | null | undefined) {
  const id = resolveSettingsTarget(target);
  if (!id) return null;
  const page = document.getElementById('panel-settings');
  const element = document.getElementById(id);
  return page && element && page.contains(element) ? element : null;
}

/**
 * Brings a section, or a block inside one, into view: every closed disclosure
 * around it opens, the page scrolls (smoothly unless reduced motion is
 * preferred) and focus moves to its heading so keyboard and screen-reader
 * users continue from there.
 */
export function revealSettingsTarget(target: string | null | undefined, options: { smooth?: boolean } = {}) {
  const element = settingsTargetElement(target);
  if (!element) return false;
  const page = document.getElementById('panel-settings');
  for (let node = element.parentElement; node && node !== page; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
  }
  if (element instanceof HTMLDetailsElement && !element.open) element.open = true;
  const behavior: ScrollBehavior = options.smooth === false || prefersReducedMotion() ? 'instant' : 'smooth';
  element.scrollIntoView({ block: 'start', behavior });
  const heading = element.matches('h2, h3') ? element : element.querySelector<HTMLElement>('h2, h3');
  const focusTarget = heading ?? element;
  if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
  focusTarget.focus({ preventScroll: true });
  return true;
}
