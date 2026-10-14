// Optional AI extraction through the owner's local Claude Code installation (`claude -p`).
//
// Safety and cost rules (see docs/LOCAL_FIRST.md › AI):
//   - Runs ONLY when the CLI reports subscription auth (authMethod "claude.ai"). API-key, token,
//     helper and cloud-provider auth are refused, so this can never start per-token API billing.
//   - The child gets an allow-listed environment: ANTHROPIC_* / CLAUDE_CODE_USE_* / proxy variables
//     from the server's environment never reach it.
//   - No tools at all (--tools ""), no MCP servers, no hooks/plugins/skills/CLAUDE.md (--safe-mode),
//     no slash commands, no session persistence, run in an empty temporary directory.
//   - Input is ONLY the posting text being extracted (inside delimiters); output must match the
//     JSON schema and is re-validated by ai/extract-job.ts (verbatim evidence checks).
//   - It is only used when the user explicitly asks for AI on an extraction.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AiError, type AiProvider } from "../server/ai/provider";

const TIMEOUT_MS = 180_000;
const AUTH_TTL_MS = 5 * 60_000;

/** Environment variables passed to the CLI. Everything else (API keys, tokens, provider switches) is dropped. */
const ENV_ALLOW = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "TERM"];

export function claudeEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ENV_ALLOW) if (source[k]) env[k] = source[k]!;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/** Finds the `claude` executable: configured path, PATH, standard installs, then the copy bundled with the Claude desktop app. */
export function findClaude(configured?: string): string | null {
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, "claude"));
  candidates.push(join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  const bundled = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (existsSync(bundled)) {
    const found: { p: string; t: number }[] = [];
    for (const ver of readdirSync(bundled)) {
      const vdir = join(bundled, ver);
      if (!statSync(vdir).isDirectory()) continue;
      for (const build of readdirSync(vdir)) {
        const p = join(vdir, build, "claude.app", "Contents", "MacOS", "claude");
        if (existsSync(p)) found.push({ p, t: statSync(p).mtimeMs });
      }
    }
    candidates.push(...found.sort((a, b) => b.t - a.t).map((f) => f.p));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: claudeEnv() as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    // The CLI may exit before reading stdin (e.g. --version, auth errors); never let EPIPE crash the server.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

export interface ClaudeStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  logged_in: boolean;
  auth_method: string | null;
  /** True only for subscription auth: the only mode Career Atlas will use. */
  subscription: boolean;
  reason?: string;
}

export function claudeCodeProvider(opts: { path?: string; model?: string } = {}) {
  let cached: { at: number; status: ClaudeStatus } | null = null;
  let busy: Promise<unknown> = Promise.resolve();

  async function status(force = false): Promise<ClaudeStatus> {
    if (!force && cached && Date.now() - cached.at < AUTH_TTL_MS) return cached.status;
    const bin = findClaude(opts.path);
    let s: ClaudeStatus;
    if (!bin) {
      s = { available: false, path: null, version: null, logged_in: false, auth_method: null, subscription: false, reason: "claude_not_found" };
    } else {
      const work = mkdtempSync(join(tmpdir(), "career-atlas-claude-"));
      try {
        const v = await run(bin, ["--version"], "", work, 20_000);
        const a = await run(bin, ["auth", "status"], "", work, 20_000);
        let info: { loggedIn?: boolean; authMethod?: string } = {};
        try {
          info = JSON.parse(a.stdout);
        } catch {
          /* not JSON → treated as logged out */
        }
        const method = info.authMethod ?? null;
        const subscription = !!info.loggedIn && method === "claude.ai";
        s = {
          available: v.code === 0,
          path: bin,
          version: v.stdout.trim().split(" ")[0] || null,
          logged_in: !!info.loggedIn,
          auth_method: method,
          subscription,
          reason: subscription ? undefined : info.loggedIn ? "not_subscription_auth" : "not_logged_in",
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    cached = { at: Date.now(), status: s };
    return s;
  }

  const provider: AiProvider & { status: typeof status } = {
    name: "claude_code",
    model: opts.model || "default",
    status,
    async completeJson(req) {
      const st = await status();
      if (!st.path || !st.subscription) {
        throw new AiError("ai_not_configured", st.reason === "not_subscription_auth" ? "Claude Code is not using subscription sign-in; refusing to avoid API charges" : "Claude Code is not signed in");
      }
      // One call at a time keeps usage predictable.
      const job = busy.then(async () => {
        const work = mkdtempSync(join(tmpdir(), "career-atlas-claude-"));
        try {
          const args = [
            "-p",
            "--safe-mode",
            "--tools",
            "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--json-schema",
            JSON.stringify(req.jsonSchema),
            "--max-turns",
            "3",
            "--system-prompt",
            req.system,
            ...(opts.model ? ["--model", opts.model] : []),
          ];
          const r = await run(st.path!, args, req.user, work, TIMEOUT_MS);
          if (r.timedOut) throw new AiError("ai_failed", "Claude Code timed out");
          let out: { is_error?: boolean; subtype?: string; structured_output?: unknown; result?: unknown };
          try {
            out = JSON.parse(r.stdout);
          } catch {
            throw new AiError("ai_failed", `Claude Code exited with code ${r.code}`);
          }
          if (out.is_error || r.code !== 0) {
            cached = null; // re-check auth next time (e.g. signed out, limit reached)
            throw new AiError("ai_failed", `Claude Code returned an error (${String(out.subtype ?? r.code).slice(0, 40)})`);
          }
          if (out.structured_output === undefined || out.structured_output === null) throw new AiError("ai_invalid_output", "Claude Code returned no structured output");
          return out.structured_output;
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
      busy = job.catch(() => undefined);
      return job;
    },
  };
  return provider;
}

export type ClaudeCodeProvider = ReturnType<typeof claudeCodeProvider>;
