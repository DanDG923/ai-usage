# Changelog

## 1.0.11 — 1 September 2026

This is an in-place feature and reliability update. Running the 1.0.11 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups. On first launch it rescans local transcripts once to fill the new project column.

### Answers first

- Adds **Runs out** to every allowance card: the moment the expected projection first reaches zero, or the heavier projection's moment when only that one does, with the distance to reset. The forecast chart marks the same instant.
- Puts the three headline percentages into the header verdict chip and the tray tooltip, and paints a state-coloured dot onto the tray icon.
- Presents Fable 5 as a full third card with the same gauge, pace bullet, forecast chart, and run-out fact as Codex and Claude; its local-activity and staleness notes move into the card footer.
- Adds **Budget mode**: a per-allowance reserve that the safe pace will not spend and that turns the state to watch when a projection would eat into it.

### Details

- Adds **Reset cycles**: the peak percentage each past window reached, the number of readings, and what that window's tokens are worth at the current catalogue, with a small bar history per source.
- Adds a **By project** table using the working directory each Codex or Claude session ran in; sessions now show the project name and a short session id instead of a truncated UUID. Only the folder path is stored, never prompts.
- Gives the cost chart hover values, day ticks, and a stacked-by-provider mode; the daily Codex chart gains the same hover and ticks.
- Replaces the repeated "current-catalogue token API-equivalent" phrasing with a short label and an explainer available from an info control.

### Notifications, export, diagnostics

- Adds reset, fallback, and daily-digest notifications alongside the existing pace alert, each independently switchable; the pace alert now names the earliest run-out time. Alerts can be snoozed for one, six, or twenty-four hours from settings or the tray menu.
- Adds **Export CSV…** for the ledger (30, 90, or 365 days, with the per-record API-equivalent) and **Copy summary** for a plain-text allowance summary, also available from the tray.
- Adds a **Diagnostics** section listing what each collector last saw: SDK read latency and outcome, transcript and status-line counters, and the reason for any fallback.
- Adds a **Theme** setting (follow Windows, dark, light). The renderer now uses design tokens throughout, and the native title bar follows the effective theme.
- Adds opt-out update checks through electron-updater. They activate only in packaged builds once `build.publish` names a real release feed; the placeholder shipped here keeps them off.

### Reliability and performance

- Moves collection into a utility process with its own SQLite connection, so a slow transcript scan or a stalled provider call no longer blocks the window, the tray menu, or settings. In-flight requests fail cleanly if that process stops, and it is recycled after a timeout.
- Reads Codex session logs and Claude transcripts incrementally from a byte cursor; the Codex reader keeps session, model, and working-directory context in the cursor so an appended chunk parses on its own.
- Forecasts from a bounded 45-day window plus each bucket's latest row, compacts polling rows older than 60 days to the first and last reading per window per day, caches price lookups within an analytics run, and caches the dashboard snapshot for twenty seconds between writes.
- Packages only the runtime dependencies: React, ReactDOM, and lucide-react are bundled by Vite and are now devDependencies, which removes about 2,160 loose files from the application archive.

### Corrections

- Fixes a release-blocking test whose fixture date had expired.
- Gives each forecast chart its own gradient id, aligns the Fable estimator's list of official provenances with the tracker's, widens the active-hour selects to the full validated range, and renames the risk-notification setting to reflect that it is a desktop notification (old databases and exports are migrated).
- Removes about half of the old stylesheet that no component referenced, raises the smallest secondary text sizes, and adds tab, live-region, and focus semantics to the header and settings.

### Tooling

- Adds oxlint, Prettier, `npm run typecheck`, and a GitHub Actions workflow that runs lint, format check, type check, tests, and the web build.

## 1.0.10 — 31 August 2026

This is an in-place visual update. Running the 1.0.10 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### Native application header

- Integrates the native Windows minimise, maximise, and close controls into the application header using Electron's Window Controls Overlay, removing the visually separate title strip while preserving native window behaviour.
- Defines explicit draggable and interactive regions so the header can still move the window without making navigation, refresh, or other controls unclickable.
- Keeps the brand, navigation, verdict, refresh metadata, and native caption controls within responsive safe areas, including when the header wraps on a narrow window.

