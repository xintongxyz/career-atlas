// Option matching for Workday's repeatable sections and tag boxes (skills, education, languages,
// websites, "How did you hear about us?"). Pure functions, unit-tested.
//
// Rule of thumb: an option is taken only when it means the same thing as the applicant's own data —
// exact, or an unambiguous equivalent (vendor prefix "Microsoft Excel" for "Excel", a qualifier in
// parentheses, a known abbreviation). Several equally good candidates → no choice (asked or skipped).
// Nothing here invents facts: every value comes from My Profile, the user's answers or the saved job.

export const mnorm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}+#' ]+/gu, " ")
    .replace(/'s\b/g, "s")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();

export type MatchResult = { pick: string | null; how: "exact" | "equivalent" | "parts" | "category" | null; ambiguous: string[] };
const none = (ambiguous: string[] = []): MatchResult => ({ pick: null, how: null, ambiguous });

/** Vendors / qualifiers that do not change what a skill is ("Microsoft Excel" = "Excel"). */
const VENDOR = /^(microsoft|ms|google|adobe|amazon|aws|apache|oracle|sap|ibm|salesforce|atlassian|tableau software|the)\s+/;
const stripQualifier = (s: string) => s.replace(/\s*\((programming language|software|language|tool|platform|framework)\)\s*$/i, "").trim();

/**
 * A skill from My Profile against the site's suggestions. Exact (ignoring case and punctuation)
 * first; then the same skill with a vendor prefix or a "(Programming Language)"-style qualifier.
 * "SQL" never becomes "SQL Server", "Excel" never "Excel VBA".
 */
export function matchSkill(skill: string, options: string[]): MatchResult {
  const q = mnorm(skill);
  if (!q) return none();
  const opts = [...new Set(options.filter(Boolean))];
  const exact = opts.filter((o) => mnorm(o) === q);
  if (exact.length) return { pick: exact[0], how: "exact", ambiguous: [] };
  const eq = opts.filter((o) => {
    const n = mnorm(stripQualifier(o));
    return n === q || n.replace(VENDOR, "") === q || q.replace(VENDOR, "") === n;
  });
  if (eq.length === 1) return { pick: eq[0], how: "equivalent", ambiguous: [] };
  return none(eq);
}

// ---------------------------------------------------------------- schools

const SCHOOL_STOP = /\b(the|of|at|and|in)\b/g;
const schoolCore = (s: string) => mnorm(s).replace(SCHOOL_STOP, " ").replace(/\s+/g, " ").trim();

/** Search terms to try for a school, most specific first ("University of X" ↔ "X University", "uX"). */
export function schoolQueries(institution: string): string[] {
  const n = institution.trim();
  const out = [n];
  const m = /^university of (.+)$/i.exec(n);
  if (m) out.push(`${m[1]} University`, m[1]);
  const m2 = /^(.+) university$/i.exec(n);
  if (m2) out.push(`University of ${m2[1]}`, m2[1]);
  const u = /^u([A-Z][a-z]+)$/.exec(n); // uOttawa-style
  if (u) out.push(`University of ${u[1]}`, u[1]);
  return [...new Set(out.filter((x) => x.length >= 3))];
}

/** Same institution? Exact, word-order variants of "University of X", or the "uX" short form. */
export function sameSchool(a: string, b: string): boolean {
  const x = schoolCore(a);
  const y = schoolCore(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const key = (s: string) => s.split(" ").sort().join(" ");
  if (key(x) === key(y)) return true;
  const short = (s: string) => /^u([a-z]+)$/.exec(s.replace(/\s+/g, ""))?.[1];
  const sx = short(mnorm(a));
  const sy = short(mnorm(b));
  if (sx && key(y) === key(`university ${sx}`)) return true;
  if (sy && key(x) === key(`university ${sy}`)) return true;
  return false;
}

export function matchSchool(institution: string, options: string[]): MatchResult {
  const hits = [...new Set(options.filter((o) => sameSchool(o, institution)))];
  if (hits.length === 1) return { pick: hits[0], how: mnorm(hits[0]) === mnorm(institution) ? "exact" : "equivalent", ambiguous: [] };
  return none(hits);
}

// ---------------------------------------------------------------- degrees

const LEVEL_WORD: Record<string, RegExp> = {
  high_school: /\b(high school|secondary|ged)\b/,
  diploma: /\b(diploma|certificate|associate)/,
  bachelor: /\b(bachelor|undergraduate|baccalaureate)/,
  master: /\bmaster/,
  doctorate: /\b(doctor|doctorate|ph ?d|dphil)\b/,
};
/** The generic name of a level ("Master's Degree", "Masters", "Master"). */
const GENERIC: Record<string, RegExp> = {
  bachelor: /^(bachelors?( degree)?|bachelor degree|undergraduate( degree)?|baccalaureate)$/,
  master: /^(masters?( degree)?|master degree|graduate degree masters?)$/,
  doctorate: /^(doctorate|doctoral degree|doctors? degree|phd|ph d)$/,
  diploma: /^(diploma|college diploma|certificate|associates?( degree)?)$/,
  high_school: /^(high school( diploma)?|secondary school( diploma)?|ged)$/,
};

/**
 * The degree option for one education entry's level. The generic option ("Master's Degree") is
 * preferred; a specific one ("Master of Science") only when it is the ONLY option of that level —
 * otherwise the specific credential would be a guess.
 */
export function matchDegree(level: string, options: string[]): MatchResult {
  const re = LEVEL_WORD[level];
  if (!re) return none();
  const ofLevel = options.filter((o) => re.test(mnorm(o)) && !(level === "diploma" && /high school/.test(mnorm(o))));
  const generic = ofLevel.filter((o) => GENERIC[level]?.test(mnorm(o)));
  if (generic.length >= 1) return { pick: generic[0], how: "exact", ambiguous: [] };
  if (ofLevel.length === 1) return { pick: ofLevel[0], how: "equivalent", ambiguous: [] };
  return none(ofLevel);
}

// ---------------------------------------------------------------- fields of study

/**
 * Field of study / major. Exact first (ignoring case/punctuation, "&" = "and"); then the parts of a
 * joint programme ("Economics and Statistics" → "Economics" + "Statistics") when the box accepts
 * several values and every part exists exactly. Never a different major.
 */
export function matchFieldOfStudy(field: string, options: string[], multi: boolean): { picks: string[]; how: MatchResult["how"]; ambiguous: string[] } {
  const q = mnorm(field);
  if (!q) return { picks: [], how: null, ambiguous: [] };
  const exact = options.filter((o) => mnorm(stripQualifier(o)) === q);
  if (exact.length) return { picks: [exact[0]], how: "exact", ambiguous: [] };
  const parts = q.split(/\s*(?:\band\b|,|\/|\+)\s*/).filter(Boolean);
  if (multi && parts.length > 1) {
    const picks = parts.map((p) => options.find((o) => mnorm(o) === p) ?? null);
    if (picks.every(Boolean)) return { picks: picks as string[], how: "parts", ambiguous: [] };
  }
  return { picks: [], how: null, ambiguous: [] };
}

/** Search terms for a field of study: the whole name, then each part of a joint programme. */
export function fieldQueries(field: string): string[] {
  const parts = field.split(/\s*(?:\band\b|&|,|\/|\+)\s*/i).map((x) => x.trim()).filter(Boolean);
  return [...new Set([field.trim(), ...(parts.length > 1 ? parts : [])])];
}

// ---------------------------------------------------------------- languages

const LANG_ALIASES: Record<string, string[]> = {
  mandarin: ["mandarin", "chinese mandarin", "mandarin chinese", "chinese"],
  chinese: ["chinese", "mandarin", "chinese mandarin", "mandarin chinese"],
  cantonese: ["cantonese", "chinese cantonese", "cantonese chinese", "yue"],
  english: ["english"],
  french: ["french", "francais"],
  spanish: ["spanish", "espanol"],
};

export function matchLanguage(language: string, options: string[]): MatchResult {
  const q = mnorm(language);
  const exact = options.filter((o) => mnorm(o) === q);
  if (exact.length) return { pick: exact[0], how: "exact", ambiguous: [] };
  const names = LANG_ALIASES[q] ?? [q];
  for (const n of names) {
    const hits = options.filter((o) => mnorm(o) === n || mnorm(o).replace(/\s*\(.*\)$/, "") === n);
    if (hits.length === 1) return { pick: hits[0], how: "equivalent", ambiguous: [] };
    if (hits.length > 1) return none(hits);
  }
  return none();
}

/** Words that name each saved level on common proficiency scales. */
const LEVEL_SCALE: Record<string, RegExp> = {
  basic: /\b(basic|beginner|elementary|novice|limited|some knowledge)\b/,
  intermediate: /\b(intermediate|conversational|moderate|working knowledge)\b/,
  professional: /\b(advanced|professional( working)?|proficient|full professional)\b/,
  fluent: /\b(fluent|fluency|full professional|expert)\b/,
  native: /\b(native|bilingual|mother tongue|first language)\b/,
};

/**
 * Proficiency option for a saved level. Exactly one option must name the level; "native" may use a
 * "Fluent" option only when the scale has no native/bilingual step (fluent is then its top).
 */
export function matchProficiency(level: string, options: string[]): MatchResult {
  const re = LEVEL_SCALE[level];
  if (!re) return none();
  const words = options.map((o) => ({ o, n: mnorm(o).replace(/^\d+\s*/, "") }));
  const hits = words.filter((w) => re.test(w.n)).map((w) => w.o);
  if (hits.length === 1) return { pick: hits[0], how: "exact", ambiguous: [] };
  if (hits.length > 1) {
    // "Professional" vs "Full professional": the plain word wins only when unique.
    const plain = hits.filter((h) => mnorm(h).replace(/^\d+\s*/, "") === level);
    if (plain.length === 1) return { pick: plain[0], how: "exact", ambiguous: [] };
    return none(hits);
  }
  if (level === "native" && !words.some((w) => LEVEL_SCALE.native.test(w.n))) {
    const f = words.filter((w) => LEVEL_SCALE.fluent.test(w.n)).map((w) => w.o);
    if (f.length === 1) return { pick: f[0], how: "equivalent", ambiguous: [] };
  }
  return none();
}

// ---------------------------------------------------------------- websites

/** Comparable form of a URL (scheme, "www.", trailing slash and case of the host ignored). */
export function urlKey(u: string): string {
  const s = u.trim();
  try {
    const x = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

/** A URL as typed into a form: keeps the destination, adds https:// when the scheme is missing. */
export function formUrl(u: string): string {
  const s = u.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

// ---------------------------------------------------------------- "How did you hear about us?"

export type JobSource = "linkedin" | "indeed" | "glassdoor" | "company_site" | "job_board" | null;

/** Where the user found the job, from the saved job (not a guess): route, URL parameters, platform. */
export function jobSourceOf(job: { sourcePlatform?: string | null; originalUrl?: string | null; route?: string | null; sourceUrl?: string | null }): JobSource {
  if (job.route === "indeed_company_site" || job.route === "indeed_apply") return "indeed";
  for (const raw of [job.sourceUrl, job.originalUrl]) {
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const h = u.hostname.toLowerCase();
    if (/(^|\.)linkedin\.com$/.test(h)) return "linkedin";
    if (/(^|\.)indeed\.[a-z.]+$/.test(h)) return "indeed";
    if (/(^|\.)glassdoor\.[a-z.]+$/.test(h)) return "glassdoor";
    const p = mnorm([u.searchParams.get("source"), u.searchParams.get("src"), u.searchParams.get("utm_source"), u.searchParams.get("codes")].filter(Boolean).join(" "));
    if (/\blinkedin\b/.test(p)) return "linkedin";
    if (/\bindeed\b/.test(p)) return "indeed";
    if (/\bglassdoor\b/.test(p)) return "glassdoor";
  }
  if (job.sourcePlatform === "linkedin") return "linkedin";
  if (job.sourcePlatform === "indeed") return "indeed";
  // "company_site" only says the saved link points at an employer's site, not where the user found
  // the job — not used as evidence.
  return null;
}

const SOURCE_LEAF: Record<Exclude<JobSource, null>, RegExp> = {
  linkedin: /^linked ?in\b/,
  indeed: /^indeed\b/,
  glassdoor: /^glassdoor\b/,
  company_site: /^(company|corporate|employer|our) (web ?site|career(s)? (site|page|website))$|^careers? (site|page|website)$|^company careers?( page| site)?$/,
  job_board: /^(online )?job (board|site|posting)s?$/,
};
/** Truthful broader categories, in order of preference; never referral, campus, agency, event. */
const SOURCE_CATEGORY: Record<Exclude<JobSource, null>, RegExp[]> = {
  linkedin: [/^social (media|network(ing)?)( sites?)?$/, /^(online )?job (board|site)s?$/, /^(internet|online|website|web)$/],
  indeed: [/^(online )?job (board|site|search engine)s?$/, /^(internet|online|website|web)$/],
  glassdoor: [/^(online )?job (board|site)s?$/, /^(internet|online|website|web)$/],
  company_site: [/^(internet|online|website|web)$/],
  job_board: [/^(internet|online|website|web)$/],
};
const NEVER_SOURCE = /referr|campus|university|college|school|agency|recruit(er|ment)|career fair|job fair|event|staffing|headhunter|newspaper|radio|tv\b/;

/** The option for the job's source: the exact leaf, else a truthful category to open or choose. */
export function matchSource(src: Exclude<JobSource, null>, options: string[]): { leaf: string | null; categories: string[] } {
  const clean = options.filter((o) => !NEVER_SOURCE.test(mnorm(o)));
  const leaf = clean.filter((o) => SOURCE_LEAF[src].test(mnorm(o)));
  const cats: string[] = [];
  for (const re of SOURCE_CATEGORY[src]) for (const o of clean) if (re.test(mnorm(o)) && !cats.includes(o)) cats.push(o);
  return { leaf: leaf.length === 1 ? leaf[0] : null, categories: cats };
}

export const SOURCE_QUERY: Record<Exclude<JobSource, null>, string> = { linkedin: "LinkedIn", indeed: "Indeed", glassdoor: "Glassdoor", company_site: "Company Website", job_board: "Job Board" };
