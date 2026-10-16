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
import { codexProvider } from "./codex";
import { chooseFromFacts, reasonClick } from "./apply/codex-agent";
import { writeSettings, type LocalConfig } from "./config";
import type { LocalD1 } from "./d1-sqlite";
import { openDatabase, schemaVersion } from "./database";
import { localFileStore } from "./file-store";
import { createTaskRunner, type TaskRunner } from "./tasks";
import { createApplyRunner, type ApplyRunner } from "./apply/runner";
import { accountManager, keychainStore, memoryStore, passwordProblems, tenantOf } from "./apply/credentials";
import { mailVerifier } from "./apply/mail";
import { aiOptionMatcher } from "./apply/ai-assist";
import { accountSettingsSchema, existingAccountSchema, mailSettingsSchema, sharedPasswordSchema } from "@shared/apply";
import { profileSchema } from "@shared/profile";
import { spawn } from "node:child_process";
import { getDb } from "../server/db/client";
import { getProfileRow } from "../server/services/profile";

export const DEFAULT_OWNER_EMAIL = "owner@career-atlas.example.test";

export interface LocalRuntime {
  cfg: LocalConfig;
  d1: LocalD1;
  env: AppEnv;
  runner: TaskRunner;
  apply: ApplyRunner;
  claude: ClaudeCodeProvider;
  codex: ReturnType<typeof codexProvider>;
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

export async function createLocalRuntime(cfg: LocalConfig, opts: { extraHosts?: string[]; serveStatic?: boolean; apply?: Partial<Parameters<typeof createApplyRunner>[0]> } = {}): Promise<LocalRuntime> {
  // Open + migrate. An existing database is backed up (encrypted, verified) before any schema change.
  const { d1, migrated } = await openDatabase(cfg, {
    beforeMigrate: async (db, pending) => {
      const r = await createBackup(cfg, db, { reason: `pre-migration ${pending.map((p) => p.name).join(",")}` });
      console.log(`✓ Pre-migration backup verified: ${r.dir}`);
    },
  });
  if (migrated.length) console.log(`✓ Applied migrations: ${migrated.join(", ")}`);

  const claude = claudeCodeProvider({ path: cfg.settings.claude_path, model: cfg.settings.claude_model });
  const codex = codexProvider();
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
  // Application automation: own browser profile and screenshots under <data>/automation (owner-only).
  // Only test/dev instances may target synthetic forms on 127.0.0.1.
  // Workday account passwords: macOS Keychain on the personal instance; memory for test/dev instances.
  const secrets = cfg.kind === "personal" ? keychainStore() : memoryStore();
  const accounts = accountManager({
    store: secrets,
    dir: join(cfg.dataDir, "automation"),
    settings: () => ({ mode: cfg.settings.workday_password_mode === "shared" ? "shared" : "unique", autoSignIn: cfg.settings.workday_auto_sign_in !== false }),
  });
  // Gmail verification e-mails: opt-in; the app password shares the same secure store.
  const mail = mailVerifier({ store: secrets, settings: () => ({ enabled: cfg.settings.gmail_verification === true, address: cfg.settings.gmail_address ?? null }) });
  const apply = createApplyRunner({ getEnv: () => env, automationDir: join(cfg.dataDir, "automation"), allowLoopback: cfg.kind !== "personal", accounts, mail, aiAssist: () => (cfg.settings.apply_ai_assist === true && env.AI_PROVIDER === "claude_code" ? aiOptionMatcher(env) : null),   pageAgent: async (obs) => {
    if (!obs.buttons.length) return null;
    const provider = await codex.ready();
    return provider ? reasonClick(provider, obs) : null;
  }, chooseOption: async (label, options, facts) => {
    const provider = await codex.ready();
    return provider ? chooseFromFacts(provider, label, options, facts) : null;
  }, browserAgent: async () => {
    // The owner's ChatGPT sign-in through the local Codex CLI, with every Codex tool switched off:
    // the model only proposes; Career Atlas validates and executes (src/local/apply/browser-agent.ts).
    const provider = await codex.ready();
    return provider ? async (system, user, schema) => (await provider.completeJson({ system, user, jsonSchema: schema })) as Record<string, unknown> : null;
  }, answerWriter: async () => {
    // The same signed-in provider, tools off. Used only when the owner turned on "AI answer writing".
    const provider = await codex.ready();
    return provider ? async (system, user, schema) => (await provider.completeJson({ system, user, jsonSchema: schema })) as Record<string, unknown> : null;
  }, ...opts.apply });
  await apply.init();
  env.APPLY = apply;

  const api = createApp((app) => registerLocalRoutes(app, { cfg, d1, env, claude, codex, runner, apply }));

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
  void apply.recover().then((r) => {
    if (r.requeued) console.log(`↻ Resumed ${r.requeued} application attempt(s)`);
    if (r.unconfirmed) console.log(`! ${r.unconfirmed} application attempt(s) were interrupted while submitting — marked "Unconfirmed" (never re-submitted automatically)`);
  }, () => {
    /* runtime closed before recovery finished; it runs again at the next start */
  });

  return {
    cfg,
    d1,
    env,
    runner,
    apply,
    claude,
    codex,
    allowedHosts,
    fetch: async (req) => outer.fetch(req),
    close() {
      runner.stop();
      apply.stop();
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

function registerLocalRoutes(app: Hono<HonoEnv>, rt: { cfg: LocalConfig; d1: LocalD1; env: AppEnv; claude: ClaudeCodeProvider; codex: ReturnType<typeof codexProvider>; runner: TaskRunner; apply: ApplyRunner }) {
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
      ai: { provider: rt.env.AI_PROVIDER, claude: await rt.claude.status(), codex: await rt.codex.status() },
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

  // ---------- Workday candidate accounts (passwords stay in the Keychain; never returned) ----------
  const accounts = rt.apply.accounts;
  const accountView = async () => ({
    available: accounts.available,
    store: accounts.storeKind,
    password_mode: accounts.settings().mode,
    auto_sign_in: accounts.settings().autoSignIn,
    ai_assist: cfg.settings.apply_ai_assist === true,
    ai_available: rt.env.AI_PROVIDER === "claude_code",
    shared_configured: await accounts.sharedConfigured(),
    accounts: accounts.list().map((a) => ({ tenant: a.tenant, email: a.email, mode: a.mode, status: a.status, created_at: a.created_at, last_sign_in_at: a.last_sign_in_at ?? null, last_failure_at: a.last_failure_at ?? null })),
  });
  app.get("/api/local/accounts", async (c) => c.json(await accountView()));
  app.patch("/api/local/accounts", async (c) => {
    const body = await jsonBody(c, accountSettingsSchema);
    if (body.password_mode) writeSettings(cfg, { workday_password_mode: body.password_mode });
    if (body.auto_sign_in !== undefined) writeSettings(cfg, { workday_auto_sign_in: body.auto_sign_in });
    if (body.ai_assist !== undefined) writeSettings(cfg, { apply_ai_assist: body.ai_assist });
    return c.json(await accountView());
  });
  app.put("/api/local/accounts/shared-password", async (c) => {
    const body = await jsonBody(c, sharedPasswordSchema);
    if (body.password !== body.confirm) throw new ApiError(422, "password_mismatch", "The passwords do not match");
    const problems = passwordProblems(body.password);
    if (problems.length) throw new ApiError(422, "password_weak", "Use at least 8 characters with upper and lower case, a digit and a symbol", { problems });
    if (!accounts.available) throw new ApiError(503, "keychain_unavailable", "No secure store available");
    await accounts.setShared(body.password);
    return c.json(await accountView());
  });
  app.delete("/api/local/accounts/shared-password", async (c) => {
    await accounts.deleteShared();
    return c.json(await accountView());
  });
  // A password the user already has for an employer site (e.g. an account made by hand): Keychain only.
  app.put("/api/local/accounts/existing", async (c) => {
    const body = await jsonBody(c, existingAccountSchema);
    const site = /^https?:\/\//i.test(body.site) ? body.site : `https://${body.site}`;
    const tenant = tenantOf(site);
    if (!tenant || !/\./.test(tenant)) throw new ApiError(422, "invalid_site", "Enter the employer's Workday address");
    if (!accounts.available) throw new ApiError(503, "keychain_unavailable", "No secure store available");
    await accounts.save(tenant, body.email, body.password, "unique", "created");
    return c.json(await accountView());
  });
  // Copies a saved password to this Mac's clipboard (so the user can sign in by hand). The password
  // never travels through HTTP: the local server hands it to pbcopy on stdin.
  app.post("/api/local/accounts/:tenant/copy", async (c) => {
    const email = c.req.query("email") ?? "";
    const pw = await accounts.password(c.req.param("tenant"), email);
    if (!pw) throw new ApiError(404, "not_found", "No saved password for this site");
    if (process.platform !== "darwin") throw new ApiError(501, "clipboard_unavailable", "Copying is only available on macOS");
    await new Promise<void>((resolve, reject) => {
      const p = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("clipboard_failed"))));
      p.stdin.end(pw);
    });
    return c.json({ ok: true });
  });
  app.delete("/api/local/accounts/:tenant", async (c) => {
    const email = c.req.query("email") ?? "";
    await accounts.forget(c.req.param("tenant"), email);
    return c.json(await accountView());
  });
  // ---------- Gmail verification e-mails (app password stays in the Keychain; never returned) ----------
  const mail = rt.apply.mail!;
  const profileEmail = async (c: Parameters<typeof userOf>[0]) => {
    const row = await getProfileRow(getDb(rt.env.DB), userOf(c).id);
    const p = profileSchema.safeParse(row?.data ?? {});
    return p.success ? (p.data.contact.email ?? null) : null;
  };
  const mailView = async (c: Parameters<typeof userOf>[0]) => {
    const fallback = await profileEmail(c);
    const address = mail.address(fallback);
    return { available: mail.available, store: mail.storeKind, enabled: mail.settings().enabled, address: cfg.settings.gmail_address ?? "", profile_email: fallback, effective_address: address || null, password_saved: address ? await mail.hasPassword(address) : false };
  };
  app.get("/api/local/mail", async (c) => c.json(await mailView(c)));
  app.put("/api/local/mail", async (c) => {
    const body = await jsonBody(c, mailSettingsSchema);
    if (body.address !== undefined) writeSettings(cfg, { gmail_address: body.address || undefined });
    if (body.app_password) {
      const pw = body.app_password.replace(/\s+/g, "");
      if (!/^[a-zA-Z]{16}$/.test(pw)) throw new ApiError(422, "app_password_format", "A Google app password has 16 letters");
      const address = mail.address(await profileEmail(c));
      if (!address) throw new ApiError(422, "address_missing", "Enter the Gmail address first");
      if (!mail.available) throw new ApiError(503, "keychain_unavailable", "No secure store available");
      await mail.setPassword(address, pw);
    }
    if (body.enabled !== undefined) writeSettings(cfg, { gmail_verification: body.enabled });
    return c.json(await mailView(c));
  });
  app.delete("/api/local/mail/password", async (c) => {
    const address = mail.address(await profileEmail(c));
    if (address) await mail.deletePassword(address);
    writeSettings(cfg, { gmail_verification: false });
    return c.json(await mailView(c));
  });
  app.post("/api/local/mail/check", async (c) => c.json({ result: await mail.check(await profileEmail(c)) }));

  app.patch("/api/local/settings", async (c) => {
    const body = await jsonBody(c, z.object({ ai_provider: z.enum(["none", "claude_code"]).optional() }));
    if (body.ai_provider) {
      writeSettings(cfg, { ai_provider: body.ai_provider });
      rt.env.AI_PROVIDER = body.ai_provider;
    }
    return c.json({ ai_provider: rt.env.AI_PROVIDER });
  });
}
