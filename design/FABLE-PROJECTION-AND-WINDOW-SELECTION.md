# Fable as a projection, and one rule for the displayed window

Plan for a single pull request against `main` at 1.0.42, prepared as 1.0.43. Implemented on `claude/fable-projection`; the notes below are the design record. Two deviations from the plan as written: the projection module and its store wiring landed in one commit rather than two, and the renderer consumes the shared rule through `forecast.expired` as its expiry signal rather than a clock, since the store sets that flag from the same comparison. Two structural changes, shipped together because the second removes most of the code the first would otherwise have to touch.

1. **One shared selector** decides which allowance window a provider headlines, which are secondary, and which are expired. The store, notifications, verdict, renderer and Claude tracker all use it.
2. **The Fable 5 estimate becomes a projection** computed when a snapshot is built, from official rows and local activity. It is never written to `quota_observations` again.

## Why

Pull requests #30 and #31 each took four or five rounds of automated review. Every finding was one of two things: a persisted Fable estimate that had outlived the settings or evidence it was computed from, or one of ten hand-written copies of "which row does the card show" disagreeing with another. The end-to-end review of 14 September 2026 reproduced two live bugs from those seams:

- Derived Fable rows written after an allowance boundary but before the entry was saved are never rescaled or removed. The card shows the corrected figure; the Fable forecast's learning and cycle peak still contain the phantom step.
- Derivation is gated on the newest overall row's plan type. Status-line rows carry no plan, so one status-line row newer than the last SDK row switches derivation off, and the 1.0.42 settings path then discards the live estimate.

A projection has no rows to go stale and no rows to discard, and one selector cannot disagree with itself.

## Part 1 — `electron/quota-selection.mjs`

Shared with the renderer the same way `dashboard-decision.mjs` is: an ESM source, a one-line `quota-selection.cjs` re-export for the main process, and a `quota-selection.d.mts` declaration.

### Interface

```ts
type Selection<T> = { primary: T | null; active: T[]; secondary: T[]; expired: T[] };

// Windows carry the QuotaWindow shape the store already builds: bucketId,
// sourceId (added, see below), observedAt, resetsAt, windowMinutes,
// provenance, metadata. Rows straight from SQLite are adapted by the caller.
export function selectDisplayedWindows<T extends WindowLike>(sourceId, windows: T[], nowMs: number): Selection<T>;
export function isMainWindow(sourceId, window): boolean;
export function isOfficial(window): boolean;
```

### The rule, written once

1. **Usable**: `validQuotaTime(observedAt, resetsAt, windowMinutes, nowMs)` from `quota-time.cjs`. Anything else is dropped before ordering.
2. **Expired**: `resetsAt <= nowMs`. This is the only definition. `forecast.expired` stays on the forecast object because the renderer reads it, and `forecastQuota` already sets it from the same comparison; the selector does not read it.
3. **Main**: Codex when `metadata.limitId === 'codex'` or the bucket matches `codex:(weekly|primary|secondary)`. Claude when `metadata.scope === 'overall'`, or when there is no scope and the bucket is `seven_day` or `five_hour`. Fable: `fable_seven_day` and `fable:seven_day_fable`. Everything else is secondary. This is the narrow rule from `lib.ts`; the store's current negative rule (anything not model-scoped and not ending in `_opus`, `_sonnet`, `_oauth_apps`) is dropped. The one behavioural change: an unrecognised scope-less Claude bucket becomes secondary rather than a headline candidate.
4. **Order** among usable windows: active before expired; main before secondary; longer `windowMinutes` first; official provenance before derived; newest `observedAt`; then `bucketId` for a stable tie-break.
5. `primary` is the first active window, or the first expired one when nothing is active so the provider still reports as expired rather than vanishing. `active` is every active window in order. `secondary` is `active` minus `primary`.

### Consumers and what they stop doing

| Site | Today | After |
|---|---|---|
| `store.getQuota` (`store.cjs` ~1033) | own six-key sort and `overall()` predicate | orders `windows` with the selector; top-level fields come from `primary`. Adds `sourceId` to each window so the selector and renderer stop inferring it from bucket names. |
| `src/lib.ts primaryWindow`, `quotaWindows` | twin copy of the rule | thin wrappers over the selector |
| `electron/notifications.cjs primaryWindow` | twin copy | wrapper over the selector |
| `electron/dashboard-decision.mjs quotaWindows` | active-or-first-slice | `selection.active`, falling back to `[primary]` |
| `src/provider-view.ts` | lib wrappers | unchanged API, shared rule |
| `src/components/TokenCapacity.tsx capacityWindows` | own Codex newest-by-observation sort | filters `selection.active` to weekly, token-scoped windows and keeps selector order; the newest-live-slot rule is kept as a filter, not a competing sort |
| `src/components/Overview.tsx RecentCycles` | trusts store primary equals card headline | true by construction; comment updated |
| `electron/fable-tracker.cjs getLastCurrentOfficial` | raw SQL with `resets_at > now` and no skew check | adapts rows and uses the selector with an official-provenance filter |
| `lib.ts verdictSentence` | inlined freshness limit | imports it from `dashboard-decision.mjs` (small, while in the file) |

