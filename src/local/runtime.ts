// Assembles the local runtime: database, file store, background tasks, AI, network guard,
// local-only routes, static SPA and the request firewall (Host/Origin checks).
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createApp, jsonBody, userOf } from "../server/app";
import type { AppEnv, HonoEnv } from "../server/env";
import { ApiError } from "../server/lib/errors";
import { backupDue, backupSummary, createBackup, listBackups, verifyBackup } from "./backup";
import { claudeCodeProvider, type ClaudeCodeProvider } from "./claude-code";
import { writeSettings, type LocalConfig } from "./config";
import type { LocalD1 } from "./d1-sqlite";
import { openDatabase, schemaVersion } from "./database";
import { localFileStore } from "./file-store";
import { createTaskRunner, type TaskRunner } from "./tasks";

export const DEFAULT_OWNER_EMAIL = "owner@career-atlas.example.test";

export interface LocalRuntime {
  cfg: LocalConfig;
  d1: LocalD1;
  env: AppEnv;
  runner: TaskRunner;
  claude: ClaudeCodeProvider;
  /** Full HTTP handler (firewall + API + static files). */
  fetch: (req: Request) => Promise<Response>;
  /** Hosts accepted in the Host header, e.g. 127.0.0.1:4310. */
  allowedHosts: Set<string>;
  close(): void;
}

/** The single local user: configured owner, else the only user in the database, else a placeholder identity. */
export function resolveOwnerEmail(d1: LocalD1, configured?: string): string {
  if (configured) return configured.toLowerCase();
  const users = d1.db.prepare("SELECT email FROM users ORDER BY created_at").all() as { email: string }[];
  if (users.length === 1) return users[0].email;
  if (users.length > 1) throw new Error(`The database has ${users.length} users. Set "owner_email" in config.json to choose the local owner.`);
  return DEFAULT_OWNER_EMAIL;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

// Frozen and always copied: the Node adapter may add headers (e.g. content-length) to the
// object it is given, which would otherwise leak into every later response.
const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

export function staticResponse(clientDir: string, pathname: string): Response {
  let rel = decodeURIComponent(pathname);
  if (rel.includes("\0")) return new Response("Bad request", { status: 400 });
  let file = resolve(clientDir, "." + rel);
  if (!file.startsWith(resolve(clientDir) + sep) && file !== resolve(clientDir)) return new Response("Not found", { status: 404 });
  const isAsset = rel.startsWith("/assets/");
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (isAsset || extname(rel)) return new Response("Not found", { status: 404, headers: { ...SECURITY_HEADERS } });
    file = join(clientDir, "index.html"); // SPA route
    rel = "/index.html";
  }
  if (!existsSync(file)) return new Response("Career Atlas is not built yet. Run: npm run build", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(readFileSync(file), {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // Local app: always revalidate. Long-lived caching gains nothing on localhost and would make
      // a bad response stick in the browser after an update.
      "cache-control": "no-cache",
    },
  });
}

export async function createLocalRuntime(cfg: LocalConfig, opts: { extraHosts?: string[]; serveStatic?: boolean } = {}): Promise<LocalRuntime> {
  // Open + migrate. An existing database is backed up (encrypted, verified) before any schema change.
  const { d1, migrated } = await openDatabase(cfg, {
    beforeMigrate: async (db, pending) => {
      const r = await createBackup(cfg, db, { reason: `pre-migration ${pending.map((p) => p.name).join(",")}` });
      console.log(`✓ Pre-migration backup verified: ${r.dir}`);
    },
  });
  if (migrated.length) console.log(`✓ Applied migrations: ${migrated.join(", ")}`);

  const claude = claudeCodeProvider({ path: cfg.settings.claude_path, model: cfg.settings.claude_model });
  const files = localFileStore(cfg.documentsDir);
  const env: AppEnv = {
    DB: d1.asD1(),
    FILES: files,
    APP_ENV: cfg.kind === "personal" ? "local" : cfg.kind === "dev" ? "development" : "test",
    AUTH_MODE: "local",
    LOCAL_USER_EMAIL: resolveOwnerEmail(d1, cfg.settings.owner_email),
    AI_PROVIDER: cfg.settings.ai_provider === "claude_code" ? "claude_code" : "none",
    AI_LOCAL: claude,
    AI_MODEL: cfg.settings.claude_model ?? "",
    MAX_UPLOAD_BYTES: String(10 * 1024 * 1024),
    MAINTENANCE_MODE: "off",
  };
  const runner = createTaskRunner(() => env);
  env.EXTRACTION_DISPATCH = (msg) => runner.dispatch(msg);

  const api = createApp((app) => registerLocalRoutes(app, { cfg, d1, env, claude, runner }));

  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, ...(opts.extraHosts ?? [])]);
  const clientDir = join(cfg.appRoot, "dist", "client");

  const outer = new Hono();
  // Firewall: only requests addressed to this machine's loopback name (blocks DNS rebinding),
  // and only same-origin browser requests (blocks other websites driving the local API).
  outer.use("*", async (c, next) => {
    const deny = (code: string, message: string) =>
      c.req.path.startsWith("/api/") ? c.json({ error: { code, message } }, 403) : c.text(message, 403);
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return deny("forbidden_host", "Forbidden host");
    const origin = c.req.header("origin");
    if (origin === "null" || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "").toLowerCase()))) return deny("csrf_rejected", "Cross-site request rejected");
    if (c.req.header("sec-fetch-site") === "cross-site" && c.req.path.startsWith("/api/")) return deny("csrf_rejected", "Cross-site request rejected");
    await next();
  });
  outer.all("/api/*", (c) => api.fetch(c.req.raw, env));
  outer.get("*", (c) => (opts.serveStatic === false ? c.text("Not found", 404) : staticResponse(clientDir, c.req.path)));

  void runner.recover().then((n) => n && console.log(`↻ Resumed ${n} interrupted extraction(s)`));

  return {
    cfg,
    d1,
    env,
    runner,
    claude,
    allowedHosts,
    fetch: async (req) => outer.fetch(req),
    close() {
      runner.stop();
      d1.close();
    },
  };
}

