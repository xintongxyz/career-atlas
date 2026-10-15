// Deterministic meaning layer for application forms (no AI, no network). Shared by the worker
// (src/local/apply/plan.ts) and the server (remembering answers as Application Defaults).
//
// 1. Option matching: picks the option that MEANS the same as an answer, in a fixed order:
//      exact normalized → known aliases for the field's domain → context (yes/no wording) →
//      a single unambiguous equivalent → otherwise nothing (the user is asked).
//    Aliases are grouped by concept; an option that maps to two concepts ("Work Mobile") or a
//    different concept ("Home Phone") is never taken. No edit-distance or "closest" guessing.
// 2. Question meaning: classifies screening questions ("Have you worked for us before?",
//    "Are you enrolled in a co-op program?", …) with explicit exclusions, so an answer is never
//    reused for a question that merely looks similar ("applied here before", "worked with our
//    employees", "Canadian citizen" vs "eligible to work in Canada", …).
export interface FieldOption {
  value: string;
  label: string;
}

/** Same normalization as the planner: lower case, punctuation → spaces, "(required)" removed. */
export const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\*/g, " ")
    .replace(/\(required\)|\(optional\)/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------- option domains

export type OptionDomain = "yes_no" | "phone_type" | "country" | "region" | "degree" | "contact_method" | "generic";

type Concept = { id: string; aliases: RegExp };
const c = (id: string, aliases: RegExp): Concept => ({ id, aliases });

const PHONE_TYPES: Concept[] = [
  c("mobile", /^(personal )?(mobile|cell|cellular)( (phone|telephone|number))?$|^(mobile|cell) ?\/ ?(cell|mobile)( phone)?$|^smartphone$/),
  c("home", /^(home|residence|residential|landline)( (phone|telephone|number))?$/),
  c("work", /^(work|business|office)( (phone|telephone|number))?$/),
  c("fax", /^fax( (phone|number))?$/),
  c("voip", /^(voip|internet)( (phone|telephone))?$/),
  c("pager", /^pager$/),
];

const YES_NO: Concept[] = [
  c("yes", /^(yes|y|true|affirmative|oui|是)( i (am|do|have|will|can|would))?$/),
  c("no", /^(no|n|false|negative|non|否)( i (am|do|have|will|can|would) not| i (havent|dont|wont|cant|wouldnt|m not|am not))?$/),
];

// Names in English, ISO codes, and Chinese (My Profile may be written in either language).
const COUNTRIES: Concept[] = [
  c("canada", /^(canada|ca|can|canadian address|加拿大)$/),
  c("united states", /^(united states( of america)?|usa|us|u s( a)?|america|美国|美利坚合众国)$/),
  c("united kingdom", /^(united kingdom|uk|gb|great britain|england|英国|大不列颠)$/),
  c("china", /^(china|cn|chn|peoples republic of china|china mainland|mainland china|prc|中国|中华人民共和国|中国大陆)$/),
  c("india", /^(india|in|ind|印度)$/),
  c("france", /^(france|fr|fra|法国)$/),
  c("germany", /^(germany|de|deu|德国)$/),
  c("australia", /^(australia|au|aus|澳大利亚|澳洲)$/),
  c("mexico", /^(mexico|mx|mex|墨西哥)$/),
  c("hong kong", /^(hong kong|hk|hkg|香港)$/),
  c("taiwan", /^(taiwan|tw|twn|台湾)$/),
  c("singapore", /^(singapore|sg|sgp|新加坡)$/),
  c("japan", /^(japan|jp|jpn|日本)$/),
  c("south korea", /^(south korea|korea|republic of korea|kr|kor|韩国)$/),
];

const COUNTRY_NAME: Record<string, string> = { canada: "Canada", "united states": "United States", "united kingdom": "United Kingdom", china: "China", india: "India", france: "France", germany: "Germany", australia: "Australia", mexico: "Mexico", "hong kong": "Hong Kong", taiwan: "Taiwan", singapore: "Singapore", japan: "Japan", "south korea": "South Korea" };

/**
 * The English name to search for on a form, for a country written any known way ("加拿大", "CA",
 * "Canada" → "Canada"). Unknown spellings are returned unchanged (never guessed).
 */
export function englishCountry(value: string): string {
  const ids = conceptsOf("country", value);
  return ids.length === 1 && COUNTRY_NAME[ids[0]] ? COUNTRY_NAME[ids[0]] : value.trim();
}

const PROVINCES: [string, string, string][] = [
  ["alberta", "ab", "阿尔伯塔省?|艾伯塔省?"],
  ["british columbia", "bc", "不列颠哥伦比亚省?|卑诗省?"],
  ["manitoba", "mb", "曼尼托巴省?"],
  ["new brunswick", "nb", "新不伦瑞克省?"],
  ["newfoundland and labrador", "nl", "纽芬兰与拉布拉多省?"],
  ["northwest territories", "nt", "西北地区"],
  ["nova scotia", "ns", "新斯科舍省?"],
  ["nunavut", "nu", "努纳武特地区"],
  ["ontario", "on", "安大略省?"],
  ["prince edward island", "pe", "爱德华王子岛省?"],
  ["quebec", "qc", "魁北克省?"],
  ["saskatchewan", "sk", "萨斯喀彻温省?"],
  ["yukon", "yt", "育空地区"],
];
const REGIONS: Concept[] = PROVINCES.map(([name, code, zh]) => c(name, new RegExp(`^(${name}|${code}|${name} \\(${code}\\)|${code} ${name}|${name} ${code}|${zh})$`)));

/** English name of a Canadian province / territory written any known way; unknown → unchanged. */
export function englishRegion(value: string): string {
  const ids = conceptsOf("region", value);
  return ids.length === 1 ? ids[0].replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\bAnd\b/, "and") : value.trim();
}

