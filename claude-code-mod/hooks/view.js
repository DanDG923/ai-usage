// Pure helpers for the AI Usage mod: reading the glance the app writes,
// wording it, and shaping the reading files the app imports. Nothing here
// touches the mods API, so the hooks module stays the one place that acts.

export const PANE_ID = 'ai-usage'
export const GLANCE_SCHEMA = 1
export const READING_FORMAT = 'ai-usage-claude-code-reading'
export const REQUEST_FORMAT = 'ai-usage-claude-code-request'

// The app rewrites the glance every few minutes while it runs; older than
// this, it has stopped and the figures are only as current as that moment.
export const APP_SILENT_MS = 15 * 60_000

// The Flight Deck provider colours (src/styles/tokens.css), the same in both themes.
export const PROVIDER_COLOR = { codex: '#087aaf', claude: '#9d6fe3', fable: '#d2119a' }

const STATES = new Set(['safe', 'watch', 'risk', 'critical', 'unknown'])
const STATUS = {
  safe: { word: 'On track', glyph: '✓', color: 'success' },
  watch: { word: 'Watch', glyph: '▲', color: 'warning' },
  risk: { word: 'At risk', glyph: '▲', color: 'warning' },
  critical: { word: 'Critical', glyph: '■', color: 'error' },
  unknown: { word: 'Learning', glyph: '○', color: 'inactive' },
}

export function statusOf(state) {
  return STATUS[STATES.has(state) ? state : 'unknown']
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const textOr = (value, fallback) => (typeof value === 'string' ? value : fallback)
const timeOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)

/**
 * The glance file's text as the mod uses it, or null when it is not one this
 * mod understands. Every field is re-checked: the file is the app's, but a
 * half-written or older copy must draw as "no reading", never as a number.
 */
