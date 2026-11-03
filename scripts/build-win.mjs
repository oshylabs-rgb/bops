#!/usr/bin/env node
// Builds Oshy Ops for Windows (the Windows port of Bops): the server (Next.js standalone, with brains on,
// so bots can run on Claude Code) packed into an Electron app, as an installer (NSIS) and a zip in
// dist-desktop/. Run it on Windows (a GitHub Windows runner does: .github/workflows/windows.yml).
//
//   npm run app:build:win
//
// Unsigned: Windows SmartScreen warns the first time it's opened ("More info", then "Run anyway").
// Not carried yet (Mac-only or private to Orgo): the relay agent ("Route through this Mac"), the ingot
// command, and the runner bundle for cloud routines.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
process.chdir(root);
const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });

// A build that runs the source folder has desktop/repo.json; a release must not.
rmSync("desktop/repo.json", { force: true });

if (!process.env.BOPS_SERVER_BUILT) run("npx next build", { NEXT_PUBLIC_BOPS_BRAINS: "1", NEXT_TELEMETRY_DISABLED: "1" });

const sa = ".next/standalone";
if (!existsSync(join(sa, "server.js"))) throw new Error(`No ${sa}/server.js: is output "standalone" set in next.config.ts?`);
// Only what the server needs, as scripts/server-bundle.sh ships it: never settings, state or the repo's other folders.
const keep = new Set([".next", "cloud", "LICENSE", "node_modules", "package.json", "public", "server.js", "slack", "vm"]);
for (const name of readdirSync(sa)) {
  if (keep.has(name)) continue;
  console.log(`Not shipping ${name} (traced from the project, not part of the server).`);
  rmSync(join(sa, name), { recursive: true, force: true });
}

run("npx electron-builder --win --x64 --config desktop/win.builder.json --publish never", { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
console.log("Built: dist-desktop/ (OshyOps-*-x64.exe installer and .zip).");
