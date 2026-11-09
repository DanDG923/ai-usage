'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { flyoutBounds, taskbarEdge } = require('../../electron/flyout-position.cjs');
const {
  FLYOUT_BACKGROUND, FLYOUT_MEASURE_MS, FLYOUT_RELEASE_MS, NAVIGATION_TTL_MS, createNavigationQueue, createTrayFlyout, flyoutPayload,
  isMainFrameOf, normalizeNavigationTarget,
} = require('../../electron/flyout.cjs');
const { assertArchive } = require('../../tools/audit-release.cjs');
const { mainApplication } = require('../helpers/main-application.cjs');

const { repoRoot: root, readRepoFile } = require('../helpers/repo.cjs');
const { startRendererServer } = require('../helpers/renderer-server.cjs');
const { decodedText: text } = require('../helpers/markup.cjs');
const size = { width: 380, height: 540 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A 1920x1080 display whose taskbar takes 48 px from the given edge.
function display(edge, origin = { x: 0, y: 0 }) {
  const bounds = { ...origin, width: 1920, height: 1080 };
  const workArea = {
    bottom: { x: origin.x, y: origin.y, width: 1920, height: 1032 },
    top: { x: origin.x, y: origin.y + 48, width: 1920, height: 1032 },
    left: { x: origin.x + 48, y: origin.y, width: 1872, height: 1080 },
    right: { x: origin.x, y: origin.y, width: 1872, height: 1080 },
  }[edge];
  return { displayBounds: bounds, workArea };
}

function inside(bounds, workArea, margin = 8) {
  return bounds.x >= workArea.x + margin && bounds.y >= workArea.y + margin
    && bounds.x + bounds.width <= workArea.x + workArea.width - margin
    && bounds.y + bounds.height <= workArea.y + workArea.height - margin;
}

test('the flyout opens against a bottom taskbar, centred on the icon and clamped at the screen edge', () => {
  const screen = display('bottom');
  const trayBounds = { x: 1700, y: 1044, width: 24, height: 24 };
  assert.equal(taskbarEdge({ trayBounds, ...screen }), 'bottom');
  const bounds = flyoutBounds({ trayBounds, ...screen, ...size });
  assert.deepEqual(bounds, { x: 1522, y: 484, width: 380, height: 540 });
  assert.ok(inside(bounds, screen.workArea));
  // An icon at the far right would push the flyout off screen; it is held 8 px in.
  const clamped = flyoutBounds({ trayBounds: { x: 1900, y: 1044, width: 24, height: 24 }, ...screen, ...size });
  assert.equal(clamped.x, 1920 - 8 - 380);
  assert.ok(inside(clamped, screen.workArea));
  // An icon in the overflow panel sits inside the work area; the flyout opens above it.
  const overflow = flyoutBounds({ trayBounds: { x: 1600, y: 900, width: 24, height: 24 }, ...screen, ...size });
  assert.equal(overflow.y, 900 - 8 - 540);
});

test('top, left and right taskbars open the flyout away from their own edge', () => {
  const top = display('top');
  const fromTop = flyoutBounds({ trayBounds: { x: 1700, y: 12, width: 24, height: 24 }, ...top, ...size });
  assert.equal(taskbarEdge({ trayBounds: { x: 1700, y: 12, width: 24, height: 24 }, ...top }), 'top');
  assert.deepEqual(fromTop, { x: 1522, y: 48 + 8, width: 380, height: 540 });

  const left = display('left');
  const leftIcon = { x: 12, y: 1040, width: 24, height: 24 };
  assert.equal(taskbarEdge({ trayBounds: leftIcon, ...left }), 'left');
  const fromLeft = flyoutBounds({ trayBounds: leftIcon, ...left, ...size });
  assert.deepEqual(fromLeft, { x: 48 + 8, y: 1080 - 8 - 540, width: 380, height: 540 });

  const right = display('right');
  const rightIcon = { x: 1884, y: 400, width: 24, height: 24 };
  assert.equal(taskbarEdge({ trayBounds: rightIcon, ...right }), 'right');
  const fromRight = flyoutBounds({ trayBounds: rightIcon, ...right, ...size });
  assert.deepEqual(fromRight, { x: 1872 - 8 - 380, y: 412 - 270, width: 380, height: 540 });
  for (const [bounds, area] of [[fromTop, top], [fromLeft, left], [fromRight, right]]) assert.ok(inside(bounds, area.workArea));
});

test('flyout geometry handles auto-hidden taskbars, secondary displays, unknown icons and small work areas', () => {
  // Auto-hide: no gap between display and work area; the nearest edge to the icon wins.
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(taskbarEdge({ trayBounds: { x: 1700, y: 1060, width: 20, height: 20 }, workArea: full, displayBounds: full }), 'bottom');
  assert.equal(taskbarEdge({ trayBounds: { x: 4, y: 500, width: 20, height: 20 }, workArea: full, displayBounds: full }), 'left');
  // A display left of the primary has negative coordinates.
  const secondary = display('bottom', { x: -1920, y: 0 });
  const onSecondary = flyoutBounds({ trayBounds: { x: -100, y: 1044, width: 24, height: 24 }, ...secondary, ...size });
  assert.equal(onSecondary.x, -8 - 380);
  assert.ok(inside(onSecondary, secondary.workArea));
  // Windows can report an empty rectangle: open in the notification-area corner.
  const unknown = flyoutBounds({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, ...display('bottom'), ...size });
  assert.deepEqual(unknown, { x: 1920 - 8 - 380, y: 1032 - 8 - 540, width: 380, height: 540 });
  const unknownTop = flyoutBounds({ trayBounds: null, ...display('top'), ...size });
  assert.equal(unknownTop.y, 48 + 8);
  // A work area smaller than the flyout shrinks it rather than letting it overflow.
  const small = { x: 0, y: 0, width: 300, height: 400 };
  const shrunk = flyoutBounds({ trayBounds: { x: 280, y: 410, width: 16, height: 16 }, workArea: small, displayBounds: { ...small, height: 440 }, ...size });
  assert.deepEqual(shrunk, { x: 8, y: 8, width: 284, height: 384 });
  // Fractional scale factors still produce whole pixels.
  const fractional = flyoutBounds({ trayBounds: { x: 1700.4, y: 1044.6, width: 23.3, height: 23.3 }, ...display('bottom'), width: 380, height: 433.5 });
  for (const value of Object.values(fractional)) assert.ok(Number.isInteger(value));
  assert.equal(flyoutBounds({ trayBounds: null, workArea: null, ...size }), null);
});

// A BrowserWindow stand-in with the surface the flyout controller and main use.
class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.visible = false;
    this.destroyed = false;
    this.focused = 0;
    this.bounds = null;
    this.loaded = null;
    const sent = [];
    this.webContents = Object.assign(new EventEmitter(), { mainFrame: { frame: 'main' }, sent, send: (...args) => sent.push(args) });
    FakeWindow.created.push(this);
  }
  loadFile(value) { this.loaded = { kind: 'file', value }; return FakeWindow.loadResult(); }
  loadURL(value) { this.loaded = { kind: 'url', value }; return FakeWindow.loadResult(); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  show() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  focus() { this.focused += 1; }
  setBounds(bounds) { this.bounds = bounds; }
  setBackgroundColor(color) { this.background = color; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
}
FakeWindow.created = [];
FakeWindow.loadResult = () => Promise.resolve();

const ANCHOR = { trayBounds: { x: 1700, y: 1044, width: 24, height: 24 }, ...display('bottom') };

function controller(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000_000;
  const windows = [];
  const reveals = [];
  const flyout = createTrayFlyout({
    createWindow: (initial) => {
      const created = new FakeWindow(initial);
      windows.push(created);
      return created;
    },
    getAnchor: () => ANCHOR,
    onReveal: (info) => reveals.push(info),
    now: () => clock,
    ...options,
  });
  return {
    flyout, windows, reveals,
    advance(ms) { clock += ms; t.mock.timers.tick(ms); },
  };
}

test('the flyout window is created on first open only and revealed above the tray once ready', (t) => {
  const h = controller(t);
  assert.equal(h.windows.length, 0, 'nothing is created before the first click');
  assert.equal(h.flyout.window(), null);
  assert.equal(h.flyout.toggle(), true);
  assert.equal(h.windows.length, 1);
  const [flyout] = h.windows;
  assert.deepEqual(flyout.options, { width: 380, height: 540 });
  assert.equal(flyout.visible, false, 'hidden until ready-to-show');
  flyout.emit('ready-to-show');
  assert.equal(flyout.visible, true);
  assert.equal(flyout.focused, 1);
  assert.deepEqual(flyout.bounds, flyoutBounds({ ...ANCHOR, ...size }));
  assert.deepEqual(h.reveals, [{ reused: false }]);
  assert.equal(h.flyout.toggle(), false, 'a second click closes it');
  assert.equal(flyout.visible, false);
});

test('blur hides the flyout and the tray click that caused the blur does not reopen it', (t) => {
  const h = controller(t);
  h.flyout.toggle();
  const [flyout] = h.windows;
  flyout.emit('ready-to-show');
  flyout.emit('blur');
  assert.equal(flyout.visible, false);
  assert.equal(h.flyout.toggle(), false);
  assert.equal(flyout.visible, false);
  h.advance(500);
  assert.equal(h.flyout.toggle(), true);
  assert.equal(flyout.visible, true);
  assert.equal(h.windows.length, 1, 'a recently hidden window is reused');
  assert.deepEqual(h.reveals.at(-1), { reused: true });
});

test('a hidden flyout releases its window after a minute and is recreated on the next open', (t) => {
  const h = controller(t);
  h.flyout.toggle();
  h.windows[0].emit('ready-to-show');
  h.flyout.hide();
  h.advance(30_000);
  h.flyout.toggle();
  h.advance(FLYOUT_RELEASE_MS * 2);
  assert.equal(h.windows[0].destroyed, false, 'reopening cancels the release');
  h.flyout.hide();
  // Repeated hides, such as Escape after a blur, do not postpone the release.
  h.advance(FLYOUT_RELEASE_MS - 1);
  h.flyout.hide();
  assert.equal(h.windows[0].destroyed, false);
  h.advance(1);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.flyout.window(), null);
  h.flyout.toggle();
  assert.equal(h.windows.length, 2);
});

