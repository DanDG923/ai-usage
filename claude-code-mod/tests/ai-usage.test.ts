import { expect, mock, test } from 'claude-code/testing'

// Run with `claude plugin test` from claude-code-mod/ (npm run test:mod).

const APPDATA = 'C:/Users/test/AppData/Roaming'
const HOUR = 3_600_000

function glance(state: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    schema: 1,
    appVersion: '1.0.56',
    writtenAt: new Date(now).toISOString(),
    generatedAt: new Date(now - 60_000).toISOString(),
    collectedAt: new Date(now - 120_000).toISOString(),
    verdict: state === 'safe'
      ? { state, headline: 'All allowances on track', detail: '' }
      : { state, headline: 'Claude is above its safe pace', detail: 'Stay under 9.2% a day to reach the reset.' },
    providers: [
      { id: 'codex', name: 'Codex', subtitle: 'ChatGPT Pro · Weekly', state: 'safe', waiting: false, remaining: 62.4,
        expectedRemaining: 48, estimated: false, usable: false, resetsAt: new Date(now + 50 * HOUR).toISOString(),
        exhaustsAt: null, stale: false, secondary: [] },
      { id: 'claude', name: 'Claude', subtitle: 'Claude Max · Weekly', state, waiting: false, remaining: 41,
        expectedRemaining: 12, estimated: false, usable: false, resetsAt: new Date(now + 30 * HOUR).toISOString(),
        exhaustsAt: null, stale: false,
        secondary: [{ label: '5-hour session', state: 'safe', remaining: 77, resetsAt: new Date(now + 2 * HOUR).toISOString() }] },
      { id: 'fable', name: 'Fable', subtitle: 'Provider reading · Weekly', state: 'unknown', waiting: true, remaining: null,
        expectedRemaining: null, estimated: false, usable: false, resetsAt: null, exhaustsAt: null, stale: false, secondary: [] },
    ],
    alertsSnoozedUntil: null,
    ...overrides,
  }
}

type Stubs = {
  feed?: unknown
  surfaces?: string[]
  band?: unknown
  writes?: { path: string; text: string }[]
  toasts?: string[]
  saved?: Map<string, unknown>
}

// Everything Claude Code would answer for the mod, recorded where a test checks it.
function stub(on: any, { feed = glance('risk'), surfaces = ['terminal'], band, writes = [], toasts = [], saved = new Map() }: Stubs = {}) {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'APPDATA' ? APPDATA : undefined }))
  on('store.get', ($: any, e: any) => ({ value: e.key === 'band' ? band : saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.stat', ($: any, e: any) => (feed != null && String(e.path).endsWith('glance.json')
    ? { value: { kind: 'file', size: 1, mtimeMs: 5, isLink: false } }
    : { deny: 'ENOENT' }))
  on('fs.read', ($: any, e: any) => (feed != null && String(e.path).endsWith('glance.json')
    ? { value: typeof feed === 'string' ? feed : JSON.stringify(feed) }
    : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { clock, writes, toasts, saved }
}

const PANE = (surface: 'terminal' | 'desktop', columns = 90) => ({
  plugin: 'ai-usage',
  component: 'Pane',
  requestId: 'ai-usage',
  surface,
  viewport: { columns: 140, rows: 40 },
  props: { title: 'AI Usage', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}) as const

const BAND = (surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'ai-usage',
  component: 'AbovePrompt',
  requestId: 'band',
  surface,
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
}) as const

async function step($: any, index = 0) {
  const stream = $.turn.step({ turnId: 't', index, model: 'claude-opus-5-5', messageCount: 1 })
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}

// Resets as Claude Code reports them: the same instant give or take a second.
const FIVE_HOUR_RESET = Math.ceil((Date.now() + 3 * HOUR) / 60_000) * 60_000
const LIMITS = (used: number, jitterMs = 0) => [
  { kind: 'five_hour', percentUsed: used, resetsAt: new Date(FIVE_HOUR_RESET + jitterMs).toISOString() },
  { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(FIVE_HOUR_RESET + 87 * HOUR).toISOString() },
]

test('/ai-usage opens the pane where Claude Code draws, and adds nothing to the conversation', async ($, on) => {
  stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const answer = await $.command.run({ command: 'ai-usage', args: '' })
  expect(answer).toEqual({})
})

test('/ai-usage prints the allowances where nothing draws, and when asked for text', async ($, on) => {
  stub(on, { surfaces: [] })
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const answer = await $.command.run({ command: 'ai-usage', args: '' })
  expect(answer.text).toMatch(/^▲ Claude is above its safe pace — Stay under 9\.2% a day/)
  expect(answer.text).toContain('Codex: 62% left · On track · ChatGPT Pro · Weekly · 48% at reset')
  expect(answer.text).toContain('  5-hour session: 77% left')
  expect(answer.text).toContain('Fable: — · Learning · Provider reading · Weekly · waiting for a reading')
  const asked = await $.command.run({ command: 'ai-usage', args: 'text' })
  expect(asked.text).toBe(answer.text)
})

test('the pane draws the verdict and every allowance in the terminal and the Desktop app', async ($, on) => {
  stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ type: 'Text', text: '▲ Claude is above its safe pace' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Stay under 9.2% a day to reach the reset.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62% left' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41% left' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ChatGPT Pro · Weekly · 48% at reset · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5-hour session: 77% left · On track · resets / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▲ At risk' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^updated 2 min ago$/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: /^█+$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a narrow pane puts each tape on its own line', async ($, on) => {
  stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(PANE('terminal', 40))
  expect(await ui.find({ type: 'Text', text: '62% left' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^█+$/ })).toBeDefined()
})

test('without the app the pane says how to connect it', async ($, on) => {
  stub(on, { feed: null })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /^AI Usage has not shared any allowances yet/ })).toBeDefined()
})

