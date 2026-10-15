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
import { checkSet, listSelect, scan, searchSelect, shownMatches, textSet, valuesOf, type Finder } from "./interact";
import { classify, fieldKey, norm, planForm, profileValue, question, toAction, type FieldDescriptor, type PlanContext, type Semantic } from "./plan";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- observation

export interface AgentButton {
  ref: string;
  text: string;
  disabled?: boolean;
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
}
export interface AgentObservation {
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
    buttons.push(b);
    if (buttons.length >= 60) break;
  }
  document.documentElement.setAttribute('data-ca-bseq', String(n));
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .modal.show')].filter(vis).map((d) => clean(d.innerText).slice(0, 400));
  const headings = [...document.querySelectorAll('h1, h2, h3, legend, [role="heading"]')].filter(vis).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 15);
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

export async function observeForModel(page: Page, answers: Record<string, unknown> = {}, asked: Set<string> = new Set()): Promise<{ obs: AgentObservation; fields: FieldDescriptor[] }> {
  const base = (await page.evaluate(OBSERVE_JS)) as Omit<AgentObservation, "fields">;
  const fields = (await scan(page)).filter((f) => f.visible || f.control === "file");
  const obs: AgentObservation = {
    ...base,
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
      ...(asked.has(fieldKey(f)) ? { asked_applicant: true } : {}),
    })),
  };
  return { obs, fields };
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
};
/** Preferences whose VALUES are not personal facts and help the model map a question. */
const PREFS = ["preferred_contact_method", "prior_employment", "relocation", "travel", "shift_work", "referral", "enrolled_student", "coop_program", "source"] as const;

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
    experience_entries: p.experience.length,
    education_entries: p.education.length,
    skills: p.skills.length,
    languages: p.languages.length,
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
  | { action: "finish"; status: "review_ready" | "needs_user" | "blocked"; reason: string };

export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "One short sentence: what the page shows and why this action." },
    action: { type: "string", enum: ["click", "fill_from_profile", "choose_from_profile", "choose_option", "set_checkbox", "upload_resume", "run_autofill", "dismiss_dialog", "scroll", "wait", "ask_user", "finish"] },
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

export const AGENT_SYSTEM = `You operate a job-application web page for the applicant, one action per turn, like a careful human assistant.
You see the page as JSON (buttons b…, fields f… with label, control, state, options) plus available_facts: which profile facts exist (true/false or a count) and a few non-personal preferences.
Goal: complete the application up to its final review / submit page, then stop.

Rules:
- Applicant values come ONLY from the profile: use fill_from_profile / choose_from_profile with a fact key; Career Atlas looks the value up and enters it. You never type personal data yourself.
- choose_option is only for choices that are not about the applicant (e.g. "How would you like to apply?" or a language picker). Questions about the applicant (eligibility, experience, preferences, identity) → choose_from_profile if a fact covers it, else ask_user.
- Identity / self-identification questions (gender, race, disability, veteran, Indigenous, pronouns) → ask_user unless the page already has them done.
- Agreements, declarations, privacy consents → ask_user (Career Atlas may already have handled routine notices).
- Repeated sections (work history, education) and long standard forms → run_autofill first; it fills everything the profile covers and verifies it.
- To start: click the button that opens the application (Apply, Start, Begin, Continue as guest…). Never create an account or sign in; if the page requires it, finish with needs_user.
- Informational pop-ups (OK, Got it, Close) → dismiss_dialog with that button's ref.
- After filling a step, click the button that moves to the next step (Next, Continue, Save and continue, Proceed…).
- NEVER click the final submit button (Submit, Submit application, Send…). When the page is the final review / submit step, finish with status review_ready.
- CAPTCHA or bot check → finish with needs_user.
- Fields marked answer_on_file: the applicant answered them — fill_from_profile / choose_from_profile with fact "applicant_answer".
- Fields marked asked_applicant are waiting for the applicant: never ask again; continue with other fields, and when nothing else can be done, finish with needs_user. Optional questions may stay empty.
- If the last action failed, try a different approach; do not repeat the same failing action.
Keep "reasoning" to one short sentence.`;