test('a double click never leaves the flyout open over the dashboard', (t) => {
  const h = controller(t);
  // Windows raises 'click' (flyout starts loading) and then 'double-click'.
  h.flyout.toggle();
  h.flyout.hide({ holdMs: 600 });
  h.windows[0].emit('ready-to-show');
  assert.equal(h.windows[0].visible, false, 'the loading flyout is not revealed');
  assert.equal(h.flyout.toggle(), false, 'clicks belonging to the double click are ignored');
  assert.equal(h.windows[0].visible, false);
  h.advance(600);
  assert.equal(h.flyout.toggle(), true);
  assert.equal(h.windows[0].visible, true);
});

test('the window fits its content between the minimum and maximum height, anchored to the taskbar', (t) => {
  const h = controller(t);
  h.flyout.toggle();
  const [flyout] = h.windows;
  flyout.emit('ready-to-show');
  flyout.webContents.emit('preferred-size-changed', {}, { width: 380, height: 421.4 });
  assert.equal(flyout.bounds.height, 422);
  assert.equal(flyout.bounds.y + flyout.bounds.height, 1032 - 8);
  flyout.webContents.emit('preferred-size-changed', {}, { width: 380, height: 5000 });
  assert.equal(flyout.bounds.height, 540);
  flyout.webContents.emit('preferred-size-changed', {}, { width: 380, height: 12 });
  assert.equal(flyout.bounds.height, 200);
  flyout.webContents.emit('preferred-size-changed', {}, null);
  assert.equal(flyout.bounds.height, 200);
});

// The renderer rounds its preferred height down, while a page at 150% scaling
// is rarely a whole number of pixels (460.55 in the 1.0.57 flyout). A window
// that short overflowed by the fraction, the scrollbar rewrapped the page to
// 477, and the window resized between the two hundreds of times a second.
test('a whole-pixel preferred height gets a window one pixel taller, so the page never overflows by a fraction', (t) => {
  const h = controller(t);
  h.flyout.toggle();
  const [flyout] = h.windows;
  flyout.emit('ready-to-show');
  const placed = [];
  flyout.setBounds = (bounds) => { flyout.bounds = bounds; placed.push(bounds.height); };
  flyout.webContents.emit('preferred-size-changed', {}, { width: 1, height: 460 });
  assert.equal(flyout.bounds.height, 461);
  assert.equal(flyout.bounds.y + flyout.bounds.height, 1032 - 8, 'still anchored to the taskbar');
  flyout.webContents.emit('preferred-size-changed', {}, { width: 1, height: 460 });
  assert.deepEqual(placed, [461], 'the same height is not placed again');
});

