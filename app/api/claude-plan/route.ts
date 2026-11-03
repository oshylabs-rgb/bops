import { spawn } from "node:child_process";
import { findClaude, forgetPlanStatus, planStatus } from "@/lib/server/claude-code-chat";
import { chatEngine } from "@/lib/server/claude-responses";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Chat on the user's Claude plan (lib/server/claude-code-chat.ts): whether Claude Code is installed and signed in,
 * which engine chat runs on, and, from the app's window only (ui-token.ts), installing Claude Code with
 * Anthropic's own installer or opening its sign in (`claude auth login`, which opens the browser).
 */
const NO_STORE = { "Cache-Control": "no-store" };
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "This can only be done in the Oshy Ops app." }, { status: 403, headers: NO_STORE }));

async function status(fresh = false) {
  const plan = await planStatus(fresh);
  const { engine } = await chatEngine();
  return { ...plan, engine };
}

export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  return Response.json(await status(new URL(request.url).searchParams.get("fresh") === "1"), { headers: NO_STORE });
}

/** Anthropic's installer for Claude Code (claude.ai/install), run hidden; resolves once it's done. */
function install(): Promise<{ ok: boolean; out: string }> {
  const win = process.platform === "win32";
  const [cmd, args] = win
    ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]]
    : ["/bin/bash", ["-lc", "curl -fsSL https://claude.ai/install.sh | bash"]];
  return new Promise((resolve) => {
    const p = spawn(cmd, args as string[], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 10 * 60_000);
    p.on("error", (e) => (clearTimeout(timer), resolve({ ok: false, out: e.message })));
    p.on("close", (code) => (clearTimeout(timer), resolve({ ok: code === 0, out: out.slice(-400) })));
  });
}

/** Claude Code's own sign in, in a window of its own: it opens the browser, the user signs in to their plan there. */
function openSignIn(bin: string): boolean {
  try {
    if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", "Claude sign in", bin, "auth", "login"], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("/usr/bin/osascript", ["-e", `tell application "Terminal" to do script "'${bin.replace(/["'\\]/g, "")}' auth login"`, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
    else return false;
    return true;
  } catch {
    return false;
  }
}

/** `action`: "install" Claude Code, "sign-in" (opens its sign in), or "check" (asks again now). */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const { action } = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (action === "install") {
    if (!findClaude()) {
      const r = await install();
      forgetPlanStatus();
      if (!r.ok || !findClaude()) return Response.json({ error: `Claude Code didn't install. ${r.out.trim().split("\n").pop() ?? ""}`.trim(), ...(await status(true)) }, { status: 502, headers: NO_STORE });
    }
    return Response.json(await status(true), { headers: NO_STORE });
  }
  if (action === "sign-in") {
    const bin = findClaude();
    if (!bin) return Response.json({ error: "Install Claude Code first." }, { status: 409, headers: NO_STORE });
    if (!openSignIn(bin)) return Response.json({ error: "Couldn't open the sign in window. Run `claude auth login` in a terminal instead." }, { status: 500, headers: NO_STORE });
    forgetPlanStatus();
    return Response.json(await status(), { headers: NO_STORE });
  }
  if (action === "check") return Response.json(await status(true), { headers: NO_STORE });
  return Response.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE });
}
