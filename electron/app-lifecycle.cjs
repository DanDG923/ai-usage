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

module.exports = {
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  revealWindow,
};