const DEGREES: Concept[] = [
  c("high_school", /^(high school( diploma)?|secondary( school)?( diploma)?|ged|high school or equivalent)$/),
  c("diploma", /^(college )?diploma$|^(associate|associates)( degree)?$|^certificate$/),
  c("bachelor", /^(undergraduate )?(bachelor|bachelors|baccalaureate)( degree)?$|^(ba|bs|bsc|b sc|bcom|b com|beng|b eng|bba)$/),
  c("master", /^(graduate )?(master|masters)( degree)?$|^(ma|ms|msc|m sc|mba|meng|m eng|mfa)$/),
  c("doctorate", /^(doctorate|doctoral( degree)?|phd|ph d|doctor of philosophy)$/),
];

// "Preferred contact method" options. "Phone" never covers "Text" and vice versa.
const CONTACT_METHODS: Concept[] = [
  c("email", /^(e ?mail|e ?mail address|electronic mail|by e ?mail|via e ?mail|contact me (by|via) e ?mail|e ?mail me)$/),
  c("phone", /^(phone|telephone|phone call|call|by phone|by telephone|contact me by phone|call me|voice)$/),
  c("text", /^(text|sms|text message|text messaging|by text|by sms|contact me by text|text me)$/),
];

const DOMAINS: Record<Exclude<OptionDomain, "generic">, Concept[]> = { yes_no: YES_NO, phone_type: PHONE_TYPES, country: COUNTRIES, region: REGIONS, degree: DEGREES, contact_method: CONTACT_METHODS };

/** The concept(s) a phrase belongs to within a domain. */
export function conceptsOf(domain: OptionDomain, text: string): string[] {
  if (domain === "generic") return [];
  // Country / province options often carry a code: "Canada (+1)", "Ontario (ON)".
  const raw = domain === "country" ? text.replace(/\([^)]*\)|\+\d+/g, " ") : text;
  const n = norm(raw).replace(/'/g, "");
  return DOMAINS[domain].filter((k) => k.aliases.test(n)).map((k) => k.id);
}

