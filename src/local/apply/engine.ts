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
//   - CAPTCHAs, sign-ins, account creation and email codes are handed to the user, never bypassed;
//     Career Atlas never types passwords or creates accounts
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
import type { BrowserContext, Locator, Page } from "playwright-core";
import { eq } from "drizzle-orm";
import { schema, getDb } from "../../server/db/client";
import type { AppEnv } from "../../server/env";
import { sha256Hex } from "../../server/lib/util";
import { readDocumentBytes, syncApplied, updateAttempt, type AttemptRow } from "../../server/services/apply";
import { getProfileRow } from "../../server/services/profile";
import { launchBrowser, type BrowserChoice } from "./browser";
import { PAGE_SIGNALS, SCAN_FIELDS } from "./dom";
import { classifyIndeedUrl } from "./indeed";
import { applicationUrl, atsFromSignals, classifyAfterSubmit, stripQuery, type Ats, type PageSignals } from "./outcome";
import { fieldKey, filledSummary, norm, planForm, question, toAction, type FieldDescriptor, type PlanContext, type PlannedAction } from "./plan";
import { addButton, declineCookies, degreeOption, deletePanel, enterApplyFlow, nextButton, uploadResume, WD_OPTION_SEL, wdSettle, wdState } from "./workday";

const { applicationAttempts, documents, jobPostings } = schema;

export interface EngineDeps {
  env: AppEnv;
  choice: BrowserChoice;
  profileDir: string;
  evidenceDir: (attemptId: string) => string;
  allowLoopback: boolean;
  isCancelled: (attemptId: string) => boolean;
  timeouts?: Partial<{ navigation: number; afterSubmit: number; manual: number }>;
  /** Tests: run the visible-window logic in a headless browser. */
  forceHeadless?: boolean;
}

