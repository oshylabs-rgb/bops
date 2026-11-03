# Oshy Ops for Windows

An unofficial Windows port of [Bops](https://github.com/OrgoAI/bops), where chat runs on Claude and bots can work on Claude Code. Based on Bops by Organic Intelligence, Inc., under the same license (FSL-1.1-ALv2). Renamed, with its own icon, as [TRADEMARK.md](../TRADEMARK.md) asks of a modified version.

## Get it
Each push builds it on a GitHub Windows machine (`.github/workflows/windows.yml`). Open the latest run in the Actions tab and download **OshyOps-windows**: an installer (`OshyOps-<version>-x64.exe`) and a zip.

Until code signing is set up (below), Windows SmartScreen warns the first time: **More info**, then **Run anyway**.

## Set it up
1. Open Oshy Ops and sign in with Orgo (or Google / email).
2. **Chat on Claude, on your Claude plan (free):** Settings → AI plans → Chat on Claude → **Install Claude Code**, then **Sign in with your Claude plan** and sign in to your Claude account in the browser window that opens. Chat then runs on your Pro or Max plan, with nothing extra to pay. (Advanced: an Anthropic API key, paid per use, works too.)
3. **Tasks on Claude Code:** Settings → Brain → add Claude Code on your Claude plan, sign in to Claude on the bot's screen, and pick that brain in the bot's profile.
4. **GitHub for the bots:** add a fine-grained GitHub token to the Vault as the GitHub key, limited to the repos they need.

## What runs on Claude
| Part | Runs on | Where in the code |
|---|---|---|
| Chat with bots, replies, tool calls, web search | Claude Opus 5.5 on your Claude plan through Claude Code (`claude -p`), or on the API with a key | `lib/server/claude-code-chat.ts`, `claude-responses.ts`, `chat.ts` |
| Memory, summaries, labels, yes/no judgments | Claude Haiku 5.5 | `memory*.ts`, `chat-summary.ts`, `judge.ts`, `skill-label-model.ts`, `procedures.ts` |
| Tasks on the bots' cloud computers | Claude Code on your Claude plan (a brain) | `lib/server/brains.ts` |
| Voice calls, phone, transcription, drawing pictures, screen watches, app builder | Still OpenAI, through Orgo's AI credit (no Claude equivalent wired yet) | `phone*.ts`, `call.ts`, `transcribe.ts`, `images.ts`, `watches.ts`, `made-apps.ts` |

Which engine runs chat: your Claude plan through Claude Code when it's installed and signed in, else an Anthropic API key, else OpenAI. `BOPS_CHAT_ENGINE=plan|api|openai` fixes it. Models: `BOPS_CLAUDE_MODEL`, `BOPS_CLAUDE_LIGHT_MODEL`.

On the plan, each turn runs Claude Code once in print mode, with its own tools off (only its web search when Bops offers web search), no other MCP servers, and no API key passed on, so it counts against your plan's usage limits and nothing else. Heavy use can hit those limits; chat then says so until they reset.

## Code signing
Not needed for your own laptop: the first time you open the installer, Windows SmartScreen asks once (**More info**, then **Run anyway**). Signing only matters when other people install it. There's no free, publicly trusted signing for this app (free programmes like SignPath Foundation are for open-source licences, and FSL isn't one), and a self-made certificate doesn't stop SmartScreen.

If it's ever needed, the build already signs through **Azure Artifact Signing** (paid) once these are set in the repo's **Settings → Secrets and variables → Actions**: secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; variables `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`. It then checks the signature.

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

## Tests
- `scripts/test-claude-chat.mjs` (the API engine, against a fake Claude) and `scripts/test-claude-plan.mjs` (the plan engine, against a stand-in Claude Code) run in CI; `scripts/test-win-vault.mjs` runs on every Windows build.
- Bops' own tests check its wording exactly ("Bops", "Boppy"). `scripts/test-renamed.sh` runs them against a copy with the names swapped back, so a test that fails there is a real change, not the rename. Checked 3 Nov 2026: the same results as upstream on all 130 (one timing test, `test-web` readPage, is flaky in this container on upstream too).

## Build it yourself (on Windows)
```
npm ci
npm run app:build:win
```
Output: `dist-desktop/`.
