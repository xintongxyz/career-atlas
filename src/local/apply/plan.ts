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
import { canonicalPhone, phoneAccepted, phoneLayout, phoneValue, type CanonicalPhone } from "@shared/phone";
import type { FilledField, PendingQuestion } from "@shared/apply";
import { SOURCE_QUERY } from "@shared/apply-match";
import { consentCategories, domainForLabel, englishCountry, englishRegion, matchOptionSemantic, questionMeaning, type ConsentCategory, type QuestionMeaning } from "@shared/apply-semantic";
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
  group?: "work" | "education" | "skills" | "websites" | "languages" | "certifications" | null;
  groupIndex?: number | null;
  /** The site marked the field as invalid (aria-invalid / Workday inputAlert). */
  invalid?: boolean;
  /** Date fields typed as separate month / day / year inputs (refs). */
  parts?: { month?: string; day?: string; year?: string };
  /**
   * Phone inputs: the widget around them ("intl" = an international phone widget, "split" = a separate
   * country-code control beside the number) and the calling code it currently shows ("+1").
   */
  phone?: { widget: "intl" | "split" | null; dial: string | null } | null;
  /** The site's help / error text tied to the control (aria-describedby). */
  help?: string;
  /** The control's own character limit (maxlength). */
  maxLength?: number | null;
}

export type Semantic =
  | "first_name"
  | "last_name"
  | "full_name"
  | "preferred_name"
  | "email"
  | "phone"
  | "phone_country"
  | "contact_method"
  | "location"
  | "city"
  | "region"
  | "country"
  | "address"
  | "postal_code"
  | "phone_type"
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
  /** The employer (for employer-scoped answers such as "Have you worked for us before?"). */
  employer?: string | null;
  /** Where the user found the job (from the saved job), for "How did you hear about us?". */
  jobSource?: import("@shared/apply-match").JobSource;
  /** Field keys already completed by a section handler (left alone here). */
  handled?: Set<string>;
  /** Standing consents: is every value entered so far verified (for accuracy declarations), and which terms were readable. */
  consent?: { accuracyVerified: boolean; inspectedTerms?: Set<string> };
}

/**
 * A consent given from the owner's standing authorisations — only when EVERY category the text touches is
 * authorised (see consentCategories), an accuracy declaration only over verified values, and terms only
 * when their text was readable. Returns the categories, or null (→ asked).
 */
export function standingConsent(text: string, key: string, ctx: PlanContext): ConsentCategory[] | null {
  const cats = consentCategories(text);
  if (!cats.length || cats.includes("other_binding")) return null;
  const d = ctx.profile.application_defaults;
  const s = d.standing_consents ?? {};
  const ok = (c: ConsentCategory) =>
    c === "privacy_notice"
      ? d.accept_privacy_notices === "yes"
      : c === "accuracy_declaration"
        ? s.accuracy_declaration === true && ctx.consent?.accuracyVerified === true
        : c === "routine_terms"
          ? s.routine_terms === true && (ctx.consent?.inspectedTerms?.has(key) ?? false)
          : s[c as keyof typeof s] === true;
  return cats.every(ok) ? cats : null;
}

/** For a consent that is not given automatically: its categories and the ones not authorised (shown with the question). */
export function consentGap(text: string, key: string, ctx: PlanContext): string | null {
  const cats = consentCategories(text);
  if (!cats.length) return null;
  const missing = cats.filter((c) => !standingConsent(c === "other_binding" ? "arbitration" : CATEGORY_PROBE[c], key, ctx));
  return `Consent categories: ${cats.join(", ")}${missing.length ? `; not authorised: ${missing.join(", ")}` : ""}`;
}

/** One sentence per category, to test a single category's authorisation. */
const CATEGORY_PROBE: Record<ConsentCategory, string> = {
  privacy_notice: "I acknowledge the candidate privacy notice.",
  routine_terms: "I agree to the application terms and conditions.",
  read_information: "I have read the information about this position.",
  accuracy_declaration: "I certify that my answers are accurate and complete.",
  interview_recording: "We record interviews.",
  recording_training: "We record interviews and use recordings for internal training.",
  background_check: "I authorize a background check.",
  third_party_sharing: "We share your information with third parties.",
  other_binding: "binding arbitration",
};

