// Runs one application attempt in a Playwright browser.
//
//   open → route (Indeed listing → follow the user's click; Workday wizard; single-page form)
//   → per step: attach the selected resume, fill from verified data, verify on the page
//   → pause if anything is missing / needs approval / needs the user (sign-in, CAPTCHA)
//   → submit only when authorised → verify the site's confirmation → Applied via changeStatus.
//
// Safety rules enforced here:
//   - submit_clicked_at is written durably BEFORE the click; an attempt with an uncertain outcome
//     becomes "submission_unconfirmed" and is never submitted again automatically
//   - every submission consumes the authorisation (submit_authorized → 0)
//   - CAPTCHAs are handed to the user, never bypassed. Workday sign-in / account creation only as
//     authorised per application (Keychain credentials, never retried after a failure); Workday
//     verification e-mails are read from Gmail only when the owner turned it on (mail.ts),
//     otherwise they are handed to the user
//   - Indeed is never automated: in the visible window the user clicks; Career Atlas only reads
//     page addresses to follow them to the employer's form
//   - logs contain attempt ids and codes only — never field values, resume content or URLs
//
// The Workday listbox handling (chooseListbox) and Workday field names follow MIT-licensed projects
// listed in THIRD_PARTY_NOTICES.md (AutoApply, Autofill-Jobs); see src/local/apply/workday.ts.
import { classificationUrl, type AttemptState, type FilledField, type InterventionReason, type PendingQuestion } from "@shared/apply";
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
import { tenantOf, type AccountManager } from "./credentials";
import { questionMeaning } from "@shared/apply-semantic";
import { PAGE_SIGNALS } from "./dom";
import { enrichOptions, perform, scan, verify } from "./interact";
import { classifyIndeedUrl } from "./indeed";
import { applicationUrl, atsFromSignals, classifyAfterSubmit, stripQuery, type Ats, type PageSignals } from "./outcome";
import { fieldKey, norm, planForm, question, type FieldDescriptor, type PlanContext, type PlannedAction } from "./plan";
import { fillSections } from "./wd-sections";
import { jobSourceOf, type JobSource } from "@shared/apply-match";
import type { MailVerifier } from "./mail";
import { accountTermsLabel, activeStep, clickNext, codeInput, declineCookies, enterApplyFlow, isAutofillUpload, nextButton, submitVerificationCode, uploadResume, wdReady, wdSettle, wdState, workdayCreateAccount, workdaySignIn } from "./workday";

const { applicationAttempts, documents, jobPostings, companies } = schema;

export interface EngineDeps {
  env: AppEnv;
  choice: BrowserChoice;
  profileDir: string;
  evidenceDir: (attemptId: string) => string;
  allowLoopback: boolean;
  isCancelled: (attemptId: string) => boolean;
  timeouts?: Partial<{ navigation: number; afterSubmit: number; manual: number; stepReady: number; mailWait: number }>;
  /** Tests: run the visible-window logic in a headless browser. */
  forceHeadless?: boolean;
  /** Workday candidate accounts (Keychain-backed). */
  accounts?: AccountManager;
  /** Gmail verification e-mails (opt-in, Settings). */
  mail?: MailVerifier | null;
  /** Owner opt-in: Claude decides whether one of the site's options means the same as a value (never facts). */
  aiAssist?: ((purpose: "skill" | "field_of_study" | "language" | "school", value: string, options: string[]) => Promise<string | null>) | null;
}

class Stop extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** The Workday page moved on while it was being filled (e.g. the user clicked Continue in the window). */
class StepMoved extends Error {
  constructor() {
    super("step_moved");
  }
}

