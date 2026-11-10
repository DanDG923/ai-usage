# Privacy and security

This page is for anyone assessing what AI Usage reads, stores and protects. It covers how source health is reported, what the ledger keeps and never keeps, the security model and the risks accepted by design, and how the database and its backups are handled.

## What is and is not stored

Claude prompts and responses are never copied into the dashboard. The ledger retains token counts, timestamps, model names, session/request identifiers, the session's working directory path (for the project breakdown), and limited source metadata needed for deduplication and provenance. Dashboard data is not uploaded by AI Usage.

Other parts of the app keep their own, narrower records. Each is described where it is used:

- the [status-line helper](setup.md#the-claude-status-line-helper) stores only capture time, model identity, rate-limit fields, a session identifier and API wait time;
- the [official Claude reader](forecasting.md#the-official-reader) retains only the allowance fields the tracker needs and does not read or store Claude OAuth tokens;
- [chat estimates](costs.md#what-is-stored) keep hashed reply keys and counts, never conversation titles or text;
- the [Claude Code mod](using-the-dashboard.md#what-the-mod-can-reach) reads and writes only small files in the app's `claude-code` folder;
- [update requests](setup.md#what-update-requests-send) carry no credential and send no usage data, and the [update log](setup.md#the-update-log) holds no request details or credentials;
- diagnostics retain only safe error categories and attempt timings (see below).

## Source health

Claude allowance readings must include confirmation of a successful provider fetch. If Claude returns cached figures after a failed connection, AI Usage retains the previous fresh reading and reports the failure. Temporary fetch failures and unexpectedly empty subscription responses receive one retry after a short delay; authentication failures and throttling wait for your next **Refresh**. Diagnostics retain only safe error categories and attempt timings, never raw provider debug output.

Each source shows three different timestamps where relevant:

- **Evidence** — the newest quota or token evidence;
- **Scan** — the latest collection attempt; and
- **Last good** — the latest scan that the source explicitly reported as successful.

This keeps a failed refresh from pretending old evidence is current, without deleting the last valid observation. Provider omissions and unsupported experimental responses fail closed: missing percentages remain unknown, while an explicit `0%` is retained as valid data.

### How collection keeps data consistent

Collection runs in a separate utility process with its own connection to the same database, so a slow transcript scan or a stalled provider call never freezes the window, the tray, or the settings screen. Transcripts and session logs are read incrementally from a byte cursor rather than re-parsed in full on every refresh.

- Invalid historical Codex quota windows are counted as rejected while valid token records and other windows continue importing.
- Polling rows older than sixty days are compacted to the chronological first, last, and highest reading of each window per day; manual observations are retained.
- Malformed non-object transcript records are skipped without blocking later valid records; storage failures still roll back the file for a complete retry.
- Codex cumulative token totals distinguish new usage from repeated quota notifications.

**Diagnostics** at the bottom of Settings shows what each collector last saw, including latency and the reason for any fallback.

When eligible logs are first rechecked by the corrected importer, existing duplicates are removed only where the source records and stored token details prove the duplication, with a safety backup before correction. Unavailable logs and conflicting records are left intact.

The one-time correction also checks previously imported Codex logs outside the usual recent scan, if those files are still available. Restoring an older export that adds Codex records schedules another check on the next scan.

## Security model and accepted risks

### The windows

The window runs sandboxed with context isolation, no Node integration, a content security policy that allows no network origin, and navigation, pop-ups, redirects and embedded web views denied. Web permission requests (notifications, media, geolocation and the rest) are refused outright; desktop notifications come from the main process. Every bridge call is accepted only from the dashboard's own main frame.

The tray flyout runs under the same restrictions with its own, smaller bridge (reading the tray summary, refresh, snooze, and opening the dashboard at a section or provider page); its calls are accepted only from the flyout's own main frame, and neither window can call the other's bridge. Navigation targets are checked against a fixed list of sections and providers.

### Provider executables

Provider executables are located only through absolute PATH entries, the native Claude Code install location, and the official Claude Code and Codex caches. The directory the app was launched from is never searched, and each provider process starts in its own directory with a PATH from which relative and launch-directory entries have been removed. Setting `CODEX_BINARY` selects an explicit Codex executable; an invalid value disables Codex rather than choosing something else.

### Data checks

CSV exports neutralise spreadsheet formula prefixes. Quota readings are accepted only with a reset at most 31 days ahead and an observation time no more than five minutes in the future; rows written by older versions are re-checked when read.

### Accepted risks

Some risks are accepted by design and worth knowing:

- **Claude Code installation** runs Anthropic's installer script, downloaded from `claude.ai` over HTTPS at the moment you choose to install. The app runs the script only if it matches, byte for byte, the SHA-256 recorded in the app at release time (`electron/claude-installer-pin.json`). The pin covers that short bootstrap script and nothing after it: what the script goes on to download and install is Anthropic's and is not checked by AI Usage. If Anthropic has changed the script since the release, the app does not run it and shows the official PowerShell command instead; running that command yourself rests on TLS to `claude.ai` alone.
- **In-app updates** are not code-signed. Trust rests on GitHub TLS, write access to the repository being limited to its owner, and the SHA-512 in the release manifest. Downloading and installing each require a click, so a compromised release cannot install itself.
- **Backups** under `%APPDATA%\ai-usage\Backups` contain settings, session identifiers and the working directory of every session. They hold no credentials. Older backups in `Documents\AI Usage\Backups` remain there and may already have synced through OneDrive.

How release access is controlled on the repository side is in [Releasing](releasing.md#release-access).

## Data and backups

The database is stored under the standard Windows app-data directory for AI Usage. New backups are written to `%APPDATA%\ai-usage\Backups` as both a SQLite snapshot and a compressed `.aiusage.json.gz` export. Daily backup creation is enabled by default, and **Back up now** is available at any time.

Restore accepts both compressed exports and legacy `.aiusage.json` files; browse to `Documents\AI Usage\Backups` to select an older export. Existing backups outside the current backup folder and completed files absent from the database's backup list are protected from automatic pruning.

Backups, restores, and CSV exports run in a dedicated background worker. Storage changes are queued safely, and quitting waits for active storage work to complete.

### Restoring

**Restore from backup…** merges an export into the local database.

- Existing token records, observations, daily totals, and edited prices are kept.
- On a fresh database, saved prices replace the built-in defaults so recovery restores the original cost calculations.
- Settings are replaced by the ones the backup contains; a setting added in a later version than the backup keeps its current value.
- A fresh safety backup is written before the merge, and a storage failure aborts the restore immediately.