/** Starts the weekly backup schedule: runs when overdue (at launch and every hour while open). */
export function scheduleBackups(rt: LocalRuntime, log = console.log) {
  const tick = async () => {
    if (!backupDue(rt.cfg)) return;
    try {
      const r = await createBackup(rt.cfg, rt.d1, { reason: "weekly" });
      log(`✓ Weekly backup verified: ${r.dir}${r.pruned.length ? ` (pruned ${r.pruned.length} old)` : ""}`);
      if (r.keyCreated) log("! A new backup key was created. Save a copy in your password manager (see docs/LOCAL_FIRST.md).");
    } catch (e) {
      log(`✗ Weekly backup failed: ${(e as Error).message}`);
    }
  };
  const first = setTimeout(tick, 15_000);
  const every = setInterval(tick, 3600_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

function registerLocalRoutes(app: Hono<HonoEnv>, rt: { cfg: LocalConfig; d1: LocalD1; env: AppEnv; claude: ClaudeCodeProvider; runner: TaskRunner }) {
  const { cfg } = rt;
  app.get("/api/local/status", async (c) => {
    userOf(c);
    return c.json({
      instance: cfg.kind,
      data_dir: cfg.dataDir,
      database: cfg.dbPath,
      documents_dir: cfg.documentsDir,
      schema_version: schemaVersion(rt.d1),
      backup: backupSummary(cfg),
      tasks: rt.runner.stats(),
      ai: { provider: rt.env.AI_PROVIDER, claude: await rt.claude.status() },
    });
  });
  app.post("/api/local/backup", async (c) => {
    try {
      const r = await createBackup(cfg, rt.d1, { reason: "manual" });
      return c.json({ ok: true, name: r.dir.split(sep).pop(), key_created: r.keyCreated, pruned: r.pruned.length, rows: Object.values(r.manifest.table_counts).reduce((a, b) => a + b, 0) });
    } catch (e) {
      throw new ApiError(500, "backup_failed", (e as Error).message.replace(/\/Users\/[^/\s]+/g, "~"));
    }
  });
  app.post("/api/local/backup/verify", async (c) => {
    const body = await jsonBody(c, z.object({ name: z.string().max(200).optional() }));
    const list = listBackups(cfg);
    const target = body.name ? list.find((b) => b.name === body.name) : list[0];
    if (!target) throw new ApiError(404, "not_found", "No backup to verify");
    try {
      const r = verifyBackup(target.dir);
      return c.json({ ok: true, name: target.name, rows: Object.values(r.counts).reduce((a, b) => a + b, 0), documents: r.documents });
    } catch (e) {
      throw new ApiError(500, "verify_failed", (e as Error).message.slice(0, 200));
    }
  });
  app.post("/api/local/ai/check", async (c) => c.json(await rt.claude.status(true)));
  app.patch("/api/local/settings", async (c) => {
    const body = await jsonBody(c, z.object({ ai_provider: z.enum(["none", "claude_code"]).optional() }));
    if (body.ai_provider) {
      writeSettings(cfg, { ai_provider: body.ai_provider });
      rt.env.AI_PROVIDER = body.ai_provider;
    }
    return c.json({ ai_provider: rt.env.AI_PROVIDER });
  });
}
