// Background queue for application attempts. One browser at a time (the automation profile can
// only be open once). The `application_attempts` row is the durable queue entry; this runner only
// decides when to work on it. After a restart:
//   - queued / filling attempts that never clicked Submit start again from the beginning
//   - an attempt that was submitting, or had clicked Submit, becomes "submission_unconfirmed"
//     (never re-submitted automatically)
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ApplyController, AppEnv } from "../../server/env";
import { chooseBrowser, type BrowserChoice } from "./browser";
import { tenantOf, type AccountManager } from "./credentials";
import { runAttempt, type EngineDeps } from "./engine";
import type { MailVerifier } from "./mail";

export interface ApplyRunner extends ApplyController {
  accounts: AccountManager;
  mail: MailVerifier | null;
  init(): Promise<void>;
  recover(): Promise<{ requeued: number; unconfirmed: number }>;
  idle(): Promise<void>;
  stop(): void;
}

export function createApplyRunner(opts: {
  getEnv: () => AppEnv;
  automationDir: string;
  allowLoopback: boolean;
  timeouts?: EngineDeps["timeouts"];
  /** Tests only: run visible-window logic headless. */
  forceHeadless?: boolean;
  /** Tests may force a choice (e.g. unavailable). */
  choice?: BrowserChoice;
  accounts: AccountManager;
  /** Gmail verification e-mails (opt-in). */
  mail?: MailVerifier | null;
  /** Owner opt-in AI option matching (read at the start of each run). */
  aiAssist?: () => EngineDeps["aiAssist"];
  /** Unfamiliar application pages. Sees labels only; never profile values. */
  pageAgent?: EngineDeps["pageAgent"];
  chooseOption?: EngineDeps["chooseOption"];
}): ApplyRunner {
  const queue: string[] = [];
  const cancelled = new Set<string>();
  /** Re-queued while still running (e.g. answered while the paused run was closing its browser). */
  const rerun = new Set<string>();
  let running: string | null = null;
  let stopped = false;
  let choice: BrowserChoice = opts.choice ?? { available: false, browser: null, reason: "starting" };
  let waiters: (() => void)[] = [];
  const attemptsDir = join(opts.automationDir, "attempts");
  const evidenceDir = (id: string) => join(attemptsDir, id.replace(/[^a-zA-Z0-9-]/g, ""));

  const settle = () => {
    if (!running && !queue.length) {
      for (const w of waiters) w();
      waiters = [];
    }
  };

  const pump = () => {
    if (stopped || running || !queue.length) return settle();
    const id = queue.shift()!;
    running = id;
    void (async () => {
      const t0 = Date.now();
      if (process.env.CA_APPLY_DEBUG) console.log("RUNNER start", id.slice(0, 8));
      try {
        // Watchdog: a run can never hold the queue longer than its longest legitimate wait
        // (a visible hand-off) plus a margin; the attempt's own state is left as recorded.
        const limit = (opts.timeouts?.manual ?? 30 * 60_000) + 10 * 60_000;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          runAttempt(
          {
            env: opts.getEnv(),
            choice,
            profileDir: join(opts.automationDir, "browser-profile"),
            evidenceDir,
            allowLoopback: opts.allowLoopback,
            isCancelled: (a) => cancelled.has(a),
            timeouts: opts.timeouts,
            forceHeadless: opts.forceHeadless,
            accounts: opts.accounts,
            mail: opts.mail ?? null,
            aiAssist: opts.aiAssist?.() ?? null,
            pageAgent: opts.pageAgent,
            chooseOption: opts.chooseOption,
          },
          id,
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              console.error(JSON.stringify({ level: "error", where: "apply", attempt: id, error: "run_watchdog" }));
              resolve();
            }, limit);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
      } catch (e) {
        console.error(JSON.stringify({ level: "error", where: "apply", attempt: id, error: (e as Error)?.name }));
      } finally {
        if (process.env.CA_APPLY_DEBUG) console.log("RUNNER end", id.slice(0, 8), Date.now() - t0);
        cancelled.delete(id);
        running = null;
        if (rerun.delete(id) && !stopped) queue.push(id);
        pump();
      }
    })();
  };

  return {
    allowLoopback: opts.allowLoopback,
    accounts: opts.accounts,
    mail: opts.mail ?? null,
    async accountStatus(url, email) {
      const a = opts.accounts;
      const tenant = tenantOf(url);
      const st = a.settings();
      return {
        available: a.available,
        store: a.storeKind,
        tenant,
        email,
        credential: email ? await a.hasCredential(tenant, email) : false,
        blocked: email ? a.blocked(tenant, email) : false,
        password_mode: st.mode,
        shared_configured: await a.sharedConfigured(),
        auto_sign_in: st.autoSignIn,
        mail_verification: !!opts.mail && (await opts.mail.configured(email)),
      };
    },
    async init() {
      if (!opts.choice) choice = await chooseBrowser();
    },
    enqueue(id) {
      if (running === id) {
        rerun.add(id);
        return;
      }
      if (queue.includes(id)) return;
      queue.push(id);
      pump();
    },
    cancel(id) {
      cancelled.add(id);
      rerun.delete(id);
      const i = queue.indexOf(id);
      if (i >= 0) queue.splice(i, 1);
    },
    status: () => choice,
    readEvidence(attemptId, name) {
      if (!/^[a-z0-9-]{1,40}\.png$/.test(name)) return null;
      const p = join(evidenceDir(attemptId), name);
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
    },
    async recover() {
      const db = opts.getEnv().DB;
      const now = Date.now();
      // Anything that may have reached the employer is never retried.
      const unconfirmed = await db
        .prepare(
          "UPDATE application_attempts SET state = 'submission_unconfirmed', stage = NULL, error_code = 'interrupted', finished_at = ?, updated_at = ? WHERE state = 'submitting' OR (state = 'needs_review' AND intervention = 'manual_in_browser' AND stage = 'manual_posted')",
        )
        .bind(now, now)
        .run();
      // A visible hand-off cannot survive a restart: back to the user with the reason.
      await db.prepare("UPDATE application_attempts SET intervention = 'unexpected_page', visible = 0, stage = NULL, updated_at = ? WHERE state = 'needs_review' AND intervention = 'manual_in_browser'").bind(now).run();
      // Applications the user was completing in a window (Indeed Apply, unsupported employer site): ask how it ended.
      await db.prepare("UPDATE application_attempts SET intervention = 'confirm_result', visible = 0, stage = NULL, updated_at = ? WHERE state = 'needs_review' AND intervention IN ('indeed_apply_assisted', 'employer_site_manual')").bind(now).run();
      await db.prepare("UPDATE application_attempts SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE state IN ('queued','filling') AND cancel_requested_at IS NOT NULL").bind(now, now).run();
      await db.prepare("UPDATE application_attempts SET state = 'queued', stage = NULL, updated_at = ? WHERE state = 'filling'").bind(now).run();
      const rows = await db.prepare("SELECT id FROM application_attempts WHERE state = 'queued' ORDER BY created_at").all<{ id: string }>();
      for (const r of rows.results) this.enqueue(r.id);
      // Screenshots of attempts that no longer exist (job deleted) are removed.
      if (existsSync(attemptsDir)) {
        const ids = new Set((await db.prepare("SELECT id FROM application_attempts").all<{ id: string }>()).results.map((r) => r.id));
        for (const d of readdirSync(attemptsDir)) if (!ids.has(d)) rmSync(join(attemptsDir, d), { recursive: true, force: true });
      }
      return { requeued: rows.results.length, unconfirmed: Number(unconfirmed.meta?.changes ?? 0) };
    },
    idle() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        settle();
      });
    },
    stop() {
      // A running attempt is not cancelled: after the restart, recover() continues it safely.
      stopped = true;
      queue.length = 0;
      settle();
    },
  };
}
