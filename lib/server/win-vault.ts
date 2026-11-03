import "server-only";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Secrets on Windows, the stand-in for the Mac's Keychain (keychain.ts). Each one is encrypted with
 * Windows DPAPI for the signed-in Windows user (ProtectedData, CurrentUser scope), so only that user on
 * this PC can read it back, and kept as its own file in the vault folder. The file's name is a hash of
 * the item's name, so the folder doesn't say what's in it. Values go to PowerShell on stdin, base64
 * encoded, so they never show up in a process list or a command line.
 *
 * The folder: BOPS_WIN_VAULT_DIR, else %APPDATA%\Oshy Ops\vault (outside the server folder, so a
 * reinstall or "start over" doesn't lose saved logins).
 */
const ENTROPY = "Oshy Ops Vault v1";

export const vaultDir = () =>
  process.env.BOPS_WIN_VAULT_DIR || join(process.env.APPDATA || join(process.env.USERPROFILE || process.cwd(), "AppData", "Roaming"), "Oshy Ops", "vault");

const fileFor = (service: string, account: string) => join(vaultDir(), createHash("sha256").update(`${service}\n${account}`).digest("hex") + ".dpapi");

/** Run one DPAPI call in PowerShell: `protect` or `unprotect` the base64 `input`; resolves to base64. */
function dpapi(op: "Protect" | "Unprotect", input: string) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try { Add-Type -AssemblyName System.Security } catch {}",
    `$data = [Convert]::FromBase64String('${input}')`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("\n");
  return new Promise<string>((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 && /^[A-Za-z0-9+/=]*$/.test(out.trim()) ? resolve(out.trim()) : reject(new Error(`Windows refused it: ${err.trim().split("\n")[0] || code}`))));
    p.stdin.end(script + "\n");
  });
}

export async function winSetSecret(service: string, account: string, value: string) {
  const blob = await dpapi("Protect", Buffer.from(value, "utf8").toString("base64"));
  await mkdir(vaultDir(), { recursive: true });
  const file = fileFor(service, account);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, blob, { mode: 0o600 });
  await rename(tmp, file);
}

export async function winGetSecret(service: string, account: string): Promise<string | null> {
  let blob: string;
  try {
    blob = (await readFile(fileFor(service, account), "utf8")).trim();
  } catch {
    return null;
  }
  try {
    return Buffer.from(await dpapi("Unprotect", blob), "base64").toString("utf8");
  } catch {
    return null;
  }
}

export async function winDeleteSecret(service: string, account: string) {
  await unlink(fileFor(service, account)).catch(() => {});
}
