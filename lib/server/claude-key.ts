import "server-only";
import { deleteSecret, getSecret, setSecret } from "./keychain";

/**
 * The Anthropic key chat on Claude runs on (claude-responses.ts), kept on this computer: the Mac's Keychain, or
 * Windows' DPAPI store (keychain.ts, win-vault.ts). Set in Settings → AI plans; never in the state, a log, or
 * anything a bot or a model sees. ANTHROPIC_API_KEY in the settings file wins over it.
 */
const ACCOUNT = "oshyops:anthropic-api-key";

export const isAnthropicKey = (k: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k.trim());

export async function getClaudeKey(): Promise<string | null> {
  return (await getSecret(ACCOUNT).catch(() => null))?.trim() || null;
}

export async function setClaudeKey(key: string) {
  if (!isAnthropicKey(key)) throw new Error("That doesn't look like an Anthropic API key (it starts with sk-ant-).");
  await setSecret(ACCOUNT, key.trim());
}

export const deleteClaudeKey = () => deleteSecret(ACCOUNT);

/**
 * A long-lived Claude Code token (`claude setup-token`, on the user's Claude plan), for Claude Code to run with
 * where it isn't signed in itself (claude-code-chat.ts). Optional: Claude Code's own sign-in works without it.
 */
const TOKEN_ACCOUNT = "oshyops:claude-code-token";
export const isClaudeToken = (t: string) => /^sk-ant-oat[A-Za-z0-9_-]{20,}$/.test(t.trim());
export async function getClaudeToken(): Promise<string | null> {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || (await getSecret(TOKEN_ACCOUNT).catch(() => null))?.trim() || null;
}
export async function setClaudeToken(token: string) {
  if (!isClaudeToken(token)) throw new Error("That doesn't look like a Claude Code token (it starts with sk-ant-oat).");
  await setSecret(TOKEN_ACCOUNT, token.trim());
}
export const deleteClaudeToken = () => deleteSecret(TOKEN_ACCOUNT);
