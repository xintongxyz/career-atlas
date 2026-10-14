// Local-runtime safety tests. Synthetic data only, every test in its own temporary directory.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDue, createBackup, listBackups, pruneBackups, restoreInto, verifyBackup } from "../../src/local/backup";
import { claudeCodeProvider, claudeEnv } from "../../src/local/claude-code";
import { findAppRoot, loadConfig, personalDataDir, writeSettings, type LocalConfig } from "../../src/local/config";
import { loadKey } from "../../src/local/crypto";
import { LocalD1 } from "../../src/local/d1-sqlite";
import { openDatabase, readMigrations } from "../../src/local/database";
import { publicOnlyLookup } from "../../src/server/extraction/net";
import { createLocalRuntime, staticResponse, type LocalRuntime } from "../../src/local/runtime";
import type { AiProvider } from "../../src/server/ai/provider";

let work: string;
let cfg: LocalConfig;
const open: LocalRuntime[] = [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "career-atlas-local-test-"));
  process.env.CA_BACKUP_DIR = join(work, "backups");
  process.env.CA_BACKUP_KEY_FILE = join(work, "keys", "backup.key");
  cfg = loadConfig({ kind: "test", dataDir: join(work, "data"), port: 4999 });
});
afterEach(() => {
  for (const rt of open.splice(0)) rt.close();
  rmSync(work, { recursive: true, force: true });
});

async function start(c = cfg) {
  const rt = await createLocalRuntime(c, { serveStatic: false });
  open.push(rt);
  return rt;
}
const req = (rt: LocalRuntime, path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:4999");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", "http://127.0.0.1:4999");
  return rt.fetch(new Request(`http://127.0.0.1:4999${path}`, { ...init, headers, body }));
};
const createJob = async (rt: LocalRuntime, title = "Data Analyst") =>
  (await (await req(rt, "/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics", title } } })).json()) as { id: string; job_posting_id: string };

describe("D1 adapter over node:sqlite", () => {
  it("batch() is atomic: a failing statement rolls back the whole batch", async () => {
    const d1 = new LocalD1(":memory:");
    await d1.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
    await expect(d1.batch([d1.prepare("INSERT INTO t VALUES (?, ?)").bind("a", 1), d1.prepare("INSERT INTO t VALUES (?, ?)").bind("a", 2)])).rejects.toThrow();
    expect((await d1.prepare("SELECT COUNT(*) AS n FROM t").first<{ n: number }>())!.n).toBe(0);
    d1.close();
  });
  it("raw() keeps duplicate column names, booleans bind as 1/0, undefined is rejected", async () => {
    const d1 = new LocalD1(":memory:");
    expect(await d1.prepare("SELECT 1 AS x, 2 AS x").raw()).toEqual([[1, 2]]);
    expect(await d1.prepare("SELECT ? AS b").bind(true).first("b")).toBe(1);
    expect(() => d1.prepare("SELECT ?").bind(undefined)).toThrow(/undefined/);
    d1.close();
  });
});

