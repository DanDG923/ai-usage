'use strict';

// The tray icon is the app icon with a state dot painted into its corner. The
// main process has no canvas, but nativeImage can hand over its BGRA bitmap
// and take one back, so the dot is drawn directly into the pixel buffer.
// Flight Deck status colours (src/styles/tokens.css, night set): ok #3ecf7a,
// caution #f2a93b for watch and at risk, warning #ff5f52 for critical, and
// text-3 #7d848e while the state is unknown.
/** @type {Record<import('./types').ForecastState, number[]>} */
const STATE_COLORS = {
  safe: [0x3e, 0xcf, 0x7a],
  watch: [0xf2, 0xa9, 0x3b],
  risk: [0xf2, 0xa9, 0x3b],
  critical: [0xff, 0x5f, 0x52],
  unknown: [0x7d, 0x84, 0x8e],
};

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number[]} rgb
 * @param {number} alpha
 */
function blend(buffer, offset, rgb, alpha) {
  // BGRA byte order, straight alpha in the output.
  const [red, green, blue] = rgb;
  const existingAlpha = buffer[offset + 3] / 255;
  const outAlpha = alpha + existingAlpha * (1 - alpha);
  /**
   * @param {number} channelIndex
   * @param {number} value
   */
  const mix = (channelIndex, value) => {
    const existing = buffer[offset + channelIndex];
    const result = outAlpha > 0 ? (value * alpha + existing * existingAlpha * (1 - alpha)) / outAlpha : value;
    buffer[offset + channelIndex] = Math.round(result);
  };
  mix(0, blue);
  mix(1, green);
  mix(2, red);
  buffer[offset + 3] = Math.round(outAlpha * 255);
}

/**
 * @param {Buffer} bitmap
 * @param {number} width
 * @param {number} height
 * @param {string} state
 * @param {{ radius?: number, centerX?: number, centerY?: number }} [options]
 */
function paintStateDot(bitmap, width, height, state, options = {}) {
  // Any other name has no colour of its own and takes the unknown one.
  const rgb = STATE_COLORS[/** @type {import('./types').ForecastState} */ (state)] || STATE_COLORS.unknown;
  const radius = options.radius ?? Math.max(3, Math.round(Math.min(width, height) * 0.2));
  const centerX = options.centerX ?? width - radius - 1;
  const centerY = options.centerY ?? height - radius - 1;
  const ring = radius + 1.2;
  for (let y = Math.max(0, Math.floor(centerY - ring - 1)); y <= Math.min(height - 1, Math.ceil(centerY + ring + 1)); y += 1) {
    for (let x = Math.max(0, Math.floor(centerX - ring - 1)); x <= Math.min(width - 1, Math.ceil(centerX + ring + 1)); x += 1) {
      const distance = Math.hypot(x + 0.5 - centerX - 0.5, y + 0.5 - centerY - 0.5);
      const offset = (y * width + x) * 4;
      if (distance <= ring) {
        // Dark outline keeps the dot readable on light and dark taskbars.
        const outlineAlpha = Math.max(0, Math.min(1, ring - distance));
        blend(bitmap, offset, [0x07, 0x10, 0x1e], outlineAlpha);
      }
      if (distance <= radius) {
        const alpha = Math.max(0, Math.min(1, radius - distance + 0.5));
        blend(bitmap, offset, rgb, alpha);
      }
    }
  }
  return bitmap;
}

module.exports = { STATE_COLORS, paintStateDot };
