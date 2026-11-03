import "server-only";
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type OpenAI from "openai";
import { claudeModelFor, keep, recall, tidy, toMessages } from "./claude-responses";

/**
 * Chat on the user's own Claude plan (Pro or Max), through Claude Code on this computer: no API key, nothing
 * billed beyond the plan. Each responses.create (claude-responses.ts chatClient) runs `claude -p` once:
 *
 * - the conversation so far goes in as a transcript (stdin), Bops' instructions as the system prompt (a file:
 *   Windows caps a command line at 32k characters);
 * - Bops' tools are offered in the system prompt and answered through Claude Code's structured output
 *   (--json-schema): { reply, tool_calls }. Bops runs the calls itself, as it does on OpenAI, and the next call
 *   (previous_response_id) carries their results. Claude Code's own tools are off (--tools ""), except its web
 *   search and page reader when Bops offered web search; those show up as web_search_call items with the
 *   addresses they read, so Bops still knows the turn read something from outside;
 * - a JSON answer (text.format json_schema) comes from --json-schema too.
 *
 * Sign-in: a long-lived token from `claude setup-token` saved in Settings (claude-key.ts) runs Claude Code bare
 * (no hooks, no CLAUDE.md, no other MCP servers); without one, Claude Code's own sign-in on this computer is used.
 * An Anthropic API key in this server's environment is never passed on, so these runs stay on the plan.
 */

export const CC_PREFIX = "resp_cc_";
type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type Options = { timeout?: number; signal?: AbortSignal };
const TIMEOUT_MS = 5 * 60_000;

/** Claude Code's command on this computer: BOPS_CLAUDE_BIN, else on PATH, else where its installer puts it. */
export function findClaude(): string | null {
  const set = process.env.BOPS_CLAUDE_BIN?.trim();
  if (set) return existsSync(set) ? set : null;
  const win = process.platform === "win32";
  const name = win ? "claude.exe" : "claude";
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin"), ...(win ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "claude")] : ["/usr/local/bin", "/opt/homebrew/bin"])];
  for (const d of dirs) if (existsSync(join(d, name))) return join(d, name);
  return null;
}

/** The environment Claude Code runs with: no API key of this server's (the plan pays, never the API), the saved token if any. */
function ccEnv(token: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[k];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

async function savedToken(): Promise<string | null> {
  try {
    const { getClaudeToken } = await import("./claude-key");
    return await getClaudeToken();
  } catch {
    return null;
  }
}

export type PlanStatus = { installed: boolean; signedIn: boolean; plan?: string; email?: string; via?: "token" | "login" };
let status: { at: number; value: PlanStatus } | undefined;
const STATUS_TTL = 2 * 60_000;

/** Whether Claude Code is here and signed in to a plan (`claude auth status --json`), asked at most every 2 minutes. */
export async function planStatus(fresh = false): Promise<PlanStatus> {
  if (!fresh && status && Date.now() - status.at < STATUS_TTL) return status.value;
  const bin = findClaude();
  let value: PlanStatus = { installed: !!bin, signedIn: false };
  if (bin) {
    const token = await savedToken();
    const out = await new Promise<string>((resolve) => execFile(bin, ["auth", "status", "--json"], { env: ccEnv(token), timeout: 20_000, windowsHide: true }, (_e, stdout) => resolve(String(stdout ?? ""))));
    try {
      const j = JSON.parse(out) as { loggedIn?: boolean; subscriptionType?: string; email?: string };
      if (j.loggedIn) value = { installed: true, signedIn: true, plan: j.subscriptionType?.toLowerCase(), email: j.email, via: token ? "token" : "login" };
    } catch {
      // An older Claude Code without `auth status`: a saved token is taken as signed in; a run says if it isn't.
      if (token) value = { installed: true, signedIn: true, via: "token" };
    }
  }
  status = { at: Date.now(), value };
  return value;
}
export const forgetPlanStatus = () => void (status = undefined);

/* ---------------- The conversation as a transcript ---------------- */

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n") : "";

/** The conversation as Claude reads it here: who said what, each tool call and its answer by id. */
export function transcript(messages: BetaMessageParam[]): string {
  const names = new Map<string, string>();
  const out: string[] = [];
  for (const m of messages) {
    const blocks = (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }]) as BetaContentBlockParam[];
    for (const b of blocks) {
      if (b.type === "text" && b.text.trim()) out.push(m.role === "user" ? `[User]\n${b.text}` : `[You]\n${b.text}`);
      else if (b.type === "image") out.push("[The user sent an image, which can't be shown here.]");
      else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        out.push(`[You called ${b.name} (call ${b.id}) with ${JSON.stringify(b.input ?? {})}]`);
      } else if (b.type === "tool_result") out.push(`[Result of ${names.get(b.tool_use_id) ?? "a tool"} (call ${b.tool_use_id})]\n${textOf(b.content) || "(no output)"}`);
    }
  }
  return out.join("\n\n");
}

