// Rule-based extraction from plain job-description text. Works without AI.
// Every candidate carries the exact sentence it came from as evidence; when the
// text is ambiguous the value stays unknown or is marked low confidence.

import type { EmploymentType, SalaryPeriod, WorkMode } from "@shared/constants";
import { cand, type CandidateSet } from "./jsonld";

const S = "heuristic" as const;

export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+(?=[A-Z0-9一-鿿(])/))
    .map((s) => s.replace(/^[•\-*·▪◦]\s*/, "").trim())
    .filter((s) => s.length > 2);
}

// ---------------------------------------------------------------- sections

const SECTION_PATTERNS: { key: "responsibilities" | "required_qualifications" | "preferred_qualifications" | "benefits"; re: RegExp }[] = [
  {
    key: "preferred_qualifications",
    re: /^(nice[- ]to[- ]haves?|preferred( qualifications| skills| experience)?|bonus( points)?|pluses|it'?s a plus|good to have|desired (skills|qualifications)|assets?|even better|you might also have|ideally,? you('ll| will)? have|what would make you stand out|加分项|优先条件|优先考虑)(?![a-z])/i,
  },
  {
    key: "required_qualifications",
    re: /^(requirements|qualifications|minimum qualifications|basic qualifications|required (skills|qualifications|experience)|what you('ll| will)? (need|bring)|what you (should|must) have|what we('re| are) looking for|what we need|who you are|about you|you have|you (should|must|will) have|must[- ]haves?|skills( and| &) experience|your (profile|background|experience|skills)|is this you\??|任职要求|岗位要求|任职资格|职位要求)(?![a-z])/i,
  },
  {
    key: "responsibilities",
    re: /^(responsibilities|key responsibilities|what you('ll| will) (be )?(do|doing)|what you will be doing|your role|the role|in this role,? you('ll| will)?|duties|your (impact|mission|day[- ]to[- ]day)|day[- ]to[- ]day|what the job involves|岗位职责|工作职责|工作内容|职位描述)(?![a-z])/i,
  },
  {
    key: "benefits",
    re: /^(benefits|perks|what we offer|why join( us)?|compensation (and|&) benefits|our benefits|perks (and|&) benefits|福利|福利待遇)(?![a-z])/i,
  },
];

const cleanHeading = (l: string) => l.replace(/[’‘]/g, "'").replace(/[:：]$/, "").trim();

function isHeading(line: string): boolean {
  const l = line.trim();
  if (!l || l.length > 80) return false;
  if (l.startsWith("•")) return false;
  return /[:：]$/.test(l) || SECTION_PATTERNS.some((p) => p.re.test(cleanHeading(l))) || (/^[A-Z][A-Za-z'’ &/-]{2,60}$/.test(l) && !/[.,;]$/.test(l));
}

export function extractSections(text: string): CandidateSet {
  const out: CandidateSet = {};
  const lines = text.split("\n").map((l) => l.trim());
  let current: (typeof SECTION_PATTERNS)[number]["key"] | null = null;
  let heading = "";
  let sawBullet = false;
  const buckets: Record<string, { heading: string; items: string[] }> = {};
  for (const line of lines) {
    if (!line) continue;
    if (isHeading(line)) {
      const clean = cleanHeading(line);
      const match = SECTION_PATTERNS.find((p) => p.re.test(clean));
      current = match ? match.key : null;
      heading = clean;
      sawBullet = false;
      continue;
    }
    if (!current) continue;
    const isBullet = /^([•\-*·▪◦]|\d+[.)])\s*/.test(line);
    // A plain paragraph after a bullet list ends the section.
    if (sawBullet && !isBullet) {
      current = null;
      continue;
    }
    if (isBullet) sawBullet = true;
    const item = line.replace(/^[•\-*·▪◦]\s*|^\d+[.)]\s+/, "").trim();
    if (item.length < 3) continue;
    const b = (buckets[current] ??= { heading, items: [] });
    if (b.items.length < 40) b.items.push(item.slice(0, 600));
  }
  for (const [key, b] of Object.entries(buckets)) {
    if (!b.items.length) continue;
    out[key as keyof CandidateSet] = cand(b.items, S, `${b.heading}: ${b.items[0]}`, "medium");
  }
  return out;
}