### Responsive dashboard scaling

- Replaces the fixed-feeling desktop canvas with bounded responsive scaling for the dashboard width, provider cards, gauges, forecast plots, icons, spacing, and important values. A 2560-pixel logical fullscreen viewport now uses a 2280-pixel dashboard instead of remaining capped at 1800 pixels.
- Preserves the established layout at 1920 pixels and below, then grows continuously to the new very-wide cap without a breakpoint jump or global browser zoom.
- Stacks provider cards before they become cramped, keeps the four-value summary in a balanced two-by-two layout until it fits on one row, and collapses settings navigation and source controls before they can overflow.
- Lets Details charts follow their SVG aspect ratios while applying readable maximum widths, and keeps forecast tooltips wrapped and contained inside their plots.

### Verification

- Adds release contracts for native title-bar configuration, draggable/non-draggable regions, caption-control safe areas, responsive focal scaling, compact settings containment, summary-grid behaviour, tooltip wrapping, very-wide chart caps, and the absence of global CSS zooming.
- Exercises Overview, Details, and Data & Settings across compact, desktop, breakpoint, and 2560-by-1440 fullscreen browser viewports with no horizontal page overflow or console errors.
- Verifies the native Electron header at regular and compact window sizes, including native caption controls and narrow-header wrapping.

## 1.0.9 — 30 August 2026

This is an in-place forecast correction. Running the 1.0.9 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Codex runway forecasting

- Fixes a false `0.00%/h` safe pace after a deliberately heavy late session. Previously, one small percentage step just after the configured active-hours boundary could assign nearly all otherwise unlocalised current-window use to off-schedule activity, then repeat that event rate through every remaining night.
- Allocates usage from before the first useful observation by elapsed active/off-schedule exposure, while projecting observed off-schedule events as a duty-cycled daily budget. The **Heavier** scenario still retains genuinely busy nights instead of erasing them.
- Uses each learned local day's actual off-schedule capacity, so inactive days and 23/25-hour daylight-saving days are not divided by an active weekday's hours. The expected series now applies inferred sustainable off-schedule evidence even before a zero-change poll arrives, keeping forecasts invariant to polling cadence and consistent with safe pace.
- Keeps the safe-pace denominator and the expected forecast on the same sustainable off-schedule model. Positive usage against a genuinely zero safe budget now reports an over-limit pace and fills the burn bar hot rather than rendering a misleading green sliver.
- Treats observed allowance state, external reset announcements, and banked personal reset credits as distinct. A changed official window—or a clear provider-reported allowance replenishment before its reset timestamp updates—re-anchors the forecast on the next successful refresh; announcements and credit availability do not alter the numbers, and the app never redeems a credit automatically.

### Verification

- Adds exact regressions for the two-observation live failure, the zero-safe-budget display contract, a clear provider-reported allowance replenishment before its reset timestamp changes, derived-estimate corrections, inactive days, and unchanged polling, alongside the existing overnight, sparse multi-day, reset-boundary, and rebound-jitter cases.
- Replays a copied live database without modifying the installed profile. At the captured 87%-remaining point, the corrected model reports about `0.88%` safe use per active hour, `24%` expected to remain, and `3%` in the heavier scenario instead of a false critical result.

## 1.0.8 — 30 August 2026

This is an in-place corrective update. Running the 1.0.8 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Automatic Fable 5 tracking