// Gives the newest window a page that reports this height when measured.
function pageHeight(h, height) {
  const calls = [];
  h.windows.at(-1).webContents.executeJavaScript = (code) => {
    calls.push(code);
    return Promise.resolve(height);
  };
  return calls;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a new window measures its page before it opens, instead of opening at the maximum and shrinking', async (t) => {
  const h = controller(t);
  h.flyout.toggle();
  const calls = pageHeight(h, 460.55);
  const [flyout] = h.windows;
  const shown = [];
  flyout.show = () => { flyout.visible = true; shown.push(flyout.bounds.height); };
  flyout.emit('ready-to-show');
  assert.equal(flyout.visible, false, 'not revealed while the page is measured');
  await settle();
  assert.deepEqual(calls, ['document.body.getBoundingClientRect().height']);
  assert.deepEqual(shown, [461], 'revealed once, already at the page height');
  assert.deepEqual(h.reveals, [{ reused: false }]);
});

test('a page that cannot be measured in time opens at the maximum height', async (t) => {
  const h = controller(t);
  h.flyout.toggle();
  pageHeight(h, new Promise(() => {}));
  h.windows[0].emit('ready-to-show');
  await settle();
  assert.equal(h.windows[0].visible, false);
  h.advance(FLYOUT_MEASURE_MS);
  await settle();
  assert.equal(h.windows[0].visible, true);
  assert.equal(h.windows[0].bounds.height, 540);
});

test('a flyout closed while its page is measured stays closed, and opens at the measured height', async (t) => {
  const h = controller(t);
  h.flyout.toggle();
  pageHeight(h, 300.2);
  h.flyout.hide();
  h.windows[0].emit('ready-to-show');
  await settle();
  assert.equal(h.windows[0].visible, false);
  assert.equal(h.flyout.toggle(), true);
  assert.equal(h.windows[0].visible, true);
  assert.equal(h.windows[0].bounds.height, 301);
});

test('a crashed flyout renderer is dropped and pushes reach only a live window', (t) => {
  const h = controller(t);
  assert.equal(h.flyout.send('flyout:updated', {}), false);
  h.flyout.toggle();
  assert.equal(h.flyout.send('flyout:updated', { n: 1 }), true);
  assert.deepEqual(h.windows[0].webContents.sent, [['flyout:updated', { n: 1 }]]);
  h.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.flyout.send('flyout:updated', {}), false);
  assert.equal(h.flyout.isOpen(), false);
});

test('sender checks accept only the main frame of the live window', () => {
  const window = new FakeWindow();
  const main = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(isMainFrameOf(window, main), true);
  assert.equal(isMainFrameOf(window, { sender: window.webContents, senderFrame: {} }), false);
  assert.equal(isMainFrameOf(window, { sender: {}, senderFrame: window.webContents.mainFrame }), false);
  assert.equal(isMainFrameOf(null, main), false);
  window.destroy();
  assert.equal(isMainFrameOf(window, main), false);
});

test('navigation targets are reduced to known tabs and providers', () => {
  assert.deepEqual(normalizeNavigationTarget({ tab: 'overview' }), { tab: 'overview' });
  assert.deepEqual(normalizeNavigationTarget({ tab: 'overview', provider: 'fable' }), { tab: 'overview', provider: 'fable' });
  assert.deepEqual(normalizeNavigationTarget({ tab: 'settings', provider: null }), { tab: 'settings' });
  for (const tab of ['overview', 'activity', 'costs', 'settings']) assert.deepEqual(normalizeNavigationTarget({ tab }), { tab });
  for (const invalid of [
    null, undefined, 'settings', ['settings'], {}, { tab: 'Settings' }, { tab: 'secrets' }, { tab: 'overview', provider: 'openai' },
    { tab: 'overview', provider: 'claude-fable' }, { tab: 'settings', extra: true }, { tab: { toString: () => 'settings' } },
    JSON.parse('{"tab":"settings","__proto__":{"provider":"codex"}}'),
  ]) {
    assert.equal(normalizeNavigationTarget(invalid), null, JSON.stringify(invalid));
  }
});

test('a queued navigation is handed out once, the latest request wins and stale requests expire', () => {
  let clock = 0;
  const queue = createNavigationQueue({ now: () => clock });
  assert.equal(queue.take(), null);
  queue.request({ tab: 'costs' });
  queue.request({ tab: 'settings' });
  assert.equal(queue.hasPending(), true);
  assert.deepEqual(queue.take(), { tab: 'settings' });
  assert.equal(queue.take(), null);
  queue.request({ tab: 'activity' });
  clock += NAVIGATION_TTL_MS + 1;
  assert.equal(queue.hasPending(), false);
  assert.equal(queue.take(), null);
});

test('the flyout payload keeps the tray fields and drops analytics, capacity and chart series', () => {
  const window = (bucketId) => ({ bucketId, remainingPercent: 50, forecast: { state: 'safe', expectedRemaining: 20, series: { observed: [{ at: 1, remaining: 2 }], expected: [1], heavy: [2] } }, tokenCapacity: { weeklyTokens: 1 } });
  const full = {
    generatedAt: '2026-09-23T10:00:00.000Z', timezone: 'Europe/London', settings: { theme: 'dark' }, sources: [{ id: 'codex' }],
    fableApplies: true, dashboardVerdict: { state: 'safe' }, resetCredits: 1,
    quotas: { codex: { ...window('weekly'), windows: [window('weekly'), window('five_hour')] }, claude: null },
    costs: { actual: 12 }, priceCatalog: [], cycles: {}, dailyUsage: [], storage: { databasePath: 'C:\\secret.sqlite' },
  };
  const payload = flyoutPayload(full);
  assert.deepEqual(Object.keys(payload).sort(), ['dashboardVerdict', 'fableApplies', 'generatedAt', 'quotas', 'resetCredits', 'settings', 'sources', 'timezone']);
  assert.equal(payload.quotas.codex.forecast.series.observed.length, 0);
  assert.equal(payload.quotas.codex.forecast.expectedRemaining, 20);
  assert.equal(payload.quotas.codex.windows.length, 2);
  assert.equal(payload.quotas.codex.windows[1].forecast.series.expected.length, 0);
  assert.equal('tokenCapacity' in payload.quotas.codex, false);
  assert.equal('tokenCapacity' in payload.quotas.codex.windows[0], false);
  assert.equal(payload.quotas.claude, null);
  assert.equal(payload.quotas.fable, null);
  assert.equal(full.quotas.codex.forecast.series.observed.length, 1, 'the source snapshot is not modified');
  assert.equal(flyoutPayload(null), null);
});

