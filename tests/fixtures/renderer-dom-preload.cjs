'use strict';
const fs = require('node:fs');
const { contextBridge } = require('electron');
const snapshot = JSON.parse(fs.readFileSync(process.env.AI_USAGE_RENDERER_FIXTURE, 'utf8'));
let listeners = new Set();
let requests = [];
let heldPages = [];
let pageDelay = false;
let errors = [];
let rejectSettings = false;
let holdSettings = false;
let heldSettings = [];
let prepareSleep = null;
let holdRefresh = false;
let heldRefreshes = [];
let refreshCalls = 0;
// Writes that wait until released, so a second click lands while the first is in flight.
let helperCalls = { install: 0, uninstall: 0 };
let heldHelpers = [];
let priceCalls = 0;
let heldPrices = [];
let holdConfigure = false;
let heldConfigures = [];
let cancelCalls = 0;
const setHelperInstalled = (helperInstalled) => {
  const claude = snapshot.sources.find((source) => source.id === 'claude');
  claude.metadata = { ...claude.metadata, helperInstalled };
};
// A second window starts while storage is closed: reads answer null until
// told, then answer at once for whichever period the saved view selects.
const declining = process.argv.includes('--decline-reads');
let declineReads = declining;
const page = (kind, options) => {
  const rows = snapshot.costs[kind] || [];
  const data = { rows, total: rows.length, page: options.page, pageSize: options.pageSize, totalPages: 1 };
  return pageDelay ? new Promise((resolve) => heldPages.push(() => resolve(data))) : Promise.resolve(data);
};
contextBridge.exposeInMainWorld('aiUsage', {
  getSnapshot(days) {
    if (declining) return Promise.resolve(declineReads ? null : { ...structuredClone(snapshot), costs: { ...snapshot.costs, periodDays: days } });
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
    if (rejectSettings) throw new Error('Deliberate settings rejection');
    if (holdSettings) await new Promise((resolve) => heldSettings.push(resolve));
    const currency = patch.currency || snapshot.settings.currency;
    const rate = currency === 'USD' ? 1 : patch.usdToCurrency ?? snapshot.settings.currencyRates[currency];
    snapshot.settings = { ...snapshot.settings, ...patch, usdToCurrency: rate,
      currencyRates: { ...snapshot.settings.currencyRates, [currency]: rate } };
    snapshot.costs.currency = currency;
    return { snapshot: structuredClone(snapshot) };
  },
  getClaudeSetup: async () => ({ installed: true, auth: 'signed-in', dismissed: false }),
  configureClaude: async () => {
    if (holdConfigure) await new Promise((resolve) => heldConfigures.push(resolve));
    return { dismissed: true };
  },
  cancelClaudeSetup: async () => { cancelCalls += 1; throw new Error('Deliberate cancel rejection'); },
  installClaudeHelper: async () => {
    helperCalls.install += 1;
    await new Promise((resolve) => heldHelpers.push(resolve));
    setHelperInstalled(true);
    return { snapshot: structuredClone(snapshot) };
  },
  // The helper is disabled but its script is still open elsewhere and stays on disk.
  uninstallClaudeHelper: async () => {
    helperCalls.uninstall += 1;
    await new Promise((resolve) => heldHelpers.push(resolve));
    setHelperInstalled(false);
    return { snapshot: structuredClone(snapshot),
      result: { managed: true, restoredPreviousStatusLine: false, statusLineRemoved: true, helperScriptRemoved: false } };
  },
  updatePrice: async () => {
    priceCalls += 1;
    await new Promise((resolve) => heldPrices.push(resolve));
    return { snapshot: structuredClone(snapshot) };
  },
  refresh: async () => {
    refreshCalls += 1;
    if (holdRefresh) return new Promise((resolve) => heldRefreshes.push(() => resolve({ snapshot: structuredClone(snapshot), collectors: {} })));
    throw new Error('Deliberate refresh rejection');
  },
  onPrepareSleep(callback) { prepareSleep = callback; return () => { if (prepareSleep === callback) prepareSleep = null; }; },
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
  rejectSettings(value) { rejectSettings = value; },
  holdSettings(value) { holdSettings = value; },
  releaseSettings() { holdSettings = false; for (const resolve of heldSettings.splice(0)) resolve(); },
  releaseFirstSetting() { heldSettings.shift()?.(); },
  heldSettings: () => heldSettings.length,
  setSettings(patch) { snapshot.settings = { ...snapshot.settings, ...patch }; },
  holdRefresh(value) { holdRefresh = value; },
  releaseRefresh() { holdRefresh = false; for (const resolve of heldRefreshes.splice(0)) resolve(); },
  refreshCalls: () => refreshCalls,
  answerReads() { declineReads = false; },
  helperCalls: () => ({ ...helperCalls }),
  releaseHelpers() { for (const resolve of heldHelpers.splice(0)) resolve(); },
  priceCalls: () => priceCalls,
  releasePrices() { for (const resolve of heldPrices.splice(0)) resolve(); },
  holdConfigure(value) { holdConfigure = value; },
  releaseConfigure() { holdConfigure = false; for (const resolve of heldConfigures.splice(0)) resolve(); },
  cancelCalls: () => cancelCalls,
  // What the renderer answers when the hidden window asks to release it.
  prepareSleep: () => (prepareSleep ? prepareSleep() : null),
});
