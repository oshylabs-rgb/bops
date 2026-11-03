import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";

/**
 * Chat on Claude (Oshy Ops). Bops' chat, memory, summaries and judgments call OpenAI's Responses API
 * (`client.responses.create`). chatClient() keeps that call shape and, when there's an Anthropic key, runs
 * each call on Claude's Messages API instead, so the callers don't change:
 *
 * - instructions → system; input items (messages, images, function calls and their outputs) → messages;
 * - function tools → tools; OpenAI's web_search → Claude's web search server tool; tool_choice "none" kept;
 * - reasoning.effort → output_config.effort; text.format json_schema → output_config.format;
 * - previous_response_id: Claude's API keeps no responses, so each response's whole conversation is kept
 *   here (in memory, and in .data/claude-responses for a turn that waits on the user's OK across a restart)
 *   and the next call appends to it, never edits it (Claude's thinking blocks stay valid);
 * - the reply comes back shaped as an OpenAI Response: output_text, function_call items, web_search_call
 *   items with their sources, url_citation annotations and usage.
 *
 * Models: the main model is Claude Opus 5.5 (BOPS_CLAUDE_MODEL), the light one (memory, labels, yes/no
 * judgments: OpenAI's "luna", "mini" and "nano" models) Claude Haiku 5.5 (BOPS_CLAUDE_LIGHT_MODEL). Opus
 * and Sonnet calls ask for Anthropic's server-side fallback when Claude declines a request for safety.
 *
 * The key: ANTHROPIC_API_KEY in the settings (.env.local), else the ANTHROPIC_API_KEY key in the Vault.
 * With neither, or BOPS_CHAT_PROVIDER=openai, calls go to OpenAI as before. A previous_response_id from
 * one provider always goes back to that provider.
 */

type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type Options = { maxRetries?: number; timeout?: number; signal?: AbortSignal; headers?: unknown };

export const CLAUDE_MODEL = () => process.env.BOPS_CLAUDE_MODEL?.trim() || "claude-opus-5-5";
export const CLAUDE_LIGHT_MODEL = () => process.env.BOPS_CLAUDE_LIGHT_MODEL?.trim() || "claude-haiku-5-5";
const ID_PREFIX = "resp_claude_";
const MAX_TOKENS = 16_000;
/** Server-side tool loops that stop at their limit (pause_turn) are carried on this many times. */
const MAX_PAUSES = 3;

/** OpenAI's model name → Claude's. A Claude name stays as it is. */
export function claudeModelFor(model: string | undefined | null): string {
  const m = (model ?? "").trim();
  if (m.startsWith("claude-")) return m;
  const light = process.env.BOPS_LIGHT_MODEL?.trim();
  if ((light && m === light) || /luna|mini|nano/i.test(m)) return CLAUDE_LIGHT_MODEL();
  return CLAUDE_MODEL();
}

/* ---------------- The key ---------------- */

let vaultKey: { value: string; at: number } | undefined;
const VAULT_TTL = 5 * 60_000;

/** The Anthropic key chat runs on, or null: chat stays on OpenAI. */
export async function anthropicKey(): Promise<string | null> {
  if (process.env.BOPS_CHAT_PROVIDER?.trim().toLowerCase() === "openai") return null;
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  if (env) return env;
  if (vaultKey && Date.now() - vaultKey.at < VAULT_TTL) return vaultKey.value || null;
  let value = "";
  try {
    // The same way a Claude Code brain on a key gets it (brains.ts): the app's own use, never a bot's tools or a
    // model's. Loaded only when needed: brains.ts brings the whole server with it.
    const { revealNamedKey } = await import("./brains");
    value = (await revealNamedKey("ANTHROPIC_API_KEY", "")).trim();
  } catch {}
  vaultKey = { value, at: Date.now() };
  return value || null;
}

/** Forget the Vault's key, so the next call reads it again (after the user adds or changes it). */
export const forgetAnthropicKey = () => void (vaultKey = undefined);

/* ---------------- Conversations kept for previous_response_id ---------------- */

type Kept = { messages: BetaMessageParam[]; at: number };
const kept = new Map<string, Kept>();
const KEEP_IN_MEMORY = 200;
const KEEP_ON_DISK_MS = 7 * 24 * 60 * 60_000;

const keptDir = () => process.env.BOPS_CLAUDE_RESPONSES_DIR || join(process.cwd(), ".data", "claude-responses");
const keptFile = (id: string) => join(keptDir(), createHash("sha256").update(id).digest("hex").slice(0, 40) + ".json");

function keep(id: string, messages: BetaMessageParam[]) {
  kept.set(id, { messages, at: Date.now() });
  while (kept.size > KEEP_IN_MEMORY) kept.delete(kept.keys().next().value!);
  try {
    mkdirSync(keptDir(), { recursive: true });
    writeFileSync(keptFile(id), JSON.stringify({ id, messages }), { mode: 0o600 });
    prune();
  } catch {}
}

