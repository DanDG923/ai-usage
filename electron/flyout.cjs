'use strict';

const { flyoutBounds } = require('./flyout-position.cjs');
const { PROVIDERS } = require('./providers.mjs');

/** @typedef {import('electron').BrowserWindow} BrowserWindow */
/** @typedef {import('electron').IpcMainInvokeEvent} IpcMainInvokeEvent */
/** @typedef {import('electron').Rectangle} Rectangle */
/** @typedef {import('../src/types').DashboardNavigation} DashboardNavigation */
/** @typedef {import('../src/types').FlyoutSnapshot} FlyoutSnapshot */
/** @typedef {import('../src/types').Quota} Quota */
/** @typedef {import('../src/types').QuotaWindow} QuotaWindow */
/** @typedef {import('../src/types').SharedPool} SharedPool */

/**
 * Where the tray icon is, and the display it is on.
 *
 * @typedef {{ trayBounds: Rectangle, workArea: Rectangle, displayBounds: Rectangle }} FlyoutAnchor
 */

// The tray flyout: a small frameless window above the tray icon showing the
// allowances at a glance. Electron is injected so the lifecycle, sender and
// navigation rules can be tested without launching it.

const FLYOUT_WIDTH = 380;
const FLYOUT_MAX_HEIGHT = 540;
const FLYOUT_MIN_HEIGHT = 200;
// A hidden flyout keeps a renderer process (tens of MB) alive; it is destroyed
// after a minute, much as the dashboard is released after 30 seconds.
const FLYOUT_RELEASE_MS = 60_000;
// Clicking the tray icon while the flyout is open takes focus from it first,
// which hides it; the click that follows must not open it again.
const FLYOUT_BLUR_GRACE_MS = 400;
// Windows raises 'click' before 'double-click'; clicks just after a double
// click belong to it and must not reopen the flyout over the dashboard.
const FLYOUT_DOUBLE_CLICK_HOLD_MS = 600;
// Follows --panel (night #08090b, Daylight #ffffff) in src/styles/tokens.css,
// the colour the flyout paints, so it never flashes the other palette.
const FLYOUT_BACKGROUND = Object.freeze({ dark: '#08090b', light: '#ffffff' });
// How long the first opening waits to measure the page before it opens at
// the maximum height instead.
const FLYOUT_MEASURE_MS = 150;

/**
 * The window height that holds a page of the given height. The renderer
 * reports its preferred height in whole pixels, rounded down, while the page
 * is rarely whole at 150% scaling. A window that short overflows by the
 * fraction, the scrollbar that raises narrows and rewraps the page taller,
 * the window grows, the scrollbar goes and the page shrinks back: it resized
 * hundreds of times a second while open. The next whole pixel always holds it.
 *
 * @param {unknown} height as the page reported it; anything but a positive number gives null
 */
function fitHeight(height) {
  const value = Number(height);
  return value > 0 ? Math.floor(value) + 1 : null;
}

const DASHBOARD_TABS = Object.freeze(['overview', 'activity', 'costs', 'settings']);
// A page may name a provider by the key the snapshot lists it under.
const DASHBOARD_PROVIDERS = Object.freeze(PROVIDERS.map((provider) => provider.snapshotKey));
// A navigation the dashboard never collects, for example because it failed to
// load, must not redirect a dashboard opened much later.
const NAVIGATION_TTL_MS = 60_000;

/**
 * True only for an IPC event sent by the main frame of the given live window.
 *
 * @param {BrowserWindow | null | undefined} window
 * @param {IpcMainInvokeEvent | null | undefined} event
 */
function isMainFrameOf(window, event) {
  if (!window || typeof window.isDestroyed !== 'function' || window.isDestroyed() || !event) return false;
  const contents = window.webContents;
  return Boolean(contents) && event.sender === contents && event.senderFrame === contents.mainFrame;
}

/**
 * A dashboard page request from outside the dashboard, reduced to the known
 * tabs and providers. Anything else, including extra keys, is refused (null).
 *
 * @param {any} value whatever a renderer sent; every field is checked here
 * @returns {DashboardNavigation | null}
 */
function normalizeNavigationTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => key !== 'tab' && key !== 'provider')) return null;
  if (!DASHBOARD_TABS.includes(value.tab)) return null;
  if (value.provider == null) return { tab: value.tab };
  if (!DASHBOARD_PROVIDERS.includes(value.provider)) return null;
  return { tab: value.tab, provider: value.provider };
}

/** Holds the latest requested page until the dashboard collects it, exactly once. */
function createNavigationQueue({ now = Date.now, ttlMs = NAVIGATION_TTL_MS } = {}) {
  /** @type {{ target: DashboardNavigation, at: number } | null} */
  let pending = null;
  return {
    /** @param {DashboardNavigation} target */
    request(target) {
      pending = { target, at: now() };
    },
    take() {
      const entry = pending;
      pending = null;
      return entry && now() - entry.at <= ttlMs ? entry.target : null;
    },
    hasPending() {
      return pending !== null && now() - pending.at <= ttlMs;
    },
  };
}

