// Tests for chat on Claude (lib/server/claude-responses.ts): OpenAI Responses calls run on Claude's Messages
// API and come back shaped as OpenAI Responses. Claude is a fake (a local server for /v1/messages that answers
// what each test queues and keeps what it was sent), so nothing reaches Anthropic and the key is made up.
// Checks: instructions, model choice (Opus 5.5 for chat with the server-side fallback, Haiku 5.5 for light
// work without one), effort, a tool call and its answer through previous_response_id (the conversation kept
// and appended to, thinking blocks untouched), web search with its sources and citations, JSON schema answers,
// tool_choice none, a function call with no answer kept as text, a refusal, pause_turn carried on, and
// BOPS_CHAT_PROVIDER=openai turning Claude off.
// Usage: node --conditions=react-server scripts/test-claude-chat.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const queue = [];
const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ path: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
    const next = queue.shift() ?? { content: [{ type: "text", text: "ok" }] };
    const reply = { id: `msg_${seen.length}`, type: "message", role: "assistant", model: seen.at(-1).body.model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 }, ...next };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const dir = mkdtempSync(join(tmpdir(), "claude-chat-"));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-made-up";
process.env.BOPS_CLAUDE_RESPONSES_DIR = dir;
delete process.env.BOPS_CHAT_PROVIDER;
const { chatClient, anthropicKey, claudeModelFor } = await import("../lib/server/claude-responses.ts");
const client = chatClient();
const last = () => seen.at(-1);

