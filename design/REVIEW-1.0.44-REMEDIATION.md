# AI Usage 1.0.44 review remediation

14 September 2026. Fixes for Claude's review of commit `003e97b`. Changes are local source changes; this work does not publish a release or update the installed application. The follow-up independent review and its resolution are recorded in [INDEPENDENT-REVIEW-1.0.44-FIXES.md](INDEPENDENT-REVIEW-1.0.44-FIXES.md).

## Initial remediation validation

- Full suite: **649 passing tests under Node 26.7.0 and 649 under Electron 44.3.0**, including real Chromium interaction tests with an isolated fake bridge.
- Type checking, JavaScript/accessibility lint, renderer formatting and production web build pass.
- Windows portable and NSIS installer builds pass, together with the full manifest/checksum/private-feed audit and packaged store, updater and Claude SDK imports. A clean temporary staging folder was used after OneDrive enumeration failed; staged application sources matched the workspace byte for byte. Nothing was installed or published.
- Independent reviewers checked collector changes, the root storage/forecast work, and lifecycle/IPC changes. Reproduced findings from those rechecks were fixed and covered by regressions.
- With explicit approval, the live database was opened read-only and consistently copied into a temporary directory outside OneDrive. Both old and updated stores retained **9,506 readings and 8,627 events**, and SQLite integrity checks passed. Cost analytics and cycle history matched. All temporary live-data copies were removed.
- On that live-data copy, cold snapshots measured **327 ms before / 212 ms after**; the third unchanged snapshot measured **54 ms before / 15 ms after**. These are local timings, not guarantees for every machine.
- A separate 50-day synthetic fixture also matched cost and cycle outputs, allowing deterministic ordering of projects with equal costs. Diagnostic logs and benchmark code are under the ignored `outputs/` directory.
- UI checks cover dark 1280×900 Overview and light 900×720 Costs. The sandbox requires a test-only `in-process-gpu` switch; production GPU behavior is unchanged.

## Forecast and allowance findings

| IDs | Resolution |
| --- | --- |
| F1 | Projection, active-hour measurement and learning intervals split at local clock-hour boundaries. Regression cases cover London, Kolkata, Kathmandu and Lord Howe offsets, with existing DST tests retained. |
| F2 | Overall-share Fable attribution only includes pressure after a manual anchor, while the denominator remains the complete bounded overall interval. |
| F3 | Each projected point is bounded by its contemporaneous overall ceiling. The raw accumulator is retained so later ceilings and the headline card agree. |
| F4 | Verdict reasons use the configured pace threshold. A single window cannot produce a misleading mixed/multiple-allowance label. |
| F5 | Zero-use rolling resets and their first pinned reset are normal idle startup, rather than confidence-reducing reset drift. |
| F6 | Store rows retain shared parsed observations; forecast learning models are reused for up to 60 seconds while the time-sensitive series is rebuilt. Evidence, settings, boundaries and clock rollback invalidate appropriately. |
| F7 | Prior windows shorter than six hours skip the impossible six-active-hour evidence scan. The threshold is retained rather than inventing a new short-window forecasting policy. |
| F8 | Observed graph points are limited to the last 48 hours plus one preceding point. Full historical evidence still feeds learning. |
| F9 | Early-reset identity checks compare fields directly instead of serializing every identity. Prepared observations avoid repeated timestamp parsing. |
| F10 | Allowance scalers are reused across consecutive rows of the same source, bucket and duration. Input rows remain immutable. |
| F11 | Shared named provenance rules distinguish provider readings from manual calibration evidence. SQL calibration lists are shared. |
| F12 | Renderer secondary ordering and freshness use shared selector/rules. |
| F13 | Dead projection reason branches and obsolete design claims were removed or corrected. |
| F14 | Removed the redundant current-cluster search/anchor guards and shared the forecast-state rule. |
| F15 | Confidence counts merged allowance windows, not rolling reset timestamps. |
| F16 | Skip the stored Fable forecast when a projection replaces it. Collector summaries reuse the store's projection cache. |

Read-time repeat collapsing happens **after allowance rescaling**, after horizon filtering, and splits runs at local midnight and the evaluation clock. It retains endpoints and does not delete original readings. This ordering is regression-tested: collapsing before rescaling lost evidence at allowance changes.

## Storage and backups

| IDs | Resolution |
| --- | --- |
| S1, M15 | Unique owned partial files, close/rename/register sequencing, failure cleanup, persisted one-hour retry backoff, and a sweep restricted to abandoned new-format partial files. Completed unregistered backups are preserved, including after database corruption recovery. |
| S2 | Row-by-row gzip export using bounded gzip members, read from the consistent SQLite backup. Restore accepts legacy JSON and gzip, with a 64 MB input/decompressed limit. Oversized recovery still requires the paired SQLite backup; unlimited streaming restore was not added. |
| S3, S5 | Compaction merges actual allowance windows and processes only newly eligible/dirty days. Transactional dirty markers catch backdated inserts and updates from other connections. Daily endpoints, peaks and manual readings are retained. |
| S4 | Cycle pricing groups by model and per-request context tier in SQL, preserving legacy cache-duration rules and token accounting. |
| S6 | Collapse repeated forecast input on read, preserving stored evidence and cycle reading counts. |
| S7 | Reuse bounded raw rows and daily aggregates, while keeping exact rolling reporting/learning boundaries. The proposed 15-minute change to the displayed horizon was intentionally replaced by caching that preserves boundary behavior. |
| S8 | Candidate reads use a recent-range UNION with indexed latest-per-bucket seeks. |
| S9 | Capture quota revisions before reading candidate rows, preventing a concurrent commit from labeling old evidence with a new revision. |
| S10 | Capacity evidence selects only used columns and uses the indexed time order. |
| S11 | Settings repair filters invalid allowance-change entries individually and tolerates valid future entries after clock rollback. New user input retains its future-date validation. |
| S12 | Daily ingestion and restore validate real dates and nonnegative integral token totals. |
| S13 | Legacy date/bucket cleanup has a migration marker. |
| S14 | Removed the unused source/model usage index. |
| S15 | Removed unused observation-query methods. Retained the small validated `restoreFromBackup` convenience API used by recovery tests. |
| S16 | Caches consistently check SQLite transaction state. |
| S17 | Column additions and their required transcript-rescan invalidation occur in one transaction. |