class Stop extends Error {
  constructor(public code: string) {
    super(code);
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
  const t = { navigation: 45_000, afterSubmit: 45_000, manual: 30 * 60_000, ...deps.timeouts };
  let row = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, attemptId) });
  if (!row || row.state !== "queued") return (row?.state as AttemptState) ?? "failed";
  const visible = !!row.visible;
  const evidence = new Set<string>((row.evidence as string[] | null) ?? []);
  let clickedThisRun = false;
  let ctx: BrowserContext | null = null;
  let allFilled: FilledField[] = [];
  let resumeFile = { name: "", mimeType: "", buffer: Buffer.alloc(0) };
  let planCtx: PlanContext = { profile: emptyProfile(), jobCountry: null, answers: {}, resume: { fileName: "" } };
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
    planCtx = { profile, jobCountry: posting?.country ?? null, answers: (row.answers as Record<string, unknown> | null) ?? {}, resume: { fileName: resumeFile.name } };

    // ---- open
    await checkCancel();
    ctx = await launchBrowser({ profileDir: deps.profileDir, headless: !visible || !!deps.forceHeadless, choice: deps.choice, allowLoopback: allow });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(15_000);
    await goto(page, row.targetUrl, t.navigation);
    if (classifyIndeedUrl(classificationUrl(page.url(), allow)) !== "external") return await indeedFlow(page);
    return await formFlow(page, row.route === "indeed_company_site");
  } catch (e) {
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
    await ctx?.close().catch(() => {});
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
    const entered = await enterApplyFlow(page);
    if (entered.result === "closed") throw new Stop("posting_gone");
    if (entered.mode) await set({}, "workday_entered", { mode: entered.mode });
    const parsedMode = entered.mode === "autofill";
    let lastStep = "";
    let resumeHandled = false;
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
      if (st.kind === "auth" || st.kind === "verify_email") {
        if (!visible) return pause("login_required", [], { stage: "workday_sign_in" });
        const ok = await waitForUser(page, async () => {
          const x = await wdState(page);
          return x.kind === "step" || x.kind === "review";
        }, "login_required");
        if (!ok) return pause("login_required", [], { stage: "workday_sign_in" });
        await set({ state: "filling", intervention: null, stage: "filling" }, "workday_signed_in");
        continue;
      }
      if (/already applied/i.test(st.errors.join(" "))) throw new Stop("already_applied_on_site");
      if (st.kind === "review") break;
      if (st.kind !== "step") return visible ? manual(page, "workday", "unexpected_page") : pause("unexpected_page");
      const name = `${st.step ?? ""}|${st.pageId ?? ""}`;
      if (name !== lastStep) await set({ stage: "filling" }, "workday_step", { step: st.step ?? st.pageId ?? "?", n: st.index ?? 0, total: st.total ?? 0 });
      lastStep = name;

      // Resume (My Experience): exactly the selected file; any other attached file is removed first.
      if (!resumeHandled && (await page.locator('input[type="file"]').count())) {
        const r = await uploadResume(page, resumeFile);
        if (r === "failed") throw new Stop("resume_upload_failed");
        if (r === "other_file_present") return pause("unsupported_field", [], { errorCode: "other_resume_attached" });
        if (r === "uploaded") await set({}, "uploaded_resume", { file: resumeFile.name });
        resumeHandled = r !== "no_input";
      }
      const sections = await fillWorkdaySections(page);
      const generic = await fillPage(page, { uploadInPlan: false, parsedMode });
      const questions = [...sections.questions, ...generic.questions];
      if (questions.length) {
        await shot(page, `step-${st.index ?? i + 1}`);
        return visible ? manual(page, "workday", reasonFor(questions), questions) : pause(reasonFor(questions), questions);
      }
      // Save and Continue. Workday validates on the server; errors keep us on the same step.
      await nextButton(page).click();
      await sleep(800);
      st = await wdSettle(page);
      const after = `${st.step ?? ""}|${st.pageId ?? ""}`;
      if (after === name && st.errors.length && st.kind === "step") {
        const fields = (await scan(page)).filter((f) => f.visible && f.invalid);
        const qs = fields.map((f) => question(f, f.group ? `${f.group}:${f.groupIndex}:${f.wdField}` : fieldKey(f), "not_accepted", false, st.errors.join(" | ").slice(0, 300)));
        await shot(page, `step-${st.index ?? i + 1}-errors`);
        if (qs.length) return pause("missing_information", qs, { errorMessage: st.errors.join(" | ").slice(0, 600) });
        return pause("validation_errors", [], { errorCode: "step_rejected", errorMessage: st.errors.join(" | ").slice(0, 600) });
      }
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

  // ================================================================ filling

  /** Scan → plan → fill → verify the visible, non-panel fields of the current page. */
  async function fillPage(page: Page, opts: { uploadInPlan: boolean; parsedMode?: boolean }): Promise<{ questions: PendingQuestion[] }> {
    let fields = await scan(page);
    if (!opts.uploadInPlan) fields = fields.filter((f) => f.control !== "file");
    let plan = planForm(fields, planCtx);
    const upload = plan.actions.find((a) => a.kind === "upload");
    if (upload) {
      // Resume first: some systems (e.g. Lever) parse it and pre-fill fields, which we then overwrite and verify.
      await page.locator(`[data-ca-ref="${upload.ref}"]`).setInputFiles(resumeFile);
      await set({}, "uploaded_resume", { file: resumeFile.name });
      await sleep(1200);
      fields = await scan(page);
    }
    fields = await enrichOptions(page, fields);
    plan = planForm(fields, planCtx);
    for (const a of plan.actions) {
      await checkCancel();
      if (a.kind !== "upload") await perform(page, a).catch(() => {});
    }
    const after = await scan(page);
    const ok = verify(plan.actions, after, resumeFile);
    allFilled = allFilled.concat(filledSummary(plan.actions, ok));
    await set({ filled: allFilled }, "filled", { count: ok.size, total: plan.actions.length });
    const questions = [...plan.questions];
    for (const a of plan.actions.filter((x) => !ok.has(x.ref))) {
      if (a.kind === "upload") throw new Stop("resume_upload_failed");
      const f = after.find((x) => fieldKey(x) === a.key) ?? fields.find((x) => x.ref === a.ref);
      if (f && f.required && !questions.some((q) => q.key === a.key)) questions.push(question(f, a.key, "not_accepted", false));
    }
    // Values a site pre-filled by parsing the resume are not trusted: the user confirms them.
    if (opts.parsedMode) {
      const planned = new Set([...plan.actions.map((a) => a.key), ...plan.questions.map((q) => q.key), ...plan.skipped.filter((x) => x.reason === "demographic" || x.reason === "legal").map((x) => x.key)]);
      for (const f of after) {
        const key = fieldKey(f);
        const v = Array.isArray(f.value) ? f.value.join(", ") : typeof f.value === "string" ? f.value : "";
        if (!f.visible || f.group || f.control === "file" || !v || planned.has(key) || key in planCtx.answers || questions.some((q) => q.key === key)) continue;
        questions.push(question(f, key, "parsed_unverified", false, v.slice(0, 200)));
      }
    }
    return { questions };
  }

  /** Workday work experience / education / skills panels, from My Profile (in profile order). */
  async function fillWorkdaySections(page: Page): Promise<{ questions: PendingQuestion[] }> {
    const questions: PendingQuestion[] = [];
    const actions: PlannedAction[] = [];
    const p = planCtx.profile;
    const ans = planCtx.answers;
    const panelsOf = (fields: FieldDescriptor[], group: "work" | "education") => {
      const m = new Map<number, FieldDescriptor[]>();
      for (const f of fields) if (f.group === group && f.groupIndex != null) m.set(f.groupIndex, [...(m.get(f.groupIndex) ?? []), f]);
      return m;
    };
    const val = (ds: FieldDescriptor[], wd: string) => {
      const f = ds.find((d) => d.wdField === wd);
      return f ? (Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "")) : "";
    };
    const plain = (raw: string | null | undefined) => (raw ? raw : null);

    for (const group of ["work", "education"] as const) {
      const entries = group === "work" ? p.experience : p.education;
      const anchor = group === "work" ? "jobTitle" : "schoolName";
      let fields = await scan(page);
      if (!fields.some((f) => f.group === group) && !(await addButton(page, group === "work" ? /work experience/ : /education/))) continue;
      // 1. Match existing panels (saved draft or resume parsing) to profile entries.
      let panels = panelsOf(fields, group);
      const assigned = new Map<number, number>(); // panel → profile entry
      const used = new Set<number>();
      const extras: number[] = [];
      for (const [pi, ds] of [...panels.entries()].sort((a, b) => a[0] - b[0])) {
        const first = norm(val(ds, anchor) || val(ds, "school"));
        const second = norm(group === "work" ? val(ds, "companyName") : val(ds, "degree"));
        if (!first && !second) continue; // empty panel: reused below
        const k = entries.findIndex((e, j) => {
          if (used.has(j)) return false;
          if (group === "work") {
            const w = e as Profile["experience"][number];
            return norm(w.title) === first && (!second || !w.organization || norm(w.organization) === second);
          }
          const ed = e as Profile["education"][number];
          return !!ed.institution && norm(ed.institution) === first;
        });
        if (k >= 0) {
          assigned.set(pi, k);
          used.add(k);
        } else extras.push(pi);
      }
      // 2. Entries Workday shows that are not in My Profile (e.g. parsed from the resume): the user decides.
      let removed = false;
      for (const pi of extras.sort((a, b) => b - a)) {
        const ds = panels.get(pi)!;
        const desc = [val(ds, anchor) || val(ds, "school"), group === "work" ? val(ds, "companyName") : val(ds, "degree")].filter(Boolean).join(" — ");
        const key = `${group}_extra:${norm(desc)}`.slice(0, 200);
        const choice = String(ans[key] ?? "");
        if (choice === "Remove") {
          if (await deletePanel(page, group, pi)) removed = true;
        } else if (choice !== "Keep") {
          questions.push({ key, label: `${group === "work" ? "Work experience" : "Education"} entry on the form that is not in My Profile: “${desc}”`, kind: "radio", required: true, options: ["Keep", "Remove"], reason: "parsed_unverified", sensitive: false, hint: null });
        }
      }
      if (removed) {
        // Panel numbers shift after a removal: match again on the next pass.
        fields = await scan(page);
        panels = panelsOf(fields, group);
        assigned.clear();
        used.clear();
        for (const [pi, ds] of panels) {
          const first = norm(val(ds, anchor) || val(ds, "school"));
          const k = entries.findIndex((e, j) => !used.has(j) && (group === "work" ? norm((e as Profile["experience"][number]).title) === first : norm((e as Profile["education"][number]).institution ?? "") === first));
          if (k >= 0) {
            assigned.set(pi, k);
            used.add(k);
          }
        }
      }
      // 3. Profile entries without a panel: reuse empty panels, then "Add".
      for (let k = 0; k < entries.length; k++) {
        if (used.has(k)) continue;
        const empty = [...panels.entries()].find(([pi, ds]) => !assigned.has(pi) && !norm(val(ds, anchor) || val(ds, "school")));
        if (empty) {
          assigned.set(empty[0], k);
          used.add(k);
          continue;
        }
        const add = await addButton(page, group === "work" ? /work experience/ : /education/);
        if (!add) break;
        const before = panels.size;
        await add.click();
        for (let w = 0; w < 20 && panelsOf(await scan(page), group).size === before; w++) await sleep(150);
        fields = await scan(page);
        panels = panelsOf(fields, group);
        const fresh = [...panels.keys()].filter((pi) => !assigned.has(pi)).sort((a, b) => b - a)[0];
        if (fresh == null) break;
        await set({}, group === "work" ? "work_entry_added" : "education_entry_added", { n: k + 1 });
        assigned.set(fresh, k);
        used.add(k);
      }
      // 4. Fill each assigned panel from its profile entry (performed right away: adding panels in
      //    the next section may re-render the form).
      for (const [pi, k] of assigned) {
        const label = group === "work" ? `${(entries[k] as Profile["experience"][number]).title}` : `${(entries[k] as Profile["education"][number]).institution ?? ""}`;
        const want = (wd: string): string | boolean | null => {
          const a = ans[`${group}:${k}:${wd}`];
          if (a !== undefined && a !== "") return a as string | boolean;
          if (group === "work") {
            const e = entries[k] as Profile["experience"][number];
            if (wd === "jobTitle") return e.title;
            if (wd === "companyName" || wd === "company") return plain(e.organization);
            if (wd === "currentlyWorkHere") return e.current;
            if (wd === "startDate") return plain(e.start);
            if (wd === "endDate") return e.current ? null : plain(e.end);
            if (wd === "roleDescription" || wd === "description") return plain(e.description);
            return null;
          }
          const e = entries[k] as Profile["education"][number];
          if (wd === "schoolName" || wd === "school") return plain(e.institution);
          if (wd === "fieldOfStudy") return plain(e.field);
          if (wd === "lastYearAttended" || wd === "endDate") return e.year ? String(e.year) : null;
          return null;
        };
        // The checkbox first: it shows or hides the end date.
        let ds = panelsOf(await scan(page), group).get(pi) ?? [];
        const cb = ds.find((d) => d.wdField === "currentlyWorkHere" && d.control === "checkbox");
        const cv = cb ? want("currentlyWorkHere") : null;
        if (cb && typeof cv === "boolean" && cb.value !== cv) {
          await perform(page, { ref: cb.ref, key: `${group}:${k}:currentlyWorkHere`, label: cb.label, control: "checkbox", kind: "check", value: cv, source: "experience" }).catch(() => {});
          await sleep(300);
        }
        ds = await enrichOptions(page, panelsOf(await scan(page), group).get(pi) ?? []);
        for (const f of ds) {
          if (!f.visible || !f.wdField || f.control === "file") continue;
          const key = `${group}:${k}:${f.wdField}`;
          if (f.wdField === "currentlyWorkHere") {
            if (cb && typeof cv === "boolean") actions.push({ ref: f.ref, key, label: f.label, control: "checkbox", kind: "check", value: cv, source: "experience" });
            continue;
          }
          let v = want(f.wdField);
          if (group === "education" && f.wdField === "degree" && (ans[key] === undefined || ans[key] === "")) {
            const e = entries[k] as Profile["education"][number];
            v = degreeOption(e.level, f.options.map((o) => o.label));
            if (!v && f.required) {
              questions.push(question(f, key, "missing", false, e.level));
              continue;
            }
          }
          if (v === null || v === undefined || v === "") {
            if (f.required) questions.push({ ...question(f, key, "missing", false), label: `${label}: ${f.label}`.slice(0, 500) });
            continue;
          }
          const a = toAction(f, key, v, group === "work" ? "experience" : "education");
          if ("misfit" in a) {
            if (f.required) questions.push({ ...question(f, key, "no_matching_option", false, String(v)), label: `${label}: ${f.label}`.slice(0, 500) });
            continue;
          }
          // Searchable school / field-of-study lists: only an exact option is taken.
          if (a.kind === "search") actions.push({ ...a, match: [String(v)], value: String(v) });
          else actions.push(a);
        }
      }
      await runActions(actions.splice(0));
    }

    // Skills: each profile skill that the employer's list offers exactly (optional; never invented).
    const skills = (await scan(page)).find((f) => f.group === "skills" && f.visible && f.control === "combobox");
    if (skills && p.skills.length) {
      const have = new Set((Array.isArray(skills.value) ? skills.value : []).map(norm));
      for (const sk of p.skills.slice(0, 25)) {
        if (have.has(norm(sk))) continue;
        await pickOption(page, page.locator(`[data-ca-ref="${skills.ref}"]`), sk, (l) => l === norm(sk), 600).catch(() => {});
      }
      const now = (await scan(page)).find((f) => f.ref === skills.ref);
      const chips = new Set((Array.isArray(now?.value) ? now.value : []).map(norm));
      allFilled.push({ label: skills.label || "Skills", source: "skills", verified: p.skills.some((sk) => chips.has(norm(sk))) });
    }

    return { questions };

    async function runActions(list: PlannedAction[]) {
      if (!list.length) return;
      for (const a of list) {
        await checkCancel();
        await perform(page, a).catch(() => {});
      }
      const after = await scan(page);
      const ok = verify(list, after, resumeFile);
      allFilled = allFilled.concat(filledSummary(list, ok));
      for (const a of list) {
        if (ok.has(a.ref)) continue;
        const f = after.find((x) => x.ref === a.ref);
        if ((f?.required ?? true) && !questions.some((q) => q.key === a.key)) questions.push(f ? question(f, a.key, "not_accepted", false) : { key: a.key, label: a.label, kind: "text", required: true, options: [], reason: "not_accepted", sensitive: false, hint: null });
      }
      await set({ filled: allFilled }, "filled", { count: ok.size, total: list.length });
    }
  }

  // ================================================================ submit / outcome

  /** Pauses unless submission is authorised and nothing (CAPTCHA, cancel) is in the way. */
  async function submitGate(page: Page, ats: Ats | null): Promise<AttemptState | null> {
    row = (await current())!;
    if (!row.submitAuthorized) return visible ? manual(page, ats, "submit_approval") : pause("submit_approval");
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

  /** Visible window: waits for the user (sign-in, CAPTCHA) until `done()`; false on close / timeout. */
  async function waitForUser(page: Page, done: () => Promise<boolean>, reason: InterventionReason): Promise<boolean> {
    await set({ state: "needs_review", intervention: reason, stage: "waiting_for_you" }, "waiting_for_you", { reason });
    const until = Date.now() + t.manual;
    while (Date.now() < until) {
      if (page.isClosed()) return false;
      if (await cancelled()) throw new Stop("cancelled");
      const r = await current();
      if (!r || r.state !== "needs_review") return false;
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

const OPTION_SEL = `.select__option, [role="option"], [id*="-option-"], ${WD_OPTION_SEL}`;

/** Visible options of an open menu (never the Workday "selectedItemList" chips). */
async function visibleOptions(page: Page): Promise<Locator[]> {
  const loc = page.locator(OPTION_SEL).filter({ visible: true });
  const out: Locator[] = [];
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const o = loc.nth(i);
    if (await o.evaluate((e) => !e.closest('[data-automation-id="selectedItemList"]')).catch(() => false)) out.push(o);
  }
  return out;
}

/** Reads the options of comboboxes / listboxes (they exist only while the menu is open). */
async function enrichOptions(page: Page, fields: FieldDescriptor[]): Promise<FieldDescriptor[]> {
  for (const f of fields) {
    if ((f.control !== "combobox" && f.control !== "listbox") || !f.visible || f.options.length || (f.control === "combobox" && f.asyncOptions)) continue;
    const loc = page.locator(`[data-ca-ref="${f.ref}"]`);
    try {
      await loc.click({ timeout: 3000 });
      await sleep(300);
      const texts: string[] = [];
      for (const o of await visibleOptions(page)) {
        const tx = ((await o.textContent()) ?? "").replace(/\s+/g, " ").trim();
        if (tx) texts.push(tx);
      }
      f.options = texts.slice(0, 300).map((l) => ({ value: l, label: l }));
      if (f.control === "combobox") f.asyncOptions = !texts.length;
      await page.keyboard.press("Escape");
      await sleep(100);
    } catch {
      if (f.control === "combobox") f.asyncOptions = true;
    }
  }
  return fields;
}

async function perform(page: Page, a: PlannedAction) {
  const loc = page.locator(`[data-ca-ref="${a.ref}"]`);
  // The page re-rendered since the scan: fail fast (the step is verified and asked again) instead of waiting.
  if (!(await loc.count())) throw new Error("stale_field");
  switch (a.kind) {
    case "fill":
      await loc.fill(a.value);
      await loc.blur().catch(() => {});
      return;
    case "check":
      // A click (not setChecked): some forms re-render on change, which would make setChecked retry.
      if ((await loc.isChecked()) !== a.value) await loc.click({ force: true });
      return;
    case "date":
      // Workday date sections only commit real keystrokes.
      for (const part of ["month", "day", "year"] as const) {
        const v = a.value[part];
        const ref = a.parts[part];
        if (!v) continue;
        const target = ref ? page.locator(`[data-ca-ref="${ref}"]`) : null;
        if (!target) continue;
        await target.click();
        await target.press("ControlOrMeta+A");
        await target.pressSequentially(v);
      }
      await page.keyboard.press("Tab").catch(() => {});
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
      if (a.control === "listbox") return chooseListbox(page, loc, a.values[0]);
      if (a.control === "combobox") return pickOption(page, loc, a.values[0], (l) => l === norm(a.values[0]), 250);
      return;
    case "search":
      // Only an unambiguous suggestion is taken (e.g. "Toronto, Ontario, Canada", not "Toronto, Ohio").
      return pickOption(page, loc, a.value, (l) => a.match.every((m) => l.includes(norm(m))), 1500);
  }
}

/** Workday button dropdown: open, click the option with exactly this text. */
async function chooseListbox(page: Page, loc: Locator, label: string) {
  await loc.click();
  await sleep(300);
  for (const o of await visibleOptions(page)) {
    if (norm(await o.textContent()) === norm(label)) {
      await o.click();
      await sleep(200);
      return;
    }
  }
  await page.keyboard.press("Escape");
}

async function pickOption(page: Page, loc: Locator, text: string, fits: (normalizedLabel: string) => boolean, wait: number) {
  await loc.click();
  await loc.fill(text);
  await sleep(wait);
  let opts = await visibleOptions(page);
  if (!opts.length) {
    // Workday prompts search on Enter.
    await loc.press("Enter").catch(() => {});
    await sleep(1200);
    opts = await visibleOptions(page);
  }
  const hits: Locator[] = [];
  for (const o of opts) if (fits(norm(await o.textContent()))) hits.push(o);
  if (hits.length === 1) await hits[0].click();
  await sleep(150);
  await page.keyboard.press("Escape").catch(() => {});
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
      case "date": {
        const want = [a.value.month, a.value.day, a.value.year].filter(Boolean).map((x) => String(Number(x))).join("/");
        good = String(v ?? "").split("/").map((x) => String(Number(x))).join("/") === want;
        break;
      }
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

function errorCode(e: unknown): string {
  const m = String((e as Error)?.message ?? "");
  if ((e as Error)?.name === "TimeoutError" || /Timeout/.test(m)) return "timeout";
  if (/net::ERR_|NS_ERROR|ECONNREFUSED|ENOTFOUND/.test(m)) return "navigation_failed";
  if (/Executable doesn't exist|browserType\.launch|Failed to launch/.test(m)) return "browser_launch_failed";
  if (/Target (page|closed)|has been closed/.test(m)) return "browser_closed";
  return "worker_error";
}

export const _test = { verify, stripQuery };
