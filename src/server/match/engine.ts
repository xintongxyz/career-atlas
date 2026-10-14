// Local, deterministic job ↔ profile matching. No AI and no network: rules over the job's
// extracted requirement fields and the user's confirmed profile.
//
// Principles
//   - Missing profile information is "unknown", never a "no".
//   - A requirement the AI only inferred (no quote from the posting) is "unclear", never mandatory.
//   - Wording that allows alternatives ("or equivalent", "may be considered", "ideally") never
//     produces a hard "not met"; it becomes "partial" with an explanation.
//   - Mandatory gaps are reported separately and are never hidden by the overall score.
import type { MatchItem, MatchResult, MatchStatus, MatchSummary, RequirementCategory, RequirementKind } from "@shared/match";
import type { Profile } from "@shared/profile";

export interface JobRequirementsInput {
  country: string | null;
  visa_sponsorship: string | null;
  fields: Partial<Record<string, unknown>>;
  /** Per field: was the value quoted from the posting / entered by the user (verified) or inferred by AI? */
  inferred: Set<string>;
}

// ---------------------------------------------------------------- helpers

const lc = (s: unknown) => String(s ?? "").toLowerCase();
const PREFERRED_RE = /\b(preferred|prefer|nice[- ]to[- ]have|an? asset|advantage|bonus|desirable|desired|plus\b|ideally|would be great)|优先|加分|最好/i;
const FLEX_RE = /\b(or equivalent|equivalent (work )?experience|equivalent combination|may be considered|ideally|approximately|or related|related field|or similar|minimum of .* or)|或同等|同等学力|可考虑/i;
const ALT_EDU_RE = /\b(or equivalent|equivalent (work )?experience|equivalent combination|combination of education and experience)|或同等/i;

const RE = {
  licence: /driver'?s?'? ?licen[cs]e|driving licen[cs]e|valid licen[cs]e|access to a (vehicle|car)|own (vehicle|car)|reliable (vehicle|transportation)|驾照|驾驶执照/i,
  vehicle: /vehicle|car\b|transportation|车/i,
  clearance: /security clearance|clearance level|reliability status|secret clearance|top secret|安全许可|安全审查/i,
  authorization: /(authori[sz]ed|eligible|entitled|legally able|permitted) to work|work (permit|authori[sz]ation)|right to work|citizen|permanent resident|sponsorship|工作许可|合法工作|公民|永久居民|签证/i,
  language: /\b(english|french|spanish|mandarin|cantonese|chinese|german|portuguese|japanese|korean|arabic|hindi|punjabi|italian|tagalog|vietnamese|bilingual)\b|英语|英文|法语|法文|普通话|中文|粤语|双语|西班牙语|日语|韩语/i,
  education: /bachelor|master'?s|\bmba\b|ph\.?d|doctorate|\bdegree\b|diploma|high school|secondary (school|education)|post-?secondary|college|university|学士|硕士|博士|学历|本科|大专|高中|学位/i,
  experience: /(\d+(?:\.\d+)?)\s*\+?\s*(?:(?:-|–|to)\s*(\d+)\s*)?(?:\+\s*)?(?:years?|yrs?)\b|(\d+)\s*年.*经验/i,
  certification: /certif|designation|accredit|\b(CPA|CFA|CAMS|ACFCS|PMP|CFE|FRM|CISSP|CISA|CIA|CSC|CPHR|ITIL|SHRM|PRINCE2)\b|证书|资格证/,
};

const LANGS: [RegExp, string][] = [
  [/english|英语|英文/i, "English"],
  [/french|法语|法文/i, "French"],
  [/spanish|西班牙语/i, "Spanish"],
  [/mandarin|普通话|chinese|中文/i, "Chinese"],
  [/cantonese|粤语/i, "Cantonese"],
  [/german/i, "German"],
  [/portuguese/i, "Portuguese"],
  [/japanese|日语/i, "Japanese"],
  [/korean|韩语/i, "Korean"],
  [/arabic/i, "Arabic"],
  [/hindi/i, "Hindi"],
  [/punjabi/i, "Punjabi"],
  [/italian/i, "Italian"],
  [/tagalog/i, "Tagalog"],
  [/vietnamese/i, "Vietnamese"],
];
const LANG_ALIASES: Record<string, string[]> = { Chinese: ["chinese", "mandarin", "中文", "普通话", "汉语"], English: ["english", "英语", "英文"], French: ["french", "法语", "法文", "français"], Cantonese: ["cantonese", "粤语"] };
const LEVEL_RANK: Record<string, number> = { basic: 1, intermediate: 2, professional: 3, fluent: 4, native: 5 };