// The real main-process application, with Electron replaced by stand-ins.
function mainHarness({ env = {} } = {}) {
  class HarnessWindow extends FakeWindow {}
  class FakeTray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
    setImage() {}
    isDestroyed() { return false; }
    getBounds() { return { x: 1700, y: 1044, width: 24, height: 24 }; }
  }
  const { main, handlers, app } = mainApplication({
    env,
    electron: {
      BrowserWindow: HarnessWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => template },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
      nativeTheme: { shouldUseDarkColors: true },
      screen: {
        getCursorScreenPoint: () => ({ x: 1710, y: 1050 }),
        getDisplayMatching: () => ({ bounds: display('bottom').displayBounds, workArea: display('bottom').workArea }),
        getAllDisplays: () => [{ bounds: display('bottom').displayBounds, workArea: display('bottom').workArea }],
      },
    },
  });
  const windowsBefore = FakeWindow.created.length;
  return {
    main, handlers, electron: { ...main.electron, app },
    created: () => FakeWindow.created.slice(windowsBefore).filter((entry) => entry instanceof HarnessWindow),
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('the tray creates no flyout at startup; left click opens it and double click opens the dashboard instead', () => {
  const h = mainHarness();
  let dashboardShows = 0;
  h.main.dashboard.showMainWindow = () => { dashboardShows++; };
  h.main.tray.createTray();
  assert.equal(h.created().length, 0, 'no flyout renderer exists until the first click');
  const tray = h.main.tray.icon;
  tray.emit('click');
  const [flyout] = h.created();
  assert.ok(flyout);
  assert.equal(flyout.visible, false);
  flyout.emit('ready-to-show');
  assert.equal(flyout.visible, true);
  assert.deepEqual(flyout.bounds, { x: 1522, y: 484, width: 380, height: 540 });
  tray.emit('double-click');
  assert.equal(flyout.visible, false);
  assert.equal(dashboardShows, 1);
  tray.emit('click');
  assert.equal(flyout.visible, false, 'the click after a double click does not reopen the flyout');
  // Right click keeps the native context menu.
  assert.equal(tray.listenerCount('right-click'), 0);
});

test('the flyout window is hardened like the dashboard and loads its own page', async () => {
  const h = mainHarness();
  h.main.tray.createFlyoutWindow({ width: 380, height: 540 });
  const [flyout] = h.created();
  const { options } = flyout;
  assert.equal(options.show, false);
  assert.equal(options.frame, false);
  assert.equal(options.resizable, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.backgroundColor, FLYOUT_BACKGROUND.dark);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.preload, path.join(root, 'electron', 'flyout-preload.cjs'));
  assert.equal(options.webPreferences.enablePreferredSizeMode, true);
  assert.deepEqual(flyout.loaded, { kind: 'file', value: path.join(root, 'dist', 'flyout.html') });

  const dev = mainHarness({ env: { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' } });
  dev.main.tray.createFlyoutWindow({ width: 380, height: 540 });
  assert.deepEqual(dev.created()[0].loaded, { kind: 'url', value: 'http://127.0.0.1:5173/flyout.html' });
  dev.electron.app.isPackaged = true;
  dev.main.tray.createFlyoutWindow({ width: 380, height: 540 });
  assert.equal(dev.created()[1].loaded.kind, 'file', 'a packaged build never loads a development URL');

  // A page that fails to load is dropped; the next click tries again.
  const failing = mainHarness();
  failing.main.tray.createTray();
  const previous = FakeWindow.loadResult;
  FakeWindow.loadResult = () => Promise.reject(new Error('missing flyout.html'));
  try {
    failing.main.tray.icon.emit('click');
    await flush();
  } finally {
    FakeWindow.loadResult = previous;
  }
  assert.equal(failing.created()[0].destroyed, true);
  assert.equal(failing.main.tray.flyout.window(), null);
  failing.main.tray.icon.emit('click');
  assert.equal(failing.created().length, 2);
});

function wiredHarness() {
  const h = mainHarness();
  const { main } = h;
  main.ipc.registerIpc();
  main.tray.createTray();
  main.dashboard.window = new h.electron.BrowserWindow({});
  main.tray.flyout.show();
  const dashboard = main.dashboard.window;
  const flyout = main.tray.flyout.window();
  flyout.emit('ready-to-show');
  return {
    ...h,
    dashboard,
    flyout,
    fromDashboard: { sender: dashboard.webContents, senderFrame: dashboard.webContents.mainFrame },
    fromFlyout: { sender: flyout.webContents, senderFrame: flyout.webContents.mainFrame },
  };
}

test('flyout channels refuse the dashboard and every dashboard channel refuses the flyout', () => {
  const h = wiredHarness();
  const flyoutChannels = [...h.handlers.keys()].filter((channel) => channel.startsWith('flyout:')).sort();
  assert.deepEqual(flyoutChannels, ['flyout:close', 'flyout:get-snapshot', 'flyout:open-dashboard', 'flyout:refresh', 'flyout:snooze']);
  assert.ok(h.handlers.has('dashboard:take-navigation'));
  const flyoutSubframe = { sender: h.flyout.webContents, senderFrame: { frame: 'embedded' } };
  const stranger = { sender: {}, senderFrame: {} };
  for (const [channel, handler] of h.handlers) {
    if (channel.startsWith('flyout:')) {
      for (const event of [h.fromDashboard, flyoutSubframe, stranger]) {
        assert.throws(() => handler(event), /only available from the AI Usage tray flyout/, channel);
      }
    } else {
      assert.throws(() => handler(h.fromFlyout), /only available from the AI Usage window/, channel);
    }
  }
  assert.equal(h.main.ipc.activeDashboardRequests, 0);
  // Once the flyout is released, its old frame is refused too.
  h.main.tray.flyout.destroy();
  assert.throws(() => h.handlers.get('flyout:close')(h.fromFlyout), /tray flyout/);
});

test('flyout channels read the tray snapshot, refresh, snooze and close through the main process', async () => {
  const h = wiredHarness();
  const { main } = h;
  let traySnapshots = 0;
  let refreshes = 0;
  const snoozes = [];
  main.store = {
    getTraySnapshot: () => { traySnapshots++; return { generatedAt: 'now', settings: { theme: 'light' }, sources: [],
      quotas: { codex: { forecast: { state: 'safe', series: { observed: [1], expected: [1], heavy: [1] } }, windows: [] } },
      dashboardVerdict: { state: 'safe' } }; },
    getDashboardSnapshot: () => { throw new Error('The flyout must not build a full dashboard snapshot'); },
  };
  main.refresh.refreshAll = async () => { refreshes++; };
  main.tray.setSnooze = async (hours) => { snoozes.push(hours); return { settings: { alertsSnoozedUntil: hours ? 'later' : null }, quotas: {}, costs: { actual: 1 } }; };
  const call = (channel, ...args) => h.handlers.get(channel)(h.fromFlyout, ...args);
  const first = await call('flyout:get-snapshot');
  assert.equal(first.quotas.codex.forecast.series.observed.length, 0);
  assert.equal(traySnapshots, 1);
  const refreshed = await call('flyout:refresh');
  assert.equal(refreshes, 1);
  assert.equal(refreshed.generatedAt, 'now');
  await assert.rejects(async () => call('flyout:snooze', -1), /Invalid snooze duration/);
  await assert.rejects(async () => call('flyout:snooze', 'soon'), /Invalid snooze duration/);
  const snoozed = await call('flyout:snooze', 1);
  assert.equal(snoozed.settings.alertsSnoozedUntil, 'later');
  assert.equal('costs' in snoozed, false);
  await call('flyout:snooze', 500);
  await call('flyout:snooze', 0);
  assert.deepEqual(snoozes, [1, 72, 0]);
  call('flyout:close');
  assert.equal(h.flyout.visible, false);
  main.lifecycle.isQuitting = true;
  main.lifecycle.shutdownPromise = Promise.resolve();
  assert.equal(await call('flyout:get-snapshot'), null, 'no snapshot while storage closes');
});

// Claude plan usage is read only on an explicit refresh; showing the flyout or
// the dashboard is automatic collection and must say so.
test('showing the flyout or the dashboard asks only for an automatic refresh', async () => {
  const h = mainHarness();
  const staleRequests = [];
  h.main.refresh.refreshIfStale = (options) => { staleRequests.push(options); };
  h.main.tray.createTray();
  h.main.tray.icon.emit('click');
  const [flyout] = h.created();
  flyout.emit('ready-to-show');
  assert.deepEqual(staleRequests, [{ trigger: 'flyout-show' }]);
  h.main.dashboard.createWindow();
  const dashboard = h.created().at(-1);
  dashboard.emit('show');
  assert.deepEqual(staleRequests.at(-1), { trigger: 'window-show' });
  await flush();
});

test('showing the dashboard while an update has closed storage does not read the closed database', () => {
  const h = mainHarness();
  h.main.lifecycle.preparingUpdate = true;
  h.main.store = { getSettings() { throw new Error('database is not open'); } };
  assert.doesNotThrow(() => h.main.refresh.refreshIfStale({ trigger: 'window-show' }));
});

test('a released dashboard reopens where it was only while that place is still on a display', () => {
  const h = mainHarness();
  const [{ workArea }] = h.electron.screen.getAllDisplays();
  h.main.dashboard.savedWindowBounds = { x: workArea.x + 40, y: workArea.y + 30, width: 900, height: 700 };
  h.main.dashboard.createWindow();
  assert.deepEqual(plain(h.created().at(-1).options).x, workArea.x + 40);
  // Released on a monitor that has since been disconnected: keep the size only.
  h.main.dashboard.savedWindowBounds = { x: workArea.x + workArea.width + 500, y: workArea.y, width: 900, height: 700 };
  h.main.dashboard.createWindow();
  const { x, y, width, height } = h.created().at(-1).options;
  assert.deepEqual({ x, y, width, height }, { x: undefined, y: undefined, width: 900, height: 700 });
});

test('a crashed dashboard renderer is reloaded on screen and released when hidden or failing again', () => {
  const h = mainHarness();
  h.main.dashboard.createWindow();
  const dashboard = h.created().at(-1);
  let reloads = 0;
  dashboard.webContents.reload = () => { reloads += 1; };
  dashboard.getNormalBounds = () => ({ x: 10, y: 20, width: 900, height: 700 });
  dashboard.isMaximized = () => false;
  dashboard.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  assert.equal(reloads, 0);
  dashboard.show();
  dashboard.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(reloads, 1, 'a visible window is reloaded');
  assert.equal(dashboard.destroyed, false);
  // Failing again straight after a reload must not loop.
  dashboard.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(reloads, 1);
  assert.equal(dashboard.destroyed, true);
  assert.deepEqual(plain(h.main.dashboard.savedWindowBounds), { x: 10, y: 20, width: 900, height: 700 });
  assert.equal(h.main.dashboard.window, null, 'the next open builds a fresh window');

  h.main.dashboard.createWindow();
  const hidden = h.created().at(-1);
  hidden.webContents.reload = () => { reloads += 1; };
  hidden.getNormalBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  hidden.isMaximized = () => false;
  hidden.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  assert.equal(reloads, 1, 'a hidden window is released, not reloaded');
  assert.equal(hidden.destroyed, true);
});

test('publishes reach an existing flyout as a light payload, and the theme sets its background', () => {
  const h = wiredHarness();
  const { main } = h;
  main.tray.trayIconFor = () => ({});
  main.tray.buildTrayMenu = () => null;
  main.store = { getSettings: () => ({}) };
  main.tray.updateTray({ generatedAt: 'now', settings: { theme: 'dark' }, sources: [], dashboardVerdict: { state: 'safe', affected: [], details: [] },
    quotas: { codex: null, claude: null, fable: null }, costs: { actual: 12 }, storage: { databasePath: 'C:\\data.sqlite' } });
  const [channel, payload] = h.flyout.webContents.sent.at(-1);
  assert.equal(channel, 'flyout:updated');
  assert.equal(payload.generatedAt, 'now');
  assert.equal('costs' in payload, false);
  assert.equal('storage' in payload, false);
  h.electron.nativeTheme.shouldUseDarkColors = false;
  main.dashboard.applyTheme('light');
  assert.equal(h.flyout.background, FLYOUT_BACKGROUND.light);
  main.tray.flyout.destroy();
  assert.doesNotThrow(() => main.tray.updateTray({ dashboardVerdict: { state: 'safe' } }));
});

test('opening the dashboard from the flyout queues the page until the dashboard renderer collects it', () => {
  const h = wiredHarness();
  const { main } = h;
  let dashboardShows = 0;
  main.dashboard.showMainWindow = () => { dashboardShows++; };
  const open = (value) => h.handlers.get('flyout:open-dashboard')(h.fromFlyout, value);
  const take = (event = h.fromDashboard) => h.handlers.get('dashboard:take-navigation')(event);
  for (const invalid of [{ tab: 'secrets' }, { tab: 'overview', provider: 'openai' }, { tab: 'settings', extra: 1 }, 'settings', null]) {
    assert.throws(() => open(invalid), /Unknown dashboard page/);
  }
  assert.equal(dashboardShows, 0, 'an invalid page opens nothing');
  assert.equal(take(), null);

  open({ tab: 'overview', provider: 'fable' });
  assert.equal(dashboardShows, 1);
  assert.equal(h.flyout.visible, false, 'the flyout closes when the dashboard opens');
  assert.deepEqual(h.dashboard.webContents.sent.at(-1), ['dashboard:navigation-pending']);
  assert.deepEqual(take(), { tab: 'overview', provider: 'fable' });
  assert.equal(take(), null, 'each request is delivered once');
  assert.throws(() => take(h.fromFlyout), /only available from the AI Usage window/);

  open(undefined);
  assert.deepEqual(take(), { tab: 'overview' });

  // A released dashboard is recreated; its new renderer collects the page when it subscribes.
  const recreated = new h.electron.BrowserWindow({});
  main.dashboard.window = null;
  main.dashboard.showMainWindow = () => { main.dashboard.window = recreated; };
  open({ tab: 'settings' });
  assert.equal(main.dashboard.window, recreated);
  assert.deepEqual(recreated.webContents.sent.at(-1), ['dashboard:navigation-pending']);
  assert.throws(() => take(h.fromDashboard), /only available/, 'the destroyed dashboard frame is no longer trusted');
  assert.deepEqual(take({ sender: recreated.webContents, senderFrame: recreated.webContents.mainFrame }), { tab: 'settings' });
});

function loadPreload(file, respond = () => undefined) {
  let exposedName;
  let bridge;
  const invoked = [];
  const listeners = new Map();
  const context = {
    require: (id) => {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposedName = name; bridge = value; } },
        ipcRenderer: {
          invoke: async (channel, ...args) => {
            invoked.push([channel, ...args]);
            return respond(channel, ...args);
          },
          on: (channel, listener) => {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel).add(listener);
          },
          removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
        },
      };
    },
  };
  vm.runInNewContext(readRepoFile('electron', file), context);
  const emit = (channel, ...args) => { for (const listener of Array.from(listeners.get(channel) ?? [])) listener({ senderId: 'hidden' }, ...args); };
  return { exposedName, bridge, invoked, listeners, emit };
}

