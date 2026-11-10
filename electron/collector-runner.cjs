'use strict';

// Runs every collector at once and reports each outcome under its own name;
// one that throws or rejects does not stop the others.
/**
 * @template {Record<string, () => unknown>} F
 * @param {F} factories
 * @returns {Promise<{ [Name in keyof F]: PromiseSettledResult<Awaited<ReturnType<F[Name]>>> }>}
 */
async function runCollectors(factories) {
  const entries = Object.entries(factories);
  const settled = await Promise.allSettled(entries.map(([, factory]) => Promise.resolve().then(factory)));
  // Object.fromEntries forgets which name carries which outcome; each entry
  // is the outcome of the factory with the same name and position.
  return /** @type {{ [Name in keyof F]: PromiseSettledResult<Awaited<ReturnType<F[Name]>>> }} */ (
    Object.fromEntries(entries.map(([name], index) => [name, settled[index]])));
}

module.exports = { runCollectors };
