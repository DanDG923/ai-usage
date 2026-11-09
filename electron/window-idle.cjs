'use strict';

// The renderer must consent after checking its current forms and dialogs.
// Missing, stale or negative replies keep the window intact. Only a hidden
// window is released; minimising it is deliberately different from closing it.
/**
 * @param {object} options
 * @param {import('electron').BrowserWindow} options.window
 * @param {() => boolean} options.isBusy
 * @param {() => void} options.onRelease Called just before the window is destroyed.
 * @param {number} [options.idleMs]
 */
function createWindowIdleRelease({ window, isBusy, onRelease, idleMs = 30_000 }) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let generation = 0;
  /** @type {number | null} */
  let requested = null;
  const hidden = () => !window.isDestroyed() && !window.isVisible();
  function cancel() {
    clearTimeout(timer);
    requested = null;
    generation++;
  }
  function schedule() {
    cancel();
    if (!hidden()) return;
    timer = setTimeout(() => {
      if (!hidden()) return;
      if (!isBusy()) {
        requested = ++generation;
        window.webContents.send('dashboard:prepare-sleep', requested);
      }
      // Retry if a dialog, a save, or a loading renderer declined the request.
      timer = setTimeout(schedule, idleMs);
      timer.unref?.();
    }, idleMs);
    timer.unref?.();
  }
  // Both values arrive from the renderer and are compared, never trusted.
  /**
   * @param {unknown} token
   * @param {unknown} allowed
   */
  function reply(token, allowed) {
    if (allowed !== true || token !== requested || requested === null || !hidden() || isBusy()) return false;
    clearTimeout(timer);
    // Let the IPC reply complete before destroying its sending frame.
    timer = setTimeout(() => {
      if (token !== requested || !hidden() || isBusy()) { schedule(); return; }
      onRelease();
      window.destroy();
    }, 0);
    return true;
  }
  window.on('hide', schedule);
  window.on('show', cancel);
  window.on('closed', cancel);
  return { schedule, cancel, reply };
}

module.exports = { createWindowIdleRelease };
