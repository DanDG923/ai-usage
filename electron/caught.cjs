'use strict';

// A `catch` binding is typed `unknown`, because anything can be thrown. These
// read one field of it exactly as `error?.code` and `error?.message` would: an
// Error gives its field, and an object without one, a string, a number, null
// or undefined gives undefined. The value is returned as it is, unchecked, so
// a caller that tests it for truth or compares it behaves as it did before.

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  return /** @type {{ code?: unknown } | null | undefined} */ (error)?.code;
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorMessage(error) {
  return /** @type {{ message?: unknown } | null | undefined} */ (error)?.message;
}

module.exports = { errorCode, errorMessage };