- Adds a one-call automatic Fable refresh that reads official model-scoped allowance data through Anthropic's experimental Claude Agent SDK when the provider supplies it, while independently importing actual local Fable token activity on every refresh.
- The SDK control query sends no prompt, exposes no tools, loads no user settings or plug-ins, persists no session, has bounded initialization, usage, and cleanup waits, aborts and releases its input, and returns only validated subscription/rate-limit fields. AI Usage neither reads OAuth tokens nor calls a private web endpoint.
- Treats `rate_limits: null`, an absent Fable window, malformed data, cancellation, and provider failure as unavailable or degraded evidence—never as fabricated `0%` usage. A still-valid official cached Fable observation can be shown as stale without being rewritten.
- Uses exact provider data whenever a Fable `model_scoped` window appears. Otherwise, actual this-device Fable activity continues to update and a calibrated local estimate is used only when its evidence is sufficient.
- Accounts for plan differences: the shared half-pool derivation now requires affirmative Max-plan evidence, because Pro and standard seats use credits and the status-line schema does not identify the plan. The upgrade clears the false Max label from old status-line rows and discards only reproducible derived estimates created from it. Manual observations remain an optional re-anchor rather than an automation trigger.
- Repairs the fallback estimator's same-reset high-water handling, rejects zero-delta rounded calibration pairs and incomplete model coverage, and bases allowance pressure on a fixed versioned vector rather than user-editable API prices or exchange rates. A twice-overall ceiling is applied only at the timestamp shared by both readings; later actual local Fable activity is no longer suppressed by an older overall percentage.
- Preserves all supported five-hour, weekly, OAuth-app, Opus, Sonnet, and model-scoped provider windows. Sanitized extra-usage credit metadata is retained as a separate account signal without being mislabelled as a Fable percentage.

### Runway and API-equivalent correctness

- Moves the all-clear/risk verdict into the backend and evaluates every active allowance window. Risk in a secondary or model-specific window can no longer be hidden by a safe primary window, and missing or expired-only sources cannot produce “All allowances on track.”
- Makes unknown model pricing explicit. Cost totals become a labelled lower bound, show the unpriced models and token volumes, and expose blank catalogue rows that can be completed in the settings screen.
- Applies the published GPT-5.6 Sol, Terra, and Luna long-context multipliers above 272,000 input tokens, with cached prompt input included in threshold eligibility.
- Keeps USD conversion fixed at one and validates settings, observations, token records, reset horizons, confidence values, and reasoning/output relationships before storage.
- Defines the displayed comparison as a current-catalogue token API-equivalent: current model rows intentionally reprice selected history, price provenance is visible, and GBP/EUR use a clearly labelled manual conversion rate rather than an implied live feed.
- Reprices restored legacy events with the current catalogue even when they carry an old reported charge, so a displayed total never mixes historical invoices with the current token comparison.
- Labels projected current balances as estimates in the primary gauges and every secondary allowance window instead of presenting a decayed observation as exact.

### Reliability, health, and packaging

- Separates the newest evidence, latest collection attempt, and latest successful scan, so a failed refresh neither refreshes stale evidence nor erases the last known-good state.
- Downgrades a safe-looking verdict when collector health or allowance evidence is stale, and shows stale Fable provider readings as projected estimates rather than current balances.
- Hardens the Codex JSON-line client against child-process, pipe, reader, write, timeout, and bounded-stderr failures. A missing percentage remains unknown while an explicit zero remains valid.
- Makes the fallback status-line inbox data-minimal, rejects malformed rows independently so they cannot block the SDK, and prevents Claude Desktop's GUI executable from being mistaken for Claude Code.
- Adds single-instance behavior, safely defers an early second-launch reveal until initialization, reuses/restores the existing window, ignores stale Vite URLs in packaged builds, visibly reports bootstrap/load failures, and keeps the aggregate verdict usable at 720 pixels wide.
- Installed desktop startup now reports a visible load failure with Retry instead of silently substituting demo data. Demo content is limited to browser preview.
- Pins `@anthropic-ai/claude-agent-sdk` exactly and excludes its optional bundled Windows Claude binary from release payloads; the app uses the external installed Claude executable.
- Keeps allowance freshness separate from transcript-activity freshness: a current Fable balance plus a failed local import is visibly degraded and cached activity is labelled, not silently shown as current.
- Prevents legacy backups from restoring an unverified Max-plan label, and recognizes the optional status-line helper only when its exact `-File` target is the app-owned script.
- Audits the completed ASAR for source maps, private local data, and bundled Claude binaries, then generates `SHA256SUMS.txt` for the Windows artifacts as part of the release build.

### Verification

