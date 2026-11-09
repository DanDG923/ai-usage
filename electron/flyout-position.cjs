'use strict';

// Where the tray flyout opens: against the taskbar, centred on the tray icon,
// and wholly inside the work area of the display the icon is on. Kept free of
// Electron so every taskbar edge can be tested without a screen.

const FLYOUT_MARGIN = 8;
const EDGES = ['bottom', 'top', 'left', 'right'];

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * @param {any} rect
 * @returns {rect is Rect}
 */
function isRect(rect) {
  return Boolean(rect) && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]));
}

// Windows reports an empty rectangle for an icon it cannot locate.
/**
 * @param {any} rect
 * @returns {rect is Rect}
 */
function isUsableIcon(rect) {
  return isRect(rect) && rect.width > 0 && rect.height > 0;
}

function nearestEdge(distances) {
  return EDGES.reduce((best, edge) => (distances[edge] < distances[best] ? edge : best), EDGES[0]);
}

/**
 * The screen edge the taskbar occupies. The work area is the display minus the
 * taskbar, so the widest gap between them is the taskbar. An auto-hidden
 * taskbar leaves no gap; the edge nearest the icon is the one it slides from.
 */
/** @param {{ trayBounds?: Rect, workArea?: Rect, displayBounds?: Rect }} [anchor] */
function taskbarEdge({ trayBounds, workArea, displayBounds } = {}) {
  if (!isRect(workArea)) return 'bottom';
  if (isRect(displayBounds)) {
    const gaps = {
      bottom: displayBounds.y + displayBounds.height - (workArea.y + workArea.height),
      top: workArea.y - displayBounds.y,
      left: workArea.x - displayBounds.x,
      right: displayBounds.x + displayBounds.width - (workArea.x + workArea.width),
    };
    const widest = EDGES.reduce((best, edge) => (gaps[edge] > gaps[best] ? edge : best), EDGES[0]);
    if (gaps[widest] > 0) return widest;
  }
  if (!isUsableIcon(trayBounds)) return 'bottom';
  const area = isRect(displayBounds) ? displayBounds : workArea;
  const centreX = trayBounds.x + trayBounds.width / 2;
  const centreY = trayBounds.y + trayBounds.height / 2;
  return nearestEdge({
    bottom: area.y + area.height - centreY,
    top: centreY - area.y,
    left: centreX - area.x,
    right: area.x + area.width - centreX,
  });
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Integer bounds for a flyout of the requested size. The flyout sits `margin`
 * pixels off the taskbar, centred on the icon along it, then is clamped so the
 * whole window stays inside the work area with the same margin. An icon Windows
 * cannot locate opens the flyout in the notification-area corner. Returns null
 * when there is no usable work area.
 */
/** @param {{ trayBounds?: Rect, workArea?: Rect, displayBounds?: Rect, width?: number, height?: number, margin?: number }} [request] */
function flyoutBounds({ trayBounds, workArea, displayBounds, width, height, margin = FLYOUT_MARGIN } = {}) {
  if (!isRect(workArea) || workArea.width <= 0 || workArea.height <= 0) return null;
  const edge = taskbarEdge({ trayBounds, workArea, displayBounds });
  const fittedWidth = Math.max(0, Math.min(Number(width) || 0, workArea.width - 2 * margin));
  const fittedHeight = Math.max(0, Math.min(Number(height) || 0, workArea.height - 2 * margin));
  const left = workArea.x;
  const top = workArea.y;
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;
  let x;
  let y;
  if (isUsableIcon(trayBounds)) {
    const centreX = trayBounds.x + trayBounds.width / 2;
    const centreY = trayBounds.y + trayBounds.height / 2;
    switch (edge) {
      case 'top':
        x = centreX - fittedWidth / 2;
        y = Math.max(top, trayBounds.y + trayBounds.height) + margin;
        break;
      case 'left':
        x = Math.max(left, trayBounds.x + trayBounds.width) + margin;
        y = centreY - fittedHeight / 2;
        break;
      case 'right':
        x = Math.min(right, trayBounds.x) - margin - fittedWidth;
        y = centreY - fittedHeight / 2;
        break;
      default:
        // An icon in the overflow panel sits inside the work area; open above it.
        x = centreX - fittedWidth / 2;
        y = Math.min(bottom, trayBounds.y) - margin - fittedHeight;
    }
  } else {
    x = edge === 'left' ? left + margin : right - margin - fittedWidth;
    y = edge === 'top' ? top + margin : bottom - margin - fittedHeight;
  }
  return {
    x: Math.round(clamp(x, left + margin, right - margin - fittedWidth)),
    y: Math.round(clamp(y, top + margin, bottom - margin - fittedHeight)),
    width: Math.round(fittedWidth),
    height: Math.round(fittedHeight),
  };
}

module.exports = { FLYOUT_MARGIN, flyoutBounds, taskbarEdge };
