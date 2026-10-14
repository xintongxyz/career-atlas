// Runs one application attempt in a Playwright browser.
//
//   open → detect ATS → (per form step) upload resume, fill from verified data, verify
//   → pause if anything is missing / needs approval → submit only when authorised
//   → verify the site's confirmation → Applied through changeStatus.
//
// Safety rules enforced here:
//   - submit_clicked_at is written durably BEFORE the click; an attempt with an uncertain outcome
//     becomes "submission_unconfirmed" and is never submitted again automatically
//   - every submission consumes the authorisation (submit_authorized → 0)
//   - CAPTCHAs, logins and email codes are handed to the user, never bypassed
//   - logs contain attempt ids and codes only — never field values, resume content or URLs
import type { AttemptState, InterventionReason, PendingQuestion } from "@shared/apply";
import { emptyProfile, profileSchema, type Profile } from "@shared/profile";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { eq } from "drizzle-orm";
import { schema, getDb } from "../../server/db/client";
import type { AppEnv } from "../../server/env";
import { sha256Hex } from "../../server/lib/util";
import { readDocumentBytes, syncApplied, updateAttempt, type AttemptRow } from "../../server/services/apply";
import { getProfileRow } from "../../server/services/profile";
import { launchBrowser, type BrowserChoice } from "./browser";
import { PAGE_SIGNALS, SCAN_FIELDS } from "./dom";
import { applicationUrl, atsFromSignals, classifyAfterSubmit, stripQuery, type Ats, type PageSignals } from "./outcome";
import { fieldKey, filledSummary, norm, planForm, type FieldDescriptor, type PlannedAction } from "./plan";

const { applicationAttempts, documents, jobPostings } = schema;

export interface EngineDeps {
  env: AppEnv;
  choice: BrowserChoice;
  profileDir: string;
  evidenceDir: (attemptId: string) => string;
  allowLoopback: boolean;
  isCancelled: (attemptId: string) => boolean;
  timeouts?: Partial<{ navigation: number; afterSubmit: number; manual: number }>;
}

class Stop extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_FORM_STEPS = 6;

