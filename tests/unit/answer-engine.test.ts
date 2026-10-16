// The answer engine and fact retrieval (src/local/apply/answer-engine.ts, plan.ts). Fictional applicant.
import { describe, expect, it } from "vitest";
import { answerLimits, checkDraft, judgeOption, openQuestion, selectEvidence, writeAnswer, type Writer } from "../../src/local/apply/answer-engine";
import { planForm, standingConsent, type FieldDescriptor, type PlanContext } from "../../src/local/apply/plan";
import { educationStarts } from "../../src/server/services/apply";
import { profileSchema } from "../../src/shared/profile";

const PROFILE = profileSchema.parse({
  contact: { first_name: "Priya", last_name: "Shah", email: "priya.shah@example.test", phone: "+1 613 555 0199" },
  based_in: { city: "Ottawa", region: "Ontario", country: "加拿大" },
  work_authorization: [{ country: "Canada", status: "work_permit" }],
  education: [
    { level: "master", field: "Data Science", institution: "University of Northfield", completed: false, year: 2026, start: "2025-09", end: "2026-12" },
    { level: "bachelor", field: "Economic Statistics", institution: "Example Institute of Languages", completed: true, year: 2025 },
  ],
  experience: [
    { title: "Data Analyst Intern", organization: "Fabrikam Logistics", start: "2025-02", end: "2025-08", current: false, areas: [], description: "Built SQL queries and Python scripts to analyse delivery delays across 40 depots; created a Tableau dashboard used by operations managers." },
    { title: "Research Assistant", organization: "Example Institute of Languages", start: "2023-06", end: "2023-09", current: false, areas: [], description: "Cleaned survey data in R and ran regression analysis for a faculty study." },
  ],
  skills: ["SQL", "Python", "R", "Tableau"],
});
let n = 0;
const f = (o: Partial<FieldDescriptor>): FieldDescriptor => ({ ref: `f${++n}`, control: "text", inputType: "text", name: "", id: `i${n}`, label: "", placeholder: "", autocomplete: "", required: true, options: [], section: "", demographic: false, value: "", visible: true, ...o });
const opts = (...l: string[]) => l.map((label) => ({ label, value: label })) as FieldDescriptor["options"];
const ctx = (p = PROFILE, extra: Partial<PlanContext> = {}): PlanContext => ({ profile: p, jobCountry: "Canada", answers: {}, resume: { fileName: "" }, ...extra });
const first = (field: FieldDescriptor, c = ctx()) => planForm([field], c);

describe("facts that were present but not retrieved", () => {
  it("current OR previous employer and title come from the SAME latest record (none marked current)", () => {
    expect(first(f({ label: "Who is your current or previous employer?" })).actions[0]).toMatchObject({ value: "Fabrikam Logistics", source: "experience.latest" });
    expect(first(f({ label: "What is your current or previous job title?" })).actions[0]).toMatchObject({ value: "Data Analyst Intern", source: "experience.latest" });
    expect(first(f({ label: "Most recent employer" })).actions[0]).toMatchObject({ value: "Fabrikam Logistics" });
    // Strictly "current": nothing is current → not answered with a past employer.
    expect(first(f({ label: "Current employer" })).actions).toEqual([]);
  });
  it("country of residence, however asked, selects the site's Canada option", () => {
    for (const label of ["Please select the country where you currently reside.", "What is your country of residence?", "Where do you currently live?"]) {
      expect(first(f({ label, control: "select", options: opts("Australia", "Brazil", "Canada", "France") })).actions[0]).toMatchObject({ kind: "choose", values: ["Canada"] });
    }
  });
  it("'When do you expect to complete your degree?' → the degree IN PROGRESS, as a month and year", () => {
    expect(first(f({ label: "When do you expect to complete your degree?" })).actions[0]).toMatchObject({ value: "December 2026" });
    const two = profileSchema.parse({ ...PROFILE, education: [...PROFILE.education, { level: "diploma", field: "French", institution: "Example College", completed: false, year: 2027 }] });
    expect(first(f({ label: "When do you expect to complete your degree?" }), ctx(two)).questions[0]?.hint).toMatch(/Several degrees in progress/);
  });
});

