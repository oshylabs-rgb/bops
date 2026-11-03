// Tests for the Windows stand-in for the Mac's Keychain (lib/server/win-vault.ts): a secret saved comes
// back the same (unicode too), its file holds no trace of it or its name, saving again replaces it, a
// missing or deleted one reads as null, and a file that isn't this user's DPAPI data reads as null.
// Windows only (DPAPI): elsewhere it says so and passes. The vault is a throwaway folder; the values are made up.
// Usage: node --conditions=react-server scripts/test-win-vault.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("test-win-vault: skipped (DPAPI is Windows only).");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "oshyops-vault-"));
process.env.BOPS_WIN_VAULT_DIR = dir;
const { winSetSecret, winGetSecret, winDeleteSecret } = await import("../lib/server/win-vault.ts");

try {
  const value = "pa55-wörd ✓ 'quote' \"double\" $env:PATH";
  await winSetSecret("Bops Vault", "user1:login-42", value);
  assert.equal(await winGetSecret("Bops Vault", "user1:login-42"), value, "reads back what was saved");

  const files = readdirSync(dir);
  assert.equal(files.length, 1, "one file per secret");
  assert.match(files[0], /^[0-9a-f]{64}\.dpapi$/, "the file's name is a hash, not the item's name");
  const blob = readFileSync(join(dir, files[0]), "utf8");
  assert.ok(!blob.includes("pa55") && !Buffer.from(blob, "base64").toString("latin1").includes("pa55"), "the file holds no plain value");

  await winSetSecret("Bops Vault", "user1:login-42", "second");
  assert.equal(await winGetSecret("Bops Vault", "user1:login-42"), "second", "saving again replaces it");
  assert.equal(readdirSync(dir).length, 1, "no leftover temp files");

  assert.equal(await winGetSecret("Bops Vault", "nobody"), null, "a missing one is null");

  writeFileSync(join(dir, files[0]), Buffer.from("not dpapi data").toString("base64"));
  assert.equal(await winGetSecret("Bops Vault", "user1:login-42"), null, "a file that isn't DPAPI data is null, not a throw");

  await winSetSecret("Bops Vault", "user1:login-42", "third");
  await winDeleteSecret("Bops Vault", "user1:login-42");
  assert.equal(await winGetSecret("Bops Vault", "user1:login-42"), null, "a deleted one is gone");
  await winDeleteSecret("Bops Vault", "user1:login-42");
  console.log("test-win-vault: all passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
