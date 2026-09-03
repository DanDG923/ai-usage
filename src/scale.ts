/**
 * Viewport-driven UI scale.
 *
 * The dashboard is designed at a 1600×1000 window. On a larger window the
 * page content is zoomed up so it fills the screen; on a smaller one it is
 * zoomed down so the three cards still fit. The factor is the smaller of the
 * width and height ratios so nothing overflows in either direction, and it is
 * bounded so text never becomes unreadable or absurd. The header scales only
 * halfway, because it is a fixed-height strip that shares the window with the
 * native caption buttons.
 */
export const DESIGN_WIDTH = 1600;
export const DESIGN_HEIGHT = 1000;
export const MIN_SCALE = 0.7;
export const MAX_SCALE = 1.6;

export function viewportScale(width: number, height: number) {
  const ratio = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio)) * 1000) / 1000;
}

export function headerScale(scale: number) {
  return Math.round((1 + (scale - 1) * 0.5) * 1000) / 1000;
}

function apply() {
  const root = document.documentElement;
  const scale = viewportScale(window.innerWidth, window.innerHeight);
  root.style.setProperty('--ui-scale', String(scale));
  root.style.setProperty('--ui-header-scale', String(headerScale(scale)));
  const header = document.querySelector<HTMLElement>('.app-header');
  root.style.setProperty('--header-height', `${Math.round(header?.getBoundingClientRect().height ?? 48)}px`);
}

/** Keep the scale custom properties in step with the window. Returns a disposer. */
export function watchViewportScale() {
  apply();
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  };
  window.addEventListener('resize', schedule);
  // The header wraps at narrow widths, so its height can change without a
  // window resize event that we would otherwise miss.
  // The loading header is replaced by the dashboard header once a snapshot
  // arrives, so the observed element is re-resolved whenever the DOM changes.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  let observed: Element | null = null;
  const follow = () => {
    const header = document.querySelector('.app-header');
    if (!observer || header === observed) return;
    if (observed) observer.unobserve(observed);
    observed = header;
    if (header) observer.observe(header);
    schedule();
  };
  follow();
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(follow) : null;
  mutations?.observe(document.body, { childList: true, subtree: true });
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    observer?.disconnect();
    mutations?.disconnect();
  };
}