export async function runAttempt(deps: EngineDeps, attemptId: string): Promise<AttemptState> {
  const db = getDb(deps.env.DB);
  const t = { navigation: 45_000, afterSubmit: 45_000, manual: 30 * 60_000, ...deps.timeouts };
  let row = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
  if (!row || row.state !== "queued") return (row?.state as AttemptState) ?? "failed";
  const visible = !!row.visible;
  const evidence = new Set<string>((row.evidence as string[] | null) ?? []);
  let clickedThisRun = false;
  let ctx: BrowserContext | null = null;

  const set = (patch: Partial<typeof applicationAttempts.$inferInsert>, code?: string, params?: Record<string, string | number>) => updateAttempt(db, attemptId, patch, code ? { code, params } : undefined);
  const cancelled = async () => {
    if (deps.isCancelled(attemptId)) return true;
    const r = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
    return !!r?.cancelRequestedAt || r?.state === "cancelled";
  };
  const checkCancel = async () => {
    if (await cancelled()) throw new Stop("cancelled");
  };
  const shot = async (page: Page, name: string) => {
    try {
      const dir = deps.evidenceDir(attemptId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${name}.png`), await page.screenshot({ fullPage: true, timeout: 15_000 }), { mode: 0o600 });
      evidence.add(`${name}.png`);
      await set({ evidence: [...evidence] });
    } catch {
      /* evidence is best effort */
    }
  };
  const pause = async (reason: InterventionReason, questions: PendingQuestion[] = [], extra: Partial<typeof applicationAttempts.$inferInsert> = {}) => {
    await set({ state: "needs_review", intervention: reason, questions, visible: 0, stage: null, ...extra }, "paused", { reason });
    return "needs_review" as const;
  };

  try {
    await set({ state: "filling", startedAt: row.startedAt ?? Date.now(), stage: "opening", errorCode: null, errorMessage: null }, visible ? "started_visible" : "started");

    // ---- inputs: profile, job, the exact resume (never substituted)
    const profileRow = await getProfileRow(db, row.userId);
    const parsed = profileSchema.safeParse(profileRow?.data ?? {});
    const profile: Profile = parsed.success ? parsed.data : emptyProfile();
    const posting = await db.query.jobPostings.findFirst({ where: eq(jobPostings.id, row.jobPostingId) });
    const doc = row.resumeDocumentId ? await db.query.documents.findFirst({ where: eq(documents.id, row.resumeDocumentId) }) : null;
    if (!doc || doc.deletedAt) throw new Stop("resume_unavailable");
    const bytes = await readDocumentBytes(deps.env, doc.r2Key);
    if (!bytes || bytes.byteLength !== row.resumeSizeBytes || (await sha256Hex(bytes.buffer as ArrayBuffer)) !== row.resumeSha256) throw new Stop("resume_changed");
    const resumeFile = { name: row.resumeFileName, mimeType: row.resumeMimeType, buffer: Buffer.from(bytes) };

    // ---- open
    await checkCancel();
    ctx = await launchBrowser({ profileDir: deps.profileDir, headless: !visible, choice: deps.choice, allowLoopback: deps.allowLoopback });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(15_000);
    await goto(page, row.targetUrl, t.navigation);
    let s = await signals(page);
    if (s.greenhouseIframe) {
      await goto(page, s.greenhouseIframe, t.navigation);
      s = await signals(page);
    }
    let ats: Ats | null = atsFromSignals(s);
    if (ats === "lever" && !s.leverForm) {
      await goto(page, applicationUrl("lever", page.url()), t.navigation);
      s = await signals(page);
    }
    if (ats && !s.hasForm) {
      // Some boards show the form after an "Apply" button.
      const apply = page.getByRole("button", { name: /^apply( for this job| now)?$/i }).or(page.getByRole("link", { name: /^apply( for this job| now)?$/i })).first();
      if (await apply.isVisible().catch(() => false)) {
        await apply.click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(800);
        s = await signals(page);
        ats = atsFromSignals(s) ?? ats;
      }
    }
    if (s.challenge) return visible ? await manual(page, ats, "captcha") : await pause("captcha");
    if (!s.hasForm && s.password) return visible ? await manual(page, ats, "login_required") : await pause("login_required");
    if (!ats) throw new Stop("unsupported_site");
    if (!s.hasForm) throw new Stop("form_not_found");
    await set({ ats, stage: "filling" }, "detected_ats", { ats });

    // ---- fill, step by step
    const answers = (row.answers as Record<string, unknown> | null) ?? {};
    const planCtx = { profile, jobCountry: posting?.country ?? null, answers, resume: { fileName: resumeFile.name } };
    let allFilled: ReturnType<typeof filledSummary> = [];
    for (let step = 0; step < MAX_FORM_STEPS; step++) {
      await checkCancel();
      let fields = await scan(page);
      let plan = planForm(fields, planCtx);
      // Resume first: some systems (e.g. Lever) parse it and pre-fill fields, which we then overwrite and verify.
      const upload = plan.actions.find((a) => a.kind === "upload");
      if (upload) {
        await page.locator(`[data-ca-ref="${upload.ref}"]`).setInputFiles(resumeFile);
        await set({}, "uploaded_resume", { file: resumeFile.name });
        await sleep(1200);
        fields = await scan(page);
        plan = planForm(fields, planCtx);
      }
      fields = await enrichComboboxes(page, fields);
      plan = planForm(fields, planCtx);
      for (const a of plan.actions) {
        await checkCancel();
        if (a.kind !== "upload") await perform(page, a).catch(() => {});
      }
      // Verify what the page now holds.
      const after = await scan(page);
      const ok = verify(plan.actions, after, resumeFile);
      const unverified = plan.actions.filter((a) => !ok.has(a.ref));
      allFilled = allFilled.concat(filledSummary(plan.actions, ok));
      await set({ filled: allFilled }, "filled", { count: ok.size, total: plan.actions.length });

      const questions = [...plan.questions];
      for (const a of unverified) {
        const f = after.find((x) => fieldKey(x) === a.key) ?? fields.find((x) => x.ref === a.ref);
        if (a.kind === "upload") throw new Stop("resume_upload_failed");
        if (f && f.required && !questions.some((q) => q.key === a.key)) questions.push({ key: a.key, label: f.label.slice(0, 500), kind: f.control === "select" || f.control === "combobox" ? "select" : f.control === "radio" ? "radio" : "text", required: true, options: f.options.map((o) => o.label).slice(0, 100), reason: "not_accepted", sensitive: false, hint: null });
      }
      if (questions.length) {
        await shot(page, `step-${step + 1}`);
        const reason: InterventionReason = questions.some((q) => q.reason === "legal") ? "approval_needed" : questions.every((q) => q.reason === "unsupported") ? "unsupported_field" : "missing_information";
        return visible ? await manual(page, ats, reason, questions) : await pause(reason, questions);
      }
      // Multi-step forms: continue while there is a Next button and no Submit button.
      if (await submitButton(page, ats).isVisible().catch(() => false)) break;
      const next = page.getByRole("button", { name: /^(next|continue|save and continue|next step)$/i }).first();
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(800);
      await set({}, "next_step", { step: step + 2 });
    }

    // ---- ready to submit
    await shot(page, "filled");
    const submit = submitButton(page, ats);
    if (!(await submit.isVisible().catch(() => false))) return visible ? await manual(page, ats, "unexpected_page") : await pause("unexpected_page");
    row = (await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) }))!;
    if (!row.submitAuthorized) return visible ? await manual(page, ats, "submit_approval") : await pause("submit_approval");
    s = await signals(page);
    if (s.challenge) return visible ? await manual(page, ats, "captcha") : await pause("captcha");
    await checkCancel();

    // ---- submit: record the click durably first, consume the authorisation
    const posts = trackSubmissions(page);
    await set({ state: "submitting", stage: "submitting", submitClickedAt: row.submitClickedAt ?? Date.now(), submitAuthorized: 0 }, "submit_clicked");
    clickedThisRun = true;
    await submit.click();
    const outcome = await waitForOutcome(page, ats, posts, t.afterSubmit);
    if (outcome.kind === "verified") return await verified(page, outcome.text, outcome.url, "page");
    if (outcome.kind === "validation_errors") {
      await shot(page, "rejected");
      // The site refused the form before sending it (no submission request was made).
      return visible ? await manual(page, ats, "validation_errors") : await pause("validation_errors", [], { state: "needs_review", errorCode: "validation_errors", errorMessage: outcome.errors.join(" | ").slice(0, 600) });
    }
    if (outcome.kind === "challenge" && !posts.posted()) {
      return visible ? await manual(page, ats, "captcha") : await pause("captcha", [], { state: "needs_review" });
    }
    if (visible) return await manual(page, ats, outcome.kind === "email_code" ? "login_required" : "unexpected_page");
    await shot(page, "result");
    await set({ state: "submission_unconfirmed", stage: null, finishedAt: Date.now(), errorCode: outcome.kind === "email_code" ? "verification_code_required" : outcome.kind === "challenge" ? "captcha_after_submit" : "no_confirmation" }, "unconfirmed");
    return "submission_unconfirmed";
  } catch (e) {
    const code = e instanceof Stop ? e.code : errorCode(e);
    if (code === "cancelled" && !clickedThisRun) {
      await set({ state: "cancelled", stage: null, finishedAt: Date.now(), intervention: null }, "cancelled");
      return "cancelled";
    }
    if (clickedThisRun) {
      await set({ state: "submission_unconfirmed", stage: null, finishedAt: Date.now(), errorCode: code }, "unconfirmed");
      return "submission_unconfirmed";
    }
    await set({ state: "failed", stage: null, finishedAt: Date.now(), errorCode: code, errorMessage: null }, "failed", { code });
    console.error(JSON.stringify({ level: "warn", where: "apply", attempt: attemptId, code }));
    return "failed";
  } finally {
    await ctx?.close().catch(() => {});
  }

  // ---------------------------------------------------------------- helpers (closures)

  async function verified(page: Page, text: string | null, url: string, source: "page" | "user"): Promise<AttemptState> {
    await shot(page, "confirmation");
    const ts = Date.now();
    await set({ state: "submitted_verified", stage: null, confirmationText: text, confirmationUrl: url, confirmationSource: source, confirmedAt: ts, finishedAt: ts, intervention: null, questions: [] }, "verified");
    const r = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
    if (r) await syncApplied(db, r.userId, r as AttemptRow);
    return "submitted_verified";
  }

  /**
   * Visible browser hand-off: the user finishes in the window. We keep watching for the site's
   * confirmation; a submission seen without confirmation ends as "unconfirmed".
   */
  async function manual(page: Page, ats: Ats | null, reason: InterventionReason, questions: PendingQuestion[] = []): Promise<AttemptState> {
    await set({ state: "needs_review", intervention: "manual_in_browser", questions, stage: "manual" }, "manual_handoff", { reason });
    const posts = trackSubmissions(page);
    const until = Date.now() + t.manual;
    while (Date.now() < until) {
      if (page.isClosed()) break; // the user closed the window
      const r = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
      if (!r || r.state !== "needs_review" || r.cancelRequestedAt || deps.isCancelled(attemptId)) {
        if (r?.state === "cancelled" || r?.cancelRequestedAt) {
          if (posts.posted()) break;
          await set({ state: "cancelled", stage: null, finishedAt: Date.now(), intervention: null, visible: 0 }, "cancelled");
          return "cancelled";
        }
        return (r?.state as AttemptState) ?? "failed"; // answered/re-queued: a new run takes over
      }
      if (posts.posted() && r.stage !== "manual_posted") await set({ stage: "manual_posted", submitClickedAt: r.submitClickedAt ?? Date.now() }, "submitted_by_user");
      const s = await signals(page).catch(() => null);
      if (s) {
        const o = classifyAfterSubmit(ats, s, posts.posted());
        if (o.kind === "verified") return verified(page, o.text, o.url, "page");
      }
      await sleep(1000);
    }
    if (posts.posted()) {
      await set({ state: "submission_unconfirmed", stage: null, finishedAt: Date.now(), visible: 0, errorCode: "no_confirmation" }, "unconfirmed");
      return "submission_unconfirmed";
    }
    return pause(reason, questions);
  }
}

// ---------------------------------------------------------------- page helpers

async function goto(page: Page, url: string, timeout: number) {
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch((e) => {
    throw new Stop(errorCode(e));
  });
  if (res && res.status() >= 400) throw new Stop(res.status() === 404 || res.status() === 410 ? "posting_gone" : "navigation_failed");
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}

async function signals(page: Page): Promise<PageSignals> {
  return (await page.evaluate(PAGE_SIGNALS)) as PageSignals;
}

async function scan(page: Page): Promise<FieldDescriptor[]> {
  return (await page.evaluate(SCAN_FIELDS)) as FieldDescriptor[];
}

const OPTION_SEL = '.select__option, [role="option"], [id*="-option-"]';

/** Reads the options of react-select style comboboxes (they exist only while the menu is open). */
async function enrichComboboxes(page: Page, fields: FieldDescriptor[]): Promise<FieldDescriptor[]> {
  for (const f of fields) {
    if (f.control !== "combobox" || !f.visible || f.options.length) continue;
    const loc = page.locator(`[data-ca-ref="${f.ref}"]`);
    try {
      await loc.click({ timeout: 3000 });
      await sleep(250);
      const opts = await page.locator(OPTION_SEL).evaluateAll((els) => els.filter((e) => (e as unknown as { offsetParent: unknown }).offsetParent !== null).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean));
      f.options = opts.slice(0, 300).map((l) => ({ value: l, label: l }));
      f.asyncOptions = !opts.length;
      await page.keyboard.press("Escape");
    } catch {
      f.asyncOptions = true;
    }
  }
  return fields;
}

async function perform(page: Page, a: PlannedAction) {
  const loc = page.locator(`[data-ca-ref="${a.ref}"]`);
  switch (a.kind) {
    case "fill":
      await loc.fill(a.value);
      await loc.blur().catch(() => {});
      return;
    case "check":
      await loc.setChecked(a.value, { force: true });
      return;
    case "choose":
      if (a.control === "select") {
        await loc.selectOption({ label: a.values[0] });
        return;
      }
      if (a.control === "radio" || a.control === "checkboxes") {
        for (const r of a.optionRefs ?? []) await page.locator(`[data-ca-ref="${r}"]`).check({ force: true });
        return;
      }
      if (a.control === "combobox") return pickOption(page, loc, a.values[0], (l) => l === norm(a.values[0]), 250);
      return;
    case "search":
      // Only an unambiguous suggestion is taken (e.g. "Toronto, Ontario, Canada", not "Toronto, Ohio").
      return pickOption(page, loc, a.value, (l) => a.match.every((m) => l.includes(norm(m))), 1500);
  }
}

async function pickOption(page: Page, loc: ReturnType<Page["locator"]>, text: string, fits: (normalizedLabel: string) => boolean, wait: number) {
  await loc.click();
  await loc.fill(text);
  await sleep(wait);
  const opts = page.locator(OPTION_SEL).filter({ visible: true });
  const hits: number[] = [];
  const n = await opts.count();
  for (let i = 0; i < n; i++) if (fits(norm(await opts.nth(i).textContent()))) hits.push(i);
  if (hits.length === 1) await opts.nth(hits[0]).click();
  else await page.keyboard.press("Escape");
}

function verify(actions: PlannedAction[], after: FieldDescriptor[], resume: { name: string }): Set<string> {
  const ok = new Set<string>();
  const byKey = new Map(after.map((f) => [fieldKey(f), f]));
  const byRef = new Map(after.map((f) => [f.ref, f]));
  const digits = (s: string) => s.replace(/\D+/g, "");
  for (const a of actions) {
    const f = byRef.get(a.ref) ?? byKey.get(a.key);
    if (!f) continue;
    const v = f.value;
    const list = (Array.isArray(v) ? v : [String(v ?? "")]).map(norm);
    let good = false;
    switch (a.kind) {
      case "upload":
        good = list.includes(norm(resume.name));
        break;
      case "fill":
        good = /phone|tel/.test(`${f.name} ${f.id} ${f.inputType}`.toLowerCase()) ? digits(String(v)).endsWith(digits(a.value).slice(-7)) && digits(a.value).length > 0 : norm(String(v)) === norm(a.value);
        break;
      case "check":
        good = v === a.value;
        break;
      case "choose":
        good = a.values.every((x) => list.includes(norm(x)));
        break;
      case "search":
        good = list.some((x) => a.match.every((m) => x.includes(norm(m))));
        break;
    }
    if (good) ok.add(a.ref);
  }
  return ok;
}

function submitButton(page: Page, ats: Ats | null) {
  const generic = page.getByRole("button", { name: /^submit( (my )?application)?$/i });
  if (ats === "lever") return page.locator('#btn-submit, button[data-qa="btn-submit"]').or(generic).first();
  if (ats === "greenhouse") return page.locator('form#application-form button[type="submit"], form#application_form #submit_app, form#application_form input[type="submit"]').or(generic).first();
  return generic.first();
}

/** Watches for a form submission request (POST/PUT to the site itself, not analytics). */
function trackSubmissions(page: Page) {
  let seen = false;
  const host = (() => {
    try {
      return new URL(page.url()).hostname;
    } catch {
      return "";
    }
  })();
  const onReq = (req: { method(): string; url(): string; resourceType(): string }) => {
    if (!["POST", "PUT"].includes(req.method())) return;
    let h = "";
    try {
      h = new URL(req.url()).hostname;
    } catch {
      return;
    }
    if (h === host || /(^|\.)greenhouse\.io$|(^|\.)lever\.co$/.test(h)) seen = true;
  };
  page.on("request", onReq);
  return { posted: () => seen, stop: () => page.off("request", onReq) };
}

async function waitForOutcome(page: Page, ats: Ats | null, posts: ReturnType<typeof trackSubmissions>, timeout: number) {
  const until = Date.now() + timeout;
  let last: ReturnType<typeof classifyAfterSubmit> = { kind: "pending" };
  await sleep(500);
  while (Date.now() < until) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const s = await signals(page).catch(() => null);
    if (s) {
      last = classifyAfterSubmit(ats, s, posts.posted());
      if (last.kind === "verified") return last;
      // Rejected locally: wait briefly in case a submission request is still on its way.
      if (last.kind === "validation_errors" && Date.now() > until - timeout + 2500) return last;
      if ((last.kind === "challenge" || last.kind === "email_code") && Date.now() > until - timeout + 4000) return last;
    }
    await sleep(500);
  }
  return last.kind === "validation_errors" && !posts.posted() ? last : last.kind === "challenge" || last.kind === "email_code" ? last : ({ kind: "pending" } as const);
}

function errorCode(e: unknown): string {
  const m = String((e as Error)?.message ?? "");
  if ((e as Error)?.name === "TimeoutError" || /Timeout/.test(m)) return "timeout";
  if (/net::ERR_|NS_ERROR|ECONNREFUSED|ENOTFOUND/.test(m)) return "navigation_failed";
  if (/Executable doesn't exist|browserType\.launch|Failed to launch/.test(m)) return "browser_launch_failed";
  if (/Target (page|closed)|has been closed/.test(m)) return "browser_closed";
  return "worker_error";
}

export const _test = { verify, stripQuery };
