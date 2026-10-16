// The runtime browser agent: OBSERVE → UNDERSTAND → RETRIEVE → PLAN → ACT → VERIFY → RECOVER.
//
// Career Atlas observes the live page and sends the model (Codex with the owner's ChatGPT sign-in,
// no tools — see src/local/codex.ts) a compact description of it. The model proposes ONE structured
// action. Career Atlas — not the model — validates it against this application's authorisation,
// resolves applicant facts from My Profile itself, executes it with its own Playwright primitives,
// and verifies the result on the page. The result is fed back for the next proposal.
//
// What the model receives: page labels, headings, button texts, option lists, which fields are
// filled (not their values), and WHICH profile facts exist (not their values, except non-personal
// preferences such as "preferred contact method: email"). It never receives passwords, codes,
// documents or free-text personal data, and it cannot type free text into the form: personal values
// come only from My Profile through Career Atlas. Hard limits live in `validate()`, not in the prompt.
import type { FilledField, PendingQuestion } from "@shared/apply";
import { questionMeaning } from "@shared/apply-semantic";
import type { Profile } from "@shared/profile";
import type { Page } from "playwright-core";
import { isIndeedOwnedHost } from "./indeed";
import { checkSet, listSelect, openChoices, scan, searchSelect, shownMatches, textSet, valuesOf, type Finder } from "./interact";
import { domainForLabel, matchOptionSemantic } from "@shared/apply-semantic";
import { APPLY_CTA_RE, cookieChoice, PAGE_MAP, pageState, type PageMap, type PageState, type PageWidget, type WidgetKind } from "./page-intent";
import { classify, datePartOf, fieldKey, MONTH_NAMES, norm, parseDateAnswer, planForm, profileValue, question, screeningValue, toAction, type FieldDescriptor, type PlanContext, type Semantic } from "./plan";
import { phoneAccepted, type CanonicalPhone } from "@shared/phone";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- observation

export interface AgentButton {
  ref: string;
  text: string;
  disabled?: boolean;
  /** The control sits in a site widget, not in the page's own content: "search" | "subscription" | "chrome" | "cookie". */
  area?: WidgetKind;
  /** For a consent-like button: the statement around it (site wording). */
  context?: string;
  /** For a consent-like button: "approved" (the applicant's authorisation covers it) or "applicant_decides". */
  consent?: "approved" | "applicant_decides";
}
export interface AgentField {
  ref: string;
  label: string;
  control: string;
  required?: boolean;
  /** "empty" | "filled" | "checked" | "unchecked" | "selected: <option>" — never a typed personal value. */
  state: string;
  options?: string[];
  entry?: string;
  identity?: boolean;
  /** The applicant answered this question (value not shown): use fact "applicant_answer". */
  answer_on_file?: boolean;
  /** Already asked in this run: do not ask again. */
  asked_applicant?: boolean;
  /** An agreement / consent: "approved" (the applicant approved it, here or by a standing authorisation) or "applicant_decides". */
  consent?: "approved" | "applicant_decides";
  /** The group / fieldset heading the control sits in (e.g. "Graduation date" for a bare "Month"). */
  group?: string;
  /** The site's placeholder text (an example format, never a saved value). */
  placeholder?: string;
  /** The site's help or error text for the control. */
  help?: string;
  invalid?: boolean;
  /** Related controls: for a phone, the separate country-code control / widget and the code it shows. */
  related?: string;
}
export interface AgentObservation {
  /** What the applicant wants done (job title and employer — not personal data). */
  goal: string;
  /** Career Atlas's own reading of the page: posting / application / questions / login / unknown. */
  page_state: PageState;
  /** Site widgets that are NOT part of the application (search, job alerts, chrome, cookie banners). */
  widgets: PageWidget[];
  /** Large embedded documents (host, share of the screen): an application may live inside one — Career Atlas opens it. */
  frames: { host: string; share: number }[];
  url: string;
  title: string;
  headings: string[];
  dialogs: string[];
  errors: string[];
  buttons: AgentButton[];
  fields: AgentField[];
  captcha: boolean;
  password_field: boolean;
}

