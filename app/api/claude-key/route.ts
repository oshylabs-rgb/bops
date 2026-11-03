import { deleteClaudeKey, isAnthropicKey, setClaudeKey } from "@/lib/server/claude-key";
import { anthropicKeyFrom, CLAUDE_LIGHT_MODEL, CLAUDE_MODEL, forgetAnthropicKey } from "@/lib/server/claude-responses";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Chat on Claude's key (lib/server/claude-key.ts): whether there is one and where it's from, saved or removed.
 * From the app's window only (ui-token.ts), and the key itself never comes back.
 */
const NO_STORE = { "Cache-Control": "no-store" };
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "The Claude key can only be changed in the Oshy Ops app." }, { status: 403, headers: NO_STORE }));

async function status() {
  const { from } = await anthropicKeyFrom();
  return { on: !!from, from, model: CLAUDE_MODEL(), lightModel: CLAUDE_LIGHT_MODEL(), forcedOpenAI: process.env.BOPS_CHAT_PROVIDER?.trim().toLowerCase() === "openai" };
}

export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  return Response.json(await status(), { headers: NO_STORE });
}

/** Save `key` on this computer: chat runs on Claude from the next message. */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { key?: unknown };
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!isAnthropicKey(key)) return Response.json({ error: "That doesn't look like an Anthropic API key. It starts with sk-ant-." }, { status: 400, headers: NO_STORE });
  try {
    await setClaudeKey(key);
  } catch (e) {
    return Response.json({ error: `Couldn't save it on this computer: ${(e as Error).message}` }, { status: 500, headers: NO_STORE });
  }
  forgetAnthropicKey();
  return Response.json(await status(), { headers: NO_STORE });
}

/** Remove the key saved on this computer: chat goes back to OpenAI (unless the settings file or the Vault has one). */
export async function DELETE(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  await deleteClaudeKey();
  forgetAnthropicKey();
  return Response.json(await status(), { headers: NO_STORE });
}
