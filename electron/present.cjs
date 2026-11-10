'use strict';

// `Boolean`, with a type that says what filtering by it does: the nulls and
// undefineds leave the element type as well as the array.

/** @type {<T>(value: T | null | undefined | false | 0 | '') => value is T} */
const present = /** @type {any} */ (Boolean);

module.exports = { present };
