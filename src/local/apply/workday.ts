// Workday adapter helpers (Playwright). The step loop itself lives in engine.ts.
//
// Workday career sites are a React app addressed through data-automation-id attributes. The flow
// is a wizard whose steps vary by employer (typically Create Account/Sign In → My Information →
// My Experience → Application Questions → Voluntary Disclosures → (Self Identify) → Review), so
// steps are recognised from the page, never assumed by number.
//
// Selector sources (all MIT-licensed, re-implemented here; see THIRD_PARTY_NOTICES.md):
//  - AbhishekMandapmalvi/AutoApply bot/apply/workday.py — Apply-button candidates, listbox
//    dropdown strategy (button[aria-haspopup=listbox] → [role=listbox] [role=option]), error and
//    "thankYouMessage" selectors, Submit candidates.
//  - Harsh-H-Shah/PaperPlane backend/src/fillers/workday_filler.py — choose "Apply Manually" in the
//    apply-options popup.
//  - devdattatalele/auto-apply lib/workday.mjs — sign-in page detection selectors.
//  - andrewmillercode/Autofill-Jobs src/public/contentScripts/utils.js — formField names for My
//    Information, work experience, education and dates.
// Verified by Career Atlas on a live tenant (read-only, 2026-10-14): adventureButton, the apply
// popup (autofillWithResume / applyManually / useMyLastApplication), the /apply/applyManually URL,
// progressBar / progressBarActiveStep, the Create Account/Sign In step (signInContent, email,
// password, verifyPassword, createAccountSubmitButton, signInLink), the beecatcher honeypot and
// the legalNotice cookie banner. Everything after sign-in is untested on a real tenant.
//
// Not adopted from those projects: creating accounts or typing passwords, reading e-mail codes,
// auto-ticking terms, default answers, "Use My Last Application", random "human" delays, and
// treating "no error" as a submission.
import type { Locator, Page } from "playwright-core";
import { norm } from "./plan";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aid = (id: string) => `[data-automation-id="${id}"]`;

export const WD_OPTION_SEL = '[role="listbox"] [role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"], [data-automation-id="promptLeafNode"]';

/** Privacy-preserving choice on Workday's cookie banner (declines non-essential cookies). */
export async function declineCookies(page: Page) {
  const b = page.locator(aid("legalNoticeDeclineButton")).first();
  if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
}

export type EnterResult = { result: "entered" | "already" | "no_apply" | "closed"; mode: "manual" | "autofill" | null };