`claude-collector.cjs displayedFableReading` and `rederiveFableEstimate` are deleted by Part 2, so they need no migration to the selector.

### Tests

`tests/quota-selection.test.cjs`: ordering across every rule, expired-only providers, the scope-less Claude bucket change, Codex slot names, Fable buckets, and a table-driven check that `selectDisplayedWindows` agrees with `getQuota` output on the fixtures already used in `store.test.cjs`, `notifications.test.cjs` and `renderer-behavior.test.cjs`. Existing tests that assert window order keep passing unless they relied on the dropped negative rule; those are updated with a note.

## Part 2 — `electron/fable-projection.cjs`

### What moves

The arithmetic in `deriveFableEstimate`, `fablePairCalibration`, `fableStepsFromOverall`, `allowancePressure` and `allowanceAdjustedUsed` moves unchanged into `fable-projection.cjs`. The only edits are the gate and the output.

```js
// Read-only. Never writes to quota_observations.
projectFableAllowance(store, settings, nowMs) -> {
  available: boolean,
  reason: string | null,        // projection availability reason
  method: 'fable-anchor-pair' | 'overall-share' | null,
  window: QuotaWindow | null,   // observedAt = nowMs, provenance 'derived-tokens', metadata.calibration as today, metadata.projected: true
  series: [{ observedAt, usedPercent }],  // see below
}
```

### The gate (fixes the plan-type bug)

Plan confirmation uses the most recent `official-claude-usage` row in the current overall window, not the newest row of any provenance. Status-line rows never carry a plan and cannot switch the projection off. If no SDK row in the window says `max`, the projection is unavailable with the existing reason `fable-not-confirmed-in-shared-plan`.

The store and collector give active provider-scoped Fable readings precedence. Manual official readings remain calibration anchors, so estimates can advance from them using subsequent local activity. The projection itself does not emit an `official-current` reason.

### The series (keeps the forecast's learning)

Today the Fable forecast learns from a derived row written every refresh. A projection that returned only the current point would starve it. So the projection also returns the points the derivation already computes internally:

- **overall-share**: the base value plus cumulative steps at each overall official reading inside the window, then the current point with the tail.
- **anchor-pair**: the current projected point. Persisted official anchor rows are supplied separately to the forecast; they are not duplicated in the generated series.

`getQuota('claude-fable')` feeds `forecastQuota` the official rows plus the series as non-persisted rows with `provenance: 'derived-tokens'`. The forecast already treats that provenance as non-reset-evidence with a 0.65 weight, so no forecast change is needed. Allowance changes apply through the existing scaler because the projection reads overall rows through `allowanceAdjustedUsed`; ignored days are honoured because the forecast, not the projection, applies them.

### Store wiring

- `getQuota('claude-fable')` builds windows from persisted rows as today. If the selector finds no live official Fable window and the projection is available, it appends the projected window, runs its forecast over official rows plus the series, and lets the selector order it. Token capacity for the projected window is computed as today from official readings only.
- **Cache** `fableProjectionCache`, shaped like `tokenCapacityCache`: keyed on the `claude`/`seven_day` and `claude-fable`/`fable_seven_day` quota revisions, the `claude` usage revision, and `JSON.stringify(settings.allowanceChanges)`; `expiresAt` is the earliest of the window reset, the next future-dated usage event, any future-dated `allowanceChanges.at`, and `nowMs + 60_000` because the tail grows with wall time. Transactional reads bypass it like the other caches.
- **Migration** `migration.fable-projection-v1`, following the `fable-plan-evidence-v1` pattern at `store.cjs` ~449: delete every `provenance = 'derived-tokens'` row once, inside `BEGIN IMMEDIATE`, and record the marker in `settings`.
- **`recordObservation`**: the upsert guard that stops a derived row displacing an official one (`store.cjs` ~779) is deleted; nothing writes that provenance any more. Ingest rejects `provenance: 'derived-tokens'` outright so a stale collector cannot reintroduce rows.
- **Restore**: legacy derived rows in old exports are skipped and counted, no longer thrown as unreadable (`store.cjs` ~1970).
- **Cycle history** for Fable is built from official rows only. When only the projection exists, `RecentCycles` shows no current cycle for Fable. That is honest and is called out in the README.