/** The option that gives the consent ("Yes", "I agree", "I consent" …) — never one that declines. */
export function affirmativeOption(options: string[]): string | null {
  const yes = options.filter((o) => /^\s*(yes|i agree|agree|i consent|consent|i accept|accept|i acknowledge|acknowledged?|i understand)\b/i.test(o) && !/\b(not|decline|do not|don't|no)\b/i.test(o));
  return yes.length === 1 ? yes[0] : null;
}

export type PlannedAction =
  | { ref: string; key: string; label: string; control: Control; kind: "fill"; value: string; source: string; phone?: CanonicalPhone }
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
  /** Fields that already hold the right value (e.g. from resume parsing): left untouched. */
  kept: { ref: string; key: string; label: string; source: string }[];
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
const DEMOGRAPHIC_RE = /\b(gender|sex|race|racial|racialized|ethnic|ethnicity|hispanic|latin[oax]|veteran|disabilit|disabled|sexual orientation|lgbt|two spirit|transgender|pronoun|indigenous|aboriginal|first nations|m[eé]tis|inuit|visible minority|self[- ]identif|demographic|eeo|equal employment)/;
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
  if (/confirm e-?mail|re-?enter e-?mail|e-?mail address again/.test(label) || /confirmemail|emailconfirm|email_confirm/.test(keys)) return "email";
  if (ac === "email" || f.inputType === "email" || /(^|[^a-z])e?-?mail/.test(keys) || /^e ?mail/.test(label)) return "email";
  if (/preferred contact (method|type)/.test(label)) return "contact_method";
  if ((f.control === "combobox" || f.control === "select") && /dialing code|dialling code|calling code|dial code|(country )?phone code|phone country|country code/.test(label)) return "phone_country";
  // A dropdown labelled "Phone" next to the number is its dialing country — but never "Phone (Device) Type".
  if ((f.control === "combobox" || f.control === "select") && /^(phone|mobile|cell)/.test(label) && !/\btype\b/.test(label) && !/phone|mobile/.test(id)) return "phone_country";
  if (/phone (device )?type|type of phone|phone device/.test(label)) return "phone_type";
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
  // Employer / job title, however asked ("Who is your current or previous employer?", "Most recent job title").
  if (name === "org" || /^current (company|employer)|^(company|employer)$|\b(current|previous|most recent|last|latest|present)( or (previous|most recent|last|past))? (company|employer|organi[sz]ation)\b/.test(label)) return "current_company";
  if (/^current (job )?title|^(job )?title$|\b(current|previous|most recent|last|latest|present)( or (previous|most recent|last|past))? (job |position )?title\b/.test(label)) return "current_title";
  if (id === "school" || /^school|^university|^institution/.test(label)) return "school";
  if (id === "degree" || /^degree|highest (level of )?education/.test(label)) return "degree";
  if (id === "discipline" || /^discipline|^(field of study|major)/.test(label)) return "discipline";
  if (ac === "postal-code" || /postal|zip/.test(all)) return "postal_code";
  // The applicant's street address, however it is introduced ("Home address", "Start typing your address") —
  // not an e-mail / web / IP address, nor the second address line.
  if (ac.startsWith("street-address") || ac.startsWith("address-line1") || (/^(street )?address|\b(home|street|mailing|residential|current|postal|your) address\b|\byour address$/.test(label) && !/e ?mail|web|ip address|line 2|address 2|second/.test(label))) return "address";
  if (id === "candidate-location" || name === "location" || /^(current )?location|^where are you (located|based)/.test(label)) return "location";
  if (ac === "address-level2" || /^city|^town/.test(label)) return "city";
  if (ac === "address-level1" || /^(state|province|region)/.test(label)) return "region";
  // The applicant's country, however it is asked ("Current country", "Country of residence", "Where do you live?").
  if (ac === "country" || ac === "country-name" || /^country|^(current|home|residence|residential) country|country of (residence|domicile)|\bcountry\b.{0,40}\b(you )?(currently )?(live|reside|are based)\b|\b(live|reside)\b.{0,20}\bcountry\b/.test(label) || (CLOSED.includes(f.control) && /^where do you (currently )?(live|reside)\b/.test(label))) return id === "country" && /phone/.test(f.section.toLowerCase()) ? "phone_country" : "country";
  return "unknown";
}

// ---------------------------------------------------------------- profile values

type Resolved =
  | { ok: true; value: string | string[] | boolean; source: string; phone?: CanonicalPhone; alt?: string }
  | { ok: false; reason: "missing" | "sensitive" | "legal" | "demographic" | "open_ended" | "unsupported"; hint?: string | null };

const has = (v: unknown) => v !== null && v !== undefined && v !== "";

/** The applicant's phone in canonical form (see src/shared/phone.ts). */
export function applicantPhone(ctx: PlanContext): CanonicalPhone | null {
  const p = ctx.profile;
  return canonicalPhone(p.contact.phone, { countryCode: p.application_defaults.phone_country_code, country: p.based_in.country });
}
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
  // "加拿大", "CA" and "Canada" are the same country.
  const n = (s: string) => englishCountry(s).toLowerCase().replace(/^(the )?(us|usa|u\.s\.a?\.?)$/, "united states").replace(/^uk$/, "united kingdom").trim();
  return n(a) === n(b);
};

