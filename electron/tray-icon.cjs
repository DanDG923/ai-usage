'use strict';

// The tray icon is the app icon with a state dot painted into its corner. The
// main process has no canvas, but nativeImage can hand over its BGRA bitmap
// and take one back, so the dot is drawn directly into the pixel buffer.
const STATE_COLORS = {
  safe: [0x0f, 0xa3, 0x82],
  watch: [0xbd, 0x81, 0x21],
  risk: [0xe0, 0x6a, 0x4c],
  critical: [0xe0, 0x6a, 0x4c],
  unknown: [0x89, 0x97, 0xb1],
};

function blend(buffer, offset, rgb, alpha) {
  // BGRA byte order, straight alpha in the output.
  const [red, green, blue] = rgb;
  const existingAlpha = buffer[offset + 3] / 255;
  const outAlpha = alpha + existingAlpha * (1 - alpha);
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

function paintStateDot(bitmap, width, height, state, options = {}) {
  const rgb = STATE_COLORS[state] || STATE_COLORS.unknown;
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