### Removals

- `claude-collector.cjs`: `deriveFableEstimate`'s write, `rederiveFableEstimate`, `displayedFableReading`, and the `store.recordObservation` call. `refreshClaude` calls `projectFableAllowance` read-only to fill `fableDerived` in the source status with the same `{ derived, reason, method, measuredSteps, measuredPairs, anchored }` shape, so `DiagnosticsSection.tsx` and the status wording are untouched.
- `main.cjs` `dashboard:update-settings`: the Claude-entries diff and the re-derive call. `invalidateSnapshot()` is sufficient because the projection is part of the snapshot.
- `tests/fable-rederive.test.cjs`: deleted; its scenarios become projection tests (below).

### Renderer

No visible change. `provider-view.ts` keys "Local estimate" on `provenance === 'derived-tokens'`, which the projected window carries. `metadata.projected` is available for a future note but is not surfaced now.

### Tests

- `tests/fable-projection.test.cjs`: the five derivation tests moved from `claude-collector.test.cjs` (share, Opus-only, Fable-only, Pro plan refused, unknown plan refused) rewritten against the pure function; the 1.0.42 scenarios (allowance change rescales the estimate, removal restores it, a Codex entry changes nothing, no overall reading gives `no-overall-reading`); a status-line row newer than the SDK row does not switch the projection off; the series has one point per overall step plus the current point; active provider-scoped readings retain display precedence.
- `tests/store.test.cjs`: `getQuota('claude-fable')` appends the projected window only without a live official one; cache invalidates on a Claude usage write, a Claude or Fable quota write, and an `allowanceChanges` save; migration removes legacy derived rows once; ingest rejects `derived-tokens`; restore skips legacy rows and counts them.
- `tests/claude-collector.test.cjs`: `refreshClaude` reports the projection in `fableDerived` and writes no Fable rows.
- Snapshot-level: `renderer-behavior.test.cjs` demo snapshot gains a projected Fable window fixture so the "Local estimate" path stays rendered.

## Sequencing inside the PR

Five commits, each green on `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`:

1. Add `quota-selection.mjs/.cjs/.d.mts` and its tests. No consumers yet.
2. Switch every consumer in the Part 1 table to it and delete the duplicates.
3. Add `fable-projection.cjs` as a pure move of the arithmetic with the gate change, and its tests. The collector still writes rows at this point.
4. Wire the projection into `getQuota`, add the cache, migration, ingest rejection and restore skip; delete the write path, the settings hook and `fable-rederive.test.cjs`.
5. README (Fable tracking section, allowance-changes paragraph, cycle-history note), CHANGELOG 1.0.43, and the version bump in package.json, package-lock.json, README installer names and `tests/release-contract.test.cjs`.

## Acceptance

- Saving, removing or restoring an allowance change never leaves a Fable figure computed under the old allowance anywhere in the snapshot: card, forecast series, cycle peak.
- A status-line row newer than the last SDK row does not change the Fable estimate's availability.
- Card, tray tooltip, digest, verdict, recent-cycles row and token-capacity panel name the same window for each provider on every fixture in the test suite.
- `grep -r "derived-tokens" electron src` matches only the projection's output provenance, the ingest rejection, the restore skip and the renderer label.
- No `quota_observations` write from any Fable code path.

## Risks

- **Selector rule change** for scope-less Claude buckets with unrecognised suffixes. Mitigated by the table-driven agreement test; a real user database can be checked with the store benchmark harness before release.
- **Forecast quality** for helper-only users if the series is thinner than the old per-refresh rows. Mitigated by emitting a point per overall step; verified by asserting `learnedSamples` on a fixture against the pre-change value.
- **Snapshot cost**: the projection runs a handful of indexed queries; the cache bounds it to once a minute or once per write. Measured with `tools/benchmark-analytics.cjs` style timing before and after, as for PR #27.
- **Migration** deletes derived rows from existing databases. They are reproducible estimates and a precedent exists; a safety backup precedes migrations already.

## Out of scope, deliberately

- Stable Codex window identity across `primary`/`secondary` slot flips, and canonicalising `fable:*` status-line keys. Separate PR with its own merge migration.
- A declarative settings-effects table. Largely moot once the projection exists; revisit if another setting grows a derivation.
- Five-hour or model-scoped allowance changes.
