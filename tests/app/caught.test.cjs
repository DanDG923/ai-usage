require('../setup.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { errorCode, errorMessage } = require('../../electron/caught.cjs');

const errno = Object.assign(new Error('no such file'), { code: 'ENOENT', errno: -2 });

test('errorCode reads a code the way error?.code does', () => {
  assert.equal(errorCode(new Error('plain')), undefined);
  assert.equal(errorCode(errno), 'ENOENT');
  assert.equal(errorCode({ code: 7 }), 7);
  assert.equal(errorCode({ reason: 'no code' }), undefined);
  assert.equal(errorCode('ENOENT'), undefined);
  assert.equal(errorCode(null), undefined);
  assert.equal(errorCode(undefined), undefined);
});

test('errorMessage reads a message the way error?.message does', () => {
  assert.equal(errorMessage(new Error('plain')), 'plain');
  assert.equal(errorMessage(errno), 'no such file');
  assert.equal(errorMessage({ message: 'from an object' }), 'from an object');
  assert.equal(errorMessage({ code: 'X' }), undefined);
  assert.equal(errorMessage('a thrown string'), undefined);
  assert.equal(errorMessage(null), undefined);
  assert.equal(errorMessage(undefined), undefined);
});