const EMPTY_SERIES = Object.freeze({ observed: Object.freeze([]), expected: Object.freeze([]), heavy: Object.freeze([]) });
/** @type {(keyof FlyoutSnapshot)[]} */
const FLYOUT_FIELDS = ['generatedAt', 'timezone', 'settings', 'sources', 'fableApplies', 'dashboardVerdict', 'resetCredits'];

// Fable's shared-pool summary keeps its figures; the chart lines go.
/**
 * @param {SharedPool | undefined} sharedPool
 * @returns {SharedPool | undefined}
 */
function lightSharedPool(sharedPool) {
  if (!sharedPool || typeof sharedPool !== 'object' || sharedPool.status !== 'applied') return sharedPool;
  return {
    ...sharedPool,
    ceiling: { observed: [], expected: [] },
    ...(sharedPool.cap && typeof sharedPool.cap === 'object'
      ? { cap: { ...sharedPool.cap, observed: [], expected: [], heavy: [], tokenCapacity: null } } : {}),
  };
}

/** @param {(QuotaWindow & { windows?: QuotaWindow[] }) | null | undefined} window one window, or a quota with its windows */
function lightWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const { tokenCapacity: _tokenCapacity, windows: _windows, ...rest } = window;
  if ('sharedPool' in rest) rest.sharedPool = lightSharedPool(rest.sharedPool);
  return rest.forecast && typeof rest.forecast === 'object' ? { ...rest, forecast: { ...rest.forecast, series: EMPTY_SERIES } } : rest;
}

/** @param {Quota | null | undefined} quota */
function lightQuota(quota) {
  const light = lightWindow(quota);
  if (!light) return null;
  // lightWindow returned an object, so it was given one.
  return Array.isArray(/** @type {Quota} */ (quota).windows) ? { ...light, windows: /** @type {Quota} */ (quota).windows.map(lightWindow).filter(Boolean) } : light;
}

/**
 * What the flyout receives: the tray snapshot's fields, from either a tray or
 * a full dashboard snapshot, without cost analytics, token-capacity estimates
 * or forecast chart series, none of which the flyout draws.
 *
 * @param {FlyoutSnapshot | null | undefined} snapshot a tray or dashboard snapshot, or an earlier payload
 * @returns {FlyoutSnapshot | null}
 */
function flyoutPayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  /** @type {Record<string, unknown>} */
  const payload = {};
  for (const key of FLYOUT_FIELDS) if (key in snapshot) payload[key] = snapshot[key];
  /** @type {Partial<FlyoutSnapshot['quotas']>} */
  const quotas = snapshot.quotas && typeof snapshot.quotas === 'object' ? snapshot.quotas : {};
  payload.quotas = Object.fromEntries(DASHBOARD_PROVIDERS.map((key) => [key, lightQuota(quotas[key])]));
  // It holds the snapshot's own fields, copied above, and the lighter quotas.
  return /** @type {FlyoutSnapshot} */ (payload);
}

/**
 * The flyout window's lifecycle. `createWindow` builds and starts loading a
 * hidden window; `getAnchor` returns { trayBounds, workArea, displayBounds }.
 * The window is created on the first show only, revealed at ready-to-show,
 * hidden on blur, and destroyed `releaseAfterMs` after it was last hidden.
 *
 * @param {object} options
 * @param {(size: { width: number, height: number }) => BrowserWindow} options.createWindow
 * @param {() => FlyoutAnchor | null} options.getAnchor
 * @param {(shown: { reused: boolean }) => void} [options.onReveal]
 * @param {number} [options.width]
 * @param {number} [options.maxHeight]
 * @param {number} [options.minHeight]
 * @param {number} [options.releaseAfterMs]
 * @param {number} [options.blurGraceMs]
 * @param {number} [options.measureMs]
 * @param {() => number} [options.now]
 */