/** Leading yes/no in a longer option ("Yes, I am legally authorized…", "No, I have not"). */
function leadingYesNo(label: string): "yes" | "no" | null {
  const n = norm(label);
  if (/^(yes|y)\b/.test(n)) return "yes";
  if (/^(no|n)\b/.test(n)) return "no";
  return null;
}

/**
 * Picks the option meaning `answer`. Returns null when nothing (or more than one option) fits —
 * the caller then asks the user. `domain` limits aliases to the field's meaning.
 */
export function matchOptionSemantic(options: FieldOption[], answer: string, domain: OptionDomain = "generic"): FieldOption | null {
  const a = norm(answer);
  if (!a) return null;
  const opts = options.map((o) => ({ o, l: norm(o.label), v: norm(o.value) })).filter((x) => x.l || x.v);
  // 1. exact normalized
  const exact = opts.filter((x) => x.l === a || (x.v && x.v === a));
  if (exact.length === 1) return exact[0].o;
  if (exact.length > 1) return null;
  // 2. aliases within the domain (yes/no applies to any closed question)
  const dom: OptionDomain = domain === "generic" && conceptsOf("yes_no", a).length ? "yes_no" : domain;
  if (dom !== "generic") {
    const want = conceptsOf(dom, a);
    if (want.length === 1) {
      const hits = opts.filter((x) => {
        const cs = conceptsOf(dom, x.o.label);
        // yes/no: every option that starts with the same word competes ("Yes, I am" vs "Yes, with sponsorship").
        return (cs.length === 1 && cs[0] === want[0]) || (dom === "yes_no" && leadingYesNo(x.l) === want[0]);
      });
      if (hits.length === 1) return hits[0].o;
      if (hits.length > 1) return null;
      // 3. context: yes/no questions answered by longer options ("Yes, I am authorized …").
      if (dom === "yes_no") {
        const lead = opts.filter((x) => leadingYesNo(x.l) === want[0]);
        return lead.length === 1 ? lead[0].o : null;
      }
      // A known concept with no matching option: never fall back to loose text matching
      // (e.g. "Mobile" must not pick "Work Mobile").
      return null;
    }
    if (dom !== "yes_no" && want.length === 0 && opts.some((x) => conceptsOf(dom, x.o.label).length)) return null;
  }
  // 4. one unambiguous equivalent (prefix / containment, single candidate only). Very short answers
  //    ("ON", "CA") are codes: they only match through a domain above, never by prefix.
  if (a.length < 3) return null;
  const starts = opts.filter((x) => x.l.startsWith(a) || (x.l.length > 2 && a.startsWith(x.l)));
  if (starts.length === 1) return starts[0].o;
  if (starts.length > 1) return null;
  const contains = opts.filter((x) => x.l.includes(a));
  return contains.length === 1 ? contains[0].o : null;
}

/** Which option domain a field's label implies. */
export function domainForLabel(label: string, semantic?: string): OptionDomain {
  const l = norm(label);
  if (semantic === "contact_method" || /preferred contact type|preferred (method of |means of |way of |mode of )?(contact|communication)|contact (method|preference)|(method|way|means) (of|to) (contact|reach)|how (would|should|do) (you (like|prefer) (us to|us|to be)|we) (contact|reach)/.test(l)) return "contact_method";
  if (semantic === "phone_country" || /phone (device )?type|type of phone|phone type/.test(l)) return /country|code/.test(l) ? "country" : "phone_type";
  if (semantic === "country" || /^country\b|country (of|code|region)?$/.test(l)) return "country";
  if (semantic === "region" || /^(state|province|region|territory)|province or territory|state province/.test(l)) return "region";
  if (semantic === "degree" || /^degree|highest (level of )?education|education level/.test(l)) return "degree";
  return "generic";
}

// ---------------------------------------------------------------- question meaning