const SUBMIT_RE = /^\s*(submit|submit (my |your )?(application|candidacy)|send( my)? application|complete( my)? application|finish( and submit)?|confirm and submit|apply now and submit)\b/i;
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
      if (SUBMIT_RE.test(text)) return "the final submit button is never clicked by the agent — finish with review_ready";
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
      if (!(a.fact in FACTS) && !a.fact.startsWith("defaults.")) return `unknown fact "${a.fact}" — use a key from available_facts`;
      if (a.fact.startsWith("defaults.") && !(PREFS as readonly string[]).includes(a.fact.slice(9))) return `unknown preference "${a.fact}"`;
      if (field.demographic || DEMO_RE.test(field.label)) return "identity questions are answered only by the applicant — ask_user";
      if (LEGAL_RE.test(field.label) && CHOICE.has(field.control)) return "declarations need the applicant's approval — ask_user";
      return null;
    }
    case "choose_option": {
      if (!field) return "unknown field ref";
      if (field.options.length && !field.options.some((o) => norm(o.label) === norm(a.option))) return "that option is not offered by this field";
      if (field.demographic || DEMO_RE.test(field.label)) return "identity questions are answered only by the applicant — ask_user";
      if (LEGAL_RE.test(field.label)) return "declarations need the applicant's approval — ask_user";
      if (questionMeaning(field.label, v.employer).meaning !== "unknown") return "this question is about the applicant — use choose_from_profile or ask_user";
      const sem = classify(field);
      if (!["unknown", "open_ended"].includes(sem)) return `this field is the applicant's ${sem} — use choose_from_profile / fill_from_profile`;
      return null;
    }
    case "set_checkbox": {
      if (!field) return "unknown field ref";
      if (a.checked && LEGAL_RE.test(field.label)) return "agreements are ticked only with the applicant's approval — ask_user";
      if (field.demographic || DEMO_RE.test(field.label)) return "identity questions are answered only by the applicant — ask_user";
      return null;
    }
    case "upload_resume":
      return a.ref && !field ? "unknown field ref" : null;
    case "ask_user":
      if (!a.question?.trim()) return "ask_user needs the question text";
      if (field && v.asked?.has(fieldKey(field))) return "already asked — continue with the other fields, or finish with needs_user";
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
    case "finish":
      return { action: "finish", status: (["review_ready", "needs_user", "blocked"].includes(String(raw.status)) ? raw.status : "blocked") as "review_ready" | "needs_user" | "blocked", reason: s("reasoning") ?? "" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the loop

export type Proposer = (system: string, user: string, schema: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface AgentHost {
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

export async function runBrowserAgent(page: Page, host: AgentHost, maxSteps = 30): Promise<AgentOutcome> {
  const questions: PendingQuestion[] = [];
  const history: string[] = [];
  let lastResult = "none yet";
  let failures = 0;
  let lastSig = "";
  const asked = new Set<string>();
  for (let step = 1; step <= maxSteps; step++) {
    await host.guard();
    // Indeed pages are never automated (project rule), wherever a link led.
    const at = (() => {
      try {
        return new URL(page.url()).hostname;
      } catch {
        return "";
      }
    })();
    if (isIndeedOwnedHost(at)) return { status: "blocked", reason: "Indeed pages are never automated", questions, steps: step, page };
    // OBSERVE
    const { obs, fields } = await observeForModel(page, host.planCtx.answers, asked);
    // PLAN (the model)
    const user = JSON.stringify({ step, last_action_result: lastResult, recent_actions: history.slice(-6), available_facts: factCatalog(host.planCtx.profile), page: obs });
    let raw: Record<string, unknown>;
    try {
      raw = await host.propose(AGENT_SYSTEM, user.slice(0, 30_000), PROPOSAL_SCHEMA);
    } catch {
      return { status: "blocked", reason: "the AI provider did not answer", questions, steps: step, page };
    }
    const a = toAgentAction(raw);
    const reasoning = String(raw.reasoning ?? "").slice(0, 200);
    if (!a) {
      lastResult = "invalid proposal — use the schema";
      if (++failures >= 3) return { status: "failed_repeatedly", reason: "invalid proposals", questions, steps: step, page };
      continue;
    }
    const label = "ref" in a && a.ref ? (obs.buttons.find((b) => b.ref === a.ref)?.text ?? obs.fields.find((f) => f.ref === a.ref)?.label ?? a.ref) : "";
    await host.event("agent_proposed", { action: a.action, target: String(label).slice(0, 60) });
    host.trace?.({ step, url: obs.url, buttons: obs.buttons.length, fields: obs.fields.length, proposal: { ...a, reasoning } });
    // VALIDATE (trusted)
    const refusal = validate(a, { obs, fields, profile: host.planCtx.profile, employer: host.planCtx.employer ?? null, answers: host.planCtx.answers, asked });
    // Asking again about a question already recorded: the model is waiting for the applicant — stop here.
    if (refusal && a.action === "ask_user" && questions.length) return { status: "needs_user", reason: "waiting for the applicant's answers", questions, steps: step, page };
    if (refusal) {
      lastResult = `REFUSED: ${refusal}`;
      history.push(`${a.action} ${label} → refused`);
      await host.event("agent_refused", { action: a.action, reason: refusal.slice(0, 80) });
      if (++failures >= 4) return { status: "failed_repeatedly", reason: refusal, questions, steps: step, page };
      continue;
    }
    if (a.action === "finish") return { status: a.status, reason: a.reason || reasoning, questions, steps: step, page };
    // ACT + VERIFY
    const sig = JSON.stringify(a);
    const res = await act(page, a, fields, host, questions, asked);
    lastResult = res.ok ? `ok: ${res.note}` : `FAILED: ${res.note}`;
    history.push(`${a.action} ${label} → ${res.ok ? "ok" : "failed"}`);
    await host.event(res.ok ? "agent_verified" : "agent_failed", { action: a.action, note: res.note.slice(0, 80) });
    host.trace?.({ step, result: lastResult });
    if (res.page) page = res.page;
    // RECOVER: the same failing action twice in a row is reported to the model; three failures stop.
    if (!res.ok) {
      failures++;
      if (sig === lastSig) lastResult += " (same action failed twice — choose a different approach)";
      if (failures >= 4) return { status: "failed_repeatedly", reason: res.note, questions, steps: step, page };
    } else failures = 0;
    lastSig = sig;
  }
  return { status: "step_limit", reason: "step limit reached", questions, steps: maxSteps, page };
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
      if (act1.kind === "fill") ok = await textSet(page, find, act1.value);
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
      await host.event("uploaded_resume", { file: host.resume.name });
      return ok ? { ok: true, note: "resume attached" } : { ok: true, note: "file sent (the page does not show its name)" };
    }
    case "run_autofill": {
      const r = await host.autofill(page);
      return { ok: true, note: `${r.verified} values filled and verified; still open: ${r.open.slice(0, 8).join("; ") || "none"}` };
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
function resolve(fact: string, f: FieldDescriptor, ctx: PlanContext): { ok: true; value: unknown; source: string } | { ok: false; note: string } {
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
  const sem = FACTS[fact];
  if (!sem || sem === "default") return { ok: false, note: "unknown fact" };
  const r = profileValue(sem, f, ctx);
  return r.ok ? { ok: true, value: r.value, source: r.source } : { ok: false, note: r.reason === "sensitive" ? "eligibility not on file for this question — ask_user" : "not in the profile — ask_user" };
}

async function signature(page: Page): Promise<string> {
  return String(
    await page
      .evaluate(`(() => location.href + '|' + document.querySelectorAll('input,select,textarea,button,[role=dialog]').length + '|' + (document.body ? document.body.innerText.length : 0))()`)
      .catch(() => ""),
  );
}

export const _agentTest = { stateOf };