test('the flyout preload exposes only its own bridge over flyout channels', async () => {
  const p = loadPreload('flyout-preload.cjs', (channel) => {
    if (channel === 'flyout:snooze') throw new Error("Error invoking remote method 'flyout:snooze': Error: Invalid snooze duration.");
    return channel === 'flyout:get-snapshot' ? { generatedAt: 'now' } : undefined;
  });
  assert.equal(p.exposedName, 'aiUsageFlyout');
  assert.deepEqual(Object.keys(p.bridge).sort(), ['close', 'getSnapshot', 'onUpdated', 'openDashboard', 'refresh', 'snooze']);
  assert.deepEqual(await p.bridge.getSnapshot(), { generatedAt: 'now' });
  await p.bridge.refresh();
  await p.bridge.openDashboard({ tab: 'settings' });
  await p.bridge.close();
  await assert.rejects(p.bridge.snooze(1), { message: 'Invalid snooze duration.' });
  assert.deepEqual(p.invoked.map(([channel]) => channel), ['flyout:get-snapshot', 'flyout:refresh', 'flyout:open-dashboard', 'flyout:close', 'flyout:snooze']);
  assert.deepEqual(p.invoked[2], ['flyout:open-dashboard', { tab: 'settings' }]);
  let received;
  const off = p.bridge.onUpdated((...args) => { received = args; });
  p.emit('flyout:updated', { generatedAt: 'later' });
  assert.deepEqual(received, [{ generatedAt: 'later' }], 'the IPC event is never handed to the page');
  off();
  assert.equal(p.listeners.get('flyout:updated').size, 0);
});

