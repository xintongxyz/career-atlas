// OPT-IN: the answer engine with the REAL provider (local Codex, ChatGPT sign-in, tools off) on a
// FICTIONAL applicant. Checks that answers are written from evidence, pass the claim check, respect the
// stated limits, change with the role, refuse personal decisions, and that option equivalence is
// conservative. Never runs in CI.
//   CA_LIVE_CODEX=1 CA_AGENT_EVIDENCE=/tmp/answers.jsonl npx vitest run tests/integration/apply-answers-live.test.ts
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDraft, fitsLimits, judgeOption, openQuestion, selectEvidence, writeAnswer, type Writer } from "../../src/local/apply/answer-engine";
import { codexProvider } from "../../src/local/codex";
import { profileSchema } from "../../src/shared/profile";

const live = process.env.CA_LIVE_CODEX === "1";
const evidence = (line: Record<string, unknown>) => {
  if (process.env.CA_AGENT_EVIDENCE) appendFileSync(process.env.CA_AGENT_EVIDENCE, `${JSON.stringify(line)}\n`, { mode: 0o600 });
};

const PROFILE = profileSchema.parse({
  contact: { first_name: "Priya", last_name: "Shah", email: "priya.shah@example.test" },
  education: [
    { level: "master", field: "Data Science", institution: "University of Northfield", completed: false, year: 2026, start: "2025-09", end: "2026-12" },
    { level: "bachelor", field: "Economic Statistics", institution: "Example Institute of Languages", completed: true, year: 2025 },
  ],
  experience: [
    { title: "Data Analyst Intern", organization: "Fabrikam Logistics", start: "2025-02", end: "2025-08", current: false, areas: [], description: "Built SQL queries and Python scripts to analyse delivery delays across 40 depots; created a Tableau dashboard used by operations managers to prioritise routes." },
    { title: "Research Assistant", organization: "Example Institute of Languages", start: "2023-06", end: "2023-09", current: false, areas: [], description: "Cleaned survey data in R and ran regression analysis for a faculty study on student employment." },
  ],
  projects: [{ name: "Transit ridership forecast (course project)", description: "Forecast weekly ridership from open city data with time-series models in Python; compared ARIMA with a seasonal baseline.", skills: ["Python", "pandas"] }],
  skills: ["SQL", "Python", "R", "Tableau", "Excel"],
});
const JOB_A = { title: "Data Analyst, Intern", employer: "Northwind Payments", description: "You will analyse payments data with SQL and Python, build dashboards for product teams and communicate findings to stakeholders. Experience with experimentation is a plus." };
const JOB_B = { title: "Operations Research Intern", employer: "Contoso Rail", description: "Help improve train scheduling with optimisation and forecasting models; Python required; experience with time-series data valued." };

describe.skipIf(!live)("answer engine with the real provider (opt-in, fictional applicant)", () => {
  it("writes evidence-backed answers within limits, tailored to the role; refuses personal decisions; judges options conservatively", async () => {
    const p = await codexProvider().ready();
    expect(p).toBeTruthy();
    const write: Writer = async (system, user, schema) => (await p!.completeJson({ system, user, jsonSchema: schema })) as Record<string, unknown>;
    const cases: [string, typeof JOB_A][] = [
      ["Please tell us in 1-2 paragraphs (500 words or less) about a past data-related project you’ve worked on. Please describe the problem you were trying to solve, the data you used and what you found.", JOB_A],
      ["Why are you interested in this role? (max 150 words)", JOB_A],
      ["Describe your experience with SQL, Python or R.", JOB_A],
      ["Tell us about a time you solved a difficult problem. (200 words max)", JOB_A],
      ["Please tell us in 1-2 paragraphs (500 words or less) about a past data-related project you’ve worked on. Please describe the problem you were trying to solve, the data you used and what you found.", JOB_B],
      ["Do you have an active offer deadline or another recruiting-process deadline we should be aware of?", JOB_A],
    ];
    const results: { q: string; job: string; text: string | null; flags: string[]; problems: string[] }[] = [];
    for (const [label, job] of cases) {
      const q = openQuestion(label);
      const t0 = Date.now();
      const d = await writeAnswer(q, PROFILE, job, write);
      const problems = d ? checkDraft(d.text.split(/(?<=[.!?])\s+/).map((text) => ({ text, evidence: d.evidence })), selectEvidence(q.topic, PROFILE), job, label).map((x) => x.problem) : [];
      results.push({ q: label.slice(0, 60), job: job.employer, text: d?.text ?? null, flags: d?.flags ?? [], problems });
      evidence({ kind: "answer", question: label, job: job.employer, topic: q.topic, limits: q.limits, text: d?.text ?? null, words: d ? d.text.split(/\s+/).length : 0, flags: d?.flags ?? [], recheck: problems, ms: Date.now() - t0 });
      if (q.writable) {
        expect(d, label).not.toBeNull();
        expect(fitsLimits(d!.text, q.limits), label).toBeNull();
        for (const v of ["Priya", "Shah", "example.test"]) expect(d!.text).not.toContain(v);
      } else expect(d).toBeNull();
    }
    // The same question for another role is not the same essay.
    expect(results[0].text).not.toEqual(results[4].text);
    const judged = [
      await judgeOption("Economic Statistics", ["Computer Science", "Economics", "Statistics", "Other"], "major", write),
      await judgeOption("Example Institute of Languages", ["Example Institute", "Example State University", "Other"], "school", write),
      await judgeOption("Univ. of Northfield", ["University of Northfield", "Northfield College", "Other"], "school", write),
      await judgeOption("Data Science", ["Business", "Fine Arts", "Other"], "major", write),
    ];
    evidence({ kind: "judge", results: judged });
    expect(judged[1]).toBeNull(); // never another school
    expect(judged[2]).toEqual({ pick: "University of Northfield", relation: "same" });
    expect(judged[3]).toBeNull();
    process.stdout.write(`\n${JSON.stringify(results.map((r) => ({ q: r.q, job: r.job, words: r.text?.split(/\s+/).length ?? 0, flags: r.flags, recheck: r.problems })), null, 1)}\n${JSON.stringify(judged)}\n`);
  }, 1_200_000);
});