export function profileValue(sem: Semantic, f: FieldDescriptor, ctx: PlanContext): Resolved {
  const p = ctx.profile;
  const c = p.contact ?? {};
  const label = norm(f.label);
  // "Current" means a role marked current; "current or previous / most recent" also accepts the latest
  // ended role (by end, then start date) — the SAME record for employer and title.
  const lbl = norm(f.label || f.placeholder);
  const latest = [...p.experience].sort((a, b) => Number(!!b.current) - Number(!!a.current) || String(b.end ?? "9999").localeCompare(String(a.end ?? "9999")) || String(b.start ?? "").localeCompare(String(a.start ?? "")))[0];
  const currentJob = p.experience.find((e) => e.current) ?? (/\b(previous|most recent|last|latest|past)\b/.test(lbl) ? latest : undefined);
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
    case "phone": {
      if (!has(c.phone)) return { ok: false, reason: "missing" };
      const canon = applicantPhone(ctx);
      // Without a known country the number is typed only where no country is involved (a plain local field).
      if (!canon) return f.phone?.widget || /^\s*\+/.test(f.placeholder) ? { ok: false, reason: "missing", hint: "Phone country unknown — set the phone country code in Application Defaults." } : { ok: true, value: c.phone!.replace(/[^\d]/g, ""), source: "contact.phone" };
      return { ok: true, value: phoneValue(canon, phoneLayout(f, canon, ctx.jobCountry)), source: "contact.phone", phone: canon };
    }
    case "contact_method": {
      // Only the saved preference — never inferred from the phone type or from which details exist.
      const m = p.application_defaults.preferred_contact_method;
      return m ? { ok: true, value: m === "email" ? "Email" : m === "phone" ? "Phone" : "Text", source: "defaults.preferred_contact_method" } : { ok: false, reason: "missing" };
    }
    case "phone_type": {
      const t = p.application_defaults.phone_type;
      return t ? { ok: true, value: t === "mobile" ? "Mobile" : t === "home" ? "Home" : "Work", source: "defaults.phone_type" } : { ok: false, reason: "missing" };
    }
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
    // Forms search in English: a country / province saved in Chinese ("加拿大") is searched as "Canada".
    case "region":
      return has(p.based_in.region) ? { ok: true, value: englishRegion(p.based_in.region!), source: "based_in.region" } : { ok: false, reason: "missing" };
    case "country":
      return has(p.based_in.country) ? { ok: true, value: englishCountry(p.based_in.country!), source: "based_in.country" } : { ok: false, reason: "missing" };
    case "phone_country": {
      // The phone's own country (saved number / phone country code / the applicant's country) — never the job's.
      const canon = applicantPhone(ctx);
      if (canon?.country) return { ok: true, value: canon.country, source: "contact.phone", alt: `+${canon.cc}` };
      if (canon) return { ok: true, value: `+${canon.cc}`, source: "contact.phone" };
      return has(p.based_in.country) ? { ok: true, value: englishCountry(p.based_in.country!), source: "based_in.country" } : { ok: false, reason: "missing" };
    }
    case "location": {
      const parts = [p.based_in.city, p.based_in.region ? englishRegion(p.based_in.region) : null, p.based_in.country ? englishCountry(p.based_in.country) : null].filter(has) as string[];
      if (!has(p.based_in.city)) return { ok: false, reason: "missing" };
      return { ok: true, value: parts.join(", "), source: "based_in" };
    }
    case "current_company":
      return currentJob?.organization ? { ok: true, value: currentJob.organization, source: currentJob.current ? "experience.current" : "experience.latest" } : { ok: false, reason: "missing" };
    case "current_title":
      return currentJob ? { ok: true, value: currentJob.title, source: currentJob.current ? "experience.current" : "experience.latest" } : { ok: false, reason: "missing" };
    case "school": {
      const e = educationFor(f, p);
      return e?.institution ? { ok: true, value: e.institution, source: "education" } : { ok: false, reason: "missing" };
    }
    case "discipline": {
      const e = educationFor(f, p);
      return e?.field ? { ok: true, value: e.field, source: "education" } : { ok: false, reason: "missing" };
    }
    case "degree": {
      const e = educationFor(f, p);
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
      // A work permit may or may not need future sponsorship: only the user's own answer says.
      const own = /\bfuture\b/.test(label) || !/\b(now|currently)\b/.test(label) ? p.application_defaults.sponsorship_future : p.application_defaults.sponsorship_now;
      if (own) return { ok: true, value: own, source: "defaults.sponsorship" };
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

/**
 * The education entry a school / degree / discipline field belongs to. Forms with numbered
 * education blocks ("school_name_1", "education[1][degree]") get entry N (most recent first), so
 * every school keeps its own degree and field; a single unnumbered field gets the most recent entry.
 */
function educationFor(f: FieldDescriptor, p: Profile) {
  const m = /(?:_|\[|-)(\d+)\]?(?:\[[a-z_]+\])?$/i.exec(f.name) ?? /(?:_|-)(\d+)$/.exec(f.id);
  if (!m || Number(m[1]) >= 20) return latestEducation(p); // "question_123456": an id, not a position
  const sorted = [...p.education].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  return sorted[Number(m[1])];
}

// ---------------------------------------------------------------- options

const YES_RE = /^(yes|y|true|oui|是)\b/;
const NO_RE = /^(no|n|false|non|否)\b/;

/** Maps an answer onto one of the field's options (semantic, never guessing between candidates). */
export function matchOption(options: FieldOption[], answer: string): FieldOption | null {
  return matchOptionSemantic(options, answer) as FieldOption | null;
}

const isPlaceholderOption = (o: FieldOption) => !o.value || /^(select|choose|please select|--)/.test(norm(o.label)) || norm(o.label) === "";

// ---------------------------------------------------------------- plan

export function savedAnswerFor(profile: Profile, label: string, employer: string | null = null): unknown {
  const n = norm(label);
  if (!n) return undefined;
  const fits = (e: string | null | undefined) => !e || (!!employer && sameEmployer(e, employer));
  return profile.saved_answers.find((s) => norm(s.question) === n && fits(s.employer))?.answer;
}

export function sameEmployer(a: string, b: string) {
  const strip = (x: string) => norm(x).replace(/\b(inc|ltd|llc|corp|corporation|limited|group|company|co|plc|the|synthetic)\b/g, "").replace(/\s+/g, " ").trim();
  const x = strip(a);
  const y = strip(b);
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
}

const DEFAULT_KEY: Partial<Record<QuestionMeaning["meaning"], keyof Profile["application_defaults"]>> = {
  prior_contractor: "prior_contractor",
  prior_affiliate: "prior_affiliate",
  referral: "referral",
  relocation: "relocation",
  travel: "travel",
  shift_work: "shift_work",
  age_18: "age_18",
  enrolled_student: "enrolled_student",
  full_time_student: "full_time_student",
  coop_program: "coop_program",
  coop_term_required: "coop_term_required",
  internship_mandatory: "internship_mandatory",
  return_to_school: "return_to_school",
  start_date: "start_date",
  notice_period: "notice_period",
  salary: "salary_expectation",
  hourly_rate: "hourly_expectation",
  source: "source",
  graduation_date: "expected_graduation",
  contact_method: "preferred_contact_method",
};

/**
 * Answers to common screening questions from Application Defaults (by meaning, not wording).
 * null = this meaning is not handled here; { ok: false } = handled, but not specified → ask.
 */
export function screeningValue(qm: QuestionMeaning, ctx: PlanContext, label = ""): Resolved | null {
  const d = ctx.profile.application_defaults;
  const ok = (value: string, source: string): Resolved => ({ ok: true, value, source });
  if (qm.meaning === "prior_employment") {
    const exc = ctx.employer ? d.prior_employment_exceptions.find((e) => sameEmployer(e.employer, ctx.employer!)) : undefined;
    if (exc) return ok(exc.answer, "defaults.prior_employment_exception");
    return d.prior_employment ? ok(d.prior_employment, "defaults.prior_employment") : { ok: false, reason: "missing" };
  }
  if (qm.meaning === "enrolled_student") {
    if (d.enrolled_student) return ok(d.enrolled_student, "defaults.enrolled_student");
    // A degree recorded as "in progress" establishes current enrolment — and nothing more (not co-op).
    return ctx.profile.education.some((e) => e.completed === false) ? ok("yes", "education.in_progress") : { ok: false, reason: "missing" };
  }
  if (qm.meaning === "graduation_date") {
    if (d.expected_graduation) return ok(d.expected_graduation, "defaults.expected_graduation");
    // A degree in progress: its planned end (month when recorded). Several in progress → ambiguous (asked).
    const going = ctx.profile.education.filter((x) => x.completed === false && (x.end || x.year));
    if (going.length === 1) return ok(going[0].end ?? String(going[0].year), "education.in_progress");
    if (going.length > 1) return { ok: false, reason: "missing", hint: "Several degrees in progress — which one is meant?" };
    // A completed degree: only when there is exactly one — with several, "when did you graduate" is ambiguous.
    const done = ctx.profile.education.filter((x) => x.completed !== false && (x.end || x.year));
    if (done.length === 1) return ok(done[0].end ?? String(done[0].year), done[0].end ? "education.end" : "education.year");
    return { ok: false, reason: "missing", hint: done.length > 1 ? "Several completed degrees — which graduation is meant?" : null };
  }
  // Time-sensitive: an offer / recruiting deadline answer is reused only while fresh (3 weeks), never assumed.
  if (qm.meaning === "recruiting_deadline") {
    const r = d.recruiting_deadline;
    const fresh = r && Date.now() - Date.parse(`${r.as_of}T00:00:00Z`) < 21 * 86_400_000;
    return fresh ? ok(r!.answer, "defaults.recruiting_deadline") : { ok: false, reason: "missing", hint: r ? `Last answer (${r.as_of}) is out of date.` : null };
  }
  if (qm.meaning === "placement_duration") {
    // "Available for a four-month placement?" — yes only when every length asked is one the user listed.
    const words: Record<string, number> = { four: 4, eight: 8, twelve: 12, sixteen: 16, six: 6 };
    const asked = [...norm(label).matchAll(/\b(\d{1,2}|four|eight|twelve|sixteen|six) ?months?\b/g)].map((m) => words[m[1]] ?? Number(m[1]));
    if (asked.length && d.placement_months.length && asked.every((n) => d.placement_months.includes(n))) return ok("yes", "defaults.placement_months");
    return { ok: false, reason: "missing" };
  }
  if (qm.meaning === "source") {
    if (typeof d.source === "string" && d.source) return ok(d.source, "defaults.source");
    if (ctx.jobSource) return ok(SOURCE_QUERY[ctx.jobSource], `job.source.${ctx.jobSource}`);
    return { ok: false, reason: "missing" };
  }
  const key = DEFAULT_KEY[qm.meaning];
  if (!key) return null;
  const v = d[key];
  return typeof v === "string" && v ? ok(v, `defaults.${key}`) : { ok: false, reason: qm.meaning === "salary" || qm.meaning === "hourly_rate" ? "open_ended" : "missing" };
}

export function question(f: FieldDescriptor, key: string, reason: string, sensitive: boolean, hint?: string | null, qm?: QuestionMeaning | null): PendingQuestion {
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
    meaning: qm && qm.meaning !== "unknown" ? qm.meaning : f.wdField === "phoneType" || /phone (device )?type/.test(norm(f.label)) ? "phone_type" : null,
    rememberable: !(qm?.approval || reason === "legal" || reason === "unsupported"),
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
      const opt = matchOptionSemantic(f.options.filter((o) => !isPlaceholderOption(o)), typeof value === "boolean" ? (value ? "yes" : "no") : String(value), domainForLabel(f.label, classify(f))) as FieldOption | null;
      if (!opt) return { misfit: String(value) };
      return { ...base, kind: "choose", values: [opt.label], optionRefs: opt.ref ? [opt.ref] : undefined, source };
    }
    case "combobox": {
      const answer = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
      // A typeahead that lists nothing until something is typed: type, then pick the suggestion that matches.
      if (f.asyncOptions || !f.options.some((o) => !isPlaceholderOption(o))) {
        const parts = answer.split(",").map((x) => x.trim()).filter(Boolean);
        return { ...base, kind: "search", value: parts[0] ?? answer, match: parts.length ? parts : [answer], source };
      }
      const opt = matchOptionSemantic(f.options.filter((o) => !isPlaceholderOption(o)), answer, domainForLabel(f.label, classify(f))) as FieldOption | null;
      if (!opt) return { misfit: answer };
      return { ...base, kind: "choose", values: [opt.label], source };
    }
    case "checkboxes": {
      const list = Array.isArray(value) ? value.map(String) : [String(value)];
      const opts = list.map((v) => matchOptionSemantic(f.options, v) as FieldOption | null);
      if (opts.some((o) => !o)) return { misfit: list.join(", ") };
      return { ...base, kind: "choose", values: opts.map((o) => o!.label), optionRefs: opts.map((o) => o!.ref!).filter(Boolean), source };
    }
    default:
      return { misfit: String(value) };
  }
}

