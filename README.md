# AI Usage

AI Usage is a free, open-source, local-first Windows dashboard for answering two practical questions:

- Will the remaining Codex, Claude, and Fable allowance last until each reset?
- What would the tracked token activity have cost at the equivalent API token prices?

It imports local usage evidence, learns your real burn pattern, evaluates every active allowance window, and keeps its database on this computer. The app has no server or account of its own: installing and updating it need no sign-in, and it reads usage through the Codex and Claude accounts you already use. An optional [Claude Code mod](docs/using-the-dashboard.md#inside-claude-code) shows the same allowances inside Claude Code.

## What it does

- **Run-out forecasts.** Each Codex, Claude and Fable allowance window gets an expected and a heavier-week projection to its reset, a daily budget, and an overall verdict. See [Run-out forecasting](docs/forecasting.md).
- **Fable tracking.** Fable activity is imported automatically from local transcripts, and the usable Fable figure accounts for the shared Claude weekly limit.
- **API-equivalent costs.** Recorded tokens are priced from a local, editable price catalogue, by model, project, session, task and sub-agent. See [Costs](docs/costs.md).
- **A tray app.** A tray flyout, desktop notifications, a daily digest and an optional view inside Claude Code. See [Using the dashboard](docs/using-the-dashboard.md).
- **Local backups.** Daily SQLite and compressed JSON backups, restore by merging, and CSV export.

## Install

Download the installer from the [latest release](https://github.com/DanDG923/ai-usage/releases/latest). Use `AI-Usage-Setup-1.0.63-x64.exe` for a normal Windows installation. Running it over an existing installation upgrades in place and preserves the local database, settings, observations, and backups. Uninstalling first is neither required nor recommended. Install this version once to enable future updates through the app.

Use `AI-Usage-Portable-1.0.63-x64.exe` for a single executable that does not install the app. Windows SmartScreen may show an unknown-publisher warning because this personal build is not backed by a commercial code-signing certificate; verify the supplied SHA-256 hash before running it.

Internet access and Windows 10/11 are required. To set up Claude Code and sign in on a new computer, see [Setup](docs/setup.md#set-up-another-windows-computer).

## Updates

Source code and releases are published in the public [DanDG923/ai-usage repository](https://github.com/DanDG923/ai-usage). Updates work in the installed Windows app; portable copies continue to be replaced manually. Update checks and downloads need no GitHub account, sign-in or token: the app reads the repository's public releases anonymously.

The app checks for updates automatically; when one is available, choose **Download update** and then **Restart and update**. A safety backup is made before anything is installed. [Updates in detail](docs/setup.md#updates) covers the timing, checksums and what happens if a step fails.

## First run

1. Open AI Usage and choose **Refresh**. Local Codex and Claude token records are imported automatically.
2. In **Settings → Sources**, choose a background interval. The app refreshes while its tray process is running; **Only when I refresh** disables scheduled, reopen, and wake-triggered scans after the initial launch scan.
3. Set your normal active hours and days. They shape when future use is expected, while the burn rate itself comes from observed history.
4. Review **API pricing**. Detected models without prices are highlighted and keep the total visibly marked as a lower bound until all of their token categories have prices.

Claude plan usage is read through your own Claude Code only when you choose **Refresh**; automatic collections never start Claude Code. [Claude plan usage and Refresh](docs/setup.md#claude-plan-usage-and-refresh) explains what each kind of collection reads.

## How it treats your data

Everything stays on this computer. The app has no account and no server, and dashboard data is not uploaded by AI Usage. It reads local Codex and Claude Code usage records, and Claude plan usage through your own Claude Code when you press **Refresh**. Claude prompts and responses are never copied into the dashboard: the ledger keeps token counts, timestamps, model names, session identifiers, each session's working directory and the metadata needed to avoid duplicates. AI Usage does not read or store Claude OAuth tokens. Details are in [Privacy and security](docs/privacy-and-security.md).

## Security model and accepted risks

The installers are not code-signed, the Claude Code installer the app can run is checked only up to its bootstrap script, and backups hold session identifiers and working directories. Each of these is an accepted risk; [Security model and accepted risks](docs/privacy-and-security.md#security-model-and-accepted-risks) explains them and the window's sandboxing.

## Documentation

| Document | For | Covers |
| --- | --- | --- |
| [Using the dashboard](docs/using-the-dashboard.md) | Everyone using the app | The Overview, provider pages, Settings, notifications, the tray flyout, keyboard shortcuts, the Claude Code mod |
| [Run-out forecasting](docs/forecasting.md) | Anyone who wants to know how the forecast is made | The forecast model, ignored days, allowance changes, budget mode, token capacity, Fable tracking and the shared weekly limit |
| [Costs](docs/costs.md) | Anyone reading the cost figures | API-equivalent costs, pricing rules and the catalogue, tasks and sub-agents, Claude desktop and web chat estimates |
| [Privacy and security](docs/privacy-and-security.md) | Anyone assessing the app | Source health, what is stored, the security model and accepted risks, data and backups |
| [Setup](docs/setup.md) | New installations | Another Windows computer, Claude setup, the status-line helper, updates in detail |
| [Development](docs/development.md) | Contributors | Source layout, verification commands, CI, type-checking, tests, benchmarks |
| [Releasing](docs/releasing.md) | The maintainer | Bumping the version, publishing a release, what the release workflow does, release access |

The [changelog](CHANGELOG.md) lists what changed in each version.

## Developer quick start

Requires Node.js and npm; `.nvmrc` names the version the tools and CI use.

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build:web
npm run build
```

`npm run dev` starts the dashboard with a live renderer. [Development](docs/development.md) describes every check, what CI runs, and the source layout.

## Licence

AI Usage is released under the [MIT License](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
