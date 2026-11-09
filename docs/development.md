# Development

This page is for contributors working on the AI Usage source. It covers the toolchain, the verification commands and what CI runs, how the tests and type-checking work, the benchmarks, the source layout, and some internal behaviour worth knowing before changing the store or the analytics. Cutting a release is in [Releasing](releasing.md).

## Requirements

Requires Node.js and npm. `.nvmrc` names the Node.js version that CI and the release build use; both workflows read it from there, so it is changed in that one file. It is the version the tools and `npm test` run on, and is separate from the Node.js that Electron embeds in the app, which `npm run test:electron` covers.

The source uses React, Vite, Electron, Node's built-in SQLite support, the official Claude Agent SDK, and local JSON-line collectors. Packaged builds use the already installed external Claude binary instead.

## Verification

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

Linting uses oxlint (typescript-eslint does not yet support the TypeScript 7 compiler this project builds with) and Prettier formats the renderer source.

`npm run build` runs the tests and web build, creates both Windows artifacts without publishing, audits the packaged ASAR for source maps, private local data, and the SDK's optional Claude binary, verifies the public update feed and installer manifest, then writes `SHA256SUMS.txt` in the configured build output folder. The checksums cover the installer, portable executable, installer block map, and `latest.yml`.

Local packaging output now defaults to `%LOCALAPPDATA%\AI Usage\Build\release`, with `AI_USAGE_BUILD_OUTPUT` available for an explicit alternative. CI keeps its `release` folder. Use the package scripts so the builder, release notes and audit resolve the same location.

### What CI runs

GitHub Actions runs the CI workflow (`.github/workflows/ci.yml`) on every push to `main` and on every pull request, in two jobs:

- **Windows** (`verify`): `npm ci --ignore-scripts`, the Electron runtime download, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build:web`, `npm run test:electron`, `npm run version:check`, `npm run release:notes`, then packages the NSIS installer only (`electron-builder … --win nsis --x64 --publish never`) and audits the unpacked package with `node tools/audit-release.cjs --unpacked`.
- **Linux** (`verify-linux`): `npm ci --ignore-scripts`, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test`, so code that assumes Windows paths by accident is caught. It neither packages the app nor runs the Electron-runtime suite.

CI does not run `npm audit`, does not build the portable executable, does not run `npm run build` itself (so it writes no `SHA256SUMS.txt`), and does not run the Claude Code mod's tests (`npm run test:mod`). Run those locally before a release.

CI combines verification and packaging to avoid duplicate setup/renderer builds; releases still rebuild and audit the tagged commit, in a job whose token cannot write to the repository (see [Releasing](releasing.md)).

## Tests

The tests are in `tests/`, one folder per feature: `app` (the main process, its bridge and windows), `collectors`, `claude-code` (setup, the installer and the mod), `store`, `quota` (the forecast and the readings it is made from), `fable`, `costs`, `renderer`, `tray` (the icon, the flyout, notifications and the verdict) and `updates` (the updater and the release tools). Both runners take every `tests/*/*.test.cjs`, so a new test file goes in one of those folders; a file left directly in `tests/` is not run. `tests/setup.cjs`, `tests/helpers/` and `tests/fixtures/` are shared.

`npm test` uses two test processes, isolated provider folders, an explicit Europe/London test clock zone, fast SQLite settings for disposable fixtures, and cleanup of only the temporary folders created by that run. It runs on Linux as well as Windows; CI runs it on both. `npm run test:electron` repeats the suite with the shipped Electron runtime. Renderer interaction tests also exercise the real Chromium DOM with a fake bridge.

JavaScript lint, exercised IPC validation, and both Node/Electron runtime suites remain required alongside the type check.

### The Claude Code mod