type Fn = { name: string; description?: string; parameters?: unknown };

/** The tools Bops offers, said in the system prompt, and the answer's shape that calls them. */
function toolProtocol(fns: Fn[]) {
  const list = fns.map((f) => `- ${f.name}: ${f.description ?? ""}\n  arguments (JSON Schema): ${JSON.stringify(f.parameters ?? { type: "object", properties: {} })}`).join("\n");
  const text = [
    "How you answer here: put the words for the user in reply. To use tools, list the calls in tool_calls, each with its name and its arguments as a JSON object that fits its schema; the app runs them and gives you their results, and you go on from there. Leave tool_calls empty when you need none. reply can be empty when you only call tools.",
    "Your tools:",
    list,
  ].join("\n");
  const schema = {
    type: "object",
    properties: {
      reply: { type: "string" },
      tool_calls: { type: "array", items: { type: "object", properties: { name: { type: "string", enum: fns.map((f) => f.name) }, arguments: { type: "object" } }, required: ["name", "arguments"] } },
    },
    required: ["reply", "tool_calls"],
  };
  return { text, schema };
}

/* ---------------- One run ---------------- */

type Event = Record<string, unknown> & { type?: string };

/** Runs Claude Code once; resolves to its stream-json events (the last is its result). */
export function runClaude(bin: string, args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string, opts: Options = {}): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const events: Event[] = [];
    let buf = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), opts.timeout ?? TIMEOUT_MS);
    const abort = () => p.kill();
    opts.signal?.addEventListener("abort", abort, { once: true });
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => (clearTimeout(timer), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (buf.trim())
        try {
          events.push(JSON.parse(buf.trim()));
        } catch {}
      const result = events.findLast((e) => e.type === "result");
      if (!result) return reject(new Error(friendly(err.trim() || `Claude Code stopped (${code ?? "killed"}) without an answer.`)));
      resolve(events);
    });
    p.stdin.end(input);
  });
}

/** What Claude Code said went wrong, in words the chat can show. */
function friendly(why: string): string {
  if (/log ?in|\/login|not (logged|signed) in|invalid api key|oauth|token.*(expired|invalid)|401/i.test(why)) return "Claude Code isn't signed in to your Claude plan on this computer. Sign in under Settings → AI plans → Chat on Claude.";
  if (/rate.?limit|usage limit|limit reached|429/i.test(why)) return `Your Claude plan's limit is reached for now: ${why.slice(0, 200)}`;
  return `Claude Code couldn't answer: ${why.slice(0, 300)}`;
}