describe("database safety", () => {
  it("persists across restarts with the same IDs", async () => {
    let rt = await start();
    const job = await createJob(rt);
    rt.close();
    open.length = 0;
    rt = await start(loadConfig({ kind: "test", dataDir: cfg.dataDir, port: 4999 }));
    const res = await req(rt, `/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { posting: { title: string } }).posting.title).toBe("Data Analyst");
  });

  it("dev, demo and test instances can never use the personal data folder", () => {
    for (const kind of ["dev", "test"] as const) {
      expect(() => loadConfig({ kind, dataDir: personalDataDir() })).toThrow(/Refusing to use the personal data folder/);
      expect(() => loadConfig({ kind, dataDir: join(personalDataDir(), "sub") })).toThrow(/Refusing/);
    }
    expect(() => loadConfig({ kind: "personal", dataDir: join(findAppRoot(), "data") })).toThrow(/inside the source directory/);
  });

  it("never silently recreates a database that existed before", async () => {
    const rt = await start();
    await createJob(rt);
    rt.close();
    open.length = 0;
    for (const f of readdirSync(cfg.dataDir)) if (f.includes(".sqlite")) rmSync(join(cfg.dataDir, f));
    await expect(start(loadConfig({ kind: "test", dataDir: cfg.dataDir, port: 4999 }))).rejects.toThrow(/missing.*Refusing to create an empty replacement/s);
  });

  it("refuses modified migration history and newer databases", async () => {
    const root = join(work, "app");
    mkdirSync(root);
    cpSync(join(findAppRoot(), "migrations"), join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "migrations", "0000_init.sql"), readFileSync(join(root, "migrations", "0000_init.sql"), "utf8") + "\n-- edited\n");
    expect(() => readMigrations(root)).toThrow(/differs from migrations\/LOCK.json/);

    const rt = await start();
    rt.d1.db.prepare("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')").run();
    rt.close();
    open.length = 0;
    await expect(openDatabase(loadConfig({ kind: "test", dataDir: cfg.dataDir, port: 4999 }))).rejects.toThrow(/newer Career Atlas/);
  });

  it("backs up an existing database before applying pending migrations", async () => {
    // Build a database at the first migration only, with data, then open it with the full set.
    const first = readMigrations(cfg.appRoot)[0];
    const d1 = new LocalD1(cfg.dbPath);
    d1.db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    d1.db.exec(first.sql);
    d1.db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(first.name);
    d1.db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'someone@example.test', 1)").run();
    d1.close();
    writeSettings(cfg, { db_created_at: "2026-01-01" });
    const rt = await start();
    expect(listBackups(cfg)[0]?.manifest.reason).toMatch(/^pre-migration/);
    expect(listBackups(cfg)[0]?.manifest.schema_version).toBe(first.name);
    expect(rt.d1.db.prepare("SELECT email FROM users").get()).toEqual({ email: "someone@example.test" });
  });
});

describe("background extraction", () => {
  it("resumes extractions interrupted by a restart", async () => {
    let rt = await start();
    const job = await createJob(rt);
    const now = Date.now();
    rt.d1.db.exec(`UPDATE job_postings SET description_text = 'Senior Data Engineer. Location: Toronto, ON. Hybrid, 2 days per week in office. Salary CAD $120,000 - $140,000 per year.' WHERE id = '${job.job_posting_id}'`);
    rt.d1.db.prepare("INSERT INTO job_extraction_jobs (id, user_id, job_posting_id, input_type, status, attempts, created_at, updated_at) SELECT 'ex-1', user_id, id, 'text', 'fetching', 1, ?, ? FROM job_postings WHERE id = ?").run(now, now, job.job_posting_id);
    rt.close();
    open.length = 0;
    rt = await start(loadConfig({ kind: "test", dataDir: cfg.dataDir, port: 4999 }));
    await new Promise((r) => setTimeout(r, 50));
    await rt.runner.idle();
    const ex = rt.d1.db.prepare("SELECT status, attempts FROM job_extraction_jobs WHERE id = 'ex-1'").get() as { status: string; attempts: number };
    expect(["succeeded", "partial", "needs_review"]).toContain(ex.status);
    expect(ex.attempts).toBe(2);
  });

  it("only sends a posting to the AI provider when the user asked for AI", async () => {
    const rt = await start();
    const calls: string[] = [];
    const fake: AiProvider = { name: "claude_code", model: "fake", async completeJson(r) { calls.push(r.user); return {}; } };
    rt.env.AI_PROVIDER = "claude_code";
    rt.env.AI_LOCAL = fake;
    // ≥ 200 characters: the pipeline only calls AI for postings with enough text.
    const text = "Product Designer at Contoso (fictional). Remote within Canada. Full-time. Salary CAD $90,000 per year. You will design onboarding flows, run usability studies, partner with engineering and maintain our design system components.";
    await req(rt, "/api/jobs/capture", { method: "POST", json: { text } });
    await rt.runner.idle();
    expect(calls).toHaveLength(0);
    await req(rt, "/api/jobs/capture", { method: "POST", json: { text: text + " Second.", use_ai: true, confirm_duplicate: true } });
    await rt.runner.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("<job_posting>");
  });
});

describe("request firewall", () => {
  it("rejects foreign Host headers (DNS rebinding) and foreign or null origins", async () => {
    const rt = await start();
    const h = (headers: Record<string, string>, method = "GET") => rt.fetch(new Request("http://127.0.0.1:4999/api/me", { method, headers, body: method === "GET" ? undefined : "{}" }));
    expect((await h({ host: "attacker.example.com:4999" })).status).toBe(403);
    expect((await h({ host: "127.0.0.1:4999" })).status).toBe(200);
    expect((await h({ host: "127.0.0.1:4999", origin: "null", "content-type": "application/json" }, "PATCH")).status).toBe(403);
    expect((await h({ host: "127.0.0.1:4999", origin: "http://localhost:5555", "content-type": "application/json" }, "PATCH")).status).toBe(403);
    expect((await h({ host: "127.0.0.1:4999", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
  it("network guard refuses names that resolve to private addresses", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => publicOnlyLookup("localhost", {}, (e) => r(e)));
    expect(err?.code).toBe("EBLOCKED");
  });
});

describe("static files", () => {
  it("serves complete files after a 404 (headers are never shared between responses)", async () => {
    const dir = join(work, "client");
    mkdirSync(join(dir, "assets"), { recursive: true });
    const body = "export const x = 1;\n".repeat(500);
    writeFileSync(join(dir, "assets", "a.js"), body);
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
    // Through the real Node HTTP adapter, where the shared-headers bug appeared.
    const server = serve({ fetch: (r) => staticResponse(dir, new URL(r.url).pathname), hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/assets/missing.js`)).status).toBe(404);
      const res = await fetch(`http://127.0.0.1:${port}/assets/a.js`);
      expect((await res.text()).length).toBe(body.length);
    } finally {
      server.close();
    }
    expect(await staticResponse(dir, "/jobs/123").text()).toContain("<title>t</title>");
    expect(staticResponse(dir, "/../package.json").status).toBe(404);
  });
});

