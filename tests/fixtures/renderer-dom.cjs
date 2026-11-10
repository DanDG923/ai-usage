'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.AI_USAGE_RENDERER_PROFILE);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.whenReady().then(async () => {
 const window = new BrowserWindow({ show: false, width: 1280, height: 900,
   webPreferences: { preload: path.join(__dirname, 'renderer-dom-preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
 const evaluate = (fn) => window.webContents.executeJavaScript(`((r) => r instanceof Node ? true : r)((${fn.toString()})())`);
 const until = async (fn) => { for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(fn)) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${fn}`); };
 try {
  await window.loadURL(process.env.AI_USAGE_RENDERER_URL);
  await until(() => document.querySelector('#tab-costs'));
  assert.equal(await evaluate(() => document.title), 'AI Usage');
  await evaluate(() => document.querySelector('#tab-costs').click());
  await until(() => document.querySelector('.task-card'));
  await evaluate(() => { document.querySelector('.task-card').open = true; window.testBridge.holdPages(true); const next = window.testBridge.fixture(); next.generatedAt = new Date(Date.now() + 1000).toISOString(); window.testBridge.push(next); });
  await until(() => document.querySelector('.task-panel').getAttribute('aria-busy') === 'true');
  assert.equal(await evaluate(() => document.querySelector('.task-card').open), true, 'refresh preserves expanded task');
  assert.ok(await evaluate(() => document.querySelector('.session-panel tbody tr code')), 'sessions stay populated');
  await evaluate(() => window.testBridge.releasePages());
  await until(() => document.querySelector('.task-panel').getAttribute('aria-busy') === 'false');
  assert.equal(await evaluate(() => document.querySelector('.task-card').open), true);
  await evaluate(() => [...document.querySelectorAll('.period-switch button')].find((button) => button.textContent.includes('90')).click());
  await until(() => window.testBridge.requests().includes(90));
  await evaluate(() => window.testBridge.push(window.testBridge.fixture()));
  await evaluate(() => window.testBridge.resolve(90));
  await until(() => [...document.querySelectorAll('.period-switch button')].some((button) => button.textContent.includes('90') && button.getAttribute('aria-pressed') === 'true'));
  await evaluate(() => window.testBridge.push(window.testBridge.fixture()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => [...document.querySelectorAll('.period-switch button')].find((button) => button.getAttribute('aria-pressed') === 'true').textContent.includes('90')), true, 'old push cannot undo selected period');
  // A superseded read that succeeds, then a newer one that fails, leave the
  // main process on a period this window does not show: it asks again.
  const period = (days) => window.webContents.executeJavaScript(`[...document.querySelectorAll('.period-switch button')].find((button) => button.textContent === '${days}d').click()`);
  await period(30);
  await period(7);
  await until(() => window.testBridge.requests().includes(7));
  await evaluate(() => { window.testBridge.resolve(30); window.testBridge.reject(7); });
  await until(() => window.testBridge.requests().at(-1) === 90);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.period-switch button')].find((button) => button.getAttribute('aria-pressed') === 'true').textContent), '90d');
  await evaluate(() => document.querySelector('[aria-label="Dismiss message"]')?.click());
  // A pushed update landing during a Refresh must not re-enable Refresh.
  await evaluate(() => { window.testBridge.holdRefresh(true); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })); });
  await until(() => window.testBridge.refreshCalls() === 1);
  await evaluate(() => { const next = window.testBridge.fixture(); next.costs.periodDays = 90; window.testBridge.push(next); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => document.querySelector('button[aria-keyshortcuts="R"]').disabled), true, 'Refresh stays disabled while it runs');
  await evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => window.testBridge.refreshCalls()), 1, 'a second Refresh is not started');
  await evaluate(() => window.testBridge.releaseRefresh());
  await until(() => !document.querySelector('button[aria-keyshortcuts="R"]').disabled);
  await evaluate(() => document.querySelector('[aria-label="Dismiss message"]')?.click());
  await evaluate(() => document.querySelector('#tab-overview').click());
  await until(() => document.querySelectorAll('.runway-chart').length === 3);
  await evaluate(() => { const next = window.testBridge.fixture(); for (const quota of Object.values(next.quotas)) { if (!quota) continue; for (const entry of [quota, ...quota.windows]) { entry.resetsAt = new Date(Date.now() + 250).toISOString(); entry.forecast.expired = false; } } window.testBridge.push(next); });
  await until(() => document.body.textContent.includes('The last allowance window ended'));
  assert.equal(await evaluate(() => document.querySelector('.runway-chart')), null, 'expired runways are removed without collection');
  // A provider page opens from its card and Escape returns to the Overview.
  await evaluate(() => window.testBridge.push(window.testBridge.fixture()));
  await until(() => document.querySelector('.provider-card.fable .provider-card-link'));
  await evaluate(() => document.querySelector('.provider-card.fable .provider-card-link').click());
  await until(() => document.querySelector('.detail-page .runway-chart.full'));
  assert.match(await evaluate(() => document.querySelector('.breadcrumb [aria-current="page"]').textContent), /Fable/);
  // Focus moves on the next animation frame, which a loaded test machine can delay.
  await until(() => document.activeElement?.id === 'panel-overview');
  // Trying a reserve re-plans the budget and draws the same reserve on the chart.
  await evaluate(() => { const slider = document.querySelector('#planner-reserve'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '20'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => document.querySelector('.runway-reserve text')?.textContent.includes('Reserve 20%'));
  // An unsaved reserve keeps the hidden window from releasing the page and its draft.
  assert.equal(await evaluate(() => window.testBridge.prepareSleep()), false, 'an unsaved reserve refuses renderer release');
  // Moving the slider while a save is pending keeps the newer choice as the draft.
  await evaluate(() => { window.testBridge.holdSettings(true); [...document.querySelectorAll('.pd-save button')].find((button) => button.textContent.includes('Use 20%')).click(); });
  await until(() => window.testBridge.heldSettings() === 1);
  assert.equal(await evaluate(() => document.querySelector('.pd-save button.btn-p').disabled), true, 'a pending save cannot be submitted twice');
  await evaluate(() => { const slider = document.querySelector('#planner-reserve'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '30'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => document.querySelector('.pd-save span')?.textContent.includes('Trying 30%'));
  await evaluate(() => window.testBridge.releaseSettings());
  await until(() => document.querySelector('.pd-save span')?.textContent === 'Trying 30%. Forecasts still use 20%.');
  assert.equal(await evaluate(() => document.querySelector('#planner-reserve').value), '30', 'the completed save did not discard the newer draft');
  await evaluate(() => [...document.querySelectorAll('.pd-save button')].find((button) => button.textContent === 'Reset').click());
  await until(() => !document.querySelector('.pd-save'));
  assert.equal(await evaluate(() => window.testBridge.prepareSleep()), true, 'with nothing unsaved the page can be released');
  // A pending save still refuses release after the slider returns to the saved
  // value, which hides the unsaved-reserve block while the save runs.
  await evaluate(() => { const slider = document.querySelector('#planner-reserve'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '25'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => document.querySelector('.pd-save span')?.textContent.includes('Trying 25%'));
  await evaluate(() => { window.testBridge.holdSettings(true); [...document.querySelectorAll('.pd-save button')].find((button) => button.textContent.includes('Use 25%')).click(); });
  await until(() => window.testBridge.heldSettings() === 1);
  await evaluate(() => { const slider = document.querySelector('#planner-reserve'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '20'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => !document.querySelector('.pd-save'));
  assert.equal(await evaluate(() => window.testBridge.prepareSleep()), false, 'a pending save refuses release without the unsaved-reserve block');
  await evaluate(() => window.testBridge.releaseSettings());
  await until(() => document.querySelector('.pd-save span')?.textContent === 'Trying 20%. Forecasts still use 25%.');
  await evaluate(() => [...document.querySelectorAll('.pd-save button')].find((button) => button.textContent === 'Reset').click());
  await until(() => !document.querySelector('.pd-save'));
  assert.equal(await evaluate(() => window.testBridge.prepareSleep()), true);
  // Escape pressed in the slider stays with the slider; the page remains open.
  await evaluate(() => { document.querySelector('[aria-label="Dismiss message"]')?.click(); document.querySelector('#planner-reserve').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await evaluate(() => document.querySelector('.detail-page')), 'Escape in a field does not close the page');
  // Escape dismisses a visible notice first, so clear any before leaving the page.
  await evaluate(() => document.querySelector('[aria-label="Dismiss message"]')?.click());
  await evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await until(() => document.querySelector('.provider-card-grid'));
  await until(() => document.activeElement?.classList.contains('provider-card-link'));
  await evaluate(() => document.querySelector('#tab-settings').click());
  await until(() => document.querySelector('#pricing'));
  assert.equal(await evaluate(() => Boolean(document.querySelector('#pricing').closest('details'))), false, 'API pricing is a visible section');
  await evaluate(() => { const select = document.querySelector('#pricing select'); select.value = 'USD'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(() => document.querySelector('#pricing select').value === 'USD');
  await evaluate(() => { const select = document.querySelector('#pricing select'); select.value = 'GBP'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(() => document.querySelector('#pricing select').value === 'GBP');
  assert.equal(await evaluate(() => document.querySelector('#pricing input[type="number"]').value), '0.736');
  await evaluate(() => { const select = document.querySelector('#pricing select'); select.value = 'EUR'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(() => document.querySelector('[aria-label="Set EUR display rate"]'));
  assert.equal(await evaluate(() => document.querySelector('#pricing select').value), 'GBP', 'new currency waits for a manual rate');
  await evaluate(() => [...document.querySelectorAll('#panel-settings button')].find((button) => button.textContent.includes('Set up Claude')).click());
  await until(() => document.querySelector('[role="dialog"]'));
  await evaluate(() => document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => !document.querySelector('[role="dialog"]'));
  // A Cancel that cannot be delivered is reported in the guide, from the button and from Escape, never left as an unhandled rejection.
  await evaluate(() => { window.unhandledRejections = []; window.addEventListener('unhandledrejection', (event) => window.unhandledRejections.push(String(event.reason?.message ?? event.reason))); });
  const setupButton = (label) => window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === ${JSON.stringify(label)})?.click()`);
  await evaluate(() => [...document.querySelectorAll('#panel-settings button')].find((button) => button.textContent.includes('Set up Claude')).click());
  await until(() => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === 'Start collecting' && !button.disabled));
  await evaluate(() => window.testBridge.holdConfigure(true));
  await setupButton('Check again');
  await until(() => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === 'Cancel'));
  await setupButton('Cancel');
  await until(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('Deliberate cancel rejection'));
  await evaluate(() => document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => window.testBridge.cancelCalls() === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await evaluate(() => window.unhandledRejections), [], 'a failed Cancel is not an unhandled rejection');
  assert.ok(await evaluate(() => document.querySelector('[role="dialog"]')), 'the step that could not be cancelled is still running');
  await evaluate(() => window.testBridge.releaseConfigure());
  await until(() => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === 'Set up later'));
  await setupButton('Set up later');
  await until(() => !document.querySelector('[role="dialog"]'));
  // A double-click on the helper control sends one write, enabling and disabling.
  const helperControl = () => [...document.querySelectorAll('#sources .source-card button')].find((button) => /helper/.test(button.textContent));
  const doubleClick = (find) => window.webContents.executeJavaScript(`(() => { const find = ${find.toString()}; find().click(); find().click(); })()`);
  await evaluate(() => document.querySelector('[aria-label="Dismiss message"]')?.click());
  assert.equal(await window.webContents.executeJavaScript(`(${helperControl.toString()})().textContent`), 'Enable fallback helper');
  await doubleClick(helperControl);
  await until(() => window.testBridge.helperCalls().install === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await evaluate(() => window.testBridge.helperCalls()), { install: 1, uninstall: 0 }, 'a second click does not enable the helper twice');
  assert.equal(await window.webContents.executeJavaScript(`(${helperControl.toString()})().disabled`), true, 'the helper control waits for the change in flight');
  await evaluate(() => window.testBridge.releaseHelpers());
  await until(() => document.querySelector('.toast')?.textContent.includes('Claude allowance helper enabled'));
  await until(() => [...document.querySelectorAll('#sources .source-card button')].some((button) => button.textContent === 'Disable helper' && !button.disabled));
  await doubleClick(helperControl);
  await until(() => window.testBridge.helperCalls().uninstall === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await evaluate(() => window.testBridge.helperCalls()), { install: 1, uninstall: 1 }, 'a second click does not disable the helper twice');
  await evaluate(() => window.testBridge.releaseHelpers());
  // Disabling succeeded although the script stays on disk: the notice is a confirmation, not a failure.
  await until(() => document.querySelector('.toast')?.textContent.includes('could not be deleted'));
  assert.equal(await evaluate(() => document.querySelector('.toast').className), 'toast ok', 'a success that mentions what could not be done is drawn as a success');
  assert.match(await evaluate(() => document.querySelector('.toast').previousElementSibling.previousElementSibling.textContent), /helper disabled and its status line removed/, 'and announced politely');
  assert.equal(await evaluate(() => document.querySelector('.toast').previousElementSibling.textContent), '', 'not as an alert');
  await until(() => [...document.querySelectorAll('#sources .source-card button')].some((button) => button.textContent === 'Enable fallback helper' && !button.disabled));
  await evaluate(() => document.querySelector('[aria-label="Dismiss message"]')?.click());
  // A double-click on a price's Save writes it once.
  const priceSave = () => [...document.querySelectorAll('#pricing .price-save')].find((button) => !button.disabled || button.getAttribute('aria-busy') === 'true');
  await doubleClick(priceSave);
  await until(() => window.testBridge.priceCalls() === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => window.testBridge.priceCalls()), 1, 'a second click does not save the price twice');
  assert.equal(await evaluate(() => document.querySelectorAll('#pricing .price-save[aria-busy="true"]:disabled').length), 1, 'only the row being saved waits');
  await evaluate(() => window.testBridge.releasePrices());
  await until(() => document.querySelector('.toast')?.textContent.includes('pricing updated'));
  await until(() => !document.querySelector('#pricing .price-save[aria-busy="true"]'));
  await evaluate(() => document.querySelector('[aria-label="Dismiss message"]')?.click());
  // Settings: a screen-reader title, a section list with live badges, navigation into disclosures, and search.
  const searchSettings = (query) => window.webContents.executeJavaScript(`(() => { const input = document.querySelector('#panel-settings input[type="search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const shownSections = () => evaluate(() => [...document.querySelectorAll('[data-settings-section]')].filter((slot) => !slot.hidden).map((slot) => slot.dataset.settingsSection).join(' '));
  assert.equal(await evaluate(() => document.querySelector('#panel-settings h1').className), 'sr-only');
  assert.equal(await evaluate(() => [...document.querySelectorAll('.settings-nav a')].map((link) => link.getAttribute('href')).join(' ')), '#subscriptions #sources #forecast #alerts #pricing #storage #appearance #manual #diagnostics');
  assert.match(await evaluate(() => document.querySelector('.settings-nav a[href="#sources"]').textContent), /3 connected/);
  assert.match(await evaluate(() => document.querySelector('.settings-nav a[href="#pricing"]').textContent), /1 unpriced/);
  assert.equal(await evaluate(() => document.querySelectorAll('#subscription-fees input[type="number"]').length), 2, 'monthly fee inputs are back');
  assert.equal(await evaluate(() => document.querySelector('.advanced-disclosure').open), false);
  await evaluate(() => document.querySelector('.settings-nav a[href="#diagnostics"]').click());
  await until(() => document.activeElement && document.activeElement.id === 'diagnostics-heading');
  assert.equal(await evaluate(() => document.querySelector('.advanced-disclosure').open), true, 'navigating into a closed disclosure opens it');
  assert.equal(await evaluate(() => document.querySelector('.settings-nav [aria-current="true"]').getAttribute('href')), '#diagnostics');
  await searchSettings('backup sets kept');
  await until(() => document.querySelector('[data-settings-section="alerts"]').hidden);
  assert.equal(await shownSections(), 'storage');
  assert.equal(await evaluate(() => document.querySelector('.settings-nav a[href="#alerts"]').classList.contains('is-dimmed')), true);
  assert.equal(await evaluate(() => document.querySelector('.advanced-disclosure').hidden), true);
  await evaluate(() => document.querySelector('#panel-settings input[type="search"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await until(() => !document.querySelector('[data-settings-section][hidden]') && document.querySelector('#panel-settings input[type="search"]').value === '');
  await searchSettings('new-source fallback');
  await until(() => document.querySelector('#forecast .inline-advanced').open);
  assert.equal(await shownSections(), 'forecast', 'a match inside a collapsed disclosure opens it');
  await searchSettings('no such setting');
  await until(() => document.querySelector('.settings-empty'));
  assert.match(await evaluate(() => document.querySelector('.settings-empty').textContent), /No settings match “no such setting”/);
  await evaluate(() => [...document.querySelectorAll('.settings-empty button')].find((button) => button.textContent === 'Clear search').click());
  await until(() => !document.querySelector('.settings-empty') && document.activeElement === document.querySelector('#panel-settings input[type="search"]'));
  assert.equal(await evaluate(() => document.querySelector('#forecast .inline-advanced').open), false, 'clearing the search closes what it opened');
  // A failed save puts the saved free-reset expiry back and says so.
  await evaluate(() => { const next = window.testBridge.fixture(); next.settings = { ...next.settings, claudeFreeResets: 1, claudeFreeResetsExpireOn: '2026-10-22' }; window.testBridge.push(next); });
  await until(() => document.querySelector('#claude-free-resets input[type="date"]')?.value === '2026-10-22');
  await evaluate(() => { window.testBridge.rejectSettings(true); const input = document.querySelector('#claude-free-resets input[type="date"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2026-11-05'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => document.querySelector('#claude-free-resets [role="alert"]'));
  assert.equal(await evaluate(() => document.querySelector('#claude-free-resets input[type="date"]').value), '2026-10-22', 'a failed save restores the saved expiry');
  assert.match(await evaluate(() => document.querySelector('#claude-free-resets [role="alert"]').textContent), /could not be saved/);
  await evaluate(() => window.testBridge.rejectSettings(false));
  // Retyping the saved day while an earlier save is still on its way saves it,
  // and that earlier save landing does not put back the day typed past.
  const typeInto = (selector, value) => window.webContents.executeJavaScript(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(() => { window.testBridge.setSettings({ claudeFreeResets: 1, claudeFreeResetsExpireOn: '2026-10-22' }); window.testBridge.holdSettings(true); });
  await typeInto('#claude-free-resets input[type="date"]', '2026-10-01');
  await until(() => window.testBridge.heldSettings() === 1);
  await typeInto('#claude-free-resets input[type="date"]', '2026-10-22');
  await until(() => window.testBridge.heldSettings() === 2);
  // The earlier save lands, and its snapshot renders, while the later one waits.
  await evaluate(() => window.testBridge.releaseFirstSetting());
  await until(() => window.testBridge.fixture().settings.claudeFreeResetsExpireOn === '2026-10-01');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => document.querySelector('#claude-free-resets input[type="date"]').value), '2026-10-22', 'an earlier save landing does not put back a day typed past');
  await evaluate(() => window.testBridge.releaseSettings());
  await until(() => window.testBridge.fixture().settings.claudeFreeResetsExpireOn === '2026-10-22');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => document.querySelector('#claude-free-resets input[type="date"]').value), '2026-10-22', 'the day typed last is kept');
  // A whole-number setting marks a fraction invalid and puts the saved value back without saving it.
  await typeInto('#claude-free-resets input[type="number"]', '2.5');
  await until(() => document.querySelector('#claude-free-resets input[type="number"]').getAttribute('aria-invalid') === 'true');
  // An offscreen window never holds focus, so leave the field as React sees it.
  await evaluate(() => document.querySelector('#claude-free-resets input[type="number"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await until(() => document.querySelector('#claude-free-resets input[type="number"]').value === '1');
  assert.equal(await evaluate(() => window.testBridge.fixture().settings.claudeFreeResets), 1);
  assert.equal(await evaluate(() => Boolean(document.querySelector('#claude-free-resets [role="alert"]'))), false, 'no save was attempted');
  if (process.env.AI_USAGE_RENDERER_QA_DIRECTORY) {
    const capture = async (name) => { await new Promise((resolve) => setTimeout(resolve, 400)); window.webContents.invalidate(); await new Promise((resolve) => setTimeout(resolve, 200)); fs.writeFileSync(path.join(process.env.AI_USAGE_RENDERER_QA_DIRECTORY, name), (await window.webContents.capturePage()).toPNG()); };
    fs.mkdirSync(process.env.AI_USAGE_RENDERER_QA_DIRECTORY, { recursive: true });
    await evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); });
    await capture('renderer-settings.png');
    await evaluate(() => document.querySelector('#forecast').scrollIntoView({ block: 'start' }));
    await capture('renderer-settings-forecast.png');
    window.setSize(820, 900);
    await evaluate(() => { document.documentElement.dataset.theme = 'light'; window.scrollTo(0, 0); });
    await capture('renderer-settings-light-820.png');
    window.setSize(1280, 900);
    await evaluate(() => { delete document.documentElement.dataset.theme; document.documentElement.style.scrollBehavior = ''; });
  }
  await evaluate(() => { document.querySelector('#tab-costs').click(); });
  await until(() => document.querySelector('.table-search input'));
  await evaluate(() => document.querySelector('.table-search input').focus());
  assert.notEqual(await evaluate(() => getComputedStyle(document.querySelector('.table-search')).outlineStyle), 'none');
  await evaluate(() => document.querySelector('.table-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })));
  // Refresh shortcut is ignored while typing: use the header button instead.
  await evaluate(() => { document.querySelector('.table-search input').blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })); });
  await until(() => [...document.querySelectorAll('[role="alert"]')].some((node) => node.textContent.includes('Deliberate refresh rejection')));
  assert.equal(await evaluate(() => document.querySelectorAll('vite-error-overlay').length), 0);
  assert.deepEqual(await evaluate(() => window.testBridge.errors()), []);
  await evaluate(() => { const next = window.testBridge.fixture(); next.costs.periodDays = 90; next.costs.chart = null; window.testBridge.push(next); });
  await until(() => document.body.textContent.includes('AI Usage hit a rendering error'));
  assert.ok(await evaluate(() => document.querySelector('#tab-overview')), 'navigation survives a destination render error');
  await evaluate(() => { document.querySelector('#tab-overview').click(); const next = window.testBridge.fixture(); next.costs.periodDays = 90; window.testBridge.push(next); });
  await until(() => document.querySelector('#panel-overview'));
  assert.equal(await evaluate(() => window.testBridge.errors().length), 1, 'render errors reach main-process logging');
  if (process.env.AI_USAGE_RENDERER_QA_DIRECTORY) {
    await evaluate(() => { document.querySelector('[aria-label="Dismiss message"]')?.click(); document.documentElement.style.scrollBehavior = 'auto'; });
    fs.mkdirSync(process.env.AI_USAGE_RENDERER_QA_DIRECTORY, { recursive: true });
    await evaluate(() => document.querySelector('#tab-overview').click());
    await evaluate(() => window.testBridge.push(window.testBridge.fixture()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.scrollTo(0, 0); });
    await new Promise((resolve) => setTimeout(resolve, 500));
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(process.env.AI_USAGE_RENDERER_QA_DIRECTORY, 'renderer-overview.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(900, 720);
    await evaluate(() => { document.documentElement.dataset.theme = 'light'; document.querySelector('#tab-costs').click(); });
    await evaluate(() => window.scrollTo(0, 0));
    await new Promise((resolve) => setTimeout(resolve, 700));
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(process.env.AI_USAGE_RENDERER_QA_DIRECTORY, 'renderer-costs-light-900.png'), (await window.webContents.capturePage()).toPNG());
  }
  // A window opened while an update has closed storage explains the wait and
  // can try again, rather than loading indefinitely.
  const waiting = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { preload: path.join(__dirname, 'renderer-dom-preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true,
      additionalArguments: ['--decline-reads'] } });
  const inWaiting = (fn) => waiting.webContents.executeJavaScript(`((r) => r instanceof Node ? true : r)((${fn.toString()})())`);
  await waiting.loadURL(process.env.AI_USAGE_RENDERER_URL);
  for (let attempt = 0; !(await inWaiting(() => document.querySelector('.state-panel.is-error button'))); attempt++) {
    if (attempt > 100) throw new Error('The declined first read left the loading screen without a retry.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(await inWaiting(() => document.querySelector('.state-panel').textContent), /finishing an update/);
  await inWaiting(() => { window.testBridge.answerReads(); document.querySelector('.state-panel.is-error button').click(); });
  for (let attempt = 0; !(await inWaiting(() => document.querySelector('#tab-costs'))); attempt++) {
    if (attempt > 100) throw new Error('Try again did not load the dashboard.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  waiting.destroy();
  // The browser preview has no desktop bridge: R does what its Refresh button does, and says so.
  const preview = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  const inPreview = (fn) => preview.webContents.executeJavaScript(`((r) => r instanceof Node ? true : r)((${fn.toString()})())`);
  const inPreviewUntil = async (fn, what) => {
    for (let attempt = 0; !(await inPreview(fn)); attempt++) {
      if (attempt > 100) throw new Error(what);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await preview.loadURL(process.env.AI_USAGE_RENDERER_URL);
  await inPreviewUntil(() => document.querySelector('button[aria-keyshortcuts="R"]'), 'The preview did not load its demo data.');
  await inPreview(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })));
  await inPreviewUntil(() => document.querySelector('.toast'), 'R did nothing in the browser preview.');
  const byKey = await inPreview(() => document.querySelector('.toast').textContent);
  await inPreview(() => document.querySelector('[aria-label="Dismiss message"]').click());
  await inPreviewUntil(() => !document.querySelector('.toast'), 'The preview notice was not dismissed.');
  await inPreview(() => document.querySelector('button[aria-keyshortcuts="R"]').click());
  await inPreviewUntil(() => document.querySelector('.toast'), 'The preview Refresh button showed no notice.');
  assert.equal(byKey, await inPreview(() => document.querySelector('.toast').textContent), 'R and the Refresh button agree in the preview');
  assert.match(byKey, /installed desktop app/);
  preview.destroy();
  console.log('RENDERER_DOM_PASS: pushes, retained tasks, periods, reset timer, refresh state, currency, setup cancel, single writes, notice tone, settings navigation and search, keyboard focus and alerts, declined first read, preview refresh shortcut');
  app.exit(0);
 } catch (error) { console.error(error); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });
