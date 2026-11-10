'use strict';

// For the type checker only. An object literal in a JavaScript file is open:
// any property name may be read from it, so a misspelt `refresh.refreshAl()`
// passes. Returning the same object through this gives it a closed shape, in
// which only the members written in the literal exist.

/**
 * @template T
 * @param {T} members
 * @returns {{ [K in keyof T]: T[K] }}
 */
function closed(members) {
  return members;
}

module.exports = { closed };