const CLOSED: Control[] = ["select", "radio", "listbox", "checkbox", "combobox"];

export function planForm(fields: FieldDescriptor[], ctx: PlanContext): Plan {
  const plan: Plan = { actions: [], questions: [], skipped: [], kept: [] };
  let resumeDone = false;
  for (const f of fields) {
    if (!f.visible && f.control !== "file") continue;
    if (f.group && f.wdField) continue; // Workday panels: filled by the Workday adapter
    const key = fieldKey(f);
    if (ctx.handled?.has(key)) continue;
    let sem = classify(f);
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
    // Meaning of a screening question (Workday's "previous worker" field is prior employment by definition).
    // A bare "Month" / "Year" / "Day" control is one part of a composite date: its question is the group's.
    const part = datePartOf(f);
    const qText = part && f.section ? `${f.section} ${part}` : f.label || f.placeholder;
    const qm: QuestionMeaning = f.wdField === "candidateIsPreviousWorker" ? { ...questionMeaning("", ctx.employer ?? null), meaning: "prior_employment", employerScoped: true, reusable: true } : questionMeaning(qText, ctx.employer ?? null);
    if (qm.meaning === "identity") sem = "demographic";
    else if (qm.approval && (CLOSED.includes(f.control) || sem === "legal")) sem = "legal";
    const sensitive = SENSITIVE_SEMANTICS.has(sem) || qm.sensitivity !== "normal";
    const use = (value: unknown, source: string, phone?: CanonicalPhone) => {
      // A dropdown that already SHOWS this answer (its option list not read — it was not re-opened) is kept.
      if (["combobox", "listbox", "select"].includes(f.control) && !f.options.some((o) => !isPlaceholderOption(o)) && typeof value === "string") {
        const shown = (Array.isArray(f.value) ? f.value : [String(f.value ?? "")]).filter(Boolean);
        if (shown.length === 1 && matchOptionSemantic([{ label: shown[0], value: shown[0] }], value, domainForLabel(f.label, classify(f)))) {
          plan.kept.push({ ref: f.ref, key, label: f.label, source });
          return null;
        }
      }
      const a = toAction(f, key, value, source);
      if ("misfit" in a) return a;
      if (phone && a.kind === "fill") a.phone = phone;
      // Already right on the page (e.g. filled by Workday's resume parsing): keep it, don't re-type it.
      // The user's own answer must be there exactly as given (it may correct a rejected format).
      const same = source === "answer" && a.kind === "fill" ? norm(String(f.value ?? "")) === norm(a.value) && String(f.value ?? "").trim() === a.value.trim() : holds(f, a);
      if (same) plan.kept.push({ ref: f.ref, key, label: f.label, source });
      else plan.actions.push(a);
      return null;
    };

    // Repeated rows / sections (work, education, websites, languages, skills) are filled entry by
    // entry by their handlers (rows.ts, wd-sections.ts), never field by field here.
    if (f.group) continue;

    // 1. this attempt's answers (the user typed or approved them)
    if (key in ctx.answers && ctx.answers[key] !== null && ctx.answers[key] !== "") {
      const m = use(ctx.answers[key], "answer");
      if (m) plan.questions.push(question(f, key, "no_matching_option", sensitive, m.misfit, qm));
      continue;
    }
    // 2. explicitly approved reusable answers (exact question text; employer-scoped where saved so)
    const saved = savedAnswerFor(ctx.profile, f.label, ctx.employer ?? null);
    if (saved !== undefined && !use(saved, "saved_answer")) continue;
    // Declarations / consents the owner authorised by category (standing consents): given, and recorded.
    if (sem === "legal") {
      // What is consented to is the question itself and its options — not the surrounding headings.
      const cats = standingConsent([f.label, ...f.options.map((o) => o.label)].join(" "), key, ctx);
      // Options of a searchable dropdown are known only once it is opened: plan "Yes" — the pick must still
      // find exactly that option on the page (never another one).
      const known = f.options.filter((o) => !isPlaceholderOption(o)).map((o) => o.label);
      const value = cats ? (f.control === "checkbox" ? true : known.length ? affirmativeOption(known) : f.control === "combobox" ? "Yes" : null) : null;
      if (cats && value !== null && !use(value, `consent.${cats.join("+")}`)) continue;
    }
    // Identity and declarations: only the user's own answers above — never defaults or inference.
    if (sem === "demographic" || sem === "legal") {
      // A consent left to the user says which categories it touches and which are not authorised.
      const why = sem === "legal" ? consentGap([f.label, ...f.options.map((o) => o.label)].join(" "), key, ctx) : null;
      if (f.required) plan.questions.push(question(f, key, sem, true, why, qm));
      else plan.skipped.push({ key, label: f.label, reason: sem });
      continue;
    }
    // 3. Application Defaults, by meaning (prior employment, co-op, start date, …)
    let sv = qm.meaning !== "unknown" ? screeningValue(qm, ctx, f.label) : null;
    // A date answer typed into a free-text box reads as a month and year ("December 2026"), not "2026-12".
    if (!part && sv?.ok && typeof sv.value === "string" && (f.control === "text" || f.control === "textarea") && /^(graduation_date|start_date)$/.test(qm.meaning)) {
      const d = parseDateAnswer(sv.value);
      if (d?.year) sv = { ...sv, value: [d.month ? MONTH_NAMES[Number(d.month) - 1] : null, d.day ? String(Number(d.day)) + "," : null, d.year].filter(Boolean).join(" ").replace(/^(\w+) (\d+,) (\d{4})$/, "$1 $2 $3") };
    }
    // One part of a composite date: the month (by name, else by number), day or year of the answer.
    if (part && sv?.ok && typeof sv.value === "string") {
      const d = parseDateAnswer(sv.value);
      const v = d?.[part];
      sv = v ? { ok: true, value: part === "month" ? MONTH_NAMES[Number(v) - 1] : v, source: sv.source, alt: part === "month" ? v : undefined } : { ok: false, reason: "missing" };
    }
    // A yes/no default only answers a closed question (never typed into a free-text box).
    if (sv?.ok && (sv.value === "yes" || sv.value === "no") && !CLOSED.includes(f.control)) sv = { ok: false, reason: "open_ended" };
    const r = sv ?? profileValue(sem, f, ctx);
    if (r.ok) {
      // A calling-code list may name countries ("Canada (+1)") or show codes only ("+1").
      let m = use(r.value, r.source, r.phone);
      if (m && r.alt) m = use(r.alt, r.source, r.phone);
      if (!m) continue;
      if (f.required) plan.questions.push(question(f, key, "no_matching_option", sensitive, m.misfit, qm));
      else plan.skipped.push({ key, label: f.label, reason: "no_matching_option" });
      continue;
    }
    // Unknown: ask only when the form requires it. Optional questions stay empty.
    if (f.required) plan.questions.push(question(f, key, r.reason, sensitive || r.reason === "sensitive", r.hint, qm));
    else plan.skipped.push({ key, label: f.label, reason: r.reason });
  }
  return plan;
}

