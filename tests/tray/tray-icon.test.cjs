'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { STATE_COLORS, paintStateDot } = require('../../electron/tray-icon.cjs');

function pixel(buffer, width, x, y) {
  const offset = (y * width + x) * 4;
  return { b: buffer[offset], g: buffer[offset + 1], r: buffer[offset + 2], a: buffer[offset + 3] };
}

test('paintStateDot draws a solid state-coloured dot in the bottom-right corner and leaves the rest alone', () => {
  const size = 32;
  const bitmap = Buffer.alloc(size * size * 4, 0);
  paintStateDot(bitmap, size, size, 'risk');
  const [r, g, b] = STATE_COLORS.risk;
  const centre = pixel(bitmap, size, size - 7, size - 7);
  assert.deepEqual({ r: centre.r, g: centre.g, b: centre.b }, { r, g, b });
  assert.equal(centre.a, 255);
  assert.deepEqual(pixel(bitmap, size, 2, 2), { b: 0, g: 0, r: 0, a: 0 });
});

test('unknown states fall back to the neutral colour and the outline keeps the dot readable', () => {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4, 255);
  paintStateDot(bitmap, size, size, 'nonsense');
  const [r, g, b] = STATE_COLORS.unknown;
  const centre = pixel(bitmap, size, size - 4, size - 4);
  assert.deepEqual({ r: centre.r, g: centre.g, b: centre.b }, { r, g, b });
  // Just outside the dot, the dark outline has darkened the white background.
  const edge = pixel(bitmap, size, size - 4, size - 8);
  assert.ok(edge.r < 255 && edge.g < 255 && edge.b < 255);
});