const URLS = /https?:\/\/[^\s"'<>)\]]+/g;

/** One responses.create on the user's Claude plan through Claude Code. */
export async function claudeCodeCreate(params: Params, opts: Options = {}): Promise<OpenAI.Responses.Response> {
  const bin = findClaude();
  if (!bin) throw new Error("Claude Code isn't installed on this computer. Install it under Settings → AI plans → Chat on Claude.");
  const earlier = params.previous_response_id ? recall(params.previous_response_id) : [];
  if (!earlier) throw new Error("That conversation is no longer kept. Ask again.");
  const conversation = tidy([...earlier, ...toMessages(params.input)], earlier.length);

  const tools = (params.tools ?? []) as (Fn & { type?: string })[];
  const fns = params.tool_choice === "none" ? [] : tools.filter((t) => t.type === "function");
  const web = tools.some((t) => t.type === "web_search" || t.type === "web_search_preview");
  const format = (params.text as { format?: { type?: string; schema?: Record<string, unknown> } } | undefined)?.format;
  const protocol = fns.length ? toolProtocol(fns) : null;
  const schema = protocol?.schema ?? (format?.type === "json_schema" ? format.schema : undefined);
  const system = [typeof params.instructions === "string" ? params.instructions : "", protocol?.text ?? "", format?.type === "json_object" ? "Answer with one JSON object and nothing else." : ""]
    .filter((s) => s.trim())
    .join("\n\n---\n\n");

  const token = await savedToken();
  const dir = mkdtempSync(join(tmpdir(), "oshyops-claude-"));
  try {
    writeFileSync(join(dir, "system.md"), system || "You are a helpful assistant.", { mode: 0o600 });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--model",
      claudeModelFor(params.model as string),
      "--system-prompt-file",
      join(dir, "system.md"),
      "--max-turns",
      web ? "12" : "4",
      "--tools",
      web ? "WebSearch,WebFetch" : "",
      ...(web ? ["--allowedTools", "WebSearch", "WebFetch"] : []),
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
      ...(token ? ["--bare"] : []),
    ];
    const work = join(dir, "work");
    mkdirSync(work);
    const prompt = `${transcript(conversation)}\n\n[Now write your next turn.]`;
    const events = await runClaude(bin, args, prompt, ccEnv(token), work, opts);
    return toResponse(events, conversation, schema !== undefined, !!protocol);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Claude Code's events as an OpenAI Response, the conversation kept for the next call. */
export function toResponse(events: Event[], conversation: BetaMessageParam[], structured: boolean, withTools: boolean): OpenAI.Responses.Response {
  const result = events.findLast((e) => e.type === "result") as Event & {
    subtype?: string;
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    modelUsage?: Record<string, unknown>;
  };
  if (result.is_error || (result.subtype && result.subtype !== "success")) throw new Error(friendly(String(result.result ?? result.subtype ?? "an error")));

  // Its own web search and page reads: what Bops counts as reading from outside, with the addresses read.
  const web = new Map<string, { type: "web_search_call"; id: string; status: "completed"; action: { type: "search"; query: string; sources: { type: "url"; url: string }[] } }>();
  for (const e of events) {
    const content = ((e.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
    for (const b of content) {
      if (e.type === "assistant" && b.type === "tool_use" && (b.name === "WebSearch" || b.name === "WebFetch")) {
        const input = (b.input ?? {}) as { query?: string; url?: string };
        web.set(String(b.id), { type: "web_search_call", id: `ws_${String(b.id)}`, status: "completed", action: { type: "search", query: input.query ?? input.url ?? "", sources: input.url ? [{ type: "url", url: input.url }] : [] } });
      } else if (e.type === "user" && b.type === "tool_result" && web.has(String(b.tool_use_id))) {
        const call = web.get(String(b.tool_use_id))!;
        for (const u of new Set(textOf(b.content).match(URLS) ?? [])) if (!call.action.sources.some((s) => s.url === u)) call.action.sources.push({ type: "url", url: u });
      }
    }
  }

  let reply = "";
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  if (structured) {
    // Claude Code gives the structured answer on its result; it also calls it in as its StructuredOutput step.
    const step = events
      .filter((e) => e.type === "assistant")
      .flatMap((e) => ((e.message as { content?: Record<string, unknown>[] } | undefined)?.content ?? []))
      .findLast((b) => b.type === "tool_use" && b.name === "StructuredOutput")?.input;
    const out = result.structured_output ?? step ?? (() => {
      try {
        return JSON.parse(String(result.result ?? ""));
      } catch {
        return undefined;
      }
    })();
    if (withTools) {
      const o = (out ?? {}) as { reply?: unknown; tool_calls?: { name?: unknown; arguments?: unknown }[] };
      reply = typeof o.reply === "string" ? o.reply : out === undefined ? String(result.result ?? "") : "";
      for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) if (typeof c?.name === "string") calls.push({ name: c.name, args: c.arguments && typeof c.arguments === "object" ? (c.arguments as Record<string, unknown>) : {} });
    } else reply = out === undefined ? String(result.result ?? "") : JSON.stringify(out);
  } else reply = String(result.result ?? "");

  const id = `${CC_PREFIX}${randomBytes(12).toString("hex")}`;
  const output: unknown[] = [...web.values()];
  const assistant: BetaContentBlockParam[] = [];
  if (reply.trim()) {
    output.push({ type: "message", id: `msg_${randomBytes(12).toString("hex")}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] });
    assistant.push({ type: "text", text: reply });
  }
  for (const c of calls) {
    const callId = `toolu_cc${randomBytes(10).toString("hex")}`;
    output.push({ type: "function_call", id: `fc_${callId}`, call_id: callId, name: c.name, arguments: JSON.stringify(c.args), status: "completed" });
    assistant.push({ type: "tool_use", id: callId, name: c.name, input: c.args });
  }
  if (assistant.length) conversation.push({ role: "assistant", content: assistant });
  keep(id, conversation);

  const u = result.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const model = Object.keys(result.modelUsage ?? {})[0] ?? "claude-code";
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    output_text: reply,
    usage: { input_tokens: input, input_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 }, output_tokens: u.output_tokens ?? 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + (u.output_tokens ?? 0) },
  } as unknown as OpenAI.Responses.Response;
}
