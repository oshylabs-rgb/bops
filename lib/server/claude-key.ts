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
