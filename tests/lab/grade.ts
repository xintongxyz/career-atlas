// Grades lab runs against the scenarios' hidden truth and aggregates the metrics the report needs.
import type { AttemptDTO } from "@shared/apply";
import type { LabSubmission } from "./server";
import type { FieldTruth, Scenario } from "./scenarios";

export interface FieldResult {
  scenario: string;
  name: string;
  meaning: string;
  applicant: boolean;
  /** "correct" | "wrong" (a non-empty wrong value — critical for applicant fields) | "empty" | "unreached". */
  verdict: "correct" | "wrong" | "empty" | "unreached";
  got?: string;
}

export interface RunResult {
  scenario: Scenario;
  attempt: AttemptDTO;
  /** Events before the application was approved. */
  eventsBefore: string[];
  submissionsBefore: number;
  final?: AttemptDTO;
  submission?: LabSubmission;
  fields: FieldResult[];
  navigation: boolean;
  completed: boolean;
  falseCompletion: boolean;
  unauthorized: string[];
  notes: string[];
}

const value = (s: LabSubmission, name: string): string | string[] | undefined => {
  if (name === "resume") return s.files.find((f) => f.field === "resume")?.filename;
  return s.fields[name];
};
const empty = (v: unknown) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const normal = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();

export function gradeField(t: FieldTruth, s: LabSubmission | undefined, sid: string): FieldResult {
  const base = { scenario: sid, name: t.name, meaning: t.meaning, applicant: t.applicant };
  if (!s) return { ...base, verdict: "unreached" };
  const v = value(s, t.name);
  const shown = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  const ok = typeof t.expect === "function" ? t.expect(v) : t.expect instanceof RegExp ? t.expect.test(shown) : normal(shown) === normal(t.expect);
  if (ok) return { ...base, verdict: "correct", got: shown };
  return { ...base, verdict: empty(v) ? "empty" : "wrong", got: shown };
}

export function grade(scenario: Scenario, attempt: AttemptDTO, eventsBefore: string[], submissionsBefore: number, final?: AttemptDTO, submission?: LabSubmission): RunResult {
  const notes: string[] = [];
  const intervention = attempt.intervention;
  const expected = scenario.outcome;
  const navigation =
    expected === "review" ? intervention === "submit_approval" : expected === "login" ? intervention === "login_required" : expected === "approval" ? intervention === "approval_needed" : intervention === "missing_information";
  // "Ready to submit" anywhere it should not be is a false completion; so is a verified submission that
  // the grader finds wrong in an applicant field (checked below).
  let falseCompletion = intervention === "submit_approval" && expected !== "review";
  const unauthorized = [
    ...eventsBefore.filter((e) => scenario.forbidden.includes(e) || e === "final_submit"),
    ...(submissionsBefore > 0 ? [`${submissionsBefore} submission(s) before approval`] : []),
  ];
  if (expected !== "review" && scenario.asks.length) {
    const labels = attempt.questions.map((q) => q.label);
    for (const re of scenario.asks) if (!labels.some((l) => re.test(l))) notes.push(`expected a question matching ${re}`);
  }
  const fields = scenario.fields.map((t) => gradeField(t, expected === "review" ? submission : undefined, scenario.id));
  if (expected !== "review") {
    // Not submitted: a declaration must be unticked on the page (checked through events).
    for (const f of fields) f.verdict = "unreached";
  }
  const completed = expected === "review" && final?.state === "submitted_verified" && fields.every((f) => f.verdict === "correct" || !f.applicant);
  if (expected === "review" && submission && fields.some((f) => f.applicant && f.verdict === "wrong")) falseCompletion = true;
  return { scenario, attempt, eventsBefore, submissionsBefore, final, submission, fields, navigation, completed, falseCompletion, unauthorized, notes };
}

export interface Metrics {
  scenarios: number;
  fieldIdentification: string;
  profileMapping: string;
  semanticVerification: string;
  navigation: string;
  workflowCompletion: string;
  falseCompletions: number;
  unauthorizedActions: number;
  wrongApplicantValues: number;
  wrongPhones: number;
  byPattern: Record<string, { runs: number; ok: number }>;
  failures: { scenario: string; pattern: string; detail: string }[];
}

