# Oshy Ops for Windows

An unofficial Windows port of [Bops](https://github.com/OrgoAI/bops), where chat runs on Claude and bots can work on Claude Code. Based on Bops by Organic Intelligence, Inc., under the same license (FSL-1.1-ALv2). Renamed, with its own icon, as [TRADEMARK.md](../TRADEMARK.md) asks of a modified version.

## Get it
Each push builds it on a GitHub Windows machine (`.github/workflows/windows.yml`). Open the latest run in the Actions tab and download **OshyOps-windows**: an installer (`OshyOps-<version>-x64.exe`) and a zip.

Until code signing is set up (below), Windows SmartScreen warns the first time: **More info**, then **Run anyway**.

## Set it up
1. Open Oshy Ops and sign in with Orgo (or Google / email).
2. **Chat on Claude:** add your Anthropic API key in the Vault as **Anthropic** (`ANTHROPIC_API_KEY`). Chat picks it up within 5 minutes. Or put `ANTHROPIC_API_KEY=` in `%APPDATA%\Oshy Ops\.env.local` and restart.
3. **Tasks on Claude Code:** Settings → Brain → add Claude Code on your Claude plan, sign in to Claude on the bot's screen, and pick that brain in the bot's profile.
4. **GitHub for the bots:** add a fine-grained GitHub token to the Vault as the GitHub key, limited to the repos they need.

## What runs on Claude
| Part | Runs on | Where in the code |
|---|---|---|
| Chat with bots, replies, tool calls, web search | Claude Opus 5.5 (with Anthropic's server-side fallback if Claude declines a request) | `lib/server/claude-responses.ts`, `chat.ts` |
| Memory, summaries, labels, yes/no judgments | Claude Haiku 5.5 | `memory*.ts`, `chat-summary.ts`, `judge.ts`, `skill-label-model.ts`, `procedures.ts` |
| Tasks on the bots' cloud computers | Claude Code on your Claude plan (a brain) | `lib/server/brains.ts` |
| Voice calls, phone, transcription, drawing pictures, screen watches, app builder | Still OpenAI, through Orgo's AI credit (no Claude equivalent wired yet) | `phone*.ts`, `call.ts`, `transcribe.ts`, `images.ts`, `watches.ts`, `made-apps.ts` |

Without an Anthropic key, or with `BOPS_CHAT_PROVIDER=openai`, chat stays on OpenAI. Models can be changed with `BOPS_CLAUDE_MODEL` and `BOPS_CLAUDE_LIGHT_MODEL`.

## Code signing
The build signs itself through **Azure Artifact Signing** once these are set in the repo's **Settings → Secrets and variables → Actions**:

| Kind | Name | What it is |
|---|---|---|
| Secret | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | An Azure app registration allowed to sign ("Artifact Signing Certificate Profile Signer" role) |
| Variable | `AZURE_SIGN_ENDPOINT` | The signing account's region endpoint, e.g. `https://weu.codesigning.azure.net/` |
| Variable | `AZURE_SIGN_ACCOUNT` | The signing account's name |
| Variable | `AZURE_SIGN_PROFILE` | The certificate profile's name |
| Variable | `AZURE_SIGN_PUBLISHER` | The name on the certificate (the company's legal name) |

Then the build checks the signature and fails if it isn't valid. Without them it builds unsigned, as before.

## What changed from the Mac app
| Area | Mac (Bops) | Windows (Oshy Ops) |
|---|---|---|
| Saved logins and tokens | macOS Keychain | Windows DPAPI, per Windows user, files in `%APPDATA%\Oshy Ops\vault` (`lib/server/win-vault.ts`) |
| Keep awake during tasks | `caffeinate` | `SetThreadExecutionState` (`lib/server/awake.ts`) |
| Window ↔ server render link | Unix socket | Named pipe (`desktop/main.cjs`) |
| Server files | Symlinks into the app | Junctions and copies (no admin rights needed) |
| Updates | From bops.bot | Off: new builds come from this fork's Actions |
| Claude Code brain | Dev builds only | On in every build |
| Name | Bops, main bot Boppy | Oshy Ops, main bot Oshy (text people see; code names unchanged so Orgo's updates still merge) |

## Not in the Windows version yet
- Tasks on your own PC (the Mac version runs them through Codex in a macOS sandbox).
- Mac-only features: Full access to your Mac's apps, "Route through this Mac" (the relay agent is a private Orgo binary), the screen-share permission prompts.
- Cloud routines' runner bundle. Routines run in the app while it's open.
- Bops Cloud (Orgo's server) keeps its name where the app mentions it: it's Orgo's service.

## Build it yourself (on Windows)
```
npm ci
npm run app:build:win
```
Output: `dist-desktop/`.
