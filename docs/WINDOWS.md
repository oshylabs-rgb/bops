# Oshy Ops for Windows

An unofficial Windows port of [Bops](https://github.com/OrgoAI/bops), with Claude Code turned on as a bot brain. Based on Bops by Organic Intelligence, Inc., under the same license (FSL-1.1-ALv2). Renamed and with its own icon, as [TRADEMARK.md](../TRADEMARK.md) asks of a modified version.

## Get it
Each push builds it on a GitHub Windows machine (`.github/workflows/windows.yml`). Open the latest run in the Actions tab and download **OshyOps-windows**: an installer (`OshyOps-<version>-x64.exe`) and a zip.

It isn't code-signed yet, so Windows SmartScreen warns the first time: **More info**, then **Run anyway**.

## Set it up
1. Open Oshy Ops and sign in with Orgo (or Google / email).
2. **Settings → Brain**: add **Claude Code** on your Claude plan, and sign in to Claude on the bot's screen when it opens. Then pick that brain in the bot's profile.
3. GitHub for the bots: add a fine-grained GitHub token to the Vault as the GitHub key, limited to the repos they need.

## What changed from the Mac app
| Area | Mac (Bops) | Windows (Oshy Ops) |
|---|---|---|
| Saved logins and tokens | macOS Keychain | Windows DPAPI, per Windows user, files in `%APPDATA%\Oshy Ops\vault` (`lib/server/win-vault.ts`) |
| Keep awake during tasks | `caffeinate` | `SetThreadExecutionState` (`lib/server/awake.ts`) |
| Window ↔ server render link | Unix socket | Named pipe (`desktop/main.cjs`) |
| Server files | Symlinks into the app | Junctions and copies (no admin rights needed) |
| Updates | From bops.bot | Off: new builds come from this fork's Actions |
| Claude Code brain | Dev builds only | On in every build |

## Not in the Windows version yet
- Tasks on your own PC (the Mac version runs them through Codex in a macOS sandbox).
- Mac-only features: Full access to your Mac's apps, "Route through this Mac" (the relay agent is a private Orgo binary), the screen-share permission prompts.
- Cloud routines' runner bundle. Routines run in the app while it's open.
- Chat and voice still run on OpenAI through Orgo's AI credit. Moving them to Claude is the next stage.
- In-app wording still says "Bops" in places.

## Build it yourself (on Windows)
```
npm ci
npm run app:build:win
```
Output: `dist-desktop/`.