- Adds focused SDK lifecycle/schema/privacy, automatic Fable, estimator, dashboard-decision, storage-validation, cost-completeness, lifecycle, Codex-client, and release-contract regressions.
- Runs the suite in `Europe/London` so overnight, local-day, reset-boundary, and daylight-sensitive behavior is exercised consistently.

## 1.0.7 — 30 August 2026

This is an in-place update. Running the 1.0.7 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Fable 5 allowance

The 1.0.5 derivation only moved the Fable estimate when the official overall percentage stepped forward. On a machine whose Claude sessions mostly run outside the terminal, the status line never fires, the overall figure never visibly steps, and the estimate froze at its last anchor while real usage climbed — the official Usage screen read 40% while the app still said 37%.

- Adds a second, stronger derivation: when two official Fable readings bound an interval of local token history, the rate between them — Fable percent per dollar of API-equivalent Fable value — is measured directly, with no share assumption, and projects the latest anchor forward as new usage arrives. This keeps the estimate moving between readings even when no status-line data is arriving at all.
- The direct rate takes precedence over the overall-share split whenever it exists, because it is measured against official Fable readings rather than inferred through the shared pool. The overall-share method remains the fallback when fewer than two Fable readings exist.
- Pairs must share a reset — a delta across a reset is meaningless — but a rate learned in one window carries into the next, because it is a property of pricing and caps, not of the week.
- The ceiling is unchanged: Fable can never read higher than twice the official overall percentage.
- Fixes a double-count in the overall-share tail: when a manual Fable anchor was newer than the last official overall reading, the Fable value between those two moments was included in the anchor and projected again. The tail now starts at whichever is later.
- Practical consequence: each official Fable reading you add from Claude's Usage screen both re-anchors the estimate and sharpens the measured rate. Two readings are enough to start; the estimate then tracks continuously between them.

### Verification

- Five new regression tests cover the pair calibration, its precedence over the share split, the ceiling clamp, reset boundaries, and the tail double-count fix; all 89 tests pass.
- Verified against the live database: with the official readings 37% (29 Aug) and 40% (30 Aug) recorded, the derivation reproduces the official 40% exactly and calibrates at roughly $13.80 of Fable API-equivalent value per allowance point.

## 1.0.6 — 30 August 2026

This is an in-place update. Running the 1.0.6 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Overview redesign

The Overview was recomposed so the question it exists to answer — how much is left, and will it last to the reset — is readable without scrolling and without interpreting jargon.

- Adds a verdict chip to the header ("All allowances on track", or the affected source by name when one is running warm or may hit its limit), computed from the worst forecast state across Codex, Claude, and Fable 5. It is visible from every tab.
- Replaces the full-height quota cards with compact cards that fit both providers above the fold. Each leads with the answer sentence, then an arc gauge showing remaining allowance with the low-allowance band drawn on the arc and a tick at the expected-at-reset value.
- Adds a burn-rate bar comparing recent pace against the safe pace, coloured by the same thresholds the pace alert uses.
- Makes the forecast chart readable: hovering shows the date with the expected and heavier values at that point, the axis carries weekday labels, and a legend replaces the end-of-line captions.
- Condenses the learning strip, pace row, and provenance footer into one line each; "calculated · heavier" and similar labels are replaced with plain wording.
- Presents Fable 5 as a slim strip with a meter (remaining allowance, with a tick at the expected-at-reset value) instead of a second full card. Its waiting and expired states are unchanged.

### Corrections

- The header now stays fixed while scrolling. It had been styled as sticky since 1.0.0, but an overflow rule on the page shell disabled it everywhere.
- Removes the two full-screen blurred backdrop layers, which re-rasterised on every scrolled frame and were the dashboard's largest rendering cost.
- Reduces the minimum window width from 1000px to 720px; the card grid stacks below 980px instead of forcing a horizontal scrollbar.
- Moves the forecast chart to a colour set whose adjacent series remain distinguishable under the common forms of colour-vision deficiency and meet contrast floors against the panel background, verified programmatically.
- Honours the Windows reduced-motion preference for smooth scrolling.

### Verification

