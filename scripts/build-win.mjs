#!/usr/bin/env node
// Builds Oshy Ops for Windows (the Windows port of Bops): the server (Next.js standalone, with brains on,
// so bots can run on Claude Code) packed into an Electron app, as an installer (NSIS) and a zip in
// dist-desktop/. Run it on Windows (a GitHub Windows runner does: .github/workflows/windows.yml).
//
//   npm run app:build:win
//
// Signed when the Azure Artifact Signing settings are there (below); unsigned otherwise, and then Windows
// SmartScreen warns the first time it's opened ("More info", then "Run anyway").
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

// Code signing through Azure Artifact Signing (Trusted Signing), when its settings are here: the account's
// endpoint, account and certificate profile, and the publisher name on the certificate (the company's legal
// name). electron-builder signs with them, logging in with AZURE_TENANT_ID, AZURE_CLIENT_ID and
// AZURE_CLIENT_SECRET. Without them the build is unsigned, as before.
const az = { endpoint: process.env.AZURE_SIGN_ENDPOINT, account: process.env.AZURE_SIGN_ACCOUNT, profile: process.env.AZURE_SIGN_PROFILE, publisher: process.env.AZURE_SIGN_PUBLISHER };
const signing = Object.values(az).every((v) => v?.trim()) && !!process.env.AZURE_CLIENT_SECRET;
if (Object.values(az).some((v) => v?.trim()) && !signing) throw new Error("Code signing is half set up: AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER and AZURE_CLIENT_SECRET all need a value.");
const q = (v) => JSON.stringify(v.trim());
const signArgs = signing
  ? ` -c.win.azureSignOptions.endpoint=${q(az.endpoint)} -c.win.azureSignOptions.codeSigningAccountName=${q(az.account)} -c.win.azureSignOptions.certificateProfileName=${q(az.profile)} -c.win.azureSignOptions.publisherName=${q(az.publisher)}`
  : "";
console.log(signing ? `Signing with Azure Artifact Signing as ${az.publisher.trim()}.` : "Not signing: no Azure Artifact Signing settings.");
run(`npx electron-builder --win --x64 --config desktop/win.builder.json --publish never${signArgs}`, { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
console.log("Built: dist-desktop/ (OshyOps-*-x64.exe installer and .zip).");