test('the caution line shows only while an allowance needs attention, and can be turned off', async ($, on) => {
  const { saved } = stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount(BAND())
  expect(await band.find({ type: 'Text', text: 'Claude is above its safe pace — Stay under 9.2% a day to reach the reset.' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount(PANE('terminal'))
  await pane.press({ key: 'band' })
  expect(saved.get('band')).toBe(false)
  await pane.unmount()
  const off = await $.ui.mount(BAND())
  expect(await off.find({ type: 'Text', text: /Claude is above its safe pace/ })).toBeUndefined()
})

test('no caution line while on track, snoozed, or when the app has stopped', async ($, on) => {
  stub(on, { feed: glance('safe') })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount(BAND('desktop'))
  expect(await band.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /AI Usage/ })).toBeUndefined()
})

test('a stopped app or snoozed alerts keep the caution line away', async ($, on) => {
  const old = new Date(Date.now() - 2 * HOUR).toISOString()
  stub(on, { feed: glance('critical', { writtenAt: old }) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount(BAND())
  expect(await band.find({ type: 'Text', text: /AI Usage/ })).toBeUndefined()
})

test('a reading is left only after a response, dated by the request that fetched it', async ($, on) => {
  const { writes } = stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // A measurement with no response since: an idle repeat, never written.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS(20), changed: ['rateLimits'] })
  expect(writes.length).toBe(0)
  const before = Date.now()
  await step($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS(20), changed: ['context', 'rateLimits'] })
  expect(writes.length).toBe(1)
  // The engine hands paths on in the platform's own spelling.
  expect(writes[0].path.replaceAll('\\', '/')).toMatch(/^C:\/Users\/test\/AppData\/Roaming\/ai-usage\/claude-code\/readings\/\d{15}-session-1-1\.json$/)
  const record = JSON.parse(writes[0].text)
  expect(record.format).toBe('ai-usage-claude-code-reading')
  expect(record.session_id).toBe('session-1')
  expect(record.model).toEqual({ id: 'claude-opus-5-5' })
  expect(record.rate_limits.five_hour.used_percentage).toBe(20)
  expect(Date.parse(record.fetched_after) >= before).toBe(true)
  expect(Date.parse(record.fetched_after) <= Date.parse(record.captured_at)).toBe(true)
  // The same limits again soon after are not worth another file...
  await step($, 1)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS(20, 1_000), changed: ['context'] })
  expect(writes.length).toBe(1)
  // ...but a limit that moved is.
  await step($, 2)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS(21), changed: ['rateLimits'] })
  expect(writes.length).toBe(2)
  expect(JSON.parse(writes[1].text).rate_limits.five_hour.used_percentage).toBe(21)
})

test('no reading without plan limits, as off a subscription', async ($, on) => {
  const { writes } = stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await step($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  expect(writes.length).toBe(0)
})

test('sync and open leave a request for a running app, and say so when it is not running', async ($, on) => {
  const { writes, toasts } = stub(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await $.command.run({ command: 'ai-usage', args: 'sync' })).toEqual({})
  const pane = await $.ui.mount(PANE('terminal'))
  await pane.press({ key: 'open' })
  expect(writes.map((entry) => JSON.parse(entry.text).action)).toEqual(['sync', 'open'])
  expect(writes[0].path.replaceAll('\\', '/')).toMatch(/\/claude-code\/requests\/\d+-sync\.json$/)
  expect(toasts).toEqual(['AI Usage is collecting now.', 'Opening the AI Usage dashboard.'])
})

test('a request to a stopped app is not left behind', async ($, on) => {
  const { writes, toasts } = stub(on, { feed: glance('safe', { writtenAt: new Date(Date.now() - 3 * HOUR).toISOString() }) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'ai-usage', args: 'open' })
  expect(writes.length).toBe(0)
  expect(toasts).toEqual(['AI Usage is not running. Start it, then try again.'])
})

test('a glance this mod does not understand draws as no reading, never as numbers', async ($, on) => {
  stub(on, { feed: '{"schema":2,"providers":[{"remaining":50}]}' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^AI Usage has not shared any allowances yet/ })).toBeUndefined()
})
