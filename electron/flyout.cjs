'use strict';

const { flyoutBounds } = require('./flyout-position.cjs');

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
// Follows --surface-2 (dark) and --surface (light) in src/professional.css,
// the colours the flyout paints, so it never flashes the other palette.
const FLYOUT_BACKGROUND = Object.freeze({ dark: '#1d1e22', light: '#ffffff' });

const DASHBOARD_TABS = Object.freeze(['overview', 'activity', 'costs', 'settings']);
const DASHBOARD_PROVIDERS = Object.freeze(['codex', 'claude', 'fable']);
// A navigation the dashboard never collects, for example because it failed to
// load, must not redirect a dashboard opened much later.
const NAVIGATION_TTL_MS = 60_000;

/** True only for an IPC event sent by the main frame of the given live window. */
function isMainFrameOf(window, event) {
  if (!window || typeof window.isDestroyed !== 'function' || window.isDestroyed() || !event) return false;
  const contents = window.webContents;
  return Boolean(contents) && event.sender === contents && event.senderFrame === contents.mainFrame;
}

/**
 * A dashboard page request from outside the dashboard, reduced to the known
 * tabs and providers. Anything else, including extra keys, is refused (null).
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
  let pending = null;
  return {
    request(target) {
      pending = { target, at: now() };
    },
    take() {
      const entry = pending;
      pending = null;
      return entry && now() - entry.at <= ttlMs ? entry.target : null;
    },
    hasPending() {
      return Boolean(pending) && now() - pending.at <= ttlMs;
    },
  };
}

const EMPTY_SERIES = Object.freeze({ observed: Object.freeze([]), expected: Object.freeze([]), heavy: Object.freeze([]) });
const FLYOUT_FIELDS = ['generatedAt', 'timezone', 'settings', 'sources', 'fableApplies', 'dashboardVerdict', 'resetCredits'];

function lightWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const { tokenCapacity: _tokenCapacity, windows: _windows, ...rest } = window;
  return rest.forecast && typeof rest.forecast === 'object' ? { ...rest, forecast: { ...rest.forecast, series: EMPTY_SERIES } } : rest;
}

function lightQuota(quota) {
  const light = lightWindow(quota);
  if (!light) return null;
  return Array.isArray(quota.windows) ? { ...light, windows: quota.windows.map(lightWindow).filter(Boolean) } : light;
}

/**
 * What the flyout receives: the tray snapshot's fields, from either a tray or
 * a full dashboard snapshot, without cost analytics, token-capacity estimates
 * or forecast chart series, none of which the flyout draws.
 */
function flyoutPayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const payload = {};
  for (const key of FLYOUT_FIELDS) if (key in snapshot) payload[key] = snapshot[key];
  const quotas = snapshot.quotas && typeof snapshot.quotas === 'object' ? snapshot.quotas : {};
  payload.quotas = {
    codex: lightQuota(quotas.codex),
    claude: lightQuota(quotas.claude),
    fable: lightQuota(quotas.fable),
  };
  return payload;
}

/**
 * The flyout window's lifecycle. `createWindow` builds and starts loading a
 * hidden window; `getAnchor` returns { trayBounds, workArea, displayBounds }.
 * The window is created on the first show only, revealed at ready-to-show,
 * hidden on blur, and destroyed `releaseAfterMs` after it was last hidden.
 */
function createTrayFlyout({
  createWindow,
  getAnchor,
  onReveal = () => {},
  width = FLYOUT_WIDTH,
  maxHeight = FLYOUT_MAX_HEIGHT,
  minHeight = FLYOUT_MIN_HEIGHT,
  releaseAfterMs = FLYOUT_RELEASE_MS,
  blurGraceMs = FLYOUT_BLUR_GRACE_MS,
  now = Date.now,
}) {
  let win = null;
  let ready = false;
  // Whether the flyout should be on screen; true while a new window loads.
  let wanted = false;
  let releaseTimer = null;
  let contentHeight = null;
  let holdUntil = -Infinity;

  const alive = () => Boolean(win && !win.isDestroyed());

  function place() {
    if (!alive()) return;
    let anchor = null;
    try { anchor = getAnchor(); } catch { /* Keep the previous position. */ }
    if (!anchor) return;
    const height = contentHeight == null ? maxHeight : Math.min(maxHeight, Math.max(minHeight, contentHeight));
    const bounds = flyoutBounds({ ...anchor, width, height });
    if (bounds) win.setBounds(bounds);
  }

  function cancelRelease() {
    clearTimeout(releaseTimer);
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

  function reveal(reused) {
    place();
    win.show();
    win.focus();
    try { onReveal({ reused }); } catch { /* Showing must not depend on a fresh payload. */ }
  }

  function create() {
    ready = false;
    contentHeight = null;
    const created = createWindow({ width, height: maxHeight });
    win = created;
    const current = () => win === created && !created.isDestroyed();
    created.once('ready-to-show', () => {
      if (!current()) return;
      ready = true;
      if (wanted) reveal(false);
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
      const next = Math.ceil(Number(preferred?.height));
      if (!current() || !(next > 0) || next === contentHeight) return;
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
    if (win.isVisible()) win.hide();
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

  function send(channel, payload) {
    if (!alive()) return false;
    win.webContents.send(channel, payload);
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
    isSender: (event) => isMainFrameOf(win, event),
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
  FLYOUT_RELEASE_MS,
  FLYOUT_WIDTH,
  NAVIGATION_TTL_MS,
  createNavigationQueue,
  createTrayFlyout,
  flyoutPayload,
  isMainFrameOf,
  normalizeNavigationTarget,
};
