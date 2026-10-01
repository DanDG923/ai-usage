// AI Usage inside Claude Code.
//
// - /ai-usage opens a pane with the tray flyout's allowances (/ai-usage text
//   prints them, /ai-usage sync collects, /ai-usage open opens the dashboard).
// - When an allowance needs attention, one line above the prompt says so.
// - After each response, the plan limits Claude Code already holds are left
//   for the app, dated by the request that fetched them.
//
// Nothing here calls a model, sends a request or adds to what Claude reads:
// the limits come from $.session.usage's figures, which cost nothing, and
// everything drawn stays out of the conversation.

import {
  PANE_ID,
  PROVIDER_COLOR,
  appRunning,
  bandMessage,
  detailLabel,
  figureLabel,
  parseGlance,
  percentLabel,
  readingFileName,
  readingRecord,
  relativeLabel,
  requestRecord,
  statusOf,
  summaryText,
  tapeCells,
  tapeSvg,
  whenLabel,
} from './view.js'

// How often the glance file is checked for a new copy from the app.
const POLL_MS = 15_000
// An unchanged reading is left at most this often, so a busy session keeps
// the app's evidence current without a file after every response.
const UNCHANGED_READING_MS = 10 * 60_000
const NOT_SET_UP = 'AI Usage has not been connected to Claude Code on this computer. Install the mod from AI Usage → Settings → Sources.'
const NO_GLANCE = 'AI Usage has not shared any allowances yet. Open the AI Usage app once, and they appear here.'

let paths = null
let glance = null
let glanceMtimeMs = null
let problem = null
let bandOn = true
let paneOpen = false
let sessionId = null
let sequence = 0

// Requests to the model that have started and not finished, by token; the
// earliest start since the last reading; and the responses since then.
const inFlight = new Map()
let pendingSince = null
let responsesSinceReading = 0
let lastReading = null

// Where the app keeps the glance and collects readings and requests. The app
// writes ai-usage.json beside this mod when it installs it; a copy loaded
// for development falls back to the app's default folder.
async function locate($) {
  try {
    const value = JSON.parse(await $.fs.read($.plugin.root + '/ai-usage.json'))
    if (typeof value?.glance === 'string' && typeof value.readings === 'string' && typeof value.requests === 'string') return value
  } catch {
    // Not installed by the app; try the default folder.
  }
  const appData = await $.env.get('APPDATA')
  if (!appData) return null
  const base = appData + '/ai-usage/claude-code'
  return { glance: base + '/glance.json', readings: base + '/readings', requests: base + '/requests' }
}

// Reads the glance when the app has written a new one. True when what the
// mod would draw changed.
async function loadGlance($) {
  if (!paths) {
    const changed = problem !== NOT_SET_UP
    problem = NOT_SET_UP
    return changed
  }
  let stat = null
  try {
    stat = await $.fs.stat(paths.glance)
  } catch {
    // No glance yet.
  }
  if (!stat || stat.kind !== 'file') {
    const changed = problem !== NO_GLANCE || glance !== null
    glance = null
    glanceMtimeMs = null
    problem = NO_GLANCE
    return changed
  }
  if (stat.mtimeMs === glanceMtimeMs) return false
  let parsed = null
  try {
    parsed = parseGlance(await $.fs.read(paths.glance))
  } catch {
    // Unreadable this time; the next check tries again.
  }
  // A copy that does not parse keeps the last good one on screen.
  if (!parsed) return false
  glance = parsed
  glanceMtimeMs = stat.mtimeMs
  problem = null
  return true
}

async function pollGlance($) {
  const changed = await loadGlance($)
  // An open pane also redraws for its "updated … ago" line.
  if (changed || paneOpen) $.ui.invalidate('ui.render')
}

// Leaves a request for the app: collect now, or open the dashboard. The app
// reads it within a few seconds while it runs.
async function ask($, action) {
  if (!paths) {
    $.ui.toast(NOT_SET_UP)
    return
  }
  const now = Date.now()
  if (!glance || !appRunning(glance, now)) {
    $.ui.toast('AI Usage is not running. Start it, then try again.')
    return
  }
  await $.fs.write(paths.requests + '/' + now + '-' + action + '.json', JSON.stringify(requestRecord(action, now)) + '\n')
  $.ui.toast(action === 'sync' ? 'AI Usage is collecting now.' : 'Opening the AI Usage dashboard.')
  if (action === 'sync') $.clock.after(8_000, () => pollGlance($))
}