export type Meaning =
  | "prior_employment"
  | "prior_contractor"
  | "prior_affiliate"
  | "prior_application"
  | "prior_interview"
  | "current_employee"
  | "relative_employee"
  | "referral"
  | "work_authorization"
  | "citizenship"
  | "sponsorship_now"
  | "sponsorship_future"
  | "age_18"
  | "background_check"
  | "relocation"
  | "travel"
  | "schedule"
  | "shift_work"
  | "work_arrangement"
  | "enrolled_student"
  | "coop_program"
  | "coop_term_required"
  | "internship_mandatory"
  | "return_to_school"
  | "placement_duration"
  | "graduation_date"
  | "full_time_student"
  | "professional_licence"
  | "certification"
  | "language"
  | "salary"
  | "hourly_rate"
  | "notice_period"
  | "start_date"
  | "conflict_of_interest"
  | "non_compete"
  | "criminal_record"
  | "references"
  | "source"
  | "contact_method"
  | "motivation"
  | "identity"
  | "legal"
  | "unknown";

export type Sensitivity = "normal" | "sensitive" | "identity" | "legal";

export interface QuestionMeaning {
  meaning: Meaning;
  sensitivity: Sensitivity;
  /** May an approved answer be reused for the same meaning (with the same employer where it matters)? */
  reusable: boolean;
  /** Needs the user's explicit approval each time (declarations, consents, attestations). */
  approval: boolean;
  /** The answer depends on the employer (prior employment, prior application, referral…). */
  employerScoped: boolean;
  /** A country named in the question (work authorization / citizenship / sponsorship). */
  country: string | null;
}

const us = "(us|this company|this organi[sz]ation|our (company|organi[sz]ation|firm|bank|group)|the company|this employer)";