describe("encrypted backups", () => {
  it("creates, verifies and restores a backup including documents; detects tampering", async () => {
    const rt = await start();
    await createJob(rt);
    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode("%PDF-1.4 synthetic")], "cv.pdf", { type: "application/pdf" }));
    form.set("kind", "resume");
    form.set("version_name", "v1");
    expect((await req(rt, "/api/documents", { method: "POST", body: form })).status).toBe(201);

    const b = await createBackup(cfg, rt.d1);
    expect(b.manifest.verified).toBe(true);
    expect(b.manifest.documents).toHaveLength(1);
    expect(existsSync(`${b.dir}.partial`)).toBe(false);
    expect(readFileSync(join(b.dir, "db.sqlite.enc")).subarray(0, 5).toString()).toBe("CABK1");
    // Plaintext never lands in the backup folder.
    expect(readFileSync(join(b.dir, "db.sqlite.enc")).includes(Buffer.from("Northwind Analytics"))).toBe(false);

    const out = join(work, "restored");
    mkdirSync(out);
    const r = restoreInto(b.dir, { dbPath: join(out, "r.sqlite"), documentsDir: join(out, "docs") }, loadKey().key);
    expect(r.counts.saved_jobs).toBe(1);
    expect(r.documents).toBe(1);
    expect(() => restoreInto(b.dir, { dbPath: join(out, "r.sqlite") }, loadKey().key)).toThrow(/Refusing to restore over an existing file/);

    const enc = readFileSync(join(b.dir, "db.sqlite.enc"));
    enc[enc.length - 1] ^= 0xff;
    writeFileSync(join(b.dir, "db.sqlite.enc"), enc);
    expect(() => verifyBackup(b.dir)).toThrow();
  });

  it("retention keeps the newest verified backups, never fewer than 4, and ignores failed runs", async () => {
    const rt = await start();
    for (let i = 0; i < 6; i++) await createBackup(cfg, rt.d1);
    mkdirSync(join(cfg.backupDir, "test-2000-01-01T00-00-00-000Z.failed"));
    expect(pruneBackups(cfg, 2)).toHaveLength(2); // clamped to 4
    expect(listBackups(cfg)).toHaveLength(4);
    expect(existsSync(join(cfg.backupDir, "test-2000-01-01T00-00-00-000Z.failed"))).toBe(true);
    expect(backupDue(cfg)).toBe(false);
    expect(backupDue(cfg, Date.now() + 8 * 86_400_000)).toBe(true);
  });
});

describe("Claude Code adapter (fake CLI, no real calls)", () => {
  function fakeClaude(authMethod: string) {
    const bin = join(work, "claude");
    const log = join(work, "claude-calls.log");
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn": true, "authMethod": "${authMethod}"}'; exit 0; fi
echo "ARGS: $*" >> "${log}"
env | grep -E '^(ANTHROPIC|CLAUDE_CODE_USE|HTTPS?_PROXY)' >> "${log}"
cat > /dev/null
echo '{"type":"result","is_error":false,"structured_output":{"title":{"value":"Data Analyst","evidence":"Data Analyst","confidence":"high"}}}'
`,
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }
  const req = { system: "s", user: "<job_posting>Data Analyst</job_posting>", jsonSchema: { type: "object" } };

  it("refuses API-key / non-subscription auth without running a prompt", async () => {
    const { bin, log } = fakeClaude("api_key");
    const p = claudeCodeProvider({ path: bin });
    await expect(p.completeJson(req)).rejects.toThrow(/subscription/);
    expect(existsSync(log)).toBe(false);
  });

  it("runs with no tools, safe mode, schema output and a scrubbed environment", async () => {
    const { bin, log } = fakeClaude("claude.ai");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    try {
      const out = await claudeCodeProvider({ path: bin }).completeJson(req);
      expect(out).toMatchObject({ title: { value: "Data Analyst" } });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/ARGS: -p --safe-mode --tools {2}--strict-mcp-config --disable-slash-commands --permission-mode dontAsk --no-session-persistence --output-format json --json-schema/);
    expect(calls).not.toMatch(/ANTHROPIC|CLAUDE_CODE_USE/);
    expect(Object.keys(claudeEnv({ ANTHROPIC_API_KEY: "x", HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1" }))).not.toContain("ANTHROPIC_API_KEY");
  });
});
