// Deterministic form planning: which value goes into which field, from verified data only.
//
// Pure functions (no browser) so every rule is unit-tested. Sources, in order:
//   1. answers the user gave for this attempt
//   2. answers the user explicitly approved for reuse (exact question match)
//   3. My Profile
// Anything else stays unanswered: a required field becomes a question for the user, an
// optional one is left empty. Unknown is never turned into "No". Voluntary demographic
// questions are never answered automatically, and legal declarations need explicit approval.
//
// Ideas (not code) from the MIT-licensed projects devdattatalele/auto-apply,
// andrewmillercode/Autofill-Jobs and Br1an67/OpenJobAutofill; see docs/AUTO_APPLY.md.
import type { FilledField, PendingQuestion } from "@shared/apply";
import type { Profile } from "@shared/profile";

export type Control = "text" | "textarea" | "select" | "radio" | "checkbox" | "checkboxes" | "file" | "combobox" | "listbox" | "date";

export interface FieldOption {
  value: string;
  label: string;
  /** data-ca-ref of the option's own input (radio / checkbox groups). */
  ref?: string;
}

/** What the in-page scanner reports about one form control (see dom.ts). */
export interface FieldDescriptor {
  ref: string;
  control: Control;
  inputType: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  autocomplete: string;
  required: boolean;
  options: FieldOption[];
  /** Section heading / fieldset legend around the field. */
  section: string;
  /** Inside a voluntary self-identification (EEO) section. */
  demographic: boolean;
  /** Current value (text), selected option labels, or file names. */
  value: string | string[] | boolean | null;
  visible: boolean;
  /** Combobox whose options load only after typing (e.g. a location search). */
  asyncOptions?: boolean;
  /** Workday: the field's formField-<name>. */
  wdField?: string;
  /** Workday repeating panels (work / education / skills): filled by the Workday adapter, not the generic planner. */
  group?: "work" | "education" | "skills" | null;
  groupIndex?: number | null;
  /** The site marked the field as invalid (aria-invalid / Workday inputAlert). */
  invalid?: boolean;
  /** Date fields typed as separate month / day / year inputs (refs). */
  parts?: { month?: string; day?: string; year?: string };
}

export type Semantic =
  | "first_name"
  | "last_name"
  | "full_name"
  | "preferred_name"
  | "email"
  | "phone"
  | "phone_country"
  | "location"
  | "city"
  | "region"
  | "country"
  | "address"
  | "postal_code"
  | "linkedin"
  | "github"
  | "portfolio"
  | "website"
  | "current_company"
  | "current_title"
  | "school"
  | "degree"
  | "discipline"
  | "resume"
  | "cover_letter"
  | "work_authorization"
  | "sponsorship"
  | "driver_licence"
  | "vehicle"
  | "language"
  | "demographic"
  | "legal"
  | "open_ended"
  | "unknown";

export interface PlanContext {
  profile: Profile;
  /** Country of the job (for "Are you authorized to work in this country?"). */
  jobCountry: string | null;
  answers: Record<string, unknown>;
  resume: { fileName: string };
}

export type PlannedAction =
  | { ref: string; key: string; label: string; control: Control; kind: "fill"; value: string; source: string }
  | { ref: string; key: string; label: string; control: Control; kind: "choose"; values: string[]; source: string; optionRefs?: string[] }
  | { ref: string; key: string; label: string; control: Control; kind: "check"; value: boolean; source: string }
  | { ref: string; key: string; label: string; control: Control; kind: "upload"; source: "resume" }
  | { ref: string; key: string; label: string; control: Control; kind: "date"; value: { month?: string; day?: string; year?: string }; parts: { month?: string; day?: string; year?: string }; source: string }
  /** Search-as-you-type combobox: type `value`, then pick the one option containing every `match` part. */
  | { ref: string; key: string; label: string; control: Control; kind: "search"; value: string; match: string[]; source: string };

export interface Plan {
  actions: PlannedAction[];
  questions: PendingQuestion[];
  skipped: { key: string; label: string; reason: string }[];
}