/** Does the field already hold exactly what the action would put there? */
export function holds(f: FieldDescriptor, a: PlannedAction): boolean {
  const v = f.value;
  const list = (Array.isArray(v) ? v : [String(v ?? "")]).map(norm).filter(Boolean);
  const digits = (x: string) => x.replace(/\D+/g, "");
  switch (a.kind) {
    case "fill":
      // A phone already on the page counts only if it is THIS number in THIS country (never a suffix match).
      if (a.phone) return phoneAccepted(String(v ?? ""), a.phone, f.phone?.dial);
      if (/phone|tel/.test(`${f.name} ${f.id} ${f.inputType} ${f.wdField ?? ""}`.toLowerCase())) return !!digits(String(v ?? "")) && digits(String(v)) === digits(a.value);
      return norm(String(v ?? "")) === norm(a.value) && !!norm(a.value);
    case "check":
      return v === a.value;
    case "choose":
      return list.length === a.values.length && a.values.every((x) => list.includes(norm(x)));
    case "search":
      return list.length > 0 && list.some((x) => a.match.every((m) => x.includes(norm(m))));
    case "date": {
      const want = [a.value.month, a.value.day, a.value.year].filter(Boolean).map((x) => String(Number(x))).join("/");
      return String(v ?? "").split("/").filter(Boolean).map((x) => String(Number(x))).join("/") === want;
    }
    default:
      return false;
  }
}

export function filledSummary(actions: PlannedAction[], verified: Set<string>): FilledField[] {
  return actions.map((a) => ({ label: (a.label || a.key).slice(0, 300), source: a.source, verified: verified.has(a.ref) }));
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Month" / "Year" / "Day" (with or without a required mark): one part of a composite date. */
export function datePartOf(f: FieldDescriptor): "month" | "day" | "year" | null {
  if (f.control === "date") return null;
  const m = norm(f.label || f.placeholder).match(/^(month|mm|day|dd|year|yyyy)( required)?$/);
  if (!m) return null;
  return /^m/.test(m[1]) ? "month" : /^d/.test(m[1]) ? "day" : "year";
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