describe("genuine decisions are asked — and reused only as they should be", () => {
  it("a recruiting deadline is never assumed; a saved answer is reused only while fresh", () => {
    const label = "Do you have an active offer deadline or another recruiting-process deadline we should be aware of?";
    expect(first(f({ label, control: "textarea" })).actions).toEqual([]);
    const fresh = profileSchema.parse({ ...PROFILE, application_defaults: { recruiting_deadline: { answer: "No", as_of: new Date().toISOString().slice(0, 10) } } });
    expect(first(f({ label, control: "textarea" }), ctx(fresh)).actions[0]).toMatchObject({ value: "No" });
    const stale = profileSchema.parse({ ...PROFILE, application_defaults: { recruiting_deadline: { answer: "No", as_of: "2025-01-01" } } });
    expect(first(f({ label, control: "textarea" }), ctx(stale)).actions).toEqual([]);
  });
  it("future sponsorship is not inferred from holding a work permit", () => {
    const q = f({ label: "Do you require visa sponsorship, now or in the future, to continue working in Canada?", control: "select", options: opts("Yes, I will require visa sponsorship", "No, I do not require visa sponsorship") });
    expect(first(q).actions).toEqual([]);
    const said = profileSchema.parse({ ...PROFILE, application_defaults: { sponsorship_future: "no", sponsorship_now: "no" } });
    expect(first(q, ctx(said)).actions[0]).toMatchObject({ kind: "choose" });
  });
  it("education start dates answered for a school are saved to THAT school", () => {
    const qs = [
      { key: "a", label: "Example Institute of Languages: Start date month", kind: "select", required: true, options: [], reason: "missing", sensitive: false, meaning: "education_start", entry: "Example Institute of Languages" },
      { key: "b", label: "Example Institute of Languages: Start date year", kind: "number", required: true, options: [], reason: "missing", sensitive: false, meaning: "education_start", entry: "Example Institute of Languages" },
    ] as never;
    expect(educationStarts(qs, { a: "September", b: "2021" })).toEqual([{ entry: "Example Institute of Languages", start: "2021-09" }]);
    expect(educationStarts(qs, { a: "September" })).toEqual([]); // a month alone is not a date
  });
});

describe("standing consents by category", () => {
  const brighthire = "To ensure we can focus fully on our conversation, we use BrightHire to record and transcribe interviews. Recordings may be used internally to train our interviewers. Do you consent?";
  const withConsents = (s: Record<string, boolean>, verified = true) => ctx(profileSchema.parse({ ...PROFILE, application_defaults: { standing_consents: s } }), { consent: { accuracyVerified: verified } });
  it("recording + training needs BOTH categories; then the site's Yes is chosen", () => {
    const q = f({ label: brighthire, control: "select", options: opts("Yes", "No") });
    expect(standingConsent(brighthire, q.id, withConsents({ interview_recording: true }))).toBeNull();
    expect(standingConsent(brighthire, q.id, withConsents({ interview_recording: true, recording_training: true }))).toEqual(["interview_recording", "recording_training"]);
    expect(first(q, withConsents({ interview_recording: true, recording_training: true })).actions[0]).toMatchObject({ kind: "choose", values: ["Yes"], source: "consent.interview_recording+recording_training" });
    expect(first(q, withConsents({})).questions[0]).toMatchObject({ reason: "legal" });
  });
  it("an accuracy declaration only over verified values; binding terms never", () => {
    const decl = "I certify that the information in this application is true and complete.";
    expect(standingConsent(decl, "k", withConsents({ accuracy_declaration: true }, true))).toEqual(["accuracy_declaration"]);
    expect(standingConsent(decl, "k", withConsents({ accuracy_declaration: true }, false))).toBeNull();
    expect(standingConsent("I agree to binding arbitration.", "k", withConsents({ routine_terms: true, accuracy_declaration: true }))).toBeNull();
  });
});