/** The attempt was changed by the user while this run waited (e.g. answered → queued again). */
class Superseded extends Error {
  constructor(public state: AttemptState) {
    super("superseded");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_FORM_STEPS = 6;
const MAX_WORKDAY_STEPS = 15;
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

export async function runAttempt(deps: EngineDeps, attemptId: string): Promise<AttemptState> {
  const db = getDb(deps.env.DB);
  const t = { navigation: 45_000, afterSubmit: 45_000, manual: 30 * 60_000, stepReady: 90_000, mailWait: 180_000, ...deps.timeouts };
  let row = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
  if (!row || row.state !== "queued") return (row?.state as AttemptState) ?? "failed";
  const visible = !!row.visible;
  const evidence = new Set<string>((row.evidence as string[] | null) ?? []);
  let clickedThisRun = false;
  let ctx: BrowserContext | null = null;
  let allFilled: FilledField[] = [];
  let resumeFile = { name: "", mimeType: "", buffer: Buffer.alloc(0) };
  let planCtx: PlanContext = { profile: emptyProfile(), jobCountry: null, answers: {}, resume: { fileName: "" } };
  let jobSource: JobSource = null;
  const allow = deps.allowLoopback;

  const set = (patch: Partial<typeof applicationAttempts.$inferInsert>, code?: string, params?: Record<string, string | number>) => updateAttempt(db, attemptId, patch, code ? { code, params } : undefined);
  const current = () => db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
  const cancelled = async () => {
    if (deps.isCancelled(attemptId)) return true;
    const r = await current();
    return !!r?.cancelRequestedAt || r?.state === "cancelled";
  };
  const checkCancel = async () => {
    if (await cancelled()) throw new Stop("cancelled");
  };
  // Workday: the step being filled; if the page moves on meanwhile, filling stops and the loop re-reads it.
  let fillingStep: { page: Page; step: string } | null = null;
  const checkStep = async () => {
    if (!fillingStep) return;
    const now = await activeStep(fillingStep.page);
    if (now && fillingStep.step && now !== fillingStep.step) throw new StepMoved();
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
  const qmOf = (f: FieldDescriptor) => questionMeaning(f.label, planCtx.employer ?? null);
  const reasonFor = (questions: PendingQuestion[]): InterventionReason =>
    questions.some((q) => q.reason === "legal") ? "approval_needed" : questions.every((q) => q.reason === "unsupported") ? "unsupported_field" : "missing_information";

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
    resumeFile = { name: row.resumeFileName, mimeType: row.resumeMimeType, buffer: Buffer.from(bytes) };
    const company = posting ? await db.query.companies.findFirst({ where: eq(companies.id, posting.companyId) }) : null;
    jobSource = jobSourceOf({ sourcePlatform: posting?.sourcePlatform, originalUrl: posting?.originalUrl, route: row.route, sourceUrl: row.sourceUrl });
    planCtx = { profile, jobCountry: posting?.country ?? null, answers: (row.answers as Record<string, unknown> | null) ?? {}, resume: { fileName: resumeFile.name }, employer: company?.name ?? null, jobSource };

    // ---- open
    await checkCancel();
    ctx = await launchBrowser({ profileDir: deps.profileDir, headless: !visible || !!deps.forceHeadless, choice: deps.choice, allowLoopback: allow });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(15_000);
    await goto(page, row.targetUrl, t.navigation);
    if (classifyIndeedUrl(classificationUrl(page.url(), allow)) !== "external") return await indeedFlow(page);
    return await formFlow(page, row.route === "indeed_company_site");
  } catch (e) {
    if (e instanceof Superseded) return e.state; // a new run takes over; nothing is overwritten
    const code = e instanceof Stop ? e.code : errorCode(e);
    if (code === "cancelled" && !clickedThisRun) {
      const r = await current();
      if (r?.state !== "cancelled") await set({ state: "cancelled", stage: null, finishedAt: Date.now(), intervention: null }, "cancelled");
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
    // Closing the browser must never block the queue (a hung close would stall every later attempt).
    if (ctx) await Promise.race([ctx.close().catch(() => {}), sleep(10_000)]);
  }

  // ================================================================ routes

  /**
   * Indeed listing. The user clicks Apply in the visible window; Career Atlas only watches page
   * addresses: "Apply on company site" → continue on the employer's form (Workday, Greenhouse,
   * Lever, or assisted when unsupported); Indeed Apply → the user completes it on Indeed and the
   * post-apply page (or the user's own confirmation) records the result.
   */
  async function indeedFlow(page: Page): Promise<AttemptState> {
    if (!visible) return pause("unexpected_page", [], { errorCode: "indeed_needs_window" });
    await set({ stage: "indeed_waiting", ats: null }, "indeed_waiting");
    const context = page.context();
    let indeedApply = false;
    const until = Date.now() + t.manual;
    while (Date.now() < until) {
      if (await cancelled()) throw new Stop("cancelled");
      const r = await current();
      if (!r || !["filling", "needs_review"].includes(r.state)) return (r?.state as AttemptState) ?? "failed"; // resolved by the user meanwhile
      const pages = context.pages().filter((p) => !p.isClosed());
      if (!pages.length) break;
      for (const p of pages) {
        const kind = classifyIndeedUrl(classificationUrl(p.url(), allow));
        if (kind === "external") {
          const target = p.url();
          await set({ targetUrl: target, route: "indeed_company_site", state: "filling", intervention: null, stage: "filling" }, "indeed_resolved", { host: hostOf(target) });
          await p.bringToFront().catch(() => {});
          await p.waitForLoadState("domcontentloaded").catch(() => {});
          await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
          return formFlow(p, true);
        }
        if (kind === "indeed_apply_confirmation") {
          await set({ route: "indeed_apply" });
          return verified(p, null, stripQuery(p.url()), "page");
        }
        if (kind === "indeed_apply" && !indeedApply) {
          indeedApply = true;
          await set({ state: "needs_review", intervention: "indeed_apply_assisted", route: "indeed_apply", stage: "indeed_apply" }, "indeed_apply_detected");
        }
      }
      await sleep(1000);
    }
    return indeedApply ? pause("confirm_result", [], { route: "indeed_apply" }) : pause("unexpected_page", [], { errorCode: "indeed_no_destination" });
  }

  /** The application form itself: Workday wizard, or a single-page Greenhouse / Lever form. */
  async function formFlow(page: Page, fromIndeed: boolean): Promise<AttemptState> {
    let s = await signals(page);
    if (s.greenhouseIframe) {
      await goto(page, s.greenhouseIframe, t.navigation);
      s = await signals(page);
    }
    let ats: Ats | null = atsFromSignals(s, allow);
    if (ats === "workday") return workdayFlow(page);
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
        ats = atsFromSignals(s, allow) ?? ats;
      }
    }
    if (s.challenge) return visible ? manual(page, ats, "captcha") : pause("captcha");
    if (!s.hasForm && s.password) return visible ? manual(page, ats, "login_required") : pause("login_required");
    if (!ats) {
      // Followed from Indeed to an employer site Career Atlas can't fill: the user completes it there.
      if (fromIndeed && visible) return employerManual(page);
      throw new Stop("unsupported_site");
    }
    if (!s.hasForm) throw new Stop("form_not_found");
    await set({ ats, stage: "filling" }, "detected_ats", { ats });

    for (let step = 0; step < MAX_FORM_STEPS; step++) {
      await checkCancel();
      const { questions } = await fillPage(page, { uploadInPlan: true });
      if (questions.length) {
        await shot(page, `step-${step + 1}`);
        return visible ? manual(page, ats, reasonFor(questions), questions) : pause(reasonFor(questions), questions);
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

    await shot(page, "filled");
    const submit = submitButton(page, ats);
    if (!(await submit.isVisible().catch(() => false))) return visible ? manual(page, ats, "unexpected_page") : pause("unexpected_page");
    const gate = await submitGate(page, ats);
    if (gate) return gate;
    const posts = trackSubmissions(page);
    await markSubmitting();
    await submit.click();
    const outcome = await waitForOutcome(page, ats, posts, t.afterSubmit);
    if (outcome.kind === "verified") return verified(page, outcome.text, outcome.url, "page");
    if (outcome.kind === "validation_errors") {
      await shot(page, "rejected");
      // The site refused the form before sending it (no submission request was made).
      return visible ? manual(page, ats, "validation_errors") : pause("validation_errors", [], { errorCode: "validation_errors", errorMessage: outcome.errors.join(" | ").slice(0, 600) });
    }
    if (outcome.kind === "challenge" && !posts.posted()) return visible ? manual(page, ats, "captcha") : pause("captcha");
    if (visible) return manual(page, ats, outcome.kind === "email_code" ? "login_required" : "unexpected_page");
    return unconfirmed(page, outcome.kind === "email_code" ? "verification_code_required" : outcome.kind === "challenge" ? "captcha_after_submit" : "no_confirmation");
  }

  /**
   * Workday wizard. Steps are recognised from the page (they differ between employers). Sign-in /
   * account creation / e-mail verification are always done by the user in the visible window;
   * the session stays in Career Atlas's own browser profile and filling continues afterwards.
   */
  async function workdayFlow(page: Page): Promise<AttemptState> {
    await set({ ats: "workday", stage: "opening" }, "detected_ats", { ats: "workday" });
    await declineCookies(page);
    if (/you(?:'ve| have) already applied/i.test(await page.locator("body").innerText().catch(() => ""))) throw new Stop("already_applied_on_site");
    // Autofill with Resume first (Workday parses the exact selected resume), Apply Manually as fallback.
    const entered = await enterApplyFlow(page, row!.entryMode === "manual" ? "manual" : "autofill");
    if (entered.result === "closed") throw new Stop("posting_gone");
    if (entered.mode) await set({}, "workday_entered", { mode: entered.mode });
    const parsedMode = entered.mode === "autofill" || entered.mode === null;
    let lastStep = "";
    let resumeHandled = false;
    let stuck = 0;
    let signedInNow = false;
    let reentered = false;
    const accountTried = { signIn: false, create: false, mail: false };
    for (let i = 0; i < MAX_WORKDAY_STEPS; i++) {
      await checkCancel();
      await declineCookies(page);
      let st = await wdSettle(page);
      if (entered.result === "no_apply" && i === 0 && st.kind === "unknown") throw new Stop("form_not_found");
      if ((await signals(page)).challenge) {
        if (!visible) return pause("captcha");
        if (!(await waitForUser(page, async () => !(await signals(page)).challenge, "captcha"))) return pause("captcha");
        continue;
      }
      // Verification e-mail: read from Gmail when the user turned it on (Settings), otherwise the user.
      if (st.kind === "verify_email" && !accountTried.mail && deps.mail && row!.accountMode && row!.accountMode !== "none") {
        accountTried.mail = true;
        const r = await verifyByEmail(page, Date.now() - 15 * 60_000);
        if (r === "ok") {
          signedInNow = true;
          continue;
        }
      }
      if (st.kind === "auth" && row!.accountMode && row!.accountMode !== "none" && deps.accounts?.available) {
        const r = await workdayAccount(page, accountTried);
        if (r === "continue") {
          signedInNow = true;
          continue;
        }
        if (r !== "user") return r;
      }
      if (st.kind === "auth" || st.kind === "verify_email") {
        if (!visible) return pause("login_required", [], { stage: st.kind === "verify_email" ? "workday_verify_email" : "workday_sign_in" });
        const ok = await waitForUser(page, async () => {
          const x = await wdState(page);
          return x.kind === "step" || x.kind === "review";
        }, "login_required");
        if (!ok) return pause("login_required", [], { stage: "workday_sign_in" });
        await set({ state: "filling", intervention: null, stage: "filling" }, "workday_signed_in");
        signedInNow = true;
        continue;
      }
      if (/already applied/i.test(st.errors.join(" "))) throw new Stop("already_applied_on_site");
      if (st.kind === "review") break;
      if (st.kind !== "step") return visible ? manual(page, "workday", "unexpected_page") : pause("unexpected_page");
      // After signing in, Workday sometimes drops the "Autofill with Resume" choice and opens the
      // empty form instead: go back to the autofill address once, so the resume is uploaded and parsed.
      if (signedInNow && entered.mode === "autofill" && entered.url && !resumeHandled && !reentered && !(await isAutofillUpload(page)) && !(await page.locator('input[type="file"]').count())) {
        reentered = true;
        await set({}, "workday_autofill_resumed");
        await goto(page, entered.url, t.navigation);
        continue;
      }
      await wdReady(page);
      st = await wdState(page);
      const name = `${st.step ?? ""}|${st.pageId ?? ""}`;
      if (name !== lastStep) await set({ stage: "filling" }, "workday_step", { step: st.step ?? st.pageId ?? "?", n: st.index ?? 0, total: st.total ?? 0 });
      lastStep = name;

      try {
        fillingStep = { page, step: await activeStep(page) };
        // Resume: exactly the selected file. Files already attached are removed only with the user's OK;
        // a file with the same name is not assumed to be the same version.
        if (!resumeHandled && (await page.locator('input[type="file"]').count())) {
          const ours = await uploadedEarlier();
          const r = await uploadResume(page, resumeFile, { ours, decide: (name) => String(planCtx.answers[`attachment:${norm(name)}`] ?? "") as "Remove" | "Keep" | "" });
          if (r.result === "failed") throw new Stop("resume_upload_failed");
          if (r.result === "confirm") {
            await shot(page, `step-${st.index ?? i + 1}-attachments`);
            return pause("approval_needed", r.files.map((name) => ({ key: `attachment:${norm(name)}`, label: name === resumeFile.name ? `A file named “${name}” is already attached on the employer's site. It may be an older version of your resume. Replace it with the selected version?` : `The employer's site already has “${name}” attached. Remove it? (Your selected resume “${resumeFile.name}” is attached either way.)`, kind: "radio" as const, required: true, options: ["Remove", "Keep"], reason: "attachment", sensitive: false, hint: null, rememberable: false })));
          }
          if (r.result === "uploaded") await set({}, "uploaded_resume", { file: resumeFile.name, sha256: row!.resumeSha256 });
          resumeHandled = r.result !== "no_input";
          if (r.result === "uploaded" && parsedMode && (await waitForParsing(page, fillingStep.step))) {
            fillingStep = null;
            continue; // Workday moved on to the parsed form: read it afresh
          }
        }
        const sections = await fillWorkdaySections(page);
        const generic = await fillPage(page, { uploadInPlan: false, parsedMode });
        const questions = [...sections.questions, ...generic.questions];
        fillingStep = null;
        if (questions.length) {
          await shot(page, `step-${st.index ?? i + 1}`);
          return visible ? manual(page, "workday", reasonFor(questions), questions) : pause(reasonFor(questions), questions);
        }
      } catch (e) {
        fillingStep = null;
        if (e instanceof StepMoved) {
          lastStep = "";
          continue; // the page moved on (e.g. the user clicked Continue): read the new step
        }
        if (isTimeout(e)) return visible ? manual(page, "workday", "unexpected_page") : pause("unexpected_page", [], { errorCode: "page_slow" });
        throw e;
      }
      // Save and Continue. Workday validates on the server; errors keep us on the same step.
      if (!(await clickNext(page, t.stepReady))) {
        await shot(page, `step-${st.index ?? i + 1}-stuck`);
        return visible ? manual(page, "workday", "unexpected_page") : pause("unexpected_page", [], { errorCode: "next_not_available" });
      }
      await sleep(800);
      st = await wdSettle(page);
      const after = `${st.step ?? ""}|${st.pageId ?? ""}`;
      if (after === name && st.kind === "step") {
        // A hidden file input with an uploaded file listed next to it is not "empty".
        const uploaded = (await page.locator('[data-automation-id="file-upload-item"]').count()) > 0;
        const fields = (await scan(page)).filter((f) => f.visible && (f.invalid || (f.required && isEmpty(f.value) && !f.group && !(f.control === "file" && uploaded))));
        if (st.errors.length || fields.length) {
          // Exactly the fields the site rejected — the rest of the application is kept as is.
          const qs = fields.map((f) => question(f, f.group ? `${f.group}:${f.groupIndex}:${f.wdField}` : fieldKey(f), "not_accepted", false, st.errors.find((e) => norm(e).includes(norm(f.label).slice(0, 20))) ?? st.errors.join(" | ").slice(0, 300), qmOf(f)));
          await shot(page, `step-${st.index ?? i + 1}-errors`);
          if (qs.length) return pause("missing_information", qs, { errorMessage: st.errors.join(" | ").slice(0, 600) });
          return pause("validation_errors", [], { errorCode: "step_rejected", errorMessage: st.errors.join(" | ").slice(0, 600) });
        }
        // No error shown and still on the same step: the site may be saving; never loop endlessly.
        if (++stuck >= 2) return visible ? manual(page, "workday", "unexpected_page") : pause("unexpected_page", [], { errorCode: "step_not_advancing" });
      } else stuck = 0;
    }

    // ---- Review
    const st = await wdState(page);
    if (st.kind !== "review") return visible ? manual(page, "workday", "unexpected_page") : pause("unexpected_page");
    await shot(page, "review");
    const gate = await submitGate(page, "workday");
    if (gate) return gate;
    await markSubmitting();
    await nextButton(page).click();
    const until = Date.now() + t.afterSubmit;
    const started = Date.now();
    while (Date.now() < until) {
      await sleep(500);
      const x = await wdState(page).catch(() => null);
      if (!x) continue;
      if (x.kind === "confirmation") return verified(page, x.confirmation, stripQuery(page.url()), "page");
      // Workday reports problems on the review page: the application was not accepted.
      if (x.kind === "review" && x.errors.length && Date.now() - started > 2500) {
        await shot(page, "rejected");
        return visible ? manual(page, "workday", "validation_errors") : pause("validation_errors", [], { errorCode: "validation_errors", errorMessage: x.errors.join(" | ").slice(0, 600) });
      }
      if ((await signals(page).catch(() => null))?.challenge && Date.now() - started > 4000) return visible ? manual(page, "workday", "captcha") : unconfirmed(page, "captcha_after_submit");
    }
    return visible ? manual(page, "workday", "unexpected_page") : unconfirmed(page, "no_confirmation");
  }

  /**
   * After the resume upload on "Autofill with Resume": waits while Workday parses it. True when the
   * page moved on to the parsed form by itself; false when it waits for "Continue" (clicked next).
   */
  async function waitForParsing(page: Page, stepBefore: string): Promise<boolean> {
    const until = Date.now() + t.stepReady;
    while (Date.now() < until) {
      await checkCancel();
      const now = await activeStep(page);
      if (now && now !== stepBefore && !(await isAutofillUpload(page))) return true;
      const st = await wdState(page).catch(() => null);
      if (st?.kind === "step" && (await nextButton(page).isEnabled().catch(() => false)) && (await wdReady(page, 3000)) > 0) {
        await sleep(1000);
        const again = await activeStep(page);
        return !!again && again !== stepBefore && !(await isAutofillUpload(page));
      }
      await sleep(500);
    }
    return false;
  }

  /**
   * Verification e-mail (opt-in): finds Workday's message in Gmail and enters the code or opens the
   * verification link on the employer's site. Never logs or stores the code, link or message.
   */
  async function verifyByEmail(page: Page, since: number): Promise<"ok" | "none"> {
    const mail = deps.mail;
    const email = planCtx.profile.contact.email?.trim() ?? null;
    if (!mail || !(await mail.configured(email))) return "none";
    const tenant = tenantOf(page.url());
    await set({ stage: "workday_verify_email" }, "workday_mail_waiting", { tenant });
    const v = await mail.waitForWorkday({ tenant, since, timeoutMs: t.mailWait, fallbackAddress: email, stop: cancelled });
    if (!v) {
      await set({}, "workday_mail_not_found");
      return "none";
    }
    if (v.code && (await codeInput(page).count())) {
      const r = await submitVerificationCode(page, v.code);
      if (r === "ok") {
        await set({ stage: "filling" }, "workday_email_verified", { via: "code" });
        return "ok";
      }
      await set({}, "workday_mail_code_rejected");
      return "none";
    }
    if (v.link) {
      const host = tenantOf(v.link);
      if (host !== tenant && !/(^|\.)(myworkdayjobs|myworkday|myworkdaysite)\.com$/i.test(host.split(":")[0])) return "none";
      const back = page.url();
      await goto(page, v.link, t.navigation);
      await sleep(1500);
      await set({ stage: "filling" }, "workday_email_verified", { via: "link" });
      // Back to the application (Workday usually asks to sign in again).
      if (tenantOf(page.url()) !== tenant || !(await page.locator('[data-automation-id="applyFlowPage"], [data-automation-id="signInContent"]').count())) await goto(page, back, t.navigation);
      return "ok";
    }
    await set({}, "workday_mail_not_found");
    return "none";
  }

  /**
   * Workday candidate account, as authorised for THIS application (account_mode):
   *  - sign_in: a saved credential (Keychain) is used — once; a failure is never retried automatically
   *  - create: if no credential exists, a new account is registered with the e-mail from My Profile and
   *    a generated (or the user's shared) password, saved to the Keychain BEFORE submitting. Agreements
   *    on the registration form need the user's approval. Verification e-mails, CAPTCHAs, SSO, existing
   *    accounts and unclear results are handed to the user.
   * Returns "continue" (signed in), "user" (the normal hand-off applies) or a paused state.
   */
  async function workdayAccount(page: Page, tried: { signIn: boolean; create: boolean; mail: boolean }): Promise<AttemptState | "continue" | "user"> {
    const acc = deps.accounts!;
    const email = planCtx.profile.contact.email?.trim();
    if (!email) return "user";
    // In a visible window an earlier failed try of THIS attempt is left to the user (never retried).
    if (visible && (await signInTriedBefore())) return "user";
    const tenant = tenantOf(page.url());
    if (acc.blocked(tenant, email)) return pause("login_required", [], { stage: "workday_sign_in", errorCode: "sign_in_failed_recently" });
    const has = await acc.hasCredential(tenant, email);
    if (has && !tried.signIn) {
      tried.signIn = true;
      const pw = await acc.password(tenant, email);
      if (!pw) return "user";
      await set({ stage: "workday_sign_in" }, "workday_sign_in_attempt", { tenant });
      const t0 = Date.now();
      let r = await workdaySignIn(page, email, pw);
      if (r === "verify" && !tried.mail) {
        tried.mail = true;
        if ((await verifyByEmail(page, t0 - 15 * 60_000)) === "ok") r = "ok";
      }
      if (r === "ok") {
        acc.mark(tenant, email, { status: "signed_in", last_sign_in_at: Date.now(), last_failure_at: null, last_failure_code: null });
        await set({ stage: "filling" }, "workday_signed_in_auto", { tenant });
        return "continue";
      }
      if (r === "invalid" || r === "locked") {
        acc.mark(tenant, email, { last_failure_at: Date.now(), last_failure_code: r });
        return pause("login_required", [], { stage: "workday_sign_in", errorCode: r === "locked" ? "account_locked" : "sign_in_failed" });
      }
      if (r === "verify") return pause("login_required", [], { stage: "workday_verify_email", errorCode: "verification_required" });
      if (r === "captcha") return pause("captcha");
      return pause("login_required", [], { stage: "workday_sign_in", errorCode: "sign_in_unclear" });
    }
    if (!has && row!.accountMode === "create" && !tried.create) {
      tried.create = true;
      const terms = await accountTermsLabel(page);
      const termsKey = `account_terms:${tenant}`;
      if (terms && planCtx.answers[termsKey] !== true) {
        return pause("approval_needed", [{ key: termsKey, label: terms.slice(0, 500), kind: "checkbox", required: true, options: [], reason: "legal", sensitive: true, hint: null, rememberable: false, meaning: "account_terms" }]);
      }
      const np = await acc.newPassword();
      if (!np) return pause("login_required", [], { stage: "workday_sign_in", errorCode: "shared_password_missing" });
      await acc.save(tenant, email, np.password, np.mode, "pending");
      await set({ stage: "workday_create_account" }, "workday_account_creating", { tenant });
      const t0 = Date.now();
      let r = await workdayCreateAccount(page, email, np.password, !!terms);
      // No clear answer on the page: a verification e-mail from Workday confirms the account was made.
      if (r === "unknown" && deps.mail && (await deps.mail.configured(email))) {
        const st = await wdState(page).catch(() => null);
        if (st?.kind !== "step" && st?.kind !== "review") r = "verify";
      }
      if (r === "ok" || r === "verify") {
        acc.mark(tenant, email, { status: "created" });
        await set({}, "workday_account_created", { tenant });
        if (r === "verify") {
          tried.mail = true;
          if ((await verifyByEmail(page, t0 - 60_000)) === "ok") return "continue";
          return pause("login_required", [], { stage: "workday_verify_email", errorCode: "verification_required" });
        }
        return "continue";
      }
      // Not created: the unused generated password is removed again (a shared one stays the user's).
      if (r === "exists" || r === "policy" || r === "captcha") {
        if (np.mode === "unique") await acc.forget(tenant, email);
        if (r === "captcha") return pause("captcha");
        return pause("login_required", [], { stage: "workday_sign_in", errorCode: r === "exists" ? "account_exists" : "password_policy" });
      }
      // Unclear: keep the saved credential — the account may exist.
      return pause("login_required", [], { stage: "workday_sign_in", errorCode: "account_unclear" });
    }
    return "user";
  }

  /** Did an earlier run of THIS attempt already try the saved password (and not get in)? */
  async function signInTriedBefore(): Promise<boolean> {
    const steps = ((await current())?.steps as { code: string }[] | null) ?? [];
    const i = steps.map((x) => x.code).lastIndexOf("workday_sign_in_attempt");
    return i >= 0 && !steps.slice(i).some((x) => x.code === "workday_signed_in_auto");
  }

  /** Did an earlier run of THIS attempt upload the selected resume (same pinned SHA-256)? */
  async function uploadedEarlier(): Promise<boolean> {
    const r = await current();
    return ((r?.steps as { code: string; params?: Record<string, unknown> }[] | null) ?? []).some((x) => x.code === "uploaded_resume" && x.params?.sha256 === row!.resumeSha256);
  }

  // ================================================================ filling

  /**
   * Scan → plan → fill → verify the visible, non-panel fields of the current page, in passes:
   * conditional questions that appear after an answer are planned in the next pass. Values the page
   * already holds correctly are kept (never erased and re-typed); a pre-filled value that My Profile
   * contradicts is corrected; pre-filled values My Profile can't confirm are kept and listed for Review.
   */
  async function fillPage(page: Page, opts: { uploadInPlan: boolean; parsedMode?: boolean }): Promise<{ questions: PendingQuestion[] }> {
    const questions: PendingQuestion[] = [];
    const handled = new Set<string>();
    let uploaded = false;
    for (let pass = 0; pass < 3; pass++) {
      let fields = await scan(page);
      if (!opts.uploadInPlan) fields = fields.filter((f) => f.control !== "file");
      const fresh = fields.filter((f) => f.visible && !handled.has(fieldKey(f)));
      if (!fresh.length) break;
      let plan = planForm(fresh, planCtx);
      const upload = plan.actions.find((a) => a.kind === "upload");
      if (upload && !uploaded) {
        // Resume first: some systems (e.g. Lever) parse it and pre-fill fields, which are then checked.
        await page.locator(`[data-ca-ref="${upload.ref}"]`).setInputFiles(resumeFile);
        await set({}, "uploaded_resume", { file: resumeFile.name, sha256: row!.resumeSha256 });
        uploaded = true;
        await sleep(1200);
        fields = await scan(page);
      }
      const now = await enrichOptions(page, fields.filter((f) => f.visible && !handled.has(fieldKey(f))), checkStep);
      plan = planForm(now, planCtx);
      const before = new Map(now.map((f) => [f.ref, f.value]));
      for (let i = 0; i < plan.actions.length; i++) {
        await checkCancel();
        await checkStep();
        if (plan.actions[i].kind === "upload") continue;
        // The page may have re-rendered since the scan (React): find the control again by its identity.
        plan.actions[i] = (await refreshAction(page, plan.actions[i])) ?? plan.actions[i];
        await perform(page, plan.actions[i]).catch(() => {});
      }
      const after = await scan(page);
      const ok = verify(plan.actions, after, resumeFile);
      allFilled = allFilled.concat(
        plan.actions.map((a) => ({ label: (a.label || a.key).slice(0, 300), source: a.source, verified: ok.has(a.ref), status: (opts.parsedMode && !isEmpty(before.get(a.ref)) ? "corrected" : "filled") as "corrected" | "filled" })),
        plan.kept.map((k) => ({ label: (k.label || k.key).slice(0, 300), source: k.source, verified: true, status: "kept" as const })),
      );
      questions.push(...plan.questions.filter((q) => !questions.some((x) => x.key === q.key)));
      for (const a of plan.actions.filter((x) => !ok.has(x.ref))) {
        if (a.kind === "upload") throw new Stop("resume_upload_failed");
        const f = after.find((x) => fieldKey(x) === a.key) ?? now.find((x) => x.ref === a.ref);
        if (f && f.required && !questions.some((q) => q.key === a.key)) questions.push(question(f, a.key, "not_accepted", false, null, qmOf(f)));
      }
      // Pre-filled by the site (resume parsing) and not confirmed by My Profile: kept, shown at Review.
      const planned = new Set([...plan.actions.map((a) => a.key), ...plan.kept.map((k) => k.key), ...plan.questions.map((q) => q.key)]);
      for (const f of now) {
        const key = fieldKey(f);
        handled.add(key);
        const v = Array.isArray(f.value) ? f.value.join(", ") : typeof f.value === "string" ? f.value : "";
        if (!opts.parsedMode || !v || planned.has(key) || planCtx.handled?.has(key) || f.control === "file" || f.group || f.demographic) continue;
        allFilled.push({ label: (f.label || key).slice(0, 300), source: "site", verified: false, status: "parsed", value: v.slice(0, 300) });
      }
    }
    // Before moving on: every visible required field must have a value (nothing left for the site to reject).
    for (const f of await scan(page)) {
      if (!f.visible || !f.required || f.group || f.control === "file" || !isEmpty(f.value)) continue;
      const key = fieldKey(f);
      if (!questions.some((q) => q.key === key)) questions.push(question(f, key, "missing", false, null, qmOf(f)));
    }
    await set({ filled: allFilled }, "filled", { count: allFilled.filter((x) => x.verified).length, total: allFilled.length });
    return { questions };
  }

  /** Workday sections (work, education, websites, languages, skills, source) — see wd-sections.ts. */
  async function fillWorkdaySections(page: Page): Promise<{ questions: PendingQuestion[] }> {
    const r = await fillSections({
      page,
      profile: planCtx.profile,
      answers: planCtx.answers,
      employer: planCtx.employer ?? null,
      jobSource,
      guard: async () => {
        await checkCancel();
        await checkStep();
      },
      record: (f) => {
        allFilled.push(f);
      },
      event: async (code, params) => {
        await set({ filled: allFilled }, code, params);
      },
      diag: (section, fields, note) => diagnose(page, section, fields, note),
      equivalent: deps.aiAssist ? (purpose, value, options) => deps.aiAssist!(purpose, value, options) : undefined,
    });
    planCtx.handled = new Set([...(planCtx.handled ?? []), ...r.handled]);
    await set({ filled: allFilled }, "filled", { count: allFilled.filter((x) => x.verified).length, total: allFilled.length });
    return { questions: r.questions };
  }

  /**
   * Local diagnostic snapshot of a section that could not be completed: a screenshot (local only, like
   * other evidence) and its structure — labels, control kinds, whether a value is present, how many
   * options — never the values themselves.
   */
  async function diagnose(page: Page, section: string, fields: FieldDescriptor[], note: string) {
    try {
      const dir = deps.evidenceDir(attemptId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const shape = fields.map((f) => ({ label: f.label.slice(0, 120), control: f.control, field: f.wdField ?? null, group: f.group ?? null, index: f.groupIndex ?? null, required: f.required, has_value: !isEmpty(f.value), options: f.options.length }));
      writeFileSync(join(dir, `diag-${section}-${Date.now()}.json`), JSON.stringify({ section, note, at: new Date().toISOString(), url_path: new URL(page.url()).pathname.replace(/[^/]{24,}/g, "…"), fields: shape }, null, 2), { mode: 0o600 });
      await shot(page, `diag-${section}`.slice(0, 40));
      await set({}, "section_diagnosed", { section, note });
    } catch {
      /* diagnostics are best effort */
    }
  }

  // ================================================================ submit / outcome

  /** Pauses unless submission is authorised and nothing (CAPTCHA, cancel) is in the way. */
  async function submitGate(page: Page, ats: Ats | null): Promise<AttemptState | null> {
    row = (await current())!;
    if (!row.submitAuthorized) return visible ? manual(page, ats, "submit_approval") : pause("submit_approval");
    // Values only the site's resume parsing provided are shown at Review: automatic submission waits
    // for the user's explicit approval of them.
    const approvedByUser = ((row.steps as { code: string }[] | null) ?? []).some((x) => x.code === "submit_approved");
    if (!approvedByUser && allFilled.some((f) => f.status === "parsed")) {
      await set({ submitAuthorized: 0 });
      return visible ? manual(page, ats, "submit_approval") : pause("submit_approval", [], { errorCode: "parsed_values_need_review" });
    }
    if ((await signals(page)).challenge) return visible ? manual(page, ats, "captcha") : pause("captcha");
    await checkCancel();
    return null;
  }

  async function markSubmitting() {
    await set({ state: "submitting", stage: "submitting", submitClickedAt: row!.submitClickedAt ?? Date.now(), submitAuthorized: 0 }, "submit_clicked");
    clickedThisRun = true;
  }

  async function unconfirmed(page: Page, code: string): Promise<AttemptState> {
    await shot(page, "result");
    await set({ state: "submission_unconfirmed", stage: null, finishedAt: Date.now(), errorCode: code }, "unconfirmed");
    return "submission_unconfirmed";
  }

  async function verified(page: Page, text: string | null, url: string, source: "page" | "user"): Promise<AttemptState> {
    await shot(page, "confirmation");
    const ts = Date.now();
    await set({ state: "submitted_verified", stage: null, confirmationText: text, confirmationUrl: url, confirmationSource: source, confirmedAt: ts, finishedAt: ts, intervention: null, questions: [] }, "verified");
    const r = await current();
    if (r) await syncApplied(db, r.userId, r as AttemptRow);
    return "submitted_verified";
  }

  /**
   * Visible window: waits for the user (sign-in, CAPTCHA) until `done()`; false on close / timeout.
   * If the attempt was changed meanwhile (answered → re-queued), the run ends without overwriting it.
   */
  async function waitForUser(page: Page, done: () => Promise<boolean>, reason: InterventionReason): Promise<boolean> {
    await set({ state: "needs_review", intervention: reason, stage: "waiting_for_you" }, "waiting_for_you", { reason });
    const until = Date.now() + t.manual;
    while (Date.now() < until) {
      if (page.isClosed()) return false;
      if (await cancelled()) throw new Stop("cancelled");
      const r = await current();
      if (!r || r.state !== "needs_review") throw new Superseded((r?.state as AttemptState) ?? "failed");
      if (await done().catch(() => false)) {
        await set({ state: "filling", intervention: null, stage: "filling" });
        return true;
      }
      await sleep(1000);
    }
    return false;
  }

  /** Followed from Indeed to a site Career Atlas can't fill: the user applies; we watch for a confirmation. */
  async function employerManual(page: Page): Promise<AttemptState> {
    await set({ state: "needs_review", intervention: "employer_site_manual", route: "employer_manual", stage: "manual" }, "employer_site_manual", { host: hostOf(page.url()) });
    const posts = trackSubmissions(page);
    const until = Date.now() + t.manual;
    while (Date.now() < until) {
      if (page.isClosed()) break;
      if (await cancelled()) throw new Stop("cancelled");
      const r = await current();
      if (!r || r.state !== "needs_review") return (r?.state as AttemptState) ?? "failed";
      const s = await signals(page).catch(() => null);
      if (s && posts.posted()) {
        const o = classifyAfterSubmit(null, s, true);
        if (o.kind === "verified") return verified(page, o.text, o.url, "page");
      }
      await sleep(1000);
    }
    return pause("confirm_result", [], { route: "employer_manual" });
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
      const r = await current();
      if (!r || r.state !== "needs_review" || r.cancelRequestedAt || deps.isCancelled(attemptId)) {
        if (r?.state === "cancelled" || r?.cancelRequestedAt) {
          if (posts.posted()) break;
          await set({ state: "cancelled", stage: null, finishedAt: Date.now(), intervention: null, visible: 0 }, "cancelled");
          return "cancelled";
        }
        return (r?.state as AttemptState) ?? "failed"; // answered/re-queued: a new run takes over
      }
      if (posts.posted() && r.stage !== "manual_posted") await set({ stage: "manual_posted", submitClickedAt: r.submitClickedAt ?? Date.now() }, "submitted_by_user");
      if (ats === "workday") {
        const x = await wdState(page).catch(() => null);
        if (x?.kind === "confirmation" && posts.posted()) return verified(page, x.confirmation, stripQuery(page.url()), "page");
      } else {
        const s = await signals(page).catch(() => null);
        if (s) {
          const o = classifyAfterSubmit(ats, s, posts.posted());
          if (o.kind === "verified") return verified(page, o.text, o.url, "page");
        }
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

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);

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

function submitButton(page: Page, ats: Ats | null) {
  const generic = page.getByRole("button", { name: /^submit( (my )?application)?$/i });
  if (ats === "lever") return page.locator('#btn-submit, button[data-qa="btn-submit"]').or(generic).first();
  if (ats === "greenhouse") return page.locator('form#application-form button[type="submit"], form#application_form #submit_app, form#application_form input[type="submit"]').or(generic).first();
  return generic.first();
}

/** Watches for a form submission request (POST/PUT to the site itself, not analytics). */
function trackSubmissions(page: Page) {
  let seen = false;
  const host = hostOf(page.url());
  const onReq = (req: { method(): string; url(): string }) => {
    if (!["POST", "PUT"].includes(req.method())) return;
    const h = hostOf(req.url());
    if (h && (h === host || /(^|\.)greenhouse\.io$|(^|\.)lever\.co$|\.myworkdayjobs\.com$|\.myworkday\.com$/.test(h))) seen = true;
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

/**
 * An action whose element was replaced by a re-render gets the new element (same field key), with
 * its option / date-part references remapped. Unchanged when the element is still there.
 */
async function refreshAction(page: Page, a: PlannedAction): Promise<PlannedAction | null> {
  if (await page.locator(`[data-ca-ref="${a.ref}"]`).count()) return a;
  const f = (await scan(page)).find((x) => x.visible && !x.group && fieldKey(x) === a.key);
  if (!f) return null;
  const next = { ...a, ref: f.ref } as PlannedAction;
  if (next.kind === "choose" && next.optionRefs) next.optionRefs = next.values.map((v) => f.options.find((o) => norm(o.label) === norm(v))?.ref).filter((x): x is string => !!x);
  if (next.kind === "date") next.parts = f.parts ?? next.parts;
  return next;
}

const isTimeout = (e: unknown) => (e as Error)?.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(String((e as Error)?.message ?? ""));

function errorCode(e: unknown): string {
  const m = String((e as Error)?.message ?? "");
  if ((e as Error)?.name === "TimeoutError" || /Timeout/.test(m)) return "timeout";
  if (/net::ERR_|NS_ERROR|ECONNREFUSED|ENOTFOUND/.test(m)) return "navigation_failed";
  if (/Executable doesn't exist|browserType\.launch|Failed to launch/.test(m)) return "browser_launch_failed";
  if (/Target (page|closed)|has been closed/.test(m)) return "browser_closed";
  return "worker_error";
}

export const _test = { verify, stripQuery };
