'use strict';

const WINDOW_BOUNDS = Object.freeze({
  width: 1600,
  height: 1000,
  minWidth: 720,
  minHeight: 720,
});

function registerSingleInstance(app, onSecondInstance) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', onSecondInstance);
  return true;
}

function revealWindow(currentWindow, createWindow) {
  const mustCreate = !currentWindow
    || (typeof currentWindow.isDestroyed === 'function' && currentWindow.isDestroyed());
  const target = mustCreate ? createWindow() : currentWindow;
  if (typeof target.isMinimized === 'function' && target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

function createDeferredWindowReveal(reveal) {
  let ready = false;
  let pending = false;
  return {
    request() {
      if (!ready) {
        pending = true;
        return;
      }
      reveal();
    },
    markReady() {
      if (ready) return;
      ready = true;
      if (!pending) return;
      pending = false;
      reveal();
    },
  };
}

async function initializeWithVisibleFailure({ initialize, onFailure }) {
  for (;;) {
    try {
      await initialize();
      return true;
    } catch (error) {
      const action = await onFailure(error);
      if (action !== 'retry') return false;
    }
  }
}

// The bounds a released window is recreated with. Windows does not move a new
// window that lies off every display, so bounds saved on a monitor that has
// since been disconnected keep only their size and let the window be placed
// afresh. A sliver at an edge is not enough to find and drag it back.
const MIN_VISIBLE_PX = 64;
function restorableBounds(bounds, displays) {
  if (!bounds) return {};
  const overlaps = (displays || []).some(({ workArea: area }) =>
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= MIN_VISIBLE_PX
    && Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y) >= MIN_VISIBLE_PX);
  return overlaps ? bounds : { width: bounds.width, height: bounds.height };
}

function resolveWindowTarget({ isPackaged, devUrl, filePath }) {
  if (!isPackaged && devUrl) return { kind: 'url', value: devUrl };
  return { kind: 'file', value: filePath };
}

// Shutdown work must never hold the process open indefinitely. A deadline can
// span several awaited steps; `expired` tells a catch block whether it was the
// deadline that fired. The timer is unref'd so it cannot itself keep an
// otherwise finished process alive.
function createDeadline(timeoutMs, message) {
  const deadline = { expired: false, expiry: /** @type {Promise<never>} */ (/** @type {unknown} */ (null)), cancel: () => {} };
  deadline.expiry = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      deadline.expired = true;
      reject(new Error(message));
    }, timeoutMs);
    timer.unref?.();
    deadline.cancel = () => clearTimeout(timer);
  });
  // A deadline that nobody is racing any more must not surface as unhandled.
  deadline.expiry.catch(() => {});
  return deadline;
}

function settleWithin(promise, timeoutMs, message) {
  const deadline = createDeadline(timeoutMs, message);
  return Promise.race([promise, deadline.expiry]).finally(deadline.cancel);
}

module.exports = {
  createDeadline,
  settleWithin,
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  restorableBounds,
  revealWindow,
};
