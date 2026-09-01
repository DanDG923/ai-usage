# AI Usage

AI Usage is a local-first Windows dashboard for answering two practical questions:

- Will the remaining Codex, Claude, and Fable allowance last until each reset?
- What would the tracked token activity have cost at the equivalent API token prices?

It imports local usage evidence, learns your real burn pattern, evaluates every active allowance window, and keeps its database on this computer.

## Install

Use `AI-Usage-Setup-1.0.11-x64.exe` for a normal Windows installation. Running it over an existing installation upgrades in place and preserves the local database, settings, observations, and backups. Uninstalling first is neither required nor recommended.

Use `AI-Usage-Portable-1.0.11-x64.exe` for a single executable that does not install the app. Windows SmartScreen may show an unknown-publisher warning because this personal build is not backed by a commercial code-signing certificate; verify the supplied SHA-256 hash before running it.

## First run

1. Open AI Usage and choose **Refresh**. Local Codex and Claude token records are imported automatically.
2. In **Data & settings → Sources**, choose a background interval. The app refreshes while its tray process is running; **Only when I refresh** disables scheduled, reopen, and wake-triggered scans after the initial launch scan.
3. Set your normal active hours and days. They shape when future use is expected, while the burn rate itself comes from observed history.
4. Review **API pricing**. Detected models without prices are highlighted and keep the total visibly marked as a lower bound until all of their token categories have prices.

The Claude status-line helper is optional. The automatic Claude usage reader is tried first on every refresh. Enable the helper only as a fallback for overall Claude allowance readings when the provider interface does not return them; it stores only capture time, model identity, and rate-limit fields, and disabling it restores the status line that was present before AI Usage changed the setting.

## Fully automatic Fable tracking

Fable no longer needs a manual entry to start moving. Every Claude refresh performs two independent jobs:

| Evidence | Scope | Dashboard treatment |
| --- | --- | --- |
| Claude's official model-scoped usage reading | Account allowance, when the provider returns a Fable window | Exact provider percentage and reset |
| Local Claude transcripts | Actual Fable token activity recorded on this computer | Imported automatically on every refresh |
| Calibrated local derivation | Allowance estimate when exact model-scoped data is absent and shared-pool evidence is sufficient | Clearly labelled local estimate |
| Manual observation | Optional fallback | Re-anchors an estimate; never required as a trigger |

The official model-scoped reader uses Anthropic's experimental Claude Agent SDK usage method. It sends no prompt, exposes no tools, loads no user settings or plug-ins, persists no session, bounds initialization, usage, and cleanup waits, aborts and releases the control query, validates the complete response before writing, and retains only the allowance fields the tracker needs. AI Usage does not read or store Claude OAuth tokens and does not call a private web endpoint.

That provider method can legitimately return no plan windows. In that case the app records the successful scan, continues importing actual local Fable token activity, and shows the exact allowance as unavailable rather than inventing `0%`. It automatically switches to the exact figure on a later refresh if Claude begins returning a Fable `model_scoped` window.

Fable plan rules are not universal. Claude Max and qualifying premium Team or Enterprise seats include Fable under a dedicated limit of up to half the weekly allowance, while Claude Pro and standard Team or Enterprise seats use pay-as-you-go credits. The fallback half-pool derivation therefore requires affirmative Max-plan evidence. An unknown plan is not treated as Max, and old locally derived rows created from that assumption are discarded during the upgrade. Exact provider model-scoped readings remain authoritative on any plan.

Local transcript activity is deliberately described as **this device**. It cannot see Fable work done on another computer unless an account-level provider allowance is available. **Add a quota observation** remains available for a provider percentage you want to record, but it is now an optional fallback, not an automation prerequisite.

## Run-out forecasting

Codex, overall Claude, and Fable each have an independent learner. Repeated polling snapshots are compacted so they cannot manufacture confidence. The model combines:

- allowance used across the current reset window;
- recent working pace and hourly shape without projecting one burst across every future hour;
- matching hours and weekdays from observed history;
- your configured active-day schedule; and
- the busy end of learned daily use for the **Heavier** scenario.

Provider percentage rebounds within one reset window are handled with a monotonic high-water mark, so rounding jitter cannot spend the same allowance twice. Sparse intervals are allocated by local day, reset boundaries are not mixed, and off-schedule use remains part of the measured burn. An isolated late-night step is duty-cycled across the off-schedule hours observed over whole days; it is not treated as continuous usage throughout every remaining night. This keeps the safe active-hour pace meaningful after an intentionally heavy session.

When a successful official allowance reading shows a new window—or a clear allowance replenishment before its reset timestamp updates—the forecast starts a fresh cycle. External announcements and banked-credit availability are not treated as allowance state: the dashboard reports a banked personal reset credit separately, never assumes it was spent, and never consumes it automatically.