test('dashboard onNavigate collects a pending page on subscribe and on each signal, exactly once', async () => {
  const pending = [];
  const p = loadPreload('preload.cjs', (channel) => (channel === 'dashboard:take-navigation' ? pending.shift() ?? null : undefined));
  const received = [];
  pending.push({ tab: 'settings' });
  const off = p.bridge.onNavigate((...args) => received.push(args));
  await flush();
  assert.deepEqual(received, [[{ tab: 'settings' }]], 'a page requested while loading arrives on subscribe');
  pending.push({ tab: 'costs' });
  p.emit('dashboard:navigation-pending');
  await flush();
  assert.deepEqual(received.at(-1), [{ tab: 'costs' }]);
  const second = p.bridge.onNavigate(() => {});
  assert.equal(p.listeners.get('dashboard:navigation-pending').size, 1, 'one signal listener however many subscribers');
  second();
  off();
  // Collected with nobody listening (between unsubscribe and subscribe): held for the next listener.
  pending.push({ tab: 'activity' });
  p.emit('dashboard:navigation-pending');
  await flush();
  const later = [];
  p.bridge.onNavigate((target) => later.push(target));
  await flush();
  assert.deepEqual(later, [{ tab: 'activity' }]);
  assert.equal(received.length, 2, 'unsubscribed listeners receive nothing');
  assert.ok(p.invoked.every(([channel]) => channel === 'dashboard:take-navigation'));
});

test('the flyout page shares the dashboard CSP, is built as its own entry and is required in the package', async () => {
  const csp = (html) => html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const flyoutHtml = readRepoFile('flyout.html');
  assert.equal(csp(flyoutHtml), csp(readRepoFile('index.html')));
  assert.doesNotMatch(csp(flyoutHtml), /https?:|ws:/);
  assert.match(flyoutHtml, /<title>AI Usage<\/title>/);
  assert.match(flyoutHtml, /src="\/src\/flyout\.tsx"/);
  const { loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(root, 'vite.config.ts'), root, 'silent');
  const input = loaded.config.build.rolldownOptions.input;
  assert.deepEqual(Object.values(input).map((file) => path.basename(file)).sort(), ['flyout.html', 'index.html']);
  const devCsp = loaded.config.plugins.flat().find((plugin) => plugin?.name === 'dev-loopback-csp');
  assert.match(devCsp.transformIndexHtml(flyoutHtml), /connect-src 'self' http:\/\/127\.0\.0\.1:\* ws:\/\/127\.0\.0\.1:\*/);
  const pkg = JSON.parse(readRepoFile('package.json'));
  assert.ok(pkg.build.files.includes('dist/**/*') && pkg.build.files.includes('electron/**/*'));
  for (const previewOnly of ['!dist/assets/demo-*.js', '!dist/assets/flyout-preview-*.js'])
    assert.ok(pkg.build.files.includes(previewOnly), `the release leaves out ${previewOnly.slice(1)}`);
  const entries = ['dist/index.html', 'dist/flyout.html', 'electron/main.cjs', 'electron/preload.cjs', 'electron/flyout-preload.cjs',
    'electron/maintenance-host.cjs', 'electron/maintenance-service.cjs', 'electron/desktop-estimates.cjs', 'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    'claude-code-mod/.claude-plugin/plugin.json', 'claude-code-mod/hooks/hooks.json', 'claude-code-mod/hooks/register.js', 'claude-code-mod/hooks/view.js'];
  assert.doesNotThrow(() => assertArchive(entries));
  for (const required of ['dist/flyout.html', 'electron/flyout-preload.cjs']) {
    assert.throws(() => assertArchive(entries.filter((entry) => entry !== required)), /required application file/);
  }
});

// Server-rendered TrayFlyout, as the dashboard's renderer tests do.
let server;
let demoSnapshot;
let flyoutModule;
let providerViews;
let budget;

test.before(async () => {
  server = await startRendererServer();
  [{ demoSnapshot }, flyoutModule, { providerViews }, budget] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/components/TrayFlyout.tsx'),
    server.ssrLoadModule('/src/provider-view.ts'),
    server.ssrLoadModule('/src/budget.ts'),
  ]);
});