- All 84 automated regression tests pass unchanged; this release alters no collector, forecast, or storage behaviour.
- Strict TypeScript and the production web build pass.
- The redesigned Overview was verified in a browser at 1400px and 760px widths: both cards render above the fold, the sticky header holds while scrolling, chart tooltips report interpolated values, and no layout overflows horizontally.

## 1.0.5 — 30 August 2026

This is an in-place update. Running the 1.0.5 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Fable 5 allowance

The Fable percentage was calibrated by dividing one official reading by the Fable tokens this computer had a record of. On a machine whose local history started partway through the week, that attributed a whole week's usage to a fraction of the week's tokens, so the rate was overstated and the estimate climbed too fast. It is now derived differently.

- Derives Fable from the official overall percentage, which Claude reports and the app already collects. Each forward step in the overall figure is split between the models that caused it by API-equivalent value, and Fable's share is doubled, because Fable's cap is half the overall weekly allowance.
- Uses only intervals bounded by two official readings, so usage from before this computer's records cannot distort the rate.
- Clamps the estimate to twice the overall percentage. A Fable figure above that is arithmetically impossible.
- Splits each step by API-equivalent value rather than raw token count. A Fable output token costs five times a Fable input token, and counting both as one token mis-weighted the split.
- Leaves the estimate at zero for a week spent entirely on other models, and moves it at twice the overall rate for a week spent entirely on Fable.
- Treats an official Fable reading as an anchor rather than a requirement. Adding one still improves the result and is the way to correct a week that began on another machine.
- Holds the estimate steady when the official overall figure has not moved, instead of projecting movement from a calibrated rate.
- Reports confidence from the number of measured steps behind the estimate.

### Developer tools

- Adds `tools/fable-probe.cjs`, which reports what Claude Code exposes to the status line, what the dashboard reads from it, how much of the current window has local records, and how many usable calibration steps exist. `watch` follows the status line and transcripts live.

### Verification

- Expands the automated suite from 83 tests to 84, replacing the five tests that encoded the previous calibration model with seven covering the new one, including the all-Opus and all-Fable extremes and the ceiling.

## 1.0.4 — 30 August 2026

This is an in-place update. Running the 1.0.4 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Background collection

- Collects on a schedule, chosen in **Data & settings → Sources**, so pace alerts and daily backups no longer depend on pressing **Refresh**. Also collects when the window is reopened and when Windows wakes.
- Honours **Only when I refresh**: with automatic collection off, reopening the window and waking the PC no longer start a scan. A launch still collects once.
- Reconciles every setting whose effect lives outside the database — launch at login and the collection schedule — from one place, so the settings screen, a restore, and startup cannot disagree.
- Sends the dashboard its new figures before the scheduled backup runs, so a failed backup can no longer freeze an open window silently. Backup failures are now reported.
- Notifies once per risk episode rather than once per collection, with an escalation to a full-allowance projection always breaking through.

### Restore from backup

- Adds **Restore from backup…**, which merges a `.aiusage.json` export into the local database. Token records, observations, daily totals and prices already held are kept as they are, so nothing is double counted or rolled back. Settings are replaced by the export's, and the notice says so.
- Reads the chosen export before writing the safety backup, and exempts it from backup retention, so restoring the oldest backup can no longer delete it.
- Skips and reports records an export cannot supply validly, one row at a time, instead of abandoning the whole restore.
- Applies the same validation to restored records as to live ones, including allowance ranges and reset times, and never writes an active-hours schedule whose start is not before its end.

### Claude status-line helper

- Adds **Disable helper**, which restores the status line preserved when the helper was enabled, or removes the one it added.
- Leaves a status line the app did not install completely alone, script included.
- Reads Claude's settings file even when another tool has written it with a UTF-8 byte-order mark, and refuses to rewrite a settings file it cannot read cleanly rather than replacing it.
- Keeps a byte-exact copy of Claude's settings before changing them, and no longer leaves a new copy of an unchanged file on every click.

### Corrections