let pruned = 0;
function prune() {
  if (Date.now() - pruned < 60 * 60_000) return;
  pruned = Date.now();
  for (const f of readdirSync(keptDir())) {
    const p = join(keptDir(), f);
    try {
      if (Date.now() - statSync(p).mtimeMs > KEEP_ON_DISK_MS) rmSync(p, { force: true });
    } catch {}
  }
}

function recall(id: string): BetaMessageParam[] | null {
  const m = kept.get(id);
  if (m) return m.messages;
  try {
    const j = JSON.parse(readFileSync(keptFile(id), "utf8")) as { id: string; messages: BetaMessageParam[] };
    return j.id === id ? j.messages : null;
  } catch {
    return null;
  }
}

/* ---------------- OpenAI input → Claude messages ---------------- */

type Item = Record<string, unknown> & { type?: string; role?: string; content?: unknown };

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { raw: String(raw ?? "") };
  }
}

/** A tool_use id Claude accepts (letters, digits, _ and -). */
const toolId = (id: unknown) => {
  const s = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return s || `call_${randomUUID().replace(/-/g, "")}`;
};

function imageBlock(url: string): BetaContentBlockParam | null {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1].toLowerCase() as "image/png", data: data[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

/** A message's content (a string, or OpenAI's parts) as Claude's blocks. */
function partsToBlocks(content: unknown, note?: string): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  const text = (t: unknown) => {
    const s = String(t ?? "");
    if (s.trim()) out.push({ type: "text", text: note ? `${note}${s}` : s });
  };
  if (typeof content === "string") text(content);
  else if (Array.isArray(content))
    for (const p of content as Item[]) {
      if (p.type === "input_text" || p.type === "output_text" || p.type === "text") text(p.text);
      else if (p.type === "refusal") text(p.refusal);
      else if (p.type === "input_image") {
        const url = typeof p.image_url === "string" ? p.image_url : ((p.image_url as { url?: string } | undefined)?.url ?? "");
        const img = imageBlock(url);
        if (img) out.push(img);
      } else if (p.type === "input_file") text(`[A file was attached${p.filename ? `: ${String(p.filename)}` : ""}.]`);
    }
  return out;
}

/** Push blocks onto the conversation: a run of one role becomes one message, tool results first in a user message. */
function pushBlocks(messages: BetaMessageParam[], role: "user" | "assistant", blocks: BetaContentBlockParam[]) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    const all = [...(last.content as BetaContentBlockParam[]), ...blocks];
    last.content = role === "user" ? [...all.filter((b) => b.type === "tool_result"), ...all.filter((b) => b.type !== "tool_result")] : all;
  } else messages.push({ role, content: blocks });
}

/** OpenAI's input (new items only) as Claude messages. */
export function toMessages(input: Params["input"]): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [];
  if (typeof input === "string") {
    pushBlocks(messages, "user", partsToBlocks(input));
    return messages;
  }
  for (const item of (input ?? []) as Item[]) {
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      const role = item.role;
      if (role === "assistant") pushBlocks(messages, "assistant", partsToBlocks(item.content));
      else if (role === "developer" || role === "system") pushBlocks(messages, "user", partsToBlocks(item.content, "[Instructions from the app] "));
      else pushBlocks(messages, "user", partsToBlocks(item.content));
    } else if (type === "function_call") {
      pushBlocks(messages, "assistant", [{ type: "tool_use", id: toolId(item.call_id), name: String(item.name ?? "tool"), input: parseArgs(item.arguments) }]);
    } else if (type === "function_call_output") {
      const out = item.output;
      const content = typeof out === "string" ? out : JSON.stringify(out ?? "");
      pushBlocks(messages, "user", [{ type: "tool_result", tool_use_id: toolId(item.call_id), content: content || "(no output)" }]);
    }
    // reasoning, web_search_call and other OpenAI-only items carry nothing Claude needs.
  }
  return messages;
}

/**
 * Make a conversation Claude accepts: it starts with the user, every tool_use is answered by a tool_result in
 * the next message and every tool_result answers one. Anything else is kept as plain text, never dropped.
 * Only the part that came from OpenAI-shaped input is checked; a kept conversation is already valid.
 */