function requiredLanguageLevel(text: string): number {
  const t = lc(text);
  if (/native|mother tongue|母语/.test(t)) return 5;
  if (/fluen|bilingual|advanced|excellent|superior|流利|精通|双语/.test(t)) return 4;
  if (/professional|proficien|business|strong|written and (spoken|oral)|熟练/.test(t)) return 3;
  if (/conversational|working knowledge|intermediate|functional|good|日常|中级/.test(t)) return 2;
  if (/basic|some knowledge|基础/.test(t)) return 1;
  return 3;
}

const EDU_RANK: Record<string, number> = { high_school: 1, diploma: 2, bachelor: 3, master: 4, doctorate: 5, other: 0 };
function requiredEducationLevel(text: string): number | null {
  const t = lc(text);
  if (/ph\.?d|doctorate|博士/.test(t)) return 5;
  if (/master|\bmba\b|graduate degree|硕士/.test(t)) return 4;
  if (/bachelor|undergraduate|university degree|\bdegree\b|学士|本科/.test(t)) return 3;
  if (/diploma|college|post-?secondary|associate|大专|专科/.test(t)) return 2;
  if (/high school|secondary|ged\b|高中/.test(t)) return 1;
  return null;
}

const STOP = new Set(
  "a an and or of in on the to for with at as by from years year yrs experience experienced relevant related field fields industry minimum least plus must have having strong solid proven working work knowledge ability skills skill demonstrated including equivalent similar preferably ideally approximately candidates candidate may be considered required requirement role position job using use within across other area areas level levels".split(
    " ",
  ),
);

