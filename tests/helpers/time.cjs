'use strict';

// Small time and number helpers shared by quota, cost and forecast tests.

const assert = require('node:assert/strict');

// An epoch millisecond time as an ISO 8601 string.
const iso = (at) => new Date(at).toISOString();

// Asserts that actual is within tolerance of expected.
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);

module.exports = { iso, near };
