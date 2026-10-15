// Workday sections end to end against the SYNTHETIC "rich" Workday site (tests/fixtures/workday-
// fixture.ts, variant "rich"): id-based panels, searchable school / field of study with type="search",
// an async degree list, Websites and Languages sections with their own Add buttons, a skills tag box
// that only accepts chosen suggestions, a hierarchical "How did you hear about us?", and a full
// re-render after every choice. Fictional applicant and schools only.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const PROFILE = {
  contact: {
    first_name: "Riley",
    last_name: "Chen",
    email: "riley.chen@example.test",
    phone: "+1 647 555 0199",
    linkedin_url: "https://www.linkedin.com/in/riley-chen-example",
    website_url: "riley-chen.example.test",
    github_url: "https://github.com/riley-chen-example",
  },
  based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "citizen" }],
  // Two schools, each with its OWN degree and field (the failure being guarded against: one school's
  // degree applied to every school).
  education: [
    { level: "master", field: "Statistics", institution: "University of Northfield", country: "Canada", completed: false, year: 2026 },
    { level: "bachelor", field: "Economics and Statistics", institution: "Southern University of Foreign Studies", country: "China", completed: true, year: 2022 },
  ],
  experience: [
    { title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: [] },
    { title: "Research Assistant", organization: "Example Institute", start: "2022-09", end: "2023-08", current: false, areas: [] },
  ],
  languages: [
    { language: "English", level: "fluent" },
    { language: "Mandarin", level: "native" },
    { language: "French", level: "intermediate" },
  ],
  skills: ["Excel", "SQL", "Python", "Stata", "Power BI", "R", "excel"],
  application_defaults: { prior_employment: "no", phone_type: "mobile" },
};

let fx: AtsFixture;
let resume: string;
let jobId: string;