The header verdict is built in the backend from every active primary, secondary, and model-specific window. A risky secondary window overrides a safe headline window. **All allowances on track** appears only when every expected source has sufficiently current evidence and every active window is safe; missing, stale, failed, or expired-only evidence produces an unknown verdict rather than a false all-clear. The verdict chip and the tray tooltip both carry the three headline percentages, and the tray icon carries a colour dot for the current state.

Each card also answers **Runs out**: the moment the expected projection first reaches zero, or the heavier projection's moment when only that one does. The same time is included in pace notifications.

**Budget mode** (Data & settings → Learned forecast → *Keep in reserve*) sets a share of each allowance you want untouched at reset. The safe pace only spends what sits above the reserve, and a projection that would eat into it is shown as a watch state; the forecast itself still reports what will actually happen.

## Notifications

Desktop notifications come from the tray process after a collection, so they are only as current as the collection interval. Four kinds can be enabled independently under **Alerts**: pace risk (one per episode, with the earliest run-out time), a window reset, a collector falling back to cached readings, and a daily digest at a chosen hour. **Snooze** pauses all of them for one, six, or twenty-four hours from the settings screen or the tray menu.

## Token API-equivalent costs

The Details screen reconstructs token API-equivalent value from local input, output, cache-write, and cache-read records. Reasoning tokens are retained as an informational subset of output and are never billed twice. Claude five-minute and one-hour cache writes are stored and priced separately. Every selected historical period is recalculated with the current local price-catalogue row for each model; earlier tariff versions are not reconstructed, so editing a row intentionally reprices the displayed history.

OpenAI GPT-5.6 Sol, Terra, and Luna requests over the published 272,000-input-token threshold use the long-context multipliers, including cached prompt input when determining whether the threshold is crossed. Unknown or future model names are not assigned a guessed price: their tokens remain visible, price coverage drops, and totals are labelled **At least** until you add the missing row.

These values are token-only comparisons, not provider invoices. They do not claim to include untracked tool charges, web-search charges, storage, taxes, subscription fees, or usage performed on another device that did not reach the local ledger. USD is the ledger currency; GBP and EUR use the manually saved display conversion rate and are not updated from a live foreign-exchange feed.

The Details screen also groups the ledger **by project**, using the working directory each Codex or Claude session ran in, and shows **reset cycles**: the peak percentage each past allowance window reached and what that window's tokens are worth today. **Export CSV…** writes the ledger for the last 30, 90, or 365 days with the per-record API-equivalent, and **Copy summary** puts a plain-text version of every allowance on the clipboard.

## Source health and privacy

Each source shows three different timestamps where relevant:

- **Evidence** — the newest quota or token evidence;
- **Scan** — the latest collection attempt; and
- **Last good** — the latest scan that the source explicitly reported as successful.

This keeps a failed refresh from pretending old evidence is current, without deleting the last valid observation. Provider omissions and unsupported experimental responses fail closed: missing percentages remain unknown, while an explicit `0%` is retained as valid data.

Claude prompts and responses are never copied into the dashboard. The ledger retains token counts, timestamps, model names, session/request identifiers, the session's working directory path (for the project breakdown), and limited source metadata needed for deduplication and provenance. Dashboard data is not uploaded by AI Usage.

Collection runs in a separate utility process with its own connection to the same database, so a slow transcript scan or a stalled provider call never freezes the window, the tray, or the settings screen. Transcripts and session logs are read incrementally from a byte cursor rather than re-parsed in full on every refresh, and polling rows older than sixty days are compacted to the first and last reading of each window per day. **Diagnostics** at the bottom of Data & settings shows what each collector last saw, including latency and the reason for any fallback.

Update checks are opt-out and only run in a packaged build once a release feed is configured under `build.publish` in `package.json`; until then the setting reports that checks are off. A check fetches a version manifest and nothing else.

## Data and backups

The database is stored under the standard Windows app-data directory for AI Usage. Backups are written to `Documents\AI Usage\Backups` as both a SQLite snapshot and a readable `.aiusage.json` export. Daily backup creation is enabled by default, and **Back up now** is available at any time.

**Restore from backup…** merges an export into the local database. Existing token records, observations, daily totals, and prices are kept, so a restore neither double-counts nor rolls back newer records. Settings are replaced by the export's settings. A fresh safety backup is written before the merge.

Closing the window keeps the tray app running. Use **Quit** from the tray menu to exit fully.

## Developer verification

Requires Node.js and npm:

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build:web
npm audit
npm run build
```

Linting uses oxlint (typescript-eslint does not yet support the TypeScript 7 compiler this project builds with) and Prettier formats the renderer source. The same steps run in GitHub Actions on every push and pull request. `npm run build` runs the tests and web build, creates both Windows artifacts, audits the packaged ASAR for source maps, private local data, and the SDK's optional Claude binary, then writes `release\SHA256SUMS.txt`. The source uses React, Vite, Electron, Node's built-in SQLite support, the official Claude Agent SDK, and local JSON-line collectors. Packaged builds use the already installed external Claude binary instead.
