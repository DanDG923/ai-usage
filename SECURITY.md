# Security policy

## Supported versions

Only the latest release receives fixes. The installed Windows app can update itself from **Settings → Appearance & updates**; portable copies are replaced by downloading the latest release.

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a vulnerability.

A useful report says which version and Windows build you used, what an attacker could do, and the steps to reproduce it. This is a personal project, so responses are best effort; you will get an acknowledgement, and a fix will be released and credited (if you wish) once the issue is confirmed.

## Scope

In scope:

- The AI Usage app: its Electron main process, dashboard and tray windows, local database, backups and exports.
- The in-app updater and the release workflow that publishes its installers and update manifest.
- The Claude Code mod in `claude-code-mod/` and the optional Claude status-line helper.

Out of scope:

- Claude, Claude Code, Codex and the other tools AI Usage reads from. Report those to Anthropic or OpenAI.
- Problems that need an attacker who already controls your Windows account, such as editing the app's files or local database directly.
- The unsigned installer's SmartScreen warning, which is a documented, accepted risk (see **Security model and accepted risks** in the README).