const start = () => api<AttemptDTO>(`/api/jobs/${jobId}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true, account_mode: "none", entry_mode: "autofill" } });
const settled = (id: string) =>
  settledInner(id).catch(async (e) => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    console.log("TIMEOUT", a.state, a.stage, a.intervention, a.steps.slice(-30).map((x) => `${new Date(x.at).toISOString().slice(14, 23)} ${x.code}${x.params ? JSON.stringify(x.params) : ""}`).join(" | "));
    throw e;
  });
const settledInner = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, Number(process.env.CA_RICH_WAIT ?? 300_000));
type Saved = { v: Record<string, unknown>; work: { jobTitle?: string; companyName?: string }[]; edu: { school: string[]; degree?: string; field: string[]; lastYear?: string }[]; web: { url: string }[]; lang: { language?: string; native?: boolean; reading?: string; speaking?: string; writing?: string }[]; skills: string[] };
/** What Workday stored for My Experience (the last save made from that step). */
const experienceSave = () => [...fx.workday.saves].reverse().find((x) => Array.isArray((x as Saved).lang) && ((x as Saved).edu ?? []).length > 0) as Saved | undefined;

beforeAll(async () => {
  fx = await startAtsFixture();
  await api("/api/profile", { method: "PUT", json: { profile: PROFILE } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic resume Riley rich\n%%EOF\n")], "Riley_Chen.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Riley");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
  const url = `${fx.url}/wd/northwind/job/Toronto-ON/Analyst_R4001?variant=rich&source=LinkedIn`;
  jobId = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title: "Analyst (rich)", country: "Canada", original_url: url }, confirm_duplicate: true } })).body.id;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("Workday sections on a live-like form (synthetic)", () => {
  let first: AttemptDTO;

  it("fills My Information and My Experience completely from My Profile, with each value committed on the page", async () => {
    first = await settled((await start()).body.id);
    if (process.env.CA_APPLY_DEBUG) console.log("RICH", first.state, first.intervention, first.error_code, (first as unknown as { error_message?: string }).error_message, JSON.stringify(first.questions.map((q) => [q.key, q.reason, q.label])), first.steps.slice(-25).map((x) => `${x.code}${x.params ? JSON.stringify(x.params) : ""}`).join(" | "), JSON.stringify(first.filled.filter((f) => !f.verified)));
    if (process.env.CA_RICH_SHOTS) {
      const { writeFileSync } = await import("node:fs");
      for (const name of first.evidence ?? []) {
        const r = await SELF.fetch(`http://localhost/api/apply/attempts/${first.id}/evidence/${name}`, { headers: { origin: "http://localhost" } });
        writeFileSync(`${process.env.CA_RICH_SHOTS}/${name}`, Buffer.from(await r.arrayBuffer()));
      }
    }
    const steps = first.steps.filter((s) => s.code === "workday_step").map((s) => s.params?.step);
    expect(steps).toEqual(expect.arrayContaining(["My Information", "My Experience", "Application Questions"])); // got past both pages
    // Nothing that My Profile already answers is asked.
    const asked = first.questions.map((q) => q.label).join(" | ");
    expect(asked).not.toMatch(/school|degree|field of study|language|reading|speaking|writing|url|skills|hear about|former employee|phone|name|e-?mail/i);

    const s = experienceSave()!;
    expect(s).toBeTruthy();
    // Education: each school keeps its own degree and field.
    expect(s.edu).toHaveLength(2);
    expect(s.edu[0]).toMatchObject({ school: ["University of Northfield"], degree: "Master's Degree", field: ["Statistics"], lastYear: "2026" }); // the parsed "Bachelor's" was corrected
    expect(s.edu[1]).toMatchObject({ school: ["Southern University of Foreign Studies"], degree: "Bachelor's Degree", field: ["Economics", "Statistics"], lastYear: "2022" });
    // Work: the parsed entry matched (not duplicated), the second one added.
    expect(s.work.map((w) => w.jobTitle)).toEqual(["Data Analyst", "Research Assistant"]);
    // Websites: one row per URL.
    expect(s.web.map((w) => w.url)).toEqual(["https://www.linkedin.com/in/riley-chen-example", "https://riley-chen.example.test", "https://github.com/riley-chen-example"]);
    // Languages: one entry each, with the saved level (native → the scale's top, "Fluent").
    expect(s.lang).toEqual([
      expect.objectContaining({ language: "English", native: true, reading: "Fluent", speaking: "Fluent", writing: "Fluent" }),
      expect.objectContaining({ language: "Mandarin", native: true, reading: "Fluent", speaking: "Fluent", writing: "Fluent" }),
      expect.objectContaining({ language: "French", reading: "Intermediate", speaking: "Intermediate", writing: "Intermediate" }),
    ]);
    expect(s.lang[2].native ?? false).toBe(false);
    // Skills: individual committed tags, equivalents only, no duplicates; Stata isn't offered → skipped.
    expect(s.skills).toEqual(["Microsoft Excel", "SQL", "Python (Programming Language)", "Microsoft Power BI", "R (Programming Language)"]);
    expect(first.filled.find((f) => f.status === "skipped" && /Stata/.test(f.label))).toBeTruthy();
    // Screening: source from the saved job (LinkedIn, inside "Social Media"), prior employment = No.
    expect(s.v.source).toBe("LinkedIn");
    expect(s.v.prev).toBe("No");
  }, 900_000);

  it("a second run on the same draft re-uses everything: no duplicate schools, rows, languages or tags", async () => {
    await api(`/api/apply/attempts/${first.id}/cancel`, { method: "POST" });
    await waitFor(async () => ((await api<AttemptDTO>(`/api/apply/attempts/${first.id}`)).body.state === "cancelled" ? true : null), 60_000);
    const saves = fx.workday.saves.length;
    const again = await settled((await start()).body.id);
    expect(fx.workday.saves.length).toBeGreaterThan(saves);
    const s = experienceSave()!;
    expect(s.edu).toHaveLength(2);
    expect(s.work).toHaveLength(2);
    expect(s.web).toHaveLength(3);
    expect(s.lang).toHaveLength(3);
    expect(new Set(s.skills).size).toBe(s.skills.length);
    expect(s.edu[0].degree).toBe("Master's Degree");
    expect(s.edu[1].degree).toBe("Bachelor's Degree");
    await api(`/api/apply/attempts/${again.id}/cancel`, { method: "POST" });
  }, 400_000);
});
