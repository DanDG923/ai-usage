'use strict';

// The renderer must consent after checking its current forms and dialogs.
// Missing, stale or negative replies keep the window intact. Only a hidden
// window is released; minimising it is deliberately different from closing it.
function createWindowIdleRelease({ window, isBusy, onRelease, idleMs = 30_000 }) {
  let timer;
  let generation = 0;
  /** @type {any} */
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
