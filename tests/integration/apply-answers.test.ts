// The answer engine end to end on a SYNTHETIC questionnaire (tests/fixtures/questionnaire-fixture.ts) with a
// fictional applicant: facts that were present but not retrieved are filled; the open project question is
// written from verified records (a scripted stand-in for the AI here — the real provider is exercised by
// apply-answers-live.test.ts); a school the site does not list becomes "Other", a major its broader
// listed field; recording consent follows the standing categories; genuine decisions are asked once and
// saved where they belong. Review mode.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Proposer } from "../../src/local/apply/browser-agent";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { codexProvider } from "../../src/local/codex";
import { agentHook, runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
let fx: AtsFixture;
let resume: string;

const PROFILE = {
  contact: { first_name: "Priya", last_name: "Shah", email: "priya.shah@example.test", phone: "+1 613 555 0199" },
  based_in: { city: "Ottawa", region: "Ontario", country: "加拿大" },
  work_authorization: [{ country: "Canada", status: "work_permit" }],
  education: [
    { level: "master", field: "Data Science", institution: "University of Northfield", completed: false, year: 2026, start: "2025-09", end: "2026-12" },
    { level: "bachelor", field: "Economic Statistics", institution: "Example Institute of Languages", completed: true, year: 2025, end: "2025-06" },
  ],
  experience: [
    { title: "Data Analyst Intern", organization: "Fabrikam Logistics", start: "2025-02", end: "2025-08", current: false, areas: [], description: "Built SQL queries and Python scripts to analyse delivery delays across 40 depots; created a Tableau dashboard used by operations managers." },
    { title: "Research Assistant", organization: "Example Institute of Languages", start: "2023-06", end: "2023-09", current: false, areas: [], description: "Cleaned survey data in R and ran regression analysis for a faculty study." },
  ],
  skills: ["SQL", "Python", "R", "Tableau"],
};

/** Stands in for the AI: answers ONLY from the evidence it is given, judges options conservatively. */
const scripted: { calls: { kind: string; payload: Record<string, unknown> }[]; writer: Proposer } = {
  calls: [],
  writer: async (_s, user) => {
    const u = JSON.parse(user) as Record<string, unknown>;
    if ("options" in u) {
      scripted.calls.push({ kind: "judge", payload: u });
      // Economic Statistics → Statistics is a broader field that contains it; a school is never swapped.
      if (u.kind === "major" && u.value === "Economic Statistics") return { pick: "Statistics", relation: "broader", reason: "contains" };
      return { pick: null, relation: "different", reason: "not listed" };
    }
    scripted.calls.push({ kind: "answer", payload: u });
    const ev = u.evidence as { id: string; text: string }[];
    const exp = ev.find((e) => e.id === "exp1")!;
    return {
      answerable: true,
      reason: "",
      paragraph_breaks: [2],
      sentences: [
        { text: "At Fabrikam Logistics I analysed delivery delays across 40 depots.", evidence: [exp.id] },
        { text: "I wrote SQL queries and Python scripts and built a Tableau dashboard that operations managers used.", evidence: [exp.id] },
        { text: "The work showed where delays arose and gave managers a shared view of them.", evidence: [exp.id] },
      ],
    };
  },
};

const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 300_000);
const run = async (n: number, defaults: Record<string, unknown>) => {
  await api("/api/profile", { method: "PUT", json: { profile: { ...PROFILE, application_defaults: defaults } } });
  const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind (synthetic)", title: "Data Analyst, Intern", country: "Canada", original_url: `${fx.url}/qa/${n}` }, confirm_duplicate: true } })).body.id;
  return settled((await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
};
const dbg = (a: AttemptDTO) => process.env.CA_APPLY_DEBUG && process.stderr.write(`ATT ${a.state} ${a.intervention} ${a.error_code} Q=${JSON.stringify(a.questions.map((q) => [q.label.slice(0, 50), q.reason]))} F=${JSON.stringify(a.filled.map((f) => [f.label.slice(0, 40), f.source, f.verified, f.status]))} S=${JSON.stringify(a.steps.map((x) => x.code))}\n`);
const keys = (a: AttemptDTO) => a.questions.map((q) => q.label.replace(/\s+/g, " "));

beforeAll(async () => {
  fx = await startAtsFixture();
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Priya.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Priya");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterEach(() => {
  agentHook.writer = null;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("answer engine on a synthetic questionnaire (fictional applicant)", () => {
  it("AI writing + recording consents on: retrieves, writes, judges, consents; asks only the genuine unknowns; saves them where they belong", async () => {
    agentHook.writer = scripted.writer;
    scripted.calls = [];
    let a = await run(1, { ai_answer_writing: "on", standing_consents: { interview_recording: true, recording_training: true } });
    dbg(a);
    expect(a).toMatchObject({ state: "needs_review" });
    const asked = keys(a).join(" | ");
    // Only: the offer deadline (time-sensitive), future sponsorship (a decision), the bachelor's start date (absent).
    expect(asked).toMatch(/offer deadline/);
    expect(asked).toMatch(/visa sponsorship/);
    expect(asked).toMatch(/Example Institute of Languages: Start date month/);
    expect(asked).not.toMatch(/employer|job title|reside|complete your degree|data-related project|record/);
    const startQs = a.questions.filter((q) => q.meaning === "education_start");
    expect(startQs.every((q) => q.entry === "Example Institute of Languages")).toBe(true);
    // The written answer: from evidence only, listed for review.
    const gen = a.filled.find((f) => f.status === "generated")!;
    expect(gen).toMatchObject({ source: "ai_generated", verified: true, flags: [] });
    expect(gen.value).toContain("40 depots");
    // Evidence sent for writing never carries contact / eligibility details.
    const sent = JSON.stringify(scripted.calls);
    for (const v of ["Priya", "Shah", "example.test", "555", "work_permit", "Ottawa"]) expect(sent).not.toContain(v);
    // Answer the genuine unknowns once.
    const q = (re: RegExp) => a.questions.find((x) => re.test(x.label))!;
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/answers`, { method: "POST", json: { answers: { [q(/offer deadline/).key]: "No", [q(/visa sponsorship/).key]: q(/visa sponsorship/).options.find((o) => /^No/.test(o)) ?? "No", [q(/Start date month/).key]: "September", [q(/Start date year/).key]: "2021" }, remember: [q(/visa sponsorship/).key, q(/offer deadline/).key] } })).body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    // Saved where they belong: the start date in THAT school's entry; sponsorship by meaning; the deadline dated.
    const prof = (await api<{ profile: typeof PROFILE & { application_defaults: Record<string, unknown> } }>("/api/profile")).body.profile;
    expect(prof.education.find((e) => e.institution === "Example Institute of Languages")).toMatchObject({ start: "2021-09" });
    expect(prof.education.find((e) => e.institution === "University of Northfield")).toMatchObject({ start: "2025-09" });
    expect(prof.application_defaults).toMatchObject({ sponsorship_future: "no", recruiting_deadline: { answer: "No" } });
    // The written answer was not rewritten on the re-run (same text kept with the attempt).
    expect(scripted.calls.filter((c) => c.kind === "answer")).toHaveLength(1);
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    expect(a.state).toBe("submitted_verified");
    const s = fx.submissions.find((x) => x.path === "/qa/1/submit")!.fields;
    expect(s).toMatchObject({
      q_employer: "Fabrikam Logistics",
      q_title: "Data Analyst Intern",
      q_country: "Canada",
      q_complete: "December 2026",
      q_record: "Yes",
      school_0: "University of Northfield",
      discipline_0: "Data Science",
      school_1: "Other", // not listed: never another school
      discipline_1: "Statistics", // the broader listed field that contains the major
      start_month_1: "September",
      start_year_1: "2021",
    });
    expect(String(s.q_project)).toContain("Fabrikam Logistics");
    expect(String(s.q_project).split(/\s+/).length).toBeLessThanOrEqual(500);
    expect(String(s.q_sponsor)).toMatch(/^No/);
  }, 600_000);

  it("AI writing and consents off: facts still retrieved; the project question and the recording consent are asked", async () => {
    agentHook.writer = scripted.writer;
    scripted.calls = [];
    const a = await run(2, { ai_answer_writing: "off" });
    dbg(a);
    const asked = keys(a).join(" | ");
    expect(asked).toMatch(/data-related project/);
    expect(asked).toMatch(/record and transcribe/);
    expect(asked).not.toMatch(/employer|job title|reside|complete your degree/);
    expect(a.questions.find((q) => /record and transcribe/.test(q.label))).toMatchObject({ reason: "legal" });
    expect(scripted.calls).toEqual([]); // nothing was sent to the AI
    expect(a.filled.some((f) => f.status === "generated")).toBe(false);
  }, 600_000);

  // OPT-IN: the same questionnaire with the REAL provider writing and judging (CA_LIVE_CODEX=1).
  it.skipIf(process.env.CA_LIVE_CODEX !== "1")("real provider end to end: the project answer is written from evidence, filled, verified and listed for review", async () => {
    const p = await codexProvider().ready();
    expect(p).toBeTruthy();
    agentHook.writer = async (system, user, schema) => (await p!.completeJson({ system, user, jsonSchema: schema })) as Record<string, unknown>;
    const a = await run(3, { ai_answer_writing: "on", standing_consents: { interview_recording: true, recording_training: true } });
    dbg(a);
    const gen = a.filled.find((f) => f.status === "generated")!;
    expect(gen).toMatchObject({ source: "ai_generated", verified: true });
    expect(gen.flags).toEqual([]);
    expect(String(gen.value).split(/\s+/).length).toBeLessThanOrEqual(500);
    expect(String(gen.value)).toMatch(/Fabrikam Logistics|transit|survey/i);
    const asked = keys(a).join(" | ");
    expect(asked).not.toMatch(/employer|job title|reside|complete your degree|data-related project|record and transcribe/);
    process.stdout.write(`\nLIVE ANSWER (${String(gen.value).split(/\s+/).length} words):\n${gen.value}\nASKED: ${asked}\n`);
  }, 900_000);
});