- The cost period chosen on Details (7, 30, or 90 days) now survives a refresh, a settings change, and a price edit, and the Overview headline names the period it is showing.
- A failed Claude collection no longer erases what the app knows about the source, which had flipped **Disable helper** back to **Enable helper**.
- A background collection no longer discards a price being edited.
- Reports the version from the application manifest to the Codex app server instead of a hardcoded string.

### Verification

- Expands the automated suite from 46 tests to 83.
- Findings from an independent multi-agent review of this release were fixed and covered by regression tests.

## 1.0.3 — 29 August 2026

This is an in-place update. Running the 1.0.3 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Forecast accuracy

- Anchors each forecast to allowance used across the current provider window, divided by active hours elapsed up to the latest observation.
- Stops evidence at the reading timestamp so stale observations cannot manufacture an unused interval.
- Blends the window anchor in gradually and gives it up to 90% weight after about 30 active hours of evidence.
- Builds the heavier scenario from learned daily usage, with a conservative early-window fallback, instead of momentary burst rates.
- Splits the sustainable window budget between active and off-schedule use so the same allowance change cannot be projected twice.
- Uses unchanged boundary readings to localise later usage and distributes sparse multi-day changes across local calendar days.
- Ignores same-window percentage regressions until usage exceeds the prior high-water mark, preventing provider jitter from duplicating consumption.
- Keeps the heavier path at least 22% above the expected path.
- Separates the sustainable projected pace from the raw pace seen while actively working, and labels both clearly on the dashboard.

### Verification

- Adds regressions for short bursts during otherwise idle allowance windows and for stale-observation anchor timing.
- Makes bundled-Claude detection deterministic on computers that already have Claude on `PATH`.
- Expands the automated suite to 46 tests and fixes the test timezone to Europe/London for repeatable results.

## 1.0.2 — 29 August 2026

This is an in-place update. Running the 1.0.2 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Accuracy

- Stops counting Codex reasoning tokens twice. Reasoning remains visible as a subset of output.
- Stores and prices Claude five-minute and one-hour cache writes separately.
- Updates the built-in Claude Sonnet 5 pricing vector while preserving edited price rows.
- Re-imports local Claude transcripts once after upgrade so historical cache TTL detail is recovered.
- Uses strict, version-bounded model price matching; unknown models remain unpriced instead of receiving a guess.
- Groups cost history by the computer's local calendar day and applies the selected 7/30/90-day period to official daily usage.

### Forecasts and allowances

- Compacts repeated unchanged observations so polling frequency cannot inflate confidence.
- Projects stale observations forward to the present before forecasting the reset.
- Marks expired allowance windows as unknown while waiting for the next official reading.
- Learns mixed active/off-schedule intervals without assigning the whole change to active hours.
- Tolerates small provider reset-time drift in the learning history and chart.
- Merges manual Codex weekly observations into the official overall weekly learner when official data arrives.
- Chooses the overall Codex limit deterministically when multiple equal-length model limits exist.
- Preserves distinct Fable allowance windows if Claude supplies more than one.

### Claude collection

- Imports transcript token metadata directly even when the optional allowance status-line helper has not emitted a reading.
- Accepts Windows UTF-8 BOM-prefixed helper records.
- Preserves partial in-progress JSON lines for the next refresh and no longer rewrites the live helper inbox.
- Rejects impossible reset dates rather than storing a 1970 allowance.
- Keeps Claude marked connected across unchanged refreshes while its latest official allowance remains current.

### Reliability and accessibility

- Isolates collector failures so one unavailable provider cannot abort the other provider's refresh.
- Distinguishes complete, fallback, and failed refreshes in the in-app notice.
- Repairs invalid settings left by earlier numeric-input behavior while preserving valid custom settings.
- Adds bounded backup retention and reports failures when Windows cannot open the backup folder.
- Restores keyboard and screen-reader access to switches, active-day state, and asynchronous notices.
- Adds a production Content Security Policy and keeps Electron navigation/pop-up protections enabled.
- Pins build dependencies, adds a Git repository, and expands automated coverage from 6 original tests to 41 regression tests.

## 1.0.1 — 29 August 2026

- Added direct Claude transcript token import and Fable 5 cost tracking.
- Produced update-compatible Windows installer and portable packages.
