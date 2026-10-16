// The answer engine: open application questions ("Describe a data project you worked on", "Why this
// role?") answered from the applicant's VERIFIED background and the job, then checked before use.
//
//   QUESTION → INTENT (topic, limits, answerable?) → EVIDENCE (only what this question needs) →
//   ANSWER (the signed-in AI provider writes; every sentence cites evidence) → CHECK (numbers, tools,
//   names and organisations must appear in the cited evidence or the job; limits) → FILL → VERIFY.
//
// Privacy: this is the one place applicant facts go to the AI provider, and only when the owner turned
// on "AI answer writing" (Application Defaults). It sends the entries a question needs — work, project,
// education entries and skills — never contact details, identity, eligibility, documents or credentials.
// The browser-navigation agent (browser-agent.ts) still never sees applicant values.
import type { Profile } from "@shared/profile";

export interface Evidence {
  id: string;
  kind: "experience" | "project" | "education" | "skills" | "summary";
  text: string;
}

export interface AnswerLimits {
  words?: number;
  chars?: number;
  paragraphs?: [number, number];
}

export type Topic = "project" | "experience" | "technical" | "problem" | "influence" | "motivation_role" | "motivation_company" | "strengths" | "general";

export interface OpenQuestion {
  label: string;
  topic: Topic;
  limits: AnswerLimits;
  /** False when the question asks for a personal fact or decision no evidence can supply. */
  writable: boolean;
}

export interface JobContext {
  title: string | null;
  employer: string | null;
  description: string | null;
}

export interface Draft {
  text: string;
  evidence: string[];
  /** Problems the check found and could not remove (shown at review); empty = fully supported. */
  flags: string[];
  language: "en" | "zh";
}

export type Writer = (system: string, user: string, schema: Record<string, unknown>) => Promise<Record<string, unknown>>;

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const num = (s: string) => WORD_NUM[s.toLowerCase()] ?? Number(s);

/** Length limits stated in the question (and the field's own character limit). */
export function answerLimits(label: string, maxLength?: number | null): AnswerLimits {
  const l = label.toLowerCase();
  const out: AnswerLimits = {};
  const w = l.match(/(\d{2,4})\s*words?\s*(or less|or fewer|max(imum)?|limit|at most)/) ?? l.match(/(?:max(?:imum)?|up to|no more than|under|less than|within|at most|limit of)\s*(\d{2,4})\s*words?/) ?? l.match(/\(\s*(\d{2,4})\s*words?\s*\)/);
  if (w) out.words = Number(w[1]);
  const c = l.match(/(\d{2,5})\s*characters?\s*(or less|or fewer|max(imum)?|limit)/) ?? l.match(/(?:max(?:imum)?|up to|no more than|under|less than|within|limit of)\s*(\d{2,5})\s*characters?/);
  const chars = [c ? Number(c[1]) : undefined, maxLength && maxLength > 0 ? maxLength : undefined].filter((x): x is number => !!x);
  if (chars.length) out.chars = Math.min(...chars);
  const p = l.match(/(\d|one|two|three)\s*(?:-|–|to|or)\s*(\d|one|two|three|four|five)\s*paragraphs?/) ?? l.match(/(\d|one|two|three)\s*paragraphs?/);
  if (p) out.paragraphs = p[2] ? [num(p[1]), num(p[2])] : [1, num(p[1])];
  return out;
}

/**
 * What the question is about — and whether it can be answered from a background at all. Personal facts and
 * decisions (deadlines, salary, availability, visas, relocation, other offers) are never written by AI.
 */
export function openQuestion(label: string, maxLength?: number | null): OpenQuestion {
  const l = label.toLowerCase();
  const personal = /deadline|offer\b|other (offers|interviews|applications|processes)|salary|compensation|pay (expectation|range)|availability|available to start|start date|notice period|relocat|visa|sponsor|authori[sz]ed to work|citizenship|criminal|disabilit|gender|pronoun|ethnic|veteran|referr(ed|al)|how did you hear|age\b|date of birth|address|phone|e-?mail/.test(l);
  const topic: Topic = /\bproject\b/.test(l)
    ? "project"
    : /\b(influenc|persuad|convinc|decision)/.test(l)
      ? "influence"
      : /\b(problem|challeng|difficult|obstacle)/.test(l)
        ? "problem"
        : /\b(sql|python|\br\b|statistic|model(l)?ing|machine learning|technical|tools?|technolog|programming)/.test(l)
          ? "technical"
          : /why (do you want to|would you like to|are you interested in) (work|join)|why (this|our) (company|team|organi[sz]ation)|why \w+\??$/.test(l) && /(company|team|organi[sz]ation|us\b|join)/.test(l)
            ? "motivation_company"
            : /why (are you|do you)|interest(ed|s)? (you )?in (this|the) (role|position|job)|motivat/.test(l)
              ? "motivation_role"
              : /strong candidate|why should we|what makes you|strengths?|stand out|good fit|qualif/.test(l)
                ? "strengths"
                : /experience|background|tell us about (yourself|your)|describe (your|a time)/.test(l)
                  ? "experience"
                  : "general";
  return { label, topic, limits: answerLimits(label, maxLength), writable: !personal };
}