const OBSERVE_JS = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let n = Number(document.documentElement.getAttribute('data-ca-bseq') || 0);
  const ref = (el) => { if (!el.getAttribute('data-ca-btn')) { n += 1; el.setAttribute('data-ca-btn', 'b' + n); } return el.getAttribute('data-ca-btn'); };
  const buttons = [];
  for (const e of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[href], [role="link"], [role="tab"], [role="menuitem"], [onclick]')) {
    if (!vis(e) || e.closest('[role="listbox"], [role="option"], [data-automation-id="selectedItemList"], [data-automation-id="beecatcher"]')) continue;
    const text = clean(e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || '');
    if (!text || text.length > 90) continue;
    const b = { ref: ref(e), text };
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') b.disabled = true;
    const w = e.closest('[data-ca-outside]');
    if (w) b.area = w.getAttribute('data-ca-outside');
    // A consent-like button ("Agree", "I accept"): the statement it agrees to (the nearest text around it).
    if (/\b(agree|consent|accept|acknowledg|certif|attest)/i.test(text) && !w) {
      let p = e.parentElement;
      while (p && p !== document.body && clean(p.innerText).length <= text.length + 12) p = p.parentElement;
      if (p && p !== document.body) b.context = clean(p.innerText).slice(0, 300);
    }
    buttons.push(b);
    if (buttons.length >= 60) break;
  }
  document.documentElement.setAttribute('data-ca-bseq', String(n));
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .modal.show')].filter(vis).map((d) => clean(d.innerText).slice(0, 400));
  const headings = [...document.querySelectorAll('h1, h2, h3, legend, [role="heading"]')].filter((h) => vis(h) && !h.closest('[data-ca-outside]')).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 15);
  const errors = [...document.querySelectorAll('[role="alert"], .error, .field-error, .error-message, [class*="error-text"], [class*="explain-error"], [data-automation-id="errorMessage"]')].filter(vis).map((e) => clean(e.innerText)).filter(Boolean).slice(0, 10);
  const captcha = [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], iframe[src*="captcha-delivery"]')].some((f) => { const r = f.getBoundingClientRect(); return r.width > 40 && r.height > 40; });
  const password_field = [...document.querySelectorAll('input[type="password"]')].some(vis);
  return { url: location.origin + location.pathname, title: document.title.slice(0, 100), headings, dialogs, errors: [...new Set(errors)], buttons, captcha, password_field };
})()`;

const CHOICE = new Set(["select", "radio", "listbox", "combobox", "checkboxes"]);
const DEMO_RE = /\b(gender|sex\b|race|racial|ethnic|hispanic|latin[oax]|veteran|disabilit|sexual orientation|lgbt|transgender|pronoun|indigenous|aboriginal|first nations|m[eé]tis|inuit|visible minority|self[- ]identif)/i;

function stateOf(f: FieldDescriptor): string {
  if (f.inputType === "password") return valuesOf(f).length ? "filled" : "empty";
  if (f.control === "checkbox") return f.value === true ? "checked" : "unchecked";
  const v = valuesOf(f);
  if (!v.length) return "empty";
  // Only a choice the SITE offered is shown (an option text), and only for questions that are not about
  // the applicant (e.g. "How would you like to apply?"); typed text and the applicant's answers are "filled".
  const personal = f.demographic || DEMO_RE.test(f.label) || LEGAL_RE.test(f.label) || questionMeaning(f.label, null).meaning !== "unknown" || !["unknown", "open_ended"].includes(classify(f));
  if (!personal && CHOICE.has(f.control) && f.options.some((o) => v.includes(o.label))) return `selected: ${v.join(", ").slice(0, 80)}`;
  return "filled";
}

export interface ObserveContext {
  goal: string;
  answers?: Record<string, unknown>;
  /** Is this agreement covered by the applicant's approval (this question's answer or a standing authorisation)? */
  consentApproved?: (text: string, key: string) => boolean;
  asked?: Set<string>;
  inWorkflow?: boolean;
}

export async function observeForModel(page: Page, c: ObserveContext): Promise<{ obs: AgentObservation; fields: FieldDescriptor[]; map: PageMap }> {
  const answers = c.answers ?? {};
  const asked = c.asked ?? new Set<string>();
  // Page purpose first: widgets are marked (and left out of the fields) before anything is described.
  const map = (await page.evaluate(PAGE_MAP)) as PageMap;
  const base = (await page.evaluate(OBSERVE_JS)) as Omit<AgentObservation, "fields" | "goal" | "page_state" | "widgets" | "frames">;
  const fields = (await scan(page)).filter((f) => f.visible || f.control === "file");
  const obs: AgentObservation = {
    goal: c.goal,
    page_state: pageState(map, { inWorkflow: !!c.inWorkflow, login: base.password_field }),
    widgets: map.widgets.filter((w) => w.kind !== "chrome" || w.inputs > 0).slice(0, 8),
    frames: map.frames.map((f) => ({ host: (() => { try { return new URL(f.src).host; } catch { return ""; } })(), share: Math.round(f.area * 100) / 100 })).slice(0, 4),
    ...base,
    buttons: base.buttons.map((b) => (b.context && !b.area && CONSENT_BTN_RE.test(b.text) ? { ...b, consent: c.consentApproved?.(`${b.text} ${b.context}`, buttonConsentKey(b)) ? ("approved" as const) : ("applicant_decides" as const) } : b)),
    fields: fields.slice(0, 80).map((f) => ({
      ref: f.ref,
      label: (f.label || f.placeholder || f.name).slice(0, 140),
      control: f.inputType === "password" ? "password" : f.control === "text" && f.inputType === "date" ? "date" : f.control,
      ...(f.required ? { required: true } : {}),
      state: stateOf(f),
      ...(f.options.length ? { options: f.options.map((o) => o.label).filter(Boolean).slice(0, 30) } : {}),
      ...(f.group ? { entry: `${f.group} ${(f.groupIndex ?? 0) + 1}` } : {}),
      ...(f.demographic || DEMO_RE.test(f.label) ? { identity: true } : {}),
      ...(answered(answers, f) ? { answer_on_file: true } : {}),
      ...(isAgreement(f) ? { consent: approvedConsent(f, answers, c.consentApproved) ? ("approved" as const) : ("applicant_decides" as const) } : {}),
      ...(asked.has(fieldKey(f)) ? { asked_applicant: true } : {}),
      ...(f.section && norm(f.section) !== norm(f.label) ? { group: f.section.slice(0, 120) } : {}),
      ...(f.placeholder && f.control !== "combobox" ? { placeholder: f.placeholder.slice(0, 60) } : {}),
      ...(f.help ? { help: f.help } : {}),
      ...(f.invalid ? { invalid: true } : {}),
      ...(f.phone?.widget ? { related: f.phone.widget === "split" ? `separate country-code control beside it${f.phone.dial ? ` (shows ${f.phone.dial})` : " (nothing chosen)"}` : `international phone widget${f.phone.dial ? ` (shows ${f.phone.dial})` : ""}` } : {}),
    })),
  };
  return { obs, fields, map };
}

/** An agreement / declaration ticked or chosen in the form (privacy policy, terms, certification…). */
const isAgreement = (f: FieldDescriptor) => LEGAL_RE.test(f.label) && (f.control === "checkbox" || CHOICE.has(f.control));
/** A button that gives a consent ("Agree", "I accept the terms") — its statement decides whether it is approved. */
const CONSENT_BTN_RE = /^\s*(i )?(hereby )?(agree|consent|accept|acknowledge|certify|attest)\b/i;
const buttonConsentKey = (b: AgentButton) => `consent:${norm(`${b.text} ${b.context ?? ""}`).slice(0, 120)}`;
/**
 * The applicant approved THIS agreement: ticked / "Yes" in their answer to it, or covered by their standing
 * authorisations (Application Defaults — checked by Career Atlas, category by category).
 */
function approvedConsent(f: FieldDescriptor, answers: Record<string, unknown>, standing?: (text: string, key: string) => boolean): boolean {
  const v = answers[fieldKey(f)];
  if (v === true || (typeof v === "string" && /^\s*(yes|i agree|agree|i consent|i accept|accept|i acknowledge)\b/i.test(v))) return true;
  return !!standing?.([f.label, ...f.options.map((o) => o.label)].join(" "), fieldKey(f));
}

const answered = (answers: Record<string, unknown>, f: FieldDescriptor) => {
  const v = answers[fieldKey(f)];
  return v !== undefined && v !== null && v !== "";
};

// ---------------------------------------------------------------- facts (names, not values)

/** Profile facts the model may ask Career Atlas to use, mapped to the planner's meanings. */
const FACTS: Record<string, Semantic | "default"> = {
  "contact.first_name": "first_name",
  "contact.last_name": "last_name",
  "contact.full_name": "full_name",
  "contact.preferred_name": "preferred_name",
  "contact.email": "email",
  "contact.phone": "phone",
  "contact.phone_type": "phone_type",
  "contact.address": "address",
  "contact.postal_code": "postal_code",
  "contact.linkedin_url": "linkedin",
  "contact.website_url": "website",
  "contact.github_url": "github",
  "location.city": "city",
  "location.region": "region",
  "location.country": "country",
  "location.phone_country": "phone_country",
  "location.full": "location",
  "work_authorization": "work_authorization",
  "sponsorship": "sponsorship",
  "driver_licence": "driver_licence",
  "current_employer": "current_company",
  "current_title": "current_title",
  "education.graduation": "default",
};
/** Preferences whose VALUES are not personal facts and help the model map a question. */
const PREFS = ["preferred_contact_method", "prior_employment", "relocation", "travel", "shift_work", "referral", "enrolled_student", "coop_program", "source"] as const;

/** What the profile holds in bulk (counts only) — context for the model, not facts it can ask to enter. */
export function profileSummary(p: Profile): Record<string, number> {
  return { experience_entries: p.experience.length, education_entries: p.education.length, skills: p.skills.length, languages: p.languages.length };
}

export function factCatalog(p: Profile): Record<string, unknown> {
  const c = p.contact;
  const has = (v: unknown) => v !== null && v !== undefined && v !== "";
  const out: Record<string, unknown> = {
    "contact.first_name": has(c.first_name),
    "contact.last_name": has(c.last_name),
    "contact.full_name": has(c.first_name) && has(c.last_name),
    "contact.preferred_name": has(c.preferred_name),
    "contact.email": has(c.email),
    "contact.phone": has(c.phone),
    "contact.phone_type": p.application_defaults.phone_type ?? false,
    "contact.address": has(c.address),
    "contact.postal_code": has(c.postal_code),
    "contact.linkedin_url": has(c.linkedin_url),
    "contact.website_url": has(c.website_url),
    "contact.github_url": has(c.github_url),
    "location.city": has(p.based_in.city),
    "location.region": has(p.based_in.region),
    "location.country": has(p.based_in.country),
    "location.phone_country": has(p.based_in.country),
    "location.full": has(p.based_in.city),
    work_authorization: p.work_authorization.length ? `on file for ${p.work_authorization.length} country(ies)` : false,
    sponsorship: p.work_authorization.length > 0,
    driver_licence: p.driver_licence.has !== null,
    current_employer: p.experience.some((e) => e.current && e.organization),
    current_title: p.experience.some((e) => e.current),
    // One completed degree (its end date) or an expected graduation; several completed degrees are ambiguous.
    "education.graduation": !!p.application_defaults.expected_graduation || p.education.filter((e) => e.completed !== false && (e.end || e.year)).length === 1 || p.education.some((e) => e.completed === false && e.year),
    applicant_answer: "for fields marked answer_on_file: the applicant's own answer to that question",
  };
  for (const k of PREFS) {
    const v = p.application_defaults[k as keyof Profile["application_defaults"]];
    out[`defaults.${k}`] = v === null || v === undefined || v === "" ? false : v;
  }
  return out;
}

// ---------------------------------------------------------------- proposals

export type AgentAction =
  | { action: "click"; ref: string }
  | { action: "fill_from_profile"; ref: string; fact: string }
  | { action: "choose_from_profile"; ref: string; fact: string }
  | { action: "choose_option"; ref: string; option: string }
  | { action: "set_checkbox"; ref: string; checked: boolean }
  | { action: "upload_resume"; ref?: string }
  | { action: "run_autofill" }
  | { action: "dismiss_dialog"; ref: string }
  | { action: "scroll" }
  | { action: "wait" }
  | { action: "ask_user"; ref?: string; question: string }
  | { action: "read_options"; ref: string }
  | { action: "pick_from_profile"; ref: string; fact: string }
  | { action: "write_answer"; ref: string }
  | { action: "finish"; status: "review_ready" | "needs_user" | "blocked"; reason: string };

export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "One short sentence: what the page shows and why this action." },
    action: { type: "string", enum: ["click", "fill_from_profile", "choose_from_profile", "choose_option", "set_checkbox", "upload_resume", "run_autofill", "dismiss_dialog", "scroll", "wait", "ask_user", "finish", "read_options", "pick_from_profile", "write_answer"] },
    ref: { type: ["string", "null"], description: "Element ref from the observation (b… button, f… field)." },
    fact: { type: ["string", "null"], description: "A key from available_facts, for *_from_profile actions." },
    option: { type: ["string", "null"], description: "Exact option text, for choose_option." },
    checked: { type: ["boolean", "null"] },
    question: { type: ["string", "null"], description: "For ask_user: the question the page asks." },
    status: { type: ["string", "null"], enum: ["review_ready", "needs_user", "blocked", null] },
  },
  required: ["reasoning", "action", "ref", "fact", "option", "checked", "question", "status"],
  additionalProperties: false,
};

export const AGENT_SYSTEM = `You operate a job-application website for the applicant, one action per turn, like a careful human assistant.
The applicant's goal is in "goal": apply for THAT job. Fill and advance the application for it up to its final review / submit page, then stop.
You see the page as JSON: page_state (Career Atlas's reading: posting, application, questions, login, unknown), widgets (site parts that are NOT the application: search boxes, job alerts / newsletters, site header/footer, cookie banners), buttons b… (with area when inside such a widget), fields f… (label, control, state, options), plus available_facts: which profile facts exist (true/false or a count) and a few non-personal preferences.

First understand the page: is it the job posting, an Apply / sign-in choice, the application form, a questionnaire, the final review, or a blocker? On a job posting, the next step is the control that STARTS the application for this job (Apply, Apply now, I'm interested, Start application…) — not job search, job alerts, "save job", sharing, similar jobs or navigation. Inputs on a posting (site search, alert e-mail) are never the application.

Rules:
- Applicant values come ONLY from the profile: use fill_from_profile / choose_from_profile with a fact key; Career Atlas looks the value up and enters it. You never type personal data yourself.
- choose_option is only for choices that are not about the applicant (e.g. "How would you like to apply?" or a language picker). Questions about the applicant (eligibility, experience, preferences, identity) → choose_from_profile if a fact covers it, else ask_user.
- Identity / self-identification questions (gender, race, disability, veteran, Indigenous, pronouns) → ask_user unless the page already has them done.
- Agreements, declarations, privacy consents: a field or button marked consent "approved" is covered by the applicant's approval — tick it with set_checkbox (or choose its affirmative option / click it) and continue; one marked "applicant_decides" → ask_user. Never tick or accept anything else.
- Checkboxes: set_checkbox (Career Atlas clicks where the box is drawn and verifies it). choose_from_profile / pick_from_profile / read_options are not for checkboxes.
- Repeated sections (work history, education) and long standard forms → run_autofill first; it fills everything the profile covers and verifies it.
- Composite controls: a field's "group" names the question its part belongs to (a bare "Month" under "Graduation date"); "related" tells how a phone is split. For a phone number use fact contact.phone on the number box and location.phone_country on a separate country-code control — Career Atlas formats the number for that layout. A placeholder is only an example format, never a value.
- To start: click the button that opens the application (Apply, Start, Begin, Continue as guest…). Never create an account or sign in; if the page requires it, finish with needs_user.
- Informational pop-ups (OK, Got it, Close) → dismiss_dialog with that button's ref. Cookie banners: only a reject / necessary-only choice, or leave the banner alone.
- Never act on buttons whose area is search, subscription or matching; they are not part of the application. Buttons with area "chrome" are the site's navigation: only use one that starts this job's application.
- "frames" lists embedded documents: if the application appears to live in one (a large frame from a career / applicant system), finish with status needs_user — Career Atlas opens frames itself. Do not click unrelated links hoping to find it.
- After filling a step, click the button that moves to the next step (Next, Continue, Save and continue, Proceed…).
- NEVER click the final submit button (Submit, Submit application, Send…). When the page is the final review / submit step, finish with status review_ready.
- CAPTCHA or bot check → finish with needs_user.
- Fields marked answer_on_file: the applicant answered them — fill_from_profile / choose_from_profile with fact "applicant_answer".
- Fields marked asked_applicant are waiting for the applicant: never ask again; continue with other fields, and when nothing else can be done, finish with needs_user. Optional questions may stay empty.
- "situation" (when present) says why you were called in: what Career Atlas's own flow expected and what it found instead. Resolve THAT, then the flow continues by itself.
- Unfamiliar controls are your job, not the applicant's: read_options opens a dropdown / autocomplete / menu (field or button ref) and shows its real choices; pick_from_profile (ref = the control or the button that opens it, fact = a fact key) makes Career Atlas open it, find the choice that means the applicant's fact, click and verify it — use it for custom dropdowns, autocompletes and button lists, or when choose_from_profile failed.
- Fact meanings: contact.address = street address (line 1); contact.postal_code = postal / ZIP code; location.city / location.region / location.country = where the applicant lives; location.full = "City, Region, Country" for a single location box; location.phone_country = the phone number's country (calling code).
- Open questions (describe a project, why this role, tell us about…) → write_answer: Career Atlas writes the answer from the applicant's verified records and fills it. Never ask the applicant to write it.
- Ask the applicant ONLY for facts or decisions no profile fact covers, identity questions, or consents — never about how a page works.
- If the last action failed, try a different approach; do not repeat the same failing action.
Keep "reasoning" to one short sentence.`;

const SUBMIT_RE = /^\s*(submit|submit (my |your )?(application|candidacy)|send\s*$|send( my)? application|complete( my)? application|finish( and submit)?|confirm and submit|apply now and submit)\b/i;
const ACCOUNT_RE = /\b(create (an |my )?account|sign ?up|register|sign ?in|log ?in)\b/i;
const LEGAL_RE = /\b(i (hereby )?(agree|consent|certify|attest|declare|acknowledge|accept)|terms (and|&) conditions|privacy (policy|notice)|consent|certif|attest|background check|signature)/i;

export interface ValidationContext {
  obs: AgentObservation;
  fields: FieldDescriptor[];
  profile: Profile;
  employer: string | null;
  answers?: Record<string, unknown>;
  /** Field keys already asked in this run. */
  asked?: Set<string>;
  /** Standing authorisations (see ObserveContext.consentApproved). */
  consentApproved?: (text: string, key: string) => boolean;
}



/** Trusted checks: what the model may NOT do, whatever it proposes. Returns a refusal reason or null. */
export function validate(a: AgentAction, v: ValidationContext): string | null {
  const btn = "ref" in a && a.ref ? v.obs.buttons.find((b) => b.ref === a.ref) : undefined;
  const field = "ref" in a && a.ref ? v.fields.find((f) => f.ref === a.ref) : undefined;
  switch (a.action) {
    case "click":
    case "dismiss_dialog": {
      if (!btn && !field) return "unknown ref — use a ref from the current observation";
      const text = btn?.text ?? field?.label ?? "";
      // Purpose, not wording: a control inside a site widget is not part of this application.
      if (btn?.area === "search" || btn?.area === "subscription" || btn?.area === "matching") return `this control belongs to the site's ${btn.area === "search" ? "job search" : btn.area === "matching" ? "job-matching tool" : "job-alert / newsletter sign-up"}, not to the application for this job`;
      // Cookie banners by what the control does: reject / necessary-only or opening the settings — never consent.
      if (btn?.area === "cookie" && cookieChoice(text) === "consent") return "cookie banners: never accept — choose reject / necessary-only, open the settings, or leave the banner";
      // The site's navigation (header, menus, footer) is not part of the application, unless it starts one.
      if (btn?.area === "chrome" && !APPLY_CTA_RE.test(text) && cookieChoice(text) !== "private") return "this is the site's navigation (header / menu / footer), not part of the application for this job";
      if (SUBMIT_RE.test(text)) return "the final submit button is never clicked by the agent — finish with review_ready";
      // A button that gives a consent: only within the applicant's approval for that statement.
      if (btn && !btn.area && CONSENT_BTN_RE.test(btn.text) && !v.consentApproved?.(`${btn.text} ${btn.context ?? ""}`, buttonConsentKey(btn))) return "this gives a consent the applicant has not approved — ask_user";
      if (ACCOUNT_RE.test(text) && !/guest|without (an )?account/i.test(text)) return "creating accounts and signing in are not done by the agent — finish with needs_user";
      if (field && (field.control === "checkbox" || field.control === "radio" || field.control === "checkboxes")) return "use set_checkbox / choose_* for form controls";
      if (field?.inputType === "password") return "password fields are never touched by the agent";
      return null;
    }
    case "fill_from_profile":
    case "choose_from_profile": {
      if (!field) return "unknown field ref";
      if (field.inputType === "password") return "password fields are never touched by the agent";
      // The applicant's own answer to this very question: allowed for any question, identity and declarations included.
      if (a.fact === "applicant_answer") return answered(v.answers ?? {}, field) ? null : "the applicant has not answered this question — ask_user";
      if (!(a.fact in FACTS) && !a.fact.startsWith("defaults.")) return `unknown fact "${a.fact}" — use a key from available_facts (profile_summary holds counts, not facts)`;
      if (a.fact.startsWith("defaults.") && !(PREFS as readonly string[]).includes(a.fact.slice(9))) return `unknown preference "${a.fact}"`;
      if (field.demographic || DEMO_RE.test(field.label)) return "identity questions are answered only by the applicant — ask_user";
      if (LEGAL_RE.test(field.label) && CHOICE.has(field.control)) return approvedConsent(field, v.answers ?? {}, v.consentApproved) ? null : "declarations need the applicant's approval — ask_user";
      return null;
    }
    case "choose_option": {
      if (!field) return "unknown field ref";
      if (field.options.length && !field.options.some((o) => norm(o.label) === norm(a.option))) return "that option is not offered by this field";
      if (field.demographic || DEMO_RE.test(field.label)) return "identity questions are answered only by the applicant — ask_user";
      if (LEGAL_RE.test(field.label)) return approvedConsent(field, v.answers ?? {}, v.consentApproved) && /^\s*(yes|i agree|agree|i consent|consent|i accept|accept|i acknowledge|acknowledged?|i understand)\b/i.test(a.option) && !/\b(not|decline|do not|don't)\b/i.test(a.option) ? null : "declarations need the applicant's approval — ask_user";
      if (questionMeaning(field.label, v.employer).meaning !== "unknown") return "this question is about the applicant — use choose_from_profile or ask_user";
      const sem = classify(field);
      if (!["unknown", "open_ended"].includes(sem)) return `this field is the applicant's ${sem} — use choose_from_profile / fill_from_profile`;
      return null;
    }
    case "set_checkbox": {
      if (!field) return "unknown field ref";
      // An agreement is ticked only within the applicant's approval: their answer to it, or a standing authorisation.
      if (a.checked && LEGAL_RE.test(field.label) && !approvedConsent(field, v.answers ?? {}, v.consentApproved)) return "agreements are ticked only with the applicant's approval — ask_user";
      if (field.demographic || DEMO_RE.test(field.label)) return "identity questions are answered only by the applicant — ask_user";
      return null;
    }
    case "upload_resume":
      return a.ref && !field ? "unknown field ref" : null;
    case "read_options":
    case "pick_from_profile": {
      if (!btn && !field) return "unknown ref — use a ref from the current observation";
      const text = btn?.text ?? field?.label ?? "";
      if (btn?.area === "search" || btn?.area === "subscription" || btn?.area === "matching") return "that control belongs to a site widget, not to the application";
      if (SUBMIT_RE.test(text) || (ACCOUNT_RE.test(text) && !/guest|without (an )?account/i.test(text))) return "not a choice control";
      if (field?.inputType === "password") return "password fields are never touched by the agent";
      if (a.action === "pick_from_profile") {
        if (a.fact !== "applicant_answer" && !(a.fact in FACTS) && !a.fact.startsWith("defaults.")) return `unknown fact "${a.fact}" — use a key from available_facts`;
        if (a.fact !== "applicant_answer" && (field?.demographic || DEMO_RE.test(text))) return "identity questions are answered only by the applicant — ask_user";
        if (a.fact !== "applicant_answer" && LEGAL_RE.test(text)) return "declarations need the applicant's approval — ask_user";
        if (field && field.control === "checkbox") return "this is a checkbox — use set_checkbox";
      }
      return null;
    }
    case "write_answer": {
      if (!field) return "unknown field ref";
      if (field.control !== "text" && field.control !== "textarea") return "write_answer is for free-text fields";
      if (field.demographic || DEMO_RE.test(field.label) || LEGAL_RE.test(field.label)) return "identity questions and declarations are answered only by the applicant — ask_user";
      return null;
    }
    case "ask_user":
      if (!a.question?.trim()) return "ask_user needs the question text";
      if (field && v.asked?.has(fieldKey(field))) return "already asked — continue with the other fields, or finish with needs_user";
      if (field && isAgreement(field) && approvedConsent(field, v.answers ?? {}, v.consentApproved)) return "the applicant already approved this agreement — set_checkbox (or choose its affirmative option); if the page does not keep it, try another way (click the box drawn beside it, its label)";
      if (field && answered(v.answers ?? {}, field)) return "the applicant already answered — use fact applicant_answer";
      return null;
    default:
      return null;
  }
}