test.after(async () => { await server?.close(); });

function renderFlyout(snapshot, props = {}) {
  const nowMs = snapshot?.generatedAt ? Date.parse(snapshot.generatedAt) : Date.parse('2026-09-23T10:00:00.000Z');
  return renderToStaticMarkup(React.createElement(flyoutModule.TrayFlyout, { snapshot, nowMs, ...props }));
}

function rows(html) {
  return html.split('<li>').slice(1).map((row) => row.split('</li>')[0]);
}

test('the demo snapshot renders the verdict, three allowance rows and their forecasts', () => {
  const html = renderFlyout(demoSnapshot);
  const all = text(html);
  const views = providerViews(demoSnapshot);
  assert.match(all, /AI Usage/);
  assert.match(all, /Updated 2 min ago/);
  assert.match(all, new RegExp(demoSnapshot.dashboardVerdict.label));
  // The affected provider has a daily budget, so the verdict gives the pace to keep.
  const affected = views.find((view) => view.id === demoSnapshot.dashboardVerdict.details[0].sourceId);
  const pace = budget.dailyBudget(affected.current, demoSnapshot.settings, Date.parse(demoSnapshot.generatedAt));
  assert.ok(all.includes(`Stay under ${budget.paceLabel(pace.budget)} a day to reach the reset.`));
  // The compact Deck annunciator takes the verdict's forecast state as its tone.
  assert.match(html, /class="annunciator flyout-verdict" data-tone="risk"/);
  const rendered = rows(html);
  assert.equal(rendered.length, 3);
  const statusWords = { safe: 'On track', watch: 'Watch', risk: 'At risk', critical: 'Critical', unknown: 'Learning' };
  views.forEach((view, index) => {
    const row = text(rendered[index]);
    assert.match(rendered[index], new RegExp(`data-provider="${view.id}"`));
    assert.ok(row.startsWith(view.name), row);
    assert.ok(row.includes(`${Math.round(view.remaining)}% left`), row);
    assert.ok(row.includes(`${view.expectedRemaining.toFixed(0)}% at reset`), row);
    assert.ok(row.includes(statusWords[view.state]), row);
    assert.match(rendered[index], /role="img" aria-label="[^"]*left now; about \d+% expected to be left at reset"/);
    // The Deck mini fuel tape is vertical, so the fills are sized by height.
    assert.match(rendered[index], /flyout-fill-used" style="height:[\d.]+%"/);
    assert.match(rendered[index], /flyout-fill-reset" style="height:[\d.]+%"/);
  });
  assert.deepEqual(views.map((view) => statusWords[view.state]), ['On track', 'On track', 'At risk']);
  assert.match(all, /Left at reset Likely used before reset/);
  assert.match(all, /Open dashboard/);
  assert.match(all, /Snooze 1 h/);
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /aria-label="Refresh now"/);
  assert.doesNotMatch(all, /Resume alerts/);
});

test('a missing quota renders an honest empty row with no invented percentage', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.quotas.fable = null;
  const html = renderFlyout(snapshot);
  const fable = rows(html).find((row) => row.includes('data-provider="fable"'));
  const row = text(fable);
  assert.match(row, /Learning/);
  assert.match(row, /Waiting for a reading/);
  assert.match(row, /No reading/);
  assert.doesNotMatch(row, /\d+%|0%/);
  assert.doesNotMatch(fable, /flyout-fill/);
  assert.match(fable, /aria-label="No allowance reading yet"/);
  // Codex and Claude are unaffected.
  assert.equal(rows(html).filter((entry) => /\d+% at reset/.test(text(entry))).length, 2);
});

test('safe, snoozed, hidden, loading, unavailable and malformed snapshots all render without fake numbers', () => {
  const { buildDashboardVerdict } = require('../../electron/dashboard-decision.cjs');
  const safe = structuredClone(demoSnapshot);
  safe.dashboardVerdict = { state: 'safe', reason: null, label: 'All allowances on track', windowsChecked: 3, affected: [], details: [] };
  const safeHtml = renderFlyout(safe);
  assert.match(text(safeHtml), /All allowances on track/);
  assert.match(safeHtml, /class="annunciator flyout-verdict" data-tone="safe"/);

  const snoozed = structuredClone(demoSnapshot);
  snoozed.settings.alertsSnoozedUntil = new Date(Date.parse(snoozed.generatedAt) + 3_600_000).toISOString();
  assert.match(text(renderFlyout(snoozed)), /Resume alerts/);
  assert.doesNotMatch(text(renderFlyout(snoozed)), /Snooze 1 h/);
  snoozed.settings.alertsSnoozedUntil = new Date(Date.parse(snoozed.generatedAt) - 1).toISOString();
  assert.match(text(renderFlyout(snoozed)), /Snooze 1 h/);

  const onlyCodex = structuredClone(demoSnapshot);
  onlyCodex.settings.showClaudeSubscription = false;
  onlyCodex.dashboardVerdict = buildDashboardVerdict(onlyCodex);
  const codexHtml = renderFlyout(onlyCodex);
  assert.equal(rows(codexHtml).length, 1);
  assert.doesNotMatch(text(codexHtml), /Claude|Fable/);
  const none = { ...onlyCodex, settings: { ...onlyCodex.settings, showCodexSubscription: false } };
  assert.match(text(renderFlyout(none)), /No subscriptions shown/);

  assert.match(text(renderFlyout(undefined)), /Loading allowances/);
  assert.match(text(renderFlyout(null)), /Allowances are unavailable right now/);
  for (const html of [renderFlyout(undefined), renderFlyout(null)]) {
    assert.equal(rows(html).length, 0);
    assert.doesNotMatch(text(html), /\d%/);
  }

  const { normalizeFlyoutSnapshot } = flyoutModule;
  assert.equal(normalizeFlyoutSnapshot(null), null);
  assert.equal(normalizeFlyoutSnapshot('snapshot'), null);
  const empty = normalizeFlyoutSnapshot({});
  const emptyHtml = renderFlyout(empty);
  assert.equal(rows(emptyHtml).length, 3);
  assert.match(text(emptyHtml), /Waiting for allowance readings/);
  assert.match(text(emptyHtml), /Not updated yet/);
  assert.doesNotMatch(text(emptyHtml), /\d%/);
  const malformed = normalizeFlyoutSnapshot({
    generatedAt: 42, settings: 'dark', sources: [null, 7],
    quotas: { codex: { forecast: null }, claude: { remainingPercent: 40 }, fable: 'full' },
    dashboardVerdict: { state: 'panic', label: 3 },
  });
  assert.deepEqual(malformed.quotas, { codex: null, claude: null, fable: null });
  assert.equal(malformed.dashboardVerdict.state, 'unknown');
  assert.doesNotMatch(text(renderFlyout(malformed)), /\d%/);
  // Normalising a real payload keeps every figure.
  const normalized = normalizeFlyoutSnapshot(plain(flyoutPayload(demoSnapshot)));
  assert.equal(rows(renderFlyout(normalized)).length, 3);
  assert.match(text(renderFlyout(normalized)), /\d+% at reset/);
});