/** Only the entries this question needs (never contact, identity, eligibility or documents). */
export function selectEvidence(topic: Topic, p: Profile): Evidence[] {
  const out: Evidence[] = [];
  const range = (a?: string | null, b?: string | null, current?: boolean) => [a ?? "", current ? "present" : (b ?? "")].filter(Boolean).join("–");
  p.experience.forEach((e, i) => {
    const text = [`${e.title}${e.organization ? ` at ${e.organization}` : ""}`, range(e.start, e.end, e.current), e.description].filter(Boolean).join(". ");
    if (text.trim()) out.push({ id: `exp${i + 1}`, kind: "experience", text: text.slice(0, 1200) });
  });
  p.projects.forEach((x, i) => out.push({ id: `proj${i + 1}`, kind: "project", text: [x.name, x.description, x.skills.length ? `Tools: ${x.skills.join(", ")}` : ""].filter(Boolean).join(". ").slice(0, 1500) }));
  if (topic !== "project" && topic !== "technical") {
    p.education.forEach((e, i) => out.push({ id: `edu${i + 1}`, kind: "education", text: [`${e.level}${e.field ? ` in ${e.field}` : ""}`, e.institution, e.completed === false ? `in progress${e.end ? `, expected ${e.end}` : ""}` : e.year ? `completed ${e.year}` : ""].filter(Boolean).join(", ") }));
  }
  if (p.skills.length) out.push({ id: "skills", kind: "skills", text: `Skills: ${p.skills.join(", ")}` });
  if (p.experience_summary.length) out.push({ id: "summary", kind: "summary", text: p.experience_summary.map((s) => `${s.years} years of ${s.area}`).join("; ") });
  return out;
}

export const ANSWER_SYSTEM = `You write one answer to a job-application question for the applicant, in the first person.
Use ONLY the evidence given (the applicant's verified records) and the job description. Never invent employers, responsibilities, projects, results, numbers, percentages, revenue, tools, degrees, qualifications or dates. If a detail is not in the evidence, leave it out — a shorter true answer is better than a richer invented one.
Prefer one specific, relevant real example over general enthusiasm. Connect it to the job's actual requirements when the evidence supports it.
Respect the limits exactly (words, characters, paragraphs). Write in the requested language. Plain text, paragraphs separated by a blank line, no headings, no lists, no placeholders.
Return every sentence with the ids of the evidence that supports it ("job" for statements about the job or employer).
If the question asks for a personal fact or decision the evidence cannot supply (a deadline, salary, availability, visa status, another offer…), set answerable to false and leave answer empty.`;

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answerable: { type: "boolean" },
    reason: { type: "string" },
    sentences: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidence: { type: "array", items: { type: "string" } } }, required: ["text", "evidence"], additionalProperties: false } },
    paragraph_breaks: { type: "array", items: { type: "integer" }, description: "Indexes of sentences that start a new paragraph (after the first)." },
  },
  required: ["answerable", "reason", "sentences", "paragraph_breaks"],
  additionalProperties: false,
};

// Tools and technologies a draft may name only when the evidence names them.
const TOOLS = ["sql", "python", "r", "sas", "spss", "stata", "excel", "vba", "tableau", "power bi", "looker", "qlik", "spark", "pyspark", "hadoop", "hive", "aws", "azure", "gcp", "bigquery", "snowflake", "redshift", "dbt", "airflow", "kafka", "pandas", "numpy", "scikit-learn", "tensorflow", "pytorch", "keras", "matlab", "java", "javascript", "typescript", "c\\+\\+", "c#", "go", "rust", "docker", "kubernetes", "git", "jira", "salesforce", "sap", "oracle", "mysql", "postgresql", "mongodb", "google analytics", "a/b test(ing)?", "regression", "machine learning", "deep learning", "nlp", "llm"];
const STOP = new Set(["i", "i'm", "i've", "i'd", "my", "the", "a", "an", "in", "at", "this", "that", "these", "those", "it", "we", "our", "as", "for", "with", "during", "while", "when", "after", "before", "by", "to", "and", "but", "so", "then", "also", "there", "here", "what", "which", "one", "first", "second", "finally", "together", "through", "using", "working", "because", "since", "although", "overall", "today", "previously", "currently", "later", "english", "chinese", "french", "canadian", "canada", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "spring", "summer", "fall", "autumn", "winter"]);

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Every claim must be supported: numbers and named tools in the cited evidence (or the job / question),
 * proper names in the evidence, the job or the question; every sentence cites evidence. Returns problems.
 */