function createTrayFlyout({
  createWindow,
  getAnchor,
  onReveal = /** @type {(shown: { reused: boolean }) => void} */ (() => {}),
  width = FLYOUT_WIDTH,
  maxHeight = FLYOUT_MAX_HEIGHT,
  minHeight = FLYOUT_MIN_HEIGHT,
  releaseAfterMs = FLYOUT_RELEASE_MS,
  blurGraceMs = FLYOUT_BLUR_GRACE_MS,
  measureMs = FLYOUT_MEASURE_MS,
  now = Date.now,
}) {
  /** @type {import('electron').BrowserWindow | null} */
  let win = null;
  let ready = false;
  // Whether the flyout should be on screen; true while a new window loads.
  let wanted = false;
  /** @type {NodeJS.Timeout | null} */
  let releaseTimer = null;
  /** @type {number | null} */
  let contentHeight = null;
  let holdUntil = -Infinity;

  // The functions below read `win` only after alive() has vouched for it.
  const alive = () => Boolean(win && !win.isDestroyed());

  function place() {
    if (!alive()) return;
    /** @type {FlyoutAnchor | null} */
    let anchor = null;
    try { anchor = getAnchor(); } catch { /* Keep the previous position. */ }
    if (!anchor) return;
    const height = contentHeight == null ? maxHeight : Math.min(maxHeight, Math.max(minHeight, contentHeight));
    const bounds = flyoutBounds({ ...anchor, width, height });
    if (bounds) /** @type {BrowserWindow} */ (win).setBounds(bounds);
  }

  function cancelRelease() {
    clearTimeout(releaseTimer ?? undefined);
    releaseTimer = null;
  }

  function scheduleRelease() {
    cancelRelease();
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (!wanted) destroy();
    }, releaseAfterMs);
    releaseTimer.unref?.();
  }

  /** @param {boolean} reused */
  function reveal(reused) {
    place();
    /** @type {BrowserWindow} */ (win).show();
    /** @type {BrowserWindow} */ (win).focus();
    try { onReveal({ reused }); } catch { /* Showing must not depend on a fresh payload. */ }
  }

  // The page's height before its window is first shown: the renderer reports
  // a preferred size only once the window is visible, so without this a new
  // window opened at the maximum height and then shrank on screen. Null when
  // it cannot be read in time.
  /**
   * @param {BrowserWindow} target
   * @returns {Promise<number | null> | null}
   */
  function measure(target) {
    if (typeof target.webContents?.executeJavaScript !== 'function') return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), measureMs);
      Promise.resolve()
        .then(() => target.webContents.executeJavaScript('document.body.getBoundingClientRect().height', true))
        .then(fitHeight, () => null)
        .then((height) => {
          clearTimeout(timer);
          resolve(height);
        });
    });
  }

  function create() {
    ready = false;
    contentHeight = null;
    const created = createWindow({ width, height: maxHeight });
    win = created;
    const current = () => win === created && !created.isDestroyed();
    const becomeReady = () => {
      if (!current() || ready) return;
      ready = true;
      if (wanted) reveal(false);
    };
    created.once('ready-to-show', () => {
      if (!current()) return;
      const measuring = measure(created);
      if (!measuring) {
        becomeReady();
        return;
      }
      void measuring.then((height) => {
        // A preferred size that arrived meanwhile is the newer height.
        if (current() && height != null && contentHeight == null) contentHeight = height;
        becomeReady();
      });
    });
    created.on('blur', () => {
      if (!current() || !wanted) return;
      holdUntil = now() + blurGraceMs;
      hide();
    });
    created.on('closed', () => {
      if (win !== created) return;
      win = null;
      ready = false;
      wanted = false;
      cancelRelease();
    });
    // With preferred-size mode the renderer reports its natural height, so
    // the window fits its content up to the maximum.
    created.webContents.on('preferred-size-changed', (_event, preferred) => {
      const next = fitHeight(preferred?.height);
      if (!current() || next == null || next === contentHeight) return;
      contentHeight = next;
      place();
    });
    created.webContents.on('render-process-gone', () => {
      if (current()) destroy();
    });
    return created;
  }

  function show() {
    wanted = true;
    cancelRelease();
    if (!alive()) {
      create();
      return;
    }
    if (ready) reveal(true);
  }

  /** Hides the flyout. `holdMs` also ignores tray clicks for that long. */
  function hide({ holdMs = 0 } = {}) {
    if (holdMs > 0) holdUntil = Math.max(holdUntil, now() + holdMs);
    const wasWanted = wanted;
    wanted = false;
    if (!alive()) return;
    if (/** @type {BrowserWindow} */ (win).isVisible()) /** @type {BrowserWindow} */ (win).hide();
    if (wasWanted || !releaseTimer) scheduleRelease();
  }

  /** The tray icon's left click. Returns whether the flyout is now opening. */
  function toggle() {
    if (wanted) {
      hide();
      return false;
    }
    if (now() < holdUntil) return false;
    show();
    return true;
  }

  function destroy() {
    cancelRelease();
    wanted = false;
    ready = false;
    const target = win;
    win = null;
    if (target && !target.isDestroyed()) target.destroy();
  }

  /**
   * @param {string} channel
   * @param {unknown} payload anything that can be sent to a renderer
   */
  function send(channel, payload) {
    if (!alive()) return false;
    /** @type {BrowserWindow} */ (win).webContents.send(channel, payload);
    return true;
  }

  return {
    show,
    hide,
    toggle,
    destroy,
    send,
    reposition: place,
    isOpen: () => wanted,
    isSender: (/** @type {IpcMainInvokeEvent} */ event) => isMainFrameOf(win, event),
    window: () => (alive() ? win : null),
  };
}

module.exports = {
  DASHBOARD_PROVIDERS,
  DASHBOARD_TABS,
  FLYOUT_BACKGROUND,
  FLYOUT_BLUR_GRACE_MS,
  FLYOUT_DOUBLE_CLICK_HOLD_MS,
  FLYOUT_MAX_HEIGHT,
  FLYOUT_MEASURE_MS,
  FLYOUT_RELEASE_MS,
  FLYOUT_WIDTH,
  NAVIGATION_TTL_MS,
  createNavigationQueue,
  createTrayFlyout,
  flyoutPayload,
  isMainFrameOf,
  normalizeNavigationTarget,
};
