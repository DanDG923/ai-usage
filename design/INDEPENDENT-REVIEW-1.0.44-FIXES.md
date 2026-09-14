# Independent review of the 1.0.44 fixes

14 September 2026. Reviewed the working tree against `003e97b26ae7a2daea2f149ea155b5877987dd59`, including new untracked modules. Three fresh reviewers received the original Claude report and source, without the implementation conversation. Application source was unchanged during this review.

**Follow-up status: all five findings fixed and independently rechecked.** The original findings below are retained as the review record; the release hold they identified is resolved in local source. Nothing has been installed or published.

## Resolution and final validation

- Completed unregistered backups survive database recovery and repeated retention pruning. Only old owned partial files are swept. An independent check preserved the original bytes across four additional retention-1 cycles and restored the original usage event.
- Fable replacement is decided before forecast calculation. Every retained window has a forecast, including the alternate official bucket case; a forecast actually replaced by projection is still skipped. The actual provider-view renderer and five additional window scenarios passed independent checks.
- Cursorless imports check the globally unique Codex event-key namespace regardless of provider assignment. Conflicting records are preserved, and verified repairs receive a safety backup. Historical cursorless imports conservatively need one additional combined preflight pass; clean first imports and ordinary incremental appends remain single-pass.
- Reader failures are caught per file, with failed-file rows, counters and cursors rolled back or left unchanged. Healthy files continue and failed files retry successfully. Independent injected database errors still propagate rather than being mistaken for transcript errors.
- README now consistently describes the current AppData location and compressed format, with Documents identified only as a legacy location.
- **Final full suite: 661 passed under Node and 661 under Electron**, zero failures or skips. Twelve new regression tests were added. Lint, type checking, production web build and whitespace checks pass.
- Independent storage review: 42 focused tests plus recovery/pruning and Fable scenario probes. Independent collector review: 118 focused tests under both runtimes plus read-failure, recovery, first-import and database-error probes. Neither recheck found a remaining actionable issue within its assigned scope.
- All tests and probes used synthetic data. No live database, provider calls, installation or publication was performed. Installer packaging was not repeated for this follow-up; the prior package artifacts predate these fixes.

## Original review findings

## Standards

### P3 — Conflicting backup instructions

`README.md:176–180` describes current backups as Documents/AI Usage/Backups and readable `.aiusage.json`, while `README.md:228` describes the new AppData location and compressed exports. Following the original recovery instructions can lead someone to copy or search legacy backups instead of the latest set. Rewrite the canonical sections and retain one legacy-location note.

This is an actionable duplicated-documentation heuristic, not an explicit repository standards breach. No additional impactful standards finding was established.

## Spec and correctness

### P1 — Database recovery can delete usable backups

**Location:** `electron/store.cjs:2057–2062`; invoked before backup creation at line 2023.

Original report §7 warns that unregistered backups may hold history predating the current database and says to check before deleting. The new sweep deletes completed UUID-named files older than 24 hours when they are absent from the current database's backup table. Database corruption recovery creates an empty table, so valid recovery files meet that condition.

**Reproduction:** create a synthetic backup containing one usage event, age its files 48 hours, corrupt only the synthetic database, and reopen through the real recovery path. Both recovery files initially exist and the export contains the event. Scheduled backup deletes both and replaces them with a zero-event backup. The app's recovery message tells the user to restore precisely the export that can be deleted.

**Correction:** preserve completed unregistered backups unless their disposal is independently justified. Sweep known incomplete files without interpreting missing database registration as proof that a completed backup is disposable.

Evidence: `outputs/independent-storage-repro.cjs`; independently rerun by the lead reviewer.

### P2 — Skipped Fable forecast crashes dashboard rendering

**Location:** `electron/store.cjs:1078–1082`; failure at `src/provider-view.ts:156`.

F16 asks to skip a forecast that is discarded when its projection replaces it. The implementation skips the canonical Fable forecast before establishing that replacement will occur. A live official alternate bucket prevents replacement, leaving the manual canonical secondary window with `forecast: null`.

**Reproduction:** two overall readings, a canonical manual Fable reading, and a live official `fable:seven_day_fable` reading. Calling the actual `providerViews(snapshot)` module throws `Cannot read properties of null (reading 'expired')`.

**Correction:** determine replacement across all windows before skipping forecasts, preserving a complete forecast for every returned window.

Evidence: `outputs/independent-fable-repro.cjs`; independently rerun by the lead reviewer.

### P2 — Missing import cursor bypasses Codex collision protection

**Location:** `electron/codex-collector.cjs:472–476`.

C5 proposes running migration passes only for old cursors. A missing cursor also occurs after restoring a ledger or moving a log, and does not prove that its events are absent. The shortcut bypasses historical collision guards in those cases.

**Reproduction:** a synthetic ledger contains a conflicting 777-token record with manual provenance and no imported-file cursor. The baseline collector preserves that record and rejects the collision group. The current collector replaces it with a 100-token imported record and inserts another 200-token record, without a safety backup.

**Correction:** establish whether historical ledger records exist before skipping collision protection, preserving records outside verified collector ownership.

Evidence: `outputs/independent-runtime-repro.cjs`; baseline collector comparison independently rerun by the lead reviewer.

### P2 — One transcript read failure aborts healthy imports

**Location:** `electron/claude-collector.cjs:292`, `electron/codex-collector.cjs:481`, and deferred read at `electron/incremental-file.cjs:35`.

C4 requests chunked reading. Streaming defers the actual read until iteration, outside the callers' per-file error handlers. One unreadable file now stops the import batch.

**Reproduction:** inject EIO in the first of two synthetic files. For both providers, the baseline reports one read error and imports the healthy second file. Current collectors throw and import zero healthy events.

**Correction:** catch iteration failures per file, maintaining transaction rollback and unchanged cursors for failed reads, then continue with healthy files.

Evidence: `outputs/independent-runtime-repro.cjs`; baseline collector comparison independently rerun by the lead reviewer.

## Validation and limits

- Fresh full suite: 649 passing tests under Node and 649 under Electron, zero failures or skips.
- Reviewers also ran 107 storage/forecast tests, 41 runtime tests, and 40 renderer tests including the real Chromium interaction fixture.
- No additional R1–R24 renderer implementation defect was confirmed in those fixtures; the cross-layer Fable crash above was found by the storage reviewer.
- All new reproductions use synthetic databases and logs. No live user database, provider calls, installer, UAC prompt, publication, or relaunch was exercised.
- The renderer checks do not establish assistive-technology behavior or production packaged layout. Package audit evidence from the implementation pass was not treated as proof of correctness in these edge cases.
- The system npm launcher failed before reaching project code; the suite was run directly through Node using the project's declared test arguments.

Original review totals: one P3 standards/documentation finding and four spec/correctness findings, worst P1 backup loss. No application fixes were applied during that review; all were subsequently fixed and verified as described above.