// ---------------------------------------------------------------- text helpers

export const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\*/g, " ")
    .replace(/\(required\)|\(optional\)/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Stable key of a field across page loads (used for the user's answers). */
export function fieldKey(f: Pick<FieldDescriptor, "name" | "id" | "label"> & { wdField?: string }): string {
  if (f.wdField) return `wd:${f.wdField}`.slice(0, 200);
  const n = f.name.replace(/\[\]$/, "");
  if (n && !/^\d+$/.test(n)) return `name:${n}`.slice(0, 200);
  if (f.id && !/^\d+$|^:r/.test(f.id)) return `id:${f.id}`.slice(0, 200);
  return `label:${norm(f.label)}`.slice(0, 200);
}

const LEGAL_RE = /\b(i (hereby )?(agree|consent|acknowledge|certify|confirm|attest|declare|understand)|terms (and|&) conditions|privacy (policy|notice)|consent|acknowledg|certif(y|ication that)|attest|true,? (accurate|correct) and complete|signature|e-?sign|electronic(ally)? sign|background check|drug (test|screen))/;
const DEMOGRAPHIC_RE = /\b(gender|sex|race|racial|ethnic|ethnicity|hispanic|latin[oax]|veteran|disabilit|disabled|sexual orientation|lgbt|transgender|pronoun|indigenous|aboriginal|first nations|visible minority|self[- ]identif|demographic|eeo|equal employment)/;
const OPEN_RE = /\b(why|describe|tell us|explain|cover letter|what interests|motivat|salary|compensation|expected pay|pay expectation|notice period|start date|available to start|availability|how did you hear|where did you hear|referr|previously (worked|employed|applied)|former employee|years of (experience|professional)|how many years|relocat|willing to|commut|travel|anything else|additional information|comments)/;

const LANGS = ["english", "french", "spanish", "mandarin", "chinese", "cantonese", "german", "portuguese", "japanese", "korean", "arabic", "hindi", "punjabi", "italian", "russian", "tagalog", "vietnamese", "dutch", "polish"];

export function classify(f: FieldDescriptor): Semantic {
  const name = f.name.toLowerCase();
  const id = f.id.toLowerCase();
  const ac = f.autocomplete.toLowerCase();
  const label = norm(f.label);
  const keys = `${name} ${id}`;
  const all = `${label} ${norm(f.placeholder)} ${keys.replace(/[_\-[\]]+/g, " ")}`;

  if (f.control === "file") {
    if (/cover/.test(all)) return "cover_letter";
    if (/resume|cv|curriculum/.test(all)) return "resume";
    return "unknown";
  }
  // Voluntary self-identification is recognised before anything else so it is never filled.
  if (/^eeo\[/.test(name) || DEMOGRAPHIC_RE.test(label)) return "demographic";
  // Declarations, consents and signatures need the user's explicit approval (also inside an EEO section).
  if (/^consent\[/.test(name) || /signature/.test(all) || (LEGAL_RE.test(label) && f.control !== "text" && f.control !== "textarea")) return "legal";
  if (f.demographic) return "demographic";
  return classifyStandard(f, name, id, ac, label, keys, all);
}

function classifyStandard(f: FieldDescriptor, name: string, id: string, ac: string, label: string, keys: string, all: string): Semantic {
  if (ac === "given-name" || /(^|[^a-z])(first_?name|firstname|fname|given_?name)/.test(keys) || /^(legal )?first name|^given name/.test(label)) return "first_name";
  if (ac === "family-name" || /(^|[^a-z])(last_?name|lastname|lname|surname|family_?name)/.test(keys) || /^(legal )?last name|^surname|^family name/.test(label)) return "last_name";
  if (/preferred_?name/.test(keys) || /^preferred (first )?name/.test(label)) return "preferred_name";
  if (ac === "name" || name === "name" || /^(full |legal )?name$/.test(label)) return "full_name";
  if (ac === "email" || f.inputType === "email" || /(^|[^a-z])e?-?mail/.test(keys) || /^e ?mail/.test(label)) return "email";
  if (f.control !== "combobox" && f.control !== "select" && f.control !== "listbox" && (ac.startsWith("tel") || f.inputType === "tel" || /phone|mobile/.test(keys) || /^(phone|mobile|telephone|cell)/.test(label))) return "phone";
  if (/linkedin/.test(all)) return "linkedin";
  if (/github/.test(all)) return "github";
  if (/portfolio/.test(all)) return "portfolio";
  if (/^urls\[(other|website)\]/.test(name) || /^(personal )?(website|web site|homepage|blog)( url)?$/.test(label)) return "website";
  if (/work(ing)? (authori[sz]ation|permit)|(legally )?(authori[sz]ed|eligible|entitled|permitted) to work|right to work|work eligib/.test(label)) return "work_authorization";
  if (/sponsor|visa/.test(label)) return "sponsorship";
  if (/driver'?s? ?licen[cs]e|driving licen[cs]e/.test(label)) return "driver_licence";
  if (/\bvehicle\b|\bown (a )?car\b/.test(label)) return "vehicle";
  if (LANGS.some((l) => label.includes(l)) && /speak|fluen|proficien|language|bilingual|written|spoken|read and write/.test(label)) return "language";
  if (OPEN_RE.test(label) || f.control === "textarea") return "open_ended";
  if (name === "org" || /^current (company|employer)|^(company|employer)$|^current or most recent (company|employer)/.test(label)) return "current_company";
  if (/^current (job )?title|^(job )?title$|^current or most recent (job )?title/.test(label)) return "current_title";
  if (id === "school" || /^school|^university|^institution/.test(label)) return "school";
  if (id === "degree" || /^degree|highest (level of )?education/.test(label)) return "degree";
  if (id === "discipline" || /^discipline|^(field of study|major)/.test(label)) return "discipline";
  if (ac === "postal-code" || /postal|zip/.test(all)) return "postal_code";
  if (ac.startsWith("street-address") || ac.startsWith("address-line") || /^(street )?address/.test(label)) return "address";
  if (id === "candidate-location" || name === "location" || /^(current )?location|^where are you (located|based)/.test(label)) return "location";
  if (ac === "address-level2" || /^city|^town/.test(label)) return "city";
  if (ac === "address-level1" || /^(state|province|region)/.test(label)) return "region";
  if (ac === "country" || ac === "country-name" || /^country/.test(label)) return id === "country" && /phone/.test(f.section.toLowerCase()) ? "phone_country" : "country";
  return "unknown";
}

// ---------------------------------------------------------------- profile values

type Resolved =
  | { ok: true; value: string | string[] | boolean; source: string }
  | { ok: false; reason: "missing" | "sensitive" | "legal" | "demographic" | "open_ended" | "unsupported"; hint?: string | null };

const has = (v: unknown) => v !== null && v !== undefined && v !== "";
const yes = (source: string): Resolved => ({ ok: true, value: "yes", source });
const no = (source: string): Resolved => ({ ok: true, value: "no", source });
const LEVEL_RANK: Record<string, number> = { basic: 1, intermediate: 2, professional: 3, fluent: 4, native: 5 };
const DEGREE_WORDS: Record<string, RegExp> = {
  high_school: /high school|secondary|ged/,
  diploma: /diploma|certificate|associate|college/,
  bachelor: /bachelor|undergraduate|\bba\b|\bbs\b|\bbsc\b|\bbcom\b|\bbeng\b/,
  master: /master|\bma\b|\bms\b|\bmsc\b|\bmba\b|\bmeng\b/,
  doctorate: /doctor|ph ?d|\bdphil\b/,
};

function countryOf(label: string, jobCountry: string | null): string | null {
  const l = label.toLowerCase();
  for (const c of ["canada", "united states", "usa", "u s", "united kingdom", "uk", "australia", "germany", "france", "ireland", "china", "singapore", "india", "netherlands"]) {
    if (new RegExp(`\\b${c}\\b`).test(l)) return c === "usa" || c === "u s" ? "united states" : c === "uk" ? "united kingdom" : c;
  }
  return jobCountry ? jobCountry.toLowerCase() : null;
}

const sameCountry = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/^(the )?(us|usa|u\.s\.a?\.?)$/, "united states").replace(/^uk$/, "united kingdom").trim();
  return n(a) === n(b);
};

export function profileValue(sem: Semantic, f: FieldDescriptor, ctx: PlanContext): Resolved {
  const p = ctx.profile;
  const c = p.contact ?? {};
  const label = norm(f.label);
  const currentJob = p.experience.find((e) => e.current);
  switch (sem) {
    case "first_name":
      return has(c.first_name) ? { ok: true, value: c.first_name!, source: "contact.first_name" } : { ok: false, reason: "missing" };
    case "last_name":
      return has(c.last_name) ? { ok: true, value: c.last_name!, source: "contact.last_name" } : { ok: false, reason: "missing" };
    case "preferred_name":
      return has(c.preferred_name) ? { ok: true, value: c.preferred_name!, source: "contact.preferred_name" } : { ok: false, reason: "missing" };
    case "full_name":
      return has(c.first_name) && has(c.last_name) ? { ok: true, value: `${c.first_name} ${c.last_name}`, source: "contact.name" } : { ok: false, reason: "missing" };
    case "email":
      return has(c.email) ? { ok: true, value: c.email!, source: "contact.email" } : { ok: false, reason: "missing" };
    case "phone":
      return has(c.phone) ? { ok: true, value: c.phone!, source: "contact.phone" } : { ok: false, reason: "missing" };
    case "linkedin":
      return has(c.linkedin_url) ? { ok: true, value: c.linkedin_url!, source: "contact.linkedin_url" } : { ok: false, reason: "missing" };
    case "github":
      return has(c.github_url) ? { ok: true, value: c.github_url!, source: "contact.github_url" } : { ok: false, reason: "missing" };
    case "portfolio":
      return has(c.portfolio_url) ? { ok: true, value: c.portfolio_url!, source: "contact.portfolio_url" } : has(c.website_url) ? { ok: true, value: c.website_url!, source: "contact.website_url" } : { ok: false, reason: "missing" };
    case "website":
      return has(c.website_url) ? { ok: true, value: c.website_url!, source: "contact.website_url" } : has(c.portfolio_url) ? { ok: true, value: c.portfolio_url!, source: "contact.portfolio_url" } : { ok: false, reason: "missing" };
    case "address":
      return has(c.address) ? { ok: true, value: c.address!, source: "contact.address" } : { ok: false, reason: "missing" };
    case "postal_code":
      return has(c.postal_code) ? { ok: true, value: c.postal_code!, source: "contact.postal_code" } : { ok: false, reason: "missing" };
    case "city":
      return has(p.based_in.city) ? { ok: true, value: p.based_in.city!, source: "based_in.city" } : { ok: false, reason: "missing" };
    case "region":
      return has(p.based_in.region) ? { ok: true, value: p.based_in.region!, source: "based_in.region" } : { ok: false, reason: "missing" };
    case "country":
    case "phone_country":
      return has(p.based_in.country) ? { ok: true, value: p.based_in.country!, source: "based_in.country" } : { ok: false, reason: "missing" };
    case "location": {
      const parts = [p.based_in.city, p.based_in.region, p.based_in.country].filter(has) as string[];
      if (!has(p.based_in.city)) return { ok: false, reason: "missing" };
      return { ok: true, value: parts.join(", "), source: "based_in" };
    }
    case "current_company":
      return currentJob?.organization ? { ok: true, value: currentJob.organization, source: "experience.current" } : { ok: false, reason: "missing" };
    case "current_title":
      return currentJob ? { ok: true, value: currentJob.title, source: "experience.current" } : { ok: false, reason: "missing" };
    case "school": {
      const e = latestEducation(p);
      return e?.institution ? { ok: true, value: e.institution, source: "education" } : { ok: false, reason: "missing" };
    }
    case "discipline": {
      const e = latestEducation(p);
      return e?.field ? { ok: true, value: e.field, source: "education" } : { ok: false, reason: "missing" };
    }
    case "degree": {
      const e = latestEducation(p);
      if (!e) return { ok: false, reason: "missing" };
      // Only a direct level match; never a degree equivalence.
      const re = DEGREE_WORDS[e.level];
      const opt = re ? f.options.filter((o) => re.test(norm(o.label))) : [];
      return opt.length === 1 ? { ok: true, value: opt[0].label, source: "education" } : { ok: false, reason: "missing", hint: e.level };
    }
    case "work_authorization": {
      const country = countryOf(label, ctx.jobCountry);
      if (!country) return { ok: false, reason: "sensitive" };
      const entry = p.work_authorization.find((w) => sameCountry(w.country, country));
      if (!entry) return { ok: false, reason: "sensitive" };
      if (entry.status === "citizen" || entry.status === "permanent_resident" || entry.status === "work_permit") return yes(`work_authorization.${entry.status}`);
      if (entry.status === "needs_sponsorship") return no("work_authorization.needs_sponsorship");
      return { ok: false, reason: "sensitive", hint: entry.status };
    }
    case "sponsorship": {
      const country = countryOf(label, ctx.jobCountry);
      const entry = country ? p.work_authorization.find((w) => sameCountry(w.country, country)) : undefined;
      if (!entry) return { ok: false, reason: "sensitive" };
      if (entry.status === "citizen" || entry.status === "permanent_resident") return no(`work_authorization.${entry.status}`);
      if (entry.status === "needs_sponsorship") return yes("work_authorization.needs_sponsorship");
      // A work permit may or may not need future sponsorship: only the user can say.
      return { ok: false, reason: "sensitive", hint: entry.status };
    }
    case "driver_licence": {
      const d = p.driver_licence;
      if (d.has === true) return yes("driver_licence.has");
      if (d.has === false) return no("driver_licence.has");
      return { ok: false, reason: "sensitive" };
    }
    case "vehicle": {
      const d = p.driver_licence;
      if (d.has_vehicle === true) return yes("driver_licence.has_vehicle");
      if (d.has_vehicle === false) return no("driver_licence.has_vehicle");
      return { ok: false, reason: "sensitive" };
    }
    case "language": {
      const lang = LANGS.find((l) => label.includes(l))!;
      const entry = p.languages.find((x) => {
        const n = x.language.toLowerCase();
        return n === lang || (lang === "chinese" && n === "mandarin") || (lang === "mandarin" && n === "chinese");
      });
      if (!entry) return { ok: false, reason: "missing" };
      // Yes only for a working level; a lower level is the user's call (never inferred).
      if (LEVEL_RANK[entry.level] >= LEVEL_RANK.professional) return yes(`languages.${entry.language}`);
      return { ok: false, reason: "missing", hint: entry.level };
    }
    case "resume":
      return { ok: true, value: ctx.resume.fileName, source: "resume" };
    case "demographic":
      return { ok: false, reason: "demographic" };
    case "legal":
      return { ok: false, reason: "legal" };
    case "open_ended":
      return { ok: false, reason: "open_ended" };
    case "cover_letter":
      return { ok: false, reason: "unsupported" };
    default:
      return { ok: false, reason: "missing" };
  }
}

function latestEducation(p: Profile) {
  return [...p.education].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0];
}

// ---------------------------------------------------------------- options

const YES_RE = /^(yes|y|true|oui|是)\b/;
const NO_RE = /^(no|n|false|non|否)\b/;

/** Maps an answer onto one of the field's options. Never guesses between several candidates. */
export function matchOption(options: FieldOption[], answer: string): FieldOption | null {
  const a = norm(answer);
  if (!a) return null;
  const labels = options.map((o) => ({ o, l: norm(o.label), v: norm(o.value) }));
  const exact = labels.filter((x) => x.l === a || x.v === a);
  if (exact.length === 1) return exact[0].o;
  if (a === "yes" || a === "no") {
    const re = a === "yes" ? YES_RE : NO_RE;
    const hits = labels.filter((x) => re.test(x.l));
    return hits.length === 1 ? hits[0].o : null;
  }
  const starts = labels.filter((x) => x.l.startsWith(a) || (x.l.length > 2 && a.startsWith(x.l)));
  if (starts.length === 1) return starts[0].o;
  const contains = labels.filter((x) => x.l.includes(a));
  return contains.length === 1 ? contains[0].o : null;
}

const isPlaceholderOption = (o: FieldOption) => !o.value || /^(select|choose|please select|--)/.test(norm(o.label)) || norm(o.label) === "";

// ---------------------------------------------------------------- plan

export function savedAnswerFor(profile: Profile, label: string): unknown {
  const n = norm(label);
  if (!n) return undefined;
  return profile.saved_answers.find((s) => norm(s.question) === n)?.answer;
}

export function question(f: FieldDescriptor, key: string, reason: string, sensitive: boolean, hint?: string | null): PendingQuestion {
  const kind: PendingQuestion["kind"] =
    f.control === "textarea" ? "textarea" : f.control === "select" || f.control === "combobox" || f.control === "listbox" ? "select" : f.control === "date" ? "date" : f.control === "radio" ? "radio" : f.control === "checkbox" ? "checkbox" : f.control === "checkboxes" ? "multi" : f.inputType === "date" ? "date" : f.inputType === "number" ? "number" : "text";
  return {
    key,
    label: (f.label || f.placeholder || f.name || f.id).slice(0, 500),
    kind,
    required: f.required,
    options: f.options.filter((o) => !isPlaceholderOption(o)).map((o) => o.label.slice(0, 300)).slice(0, 100),
    reason,
    sensitive,
    hint: hint ?? null,
  };
}

const SENSITIVE_SEMANTICS = new Set<Semantic>(["work_authorization", "sponsorship", "driver_licence", "vehicle", "legal", "demographic"]);

/** Turns a resolved value into a concrete action for the control, or null when it does not fit. */
export function toAction(f: FieldDescriptor, key: string, value: unknown, source: string): PlannedAction | { misfit: string } {
  const base = { ref: f.ref, key, label: f.label, control: f.control };
  switch (f.control) {
    case "text":
    case "textarea":
      if (typeof value === "boolean") return { misfit: String(value) };
      return { ...base, kind: "fill", value: Array.isArray(value) ? value.join(", ") : String(value), source };
    case "checkbox": {
      if (typeof value === "boolean") return { ...base, kind: "check", value, source };
      const s = norm(String(value));
      if (YES_RE.test(s)) return { ...base, kind: "check", value: true, source };
      if (NO_RE.test(s)) return { ...base, kind: "check", value: false, source };
      return { misfit: String(value) };
    }
    case "date": {
      const d = parseDateAnswer(typeof value === "string" ? value : "");
      const p = f.parts ?? {};
      if (!d || (p.month && !d.month) || (p.day && !d.day) || (p.year && !d.year)) return { misfit: String(value) };
      return { ...base, kind: "date", value: { month: p.month ? d.month : undefined, day: p.day ? d.day : undefined, year: p.year ? d.year : undefined }, parts: p, source };
    }
    case "listbox":
    case "select":
    case "radio": {
      const opt = matchOption(f.options.filter((o) => !isPlaceholderOption(o)), typeof value === "boolean" ? (value ? "yes" : "no") : String(value));
      if (!opt) return { misfit: String(value) };
      return { ...base, kind: "choose", values: [opt.label], optionRefs: opt.ref ? [opt.ref] : undefined, source };
    }
    case "combobox": {
      const answer = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
      if (f.asyncOptions) {
        const parts = answer.split(",").map((x) => x.trim()).filter(Boolean);
        return { ...base, kind: "search", value: parts[0] ?? answer, match: parts.length ? parts : [answer], source };
      }
      const opt = matchOption(f.options.filter((o) => !isPlaceholderOption(o)), answer);
      if (!opt) return { misfit: answer };
      return { ...base, kind: "choose", values: [opt.label], source };
    }
    case "checkboxes": {
      const list = Array.isArray(value) ? value.map(String) : [String(value)];
      const opts = list.map((v) => matchOption(f.options, v));
      if (opts.some((o) => !o)) return { misfit: list.join(", ") };
      return { ...base, kind: "choose", values: opts.map((o) => o!.label), optionRefs: opts.map((o) => o!.ref!).filter(Boolean), source };
    }
    default:
      return { misfit: String(value) };
  }
}

export function planForm(fields: FieldDescriptor[], ctx: PlanContext): Plan {
  const plan: Plan = { actions: [], questions: [], skipped: [] };
  let resumeDone = false;
  for (const f of fields) {
    if (!f.visible && f.control !== "file") continue;
    if (f.group) continue; // Workday work / education / skills panels: filled by the adapter
    const key = fieldKey(f);
    const sem = classify(f);
    if (sem === "resume") {
      if (resumeDone) continue;
      resumeDone = true;
      plan.actions.push({ ref: f.ref, key, label: f.label, control: f.control, kind: "upload", source: "resume" });
      continue;
    }
    if (f.control === "file") {
      if (f.required) plan.questions.push(question(f, key, "unsupported", false));
      else plan.skipped.push({ key, label: f.label, reason: "file" });
      continue;
    }

    // 1. this attempt's answers (the user typed or approved them)
    if (key in ctx.answers && ctx.answers[key] !== null && ctx.answers[key] !== "") {
      const a = toAction(f, key, ctx.answers[key], "answer");
      if (!("misfit" in a)) {
        plan.actions.push(a);
        continue;
      }
      plan.questions.push(question(f, key, "no_matching_option", SENSITIVE_SEMANTICS.has(sem), a.misfit));
      continue;
    }
    // 2. explicitly approved reusable answers (exact question text)
    const saved = savedAnswerFor(ctx.profile, f.label);
    if (saved !== undefined) {
      const a = toAction(f, key, saved, "saved_answer");
      if (!("misfit" in a)) {
        plan.actions.push(a);
        continue;
      }
    }
    // 3. the profile
    const r = profileValue(sem, f, ctx);
    if (r.ok) {
      const a = toAction(f, key, r.value, r.source);
      if (!("misfit" in a)) {
        // Do not overwrite what the site already has with the same value.
        plan.actions.push(a);
        continue;
      }
      if (f.required) plan.questions.push(question(f, key, "no_matching_option", SENSITIVE_SEMANTICS.has(sem), a.misfit));
      else plan.skipped.push({ key, label: f.label, reason: "no_matching_option" });
      continue;
    }
    // Unknown: ask only when the form requires it. Optional demographic/legal fields stay empty.
    if (f.required) plan.questions.push(question(f, key, r.reason, SENSITIVE_SEMANTICS.has(sem) || r.reason === "sensitive", r.hint));
    else plan.skipped.push({ key, label: f.label, reason: r.reason });
  }
  return plan;
}

export function filledSummary(actions: PlannedAction[], verified: Set<string>): FilledField[] {
  return actions.map((a) => ({ label: (a.label || a.key).slice(0, 300), source: a.source, verified: verified.has(a.ref) }));
}

/** Accepts YYYY-MM-DD, YYYY-MM, YYYY, MM/DD/YYYY, MM/YYYY. Never guesses a missing part. */
export function parseDateAnswer(raw: string): { month?: string; day?: string; year?: string } | null {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  const pad = (x: string) => x.padStart(2, "0");
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { year: m[1], month: pad(m[2]), day: pad(m[3]) };
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return { year: m[1], month: pad(m[2]) };
  if ((m = s.match(/^(\d{4})$/))) return { year: m[1] };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { month: pad(m[1]), day: pad(m[2]), year: m[3] };
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return { month: pad(m[1]), year: m[2] };
  return null;
}