export function tidy(messages: BetaMessageParam[], from = 0): BetaMessageParam[] {
  const out = messages.slice(0, from);
  const rest = messages.slice(from);
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i];
    const blocks = (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }]) as BetaContentBlockParam[];
    if (m.role === "assistant") {
      const next = rest[i + 1];
      const answered = new Set(next?.role === "user" && Array.isArray(next.content) ? (next.content as BetaContentBlockParam[]).filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id) : []);
      const fixed = blocks.map((b) => (b.type === "tool_use" && !answered.has(b.id) ? ({ type: "text", text: `[Called ${b.name} ${JSON.stringify(b.input)}]` } as BetaContentBlockParam) : b));
      pushBlocks(out, "assistant", fixed);
    } else {
      const prev = out[out.length - 1];
      const asked = new Set(prev?.role === "assistant" && Array.isArray(prev.content) ? (prev.content as BetaContentBlockParam[]).filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id) : []);
      const fixed = blocks.map((b) => (b.type === "tool_result" && !asked.has(b.tool_use_id) ? ({ type: "text", text: `[A tool answered: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}]` } as BetaContentBlockParam) : b));
      pushBlocks(out, "user", fixed);
    }
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(The conversation so far.)" }] });
  return out;
}

/* ---------------- Tools and settings ---------------- */

function toTools(tools: Params["tools"]): BetaToolUnion[] {
  const out: BetaToolUnion[] = [];
  for (const t of (tools ?? []) as Item[]) {
    if (t.type === "function") {
      const schema = (t.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} };
      out.push({ name: String(t.name), description: String(t.description ?? ""), input_schema: { type: "object", ...schema } as Anthropic.Beta.BetaTool.InputSchema });
    } else if (t.type === "web_search" || t.type === "web_search_preview") {
      const loc = t.user_location as { city?: string; country?: string; region?: string; timezone?: string } | undefined;
      out.push({
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 5,
        ...(loc ? { user_location: { type: "approximate" as const, city: loc.city ?? null, country: loc.country ?? null, region: loc.region ?? null, timezone: loc.timezone ?? null } } : {}),
      });
    }
    // Other OpenAI-only tools (computer use, image generation, code interpreter…) don't run on Claude here.
  }
  return out;
}

const EFFORT: Record<string, "low" | "medium" | "high" | "xhigh" | "max"> = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** The request for Claude, from OpenAI's params and the conversation so far. */
export function toRequest(params: Params, messages: BetaMessageParam[]): MessageCreateParamsNonStreaming {
  const model = claudeModelFor(params.model as string);
  const tools = toTools(params.tools);
  const choice = params.tool_choice;
  const effort = EFFORT[String((params.reasoning as { effort?: string } | null | undefined)?.effort ?? "")] ?? undefined;
  const format = (params.text as { format?: { type?: string; schema?: Record<string, unknown> } } | undefined)?.format;
  const instructions = typeof params.instructions === "string" ? params.instructions : "";
  const jsonOnly = format?.type === "json_object" ? "\n\nAnswer with one JSON object and nothing else." : "";
  const system = `${instructions}${jsonOnly}`.trim();
  // Server-side fallback when Claude declines a request for safety: Opus and Sonnet on Anthropic's API.
  const fallback = /^claude-(opus|sonnet)-/.test(model);
  return {
    model,
    max_tokens: Math.min(Number(params.max_output_tokens) || MAX_TOKENS, 64_000),
    // Caches the conversation so far, so each round of a turn reads it again at a tenth of the price.
    cache_control: { type: "ephemeral" },
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(tools.length && choice === "none" ? { tool_choice: { type: "none" } } : tools.length && params.parallel_tool_calls === false ? { tool_choice: { type: "auto", disable_parallel_tool_use: true } } : {}),
    ...(effort || format?.type === "json_schema"
      ? { output_config: { ...(effort ? { effort } : {}), ...(format?.type === "json_schema" && format.schema ? { format: { type: "json_schema", schema: format.schema } } : {}) } }
      : {}),
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  } as MessageCreateParamsNonStreaming;
}

/* ---------------- Claude's reply → an OpenAI Response ---------------- */

type Annotation = { type: "url_citation"; url: string; title: string; start_index: number; end_index: number };