// ---------------------------------------------------------------- work mode

export function extractWorkMode(sentences: string[]): CandidateSet {
  const hits: { mode: WorkMode; s: string }[] = [];
  for (const s of sentences) {
    const l = s.toLowerCase();
    if (/\bhybrid\b|混合办公/.test(l)) hits.push({ mode: "hybrid", s });
    else if (/\b(fully remote|100% remote|remote[- ]first|remote position|remote role|work from (home|anywhere)|this (role|position) is remote|remote opportunity|remote\s*[-–(,]\s*(canada|us|usa|united states|uk|europe|emea|anywhere))\b|远程办公|远程工作/.test(l) || /^remote\b/.test(l))
      hits.push({ mode: "remote", s });
    else if (/\b(on-?site|in[- ]office|in the office (full[- ]time|5 days)|office[- ]based|must work from (our|the) office)\b|现场办公|坐班/.test(l)) hits.push({ mode: "onsite", s });
  }
  const out: CandidateSet = {};
  if (!hits.length) return out;
  const modes = new Set(hits.map((h) => h.mode));
  // "Hybrid" wins over a generic "office"/"remote" mention when explicitly stated.
  const chosen = modes.has("hybrid") ? hits.find((h) => h.mode === "hybrid")! : hits[0];
  out.work_mode = cand(chosen.mode, S, chosen.s, modes.size === 1 ? "medium" : "low");

  for (const s of sentences) {
    const m = s.match(/\b(one|two|three|four|1|2|3|4)(?:\s*(?:-|to)\s*(?:two|three|four|five|2|3|4|5))?\s+days?\s+(?:a|per|each|every)\s+week\b/i) ?? s.match(/每周\s*\d\s*天/);
    if (m && /office|on-?site|in[- ]person|办公室|到岗/i.test(s)) {
      out.hybrid_frequency = cand(m[0], S, s, "medium");
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- employment type

const EMPLOYMENT_PATTERNS: [EmploymentType, RegExp][] = [
  ["internship", /\b(internship|intern\b|summer student)|实习/i],
  ["co_op", /\bco-?op\b/i],
  ["part_time", /\bpart[- ]time\b|兼职/i],
  ["contract", /\b(contract(or)?|fixed[- ]term|temporary contract|\d+[- ]month contract)\b|合同工/i],
  ["temporary", /\b(temporary|seasonal)\b/i],
  ["freelance", /\bfreelance\b/i],
  ["full_time", /\b(full[- ]time|permanent)\b|全职/i],
];

export function extractEmploymentType(sentences: string[]): CandidateSet {
  const found = new Map<EmploymentType, string>();
  for (const s of sentences) {
    for (const [type, re] of EMPLOYMENT_PATTERNS) if (re.test(s) && !found.has(type)) found.set(type, s);
  }
  if (!found.size) return {};
  const [type, s] = [...found.entries()][0];
  return { employment_type: cand(type, S, s, found.size === 1 ? "medium" : "low") };
}

// ---------------------------------------------------------------- salary

const CURRENCY_CODES = ["CAD", "USD", "EUR", "GBP", "AUD", "NZD", "CHF", "SGD", "HKD", "CNY", "RMB", "JPY", "INR", "SEK", "NOK", "DKK", "PLN", "MXN", "BRL"];
const SYMBOL_TO_CODE: Record<string, string | null> = { "C$": "CAD", CA$: "CAD", "US$": "USD", "A$": "AUD", "€": "EUR", "£": "GBP", "¥": null, "$": null, "￥": "CNY" };
const MONEY = String.raw`(?:(C\$|CA\$|US\$|A\$|€|£|¥|￥|\$)\s?)?(\d{1,3}(?:[,\s.]\d{3})+|\d+(?:\.\d+)?)\s?([kK]|万)?`;
const RANGE_RE = new RegExp(`${MONEY}\\s*(?:-|–|—|to|~|至)\\s*${MONEY}`);
const SINGLE_RE = new RegExp(`(?:(C\\$|CA\\$|US\\$|A\\$|€|£|￥|\\$)\\s?)(\\d{1,3}(?:[,\\s.]\\d{3})+|\\d+(?:\\.\\d+)?)\\s?([kK])?`);
const SALARY_CONTEXT = /salary|compensation|pay (range|band|rate|scale)|base pay|wage|hourly rate|per hour|\/\s?(hr|hour|year|yr|annum)|annually|per (year|annum)|薪资|薪酬|月薪|年薪|时薪|工资/i;

function parseAmount(raw: string, suffix?: string): number | null {
  let s = raw.replace(/\s/g, "");
  // "120.000" (European thousands) vs "12.5"
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  s = s.replace(/,/g, "");
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (suffix === "k" || suffix === "K") n *= 1000;
  if (suffix === "万") n *= 10000;
  return n;
}

function detectPeriod(s: string): SalaryPeriod {
  const l = s.toLowerCase();
  if (/per hour|\/\s?h(ou)?r\b|hourly|an hour|时薪|每小时/.test(l)) return "hourly";
  if (/per day|\/\s?day|daily rate|日薪/.test(l)) return "daily";
  if (/per week|\/\s?week|weekly/.test(l)) return "weekly";
  if (/per month|\/\s?month|monthly|月薪|每月/.test(l)) return "monthly";
  if (/per year|\/\s?y(ea)?r\b|annual|annually|per annum|a year|yearly|年薪|每年/.test(l)) return "annually";
  return "unknown";
}

function detectCurrency(s: string, symbol?: string): string | null {
  const code = CURRENCY_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(s));
  if (code) return code === "RMB" ? "CNY" : code;
  if (symbol && symbol in SYMBOL_TO_CODE) return SYMBOL_TO_CODE[symbol];
  return null; // "$" alone is ambiguous (CAD, USD, AUD, ...) — leave for review.
}

export function extractSalary(sentences: string[]): CandidateSet {
  for (const s of sentences) {
    if (!SALARY_CONTEXT.test(s)) continue;
    const r = s.match(RANGE_RE);
    if (r) {
      const min = parseAmount(r[2], r[3] ?? r[6]);
      const max = parseAmount(r[5], r[6]);
      const symbol = r[1] ?? r[4];
      if (min == null || max == null || max < min || (!symbol && !CURRENCY_CODES.some((c) => s.includes(c)) && min < 1000 && !/hour|hr|时薪/i.test(s))) continue;
      const currency = detectCurrency(s, symbol);
      const period = detectPeriod(s);
      return {
        salary: cand(
          { min, max, currency, period, source: "employer", text: s.slice(0, 300), compensation_type: null },
          S,
          s,
          currency && period !== "unknown" ? "medium" : "low",
        ),
      };
    }
    const one = s.match(SINGLE_RE);
    if (one) {
      const amount = parseAmount(one[2], one[3]);
      if (amount == null || amount < 10) continue;
      const currency = detectCurrency(s, one[1]);
      const period = detectPeriod(s);
      return {
        salary: cand(
          { min: amount, max: null, currency, period, source: "employer", text: s.slice(0, 300), compensation_type: null },
          S,
          s,
          "low",
        ),
      };
    }
  }
  return {};
}

// ---------------------------------------------------------------- requirements & restrictions

function firstMatch(sentences: string[], re: RegExp): string | null {
  return sentences.find((s) => re.test(s)) ?? null;
}
function allMatches(sentences: string[], re: RegExp, max = 6): string[] {
  return sentences.filter((s) => re.test(s)).slice(0, max);
}

export function extractRequirements(sentences: string[]): CandidateSet {
  const out: CandidateSet = {};
  for (const s of sentences) {
    const m =
      s.match(/(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?(?:years?|yrs?)(?:'|’)?\s+(?:of\s+)?(?:[\w/&,-]+\s+){0,6}?(?:experience|exp\b)/i) ??
      s.match(/(?:minimum|at least)\s+(?:of\s+)?(\d{1,2})\s+(?:years?|yrs?)/i) ??
      s.match(/(\d{1,2})\s*年(?:以上)?(?:[一-鿿]{0,8})经验/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 30) {
        out.years_experience_min = cand(n, S, s, "medium");
        out.years_experience_text = cand(s.slice(0, 300), S, s, "medium");
        break;
      }
    }
  }
  const edu = allMatches(sentences, /\b(bachelor'?s?|master'?s?|ph\.?d|doctorate|degree in|university degree|college diploma|diploma in|B\.?Sc|M\.?Sc|MBA)\b|本科|硕士|博士|学历|大专/i, 4);
  if (edu.length) out.education_requirements = cand(edu, S, edu[0], "medium");

  const lang = allMatches(
    sentences,
    /\b(fluent|fluency|proficien\w*|bilingual|native|working knowledge)\b[^.]{0,60}\b(english|french|spanish|german|mandarin|chinese|cantonese|japanese|korean|portuguese|italian|dutch|hindi|arabic)\b|\b(english|french|mandarin|chinese|spanish|german)\b[^.]{0,30}\b(required|is a must|an asset|preferred)\b|(英语|普通话|粤语|法语|日语).{0,10}(流利|熟练|要求)/i,
    4,
  );
  if (lang.length) out.language_requirements = cand(lang, S, lang[0], "medium");

  const certs = allMatches(sentences, /\b(certification|certified|certificate|licen[cs]e[d]? (as|in)|CPA|PMP|CFA|AWS Certified|CISSP|P\.?Eng)\b/i, 4);
  if (certs.length) out.certifications = cand(certs, S, certs[0], "low");

  const travel = firstMatch(sentences, /\b(travel(ing|ling)? (up to|of|requirements?|required)|\d{1,3}\s?% travel|willing(ness)? to travel|required to travel)\b|出差/i);
  if (travel) out.travel_requirement = cand(travel, S, travel, "medium");
  const reloc = firstMatch(sentences, /\brelocat(e|ion)\b|搬迁/i);
  if (reloc) out.relocation_requirement = cand(reloc, S, reloc, "medium");
  return out;
}

const REGION_NAMES =
  "Canada|United States|USA|U\\.S\\.|US|North America|Europe|EU|EMEA|UK|United Kingdom|LATAM|Latin America|APAC|Asia|Australia|Germany|France|Ireland|Netherlands|Spain|Portugal|Poland|India|Mexico|Brazil|Ontario|Quebec|British Columbia|Alberta|California|New York|Texas|Washington|Massachusetts|the Americas|worldwide|anywhere";
const REMOTE_REGION_RE = new RegExp(
  `\\bremote\\b[^.]{0,40}?\\b(?:within|in|across|from|based in|located in)\\s+(?:the\\s+)?(${REGION_NAMES})\\b|\\b(${REGION_NAMES})\\b[^.]{0,10}\\(?\\s*remote\\s*\\)?|\\bremote\\s*[-–(,:]\\s*(${REGION_NAMES})\\b|\\bopen to (?:candidates|applicants) (?:based |located )?(?:in|across|from)\\s+(?:the\\s+)?(${REGION_NAMES})\\b`,
  "i",
);

export function extractEligibility(sentences: string[]): CandidateSet {
  const out: CandidateSet = {};
  const auth = firstMatch(
    sentences.filter((x) => !/equal (employment )?opportunit|regardless of|without regard/i.test(x)),
    /\b(legally (authori[sz]ed|entitled|eligible) to work|authori[sz](ed|ation) to work|work authori[sz]ation|eligib(le|ility) to work|right to work|valid work permit|work permit)\b|工作签证|工作许可|合法工作|工作身份|工作权/i,
  );
  if (auth) out.work_authorization = cand(auth, S, auth, "medium");

  // Only immigration sponsorship counts ("gain executive sponsorship" is not a visa statement).
  const visa = sentences.find((x) => /\bvisas?\b|immigration|work permits?|\bH-?1B\b|green card|employment authori[sz]ation|签证/i.test(x) || /sponsor(ship)?\b[^.]{0,40}\b(to work|work authori[sz]ation|employment visa|right to work)/i.test(x)) ?? null;
  if (visa) {
    const l = visa.toLowerCase();
    const negative =
      /(not|unable to|cannot|can't|won't|will not|do not|does not|don't|no longer|isn't|is not)\s+(be\s+)?(able to\s+)?(offer(ing)?|provide|providing|support|supporting|sponsor|sponsoring|available)|no (visa )?sponsorship|without (the need for )?(current or future )?(visa )?sponsorship|sponsorship (is )?not (available|offered|provided)|不提供.{0,6}(签证|担保)/.test(
        l,
      );
    const positive =
      /(visa )?sponsorship (is )?(available|offered|provided|possible)|(we|company) (will|can|do|does) (offer |provide )?(visa )?sponsor|offer(s)? (visa )?sponsorship|eligible for (visa )?sponsorship|提供.{0,6}(签证|担保)/.test(l);
    // Negation wraps the positive phrase ("unable to offer visa sponsorship"), so it wins.
    if (/sponsor|签证|担保/.test(l) && (negative || positive)) {
      out.visa_sponsorship = cand(negative ? "not_available" : "available", S, visa, "medium");
    }
    if (/sponsor|签证|担保/.test(l)) out.visa_sponsorship_text = cand(visa, S, visa, "medium");
  }
  // Equal-opportunity boilerplate lists protected characteristics (incl. citizenship) — never a requirement.
  const notBoilerplate = sentences.filter((x) => !/equal (employment )?opportunit|without regard|regardless of|discriminat|protected (veteran|characteristic|class)|E-?Verify/i.test(x));
  const cit = firstMatch(notBoilerplate, /\b(citizen(ship)?|permanent resident|green card holder|PR status|nationality)\b|公民|永久居民/i);
  if (cit) out.citizenship_restriction = cand(cit, S, cit, "medium");
  const residency = firstMatch(notBoilerplate, /\b(must (currently )?(reside|live|be (located|based)) in|residen(t|cy) (of|in)|candidates (must be|located) in)\b/i);
  if (residency) out.residency_restriction = cand(residency, S, residency, "medium");
  const clearance = firstMatch(sentences, /\b(security clearance|secret clearance|top secret|reliability status|enhanced reliability|baseline personnel security|NV1|SC clearance|DV clearance|public trust)\b/i);
  if (clearance) out.security_clearance = cand(clearance, S, clearance, "medium");

  for (const s of sentences) {
    const m = s.match(REMOTE_REGION_RE);
    if (m) {
      const region = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\.$/, "");
      if (!/^(anywhere|worldwide)$/i.test(region)) {
        out.remote_eligible_regions = cand([region], S, s, "medium");
        out.location_restriction = cand(s, S, s, "low");
      }
      break;
    }
  }
  return out;
}

function parseLooseDate(s: string): number | null {
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 23, 59);
  const long = s.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (long) {
    const t = Date.parse(`${long[1]} ${long[2]} ${long[3]} 23:59 UTC`);
    return Number.isFinite(t) ? t : null;
  }
  const cn = s.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (cn) return Date.UTC(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3]), 23, 59);
  return null;
}

export function extractDeadline(sentences: string[]): CandidateSet {
  for (const s of sentences) {
    if (!/\b(apply by|applications? (close|closing|due|deadline)|closing date|deadline|posting closes|accepting applications until|截止)/i.test(s)) continue;
    const t = parseLooseDate(s);
    if (t) return { deadline_at: cand(t, S, s, "medium") };
  }
  return {};
}

export function extractTitleGuess(text: string): CandidateSet {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 3 && l.length < 120);
  return first ? { title: cand(first, S, first, "low") } : {};
}

/** Runs all heuristics over a job description. */
export function heuristicExtract(text: string): CandidateSet {
  const sentences = splitSentences(text.slice(0, 60_000));
  return {
    ...extractSections(text),
    ...extractWorkMode(sentences),
    ...extractEmploymentType(sentences),
    ...extractSalary(sentences),
    ...extractRequirements(sentences),
    ...extractEligibility(sentences),
    ...extractDeadline(sentences),
  };
}