// After a response, the limits Claude Code holds were fetched by a request
// that began no earlier than `pendingSince`. They are left for the app only
// then: a measurement with no response since the last reading is an idle
// repeat, which the app could not date.
async function leaveReading($, e) {
  if (!paths || pendingSince == null || !Array.isArray(e.rateLimits) || e.rateLimits.length === 0) return
  const moved = Array.isArray(e.changed) && e.changed.includes('rateLimits')
  if (!moved && responsesSinceReading === 0) return
  const capturedMs = Date.now()
  const fetchedAfterMs = pendingSince
  // The next reading counts from the requests still running, if any.
  pendingSince = inFlight.size ? Math.min(...inFlight.values()) : null
  responsesSinceReading = 0
  const key = limitsKey(e.rateLimits)
  if (lastReading && lastReading.key === key && capturedMs - lastReading.atMs < UNCHANGED_READING_MS) return
  lastReading = { key, atMs: capturedMs }
  let model = null
  try {
    model = await $.session.model()
  } catch {
    // The model only labels the reading.
  }
  sequence += 1
  const record = readingRecord({ capturedMs, fetchedAfterMs, sessionId, model, rateLimits: e.rateLimits })
  if (!Object.keys(record.rate_limits).length) return
  await $.fs.write(paths.readings + '/' + readingFileName(capturedMs, sessionId, sequence), JSON.stringify(record) + '\n')
  // The app imports the reading and rewrites the glance a few seconds later.
  $.clock.after(6_000, () => pollGlance($))
}

// The same limits read twice: each window's used share and its reset to the
// minute, since a reset can be reported a second apart between responses.
function limitsKey(rateLimits) {
  return rateLimits
    .map((limit) => `${limit?.kind}:${limit?.percentUsed}:${Math.floor(Date.parse(limit?.resetsAt ?? '') / 60_000)}`)
    .sort()
    .join('|')
}

function problemLine(Text) {
  return problem ? [Text({ color: 'warning', wrap: 'wrap', children: [problem] })] : []
}

function terminalTape(Box, Text, row, width) {
  const cells = tapeCells(row, width)
  const color = PROVIDER_COLOR[row.id] ?? 'inactive'
  return Box({
    flexDirection: 'row',
    children: [
      Text({ color, children: ['█'.repeat(cells.solid)] }),
      Text({ color, dimColor: true, children: ['▒'.repeat(cells.shaded)] }),
      Text({ color: 'inactive', children: ['░'.repeat(cells.empty)] }),
    ],
  })
}

function providerRows(elements, row, now, surface, width) {
  const { Box, Text, Svg } = elements
  const status = statusOf(row.state)
  const color = PROVIDER_COLOR[row.id] ?? 'inactive'
  const name = Text({ color, bold: true, children: [row.name] })
  const figure = Text({ bold: !row.waiting, dimColor: row.waiting, children: [figureLabel(row)] })
  const state = Text({ color: status.color, children: [status.glyph + ' ' + status.word] })
  const lines = []
  if (surface === 'desktop' && Svg) {
    lines.push(Box({ flexDirection: 'row', columnGap: 2, children: [name, figure, state] }))
    lines.push(Svg({
      source: tapeSvg(row),
      alt: row.remaining == null ? 'No allowance reading yet'
        : `${figureLabel(row)} now${row.expectedRemaining == null ? '' : `; about ${percentLabel(row.expectedRemaining)} expected at reset`}`,
      width: 240,
      height: 8,
    }))
  } else {
    // Name, figure and status in fixed columns, the tape filling the rest;
    // on a narrow pane the tape takes its own line.
    const tapeWidth = width - 8 - 13 - 12 - 3
    const columns = [
      Box({ width: 8, children: [name] }),
      Box({ width: 13, children: [figure] }),
    ]
    if (tapeWidth >= 8) columns.push(terminalTape(Box, Text, row, tapeWidth))
    columns.push(Box({ width: 12, marginLeft: 1, children: [state] }))
    lines.push(Box({ flexDirection: 'row', columnGap: 1, children: columns }))
    if (tapeWidth < 8) lines.push(terminalTape(Box, Text, row, Math.max(8, width - 2)))
  }
  lines.push(Box({ paddingLeft: surface === 'desktop' ? 0 : 9, children: [Text({ dimColor: true, wrap: 'wrap', children: [detailLabel(row, now)] })] }))
  for (const entry of row.secondary) {
    lines.push(Box({
      paddingLeft: surface === 'desktop' ? 0 : 9,
      children: [Text({ dimColor: true, wrap: 'truncate-end', children: [
        `${entry.label}: ${percentLabel(entry.remaining)} left · ${statusOf(entry.state).word} · resets ${whenLabel(entry.resetsAt, now)}`,
      ] })],
    }))
  }
  return Box({ flexDirection: 'column', marginBottom: 1, children: lines })
}

