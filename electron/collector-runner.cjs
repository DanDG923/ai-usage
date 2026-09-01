'use strict';

async function runCollectors(factories) {
  const entries = Object.entries(factories);
  const settled = await Promise.allSettled(entries.map(([, factory]) => Promise.resolve().then(factory)));
  return Object.fromEntries(entries.map(([name], index) => [name, settled[index]]));
}

module.exports = { runCollectors };