describe("open questions: intent, limits, evidence", () => {
  it("reads limits and whether a question can be answered from a background", () => {
    const q = openQuestion("Please tell us in 1-2 paragraphs (500 words or less) about a past data-related project you've worked on.");
    expect(q).toMatchObject({ topic: "project", writable: true, limits: { words: 500, paragraphs: [1, 2] } });
    expect(answerLimits("Why this role? (max 300 characters)", 1000)).toMatchObject({ chars: 300 });
    expect(openQuestion("Do you have an active offer deadline we should be aware of?").writable).toBe(false);
    expect(openQuestion("What are your salary expectations?").writable).toBe(false);
  });
  it("evidence carries work / project / education / skills — never contact, identity or eligibility", () => {
    const ev = JSON.stringify(selectEvidence("motivation_role", PROFILE));
    for (const v of ["Priya", "Shah", "example.test", "555", "work_permit", "Ottawa"]) expect(ev).not.toContain(v);
    expect(ev).toContain("Fabrikam Logistics");
  });
  it("invented numbers, tools and organisations are caught", () => {
    const ev = selectEvidence("project", PROFILE);
    const problems = checkDraft(
      [
        { text: "At Fabrikam Logistics I analysed delivery delays across 40 depots with SQL and Python.", evidence: ["exp1"] },
        { text: "The dashboard cut delays by 25% using Power BI.", evidence: ["exp1"] },
        { text: "I later presented it at Contoso Bank.", evidence: ["exp1"] },
        { text: "This matches the role's focus on analytics.", evidence: [] },
      ],
      ev,
      { title: "Data Analyst", employer: "Northwind", description: "Analytics with SQL." },
      "Describe a data project",
    );
    const text = problems.map((p) => p.problem).join(" | ");
    expect(problems.filter((p) => p.sentence === 0)).toEqual([]); // fully supported
    expect(text).toMatch(/number "25%"/);
    expect(text).toMatch(/power bi/i);
    expect(text).toMatch(/"Contoso"/);
    expect(text).toMatch(/no evidence cited/);
  });
});

describe("writing: repair once, then drop what is still unsupported", () => {
  const q = openQuestion("Please tell us in 1-2 paragraphs (500 words or less) about a past data-related project you've worked on.");
  const job = { title: "Data Analyst", employer: "Northwind", description: "Work with SQL and dashboards." };
  it("a supported draft is used as written", async () => {
    const write: Writer = async () => ({ answerable: true, reason: "", paragraph_breaks: [2], sentences: [
      { text: "At Fabrikam Logistics I analysed delivery delays across 40 depots.", evidence: ["exp1"] },
      { text: "I wrote SQL queries and Python scripts and built a Tableau dashboard for operations managers.", evidence: ["exp1"] },
      { text: "That work matches this role's focus on SQL and dashboards.", evidence: ["job", "exp1"] },
    ] });
    const d = await writeAnswer(q, PROFILE, job, write);
    expect(d?.flags).toEqual([]);
    expect(d?.text.split(/\n\n/)).toHaveLength(2);
  });
  it("an invented result is sent back, and removed if it comes back again", async () => {
    let calls = 0;
    const write: Writer = async (_s, user) => {
      calls++;
      if (calls === 2) expect(JSON.parse(user).fix.join(" ")).toMatch(/25%/);
      return { answerable: true, reason: "", paragraph_breaks: [], sentences: [
        { text: "At Fabrikam Logistics I analysed delivery delays across 40 depots.", evidence: ["exp1"] },
        { text: "My dashboard reduced delays by 25%.", evidence: ["exp1"] },
        { text: "I used SQL, Python and Tableau for the analysis.", evidence: ["exp1"] },
      ] };
    };
    const d = await writeAnswer(q, PROFILE, job, write);
    expect(calls).toBe(2);
    expect(d?.text).not.toContain("25%");
    expect(d?.text).toContain("40 depots");
  });
  it("a personal-decision question is never written", async () => {
    const d = await writeAnswer(openQuestion("Do you have an offer deadline?"), PROFILE, job, async () => ({ answerable: true, sentences: [{ text: "No.", evidence: ["exp1"] }], paragraph_breaks: [], reason: "" }));
    expect(d).toBeNull();
  });
});

describe("option equivalence (judge)", () => {
  it("same / broader accepted only where they make sense; a pick must be offered", async () => {
    const judge = (pick: string | null, relation: string): Writer => async () => ({ pick, relation, reason: "" });
    expect(await judgeOption("Economic Statistics", ["Statistics", "Economics", "Other"], "major", judge("Statistics", "broader"))).toEqual({ pick: "Statistics", relation: "broader" });
    expect(await judgeOption("Example Institute of Languages", ["Example Institute", "Other"], "school", judge("Example Institute", "broader"))).toBeNull();
    expect(await judgeOption("Example Institute of Languages", ["Other"], "school", judge("Example Institute of Languages", "same"))).toBeNull(); // not offered
  });
});