export function parseGlance(text) {
  let value
  try {
    value = JSON.parse(String(text).replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!isRecord(value) || value.schema !== GLANCE_SCHEMA || !Array.isArray(value.providers)) return null
  const verdict = isRecord(value.verdict) ? value.verdict : {}
  return {
    appVersion: textOr(value.appVersion, null),
    writtenAt: timeOrNull(value.writtenAt),
    generatedAt: timeOrNull(value.generatedAt),
    collectedAt: timeOrNull(value.collectedAt),
    verdict: {
      state: STATES.has(verdict.state) ? verdict.state : 'unknown',
      headline: textOr(verdict.headline, 'Usage status unknown'),
      detail: textOr(verdict.detail, ''),
    },
    providers: value.providers.filter(isRecord).map((row) => ({
      id: textOr(row.id, ''),
      name: textOr(row.name, 'Allowance'),
      subtitle: textOr(row.subtitle, ''),
      state: STATES.has(row.state) ? row.state : 'unknown',
      waiting: row.waiting === true || finiteOrNull(row.remaining) == null,
      remaining: finiteOrNull(row.remaining),
      expectedRemaining: finiteOrNull(row.expectedRemaining),
      estimated: row.estimated === true,
      usable: row.usable === true,
      resetsAt: timeOrNull(row.resetsAt),
      stale: row.stale === true,
      secondary: Array.isArray(row.secondary)
        ? row.secondary.filter(isRecord).map((entry) => ({
            label: textOr(entry.label, 'Allowance'),
            state: STATES.has(entry.state) ? entry.state : 'unknown',
            remaining: finiteOrNull(entry.remaining),
            resetsAt: timeOrNull(entry.resetsAt),
          }))
        : [],
    })),
    alertsSnoozedUntil: timeOrNull(value.alertsSnoozedUntil),
  }
}

/** Whether the app has rewritten the glance recently enough to be running. */
export function appRunning(glance, nowMs) {
  const written = Date.parse(glance?.writtenAt ?? '')
  return Number.isFinite(written) && nowMs - written <= APP_SILENT_MS
}

const pad = (value) => String(value).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']

/** "Thu 14:00" within six days, otherwise "3 Oct": the flyout's reset label. */
export function whenLabel(value, nowMs) {
  const ms = Date.parse(value ?? '')
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  if (Math.abs(ms - nowMs) < 6 * 86_400_000) return `${DAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** "just now", "4 min ago", "2 h ago", then a date. */
export function relativeLabel(value, nowMs) {
  const ms = Date.parse(value ?? '')
  if (!Number.isFinite(ms)) return 'never'
  const minutes = Math.round((nowMs - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  const date = new Date(ms)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

export const percentLabel = (value) => (value == null ? '—' : `${Math.round(value)}%`)

/** "62% left", "~31% usable", or a dash for no reading. */
export function figureLabel(row) {
  if (row.remaining == null) return '—'
  return `${row.estimated ? '~' : ''}${percentLabel(row.remaining)} ${row.usable ? 'usable' : 'left'}`
}

/** The line under a provider: plan and window, the forecast at reset, and when. */
export function detailLabel(row, nowMs) {
  if (row.waiting) return row.subtitle && row.subtitle !== 'Awaiting data' ? `${row.subtitle} · waiting for a reading` : 'Waiting for a reading'
  const parts = [row.subtitle]
  parts.push(row.expectedRemaining == null ? `resets ${whenLabel(row.resetsAt, nowMs)}` : `${percentLabel(row.expectedRemaining)} at reset · ${whenLabel(row.resetsAt, nowMs)}`)
  if (row.stale) parts.push('needs a refresh')
  return parts.filter(Boolean).join(' · ')
}

/**
 * The flyout's fuel tape laid flat, in cells: solid is what is expected to
 * be left at the reset, shaded is likely used before it, empty is used.
 * Without a forecast the balance is shaded, since neither part is known.
 */
export function tapeCells(row, width) {
  const cells = Math.max(4, Math.floor(width))
  if (row.remaining == null) return { solid: 0, shaded: 0, empty: cells }
  const left = Math.round((Math.max(0, Math.min(100, row.remaining)) / 100) * cells)
  const atReset = row.expectedRemaining == null ? 0 : Math.min(left, Math.round((Math.max(0, row.expectedRemaining) / 100) * cells))
  return { solid: atReset, shaded: left - atReset, empty: cells - left }
}

/** The same tape as a small SVG for the Desktop app, which has no cells. */
export function tapeSvg(row, width = 240, height = 8) {
  const color = PROVIDER_COLOR[row.id] ?? '#888888'
  const scale = (value) => (Math.max(0, Math.min(100, value ?? 0)) / 100) * width
  const left = row.remaining == null ? 0 : scale(row.remaining)
  const atReset = row.expectedRemaining == null ? 0 : Math.min(left, scale(row.expectedRemaining))
  const r = height / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="${r}" fill="#8a8f98" fill-opacity="0.22"/>`
    + `<rect width="${left.toFixed(1)}" height="${height}" rx="${r}" fill="${color}" fill-opacity="0.38"/>`
    + `<rect width="${atReset.toFixed(1)}" height="${height}" rx="${r}" fill="${color}"/>`
    + '</svg>'
}

/** What the band says above the prompt, or null when nothing needs attention. */
export function bandMessage(glance, nowMs) {
  if (!glance || !appRunning(glance, nowMs)) return null
  const { state, headline, detail } = glance.verdict
  if (!['watch', 'risk', 'critical'].includes(state)) return null
  const snoozed = Date.parse(glance.alertsSnoozedUntil ?? '')
  if (Number.isFinite(snoozed) && snoozed > nowMs) return null
  return { state, text: detail ? `${headline} — ${detail}` : headline }
}

/** The glance as plain text, for a surface that draws nothing (and for /ai-usage text). */
export function summaryText(glance, nowMs, problem = null) {
  if (!glance) return problem || 'AI Usage has not shared any allowances yet. Open the AI Usage app once to start.'
  const lines = []
  const running = appRunning(glance, nowMs)
  lines.push(`${statusOf(glance.verdict.state).glyph} ${glance.verdict.headline}${glance.verdict.detail ? ` — ${glance.verdict.detail}` : ''}`)
  for (const row of glance.providers) {
    lines.push(`${row.name}: ${figureLabel(row)} · ${statusOf(row.state).word} · ${detailLabel(row, nowMs)}`)
    for (const entry of row.secondary) {
      lines.push(`  ${entry.label}: ${percentLabel(entry.remaining)} left · resets ${whenLabel(entry.resetsAt, nowMs)}`)
    }
  }
  lines.push(!running
    ? `AI Usage is not running; these figures are from ${relativeLabel(glance.collectedAt ?? glance.writtenAt, nowMs)}.`
    : glance.collectedAt ? `Updated ${relativeLabel(glance.collectedAt, nowMs)} by AI Usage.` : 'AI Usage has not collected yet.')
  return lines.join('\n')
}

const safeName = (value) => String(value ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 36) || 'session'

/** A reading's file name: sortable by capture time, unique within a session. */
export function readingFileName(capturedMs, sessionId, sequence) {
  return `${String(Math.max(0, Math.floor(capturedMs))).padStart(15, '0')}-${safeName(sessionId)}-${sequence}.json`
}

/**
 * The reading the app imports: the session's plan limits in the status
 * line's shape, captured just after a response, and when the earliest
 * request that could have delivered them began.
 */
export function readingRecord({ capturedMs, fetchedAfterMs, sessionId, model, rateLimits }) {
  const limits = {}
  for (const limit of rateLimits ?? []) {
    if (!isRecord(limit) || typeof limit.kind !== 'string' || !limit.kind) continue
    if (finiteOrNull(limit.percentUsed) == null || !timeOrNull(limit.resetsAt)) continue
    limits[limit.kind] = { used_percentage: limit.percentUsed, resets_at: limit.resetsAt }
  }
  return {
    format: READING_FORMAT,
    version: 1,
    captured_at: new Date(capturedMs).toISOString(),
    fetched_after: new Date(fetchedAfterMs).toISOString(),
    session_id: typeof sessionId === 'string' ? sessionId : null,
    model: typeof model === 'string' && model ? { id: model } : {},
    rate_limits: limits,
  }
}

/** A request for the app: collect now, or open the dashboard. */
export function requestRecord(action, nowMs) {
  return { format: REQUEST_FORMAT, version: 1, action, requested_at: new Date(nowMs).toISOString() }
}