Daily analytics reuse revisioned aggregate rows. Aggregation keeps per-request long-context tiers, legacy cache durations, task/agent metadata, original request counts and first/last activity times. UTC **quarter-hour** groups preserve local hourly/day boundaries in fractional-offset zones. A UTC-hour grouping introduced during implementation was rejected by independent review and fixed.

Future backups go to `%APPDATA%\ai-usage\Backups`; older Documents/OneDrive backups remain where they were and can be selected in the restore dialog. No historical backup collection or old test/build directories were deleted.

## Main process and dashboard

- **M1–M14, M16–M20:** bounded plain-language IPC errors; lightweight hidden refreshes; full snapshots on show; background helper refresh; stable collection scheduling; removal of unused/duplicate snapshot deliveries; settings-only patches where safe; bounded truthful tray tooltips; snooze-expiry refresh; resume grace period; credential preservation restricted to the verified installer/elevation launches; actual directory-write probe; read-only maintenance outside the exclusive write lane; deferred quit handling during update preparation; hidden login launch; single web-content hardening; extracted/testable IPC registration with actual main/preload tests.
- **R1–R24:** severity-sorted attention rows without clipping; persistent task/session tables and expanded context; pending-period tracking; remembered per-currency rates and explicit first-time EUR entry; shared freshness/reset ticking; truthful chart alternatives and expired-series filtering; focus, contrast, live-region and modal fixes; fixed currency precision and conservative price-coverage rounding; accurate analysis-period wording; accessible chart tables/empty states/settings groups; one consolidated CSS/theme layer; shared provider rules; lazy demo chunk and hidden source maps; destination-level error boundaries with bounded main-process logging; real DOM interaction regressions.
- **R14:** removed unused subscription-fee controls and misleading comparison copy. Existing stored values are retained for compatibility.

Independent lifecycle rechecks additionally caught and fixed tray-only payloads escaping as full snapshots, expired caches overriding the renderer, quitting while storage close was pending, Electron test installation order in CI, and credential loss on asynchronous elevation retry. Actual UAC/installer execution was not invoked.

## Collectors

- **C1–C5:** skip/repair copied fork and synthetic usage with a safety backup and strict ownership checks; import scheduling cannot starve SDK deadlines; SDK evidence is timestamped when fetched; status-line freshness follows capture time; streaming input avoids giant remainder strings. Empty-ledger Codex imports and ordinary incremental appends use one pass; cursorless imports with historical Codex event keys conservatively use one additional combined collision/duplicate preflight pass to protect restored records.
- **C7–C15:** incremental status-line inbox reads and grace-period cleanup; shared duration/window labels; map-key Codex limit identity; no repeated probe when the SDK supplies no freshness line; synthetic rows excluded; redundant fallback/dead branches removed; queued refreshes coalesce.
- **C6 — intentionally retained:** discovery still inspects older files. Skipping older date folders can miss resumed Codex sessions, and Claude's folders are project-based. A recent-folder-only optimization would trade accurate accounting for speed and was not applied.

## Tests, build and remaining decisions

- **T1–T3:** fixed snapshot clocks; shared isolated provider environment; clean up only the test run's own temporary folders.
- **T5–T14:** shipped Electron runtime tests, main/preload behavioral tests, asynchronous mutation-resistant assertions, disposable-database fast SQLite settings, bounded test concurrency, migration/restore/SDK/audit coverage, explicit test timezone, behavioral replacements for brittle source-text checks, SHA-pinned actions, explicit permissions/concurrency and pinned Node.
- **T15:** CI verification and packaging share setup/build steps. Release-time rebuilding remains so the exact tagged source is built and audited before publication.
- **T16:** Electron 44.3.0 and Claude SDK 0.3.270 were verified and pinned; Dependabot is configured. Both runtime suites pass with those versions.
- **T18–T21:** accessibility lint, unused SDK/demo build exclusions, build outputs outside OneDrive, and a version bump/check tool.
- **T4 — administrative prerequisite:** local code cannot establish trusted repository writers, protected refs/environments or a signing identity. SHA pins and restricted workflow tokens improve the workflow but do not claim to solve unauthorized publication by a repository writer. This requires repository administration and signing credentials.
- **T17 — deferred optional typing project:** full Electron JavaScript `checkJs` adoption needs a separate annotation pass. Renderer type checks, JavaScript/accessibility lint and both runtime suites are enforced; no blanket suppressions were added to pretend that annotation work is complete.
- The longer-term suggestion to move all snapshot construction into the collector process is not required for these fixes and was not adopted. Hidden snapshots and measured in-process work were reduced directly.