The Claude Code mod in `claude-code-mod/` has its own tests, run by Claude Code's test kit: `npm run test:mod` validates it with `claude plugin validate` and runs `claude plugin test`. To try changes in a session, run `claude --plugin-dir ./claude-code-mod`; it reads the app's default folder unless an `ai-usage.json` beside it says otherwise. What the mod does for users is in [Inside Claude Code](using-the-dashboard.md#inside-claude-code).

## Type-checking

`npm run typecheck` also checks the main process. The files in `electron/` stay plain JavaScript and are checked through `tsconfig.electron.json`, with types written as JSDoc comments.

- What the store returns is declared with the renderer's own types from `src/types.ts` (`Snapshot`, `Quota`, `Forecast`, `Settings` and the rest), so a field one side renames or drops is an error on the other.
- The application object and its modules are typed, and Electron's own types apply, so a misspelt `main.refresh.refreshAll` or `window.isDestroyed` fails the check.
- Null checking is on, so reading a window, timer or reading that may not exist yet has to be guarded or carry a comment saying why it is there.
- Implicit `any` is off limits too: every parameter says what it is, and `electron/types.d.ts` holds the shapes they share, a row of each table among them.
- Where a value really is of unknown shape, such as a line of a transcript or a restored export, it is typed `unknown` or `Record<string, any>` on purpose and picked apart field by field.
- Every strict mode is on (`"strict": true`), including the one that types a caught error as `unknown`: a `catch` reads `code` or `message` through `errorCode` and `errorMessage` in `electron/caught.cjs`, which give what `error?.code` and `error?.message` would, or says with a cast what it expects to have caught.

## Benchmarks

### Cost analytics

For a repeatable cost-analytics benchmark, run `node tools/benchmark-analytics.cjs` (optionally followed by a record count). It uses 30,000 synthetic records in an in-memory database by default, reports the median of seven measured runs after two warmups, and prints a checksum of the complete result. Compare the checksum as well as the timing when changing analytics. This measures backend cost aggregation, not collection or end-to-end UI latency, and never reads the installed app's data.

### Memory and lifecycle

For Windows memory and lifecycle checks, build the renderer and run `node tools/benchmark-memory.cjs . optimized`. To compare with an older built source tree using the same installed development Electron runtime, run `node tools/benchmark-memory.cjs <older-source-directory> baseline` first. The `hidden` mode checks startup in the tray.

Each run creates a fresh profile and 30,000 synthetic records under `work/memory-*`, isolates provider discovery, disables autostart writes and notifications, and reports process working sets, private bytes and reopening time in `report.json`. The optimized check also verifies idle process release, restored navigation, protected Settings, collection restart and database integrity. Working-set sums include shared pages; results depend on workload and should not be treated as unique physical RAM savings.

The behaviour these checks measure (window release, idle collectors, **Lower memory use**) is described in [Memory use](using-the-dashboard.md#memory-use). The private update component is loaded for the first update check rather than at launch, so portable and development builds never load it.

## Source layout

- `src/` is the renderer: the dashboard and the tray flyout, in React. `App.tsx` is the shell. What the dashboard knows (the snapshot, the period, what is refreshing) is a small store in `src/app/dashboard-store.ts`, every call to the bridge is an action in `src/app/dashboard-actions.ts`, and components read both through `useDashboardState` and `useDashboardActions`. The Overview and the flyout take the verdict from one model, `src/overview-view.ts`.
- `electron/main.cjs` is the entry point. It builds the application in `electron/app/` and starts it. Each file there owns one concern and its state (`dashboard` the window, `tray` the icon, menu and flyout, `refresh` collection and publishing, `ipc` the bridge, `snapshots`, `alerts`, `logs`, `paths`, and `lifecycle` startup, shutdown and the update install), and they reach each other through the one application object, as `main.refresh.refreshAll()` or `main.dashboard.window`. The application takes Electron, the process and the timers as arguments, so `tests/helpers/main-application.cjs` builds the real one around stand-ins and a test replaces whichever function it needs.
- `electron/store.cjs` is the one handle on the database: the connection, the caches and the transaction. What it does is in `electron/store/`, one file per responsibility (`schema`, `settings`, `ledger` for what collectors write, `quota` for allowance windows and forecasts, `pricing`, `analytics`, `cycles`, `snapshot`, `backup`), as functions that take the store. They call each other through the store's methods, so the class is also the list of everything the store can do.
- `electron/providers.mjs` describes each subscription once: its ids, label, collector, allowance buckets and, for Fable, how it sits inside Claude's weekly allowance. The rest of the main process looks a provider up there instead of naming it, and the renderer reaches the same data through `dashboard-decision.mjs` and `quota-selection.mjs`.
- `electron/forecast.cjs` is the forecast as a pipeline, over one module per stage in `electron/forecast/` (`readings`, `windows`, `samples`, `anchors`, `daily-shape`, `rates`, `series`, `assess`, with `early-reset` and `learn` beside them). Every number the stages are tuned with has a name in `forecast/tuning.cjs`. `electron/quota-evidence.cjs` dates each reading's evidence and rescales readings across an allowance change; the collectors use it without forecasting anything.
- `collector-host.cjs` and `maintenance-host.cjs` run the two background processes through one host, `process-host.cjs`, with the messages they exchange in `process-protocol.cjs`.
- The rest of `electron/` is the collectors and the other pieces these use. `tests/app/ipc-contract.test.cjs` holds the bridge's three descriptions together: the preloads, the handlers and the renderer's types.

## Analytics caches and window selection

Analytics caches track changes to usage, pricing, and the relevant allowance bucket separately. A source-status or import-cursor update therefore retains previously calculated costs and cycle history. Cycle history merges small reset-timestamp variations before applying its display limit.

One shared rule decides which allowance window a provider headlines, which are listed beneath it, and which are history: the summary cards, tray tooltip, digests, dashboard verdict, recent-cycles table and token-capacity panel all consume it, so they always name the same window.