const RULES: { meaning: Meaning; re: RegExp; not?: RegExp; sensitivity?: Sensitivity; reusable?: boolean; approval?: boolean; employerScoped?: boolean }[] = [
  // identity & voluntary self-identification — never inferred
  { meaning: "identity", re: /\b(indigenous|first nations?|metis|inuit|aboriginal|visible minorit|racial|racialized|race\b|ethnic|hispanic|latin[oax]|gender|sex\b|sexual orientation|lgbt|two spirit|transgender|pronoun|disabilit|veteran|self identif|demographic|equal employment|eeo)/, sensitivity: "identity", reusable: true },
  // legal declarations / consents — approval every time
  { meaning: "background_check", re: /background (check|screening|investigation)|credit check|reference check|drug (test|screen)/, sensitivity: "legal", approval: true, reusable: false },
  { meaning: "criminal_record", re: /criminal (record|offen[cs]e|conviction)|convicted|pardon/, sensitivity: "legal", approval: true, reusable: false },
  { meaning: "non_compete", re: /non ?compet|non ?solicit|restrictive covenant/, sensitivity: "legal", approval: true, reusable: false },
  { meaning: "conflict_of_interest", re: /conflict of interest/, sensitivity: "legal", approval: true, reusable: false },
  { meaning: "legal", re: /\b(i (hereby )?(certify|attest|declare|acknowledge|agree|consent)|terms (and|&) conditions|privacy (policy|notice)|electronic(ally)? sign|signature|true,? (accurate|correct) and complete)/, sensitivity: "legal", approval: true, reusable: false },
  // employment history with the employer — distinct meanings, checked before the generic rule
  { meaning: "prior_contractor", re: /\b(contractor|consultant|contingent|temporary (worker|staff)|agency worker|freelance)/, not: /currently/, employerScoped: true },
  { meaning: "prior_affiliate", re: /\b(affiliate|subsidiar|sister company|parent company|related compan)/, employerScoped: true },
  { meaning: "prior_application", re: /\b(applied|submitted an application|application (to|with))\b.*\b(before|previously|prior|in the past|last \d+)|\b(previously|ever) applied/, employerScoped: true },
  { meaning: "prior_interview", re: /\binterview(ed)?\b.*\b(before|previously|in the past)|\bpreviously interviewed/, employerScoped: true },
  { meaning: "relative_employee", re: /\b(relative|family member|related to|spouse|partner)\b.*\b(work|employ)/, employerScoped: true },
  { meaning: "current_employee", re: /\b(current(ly)? (an? )?(employee|working (for|at|with) us)|internal (candidate|applicant)|are you (an? )?(current )?employee)/, employerScoped: true },
  {
    meaning: "prior_employment",
    // Needs an explicit reference to this employer ("us", "this company", "our organization", the
    // employer's name — added at run time) or "former employee"; see priorEmploymentRe().
    re: /$^/,
    employerScoped: true,
  },
  { meaning: "referral", re: /\breferr(ed|al)\b|\bwho referred\b|employee referral/, employerScoped: true },
  // eligibility
  { meaning: "citizenship", re: /\b(citizen(ship)?|citizenship status)\b/, not: /\b(eligible|authori[sz]ed|permitted|entitled|right) to work\b/, sensitivity: "sensitive" },
  { meaning: "sponsorship_future", re: /\bsponsor/, not: /\bnot\b.*\brequire\b.*\bnow\b/, sensitivity: "sensitive" },
  { meaning: "work_authorization", re: /\b(legally )?(authori[sz]ed|eligible|entitled|permitted|right) to work\b|work (authori[sz]ation|permit)|work eligib/, sensitivity: "sensitive" },
  { meaning: "age_18", re: /\b(18|eighteen|legal (working )?age|age of majority)\b.*\b(years|older|age)|\bat least 18\b|\bover 18\b/ },
  // student / co-op — not interchangeable
  { meaning: "coop_term_required", re: /\b(part of|requirement of|required (for|by)|for credit).*\b(co ?op|work term|placement|internship)|\b(co ?op|work term|placement)\b.*\b(academic )?requirement/ },
  { meaning: "internship_mandatory", re: /\b(internship|placement)\b.*\b(mandatory|required|compulsory)\b.*\b(degree|program)/ },
  { meaning: "coop_program", re: /\b(enrolled|registered|participat\w*) in (a|an|the)? ?(accredited )?(co ?op|cooperative education|work integrated learning)|\bco ?op (student|program)\b/ },
  { meaning: "placement_duration", re: /\b(4|four|8|eight|12|twelve|16|sixteen) ?(months?|month) (placement|work term|term|co ?op|internship)|\bwork term (length|duration)|available for (a|an) \w+ month/ },
  { meaning: "return_to_school", re: /\breturn(ing)? to (school|studies|university|college)|\bfull ?time studies after/ },
  { meaning: "full_time_student", re: /\bfull ?time (student|studies)|\bpart ?time (student|studies)/ },
  { meaning: "graduation_date", re: /\b(expected |anticipated )?graduation (date|year)|\bwhen (will|do) you graduate|\bexpected to graduate/ },
  { meaning: "enrolled_student", re: /\b(currently )?(enrolled|registered|attending|a student)\b.*\b(school|university|college|post ?secondary|program|studies|degree)|\bare you (currently )?a student\b/, not: /co ?op|cooperative education/ },
  // logistics
  { meaning: "relocation", re: /\brelocat/ },
  { meaning: "travel", re: /\btravel\b/ },
  { meaning: "shift_work", re: /\b(shift|evenings?|weekends?|overnight|on ?call|rotating)\b/ },
  { meaning: "schedule", re: /\b(schedule|hours per week|full ?time or part ?time|availability)\b/ },
  { meaning: "work_arrangement", re: /\b(remote|hybrid|on ?site|in office|in the office)\b/ },
  { meaning: "start_date", re: /\b(start date|available to start|when can you start|earliest (available )?(start|date)|date available)\b/ },
  { meaning: "notice_period", re: /\bnotice period|weeks notice/ },
  { meaning: "hourly_rate", re: /\bhourly (rate|wage|pay)\b/ },
  { meaning: "salary", re: /\b(salary|compensation|pay expectation|expected pay|desired pay)\b/ },
  // qualifications
  { meaning: "professional_licence", re: /\b(professional )?licen[cs]e\b/, not: /driver/ },
  { meaning: "certification", re: /\bcertifi(ed|cation)\b/ },
  { meaning: "language", re: /\b(speak|fluen|proficien|bilingual|language)\b/ },
  { meaning: "references", re: /\breferences?\b/, not: /referr/ },
  { meaning: "source", re: /\bhow did you (hear|find|learn)|\bwhere did you (hear|find|learn|see)|\bsource\b/ },
  { meaning: "contact_method", re: /\bpreferred contact type\b|\bpreferred (method of |means of |way of |mode of )?(contact|communication)\b|\bcontact (method|preference)\b|\b(method|way|means) (of|to) (contact|reach)\b|\bhow (would|should|do) (you (like|prefer) (us to|us|to be)|we) (contact|reach)/ },
  { meaning: "motivation", re: /\bwhy (do you|are you)|cover letter|tell us|describe|what interests/ },
];

