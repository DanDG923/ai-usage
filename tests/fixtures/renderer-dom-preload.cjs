'use strict';
const fs = require('node:fs');
const { contextBridge } = require('electron');
const snapshot = JSON.parse(fs.readFileSync(process.env.AI_USAGE_RENDERER_FIXTURE, 'utf8'));
let listeners = new Set();
let requests = [];
let heldPages = [];
let pageDelay = false;
let errors = [];
const page = (kind, options) => {
  const rows = snapshot.costs[kind] || [];
  const data = { rows, total: rows.length, page: options.page, pageSize: options.pageSize, totalPages: 1 };
  return pageDelay ? new Promise((resolve) => heldPages.push(() => resolve(data))) : Promise.resolve(data);
};
contextBridge.exposeInMainWorld('aiUsage', {
  getSnapshot(days) {
    if (days === 30 && !requests.length) return Promise.resolve(structuredClone(snapshot));
    return new Promise((resolve, reject) => requests.push({ days, resolve, reject }));
  },
  onUpdated(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  isClaudeSetupDismissed: async () => true,
  getTasks: (options) => page('tasks', options),
  getSessions: (options) => page('sessions', options),
  reportRendererError: async (error) => { errors.push(error); },
  getVersion: async () => 'test',
  getUpdateStatus: async () => ({ status: 'idle', available: false }),
  onUpdateStatus: () => () => {},
  updateSettings: async (patch) => {
    const currency = patch.currency || snapshot.settings.currency;
    const rate = currency === 'USD' ? 1 : patch.usdToCurrency ?? snapshot.settings.currencyRates[currency];
    snapshot.settings = { ...snapshot.settings, ...patch, usdToCurrency: rate,
      currencyRates: { ...snapshot.settings.currencyRates, [currency]: rate } };
    snapshot.costs.currency = currency;
    return { snapshot: structuredClone(snapshot) };
  },
  getClaudeSetup: async () => ({ installed: true, auth: 'signed-in', dismissed: false }),
  configureClaude: async () => ({ dismissed: true }),
  refresh: async () => { throw new Error('Deliberate refresh rejection'); },
});
contextBridge.exposeInMainWorld('testBridge', {
  push(next) { for (const listener of listeners) listener(next); },
  fixture: () => structuredClone(snapshot),
  requests: () => requests.map(({ days }) => days),
  resolve(days) { const request = requests.find((row) => row.days === days); if (!request) throw new Error('No request'); request.resolve({ ...structuredClone(snapshot), costs: { ...snapshot.costs, periodDays: days } }); },
  reject(days) { const request = requests.find((row) => row.days === days); request.reject(new Error('Deliberate period rejection')); },
  holdPages(value) { pageDelay = value; },
  releasePages() { pageDelay = false; for (const resolve of heldPages.splice(0)) resolve(); },
  errors: () => errors,
});