export function toResponse(id: string, msg: BetaMessage, all: BetaContentBlock[], usage: { input: number; output: number; cached: number }): OpenAI.Responses.Response {
  const output: unknown[] = [];
  let text = "";
  let open: { type: "message"; id: string; role: "assistant"; status: "completed"; content: { type: "output_text"; text: string; annotations: Annotation[] }[] } | null = null;
  const searches = new Map<string, { type: "web_search_call"; id: string; status: "completed"; action: { type: "search"; query: string; sources: { type: "url"; url: string }[] } }>();
  for (const b of all) {
    if (b.type === "text") {
      if (!open) {
        open = { type: "message", id: `msg_${randomUUID().replace(/-/g, "")}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] };
        output.push(open);
      }
      const part = open.content[0];
      const start = part.text.length;
      part.text += b.text;
      text += b.text;
      for (const c of (b.citations ?? []) as { type?: string; url?: string; title?: string | null }[])
        if (c.url) part.annotations.push({ type: "url_citation", url: c.url, title: c.title ?? c.url, start_index: start, end_index: part.text.length });
    } else if (b.type === "tool_use") {
      open = null;
      output.push({ type: "function_call", id: `fc_${b.id}`, call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: "completed" });
    } else if (b.type === "server_tool_use" && b.name === "web_search") {
      const call = { type: "web_search_call" as const, id: `ws_${b.id}`, status: "completed" as const, action: { type: "search" as const, query: String((b.input as { query?: string })?.query ?? ""), sources: [] as { type: "url"; url: string }[] } };
      searches.set(b.id, call);
      output.push(call);
    } else if (b.type === "web_search_tool_result") {
      const call = searches.get(b.tool_use_id);
      if (call && Array.isArray(b.content)) for (const r of b.content) if (r.url) call.action.sources.push({ type: "url", url: r.url });
    }
  }
  if (msg.stop_reason === "refusal") {
    const said = "I can't help with that request.";
    text = text || said;
    output.push({ type: "message", id: `msg_${randomUUID().replace(/-/g, "")}`, role: "assistant", status: "completed", content: [{ type: "refusal", refusal: said }] });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: msg.model,
    status: msg.stop_reason === "max_tokens" ? "incomplete" : "completed",
    ...(msg.stop_reason === "max_tokens" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output,
    output_text: text,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input + usage.output,
    },
  } as unknown as OpenAI.Responses.Response;
}

/* ---------------- The call ---------------- */

const clients = new Map<string, Anthropic>();
function anthropic(key: string) {
  let c = clients.get(key);
  if (!c) {
    clients.clear();
    c = new Anthropic({ apiKey: key });
    clients.set(key, c);
  }
  return c;
}

/** One responses.create, run on Claude. */
export async function claudeCreate(key: string, params: Params, opts: Options = {}): Promise<OpenAI.Responses.Response> {
  const earlier = params.previous_response_id ? recall(params.previous_response_id) : [];
  if (!earlier) throw new Error("That conversation is no longer kept. Ask again.");
  const fresh = toMessages(params.input);
  const conversation = tidy([...earlier, ...fresh], earlier.length);
  const client = anthropic(key);
  const request = toRequest(params, conversation);
  const all: BetaContentBlock[] = [];
  const usage = { input: 0, output: 0, cached: 0 };
  let msg: BetaMessage | undefined;
  // Only what the caller set: the SDK refuses an option that's there but undefined.
  const callOpts = {
    ...(typeof opts.maxRetries === "number" ? { maxRetries: opts.maxRetries } : {}),
    ...(typeof opts.timeout === "number" ? { timeout: opts.timeout } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  for (let i = 0; i <= MAX_PAUSES; i++) {
    msg = await client.beta.messages.create({ ...request, messages: conversation }, callOpts);
    const u = msg.usage;
    usage.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.cached += u.cache_read_input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    all.push(...msg.content);
    // The whole reply goes back as it came (thinking blocks too), so the conversation only ever grows.
    pushReply(conversation, msg.content);
    if (msg.stop_reason !== "pause_turn") break;
  }
  const id = `${ID_PREFIX}${msg!.id}`;
  keep(id, conversation);
  return toResponse(id, msg!, all, usage);
}

/** The assistant's reply on the conversation: a reply carried on after pause_turn joins the one before it. */
function pushReply(conversation: BetaMessageParam[], content: BetaContentBlock[]) {
  const last = conversation[conversation.length - 1];
  const blocks = content as unknown as BetaContentBlockParam[];
  if (last?.role === "assistant" && Array.isArray(last.content)) last.content = [...(last.content as BetaContentBlockParam[]), ...blocks];
  else conversation.push({ role: "assistant", content: blocks });
}

/**
 * The client chat, memory, summaries and judgments call: OpenAI's `responses` API in shape, run on Claude when
 * there's an Anthropic key (see the top of this file), else on OpenAI (openai-client.ts) as before.
 */
export function chatClient(): Pick<OpenAI, "responses"> {
  let oa: Promise<OpenAI> | undefined;
  const openai = () => (oa ??= import("./openai-client").then((m) => m.openaiClient()));
  const create = async (params: Params, opts?: Options) => {
    const prev = params.previous_response_id ?? "";
    const key = prev && !prev.startsWith(ID_PREFIX) ? null : await anthropicKey();
    if (prev.startsWith(ID_PREFIX)) {
      if (!key) throw new Error("Chat runs on Claude, but there's no Anthropic key now. Add ANTHROPIC_API_KEY in the Vault.");
      return claudeCreate(key, params, opts);
    }
    if (!key) return (await openai()).responses.create(params, opts as never);
    return claudeCreate(key, params, opts);
  };
  return { responses: { create } } as unknown as Pick<OpenAI, "responses">;
}
