# Setup

This page is for anyone installing AI Usage on a new computer or setting up Claude collection. It covers the first-run guide, how Claude plan usage is read, the optional status-line helper, and how in-app updates work in detail. The installer file names and requirements are in the [README](../README.md#install).

## Set up another Windows computer

Run the Setup installer and leave **Open AI Usage and set up usage tracking** checked. The first-run guide detects Microsoft Store and native Claude Code installations.

If Claude Code is missing, **Install Claude Code** runs Anthropic's official native installer for the current Windows user; no Node.js or npm installation is needed. AI Usage downloads that installer script over HTTPS, checks it byte-for-byte against the SHA-256 recorded in the app at release time, and runs only an exact match from a local file; if Anthropic has changed the script since the release, the app does not run it and instead shows the official PowerShell command to run yourself. What this check does and does not cover is described under [accepted risks](privacy-and-security.md#security-model-and-accepted-risks).

Choose **Sign in to Claude** and complete the account flow in your browser. AI Usage never copies account credentials into its database or installer. Claude Desktop sign-in can be separate from Claude Code sign-in.

Then choose **Start collecting** to optionally enable the fallback [status-line helper](#the-claude-status-line-helper) and refresh. Restart Claude Code for the helper to take effect. The provider may omit subscription windows even after a successful sign-in; missing limits are not reported as zero. Local activity only appears after Claude Code has written local usage records.

**Set up later** leaves Codex collection available. Reopen the guide from **Settings → Sources → Set up Claude**. Failed or cancelled installation/sign-in can be retried. A silent installation defers account setup until the app is opened interactively. Codex must separately be installed and signed into on that computer.

## Claude plan usage and Refresh

Claude plan usage is read through your own Claude Code only when you choose **Refresh** (in the dashboard, the tray flyout, or the tray menu). Launch, scheduled, reopen, wake and after-restore collections import local activity, the optional status-line helper's readings and Codex, but never start Claude Code, which keeps automated access to your Claude subscription out of the app.

Between refreshes, Claude is judged by the age of its last plan-usage reading, using the same freshness limit as the dashboard verdict; once that reading is out of date, Claude shows as needing a refresh and its status says to press **Refresh**.

The [Claude Code mod](using-the-dashboard.md#inside-claude-code) can also pass on the plan limits Claude Code already holds, so Claude stays current between Refreshes without the app reading plan usage itself.

## The Claude status-line helper

The Claude status-line helper is optional. The Claude usage reader runs when you choose **Refresh**. Enable the helper only as a fallback for overall Claude allowance readings when the provider interface does not return them.

- **What it stores.** Only capture time, model identity, rate-limit fields, the Claude Code session's random identifier and its total time spent waiting for API responses (no paths, prompts or costs).
- **Turning it off.** Disabling it restores the status line that was present before AI Usage changed the setting.
- **Where it is installed.** In the configuration folder Claude Code reads, including one relocated with `CLAUDE_CONFIG_DIR`.

### How its readings are dated

The status line repeats the limits from the Claude Code session's last request each time it redraws, so it can lag behind use in other sessions, the desktop app or the web. The session identifier and API time show when each session last received new limits, so every status-line reading is dated by that fetch rather than by its redraw.

- A reading from an earlier helper version, or from a session already open when the helper is enabled or updated (until its next response), has no known fetch: it is shown but dated from the start of its limit window, so it does not mark Claude current.
- A lower reading fetched before a newer official reading of the same reset is ignored: it does not change the card, mark Claude current, count as a successful **Refresh**, or restart the Fable estimate. One fetched after it, such as an early replenishment seen by a session in use, counts at once.
- A reading that cannot be dated (from before this helper version) waits until the official reading is out of date, and an unchanged status-line reading never marks when later usage happened.

## Updates

Where releases come from, and which copies can update themselves, is in the README's [Updates](../README.md#updates) section. This section covers the detail.

### Checking and downloading

Automatic update checks are enabled by default, start about 45 seconds after launch, and repeat every six hours while the app is running. The setting can be disabled, and a manual check is always available.

When a release is available, review its notes and choose **Download update**. Update checks fetch public GitHub release metadata and a version manifest; installer downloads happen only after **Download update** is selected. Download progress is shown; downloads always use the complete installer and verify its SHA-512 checksum against the release manifest.

### Installing

Choose **Restart and update** when ready. AI Usage finishes storage activity, makes a safety backup, and shuts down before installing and reopening.

- The whole preparation is limited to fifteen seconds. If the backup does not finish in time, nothing is installed and AI Usage reopens so you can retry; if only the final close stalls after the backup, the update proceeds.
- Quit from the tray waits the same fifteen seconds for storage work before exiting.
- If the backup fails, installation is blocked so you can resolve the error and retry.
- Ordinary app exits do not install a downloaded update.
- The installer preserves local settings, the database, and existing backups.

Before the installer runs, its checksum is verified again against the release manifest, and a launch the system refuses, for example while antivirus software is still scanning the download, is retried a few times before the update is reported as failed.

### What update requests send

Update requests carry no credential: a `GH_TOKEN` or `GITHUB_TOKEN` environment variable is not used for them, and they contain no GitHub authorization. Usage history and backups are never uploaded as part of an update check or download, and local usage data is not sent.

### The update log

Each update stage and any failure message is appended to `update.log` in the app's data folder (`%APPDATA%\ai-usage`), so a failed installation can be diagnosed after the app has restarted. The log holds only stage names, versions and the same wording shown in Settings; no request details or credentials.

Why in-app updates can be trusted without code signing is covered under [accepted risks](privacy-and-security.md#security-model-and-accepted-risks).