try {
  // 1. A plain question: instructions → system, the model and its fallback, effort.
  queue.push({ content: [{ type: "thinking", thinking: "", signature: "sig1" }, { type: "text", text: "Hello Arnold." }] });
  let r = await client.responses.create({ model: "gpt-6.1-sol", reasoning: { effort: "none" }, instructions: "You are Boppy.", input: [{ role: "user", content: "Hi" }] });
  assert.equal(r.output_text, "Hello Arnold.");
  assert.ok(r.id.startsWith("resp_claude_"));
  assert.match(last().path, /^\/v1\/messages/);
  assert.equal(last().body.model, "claude-opus-5-5", "chat runs on Claude Opus 5.5");
  assert.equal(last().body.system, "You are Boppy.");
  assert.equal(last().body.output_config.effort, "low", "OpenAI's effort none is Claude's low");
  assert.equal(last().body.fallbacks, "default");
  assert.match(String(last().headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.deepEqual(last().body.cache_control, { type: "ephemeral" });
  assert.equal(r.usage.input_tokens, 12);
  assert.equal(r.usage.input_tokens_details.cached_tokens, 2);

  // 2. A tool call, then its answer through previous_response_id.
  queue.push({ stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "sig2" }, { type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "invoices" } }] });
  const tools = [{ type: "function", name: "lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, strict: true }];
  r = await client.responses.create({ model: "gpt-6.1-sol", instructions: "x", input: [{ role: "user", content: "Any invoices?" }], tools });
  const call = r.output.find((o) => o.type === "function_call");
  assert.deepEqual([call.call_id, call.name, JSON.parse(call.arguments).q], ["toolu_1", "lookup", "invoices"]);
  assert.equal(last().body.tools[0].name, "lookup");
  assert.equal(last().body.tools[0].input_schema.type, "object");
  queue.push({ content: [{ type: "text", text: "You have 2 invoices." }] });
  r = await client.responses.create({ model: "gpt-6.1-sol", instructions: "x", previous_response_id: r.id, input: [{ type: "function_call_output", call_id: "toolu_1", output: "2 invoices" }], tools });
  assert.equal(r.output_text, "You have 2 invoices.");
  const msgs = last().body.messages;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[1].content[0].signature, "sig2", "the thinking block goes back unchanged");
  assert.equal(msgs[1].content[2].type, "tool_use");
  assert.deepEqual(msgs[2].content[0], { type: "tool_result", tool_use_id: "toolu_1", content: "2 invoices" });

  // 3. Web search: Claude's server tool, sources and citations as OpenAI's.
  queue.push({
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "orgo ai" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://orgo.ai", title: "Orgo", encrypted_content: "x", page_age: null }] },
      { type: "text", text: "Orgo makes cloud computers.", citations: [{ type: "web_search_result_location", url: "https://orgo.ai", title: "Orgo", cited_text: "c", encrypted_index: "e" }] },
    ],
  });
  r = await client.responses.create({ model: "gpt-6.1-sol", input: "What is Orgo?", tools: [{ type: "web_search", user_location: { type: "approximate", city: "Stockholm", country: "SE", timezone: "Europe/Stockholm" } }] });
  assert.equal(last().body.tools[0].type, "web_search_20260209");
  assert.equal(last().body.tools[0].user_location.city, "Stockholm");
  const ws = r.output.find((o) => o.type === "web_search_call");
  assert.deepEqual(ws.action.sources.map((s) => s.url), ["https://orgo.ai"]);
  const msg = r.output.find((o) => o.type === "message");
  assert.equal(msg.content[0].annotations[0].url, "https://orgo.ai");

  // 4. Light work with a JSON schema: Haiku 5.5, no fallback (Haiku has none).
  assert.equal(claudeModelFor("gpt-6-luna"), "claude-haiku-5-5");
  queue.push({ content: [{ type: "text", text: '{"ok":true}' }] });
  r = await client.responses.create({ model: "gpt-6-luna", store: false, input: "Is it fine?", text: { format: { type: "json_schema", name: "a", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } });
  assert.equal(last().body.model, "claude-haiku-5-5");
  assert.equal(last().body.fallbacks, undefined);
  assert.equal(last().body.output_config.format.type, "json_schema");
  assert.equal(JSON.parse(r.output_text).ok, true);

  // 5. tool_choice none; an earlier function call with no answer is kept as text, not sent as an orphan tool_use.
  queue.push({ content: [{ type: "text", text: "Done." }] });
  await client.responses.create({ model: "gpt-6.1-sol", tool_choice: "none", tools, input: [{ role: "user", content: "Do it" }, { type: "function_call", call_id: "call_x", name: "lookup", arguments: '{"q":"a"}' }, { role: "developer", content: "Answer now." }] });
  assert.deepEqual(last().body.tool_choice, { type: "none" });
  const m5 = last().body.messages;
  assert.equal(m5[1].content[0].type, "text");
  assert.match(m5[1].content[0].text, /Called lookup/);
  assert.match(m5[2].content[0].text, /^\[Instructions from the app\] Answer now\./);

  // 6. A refusal comes back as words, never an empty reply.
  queue.push({ stop_reason: "refusal", content: [] });
  r = await client.responses.create({ model: "gpt-6.1-sol", input: "something declined" });
  assert.ok(r.output_text.length > 0);
  assert.ok(r.output.some((o) => o.type === "message" && o.content[0].type === "refusal"));

  // 7. pause_turn: carried on with the same conversation, the reply joined.
  queue.push({ stop_reason: "pause_turn", content: [{ type: "text", text: "Searching… " }] });
  queue.push({ content: [{ type: "text", text: "found it." }] });
  const before = seen.length;
  r = await client.responses.create({ model: "gpt-6.1-sol", input: "long search" });
  assert.equal(seen.length - before, 2);
  assert.equal(r.output_text, "Searching… found it.");
  assert.equal(last().body.messages.at(-1).role, "assistant", "the paused reply goes back to carry on");

  // 8. An image the user sent goes to Claude as an image.
  queue.push({ content: [{ type: "text", text: "A cat." }] });
  await client.responses.create({ model: "gpt-6.1-sol", input: [{ role: "user", content: [{ type: "input_text", text: "What is it?" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] }] });
  assert.equal(last().body.messages[0].content[1].type, "image");
  assert.equal(last().body.messages[0].content[1].source.media_type, "image/png");

  // 9. BOPS_CHAT_PROVIDER=openai: no Claude.
  process.env.BOPS_CHAT_PROVIDER = "openai";
  assert.equal(await anthropicKey(), null);
  delete process.env.BOPS_CHAT_PROVIDER;
  assert.equal(await anthropicKey(), "sk-ant-test-made-up");

  // 10. A kept conversation that's gone says so instead of starting over silently.
  await assert.rejects(client.responses.create({ model: "gpt-6.1-sol", previous_response_id: "resp_claude_missing", input: "x" }), /no longer kept/);

  console.log("test-claude-chat: all passed.");
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