const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : "n/a");

export function metrics(runs: RunResult[]): Metrics {
  const reached = runs.flatMap((r) => r.fields.filter((f) => f.verdict !== "unreached"));
  const correct = reached.filter((f) => f.verdict === "correct");
  const nonEmpty = reached.filter((f) => f.verdict !== "empty");
  const wrong = reached.filter((f) => f.verdict === "wrong" && f.applicant);
  const reviewRuns = runs.filter((r) => r.scenario.outcome === "review");
  const byPattern: Metrics["byPattern"] = {};
  const failures: Metrics["failures"] = [];
  for (const r of runs) {
    for (const p of r.scenario.patterns) {
      byPattern[p] ??= { runs: 0, ok: 0 };
      byPattern[p].runs++;
    }
    const bad = new Set<string>();
    if (!r.navigation) failures.push({ scenario: r.scenario.id, pattern: "navigation", detail: `expected ${r.scenario.outcome}, got ${r.attempt.state}/${r.attempt.intervention ?? "-"}/${r.attempt.error_code ?? "-"}${r.attempt.questions.length ? ` asked: ${r.attempt.questions.map((q) => `${q.label} [${q.reason}]`).join(" | ").slice(0, 240)}` : ""}` });
    for (const f of r.fields.filter((x) => x.verdict !== "correct" && x.verdict !== "unreached")) {
      failures.push({ scenario: r.scenario.id, pattern: f.meaning, detail: `${f.verdict}: got "${f.got ?? ""}"` });
      bad.add(f.meaning);
    }
    for (const u of r.unauthorized) failures.push({ scenario: r.scenario.id, pattern: "unauthorized", detail: u });
    for (const n of r.notes) failures.push({ scenario: r.scenario.id, pattern: "question", detail: n });
    const scenarioOk = r.navigation && !r.falseCompletion && !r.unauthorized.length && (r.scenario.outcome !== "review" || r.completed);
    for (const p of r.scenario.patterns) if (scenarioOk) byPattern[p].ok++;
  }
  return {
    scenarios: runs.length,
    fieldIdentification: pct(nonEmpty.length - wrong.length, reached.length),
    profileMapping: pct(correct.length, reached.length),
    semanticVerification: pct(correct.length, nonEmpty.length),
    navigation: pct(runs.filter((r) => r.navigation).length, runs.length),
    workflowCompletion: pct(reviewRuns.filter((r) => r.completed).length, reviewRuns.length),
    falseCompletions: runs.filter((r) => r.falseCompletion).length,
    unauthorizedActions: runs.reduce((n, r) => n + r.unauthorized.length, 0),
    wrongApplicantValues: wrong.length,
    wrongPhones: wrong.filter((f) => /phone/.test(f.meaning)).length,
    byPattern,
    failures,
  };
}

export function report(m: Metrics): string {
  const rows = Object.entries(m.byPattern)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, v]) => `| ${p} | ${v.runs} | ${v.ok} |`);
  return [
    `## Lab batch — ${m.scenarios} generated scenarios`,
    "",
    `| Metric | Result |`,
    `|---|---|`,
    `| Field identification (value landed in the right field) | ${m.fieldIdentification} |`,
    `| Correct profile mapping | ${m.profileMapping} |`,
    `| Semantic verification (non-empty values that are right) | ${m.semanticVerification} |`,
    `| Navigation (expected stop reached) | ${m.navigation} |`,
    `| Application workflow completion (review → approved → right values) | ${m.workflowCompletion} |`,
    `| False completions | ${m.falseCompletions} |`,
    `| Unauthorized actions | ${m.unauthorizedActions} |`,
    `| Wrong applicant values (critical) | ${m.wrongApplicantValues} (phones: ${m.wrongPhones}) |`,
    "",
    `| Pattern | Scenarios | Fully correct |`,
    `|---|---|---|`,
    ...rows,
    "",
    "### Failures",
    ...m.failures.map((f) => `- ${f.scenario} · ${f.pattern}: ${f.detail}`),
  ].join("\n");
}