/** Parses the model's JSON into a typed action (null fields dropped). */
export function toAgentAction(raw: Record<string, unknown>): AgentAction | null {
  const s = (k: string) => (typeof raw[k] === "string" && raw[k] ? String(raw[k]) : undefined);
  switch (raw.action) {
    case "click":
    case "dismiss_dialog":
      return s("ref") ? { action: raw.action, ref: s("ref")! } : null;
    case "fill_from_profile":
    case "choose_from_profile":
      return s("ref") && s("fact") ? { action: raw.action, ref: s("ref")!, fact: s("fact")! } : null;
    case "choose_option":
      return s("ref") && s("option") ? { action: "choose_option", ref: s("ref")!, option: s("option")! } : null;
    case "set_checkbox":
      return s("ref") ? { action: "set_checkbox", ref: s("ref")!, checked: raw.checked === true } : null;
    case "upload_resume":
      return { action: "upload_resume", ref: s("ref") };
    case "run_autofill":
    case "scroll":
    case "wait":
      return { action: raw.action };
    case "ask_user":
      return { action: "ask_user", ref: s("ref"), question: s("question") ?? "" };
    case "read_options":
    case "write_answer":
      return s("ref") ? { action: raw.action, ref: s("ref")! } : null;
    case "pick_from_profile":
      return s("ref") && s("fact") ? { action: "pick_from_profile", ref: s("ref")!, fact: s("fact")! } : null;
    case "finish":
      return { action: "finish", status: (["review_ready", "needs_user", "blocked"].includes(String(raw.status)) ? raw.status : "blocked") as "review_ready" | "needs_user" | "blocked", reason: s("reasoning") ?? "" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the loop

export type Proposer = (system: string, user: string, schema: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface AgentHost {
  /** "Apply for <job title> at <employer>". */
  goal: string;
  /** Why the agent was called in (what Career Atlas's flow expected and found) — no applicant values. */
  situation?: () => string | null;
  /** The answer engine for an open question in this field (null when AI answer writing is off). */
  writeAnswer?: ((page: Page, field: FieldDescriptor) => Promise<{ ok: boolean; note: string }>) | null;
  /** Which offered choice is the same as a profile value (owner opt-in); null when unavailable. */
  judge?: ((value: string, options: string[]) => Promise<string | null>) | null;
  /** True once an Apply / guest action led into the application (page-state hint for the model). */
  inWorkflow?: () => boolean;
  /** Is this agreement covered by the applicant's standing authorisations (Application Defaults)? */
  consentApproved?: (text: string, key: string) => boolean;
  planCtx: PlanContext;
  resume: { name: string; mimeType: string; buffer: Buffer };
  /** Proposes the next action (Codex in the app; a scripted stand-in in tests). */
  propose: Proposer;
  /** Career Atlas's deterministic filler for the current page (rows + fields), as a tool. */
  autofill: (page: Page) => Promise<{ verified: number; open: string[] }>;
  guard: () => Promise<void>;
  event: (code: string, params?: Record<string, string | number>) => Promise<void>;
  record: (f: FilledField) => void;
  /** Local trace (structure only) for diagnosis. */
  trace?: (entry: Record<string, unknown>) => void;
}

export interface AgentOutcome {
  status: "review_ready" | "needs_user" | "blocked" | "step_limit" | "failed_repeatedly";
  reason: string;
  questions: PendingQuestion[];
  steps: number;
  page: Page;
}

/** Element under a ref: a field (data-ca-ref) or a button / link (data-ca-btn). */
const byRef = (page: Page, ref: string) => page.locator(`[data-ca-ref="${ref}"], [data-ca-btn="${ref}"]`).first();

/** One decision of the agent, as the caller sees it. */
export type AgentStep =
  | { kind: "acted"; ok: boolean; note: string; action: AgentAction; target: string; reasoning: string; page: Page; from: PageState }
  | { kind: "refused"; reason: string; action: AgentAction; target: string; reasoning: string }
  | { kind: "finish"; outcome: AgentOutcome; reasoning: string }
  | { kind: "stop"; outcome: AgentOutcome };

/**
 * The agent as a sequence of decisions. `step` takes ONE decision (observe → propose → validate → act →
 * verify); the engine uses it inside its own loop (e.g. on a job posting), and `run` repeats it.
 */
export function createAgent(host: AgentHost) {
  const questions: PendingQuestion[] = [];
  const history: string[] = [];
  const asked = new Set<string>();
  let lastResult = "none yet";
  let failures = 0;
  let lastSig = "";
  let n = 0;
  const out = (page: Page, status: AgentOutcome["status"], reason: string): AgentOutcome => ({ status, reason, questions, steps: n, page });

  /**
   * One decision without acting: observe → the model proposes → Career Atlas validates. `step` acts on it;
   * the reasoning evaluation (tests/lab) grades it against ground truth.
   */
  async function decide(page: Page, o: { lastResult?: string; history?: string[] } = {}) {
    const { obs, fields } = await observeForModel(page, { goal: host.goal, answers: host.planCtx.answers, asked, inWorkflow: host.inWorkflow?.(), consentApproved: host.consentApproved });
    const situation = host.situation?.() ?? null;
    const user = JSON.stringify({ step: n, ...(situation ? { situation } : {}), last_action_result: o.lastResult ?? lastResult, recent_actions: (o.history ?? history).slice(-6), available_facts: factCatalog(host.planCtx.profile), profile_summary: profileSummary(host.planCtx.profile), page: obs });
    const raw = await host.propose(AGENT_SYSTEM, user.slice(0, 30_000), PROPOSAL_SCHEMA);
    const action = toAgentAction(raw);
    const reasoning = String(raw.reasoning ?? "").slice(0, 240);
    const target = action && "ref" in action && action.ref ? (obs.buttons.find((b) => b.ref === action.ref)?.text ?? obs.fields.find((f) => f.ref === action.ref)?.label ?? action.ref) : "";
    const refusal = action ? validate(action, { obs, fields, profile: host.planCtx.profile, employer: host.planCtx.employer ?? null, answers: host.planCtx.answers, asked, consentApproved: host.consentApproved }) : "invalid proposal";
    return { obs, fields, raw, action, reasoning, target: String(target), refusal };
  }

  async function step(page: Page): Promise<AgentStep> {
    n++;
    await host.guard();
    // Indeed pages are never automated (project rule), wherever a link led.
    const at = (() => {
      try {
        return new URL(page.url()).hostname;
      } catch {
        return "";
      }
    })();
    if (isIndeedOwnedHost(at)) return { kind: "stop", outcome: out(page, "blocked", "Indeed pages are never automated") };
    // OBSERVE (purpose first: widgets are marked and described as such) → PLAN (the model) → VALIDATE
    let d: Awaited<ReturnType<typeof decide>>;
    try {
      d = await decide(page);
    } catch {
      return { kind: "stop", outcome: out(page, "blocked", "the AI provider did not answer") };
    }
    const { obs, fields, action: a, reasoning, refusal } = d;
    const observed = { url: obs.url, page_state: obs.page_state, headings: obs.headings.slice(0, 4), widgets: obs.widgets.map((w) => `${w.kind}: ${w.heading || w.buttons.slice(0, 2).join(" / ")}`), buttons: obs.buttons.length, fields: obs.fields.length };
    if (!a) {
      lastResult = "invalid proposal — use the schema";
      host.trace?.({ step: n, observation: observed, proposal: "invalid" });
      if (++failures >= 3) return { kind: "stop", outcome: out(page, "failed_repeatedly", "invalid proposals") };
      return { kind: "refused", reason: "invalid proposal", action: { action: "wait" }, target: "", reasoning };
    }
    const target = d.target;
    await host.event("agent_proposed", { action: a.action, target: String(target).slice(0, 60) });
    host.trace?.({ step: n, observation: observed, reasoning, proposal: { action: a.action, target: String(target).slice(0, 80) }, check: refusal ? `refused: ${refusal}` : "allowed" });
    // Asking again about a question already recorded: the model is waiting for the applicant — stop here.
    if (refusal && a.action === "ask_user" && questions.length) return { kind: "stop", outcome: out(page, "needs_user", "waiting for the applicant's answers") };
    if (refusal) {
      lastResult = `REFUSED: ${refusal}`;
      history.push(`${a.action} ${target} → refused`);
      await host.event("agent_refused", { action: a.action, reason: refusal.slice(0, 80) });
      if (++failures >= 4) return { kind: "stop", outcome: out(page, "failed_repeatedly", refusal) };
      return { kind: "refused", reason: refusal, action: a, target: String(target), reasoning };
    }
    if (a.action === "finish") return { kind: "finish", outcome: out(page, a.status, a.reason || reasoning), reasoning };
    // ACT + VERIFY
    const sig = JSON.stringify(a);
    const res = await act(page, a, fields, host, questions, asked);
    lastResult = res.ok ? `ok: ${res.note}` : `FAILED: ${res.note}`;
    history.push(`${a.action} ${target} → ${res.ok ? "ok" : "failed"}`);
    await host.event(res.ok ? "agent_verified" : "agent_failed", { action: a.action, note: res.note.slice(0, 80) });
    host.trace?.({ step: n, verification: lastResult });
    const next = res.page ?? page;
    // RECOVER: failures are reported to the model; the same failing action twice is pointed out.
    if (!res.ok) {
      failures++;
      if (sig === lastSig) lastResult += " (same action failed twice — choose a different approach)";
      if (failures >= 4) return { kind: "stop", outcome: out(next, "failed_repeatedly", res.note) };
    } else failures = 0;
    lastSig = sig;
    return { kind: "acted", ok: res.ok, note: res.note, action: a, target: String(target), reasoning, page: next, from: obs.page_state };
  }

  async function run(page: Page, maxSteps = 30): Promise<AgentOutcome> {
    for (let i = 0; i < maxSteps; i++) {
      const r = await step(page);
      if (r.kind === "stop") return r.outcome;
      if (r.kind === "finish") return r.outcome;
      if (r.kind === "acted") page = r.page;
    }
    return out(page, "step_limit", "step limit reached");
  }

  /**
   * Replays one remembered action on a page that looks the same again (no model call): the target is found
   * again by its visible text / label, then validated and executed like any proposal.
   */
  async function replay(page: Page, d: { action: string; target: string; option?: string; fact?: string; checked?: boolean }): Promise<{ ok: boolean; page: Page }> {
    const { obs, fields } = await observeForModel(page, { goal: host.goal, answers: host.planCtx.answers, asked, inWorkflow: host.inWorkflow?.(), consentApproved: host.consentApproved });
    const ref = obs.buttons.find((b) => b.text === d.target)?.ref ?? obs.fields.find((f) => f.label === d.target)?.ref;
    const a = ref || ["run_autofill", "scroll", "wait", "upload_resume"].includes(d.action) ? toAgentAction({ action: d.action, ref: ref ?? null, option: d.option ?? null, fact: d.fact ?? null, checked: d.checked ?? null, question: null, status: null }) : null;
    if (!a || validate(a, { obs, fields, profile: host.planCtx.profile, employer: host.planCtx.employer ?? null, answers: host.planCtx.answers, asked, consentApproved: host.consentApproved })) return { ok: false, page };
    const res = await act(page, a, fields, host, questions, asked);
    host.trace?.({ step: ++n, replayed: { action: a.action, target: d.target.slice(0, 80) }, verification: res.ok ? `ok: ${res.note}` : `FAILED: ${res.note}` });
    return { ok: res.ok, page: res.page ?? page };
  }

  /** A new hand-over: earlier failures and results do not count against it. */
  function reset() {
    failures = 0;
    lastResult = "none yet";
    lastSig = "";
  }

  return { step, run, decide, reset, replay, questions, asked };
}

export async function runBrowserAgent(page: Page, host: AgentHost, maxSteps = 30): Promise<AgentOutcome> {
  return createAgent(host).run(page, maxSteps);
}

async function act(page: Page, a: AgentAction, fields: FieldDescriptor[], host: AgentHost, questions: PendingQuestion[], asked: Set<string>): Promise<{ ok: boolean; note: string; page?: Page }> {
  const field = "ref" in a && a.ref ? fields.find((f) => f.ref === a.ref) : undefined;
  const find: Finder = async () => {
    if (!field) return null;
    const all = await scan(page);
    const x = all.find((y) => y.ref === field.ref) ?? all.find((y) => y.visible && fieldKey(y) === fieldKey(field) && y.group === field.group && y.groupIndex === field.groupIndex);
    return x ? { f: x, loc: page.locator(`[data-ca-ref="${x.ref}"]`) } : null;
  };
  switch (a.action) {
    case "click":
    case "dismiss_dialog": {
      const before = await signature(page);
      const tabs = page.context().pages().length;
      const l = byRef(page, a.ref);
      if (!(await l.count())) return { ok: false, note: "element gone — observe again" };
      await l.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await l.click({ timeout: 8000 }).catch(() => l.click({ force: true, timeout: 5000 }).catch(() => {}));
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(900);
      const pages = page.context().pages();
      if (pages.length > tabs) {
        const fresh = pages[pages.length - 1];
        await fresh.waitForLoadState("domcontentloaded").catch(() => {});
        return { ok: true, note: "a new tab opened — continuing there", page: fresh };
      }
      const after = await signature(page);
      return after !== before ? { ok: true, note: "the page changed" } : { ok: false, note: "nothing changed on the page after the click" };
    }
    case "fill_from_profile":
    case "choose_from_profile": {
      if (!field) return { ok: false, note: "unknown field" };
      const v = resolve(a.fact, field, host.planCtx);
      if (!v.ok) return { ok: false, note: v.note };
      const act1 = toAction(field, fieldKey(field), v.value, v.source);
      if ("misfit" in act1) return { ok: false, note: "the profile's answer matches none of this field's options — ask_user" };
      let ok = false;
      if (act1.kind === "fill") {
        ok = await textSet(page, find, act1.value);
        // A phone counts only as THIS number in THIS country (widgets reformat what was typed).
        if (v.phone) {
          await sleep(300);
          const now = (await scan(page)).find((x) => x.ref === field.ref);
          ok = !!now && phoneAccepted(String(now.value ?? ""), v.phone, now.phone?.dial);
        }
      }
      else if (act1.kind === "check") ok = await checkSet(page, find, act1.value);
      else if (act1.kind === "choose" || act1.kind === "search") {
        const want = act1.kind === "choose" ? act1.values[0] : act1.value;
        const fits = (l: string) => (act1.kind === "search" ? act1.match.every((m) => norm(l).includes(norm(m))) : norm(l) === norm(want));
        const decide = (labels: string[]) => labels.find(fits) ?? null;
        const committed = (x: FieldDescriptor, p: string) => shownMatches(valuesOf(x), p);
        const r = field.control === "combobox" ? await searchSelect(page, find, { queries: [want], choose: decide, committed }) : await listSelect(page, find, decide, committed);
        ok = r.ok;
      } else return { ok: false, note: "unsupported control for this fact" };
      host.record({ label: field.label.slice(0, 300), source: `agent:${v.source}`, verified: ok });
      return ok ? { ok: true, note: "value entered from the profile and verified on the page" } : { ok: false, note: "the page did not keep the value" };
    }
    case "choose_option": {
      if (!field) return { ok: false, note: "unknown field" };
      const decide = (labels: string[]) => labels.find((l) => norm(l) === norm(a.option)) ?? null;
      const committed = (x: FieldDescriptor, p: string) => shownMatches(valuesOf(x), p);
      const r = field.control === "combobox" ? await searchSelect(page, find, { queries: [a.option], choose: decide, committed }) : await listSelect(page, find, decide, committed);
      return r.ok ? { ok: true, note: "option selected and verified" } : { ok: false, note: `could not select it (${r.reason ?? "?"})` };
    }
    case "set_checkbox": {
      const ok = await checkSet(page, find, a.checked);
      return ok ? { ok: true, note: "checkbox state verified" } : { ok: false, note: "the checkbox did not change" };
    }
    case "upload_resume": {
      const target = field ?? (await scan(page)).find((f) => f.control === "file");
      if (!target) return { ok: false, note: "no file field on the page" };
      await page.locator(`[data-ca-ref="${target.ref}"]`).setInputFiles(host.resume).catch(() => {});
      await sleep(1500);
      const now = (await scan(page)).find((f) => f.ref === target.ref);
      const ok = !!now && valuesOf(now).some((n) => norm(n).includes(norm(host.resume.name)));
      // Attached = the page shows the file. Without that evidence it is not reported as done.
      if (ok) await host.event("uploaded_resume", { file: host.resume.name });
      return ok ? { ok: true, note: "resume attached (the page shows the file)" } : { ok: false, note: "no evidence on the page that the resume was attached" };
    }
    case "run_autofill": {
      const r = await host.autofill(page);
      return { ok: true, note: `${r.verified} values filled and verified; still open: ${r.open.slice(0, 8).join("; ") || "none"}` };
    }
    case "read_options": {
      const opener = byRef(page, a.ref);
      if (!(await opener.count())) return { ok: false, note: "element gone — observe again" };
      const choices = await openChoices(page, opener);
      await page.keyboard.press("Escape").catch(() => {});
      return choices.length ? { ok: true, note: `choices shown: ${choices.slice(0, 40).map((c) => c.text).join(" | ")}` } : { ok: false, note: "no choices appeared after opening it" };
    }
    case "pick_from_profile": {
      // The value comes from the profile (Career Atlas), the control is opened and read on the page, the
      // matching choice is clicked and the control must then show it.
      // A button that opens a list has no field: the fact is resolved without one.
      const target: FieldDescriptor = field ?? { ref: a.ref, control: "combobox", inputType: "text", name: "", id: "", label: "", placeholder: "", autocomplete: "", required: false, options: [], section: "", demographic: false, value: [], visible: true };
      const v = resolve(a.fact, target, host.planCtx);
      if (!v.ok) return { ok: false, note: v.note };
      const want = String(Array.isArray(v.value) ? v.value[0] : v.value);
      const opener = byRef(page, a.ref);
      if (!(await opener.count())) return { ok: false, note: "element gone — observe again" };
      const typeable = await opener.isEditable({ timeout: 500 }).catch(() => false);
      let choices = await openChoices(page, opener, typeable ? want : undefined);
      if (!choices.length && typeable) choices = await openChoices(page, opener, want.split(/[\s,]+/)[0]);
      if (!choices.length) return { ok: false, note: "no choices appeared after opening it" };
      const domain = domainForLabel(field?.label ?? "", field ? classify(field) : undefined);
      let pick = (matchOptionSemantic(choices.map((c) => ({ label: c.text, value: c.text })), want, domain)?.label as string | undefined) ?? null;
      if (!pick && host.judge) pick = await host.judge(want, choices.map((c) => c.text)).catch(() => null);
      if (!pick) return { ok: false, note: `none of the ${choices.length} choices means the applicant's answer` };
      const c = choices.find((x) => x.text === pick)!;
      await page.locator(`[data-ca-pick="${c.i}"]`).first().click({ timeout: 4000 }).catch(() => {});
      await sleep(600);
      // Verified when the control (or the block around it) now shows the chosen text.
      const shown = await opener
        .evaluate((el, t) => {
          const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
          const box = el.closest("[role=group], fieldset, li, [class*=field], [class*=Field], div") ?? el;
          const value = (el as unknown as { value?: string }).value ?? "";
          return norm(value).includes(norm(t)) || norm((box as unknown as { innerText?: string }).innerText ?? "").includes(norm(t));
        }, pick)
        .catch(() => false);
      host.record({ label: (field?.label ?? "choice").slice(0, 300), source: `agent:${v.source}`, verified: shown });
      return shown ? { ok: true, note: `“${pick}” chosen and shown by the control` } : { ok: false, note: "the control did not keep the choice" };
    }
    case "write_answer": {
      if (!field) return { ok: false, note: "unknown field" };
      if (!host.writeAnswer) return { ok: false, note: "AI answer writing is off — ask_user" };
      return host.writeAnswer(page, field);
    }
    case "scroll":
      await page.mouse.wheel(0, 800).catch(() => {});
      await sleep(300);
      return { ok: true, note: "scrolled" };
    case "wait":
      await sleep(2500);
      return { ok: true, note: "waited" };
    case "ask_user": {
      const f = field;
      const key = f ? fieldKey(f) : `agent:${norm(a.question).slice(0, 120)}`;
      asked.add(key);
      if (!questions.some((q) => q.key === key))
        // A field's question keeps the SITE's wording and options (not the model's paraphrase).
        questions.push(f ? question(f, key, f.demographic || DEMO_RE.test(f.label) ? "demographic" : LEGAL_RE.test(f.label) ? "legal" : "missing", f.demographic || DEMO_RE.test(f.label) || LEGAL_RE.test(f.label)) : { key, label: a.question.slice(0, 500), kind: "text", required: true, options: [], reason: "missing", sensitive: false, hint: null });
      return { ok: true, note: "recorded for the applicant; continue with other fields" };
    }
    default:
      return { ok: false, note: "unsupported" };
  }
}

/** A value from My Profile for a fact key, resolved by Career Atlas (never by the model). */
function resolve(fact: string, f: FieldDescriptor, ctx: PlanContext): { ok: true; value: unknown; source: string; phone?: CanonicalPhone } | { ok: false; note: string } {
  if (fact === "applicant_answer") {
    const v = ctx.answers[fieldKey(f)];
    return v === undefined || v === null || v === "" ? { ok: false, note: "no answer on file — ask_user" } : { ok: true, value: v, source: "answer" };
  }
  if (fact.startsWith("defaults.")) {
    const k = fact.slice(9) as keyof Profile["application_defaults"];
    const v = ctx.profile.application_defaults[k];
    if (v === null || v === undefined || v === "") return { ok: false, note: "the applicant has not saved that preference — ask_user" };
    // The planner maps a saved default onto this field's options (semantic, never a guess).
    const plan = planForm([f], { ...ctx, answers: {} });
    const a = plan.actions[0];
    if (a && (a.kind === "choose" || a.kind === "fill" || a.kind === "check" || a.kind === "search")) return { ok: true, value: a.kind === "choose" ? a.values[0] : a.kind === "check" ? a.value : a.value, source: `defaults.${String(k)}` };
    return { ok: true, value: k === "preferred_contact_method" ? (v === "email" ? "Email" : v === "phone" ? "Phone" : "Text") : v, source: `defaults.${String(k)}` };
  }
  if (fact === "education.graduation") {
    const sv = screeningValue({ ...questionMeaning("graduation date", null), meaning: "graduation_date" }, ctx, f.label);
    if (!sv?.ok) return { ok: false, note: (sv && !sv.ok && sv.hint) || "graduation not in the profile — ask_user" };
    // One part of a composite date (a bare Month / Year control) gets that part only.
    const part = datePartOf(f);
    if (!part) return { ok: true, value: sv.value, source: sv.source };
    const v = parseDateAnswer(String(sv.value))?.[part];
    return v ? { ok: true, value: part === "month" ? MONTH_NAMES[Number(v) - 1] : v, source: sv.source } : { ok: false, note: `the profile has no ${part} for it — ask_user` };
  }
  const sem = FACTS[fact];
  if (!sem || sem === "default") return { ok: false, note: "unknown fact" };
  const r = profileValue(sem, f, ctx);
  return r.ok ? { ok: true, value: r.value, source: r.source, phone: r.phone } : { ok: false, note: r.reason === "sensitive" ? "eligibility not on file for this question — ask_user" : r.hint || "not in the profile — ask_user" };
}

async function signature(page: Page): Promise<string> {
  return String(
    await page
      .evaluate(`(() => location.href + '|' + document.querySelectorAll('input,select,textarea,button,[role=dialog]').length + '|' + (document.body ? document.body.innerText.length : 0))()`)
      .catch(() => ""),
  );
}

export const _agentTest = { stateOf };
