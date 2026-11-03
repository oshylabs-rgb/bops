// Tests for chat on the user's Claude plan through Claude Code (lib/server/claude-code-chat.ts, and its pick in
// claude-responses.ts chatEngine). Claude Code is a stand-in program (BOPS_CLAUDE_BIN) that keeps what it was
// run with and answers what each test queues, so nothing reaches Anthropic and no account is used.
// Checks: the transcript and system prompt it's given (a file), Claude Code's own tools off unless web search is
// offered, no API key passed on (the plan pays), a saved token runs it bare, tool calls through structured
// output and their results on the next call, web reads marked as reading from outside with their addresses,
// JSON answers, a sign-in failure said plainly, and which engine answers (only in the app, by BOPS_CHAT_PLAN_AUTO).
// Usage: node --conditions=react-server scripts/test-claude-plan.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});

const work = mkdtempSync(join(tmpdir(), "claude-plan-"));
process.chdir(work);
const log = join(work, "runs.jsonl");
const queue = join(work, "queue.json");
const fake = join(work, "claude");
// The stand-in: `auth status --json` says what AUTH_STATUS holds; `-p` keeps its args, env, stdin and system
// prompt file, then prints the next queued list of stream-json events.
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write(process.env.FAKE_AUTH_STATUS || '{"loggedIn":false}'); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const at = args.indexOf("--system-prompt-file");
  const system = at >= 0 ? fs.readFileSync(args[at + 1], "utf8") : null;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, system, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null } }) + "\\n");
  const q = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, "utf8"));
  const events = q.shift() ?? [{ type: "result", subtype: "success", is_error: false, result: "ok" }];
  fs.writeFileSync(${JSON.stringify(queue)}, JSON.stringify(q));
  for (const e of events) process.stdout.write(JSON.stringify(e) + "\\n");
});
`,
);
chmodSync(fake, 0o755);
writeFileSync(queue, "[]");
const push = (...runs) => writeFileSync(queue, JSON.stringify([...JSON.parse(readFileSync(queue, "utf8")), ...runs]));
const runs = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const last = () => runs().at(-1);
const result = (extra) => ({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 5 }, modelUsage: { "claude-opus-5-5": {} }, ...extra });
const arg = (args, flag) => args[args.indexOf(flag) + 1];

process.env.BOPS_CLAUDE_BIN = fake;
process.env.BOPS_CLAUDE_RESPONSES_DIR = join(work, "kept");
process.env.ANTHROPIC_API_KEY = "sk-ant-api-key-of-the-server-made-up";
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.BOPS_CHAT_ENGINE;
delete process.env.BOPS_CHAT_PLAN_AUTO;

const CC = await import("../lib/server/claude-code-chat.ts");
const CR = await import("../lib/server/claude-responses.ts");
const tools = [{ type: "function", name: "lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${String(e.stack ?? e).split("\n").slice(0, 6).join("\n  ")}`);
  }
};