/** From the job page into the application wizard. Prefers "Apply Manually" (no resume parsing). */
export async function enterApplyFlow(page: Page): Promise<EnterResult> {
  if (/\/apply(\/|$|\?)/.test(new URL(page.url()).pathname) || (await page.locator(aid("applyFlowPage")).count())) return { result: "already", mode: null };
  const err = page.locator(aid("errorMessage")).first();
  const closed = (await err.count()) ? await err.textContent({ timeout: 2000 }).catch(() => null) : null;
  if (closed && /doesn'?t exist|no longer|not available/i.test(closed)) return { result: "closed", mode: null };
  const apply = page.locator(`a${aid("adventureButton")}, button${aid("adventureButton")}, ${aid("jobPostingApplyButton")}`).first();
  if (!(await apply.isVisible().catch(() => false))) return { result: "no_apply", mode: null };
  await apply.click();
  // The options popup (autofill with resume / apply manually / use my last application).
  for (let i = 0; i < 20; i++) {
    if (await page.locator(aid("applyManually")).first().isVisible().catch(() => false)) break;
    if (await page.locator(aid("applyFlowPage")).count()) return { result: "entered", mode: null };
    await sleep(250);
  }
  for (const [id, mode] of [["applyManually", "manual"], ["autofillWithResume", "autofill"]] as const) {
    const opt = page.locator(aid(id)).first();
    if (await opt.isVisible().catch(() => false)) {
      // A synthetic click is sometimes ignored by Workday: follow the link when it has one.
      const href = await opt.getAttribute("href").catch(() => null);
      if (href && !href.startsWith("#") && !href.startsWith("javascript:")) await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded" });
      else await opt.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return { result: "entered", mode };
    }
  }
  return { result: "entered", mode: null };
}

export interface WdState {
  kind: "auth" | "verify_email" | "review" | "step" | "confirmation" | "loading" | "unknown";
  /** Name of the active step from the progress bar, e.g. "My Experience". */
  step: string | null;
  index: number | null;
  total: number | null;
  pageId: string | null;
  confirmation: string | null;
  errors: string[];
}

export const WD_STATE = String.raw`(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
  const auth = qa('[data-automation-id="signInContent"], [data-automation-id="signInFormo"], form[data-automation-id^="signInForm"], [data-automation-id="createAccountSubmitButton"], [data-automation-id="signInSubmitButton"]').some(vis);
  const verify = qa('[data-automation-id="verificationCode"], input[name*="verification" i]').some(vis) || /verify your (email|account)|verification (code|email) (has been |was )?sent/i.test(text);
  const pageIds = ['applyFlowMyInfoPage','applyFlowMyExpPage','applyFlowPrimaryQuestionsPage','applyFlowSecondaryQuestionsPage','applyFlowVoluntaryDisclosuresPage','applyFlowSelfIdentifyPage','applyFlowReviewPage','contactInformationPage','myExperiencePage','voluntaryDisclosuresPage','selfIdentificationPage'];
  const pageId = pageIds.find((id) => vis(q('[data-automation-id="' + id + '"]'))) || null;
  const active = q('[data-automation-id="progressBarActiveStep"]');
  const at = active ? active.innerText.replace(/\s+/g, ' ').trim() : '';
  const m = at.match(/step\s+(\d+)\s+of\s+(\d+)\s*(.*)$/i);
  const next = q('[data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]');
  const nextText = next && vis(next) ? next.innerText.trim() : '';
  const thank = q('[data-automation-id="thankYouMessage"], [data-automation-id="applicationSubmittedMessage"]');
  const conf = /application (has been )?submitted|you have (successfully )?(submitted|applied)|thank you for applying|successfully (submitted|applied)/i.exec(text);
  const flow = vis(q('[data-automation-id="applyFlowPage"]'));
  const errors = qa('[data-automation-id="errorHeading"], [data-automation-id="inputAlert"], [data-automation-id="errorMessage"], [data-automation-id="alertMessage"]').filter(vis).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10);
  let kind = 'unknown';
  if (auth) kind = 'auth';
  else if (verify) kind = 'verify_email';
  else if ((vis(thank) || conf) && !pageId && !nextText) kind = 'confirmation';
  else if (pageId === 'applyFlowReviewPage' || /^submit$/i.test(nextText)) kind = 'review';
  else if (pageId || (flow && nextText)) kind = 'step';
  else if (flow) kind = 'loading';
  return { kind, step: m ? m[3].trim() || null : (at || null), index: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, pageId, confirmation: vis(thank) ? thank.innerText.trim().slice(0, 300) : conf ? conf[0] : null, errors };
})()`;

export async function wdState(page: Page): Promise<WdState> {
  return (await page.evaluate(WD_STATE)) as WdState;
}

/** Waits until the wizard shows something other than a spinner. */
export async function wdSettle(page: Page, timeout = 15_000): Promise<WdState> {
  const until = Date.now() + timeout;
  let s = await wdState(page);
  while ((s.kind === "loading" || s.kind === "unknown") && Date.now() < until) {
    await sleep(300);
    s = await wdState(page);
  }
  return s;
}

export function nextButton(page: Page): Locator {
  return page.locator(`${aid("pageFooterNextButton")}, ${aid("bottom-navigation-next-button")}`).first();
}

// ---------------------------------------------------------------- resume

/**
 * Attaches exactly the selected resume. If a different file is already attached (e.g. from a saved
 * draft or another resume), it is removed first; if it can't be removed, nothing is uploaded and
 * the caller pauses — another resume is never left in place silently.
 */
export async function uploadResume(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<"uploaded" | "already" | "other_file_present" | "no_input" | "failed"> {
  const items = () => page.locator(aid("file-upload-item")).allInnerTexts().catch(() => [] as string[]);
  const has = (list: string[]) => list.some((t) => norm(t).includes(norm(file.name)));
  let present = await items();
  if (has(present) && present.length === 1) return "already";
  for (let i = 0; i < 5 && present.length && !(has(present) && present.length === 1); i++) {
    // Remove whatever else is attached (never keep another resume alongside or instead).
    const others = page.locator(aid("file-upload-item")).filter({ hasNotText: file.name });
    if (!(await others.count())) break;
    const del = others.first().locator(`${aid("delete-file")}, button[aria-label*="delete" i], button[aria-label*="remove" i]`).first();
    if (!(await del.isVisible().catch(() => false))) return "other_file_present";
    await del.click();
    await sleep(600);
    present = await items();
  }
  if (present.some((t) => !norm(t).includes(norm(file.name)))) return "other_file_present";
  if (has(present)) return "already";
  const input = page.locator(`input[type="file"]${aid("file-upload-input-ref")}, ${aid("attachments-FileUpload")} input[type="file"]`).first();
  const any = page.locator('input[type="file"]').first();
  const target = (await input.count()) ? input : (await any.count()) ? any : null;
  if (!target) return "no_input";
  await target.setInputFiles(file);
  for (let i = 0; i < 40; i++) {
    if (has(await items())) return "uploaded";
    await sleep(250);
  }
  return "failed";
}

// ---------------------------------------------------------------- repeating panels

const ADD_BUTTON = String.raw`((src) => {
  const re = new RegExp(src, 'i');
  document.querySelectorAll('[data-ca-add]').forEach((x) => x.removeAttribute('data-ca-add'));
  const btns = [...document.querySelectorAll('button, [data-automation-id="add-button"]')].filter((b) => b.getAttribute('data-automation-id') === 'add-button' || /^add( another)?$/i.test((b.textContent || '').trim()));
  for (const b of btns) {
    let label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
    let a = b.parentElement;
    for (let d = 0; d < 6 && a && !re.test(label); d++) {
      const h = a.querySelector('h2, h3, h4, legend, [role=heading]');
      if (h) label += ' ' + (h.textContent || '');
      a = a.parentElement;
    }
    if (re.test(label)) { b.setAttribute('data-ca-add', '1'); return true; }
  }
  return false;
})`;

/** Marks and returns the "Add" button of a section (Work Experience, Education, …). */
export async function addButton(page: Page, section: RegExp): Promise<Locator | null> {
  const found = (await page.evaluate(`${ADD_BUTTON}(${JSON.stringify(section.source)})`)) as boolean;
  return found ? page.locator("[data-ca-add]").first() : null;
}

const DELETE_PANEL = String.raw`((group, index) => {
  const prefix = group === 'work' ? 'workExperience' : 'education';
  const re = new RegExp('^' + prefix + '-\\d+$');
  document.querySelectorAll('[data-ca-del]').forEach((x) => x.removeAttribute('data-ca-del'));
  const panel = [...document.querySelectorAll('[data-automation-id^="' + prefix + '-"]')].filter((x) => re.test(x.getAttribute('data-automation-id')))[index];
  if (!panel) return false;
  const del = panel.querySelector('[data-automation-id="panel-set-delete-button"], button[aria-label*="delete" i], button[aria-label*="remove" i]');
  if (!del) return false;
  del.setAttribute('data-ca-del', '1');
  return true;
})`;

/** Removes panel `index` of a group (work / education) — only when the user chose "Remove". */
export async function deletePanel(page: Page, group: "work" | "education", index: number): Promise<boolean> {
  const ok = (await page.evaluate(`${DELETE_PANEL}(${JSON.stringify(group)}, ${Number(index)})`)) as boolean;
  if (!ok) return false;
  await page.locator("[data-ca-del]").first().click();
  await sleep(500);
  return true;
}

/** Degree option for a profile education level — a direct level match only, never an equivalence. */
export function degreeOption(level: string, options: string[]): string | null {
  const words: Record<string, RegExp> = {
    high_school: /high school|secondary|ged/,
    diploma: /diploma|certificate|associate/,
    bachelor: /bachelor/,
    master: /master/,
    doctorate: /doctor|ph ?d/,
  };
  const re = words[level];
  if (!re) return null;
  const hits = options.filter((o) => re.test(norm(o)) && !(level === "diploma" && /high school/.test(norm(o))));
  return hits.length === 1 ? hits[0] : null;
}
