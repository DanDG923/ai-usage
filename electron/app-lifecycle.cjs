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

function resolveWindowTarget({ isPackaged, devUrl, filePath }) {
  if (!isPackaged && devUrl) return { kind: 'url', value: devUrl };
  return { kind: 'file', value: filePath };
}

// Shutdown work must never hold the process open indefinitely. The timer is
// unref'd so it cannot itself keep an otherwise finished process alive.
function settleWithin(promise, timeoutMs, message) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

module.exports = {
  settleWithin,
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  revealWindow,
};
