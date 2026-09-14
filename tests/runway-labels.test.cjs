'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { spreadRunwayLabels } = require('../src/components/details/runway-labels.ts');

for (const values of [[20, 22, 23], [300, 302, 316], [160, 160, 160]]) {
  test(`runway annotations stay separate and within the plot for ${values.join(', ')}`, () => {
    const labels = values.map((y, index) => ({ id: `provider-${index}`, y }));
    const original = structuredClone(labels);
    const result = spreadRunwayLabels(labels, 34, 303);
    assert.deepEqual(labels, original, 'layout must not move the underlying endpoint data');
    assert.deepEqual(new Set(result.map((label) => label.id)), new Set(labels.map((label) => label.id)));
    assert.ok(result.every((label) => label.y >= 34 && label.y <= 303));
    for (let index = 1; index < result.length; index += 1) assert.ok(result[index].y - result[index - 1].y >= 32);
  });
}

test('well-separated runway annotations retain their endpoint alignment', () => {
  const labels = [{ id: 'codex', y: 80 }, { id: 'claude', y: 160 }, { id: 'fable', y: 250 }];
  assert.deepEqual(spreadRunwayLabels(labels, 34, 303), labels);
  assert.deepEqual(spreadRunwayLabels([], 34, 303), []);
});