function drawPane($, e) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const now = Date.now()
  const width = Math.max(32, Number(e.props?.bodyColumns) || 60)
  const running = glance ? appRunning(glance, now) : false
  const updated = !glance ? ''
    : running ? `updated ${relativeLabel(glance.collectedAt, now)}`
      : `not running · from ${relativeLabel(glance.collectedAt ?? glance.writtenAt, now)}`
  const header = Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: width - 2,
    children: [Text({ bold: true, children: ['AI Usage'] }), Text({ dimColor: true, children: [updated] })],
  })
  const body = []
  if (glance) {
    const verdict = statusOf(glance.verdict.state)
    body.push(Text({ color: verdict.color, bold: true, wrap: 'wrap', children: [verdict.glyph + ' ' + glance.verdict.headline] }))
    if (glance.verdict.detail) body.push(Text({ dimColor: true, wrap: 'wrap', children: [glance.verdict.detail] }))
    body.push(Text({ children: [' '] }))
    for (const row of glance.providers) body.push(providerRows(elements, row, now, e.surface, width))
    if (e.surface !== 'desktop') {
      body.push(Text({ dimColor: true, children: ['█ left at reset   ▒ likely used before reset'] }))
    }
  }
  const controls = Box({
    flexDirection: 'row',
    columnGap: 3,
    marginTop: 1,
    children: [
      Button({ key: 'sync', label: 'Sync now', hotkey: 's', plain: true, onPress: () => ask($, 'sync') }),
      Button({ key: 'open', label: 'Open dashboard', hotkey: 'o', plain: true, onPress: () => ask($, 'open') }),
      Button({
        key: 'band',
        label: bandOn ? 'Caution line: on' : 'Caution line: off',
        hotkey: 'c',
        plain: true,
        dimColor: !bandOn,
        onPress: async () => {
          bandOn = !bandOn
          $.ui.invalidate('ui.render')
          await $.store.set('band', bandOn)
        },
      }),
    ],
  })
  return Box({ flexDirection: 'column', children: [header, ...problemLine(Text), ...body, controls] })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    paths = await locate($)
    bandOn = (await $.store.get('band')) !== false
    try {
      sessionId = await $.session.id()
    } catch {
      sessionId = null
    }
    await loadGlance($)
    $.clock.every(POLL_MS, () => pollGlance($))
    try {
      await $.command.register({
        name: 'ai-usage',
        description: 'Show your AI Usage allowances (sync, open, text)',
        argumentHint: '[sync | open | text]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log('/ai-usage could not be added: ' + error.message, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'ai-usage' }, async ($, e) => {
    const action = String(e.args ?? '').trim().toLowerCase()
    if (action === 'sync' || action === 'refresh') {
      await ask($, 'sync')
      return {}
    }
    if (action === 'open' || action === 'dashboard') {
      await ask($, 'open')
      return {}
    }
    await loadGlance($)
    const surfaces = await $.session.surfaces()
    const draws = surfaces.includes('terminal') || surfaces.includes('desktop')
    // Text only where nothing draws, or when asked: it enters the conversation.
    if (action === 'text' || !draws) return { text: summaryText(glance, Date.now(), problem) }
    paneOpen = true
    await $.ui.open({ id: PANE_ID, title: 'AI Usage', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    paneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    return drawPane($, e)
  })

  // One line above the prompt while an allowance needs attention; nothing at
  // all while every allowance is on track, or the app is not running.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const message = bandOn && !e.props?.hasSurvey ? bandMessage(glance, Date.now()) : null
    if (!message) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const status = statusOf(message.state)
    const width = Math.max(20, (Number(e.props?.bodyColumns) || 80) - 2)
    const line = Box({
      flexDirection: 'row',
      width,
      children: [
        Text({ color: status.color, bold: true, children: [status.glyph + ' AI Usage  '] }),
        Text({ wrap: 'truncate-end', children: [message.text] }),
      ],
    })
    const below = await next(e)
    return below ? Box({ flexDirection: 'column', children: [line, below] }) : line
  })

  on('turn.step', async function* ($, e, next) {
    const token = {}
    const startedMs = Date.now()
    inFlight.set(token, startedMs)
    if (pendingSince == null) pendingSince = startedMs
    try {
      const result = yield* next(e)
      responsesSinceReading += 1
      return result
    } finally {
      inFlight.delete(token)
    }
  })

  on('session.measure', async ($, e, next) => {
    try {
      await leaveReading($, e)
    } catch (error) {
      $.ui.log('A plan-limit reading could not be saved: ' + error.message, { to: 'debug' })
    }
    return next(e)
  })
}
