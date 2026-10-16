// Optional decisions through the local Codex CLI (`codex exec`).
//
// Used only for unfamiliar application pages, and only with ChatGPT subscription sign-in.
// API-key auth is refused so this cannot start per-token billing. The child receives HOME
// (so it can read the existing Codex login) and no API-key environment variables.
// Callers must not put profile values, resumes or passwords in the prompt.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, type AiProvider } from "../server/ai/provider";

const TIMEOUT_MS = 90_000;

/** Codex features that would let the model act on its own; all off for Career Atlas's calls. */
const NO_TOOLS = ["shell_tool", "unified_exec", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "apps", "image_generation", "js_repl"].flatMap((f) => ["-c", `features.${f}=false`]).concat(["-c", 'web_search="disabled"']);
const AUTH_TTL_MS = 5 * 60_000;

/** `codex exec` arguments: ephemeral, read-only sandbox, no user config, no tools, structured output only. */
export function execArgs(schemaFile: string, outFile: string, prompt: string): string[] {
  return ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "read-only", ...NO_TOOLS, "--color", "never", "--output-schema", schemaFile, "--output-last-message", outFile, prompt];
}

/** Running totals of model use (calls, tokens reported by Codex, wall time) — read as deltas per attempt. */
export const codexUsage = { calls: 0, tokens: 0, ms: 0 };

export interface CodexStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  logged_in: boolean;
  /** True only for ChatGPT sign-in. API-key login is refused. */
  chatgpt: boolean;
  reason?: string;
}

function codexEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" };
  for (const k of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "TERM"]) if (source[k]) env[k] = source[k]!;
  return env;
}

export function findCodex(): string | null {
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "codex")),
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: codexEnv() as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new AiError("ai_invalid_output", "Codex did not return JSON");
    return JSON.parse(m[0]);
  }
}

export function codexProvider() {
  let cached: { at: number; status: CodexStatus } | null = null;
  let busy: Promise<unknown> = Promise.resolve();

  async function status(force = false): Promise<CodexStatus> {
    if (!force && cached && Date.now() - cached.at < AUTH_TTL_MS) return cached.status;
    const bin = findCodex();
    let s: CodexStatus;
    if (!bin) {
      s = { available: false, path: null, version: null, logged_in: false, chatgpt: false, reason: "codex_not_found" };
    } else {
      const work = mkdtempSync(join(tmpdir(), "career-atlas-codex-"));
      try {
        const v = await run(bin, ["--version"], work, 20_000);
        const a = await run(bin, ["login", "status"], work, 20_000);
        const text = `${a.stdout}\n${a.stderr}`;
        const chatgpt = /logged in using chatgpt/i.test(text);
        const apiKey = /api key/i.test(text) && !chatgpt;
        s = {
          available: v.code === 0,
          path: bin,
          version: v.stdout.trim().split("\n").pop()?.trim() || null,
          logged_in: chatgpt || /logged in/i.test(text),
          chatgpt,
          reason: chatgpt ? undefined : apiKey ? "api_key_refused" : "not_logged_in",
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    cached = { at: Date.now(), status: s };
    return s;
  }

  async function ready(): Promise<AiProvider | null> {
    const st = await status();
    return st.chatgpt ? provider : null;
  }

  const provider: AiProvider = {
    name: "codex",
    model: "chatgpt",
    async completeJson(req) {
      const st = await status();
      if (!st.path || !st.chatgpt) {
        throw new AiError("ai_not_configured", st.reason === "api_key_refused" ? "Codex is signed in with an API key; refusing to avoid separate billing" : "Codex is not signed in with ChatGPT");
      }
      const job = busy.then(async () => {
        const work = mkdtempSync(join(tmpdir(), "career-atlas-codex-"));
        try {
          const schema = join(work, "schema.json");
          const out = join(work, "last.txt");
          writeFileSync(schema, JSON.stringify(req.jsonSchema), { mode: 0o600 });
          const prompt = `${req.system}\n\n${req.user}\n\nReply with JSON matching the schema. Do not use tools.`;
          const t0 = Date.now();
          const result = await run(
            st.path!,
            // No tools for the model: shell, code execution, browsing, apps and web search are switched off,
            // and the sandbox stays read-only. Career Atlas executes anything that happens in a browser.
            execArgs(schema, out, prompt),
            work,
            TIMEOUT_MS,
          );
          // Usage: Codex prints "tokens used\n12,345" on stderr (includes its own instructions).
          const used = /tokens used\s*\n?\s*([\d,]+)/i.exec(`${result.stderr}\n${result.stdout}`);
          codexUsage.calls += 1;
          codexUsage.tokens += used ? Number(used[1].replace(/,/g, "")) : 0;
          codexUsage.ms += Date.now() - t0;
          const body = existsSync(out) ? readFileSync(out, "utf8") : result.stdout;
          if (!body.trim()) throw new AiError("ai_failed", "Codex returned no message");
          return parseJson(body);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
      busy = job.then(() => undefined, () => undefined);
      return job;
    },
  };

  return { status, ready, provider };
}