const COUNTRY_WORDS: [RegExp, string][] = [
  [/\bcanad(a|ian)\b/, "canada"],
  [/\b(united states|usa|u s|u s a|american)\b/, "united states"],
  [/\b(united kingdom|uk|britain|british)\b/, "united kingdom"],
  [/\b(china|chinese)\b/, "china"],
  [/\b(india|indian)\b/, "india"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Have you worked for us / this company / <employer> before?" and equivalent wordings. */
function priorEmploymentRe(employer: string | null): RegExp {
  const name = employer ? norm(employer).replace(/\b(inc|ltd|llc|corp|corporation|limited|group|company|co)\b/g, "").trim() : "";
  const who = name ? `(${us.slice(1, -1)}|${escapeRe(name)}( \\w+)?)` : us;
  return new RegExp(
    `\\b(worked|been employed|been an employee|employment)\\b.*\\b(for|by|at|with) ${who}\\b|\\bformer (employee|staff member)\\b|\\b(worked|been employed) (here|with us) before\\b|\\bprevious worker\\b`,
  );
}
const PRIOR_EMPLOYMENT_NOT = /\b(with (our|any of our|one of our) (employees|staff|team|clients|customers)|clients?\b|customers?\b|provided services|vendor|supplier|on behalf of|similar (role|position)|in this (role|position|field|industry)|contractor|consultant|affiliate|subsidiar|applied|interview)/;

export function questionMeaning(label: string, employer: string | null = null): QuestionMeaning {
  const l = norm(label);
  const country = COUNTRY_WORDS.find(([re]) => re.test(l))?.[1] ?? null;
  for (const r of RULES) {
    const re = r.meaning === "prior_employment" ? priorEmploymentRe(employer) : r.re;
    const not = r.meaning === "prior_employment" ? PRIOR_EMPLOYMENT_NOT : r.not;
    if (!re.test(l) || (not && not.test(l))) continue;
    let meaning = r.meaning;
    // "now or in the future" sponsorship: the future part decides
    if (meaning === "sponsorship_future" && !/\bfuture\b/.test(l) && /\b(now|currently|at this time|immediately)\b/.test(l)) meaning = "sponsorship_now";
    return {
      meaning,
      sensitivity: r.sensitivity ?? "normal",
      reusable: r.reusable ?? true,
      approval: r.approval ?? false,
      employerScoped: r.employerScoped ?? false,
      country,
    };
  }
  return { meaning: "unknown", sensitivity: "normal", reusable: false, approval: false, employerScoped: false, country };
}

/** yes / no from an option label or answer ("Yes, I am" → yes); null when it is neither. */
export function yesNoOf(answer: unknown): "yes" | "no" | null {
  if (answer === true) return "yes";
  if (answer === false) return "no";
  if (typeof answer !== "string") return null;
  const cs = conceptsOf("yes_no", answer);
  if (cs.length === 1) return cs[0] as "yes" | "no";
  return leadingYesNo(answer);
}
