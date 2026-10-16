// Interaction patterns met on live career sites (2026-10-15), reproduced on SYNTHETIC pages
// (tests/fixtures/patterns-fixture.ts): an application inside an iframe with a login step, Apply in a
// new tab, a form behind an "Apply" tab, and repeated employment / education blocks with split dates.
// Fictional applicant; review mode — nothing is submitted unless a test approves it on purpose.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
let fx: AtsFixture;
let resume: string;

const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 180_000);
const run = async (path: string, title: string) => {
  const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title, country: "Canada", original_url: `${fx.url}${path}` }, confirm_duplicate: true } })).body.id;
  return settled((await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
};

beforeAll(async () => {
  fx = await startAtsFixture();
  await api("/api/profile", {
    method: "PUT",
    json: {
      profile: {
        contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test" },
        experience: [
          { title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: [] },
          { title: "Research Assistant", organization: "Example Institute", start: "2022-09", end: "2023-08", current: false, areas: [] },
        ],
        education: [{ level: "master", field: "Statistics", institution: "University of Northfield", completed: true, year: 2024 }],
      },
    },
  });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Alex.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Alex");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("career-site patterns (synthetic)", () => {
  it("posting inside an iframe: works in the frame, opens Apply, stops at the account step without typing", async () => {
    const a = await run("/pat/embed/1", "Embedded");
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["opened_embedded_form"]));
    expect(a).toMatchObject({ state: "needs_review", intervention: "login_required" });
    expect(a.filled.filter((f) => f.verified)).toEqual([]); // nothing typed into the login step
  }, 240_000);

  it("Apply opens a new tab: the application is filled in that tab", async () => {
    const a = await run("/pat/tab/1", "New tab");
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["followed_new_tab"]));
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
  }, 240_000);

  it("a newsletter box on the posting is not the application: the Apply tab is opened and its form filled", async () => {
    const a = await run("/pat/inline/1", "Apply tab");
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    expect(a.filled.some((f) => /email/i.test(f.label) && f.verified)).toBe(true);
  }, 240_000);

  it("repeated employment / education blocks: each entry, split month/year dates, Add another, verified at submission", async () => {
    let a = await run("/pat/emp/1", "Blocks");
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    const sub = fx.submissions.find((s) => s.path === "/pat/emp/1/submit")!;
    expect(sub.fields).toMatchObject({
      company_name_0: "Fabrikam",
      title_0: "Data Analyst",
      start_month_0: "June",
      start_year_0: "2024",
      current_0: "1",
      company_name_1: "Example Institute",
      title_1: "Research Assistant",
      start_month_1: "September",
      start_year_1: "2022",
      end_month_1: "August",
      end_year_1: "2023",
      school_0: "University of Northfield",
      degree_0: "Master's Degree",
      discipline_0: "Statistics",
    });
    expect(sub.fields.end_month_0 ?? "").toBe(""); // current role: no end date
  }, 300_000);
});