export function checkDraft(sentences: { text: string; evidence: string[] }[], evidence: Evidence[], job: JobContext, question: string): { sentence: number; problem: string }[] {
  const byId = new Map(evidence.map((e) => [e.id, e.text]));
  const jobText = `${job.title ?? ""} ${job.employer ?? ""} ${job.description ?? ""}`;
  const all = `${evidence.map((e) => e.text).join(" ")} ${jobText} ${question}`.toLowerCase();
  const out: { sentence: number; problem: string }[] = [];
  sentences.forEach((s, i) => {
    const cited = s.evidence.filter((id) => id === "job" || byId.has(id));
    if (!cited.length) out.push({ sentence: i, problem: `no evidence cited: "${s.text.slice(0, 60)}"` });
    const support = `${cited.map((id) => (id === "job" ? jobText : byId.get(id))).join(" ")} ${question}`.toLowerCase();
    // Numbers: the same number in the cited evidence (as a whole number, not inside "2025"); a percentage or
    // an amount must appear as such.
    const plain = support.replace(/(\d),(\d)/g, "$1$2");
    for (const m of s.text.matchAll(/(\$)?(\d[\d,]*(?:\.\d+)?)\s*(%|percent\b|k\b|million\b|billion\b)?/gi)) {
      const bare = m[2].replace(/,/g, "");
      const esc = bare.replace(".", "\\.");
      const unit = m[3] ? (/%|percent/i.test(m[3]) ? "\\s*(%|percent)" : `\\s*${m[3].toLowerCase()}`) : "";
      const re = new RegExp(`(^|[^\\d.])${m[1] ? "\\$\\s*" : ""}${esc}${unit}(?![\\d])`, "i");
      if (!re.test(plain)) out.push({ sentence: i, problem: `number "${m[0].trim()}" not in the cited evidence` });
    }
    for (const tool of TOOLS) {
      const re = new RegExp(`(^|[^a-z0-9+#])${tool}([^a-z0-9+#]|$)`, "i");
      if (re.test(s.text) && !re.test(support)) out.push({ sentence: i, problem: `"${s.text.match(re)![0].trim()}" is not in the cited evidence` });
    }
    // Proper names (capitalised words after the first word): must exist somewhere in the evidence, job or question.
    const tokens = s.text.replace(/[“”"'’(),.;:!?]/g, " ").split(/\s+/).filter(Boolean);
    tokens.forEach((t, k) => {
      if (k === 0 || !/^[A-Z][A-Za-z&.-]{1,}$/.test(t) || STOP.has(t.toLowerCase())) return;
      if (!all.includes(t.toLowerCase())) out.push({ sentence: i, problem: `"${t}" does not appear in the evidence or the job` });
    });
  });
  return out;
}

export function fitsLimits(text: string, l: AnswerLimits): string | null {
  if (l.words && words(text) > l.words) return `${words(text)} words (limit ${l.words})`;
  if (l.chars && text.length > l.chars) return `${text.length} characters (limit ${l.chars})`;
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  if (l.paragraphs && (paras < l.paragraphs[0] || paras > l.paragraphs[1])) return `${paras} paragraphs (asked ${l.paragraphs[0]}–${l.paragraphs[1]})`;
  return null;
}

const assemble = (sentences: { text: string }[], breaks: number[]) =>
  sentences
    .map((s, i) => (i > 0 && breaks.includes(i) ? `\n\n${s.text.trim()}` : `${i ? " " : ""}${s.text.trim()}`))
    .join("")
    .trim();

/**
 * Writes, checks and (once) repairs an answer. Unsupported sentences that survive the repair are removed;
 * whatever is still questionable is returned as flags (shown at review). null = not answerable from evidence.
 */
export async function writeAnswer(q: OpenQuestion, p: Profile, job: JobContext, write: Writer, language: "en" | "zh" = /[一-鿿]/.test(q.label) ? "zh" : "en"): Promise<Draft | null> {
  if (!q.writable) return null;
  const evidence = selectEvidence(q.topic, p);
  if (!evidence.some((e) => e.kind === "experience" || e.kind === "project")) return null;
  const target = q.limits.words ? Math.max(60, Math.round(q.limits.words * 0.6)) : q.limits.chars ? Math.round(q.limits.chars / 7) : 180;
  const base = { question: q.label, topic: q.topic, language: language === "zh" ? "Simplified Chinese" : "English", limits: { ...q.limits, aim_words: Math.min(target, q.limits.words ?? target) }, evidence, job: { title: job.title, employer: job.employer, description: (job.description ?? "").slice(0, 3500) } };
  let feedback: string[] = [];
  for (let round = 0; round < 2; round++) {
    const raw = await write(ANSWER_SYSTEM, JSON.stringify(feedback.length ? { ...base, fix: feedback } : base), ANSWER_SCHEMA);
    if (raw.answerable === false) return null;
    const sentences = (Array.isArray(raw.sentences) ? raw.sentences : []).map((s) => ({ text: String((s as { text?: unknown }).text ?? "").trim(), evidence: ((s as { evidence?: unknown }).evidence as string[] | undefined) ?? [] })).filter((s) => s.text);
    const breaks = (Array.isArray(raw.paragraph_breaks) ? raw.paragraph_breaks : []).map(Number);
    if (!sentences.length) return null;
    const problems = checkDraft(sentences, evidence, job, q.label);
    const text = assemble(sentences, breaks);
    const over = fitsLimits(text, q.limits);
    if (!problems.length && !over) return { text, evidence: [...new Set(sentences.flatMap((s) => s.evidence))], flags: [], language };
    if (round === 0) {
      feedback = [...problems.map((x) => `sentence ${x.sentence + 1}: ${x.problem} — remove or rewrite it using only the evidence`), ...(over ? [`too long: ${over}`] : [])];
      continue;
    }
    // Still unsupported after the repair: drop those sentences rather than send them.
    const bad = new Set(problems.map((x) => x.sentence));
    const kept = sentences.filter((_, i) => !bad.has(i));
    if (kept.length < 2) return null;
    const keptBreaks = breaks.map((b) => b - [...bad].filter((x) => x < b).length).filter((b) => b > 0);
    let trimmed = assemble(kept, keptBreaks);
    while (fitsLimits(trimmed, q.limits) && kept.length > 2) {
      kept.pop();
      trimmed = assemble(kept, keptBreaks);
    }
    const still = fitsLimits(trimmed, q.limits);
    return { text: trimmed, evidence: [...new Set(kept.flatMap((s) => s.evidence))], flags: still ? [still] : [], language };
  }
  return null;
}

// ---------------------------------------------------------------- option equivalence

export const JUDGE_SYSTEM = `A job-application form offers a fixed list of options. Decide which option means the SAME thing as the applicant's value.
"same": the same institution / field / thing under another name, spelling, translation or abbreviation.
"broader": only for a field of study — an offered field that genuinely contains the applicant's field (e.g. "Economic Statistics" → "Statistics").
Never pick a different institution, a narrower or merely related field, or a guess. If nothing qualifies, pick null with relation "different".`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: { pick: { type: ["string", "null"] }, relation: { type: "string", enum: ["same", "broader", "different"] }, reason: { type: "string" } },
  required: ["pick", "relation", "reason"],
  additionalProperties: false,
};

/** The offered option that is the same as `value` (or, for a field of study, the broader field that contains it). */
export async function judgeOption(value: string, options: string[], kind: "school" | "major" | "degree" | "other", write: Writer): Promise<{ pick: string; relation: "same" | "broader" } | null> {
  // "Other" is not an equivalent of anything: it is the separate fallback (rows.ts), never the judge's pick.
  const real = options.filter((o) => !/^\s*other\b/i.test(o));
  if (!real.length) return null;
  const raw = await write(JUDGE_SYSTEM, JSON.stringify({ kind, value, options: real.slice(0, 120) }), JUDGE_SCHEMA);
  const pick = typeof raw.pick === "string" ? real.find((o) => o.trim() === String(raw.pick).trim()) : undefined;
  if (!pick || (raw.relation !== "same" && raw.relation !== "broader")) return null;
  if (raw.relation === "broader" && kind !== "major") return null;
  return { pick, relation: raw.relation };
}
