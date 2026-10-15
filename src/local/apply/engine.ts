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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
import type { PublicFacts } from "./codex-agent";
import { createAgent, type Proposer } from "./browser-agent";
import { APPLY_CTA_RE, MARK_SUBMIT, PAGE_MAP, pageState, type PageMap, type PageState } from "./page-intent";
import { PAGE_SIGNALS } from "./dom";
import { decideAdvance, decideNavigation, safeClickName, type PageObservation } from "./generic";
import { commitOpenSections, enrichOptions, frameView, handleNotices, navigationSafe, perform, readMenu, scan, verify } from "./interact";
import { classifyIndeedUrl } from "./indeed";
import { applicationUrl, atsFromSignals, classifyAfterSubmit, stripQuery, successSentence, type Ats, type PageSignals } from "./outcome";
import { fieldKey, norm, planForm, question, type FieldDescriptor, type PlanContext, type PlannedAction } from "./plan";
import { fillSections } from "./wd-sections";
import { fillRows } from "./rows";
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
  /**
   * Unfamiliar pages: pick one visible control to press. The model sees button names and labels only.
   * The engine refuses Submit, sign-in and account creation even if the model asks for them.
   */
  pageAgent?: ((obs: { buttons: string[]; labels: string[] }) => Promise<string | null>) | null;
  /** Unfamiliar closed questions: pick an option from boolean facts (has email, has phone, job source). Never profile values. */
  chooseOption?: ((label: string, options: string[], facts: PublicFacts) => Promise<string | null>) | null;
  /**
   * Runtime browser agent for pages the built-in flows do not understand: returns the action proposer
   * (the authorised GPT provider, no tools) when one is available. See browser-agent.ts.
   */
  browserAgent?: (() => Promise<Proposer | null>) | null;
  /** Tests: fewer agent steps. */
  agentMaxSteps?: number;
}