/** Meaningful words of a requirement (for experience-area and skill matching). */
function keywords(text: string): string[] {
  return lc(text)
    .replace(/[^a-z0-9+#/.一-鿿 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+(\.\d+)?\+?$/.test(w));
}

const containsTerm = (hay: string, term: string) => {
  const t = lc(term).trim();
  if (!t) return false;
  if (/[一-鿿]/.test(t)) return lc(hay).includes(t);
  return new RegExp(`(^|[^a-z0-9+#])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9+#])`, "i").test(hay);
};

const SKILL_ALIASES: Record<string, string[]> = {
  "ms office": ["microsoft office", "ms office", "office 365", "microsoft 365"],
  excel: ["excel", "microsoft excel", "ms excel"],
  "power bi": ["power bi", "powerbi"],
  javascript: ["javascript", "js"],
  "google sheets": ["google sheets", "sheets"],
};
const OFFICE_SUITE = ["word", "excel", "powerpoint", "outlook", "microsoft word", "microsoft excel", "microsoft powerpoint"];
function profileHasSkill(profileTerms: string[], term: string): string | null {
  const suite = profileTerms.find((p) => /^(ms|microsoft) office|office 365|microsoft 365$/i.test(p.trim()));
  if (suite && OFFICE_SUITE.includes(lc(term).trim())) return suite;
  const t = lc(term).trim();
  const variants = new Set([t, ...(SKILL_ALIASES[t] ?? [])]);
  for (const [k, v] of Object.entries(SKILL_ALIASES)) if (v.includes(t)) [k, ...v].forEach((x) => variants.add(x));
  return profileTerms.find((p) => [...variants].some((v) => lc(p) === v || containsTerm(p, v) || containsTerm(v, lc(p)))) ?? null;
}

function monthsBetween(start: string | null | undefined, end: string | null | undefined, current: boolean, now: Date): number | null {
  if (!start) return null;
  const [sy, sm] = start.split("-").map(Number);
  let ey: number;
  let em: number;
  if (end) [ey, em] = end.split("-").map(Number);
  else if (current) [ey, em] = [now.getUTCFullYear(), now.getUTCMonth() + 1];
  else return null;
  const months = (ey - sy) * 12 + ((em || 12) - (sm || 1)) + (sm ? 1 : 0);
  return Math.max(0, months);
}

const fmtYears = (y: number) => (Math.round(y * 10) / 10).toString();

// ---------------------------------------------------------------- requirement extraction

interface Requirement {
  text: string;
  field: string;
  index: number | null;
  category: RequirementCategory;
  kind: RequirementKind;
  ai_inferred: boolean;
  flexible: boolean;
}

function kindOf(text: string): RequirementKind {
  if (RE.licence.test(text)) return "licence";
  if (RE.clearance.test(text)) return "clearance";
  if (RE.authorization.test(text)) return "authorization";
  if (RE.certification.test(text) && !RE.education.test(text)) return "certification";
  if (RE.experience.test(text) && /experience|exp\b|经验|years in/i.test(text)) return "experience";
  if (RE.education.test(text)) return "education";
  if (RE.language.test(text) && (/speak|written|oral|communicat|fluen|bilingual|proficien|language|语|native|read/i.test(text) || text.trim().split(/\s+/).length <= 6)) return "language";
  return "skill";
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : typeof v === "string" && v.trim() ? [v] : []);

export function extractRequirements(job: JobRequirementsInput): Requirement[] {
  const out: Requirement[] = [];
  const f = job.fields;
  const seen = new Set<string>();
  const add = (text: string, field: string, index: number | null, base: RequirementCategory, kind = kindOf(text)) => {
    const norm = lc(text).replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
    if (seen.has(norm)) return; // the same requirement listed in two fields
    seen.add(norm);
    const inferred = job.inferred.has(field);
    let category: RequirementCategory = base;
    if (base === "mandatory" && PREFERRED_RE.test(text)) category = "preferred";
    if (inferred) category = "unclear"; // AI inference: never a verified requirement
    out.push({ text: text.trim(), field, index, category, kind, ai_inferred: inferred, flexible: FLEX_RE.test(text) });
  };

  asList(f.required_qualifications).forEach((t, i) => add(t, "required_qualifications", i, "mandatory"));
  asList(f.preferred_qualifications).forEach((t, i) => add(t, "preferred_qualifications", i, "preferred"));
  asList(f.education_requirements).forEach((t, i) => add(t, "education_requirements", i, "mandatory", RE.certification.test(t) && !RE.education.test(t) ? "certification" : "education"));
  asList(f.language_requirements).forEach((t, i) => add(t, "language_requirements", i, "mandatory", "language"));
  asList(f.licences).forEach((t, i) => add(t, "licences", i, "mandatory", RE.licence.test(t) ? "licence" : "certification"));
  asList(f.certifications).forEach((t, i) => add(t, "certifications", i, PREFERRED_RE.test(t) ? "preferred" : "unclear", "certification"));
  for (const field of ["other_requirements", "other_hard_requirements"]) {
    asList(f[field]).forEach((t, i) => {
      const k = kindOf(t);
      if (k !== "skill") add(t, field, i, field === "other_hard_requirements" ? "mandatory" : "unclear", k); // only qualification-like conditions
    });
  }
  for (const field of ["work_authorization", "citizenship_restriction", "residency_restriction"]) {
    asList(f[field]).forEach((t) => add(t, field, null, "mandatory", "authorization"));
  }
  asList(f.security_clearance).forEach((t) => add(t, "security_clearance", null, "mandatory", "clearance"));

  // Minimum years, unless a listed requirement already states years of experience.
  const years = typeof f.years_experience_min === "number" ? f.years_experience_min : null;
  if (years != null && !out.some((r) => r.kind === "experience")) {
    const text = typeof f.years_experience_text === "string" && f.years_experience_text ? f.years_experience_text : `${years}+ years of experience`;
    const r: Requirement = { text, field: "years_experience_min", index: null, category: job.inferred.has("years_experience_min") ? "unclear" : "mandatory", kind: "experience", ai_inferred: job.inferred.has("years_experience_min"), flexible: FLEX_RE.test(text) };
    if (r.category === "mandatory" && PREFERRED_RE.test(text)) r.category = "preferred";
    out.push(r);
  }

  // Skills listed separately by the extraction, unless already part of a listed requirement.
  const listed = out.map((r) => lc(r.text)).join("\n");
  for (const field of ["technical_skills", "tools"]) {
    asList(f[field]).forEach((s, i) => {
      if (containsTerm(listed, s)) return;
      out.push({ text: s, field, index: i, category: "unclear", kind: "skill", ai_inferred: job.inferred.has(field), flexible: false });
    });
  }
  return out;
}

// ---------------------------------------------------------------- evaluation

type Eval = { status: MatchStatus; code: string; params?: Record<string, string | number>; evidence?: string | null };

function evalLicence(text: string, p: Profile): Eval {
  const dl = p.driver_licence;
  const needVehicle = RE.vehicle.test(text);
  const ev = dl.has == null ? null : `${dl.has ? "✓" : "✗"} ${dl.type ?? ""}${dl.jurisdiction ? ` (${dl.jurisdiction})` : ""}`.trim();
  if (dl.has == null) return { status: "unknown", code: "licence_unknown" };
  if (dl.has === false) return { status: "not_met", code: "licence_missing", evidence: ev };
  if (needVehicle && dl.has_vehicle === false) return { status: "not_met", code: "vehicle_missing", evidence: ev };
  if (needVehicle && dl.has_vehicle == null) return { status: "partial", code: "vehicle_unknown", evidence: ev };
  return { status: "met", code: "licence_met", params: { type: dl.type ?? "" }, evidence: ev };
}

const COUNTRY_RE: [RegExp, string][] = [
  [/canad|加拿大/i, "Canada"],
  [/united states|\bu\.?s\.?a?\b|america|美国/i, "United States"],
  [/united kingdom|\bu\.?k\.?\b|britain|英国/i, "United Kingdom"],
  [/australia|澳大利亚/i, "Australia"],
  [/china|中国/i, "China"],
  [/european union|\beu\b/i, "EU"],
];
const countryOf = (text: string): string | null => COUNTRY_RE.find(([re]) => re.test(text))?.[1] ?? null;
const sameCountry = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (lc(a) === lc(b) || countryOf(a) === countryOf(b));

function evalAuthorization(text: string, p: Profile, job: JobRequirementsInput): Eval {
  const country = countryOf(text) ?? (job.country ? (countryOf(job.country) ?? job.country) : null);
  if (!country) return { status: "unknown", code: "auth_country_unknown" };
  const entry = p.work_authorization.find((w) => sameCountry(w.country, country));
  if (!entry) return { status: "unknown", code: "auth_unknown", params: { country } };
  const ev = `${entry.country}: ${entry.status.replace(/_/g, " ")}${entry.expires ? ` → ${entry.expires}` : ""}`;
  const citizenOnly = /citizen|公民/i.test(text) && !/permanent resident|永久居民|\bpr\b|or (other )?(legal|work) (authori|status)/i.test(text);
  if (citizenOnly) {
    if (entry.status === "citizen") return { status: "met", code: "auth_met", params: { country }, evidence: ev };
    // Citizenship wording is sometimes loose; flag strongly but do not declare definitive ineligibility.
    return { status: "not_met", code: "auth_citizen_only", params: { country }, evidence: ev };
  }
  if (entry.status === "citizen" || entry.status === "permanent_resident") return { status: "met", code: "auth_met", params: { country }, evidence: ev };
  if (entry.status === "work_permit") return { status: "partial", code: "auth_permit_check", params: { country }, evidence: ev };
  if (entry.status === "needs_sponsorship") {
    if (job.visa_sponsorship === "available") return { status: "partial", code: "auth_sponsorship_available", params: { country }, evidence: ev };
    return { status: "not_met", code: "auth_sponsorship", params: { country }, evidence: ev };
  }
  return { status: "unknown", code: "auth_other", params: { country }, evidence: ev };
}

function evalClearance(text: string, p: Profile): Eval {
  const c = p.security_clearance?.trim();
  if (!c) return { status: "unknown", code: "clearance_unknown" };
  if (/^(none|no|n\/a|无)$/i.test(c)) return { status: /obtain|eligib|able to|能够获得/i.test(text) ? "unknown" : "not_met", code: /obtain|eligib|able to/i.test(text) ? "clearance_obtainable" : "clearance_missing", evidence: c };
  const want = lc(text);
  const levelOk = !/top secret/.test(want) || /top secret/i.test(c);
  return levelOk ? { status: "met", code: "clearance_met", evidence: c } : { status: "partial", code: "clearance_level", evidence: c };
}

function evalLanguage(text: string, p: Profile): Eval {
  let langs = LANGS.filter(([re]) => re.test(text)).map(([, n]) => n);
  if (!langs.length && /bilingual|双语/i.test(text)) langs = ["English", "French"];
  if (!langs.length) return { status: "unknown", code: "lang_unknown" };
  if (!p.languages.length) return { status: "unknown", code: "lang_profile_empty" };
  const need = requiredLanguageLevel(text);
  const results = langs.map((name) => {
    const aliases = LANG_ALIASES[name] ?? [lc(name)];
    const have = p.languages.find((l) => aliases.some((a) => lc(l.language).includes(a)));
    return { name, have, rank: have ? LEVEL_RANK[have.level] : 0 };
  });
  // "English or French" → any one is enough; "English and French"/bilingual → all.
  const anyOne = /\bor\b|或/i.test(text) && !/bilingual|双语|\band\b|和/i.test(text);
  const ok = (r: (typeof results)[number]) => r.rank >= need;
  const evidence = results.map((r) => `${r.name}: ${r.have ? r.have.level : "—"}`).join(", ");
  const needName = (Object.entries(LEVEL_RANK).find(([, v]) => v === need) ?? ["professional"])[0];
  if (anyOne ? results.some(ok) : results.every(ok)) return { status: "met", code: "lang_met", params: { languages: langs.join(", "), level: needName }, evidence };
  const missing = results.filter((r) => !r.have).map((r) => r.name);
  if (missing.length && (anyOne ? results.every((r) => !r.have) : true)) return { status: "not_met", code: "lang_missing", params: { languages: missing.join(", ") }, evidence };
  const close = results.every((r) => r.rank >= need - 1);
  return { status: close ? "partial" : "not_met", code: "lang_below", params: { languages: langs.join(", "), level: needName }, evidence };
}

function evalEducation(text: string, p: Profile, job: JobRequirementsInput, flexible: boolean): Eval {
  const need = requiredEducationLevel(text);
  if (need == null) return { status: "unknown", code: "edu_unclear_requirement" };
  if (!p.education.length) return { status: "unknown", code: "edu_unknown" };
  const allowsAlt = ALT_EDU_RE.test(text);
  const sorted = [...p.education].sort((a, b) => EDU_RANK[b.level] - EDU_RANK[a.level]);
  const done = sorted.filter((e) => e.completed !== false);
  const best = done[0];
  const evidence = sorted.map((e) => `${e.level}${e.field ? ` — ${e.field}` : ""}${e.country ? ` (${e.country})` : ""}${e.completed === false ? " …" : ""}`).join("; ");
  const inProgress = sorted.find((e) => e.completed === false && EDU_RANK[e.level] >= need);
  if (!best || EDU_RANK[best.level] < need) {
    if (inProgress) return { status: "partial", code: "edu_in_progress", evidence };
    if (allowsAlt) return { status: "partial", code: "edu_below_equivalent", evidence };
    return { status: "not_met", code: "edu_below", evidence };
  }
  // Field of study, when the posting names fields.
  const m = text.match(/\b(?:in|of)\s+([^.;]+)/i);
  const fieldsText = m ? m[1] : "";
  const namedFields = keywords(fieldsText).filter((w) => !["degree", "diploma", "bachelor", "master", "school", "high", "university", "college", "education", "secondary"].includes(w));
  const qualifying = done.filter((e) => EDU_RANK[e.level] >= need);
  const foreign = job.country && EDU_RANK[best.level] === need && qualifying.every((e) => e.country && !sameCountry(e.country, job.country));
  const params = foreign ? { country: qualifying[0].country ?? "" } : undefined;
  if (namedFields.length && need >= 2) {
    const fieldMatch = qualifying.some((e) => e.field && keywords(e.field).some((w) => namedFields.includes(w)));
    if (!fieldMatch) {
      if (/related|similar|relevant|any|相关/i.test(text) || flexible) return { status: "partial", code: "edu_field_related", evidence };
      return { status: "partial", code: "edu_field_differs", evidence };
    }
  }
  return { status: "met", code: foreign ? "edu_met_foreign" : "edu_met", params, evidence };
}

/** Role nouns that say nothing about the area of experience ("Risk Analyst" → area "risk"). */
const ROLE_WORDS = new Set("analyst analysts specialist specialists associate coordinator officer assistant representative consultant professional role roles team member".split(" "));
const GENERIC_AREA_RE = /\b(industry|relevant|related|professional|work|any|general)\b|相关|工作经验/i;

function experienceYears(text: string): number | null {
  const m = text.match(RE.experience);
  if (!m) return null;
  return Number(m[1] ?? m[3]);
}

function evalExperience(text: string, p: Profile, flexible: boolean, now: Date): Eval {
  const need = experienceYears(text);
  if (need == null) return { status: "unknown", code: "exp_unclear_requirement" };
  const area = keywords(text.replace(RE.experience, " ")).filter((w) => w.length > 2 && !ROLE_WORDS.has(w));
  // "industry, investigative, or AML experience": a broad alternative means any experience may count.
  const broad = GENERIC_AREA_RE.test(text) && /,|\bor\b|或/i.test(text);
  // 1) Explicit "N years of X" statements in the profile.
  const summaries = p.experience_summary.filter((s) => !area.length || keywords(s.area).some((w) => area.includes(w)));
  let have: number | null = summaries.length ? Math.max(...summaries.map((s) => s.years)) : null;
  let evidence = summaries.length ? summaries.map((s) => `${s.area}: ${fmtYears(s.years)}y`).join(", ") : null;
  let undated = false;
  // 2) Otherwise, dated roles whose title/areas/description match the requirement's area.
  if (have == null && p.experience.length) {
    const relevant = p.experience.filter((e) => {
      if (!area.length) return true;
      const hay = keywords([e.title, e.organization, ...(e.areas ?? []), e.description].filter(Boolean).join(" "));
      return area.some((w) => hay.includes(w));
    });
    let months = 0;
    for (const e of relevant) {
      const mth = monthsBetween(e.start, e.end, e.current, now);
      if (mth == null) undated = true;
      else months += mth;
    }
    if (relevant.length) {
      have = months / 12;
      evidence = relevant.map((e) => `${e.title}${e.organization ? ` @ ${e.organization}` : ""} (${e.start ?? "?"}–${e.current ? "now" : (e.end ?? "?")})`).join("; ");
    } else {
      have = 0;
      evidence = null;
    }
  }
  if (have == null) return { status: "unknown", code: "exp_unknown" };
  const params = { have: fmtYears(have), need: fmtYears(need) };
  if (have >= need) return { status: "met", code: "exp_met", params, evidence };
  if (undated) return { status: "unknown", code: "exp_dates_missing", params, evidence };
  if (flexible && have >= Math.max(need - 1, need / 2)) return { status: "partial", code: "exp_flexible", params, evidence };
  if (broad && p.experience.length) {
    let total = 0;
    let anyUndated = false;
    for (const e of p.experience) {
      const mth = monthsBetween(e.start, e.end, e.current, now);
      if (mth == null) anyUndated = true;
      else total += mth;
    }
    const y = total / 12;
    if (y >= need) return { status: "partial", code: "exp_general", params: { have: fmtYears(y), need: fmtYears(need) }, evidence: p.experience.map((e) => e.title).join("; ") };
    if (anyUndated) return { status: "unknown", code: "exp_dates_missing", params, evidence };
  }
  if (have === 0 && area.length) return { status: "not_met", code: "exp_area_missing", params, evidence };
  return { status: flexible ? "partial" : "not_met", code: flexible ? "exp_flexible" : "exp_below", params, evidence };
}

const CERT_NOT = new Set(["AML", "ATF", "KYC", "MS", "SQL", "IT", "HR", "UTR", "UTRS", "STR", "STRS", "GAML", "DSLR", "CRE", "GIS", "CRM", "API", "EDD", "USA", "UK", "US", "EU"]);
function evalCertification(text: string, p: Profile): Eval {
  const acronyms = [...new Set((text.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) ?? []).filter((a) => !CERT_NOT.has(a)))];
  const held = p.certifications;
  const find = (name: string) => held.find((c) => containsTerm(c.name, name) || containsTerm(name, c.name) || lc(c.name) === lc(name));
  const names = acronyms.length ? acronyms : held.filter((c) => containsTerm(text, c.name)).map((c) => c.name);
  if (!names.length) return { status: "unknown", code: "cert_unclear_requirement" };
  const hits = names.map((n) => ({ n, c: find(n) })).filter((x) => x.c);
  const heldHit = hits.find((x) => x.c!.status === "held");
  if (heldHit) return { status: "met", code: "cert_met", params: { name: heldHit.c!.name }, evidence: heldHit.c!.name };
  if (hits.length) return { status: "partial", code: "cert_in_progress", params: { name: hits[0].c!.name }, evidence: hits[0].c!.name };
  return { status: "not_met", code: "cert_missing", params: { names: names.join(" / ") }, evidence: held.length ? held.map((c) => c.name).join(", ") : null };
}

const SOFT_RE = /communicat|attention to detail|detail[- ]oriented|team ?player|interpersonal|organi[sz]ation|prioriti[sz]|problem[- ]solving|analytical|critical thinking|self[- ]motivated|discretion|confidential|judgment|multitask|time management|work independently|deadlines|沟通|细节|团队/i;
const TOOL_RE = /\b(SQL|Python|R\b|Excel|Power ?BI|Tableau|MS Office|Microsoft Office|Word|PowerPoint|Outlook|SAS|SPSS|Java(Script)?|TypeScript|C\+\+|C#|AWS|Azure|GCP|Salesforce|SAP|Oracle|Jira|Git|Figma|Snowflake|dbt|Looker|Copilot|GIS|CRM|Bloomberg|VBA)\b/g;

function evalSkill(text: string, p: Profile): Eval {
  const terms = [...p.skills, ...p.projects.flatMap((x) => x.skills ?? []), ...p.experience.flatMap((e) => e.areas ?? []), ...p.experience_summary.map((s) => s.area), ...p.certifications.map((c) => c.name)];
  const present = terms.filter((s) => containsTerm(text, s));
  const tools = [...new Set(text.match(TOOL_RE) ?? [])];
  if (tools.length) {
    const found = tools.map((t) => ({ t, have: profileHasSkill(terms, t) }));
    const missing = found.filter((x) => !x.have).map((x) => x.t);
    const ev = found.filter((x) => x.have).map((x) => x.have!).join(", ") || null;
    if (!terms.length) return { status: "unknown", code: "skill_profile_empty" };
    if (!missing.length) return { status: "met", code: "skill_met", params: { skills: tools.join(", ") }, evidence: ev };
    const alternatives = /\bor\b|\/|或/i.test(text);
    if (alternatives && missing.length < tools.length) return { status: "met", code: "skill_met", params: { skills: found.filter((x) => x.have).map((x) => x.t).join(", ") }, evidence: ev };
    return { status: missing.length < tools.length ? "partial" : "not_met", code: "skill_missing", params: { skills: missing.join(", ") }, evidence: ev };
  }
  if (present.length) return { status: "met", code: "skill_met", params: { skills: [...new Set(present)].slice(0, 4).join(", ") }, evidence: [...new Set(present)].join(", ") };
  if (SOFT_RE.test(text)) return { status: "unknown", code: "skill_soft" };
  // A short single term (from the job's skills list) that the profile does not mention.
  if (text.length <= 40 && terms.length) return { status: "not_met", code: "skill_missing", params: { skills: text } };
  return { status: "unknown", code: "skill_unknown" };
}

const ELIGIBILITY_KINDS = new Set<RequirementKind>(["licence", "authorization", "clearance"]);

// ---------------------------------------------------------------- main

export function matchJob(job: JobRequirementsInput, profile: Profile | null, now = new Date()): MatchResult {
  const reqs = extractRequirements(job);
  const items: MatchItem[] = reqs.map((r, i) => {
    let e: Eval;
    if (!profile) e = { status: "unknown", code: "no_profile" };
    else if (r.kind === "licence") e = evalLicence(r.text, profile);
    else if (r.kind === "authorization") e = evalAuthorization(r.text, profile, job);
    else if (r.kind === "clearance") e = evalClearance(r.text, profile);
    else if (r.kind === "language") e = evalLanguage(r.text, profile);
    else if (r.kind === "education") e = evalEducation(r.text, profile, job, r.flexible);
    else if (r.kind === "experience") e = evalExperience(r.text, profile, r.flexible, now);
    else if (r.kind === "certification") e = evalCertification(r.text, profile);
    else e = evalSkill(r.text, profile);
    // Wording that allows alternatives never yields a hard "not met".
    if (e.status === "not_met" && r.flexible && r.kind !== "authorization") e = { ...e, status: "partial" };
    const eligibility = r.category === "mandatory" && (ELIGIBILITY_KINDS.has(r.kind) || (r.kind === "certification" && r.field === "licences"));
    return {
      id: `${r.field}:${r.index ?? i}`,
      text: r.text,
      field: r.field,
      index: r.index,
      category: r.category,
      kind: r.kind,
      ai_inferred: r.ai_inferred,
      flexible: r.flexible,
      status: e.status,
      reason: { code: e.code, params: e.params },
      profile_evidence: e.evidence ?? null,
      eligibility,
    };
  });
  return { summary: summarize(items, !!profile), items, computed_at: now.getTime() };
}

const VALUE: Record<MatchStatus, number> = { met: 1, partial: 0.5, not_met: 0, unknown: 0 };
const WEIGHT: Record<RequirementCategory, number> = { mandatory: 2, preferred: 1, unclear: 0.5 };

export function summarize(items: MatchItem[], hasProfile: boolean): MatchSummary {
  const count = (cat: RequirementCategory) => {
    const xs = items.filter((i) => i.category === cat);
    return { met: xs.filter((x) => x.status === "met").length, partial: xs.filter((x) => x.status === "partial").length, not_met: xs.filter((x) => x.status === "not_met").length, unknown: xs.filter((x) => x.status === "unknown").length, total: xs.length };
  };
  const mandatory = count("mandatory");
  const preferred = count("preferred");
  const evaluated = items.filter((i) => i.status !== "unknown");
  const totalW = evaluated.reduce((a, i) => a + WEIGHT[i.category], 0);
  const score = hasProfile && evaluated.length >= 3 && totalW > 0 ? Math.round((evaluated.reduce((a, i) => a + WEIGHT[i.category] * VALUE[i.status], 0) / totalW) * 100) : null;
  const eligibility_issues = items.filter((i) => i.eligibility && i.status === "not_met").length;
  let level: MatchSummary["level"];
  // A failed must-have is always reported, even when too little is known to compute a score.
  if (!hasProfile) level = "insufficient";
  else if (mandatory.not_met > 0) level = "mandatory_gap";
  else if (score == null) level = "insufficient";
  else level = score >= 80 ? "strong" : score >= 60 ? "good" : score >= 40 ? "partial" : "weak";
  return { has_profile: hasProfile, level, score, mandatory, preferred, eligibility_issues };
}