test('guidance budgets the window the verdict names and never quotes a weekly pace for a five-hour session', () => {
  const snapshot = structuredClone(demoSnapshot);
  const weekly = snapshot.quotas.claude.windows[0];
  weekly.forecast = { ...weekly.forecast, state: 'safe' };
  const session = { ...structuredClone(weekly), bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300,
    resetsAt: new Date(Date.parse(snapshot.generatedAt) + 3 * 3_600_000).toISOString() };
  session.forecast = { ...session.forecast, state: 'risk', activeHoursLeft: 3, heavyExhaustsAt: null };
  snapshot.quotas.claude = { ...weekly, windows: [weekly, session] };
  snapshot.dashboardVerdict = { ...snapshot.dashboardVerdict, state: 'risk', label: 'Claude 5-hour session could run out',
    details: [{ sourceId: 'claude', bucketId: 'five_hour', bucketName: 'Five hour', state: 'risk', reasons: ['pace'] }] };
  const all = text(renderFlyout(snapshot));
  assert.match(all, /Claude 5-hour session could run out/);
  assert.doesNotMatch(all, /Stay under/, 'a five-hour window has no daily budget, and the weekly one is not what the verdict names');
});

test('a provider that is still learning draws its balance outlined, not as a forecast', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const entry of [snapshot.quotas.codex, ...snapshot.quotas.codex.windows]) {
    entry.forecast = { ...entry.forecast, state: 'unknown', expectedRemaining: null, heavyRemaining: null };
  }
  const codexRow = rows(renderFlyout(snapshot))[0];
  assert.match(codexRow, /flyout-fill flyout-fill-now/);
  assert.doesNotMatch(codexRow, /flyout-fill-used|flyout-fill-reset/);
});

test('the verdict annunciator keeps a partial all-clear neutral and marks a failed read as a failure', () => {
  const { buildDashboardVerdict } = require('../../electron/dashboard-decision.cjs');
  const verdictOf = (html) => html.match(/<section class="annunciator flyout-verdict"[\s\S]*?<\/section>/)[0];
  // A real partial: Fable is still learning, so the backend verdict is unknown and names it.
  const partial = structuredClone(demoSnapshot);
  for (const entry of [partial.quotas.fable, ...(partial.quotas.fable.windows ?? [])]) {
    entry.forecast = { ...entry.forecast, state: 'unknown', expectedRemaining: null, heavyRemaining: null };
  }
  partial.dashboardVerdict = buildDashboardVerdict(partial);
  const partialVerdict = verdictOf(renderFlyout(partial));
  assert.match(partialVerdict, /data-tone="unknown"/);
  assert.match(text(partialVerdict), /^Usage status needs data: Fable/);
  assert.match(text(partialVerdict), /Codex and Claude are on track\./);
  assert.doesNotMatch(partialVerdict, /circle-check/, 'green and its check belong to a verdict that assessed every allowance');
  // Positive control for the icon names; Watch keeps the warning triangle.
  const icons = {
    safe: /lucide-circle-check/,
    watch: /lucide-triangle-alert/,
    risk: /lucide-triangle-alert/,
    critical: /lucide-octagon-alert/,
    unknown: /lucide-circle-dashed/,
  };
  for (const [state, icon] of Object.entries(icons)) {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.dashboardVerdict = { ...snapshot.dashboardVerdict, state };
    assert.match(verdictOf(renderFlyout(snapshot)), icon, `${state} verdict lozenge`);
  }
  assert.match(renderFlyout(null), /data-tone="unknown"/, 'a store that is only closing is a neutral wait');
  const failed = renderFlyout(null, { error: 'The local usage store could not be opened.' });
  assert.match(failed, /data-tone="failure"/);
  assert.match(failed, /role="alert"[^>]*>[\s\S]*The local usage store could not be opened\./);
});

test('an allowance on watch keeps the warning triangle and the word in its row', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const entry of [snapshot.quotas.codex, ...(snapshot.quotas.codex.windows ?? [])]) {
    entry.forecast = { ...entry.forecast, state: 'watch' };
  }
  const codex = rows(renderFlyout(snapshot)).find((row) => row.includes('data-provider="codex"'));
  assert.match(text(codex), /Watch/);
  assert.match(codex, /lucide-triangle-alert/);
  assert.doesNotMatch(codex, /lucide-eye/);
});

test('demo data reaches only the browser preview of the flyout; Electron renders from the preload bridge', () => {
  const entry = readRepoFile('src', 'flyout.tsx');
  assert.match(entry, /const isBrowserPreview = !window\.aiUsageFlyout && window\.location\.protocol !== 'file:';/);
  assert.match(entry, /if \(isBrowserPreview\) \{\s*void import\('\.\/flyout-preview'\)/);
  assert.match(entry, /\} else \{\s*render\(\);\s*\}/, 'Electron passes no bridge prop');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const file of walk(path.join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(from|import)\s+['"][./]*flyout-preview['"]/, `${file} must not import the preview adapter statically`);
  }
  const flyout = readRepoFile('src', 'components', 'TrayFlyout.tsx');
  assert.match(flyout, /previewBridge \?\? \(typeof window === 'undefined' \? undefined : window\.aiUsageFlyout\)/);
});