/** What the attempt shows while a generic site is being worked on. */
const STAGE_OF: Record<PageState, string> = { posting: "on_posting", application: "filling", questions: "filling", login: "sign_in", unknown: "reading_page" };

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
  let agentRan = false;
  let agent: ReturnType<typeof createAgent> | null = null;
  let agentOpen: PendingQuestion[] = [];
  let jobTitle: string | null = null;
  /** Generic sites: an Apply / guest action led into the application (verified on the next page). */
  let inWorkflow = false;
  let lastState: PageState | null = null;
  /** Application milestones reached in this run (posting → apply → application → form → review). */
  const milestones = new Set<string>();
  const milestone = async (m: "posting_identified" | "apply_clicked" | "application_entered" | "form_found" | "review_reached") => {
    if (milestones.has(m)) return;
    milestones.add(m);
    await set({}, m);
  };
  let ctx: BrowserContext | null = null;
  let allFilled: FilledField[] = [];
  let resumeFile = { name: "", mimeType: "", buffer: Buffer.alloc(0) };
  let planCtx: PlanContext = { profile: emptyProfile(), jobCountry: null, answers: {}, resume: { fileName: "" } };
  let jobSource: JobSource = null;
  let genericSignInTried = false;
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
    jobTitle = posting?.title ?? null;
    jobSource = jobSourceOf({ sourcePlatform: posting?.sourcePlatform, originalUrl: posting?.originalUrl, route: row.route, sourceUrl: row.sourceUrl });
    planCtx = { profile, jobCountry: posting?.country ?? null, answers: (row.answers as Record<string, unknown> | null) ?? {}, resume: { fileName: resumeFile.name }, employer: company?.name ?? null, jobSource };

    // ---- open
    await checkCancel();
    ctx = await launchBrowser({ profileDir: deps.profileDir, headless: !visible || !!deps.forceHeadless, choice: deps.choice, allowLoopback: allow });
    const page = navigationSafe(ctx.pages()[0] ?? (await ctx.newPage()));
    page.setDefaultTimeout(15_000);
    ctx.on("page", (p) => void navigationSafe(p)); // tabs a site opens (Apply in a new tab)
    // Browser dialogs: "leave this page?" → stay; alerts → OK; confirmations → never accepted blindly.
    page.on("dialog", (d) => {
      void (d.type() === "alert" ? d.accept() : d.dismiss()).catch(() => {});
    });
    await goto(page, row.targetUrl, t.navigation);
    if (classifyIndeedUrl(classificationUrl(page.url(), allow)) !== "external") return await indeedFlow(page);
    return await formFlow(page, row.route === "indeed_company_site");
  } catch (e) {
    if (e instanceof Superseded) return e.state; // a new run takes over; nothing is overwritten
    const code = e instanceof Stop ? e.code : errorCode(e);
    // Developer diagnostics only (never on by default): the error's first line, no field values.
    if (process.env.CA_APPLY_DEBUG && !(e instanceof Stop)) process.stderr.write(`ENGINE_ERROR ${String((e as Error)?.stack ?? e).split("\n").slice(0, 5).join(" | ")}\n`);
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

  /** Which control is being worked on (field label only — never a value); readable through the API. */
  async function progress(label: string) {
    await set({ stage: `filling: ${label.replace(/\s+/g, " ").slice(0, 80)}` });
  }

  function rowsCtx(page: Page) {
    return {
    page,
    profile: planCtx.profile,
    answers: planCtx.answers,
    guard: checkCancel,
    record: (f: FilledField) => {
      allFilled.push(f);
    },
    event: async (code: string, params?: Record<string, string | number>) => {
      await set({ filled: allFilled }, code, params);
    },
    progress,
    };
  }

  /**
   * Pop-ups read from the page: routine notices are acknowledged; a consent / declaration dialog is
   * accepted only with the user's approval for it (or, for a plain recruitment privacy notice, the
   * standing preference in Application Defaults) — otherwise the application pauses with it.
   */
  async function notices(page: Page): Promise<AttemptState | null> {
    const seen = await handleNotices(page);
    for (const n of seen) if (n.kind === "dismissed") await set({}, "notice_acknowledged", { button: n.button.slice(0, 40) });
    const consent = seen.find((n) => n.kind === "consent") as { kind: "consent"; text: string; checkbox: boolean } | undefined;
    if (!consent) return null;
    const key = `notice:${norm(consent.text).slice(0, 120)}`;
    const privacyOnly = /privacy|personal information|data protection/i.test(consent.text) && !/certif|attest|background|drug|criminal|signature|arbitration|non-?compete|true,? (accurate|correct)|authori[sz]e .*(contact|verify|release)/i.test(consent.text);
    const approved = planCtx.answers[key] === true || (privacyOnly && planCtx.profile.application_defaults.accept_privacy_notices === "yes");
    if (approved && (await acceptConsentDialog(page))) {
      await set({}, "consent_given", { kind: privacyOnly ? "privacy_notice" : "approved" });
      return null;
    }
    const q: PendingQuestion = { key, label: consent.text.slice(0, 500), kind: "checkbox", required: true, options: [], reason: "legal", sensitive: true, hint: null, rememberable: false, meaning: privacyOnly ? "privacy_notice" : "declaration" };
    await shot(page, "consent");
    return visible ? manual(page, null, "approval_needed", [q]) : pause("approval_needed", [q]);
  }

  async function acceptConsentDialog(page: Page): Promise<boolean> {
    const dlg = page.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .modal.show').filter({ visible: true }).last();
    if (!(await dlg.count())) return false;
    for (const cb of await dlg.locator('input[type="checkbox"]').all()) if (!(await cb.isChecked().catch(() => true))) await cb.check({ force: true }).catch(() => {});
    const btn = dlg.getByRole("button", { name: /^(i agree|agree|accept|i accept|continue|ok|confirm|i acknowledge|acknowledge)$/i }).first();
    if (!(await btn.isVisible().catch(() => false))) return false;
    await btn.click({ timeout: 5000 }).catch(() => {});
    await sleep(500);
    return true;
  }

  /**
   * Sign-in with a saved password on any site (the Workday account store is per host, so it works
   * for every employer site). One try per run; a rejected password is recorded and never retried.
   */
  async function genericSignIn(page: Page): Promise<"ok" | "failed" | "none"> {
    const acc = deps.accounts;
    const email = planCtx.profile.contact.email?.trim();
    if (!acc?.available || !email || !row!.accountMode || row!.accountMode === "none" || genericSignInTried) return "none";
    const site = tenantOf(page.url());
    if (acc.blocked(site, email) || !(await acc.hasCredential(site, email))) return "none";
    const pw = await acc.password(site, email);
    const user = page.locator('input[type="email"], input[autocomplete="username"], input[name*="mail" i], input[id*="mail" i], input[name*="user" i], input[id*="user" i]').filter({ visible: true }).first();
    const pass = page.locator('input[type="password"]').filter({ visible: true }).first();
    if (!pw || !(await user.count()) || !(await pass.count())) return "none";
    genericSignInTried = true;
    await set({ stage: "sign_in" }, "sign_in_attempt", { site });
    await user.fill(email).catch(() => {});
    await pass.fill(pw).catch(() => {});
    const btn = page.getByRole("button", { name: /^(sign in|log in|login|continue|next)$/i }).filter({ visible: true }).first();
    if (await btn.count()) await btn.click({ timeout: 8000 }).catch(() => {});
    else await pass.press("Enter").catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    // Signed in only when the password field stays gone on a page that has drawn its content (a
    // redirect shows a blank page for a moment — that is not success).
    let clear = 0;
    for (let w = 0; w < 40; w++) {
      await sleep(500);
      const sig = await signals(page);
      const drawn = (await observe(page)).names.length > 0;
      clear = !sig.password && drawn ? clear + 1 : 0;
      if (clear >= 4) {
        acc.mark(site, email, { status: "signed_in", last_sign_in_at: Date.now(), last_failure_at: null, last_failure_code: null });
        await set({ state: "filling", intervention: null, stage: "filling" }, "signed_in_auto", { site });
        return "ok";
      }
    }
    acc.mark(site, email, { last_failure_at: Date.now(), last_failure_code: "invalid" });
    return "failed";
  }

  /** A click that opened the application in a new tab: continue in that tab (the old one stays open). */
  async function adoptNewTab(current: Page, before: number): Promise<Page> {
    await sleep(300);
    const pages = ctx!.pages();
    if (pages.length <= before) return current;
    const fresh = pages[pages.length - 1];
    await fresh.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    if (fresh.url() === "about:blank") return current;
    await fresh.bringToFront().catch(() => {});
    await set({}, "followed_new_tab");
    return navigationSafe(fresh);
  }

  /** The page's structure and purpose (widgets marked out of the application) — see page-intent.ts. */
  async function observe(page: Page): Promise<PageMap> {
    return (await page.evaluate(PAGE_MAP)) as PageMap;
  }

  async function clickNamed(page: Page, name: string): Promise<boolean> {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    // Sites often render the same control twice (a hidden mobile copy first): click the first VISIBLE one.
    for (const role of ["button", "link"] as const) {
      const all = page.getByRole(role, { name: re });
      const n = Math.min(await all.count().catch(() => 0), 10);
      for (let i = 0; i < n; i++) {
        const loc = all.nth(i);
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await loc.click({ timeout: 8000 });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await sleep(600);
        return true;
      }
    }
    return false;
  }

  function facts(): PublicFacts {
    const c = planCtx.profile.contact;
    const t = planCtx.profile.application_defaults.phone_type;
    return { has_email: !!c.email, has_phone: !!c.phone, phone_type: t === "mobile" || t === "home" || t === "work" ? t : null, job_source: jobSource };
  }

  /**
   * A site that is not Workday, Greenhouse or Lever.
   *
   * The page's PURPOSE is established before anything on it is touched (page-intent.ts): site search,
   * job-alert sign-ups, cookie banners and site chrome are marked as not part of the application, and the
   * page is read as a posting, an application step, a sign-in step or unknown. On a posting or an
   * unfamiliar page the GPT agent (when available) decides the next step from that description; its action
   * is validated, executed and verified by Career Atlas. Profile values are filled only once the
   * application itself is on the page, and only inside it; the final Submit must belong to it.
   */
  async function genericFlow(page: Page, fromIndeed: boolean): Promise<AttemptState> {
    await set({ ats: null, stage: "opening" }, "opened_form");
    let cookieDismissed = false;
    const framesOpened = new Set<string>();
    const appliesClicked = new Set<string>();
    let lastSig = "";
    let repeats = 0;
    let aiSteps = 0;
    /** An Apply / guest action was taken from this address; the next page tells whether it led into the application. */
    let entryFrom: string | null = null;
    const propose = deps.browserAgent ? await deps.browserAgent().catch(() => null) : null;
    for (let step = 0; step < 16; step++) {
      await checkCancel();
      let s = await signals(page);
      if (s.greenhouseIframe) {
        await goto(page, s.greenhouseIframe, t.navigation);
        s = await signals(page);
      }
      if (atsFromSignals(s, allow)) return formFlow(page, fromIndeed);
      const consent = await notices(page);
      if (consent) return consent;
      let obs = await observe(page);
      // A page that has not drawn its controls yet (scripts still rendering after a redirect): wait until
      // it shows something and stops changing, instead of judging an empty page.
      for (let w = 0, last = -1; w < 30; w++) {
        const n = obs.names.length + obs.applicationFields;
        if (n > 0 && n === last) break;
        last = n;
        await sleep(n > 0 ? 500 : 700);
        obs = await observe(page);
      }
      s = await signals(page);
      // A sign-in / registration step (an e-mail box on ".../login" before any application fields) is the
      // candidate's account step: never filled with the profile here.
      const loginPage = /\/(log-?in|sign-?in|signin|logon|register|registration|account\/(login|create|signin))(\/|$|\?)/i.test(new URL(page.url()).pathname) && obs.semantics.length <= 2;
      let state = pageState(obs, { inWorkflow, login: s.password || loginPage });
      // VERIFY the entry: after Apply, the page must have changed into the application (or its sign-in step).
      if (entryFrom !== null) {
        if (state === "application" || state === "questions" || state === "login" || (page.url() !== entryFrom && state !== "posting")) {
          inWorkflow = true;
          await milestone("application_entered");
          state = pageState(obs, { inWorkflow, login: s.password || loginPage });
        }
        entryFrom = null;
      }
      if (state === "application") inWorkflow = true;
      lastState = state;
      if (state === "posting") await milestone("posting_identified");
      if (state === "application" || state === "questions") await milestone("form_found");
      await set({ stage: STAGE_OF[state] });
      const decision = decideNavigation(navView(obs, state), { password: s.password || loginPage, challenge: s.challenge, cookieDismissed });
      if (process.env.CA_APPLY_DEBUG) process.stderr.write(`GENERIC step=${step} url=${page.url().slice(0, 90)} state=${state} fields=${obs.applicationFields} sem=${obs.semantics.join(",")} widgets=${obs.widgets.map((w) => w.kind).join(",")} decision=${JSON.stringify(decision)} names=${JSON.stringify(obs.names.slice(0, 12))}\n`);
      // "Same situation again" means the same decision on the same CONTENT (single-page forms keep one URL).
      const sig = `${decision.action}:${"name" in decision ? decision.name : ""}:${page.url()}:${contentSig(obs)}`;
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      if (decision.action === "captcha") return visible ? manual(page, null, "captcha") : pause("captcha");
      if (decision.action === "login") {
        // A sign-in page on any site: with a password saved for this site (Keychain) and sign-in
        // allowed for this application, sign in once; otherwise the user signs in (or registers) in
        // the visible window and filling continues. In the background it pauses for that.
        const r = await genericSignIn(page);
        if (r === "ok") continue;
        if (r === "failed") return visible ? manual(page, null, "login_required") : pause("login_required", [], { stage: "sign_in", errorCode: "sign_in_failed" });
        if (!visible) return pause("login_required", [], { stage: "sign_in" });
        const ok = await waitForUser(page, async () => !(await signals(page)).password, "login_required");
        if (!ok) return pause("login_required", [], { stage: "sign_in" });
        await set({ state: "filling", intervention: null, stage: "filling" }, "signed_in_by_user");
        continue;
      }
      // Privacy-preserving cookie choice and "apply without an account" are fixed rules (no account, no consent).
      if (decision.action === "click" && decision.why !== "apply" && repeats < 2) {
        if (decision.why === "cookie") cookieDismissed = true;
        const tabs = ctx!.pages().length;
        const from = page.url();
        if (await clickNamed(page, decision.name)) {
          page = await adoptNewTab(page, tabs);
          if (decision.why === "guest") entryFrom = from;
          await set({ stage: "opening" }, "opened_form");
          continue;
        }
      }
      // The posting may live inside a large embedded frame (iCIMS and many company sites): work inside it
      // — once per frame — when this page itself offers nothing to apply with.
      const frame = (obs.frames ?? []).sort((a, b) => b.area - a.area).find((f) => !framesOpened.has(f.src) && !/captcha|datadome|recaptcha|hcaptcha|turnstile|youtube|vimeo|maps\.google|googletagmanager|doubleclick/i.test(f.src));
      if (frame && obs.semantics.length === 0 && state !== "posting") {
        framesOpened.add(frame.src);
        const real = page;
        const f = real.frames().find((x) => x.url() === frame.src) ?? real.frames().find((x) => x !== real.mainFrame() && frame.src.startsWith(x.url().split("?")[0]));
        if (f) {
          page = frameView(real, f);
          await set({ stage: "opening" }, "opened_embedded_form");
          continue;
        }
      }
      // UNDERSTAND + DECIDE on a posting or an unfamiliar page: the GPT agent reads the page (its widgets
      // marked as such) against the goal and proposes the next action; Career Atlas validates, executes and
      // verifies it. A refused or unhelpful proposal falls back to the fixed rules below.
      if (propose && (state === "posting" || state === "unknown") && aiSteps < 8) {
        aiSteps++;
        const r = await agentFor(propose).step(page);
        await set({}, "page_assessed", { state, by: "ai", action: r.kind === "acted" || r.kind === "refused" ? r.action.action : r.kind === "finish" ? `finish:${r.outcome.status}` : "stop", target: r.kind === "acted" || r.kind === "refused" ? r.target.slice(0, 60) : "" });
        if (r.kind === "acted" && r.ok) {
          const from = page.url();
          page = r.page;
          if (r.action.action === "click") {
            await milestone("apply_clicked");
            entryFrom = from;
          }
          continue;
        }
        if (r.kind === "stop" && r.outcome.status === "blocked" && /Indeed/.test(r.outcome.reason)) return fromIndeed && visible ? employerManual(page) : pause("unexpected_page", [], { errorCode: "indeed_not_automated" });
        // Refused (e.g. a job-alert button): the model sees why on its next look, unless the fixed rules have a step.
        if (r.kind === "refused" && decision.action !== "click") continue;
      }
      if (decision.action === "click" && repeats < 2) {
        const tabs = ctx!.pages().length;
        const from = page.url();
        if (await clickNamed(page, decision.name)) {
          page = await adoptNewTab(page, tabs);
          await milestone("apply_clicked");
          entryFrom = from;
          await set({ stage: "opening" }, "opened_form");
          continue;
        }
      } else if (decision.action === "fill") {
        // Repeated rows (employment / education) entry by entry, then the rest of the page — inside the
        // application only (widgets are marked out of scope and never scanned).
        const rows = await fillRows(rowsCtx(page));
        let { questions } = await fillPage(page, { uploadInPlan: true });
        questions = [...rows.questions, ...questions.filter((q) => !rows.questions.some((r) => r.key === q.key))];
        if (questions.some((q) => q.required && q.options.length) && deps.chooseOption) {
          let changed = false;
          let asked = 0;
          for (const q of questions) {
            if (!q.required || !q.options.length || asked >= 2) continue;
            asked++;
            const choice = await deps.chooseOption(q.label, q.options, facts()).catch(() => null);
            if (choice && q.options.includes(choice)) {
              planCtx.answers[q.key] = choice;
              changed = true;
            }
          }
          if (changed) questions = (await fillPage(page, { uploadInPlan: true })).questions;
        }
        // Inline section editors keep edits only after their own Update / Save button.
        if (await commitOpenSections(page)) await set({}, "sections_saved");
        if (!questions.some((q) => q.required)) {
          const now = await observe(page);
          const adv = decideAdvance(now.names);
          // Nothing to advance with yet, but an Apply control is still on the page (a tab or button
          // that reveals the form, e.g. "Apply" next to "Job details"): open it once.
          if (adv.action === "stuck") {
            const apply = now.names.find((n) => APPLY_CTA_RE.test(n) && !appliesClicked.has(n));
            if (apply) {
              appliesClicked.add(apply);
              const tabs = ctx!.pages().length;
              const from = page.url();
              if (await clickNamed(page, apply)) {
                page = await adoptNewTab(page, tabs);
                await milestone("apply_clicked");
                entryFrom = from;
                await set({ stage: "opening" }, "opened_form");
                continue;
              }
            }
          }
          if (adv.action === "click") {
            const before = `${page.url()}:${contentSig(now)}`;
            const tabs = ctx!.pages().length;
            await clickNamed(page, adv.name);
            page = await adoptNewTab(page, tabs);
            await sleep(400);
            if (`${page.url()}:${contentSig(await observe(page))}` === before && repeats >= 2) return visible ? manual(page, null, "unexpected_page") : pause("unexpected_page", [], { errorCode: "step_not_advancing" });
            await set({}, "next_step", { step: step + 2 });
            continue;
          }
          if (adv.action === "review") return reviewPage(page);
        }
        if (questions.length) {
          await shot(page, `step-${step + 1}`);
          return visible ? manual(page, null, reasonFor(questions), questions) : pause(reasonFor(questions), questions);
        }
      }
      if (deps.pageAgent && !propose && repeats < 3) {
        const suggestion = await deps.pageAgent({ buttons: obs.names, labels: obs.labels }).catch(() => null);
        const name = suggestion ? safeClickName(suggestion, obs.names) : null;
        const tabs = ctx!.pages().length;
        const from = page.url();
        if (name && (await clickNamed(page, name))) {
          page = await adoptNewTab(page, tabs);
          entryFrom = from;
          await set({}, "opened_form");
          continue;
        }
      }
      return agentOrStop(page, fromIndeed);
    }
    return agentOrStop(page, fromIndeed);
  }

  /** What the page shows (headings, controls, fields) — how a step change is recognised without a new URL. */
  function contentSig(m: PageMap): string {
    return `${m.headings.join("|")}#${m.names.join("|")}#${m.labels.join("|")}#${m.applicationFields}`;
  }

  /** The controls the fixed rules may act on, given what the page is: a posting has no application fields. */
  function navView(m: PageMap, state: PageState): PageObservation {
    const fields = state === "posting" ? 0 : m.applicationFields;
    const applyNames = m.names.some((n) => APPLY_CTA_RE.test(n)) ? [] : m.chromeNames.filter((n) => APPLY_CTA_RE.test(n));
    return { names: [...m.names, ...applyNames, ...m.cookieNames], cookieNames: m.cookieNames, applicationFields: fields, applicantFields: state === "posting" ? 0 : m.semantics.length, labels: m.labels, frames: m.frames };
  }

  /** The GPT agent for this run (one per run, so its memory of asked questions and failures is kept). */
  function agentFor(propose: Proposer) {
    agent ??= createAgent({
      goal: `Apply for "${jobTitle ?? "this job"}"${planCtx.employer ? ` at ${planCtx.employer}` : ""}`,
      inWorkflow: () => inWorkflow,
      planCtx,
      resume: resumeFile,
      propose,
      autofill: async (p) => {
        await observe(p);
        const rows = await fillRows(rowsCtx(p));
        const { questions } = await fillPage(p, { uploadInPlan: true });
        if (await commitOpenSections(p)) await set({}, "sections_saved");
        agentOpen = [...rows.questions, ...questions.filter((q) => !rows.questions.some((r) => r.key === q.key))].filter((q) => q.required);
        return { verified: allFilled.filter((f) => f.verified).length, open: agentOpen.map((q) => q.label.slice(0, 80)) };
      },
      guard: checkCancel,
      event: async (code, params) => {
        await set({ filled: allFilled }, code, params);
      },
      record: (f) => {
        allFilled.push(f);
      },
      trace: (e) => {
        // Structure and the model's reasoning only (labels, headings, actions) — never applicant values.
        if (process.env.CA_APPLY_DEBUG) process.stderr.write(`AGENT ${JSON.stringify(e)}\n`);
        try {
          const dir = deps.evidenceDir(attemptId);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          appendFileSync(join(dir, "agent-trace.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, { mode: 0o600 });
        } catch {
          /* best effort */
        }
      },
    });
    return agent;
  }

  /**
   * A page the built-in flows do not understand: the runtime browser agent (browser-agent.ts). The
   * authorised GPT provider proposes one action at a time from a description of the page; Career Atlas
   * validates it (never Submit, sign-in, passwords, declarations or identity answers), enters profile
   * values itself, executes it and verifies the result. Its "this is the final step" is checked here:
   * only a page that really shows Submit goes on to the usual approval gate.
   */
  async function agentOrStop(page: Page, fromIndeed: boolean): Promise<AttemptState> {
    const propose = deps.browserAgent && !agentRan ? await deps.browserAgent().catch(() => null) : null;
    if (!propose) {
      if (fromIndeed && visible) return employerManual(page);
      // Never "done" while the job posting is still what the page shows.
      if (lastState === "posting") {
        await shot(page, "posting");
        return visible ? manual(page, null, "unexpected_page") : pause("unexpected_page", [], { errorCode: "still_on_posting" });
      }
      throw new Stop("unsupported_site");
    }
    agentRan = true;
    await set({ state: "filling", stage: "ai_agent" }, "agent_started");
    const out = await agentFor(propose).run(page, deps.agentMaxSteps ?? 30);
    page = out.page;
    await set({ filled: allFilled }, "agent_finished", { status: out.status, steps: out.steps });
    const s = await signals(page);
    if (s.challenge) return visible ? manual(page, null, "captcha") : pause("captcha");
    const m = await observe(page);
    const state = pageState(m, { inWorkflow, login: s.password });
    lastState = state;
    if (state === "application" || state === "questions") await milestone("form_found");
    const questions = [...out.questions, ...agentOpen.filter((q) => !out.questions.some((x) => x.key === q.key))];
    // "Final step" is checked, not believed: reviewPage needs the application's own Submit on the page.
    if (!questions.some((q) => q.required) && (out.status === "review_ready" || m.submits.length > 0)) return reviewPage(page);
    if (s.password) return visible ? manual(page, null, "login_required") : pause("login_required", [], { stage: "sign_in" });
    await shot(page, "agent");
    if (questions.length) return visible ? manual(page, null, reasonFor(questions), questions) : pause(reasonFor(questions), questions);
    if (fromIndeed && visible) return employerManual(page);
    return visible ? manual(page, null, "unexpected_page") : pause("unexpected_page", [], { errorCode: state === "posting" ? "still_on_posting" : `agent_${out.status}` });
  }

  /** A generic page that shows the application's final Submit: stop for approval, or submit when authorised. */
  async function reviewPage(page: Page): Promise<AttemptState> {
    await shot(page, "filled");
    // Fail closed: the final step counts only inside an application this run actually reached, and the
    // Submit must be that application's own (inside its scope, not a widget's, exactly one form).
    if (!milestones.has("form_found")) return visible ? manual(page, null, "unexpected_page") : pause("unexpected_page", [], { errorCode: lastState === "posting" ? "still_on_posting" : "application_form_not_found" });
    await observe(page);
    const found = Number(await page.evaluate(MARK_SUBMIT).catch(() => 0));
    if (found !== 1) return visible ? manual(page, null, "unexpected_page") : pause("unexpected_page", [], { errorCode: found === 0 ? "submit_not_in_application" : "submit_ambiguous" });
    await milestone("review_reached");
    const submit = page.locator('[data-ca-submit="1"]').first();
    if (!(await submit.isVisible().catch(() => false))) return visible ? manual(page, null, "unexpected_page") : pause("unexpected_page");
    const gate = await submitGate(page, null);
    if (gate) return gate;
    const posts = trackSubmissions(page);
    await markSubmitting();
    await submit.click();
    const outcome = await waitForOutcome(page, null, posts, t.afterSubmit);
    if (outcome.kind === "verified") return verified(page, outcome.text, outcome.url, "page");
    if (outcome.kind === "validation_errors") {
      await shot(page, "rejected");
      return visible ? manual(page, null, "validation_errors") : pause("validation_errors", [], { errorCode: "validation_errors", errorMessage: outcome.errors.join(" | ").slice(0, 600) });
    }
    if (outcome.kind === "challenge" && !posts.posted()) return visible ? manual(page, null, "captcha") : pause("captcha");
    if (visible) return manual(page, null, outcome.kind === "email_code" ? "login_required" : "unexpected_page");
    return unconfirmed(page, outcome.kind === "email_code" ? "verification_code_required" : outcome.kind === "challenge" ? "captcha_after_submit" : "no_confirmation");
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
    if (!ats) return genericFlow(page, fromIndeed);
    if (!s.hasForm) throw new Stop("form_not_found");
    await set({ ats, stage: "filling" }, "detected_ats", { ats });

    for (let step = 0; step < MAX_FORM_STEPS; step++) {
      await checkCancel();
      // Repeated employment / education blocks first (entry by entry), then the rest of the form.
      const rows = await fillRows(rowsCtx(page));
      const page1 = await fillPage(page, { uploadInPlan: true });
      const questions = [...rows.questions, ...page1.questions.filter((q) => !rows.questions.some((r) => r.key === q.key))];
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
  async function fillPage(page: Page, opts: { uploadInPlan: boolean; parsedMode?: boolean; retried?: boolean }): Promise<{ questions: PendingQuestion[] }> {
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
      const alreadyUploaded = fields.some((f) => f.control === "file" && (Array.isArray(f.value) ? f.value : [String(f.value ?? "")]).some((n) => norm(n) === norm(resumeFile.name)));
      if (upload && !uploaded && !alreadyUploaded) {
        // Resume first: some systems (e.g. Lever) parse it and pre-fill fields, which are then checked.
        // Uploading again makes some sites wipe the answers already on the page.
        await page.locator(`[data-ca-ref="${upload.ref}"]`).setInputFiles(resumeFile);
        await set({}, "uploaded_resume", { file: resumeFile.name, sha256: row!.resumeSha256 });
        uploaded = true;
        // Ant Design clears the input and shows the name in its list, sometimes after an upload request.
        fields = await scan(page);
        for (let w = 0; w < 16 && !fields.some((f) => f.control === "file" && (Array.isArray(f.value) ? f.value : [String(f.value ?? "")]).some((n) => norm(n) === norm(resumeFile.name))); w++) {
          await sleep(500);
          fields = await scan(page);
        }
      }
      const now = await enrichOptions(page, fields.filter((f) => f.visible && !handled.has(fieldKey(f))), checkStep);
      plan = planForm(now, planCtx);
      const before = new Map(now.map((f) => [f.ref, f.value]));
      // Repeating editors (work, education) discard unsaved rows when something else is clicked.
      // Fill those rows and press their Update button before touching the rest of the page.
      const panelRefs = new Set(now.filter((f) => f.group === "work" || f.group === "education").map((f) => f.ref));
      const groupOf = new Map(now.map((f) => [f.ref, f.group]));
      const panelActions = plan.actions.filter((a) => panelRefs.has(a.ref) && a.kind !== "upload");
      const workActions = panelActions.filter((a) => groupOf.get(a.ref) === "work");
      const eduActions = panelActions.filter((a) => groupOf.get(a.ref) === "education");
      const rest = [...plan.actions.filter((a) => !panelRefs.has(a.ref))].sort((a, b) => Number(a.kind === "search" || a.kind === "choose") - Number(b.kind === "search" || b.kind === "choose"));
      const ordered = [...workActions, ...eduActions, ...rest];
      const run = async (list: PlannedAction[]) => {
        for (let i = 0; i < list.length; i++) {
          await checkCancel();
          await checkStep();
          if (list[i].kind === "upload") continue;
          await progress(list[i].label || list[i].key);
          list[i] = (await refreshAction(page, list[i])) ?? list[i];
          await perform(page, list[i]).catch(() => {});
        }
      };
      const closeMenus = async () => {
        await page.keyboard.press("Escape").catch(() => {});
      };
      // Returns true only when this panel's Update button closed the editor. A click elsewhere discards it.
      const commit = async (idPart: string): Promise<boolean> => {
        const field = page.locator(`[id*="${idPart}"]`).first();
        if (!(await field.count().catch(() => 0))) return false;
        await closeMenus();
        const update = field.locator("xpath=following::button[normalize-space()='Update'][1]");
        if (!(await update.isVisible().catch(() => false))) return false;
        await update.click({ timeout: 4000 }).catch(() => {});
        for (let w = 0; w < 8; w++) {
          if ((await page.locator(`[id*="${idPart}"]`).count().catch(() => 0)) === 0) return true;
          await sleep(200);
        }
        return false;
      };
      const confirmed = new Set<string>();
      const remember = async (list: PlannedAction[]) => {
        if (!list.length) return;
        for (const ref of verify(list, await scan(page), resumeFile)) confirmed.add(ref);
      };
      // If Update did not close the editor, keep only values the inputs still show.
      const keep = async (list: PlannedAction[], saved: boolean) => {
        if (saved) return;
        const still = verify(list, await scan(page), resumeFile);
        for (const a of list) if (!still.has(a.ref)) confirmed.delete(a.ref);
      };
      // Dropdown menus are portaled outside the editor. Clicking one discards the unsaved row,
      // so text, dates and checkboxes are saved first. Optional country menus stay for a later pass.
      const plain = (list: PlannedAction[]) => list.filter((a) => a.kind !== "search" && a.kind !== "choose");
      const workPlain = plain(workActions);
      const eduPlain = plain(eduActions);
      await run(workPlain);
      await remember(workPlain);
      await keep(workPlain, await commit("workHistory_"));
      if (!(await page.locator("[id*='educationHistory_']").count().catch(() => 0)) && eduPlain.length) {
        const add = page.getByRole("button", { name: /^add education history$/i }).first();
        if (await add.isVisible().catch(() => false)) {
          await add.click().catch(() => {});
          await sleep(400);
        }
      }
      await run(eduPlain);
      await remember(eduPlain);
      await keep(eduPlain, await commit("educationHistory_"));
      await closeMenus();
      await run(rest);
      plan.actions = ordered;
      const after = await scan(page);
      const ok = verify(plan.actions, after, resumeFile);
      for (const ref of confirmed) ok.add(ref);
      const incoming = plan.actions.map((a) => ({ label: (a.label || a.key).slice(0, 300), source: a.source, verified: ok.has(a.ref), status: (opts.parsedMode && !isEmpty(before.get(a.ref)) ? "corrected" : "filled") as "corrected" | "filled" }));
      allFilled = allFilled.filter((x) => !incoming.some((n) => n.label === x.label && n.source === x.source));
      allFilled = allFilled.concat(
        incoming,
        plan.kept.map((k) => ({ label: (k.label || k.key).slice(0, 300), source: k.source, verified: true, status: "kept" as const })),
      );
      questions.push(...plan.questions.filter((q) => !questions.some((x) => x.key === q.key)));
      for (const a of plan.actions.filter((x) => !ok.has(x.ref))) {
        if (a.kind === "upload") throw new Stop("resume_upload_failed");
        const f = after.find((x) => fieldKey(x) === a.key) ?? now.find((x) => x.ref === a.ref);
        if (f && f.required && !questions.some((q) => q.key === a.key)) questions.push(question(f, a.key, "not_accepted", false, null, qmOf(f)));
      }
      const verifiedKeys = new Set(plan.actions.filter((a) => ok.has(a.ref)).map((a) => a.key));
      for (let i = questions.length - 1; i >= 0; i--) if (verifiedKeys.has(questions[i].key)) questions.splice(i, 1);
      // Pre-filled by the site (resume parsing) and not confirmed by My Profile: kept, shown at Review.
      const planned = new Set([...plan.actions.map((a) => a.key), ...plan.kept.map((k) => k.key), ...plan.questions.map((q) => q.key)]);
      for (const f of now) {
        const key = fieldKey(f);
        const action = plan.actions.find((a) => a.key === key);
        // A value the page did not keep is tried again on the next pass (resume parsing often re-renders).
        if (action && !ok.has(action.ref)) continue;
        handled.add(key);
        const v = Array.isArray(f.value) ? f.value.join(", ") : typeof f.value === "string" ? f.value : "";
        if (!opts.parsedMode || !v || planned.has(key) || planCtx.handled?.has(key) || f.control === "file" || f.group || f.demographic) continue;
        allFilled.push({ label: (f.label || key).slice(0, 300), source: "site", verified: false, status: "parsed", value: v.slice(0, 300) });
      }
    }
    // A required menu we could not answer (Preferred Contact Method, for example) needs its option
    // labels so Review can ask. Open it only after repeating editors are saved — an outside click
    // discards an unsaved work or education row. Never choose an option here.
    const openEditor = page.locator("[id*='workHistory_'], [id*='educationHistory_']").locator("visible=true");
    const editorCount = await openEditor.count().catch(() => -1);
    if (editorCount === 0) {
      const open = await scan(page);
      for (const q of questions) {
        if (!q.required || q.options.length) continue;
        const f = open.find((x) => fieldKey(x) === q.key && x.visible && (x.control === "combobox" || x.control === "listbox"));
        if (!f) continue;
        const labels = await readMenu(page, f.ref).catch(() => []);
        if (labels.length) q.options = labels;
      }
    }
    // A value the site cleared after it was verified (a re-render or a reset), or a control that appeared
    // or became enabled only after the passes (State after Country): one more round — only then a question.
    if (!opts.retried) {
      await sleep(700);
      const verifiedLabels = new Set(allFilled.filter((x) => x.verified).map((x) => x.label));
      const again = (await scan(page)).filter((f) => f.visible && f.required && isEmpty(f.value) && !f.group && f.control !== "file" && (!handled.has(fieldKey(f)) || verifiedLabels.has((f.label || fieldKey(f)).slice(0, 300))));
      if (again.length) return fillPage(page, { ...opts, retried: true });
    }
    // Before moving on: every visible required field must have a value (nothing left for the site to reject).
    // A second copy of the same control (Dayforce renders some inputs twice) does not count when the other holds the value.
    const visibleFields = await scan(page);
    const valued = new Set(visibleFields.filter((f) => f.visible && !isEmpty(f.value)).map((f) => fieldKey(f)));
    for (const f of visibleFields) {
      const key = fieldKey(f);
      if (!f.visible || !f.required || f.group || f.control === "file" || valued.has(key)) continue;
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
    const posts = await trackUserSubmission(page);
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
    const posts = await trackUserSubmission(page);
    // What the page already says at hand-off is not a confirmation of anything the user did next.
    const baseline = await signals(page).then((x) => ({ text: successSentence(x.text), url: stripQuery(x.url) })).catch(() => ({ text: null as string | null, url: "" }));
    const fresh = (text: string | null, url: string) => !!text && (text !== baseline.text || url !== baseline.url);
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
          if (o.kind === "verified" && fresh(o.text, o.url)) return verified(page, o.text, o.url, "page");
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
/**
 * In a window the USER operates: a submission counts only after the user clicked a Submit-type
 * control AND the site then received a request. Sites keep sending background requests (analytics,
 * autosave) — on their own those never mean "submitted".
 */
async function trackUserSubmission(page: Page) {
  let clickedAt = 0;
  let postAfterClick = false;
  await page.exposeBinding("__caSubmitClick", () => {
    clickedAt = Date.now();
  }).catch(() => {});
  const install = String.raw`(() => { if (window.__caSubmitWatch) return; window.__caSubmitWatch = true;
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('button, input[type=submit], input[type=button], [role=button], a');
      if (!b) return;
      const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (/^(submit|submit (my |your )?application|send( my)? application|complete( my)? application|finish( and submit)?|confirm and submit)$/i.test(t) && window.__caSubmitClick) window.__caSubmitClick();
    }, true); })()`;
  await page.addInitScript(install).catch(() => {});
  await page.evaluate(install).catch(() => {});
  const host = hostOf(page.url());
  const onReq = (req: { method(): string; url(): string }) => {
    if (!clickedAt || !["POST", "PUT"].includes(req.method())) return;
    const h = hostOf(req.url());
    if (h && (h === host || /(^|\.)greenhouse\.io$|(^|\.)lever\.co$|\.myworkdayjobs\.com$|\.myworkday\.com$|\.dayforcehcm\.com$/.test(h))) postAfterClick = true;
  };
  page.on("request", onReq);
  return { posted: () => postAfterClick, stop: () => page.off("request", onReq) };
}

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
  // Workday panels are filled by their own adapter. Ordinary repeating blocks (a work-history row on
  // an unfamiliar form) must be found again after a re-render, or the fill hits a detached node.
  const f = (await scan(page)).find((x) => x.visible && fieldKey(x) === a.key && !(x.group && x.wdField));
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