try {
  let first;
  await check("a turn with tools: the transcript on stdin, instructions and tools in the system prompt file, Claude Code's own tools off, the plan pays", async () => {
    push([{ type: "system", subtype: "init" }, result({ result: "", structured_output: { reply: "Let me look.", tool_calls: [{ name: "lookup", arguments: { q: "invoices" } }] } })]);
    first = await CC.claudeCodeCreate({ model: "gpt-6.1-sol", instructions: "You are Oshy.", input: [{ role: "user", content: "Any invoices?" }], tools });
    const r = last();
    assert.ok(r.args.includes("-p") && arg(r.args, "--output-format") === "stream-json");
    assert.equal(arg(r.args, "--model"), "claude-opus-5-5");
    assert.equal(arg(r.args, "--tools"), "", "Claude Code's own tools are off");
    assert.ok(r.args.includes("--strict-mcp-config") && r.args.includes("--no-session-persistence"));
    assert.ok(!r.args.includes("--bare"), "no saved token: Claude Code's own sign in");
    const schema = JSON.parse(arg(r.args, "--json-schema"));
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ["lookup"]);
    assert.match(r.system, /^You are Oshy\./);
    assert.match(r.system, /- lookup: Look something up\n  arguments \(JSON Schema\): \{"type":"object"/);
    assert.match(r.input, /^\[User\]\nAny invoices\?\n\n\[Now write your next turn\.\]$/);
    assert.equal(r.env.ANTHROPIC_API_KEY, null, "the server's API key never reaches Claude Code");
    assert.ok(first.id.startsWith("resp_cc_"));
    assert.equal(first.output_text, "Let me look.");
    const call = first.output.find((o) => o.type === "function_call");
    assert.equal(call.name, "lookup");
    assert.deepEqual(JSON.parse(call.arguments), { q: "invoices" });
    assert.match(call.call_id, /^toolu_cc[0-9a-f]+$/);
    assert.equal(first.usage.input_tokens, 35);
    assert.equal(first.model, "claude-opus-5-5");
  });

  await check("the next call carries the tool's result by its call, after what was said", async () => {
    const call = first.output.find((o) => o.type === "function_call");
    push([result({ result: "", structured_output: { reply: "You have 2 invoices.", tool_calls: [] } })]);
    const r2 = await CC.claudeCodeCreate({ model: "gpt-6.1-sol", instructions: "You are Oshy.", previous_response_id: first.id, input: [{ type: "function_call_output", call_id: call.call_id, output: "2 invoices" }], tools });
    assert.equal(r2.output_text, "You have 2 invoices.");
    assert.ok(!r2.output.some((o) => o.type === "function_call"));
    const t = last().input;
    assert.ok(t.indexOf("[User]\nAny invoices?") < t.indexOf("[You]\nLet me look."));
    assert.ok(t.includes(`[You called lookup (call ${call.call_id}) with {"q":"invoices"}]`));
    assert.ok(t.includes(`[Result of lookup (call ${call.call_id})]\n2 invoices`));
  });

  await check("web search offered: only Claude Code's web search and page reader, and what they read is marked as from outside", async () => {
    push([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "ws1", name: "WebSearch", input: { query: "orgo ai" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ws1", content: [{ type: "text", text: "Orgo https://orgo.ai and https://docs.orgo.ai/start" }] }] } },
      result({ result: "Orgo makes cloud computers." }),
    ]);
    const r = await CC.claudeCodeCreate({ model: "gpt-6.1-sol", input: "What is Orgo?", tools: [{ type: "web_search" }] });
    assert.equal(arg(last().args, "--tools"), "WebSearch,WebFetch");
    assert.ok(!last().args.includes("--json-schema"), "no tools of Bops' own: a plain answer");
    const ws = r.output.find((o) => o.type === "web_search_call");
    assert.equal(ws.action.query, "orgo ai");
    assert.deepEqual(ws.action.sources.map((s) => s.url), ["https://orgo.ai", "https://docs.orgo.ai/start"]);
    assert.equal(r.output_text, "Orgo makes cloud computers.");
  });

  await check("a JSON answer on light work: Haiku, the schema passed on, the JSON as the text", async () => {
    push([result({ result: "", structured_output: { ok: true } })]);
    const r = await CC.claudeCodeCreate({ model: "gpt-6-luna", input: "Is it fine?", text: { format: { type: "json_schema", name: "a", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
    assert.equal(arg(last().args, "--model"), "claude-haiku-5-5");
    assert.deepEqual(JSON.parse(arg(last().args, "--json-schema")).properties.ok, { type: "boolean" });
    assert.deepEqual(JSON.parse(r.output_text), { ok: true });
  });

  await check("a structured answer given only as Claude Code's StructuredOutput step still comes through", async () => {
    push([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "so1", name: "StructuredOutput", input: { reply: "From the step.", tool_calls: [] } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "so1", content: "Structured output provided successfully" }] } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      result({ result: "" }),
    ]);
    const r = await CC.claudeCodeCreate({ model: "gpt-6.1-sol", input: "hi", tools });
    assert.equal(r.output_text, "From the step.");
    assert.ok(!r.output.some((o) => o.type === "web_search_call"));
  });

  await check("tool_choice none: no tools offered, a plain answer", async () => {
    push([result({ result: "Done." })]);
    const r = await CC.claudeCodeCreate({ model: "gpt-6.1-sol", input: "Answer now", tools, tool_choice: "none" });
    assert.ok(!last().args.includes("--json-schema"));
    assert.ok(!/Your tools:/.test(last().system));
    assert.equal(r.output_text, "Done.");
  });

  await check("not signed in: said plainly, with where to sign in", async () => {
    push([result({ is_error: true, subtype: "error_during_execution", result: "Invalid API key · Please run /login" })]);
    await assert.rejects(CC.claudeCodeCreate({ model: "gpt-6.1-sol", input: "hi" }), /isn't signed in to your Claude plan.*Settings → AI plans/);
  });

  await check("a saved token: Claude Code runs bare, with the token", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-made-up-token-for-the-test";
    push([result({ result: "hi" })]);
    await CC.claudeCodeCreate({ model: "gpt-6.1-sol", input: "hi" });
    assert.ok(last().args.includes("--bare"));
    assert.equal(last().env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-made-up-token-for-the-test");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  await check("which engine: the plan only in the app and only signed in; else the API key; BOPS_CHAT_ENGINE decides when set", async () => {
    process.env.FAKE_AUTH_STATUS = '{"loggedIn":true,"subscriptionType":"max","email":"a@b.co"}';
    CC.forgetPlanStatus();
    assert.deepEqual(await CC.planStatus(true), { installed: true, signedIn: true, plan: "max", email: "a@b.co", via: "login" });
    assert.equal((await CR.chatEngine()).engine, "api", "outside the app, a signed in Claude Code isn't used on its own");
    process.env.BOPS_CHAT_PLAN_AUTO = "1";
    assert.equal((await CR.chatEngine()).engine, "plan");
    process.env.BOPS_CHAT_ENGINE = "api";
    assert.equal((await CR.chatEngine()).engine, "api");
    process.env.BOPS_CHAT_ENGINE = "openai";
    assert.equal((await CR.chatEngine()).engine, "openai");
    delete process.env.BOPS_CHAT_ENGINE;
    process.env.FAKE_AUTH_STATUS = '{"loggedIn":false}';
    CC.forgetPlanStatus();
    assert.equal((await CR.chatEngine()).engine, "api", "not signed in: the API key");
    delete process.env.BOPS_CHAT_PLAN_AUTO;
  });

  await check("the client: a conversation the plan started goes back to the plan", async () => {
    push([result({ result: "", structured_output: { reply: "Again.", tool_calls: [] } })]);
    const r = await CR.chatClient().responses.create({ model: "gpt-6.1-sol", previous_response_id: first.id, input: [{ role: "user", content: "and?" }], tools });
    assert.equal(r.output_text, "Again.");
    assert.ok(r.id.startsWith("resp_cc_"));
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `claude plan: ${failed} failed` : "claude plan: all passed");
process.exit(failed ? 1 : 0);
