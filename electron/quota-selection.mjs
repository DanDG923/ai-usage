// The one rule for which allowance window a provider headlines, which windows
// sit beneath it, and which are history. Shared with the renderer the same
// way dashboard-decision.mjs is, so the store, notifications, verdict, cards,
// cycle history and token-capacity panel cannot drift apart: every "which
// row does X show" bug so far came from a second copy of this rule.
//
// Windows carry the QuotaWindow shape the store builds. Expiry is supplied by
// the caller: the store knows the clock, the renderer reads the flag the
// store already set on each forecast from the same comparison.

import { isProviderProvenance } from './quota-provenance.mjs';

const CODEX_MAIN_BUCKET = /^codex:(?:primary|secondary|weekly)$/;
const CLAUDE_MAIN_BUCKETS = new Set(['seven_day', 'five_hour']);
const FABLE_MAIN_BUCKETS = new Set(['fable_seven_day', 'fable:seven_day_fable']);

// The subscription's own allowance, as opposed to a model-specific or
// OAuth-app limit reported alongside it. Bucket names are disjoint across
// providers, so the window's own fields suffice. Manual and older restored
// Codex readings may lack a limit id; the canonical bucket names stand in.
export function isMainWindow(window) {
  const bucketId = String(window?.bucketId || '');
  const metadata = window?.metadata || {};
  if (metadata.limitId === 'codex' || CODEX_MAIN_BUCKET.test(bucketId)) return true;
  if (FABLE_MAIN_BUCKETS.has(bucketId)) return true;
  if (metadata.scope) return metadata.scope === 'overall';
  return CLAUDE_MAIN_BUCKETS.has(bucketId);
}

export function isOfficialWindow(window) {
  return isProviderProvenance(window?.provenance);
}

function expiryOf({ nowMs, isExpired } = {}) {
  if (typeof isExpired === 'function') return isExpired;
  if (Number.isFinite(nowMs)) return (window) => Date.parse(window?.resetsAt) <= nowMs;
  return (window) => Boolean(window?.forecast?.expired);
}

// Active before expired; the subscription's own allowance before model or
// app limits; the longer window first, so every provider headlines its
// weekly plan; a provider-backed reading before a local estimate; the newest
// reading; then the bucket id so equal windows order the same way every time.
export function orderWindows(windows, options = {}) {
  const expired = expiryOf(options);
  return (Array.isArray(windows) ? windows : []).filter(Boolean).map((window, index) => ({ window, index, expired: expired(window) }))
    .sort((a, b) => Number(a.expired) - Number(b.expired)
      || Number(isMainWindow(b.window)) - Number(isMainWindow(a.window))
      || (Number(b.window.windowMinutes) || 0) - (Number(a.window.windowMinutes) || 0)
      || Number(isOfficialWindow(b.window)) - Number(isOfficialWindow(a.window))
      || (Date.parse(b.window.observedAt) || 0) - (Date.parse(a.window.observedAt) || 0)
      || String(a.window.bucketId || '').localeCompare(String(b.window.bucketId || ''))
      || a.index - b.index);
}

// `primary` is the first active window, or the first expired one when
// nothing is active so the provider still reports as expired rather than
// disappearing. `active` keeps every live window in display order.
export function selectDisplayedWindows(windows, options = {}) {
  const ordered = orderWindows(windows, options);
  const active = ordered.filter((entry) => !entry.expired).map((entry) => entry.window);
  const expired = ordered.filter((entry) => entry.expired).map((entry) => entry.window);
  const primary = active[0] ?? expired[0] ?? null;
  return { primary, active, secondary: active.filter((window) => window !== primary), expired };
}
