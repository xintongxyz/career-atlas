// Workday and Indeed end to end: real runtime + real headless browser against SYNTHETIC
// Workday-style and Indeed-style pages on 127.0.0.1 (tests/fixtures). No real employer or Indeed
// page is contacted. "Visible window" logic runs headless here (forceHeadless in the harness).
import type { ApplyOverview, AttemptDTO } from "@shared/apply";
import type { EventDTO, JobDetail, JobListItem } from "@shared/types";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const T = 120_000;

// Fictional applicant.
const PROFILE = {
  contact: { first_name: "Jordan", last_name: "Okoye", email: "jordan.okoye@example.test", phone: "+1 416 555 0142", linkedin_url: "https://www.linkedin.com/in/jordan-okoye-example" },
  based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "permanent_resident" }],
  driver_licence: { has: null, has_vehicle: null },
  education: [{ level: "master", field: "Statistics", institution: "Example University", country: "Canada", completed: true, year: 2024 }],
  experience: [
    { title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: ["analytics"], description: "Dashboards and reporting." },
    { title: "Research Assistant", organization: "Example University", start: "2022-01", end: "2023-12", current: false, areas: ["research"] },
  ],
  skills: ["SQL", "Python", "Stata"],
};

const pdf = (label: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% synthetic resume ${label}\n%%EOF\n`));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function upload(bytes: Uint8Array, name: string, version: string) {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", version);
  const res = await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } });
  return ((await res.json()) as { id: string }).id;
}
async function job(url: string, title: string) {
  const r = await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title, country: "Canada", city: "Toronto", original_url: url }, confirm_duplicate: true } });
  return r.body.id;
}
const start = (jobId: string, body: Record<string, unknown>) => api<AttemptDTO & { error?: { code: string } }>(`/api/jobs/${jobId}/apply`, { method: "POST", json: { confirm: true, submit_mode: "review", ...body } });
const attempt = async (id: string) => (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
const settled = (id: string, states = ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"]) =>
  waitFor(async () => {
    const a = await attempt(id);
    // Visible-window hand-offs are transient here (the "window" times out after a few seconds).
    return states.includes(a.state) && a.stage !== "waiting_for_you" && !["manual_in_browser", "indeed_apply_assisted"].includes(a.intervention ?? "") ? a : null;
  }, 150_000);
const answer = async (id: string, answers: Record<string, unknown>, remember: string[] = []) => (await api<AttemptDTO>(`/api/apply/attempts/${id}/answers`, { method: "POST", json: { answers, remember } })).body;
const detail = async (id: string) => (await api<JobDetail>(`/api/jobs/${id}`)).body;
const keys = (a: AttemptDTO) => a.questions.map((q) => q.key).sort();

// Answers a "user" gives to the questions that appear (anything else is left for the test to inspect).
const COMMON: Record<string, unknown> = {
  "wd:source": "LinkedIn",
  "wd:candidateIsPreviousWorker": "No",
  "wd:phoneType": "Mobile",
  "wd:primaryQuestionnaire--licence": "Yes",
  "wd:primaryQuestionnaire--start": "2026-12-01",
  "wd:gender": "I do not wish to answer",
  "wd:ethnicity": "I do not wish to answer",
  "wd:veteranStatus": "I do not wish to answer",
  "wd:acceptTermsAndAgreements": true,
};
async function answerKnown(a: AttemptDTO, fill: Record<string, unknown>): Promise<AttemptDTO> {
  for (let i = 0; i < 6 && a.state === "needs_review" && a.questions.length && a.questions.every((q) => q.key in fill); i++) {
    a = await settled((await answer(a.id, Object.fromEntries(a.questions.map((q) => [q.key, fill[q.key]])))).id);
  }
  return a;
}

let fx: AtsFixture;
let resumeA: string, resumeB: string, bytesB: Uint8Array;
const logs: string[] = [];
const wd = (variant = "", n = 1) => `${fx.url}/wd/northwind/job/Toronto-ON/Data-Analyst_R10${n}${variant ? `?variant=${variant}` : ""}`;

beforeAll(async () => {
  fx = await startAtsFixture();
  for (const m of ["log", "warn", "error", "info"] as const) {
    const orig = console[m];
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    });
  }
  await api("/api/profile", { method: "PUT", json: { profile: PROFILE } });
  resumeA = await upload(pdf("A"), "Jordan_General.pdf", "General");
  bytesB = pdf("B analytics");
  resumeB = await upload(bytesB, "Jordan_Analytics.pdf", "Analytics");
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("Workday (synthetic multi-step wizard)", () => {
  it("is recognised as a Workday adapter job", async () => {
    const id = await job(wd("", 0), "Workday recognition");
    const ov = (await api<ApplyOverview>(`/api/jobs/${id}/apply`)).body;
    expect(ov.support).toMatchObject({ ats: "workday", mode: "adapter", supported: true });
  });

  it("sign-in required: pauses in the background, never types into the account form; continues after the user signs in", async () => {
    const id = await job(wd("login", 2), "Workday sign-in");
    let a = await settled((await start(id, { resume_document_id: resumeB })).body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "login_required", ats: "workday" });
    expect(fx.workday.authTouched).toEqual([]); // no email, password or honeypot typed
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["detected_ats", "workday_entered"]));

    // The user opens the visible window and signs in themselves (simulated by the page): filling continues.
    const id2 = await job(wd("autologin", 3), "Workday sign-in visible");
    const r2 = await start(id2, { resume_document_id: resumeB });
    a = await settled(r2.body.id);
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/visible`, { method: "POST" })).body;
    a = await settled(a.id);
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["waiting_for_you", "workday_signed_in", "workday_step"]));
    expect(a.state).toBe("needs_review");
    expect(fx.workday.authTouched).toEqual([]);
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, T);

  it("multi-step application: profile data, the user's answers, repeating panels, dates, a conditional question, review, approved submit, verified", async () => {
    const id = await job(wd(), "Data Analyst (Workday)");
    const r = await start(id, { resume_document_id: resumeB });
    expect(r.status).toBe(201);

    // 1. My Information: only what the profile can't answer is asked.
    let a = await settled(r.body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "missing_information" });
    expect(keys(a)).toEqual(["wd:candidateIsPreviousWorker", "wd:phoneType", "wd:source"]);
    expect((await detail(id)).status).toBe("saved");
    a = await answer(a.id, { "wd:source": "LinkedIn", "wd:candidateIsPreviousWorker": "No", "wd:phoneType": "Mobile" }, ["wd:source", "wd:phoneType"]);

    // 2/3. My Experience is filled from the profile; Application Questions asks licence and start date.
    a = await settled(a.id);
    expect(keys(a)).toEqual(["wd:primaryQuestionnaire--licence", "wd:primaryQuestionnaire--start"]);
    expect(a.questions.find((q) => q.key === "wd:primaryQuestionnaire--licence")).toMatchObject({ sensitive: true, options: ["Yes", "No"] });
    expect(a.questions.find((q) => q.key === "wd:primaryQuestionnaire--start")).toMatchObject({ kind: "date" });
    expect(a.steps.filter((s) => s.code === "workday_step").map((s) => s.params?.step)).toEqual(expect.arrayContaining(["My Information", "My Experience", "Application Questions"]));
    expect(fx.workday.uploads.map((u) => u.sha256)).toContain(sha(bytesB));
    a = await answer(a.id, { "wd:primaryQuestionnaire--licence": "Yes", "wd:primaryQuestionnaire--start": "2026-12-01" });

    // 4. Voluntary Disclosures: demographic questions and the terms are the user's decision.
    a = await settled(a.id);
    expect(a.intervention).toBe("approval_needed");
    expect(keys(a)).toEqual(["wd:acceptTermsAndAgreements", "wd:ethnicity", "wd:gender", "wd:veteranStatus"]);
    expect(a.questions.find((q) => q.key === "wd:acceptTermsAndAgreements")?.reason).toBe("legal");
    expect(a.questions.find((q) => q.key === "wd:gender")?.reason).toBe("demographic");
    a = await answer(a.id, { "wd:gender": "I do not wish to answer", "wd:ethnicity": "I do not wish to answer", "wd:veteranStatus": "I do not wish to answer", "wd:acceptTermsAndAgreements": true });

    // 5. Review: waits for approval (review mode), nothing submitted yet.
    a = await settled(a.id);
    expect(a.intervention).toBe("submit_approval");
    expect(a.evidence).toContain("review.png");
    expect(fx.workday.submissions).toHaveLength(0);
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body;
    a = await settled(a.id);
    expect(a.state).toBe("submitted_verified");
    expect(a.confirmation.text).toMatch(/application submitted|you have submitted/i);

    // What Workday received.
    expect(fx.workday.submissions).toHaveLength(1);
    const s = fx.workday.submissions[0] as { v: Record<string, unknown>; work: Record<string, unknown>[]; edu: Record<string, unknown>[]; skills: string[]; resume: string };
    expect(s.v).toMatchObject({
      source: "LinkedIn",
      prev: "false",
      country: "Canada",
      "legalName--firstName": "Jordan",
      "legalName--lastName": "Okoye",
      city: "Toronto",
      region: "Ontario",
      email: "jordan.okoye@example.test",
      phoneType: "Mobile",
      phoneCode: "Canada (+1)",
      linkedin: "https://www.linkedin.com/in/jordan-okoye-example",
      qAuth: "Yes",
      qSponsor: "No",
      qLicence: "yes",
      qStart: "12/01/2026",
      gender: "I do not wish to answer",
      terms: true,
    });
    expect(s.v.qWhy).toBeUndefined(); // conditional question never shown
    expect(s.v.addressLine1 ?? "").toBe(""); // not in the profile → left empty
    expect(s.work).toEqual([
      expect.objectContaining({ jobTitle: "Data Analyst", companyName: "Fabrikam", current: true, startDate: "06/2024" }),
      expect.objectContaining({ jobTitle: "Research Assistant", companyName: "Example University", current: false, startDate: "01/2022", endDate: "12/2023" }),
    ]); // added once, matched on every later run (no duplicates)
    expect(s.edu).toEqual([expect.objectContaining({ school: "Example University", degree: "Master's Degree", field: "Statistics", lastYear: "2024" })]);
    expect(s.skills).toEqual(["SQL", "Python"]); // "Stata" is not offered → not invented
    expect(s.resume).toBe("Jordan_Analytics.pdf");
    expect(fx.workday.authTouched).toEqual([]); // honeypot untouched

    const d = await detail(id);
    expect(d.status).toBe("applied");
    expect(d.application?.applied_via).toBe("Career Atlas automation (Workday)");
    expect(d.application?.resume_document_id).toBe(resumeB);
    const ev = (await api<{ items: EventDTO[] }>(`/api/jobs/${id}/events`)).body.items.filter((e) => e.type === "application_submitted");
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toMatchObject({ attempt_id: a.id, ats: "workday", resume_sha256: sha(bytesB) });
  }, 300_000);

  it("the site rejects a value on Save and Continue: the exact field is asked; nothing is submitted", async () => {
    const id = await job(wd("validate", 4), "Workday validation");
    let a = await settled((await start(id, { resume_document_id: resumeB })).body.id);
    a = await answerKnown(a, COMMON);
    expect(a.questions.map((q) => q.key)).toContain("wd:phoneNumber");
    expect(a.questions.find((q) => q.key === "wd:phoneNumber")).toMatchObject({ reason: "not_accepted" });
    expect(a.error_message).toMatch(/only digits/);
    a = await settled((await answer(a.id, { "wd:phoneNumber": "4165550142" })).id);
    expect(a.steps.filter((s) => s.code === "workday_step").map((s) => s.params?.step)).toContain("My Experience");
    expect(fx.workday.submissions).toHaveLength(1); // still only the earlier verified one
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, T);

  it("resume parsing (Autofill with Resume) is not trusted: other resume removed, extra entries and parsed values confirmed by the user", async () => {
    const id = await job(wd("autofill", 5), "Workday autofill");
    let a = await settled((await start(id, { resume_document_id: resumeB })).body.id);
    // My Information: the parsed street address is shown for confirmation, not silently kept.
    expect(a.questions.find((q) => q.key === "wd:addressLine1")).toMatchObject({ reason: "parsed_unverified", hint: "1 Parsed Street", required: false });
    a = await answerKnown(a, { ...COMMON, "wd:addressLine1": "1 Parsed Street" });
    // My Experience: the parsed entry that is not in My Profile is the user's call.
    const extra = a.questions.find((q) => q.key.startsWith("work_extra:"));
    expect(extra).toMatchObject({ options: ["Keep", "Remove"], reason: "parsed_unverified" });
    expect(extra?.label).toMatch(/Barista — Parsed Café/);
    expect(fx.workday.deletes).toContain("Old_Resume.pdf"); // a different resume is never kept
    expect(fx.workday.uploads.at(-1)?.sha256).toBe(sha(bytesB));
    a = await settled((await answer(a.id, { [extra!.key]: "Remove" })).id);
    const saved = fx.workday.saves.at(-1) as { work: { jobTitle: string }[]; v: Record<string, string> };
    expect(saved.work.map((w) => w.jobTitle)).toEqual(["Data Analyst", "Research Assistant"]);
    expect(saved.v["legalName--firstName"]).toBe("Jordan"); // parsed "Alex" overwritten from My Profile
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 300_000);

  it("ambiguous result after Submit → Unconfirmed, never re-submitted; closed postings fail; cancellation", async () => {
    const id = await job(wd("ambiguous", 6), "Workday ambiguous");
    let a = await settled((await start(id, { resume_document_id: resumeB, submit_mode: "auto" })).body.id);
    a = await answerKnown(a, COMMON);
    expect(a.state).toBe("submission_unconfirmed");
    expect((await detail(id)).status).toBe("saved");
    await runtime.apply.idle();
    expect(fx.workday.submissions).toHaveLength(2); // exactly one more request — no retry
    expect((await start(id, { resume_document_id: resumeB })).body).toMatchObject({ error: { code: "attempt_unconfirmed" } });

    const closed = await job(wd("closed", 7), "Workday closed");
    expect(await settled((await start(closed, { resume_document_id: resumeA })).body.id)).toMatchObject({ state: "failed", error_code: "posting_gone" });
  }, 300_000);
});

describe.skipIf(!ready)("Indeed (synthetic pages; Indeed itself is never automated)", () => {
  const indeed = (type: "company" | "indeed", dest: string, auto: boolean | "click" = true, jk = "0123456789abcdef") => `${fx.url}/indeed/viewjob?jk=${jk}&type=${type}${dest ? `&dest=${encodeURIComponent(dest)}` : ""}${auto === "click" ? "&auto=click" : auto ? "&auto=1" : ""}`;

  it("needs the employer's link or a window; Indeed links can't be pasted as the form", async () => {
    const id = await job(indeed("company", wd("", 8)), "Indeed routing");
    expect((await api<ApplyOverview>(`/api/jobs/${id}/apply`)).body.support).toMatchObject({ mode: "indeed", ats: "indeed", supported: true });
    expect((await start(id, { resume_document_id: resumeA })).body).toMatchObject({ error: { code: "indeed_needs_link_or_window" } });
    expect((await start(id, { resume_document_id: resumeA, target_url: indeed("indeed", "") })).body).toMatchObject({ error: { code: "unsupported_site" } });
  });

  it("Apply on company site → Workday: followed from the user's click, filled, submitted and recorded on the ORIGINAL saved job", async () => {
    const listing = indeed("company", wd("", 9), true, "1111222233334444");
    const id = await job(listing, "Data Analyst (via Indeed)");
    const before = (await api<{ items: JobListItem[] }>("/api/jobs?page_size=100")).body.items.length;
    let a = await settled((await start(id, { resume_document_id: resumeB, indeed_window: true })).body.id);
    expect(a.source_url).toBe(listing);
    expect(a.route).toBe("indeed_company_site");
    expect(a.target_url).toContain("/wd/northwind/job/");
    expect(a.ats).toBe("workday");
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["indeed_waiting", "indeed_resolved", "detected_ats"]));
    a = await answerKnown(a, COMMON);
    expect(a.intervention).toBe("submit_approval");
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    expect(a.state).toBe("submitted_verified");
    const d = await detail(id);
    expect(d.status).toBe("applied");
    expect(d.posting.original_url).toBe(listing); // the saved job still points at the Indeed listing
    expect(d.application?.applied_via).toBe("Career Atlas automation (Workday) via Indeed");
    expect((await api<{ items: JobListItem[] }>("/api/jobs?page_size=100")).body.items.length).toBe(before); // no second job record
    const ov = (await api<ApplyOverview>(`/api/jobs/${id}/apply`)).body;
    expect(ov.support.resolved_url).toContain("/wd/northwind/job/");
    expect(fx.indeed.automationPosts).toEqual([]);
  }, 300_000);

  it("pasted employer link from Indeed → existing Lever adapter; original listing preserved", async () => {
    const listing = indeed("company", "", false, "5555666677778888");
    const id = await job(listing, "Business Analyst (via Indeed)");
    const lever = `${fx.url}/lever/northwind/0b6c0a6e-1111-4222-8333-444455556666/apply`;
    const a = await settled((await start(id, { resume_document_id: resumeA, target_url: lever })).body.id);
    expect(a).toMatchObject({ route: "indeed_company_site", source_url: listing, target_url: lever, ats: "lever", state: "needs_review" });
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, T);

  it("Indeed Apply: assisted only — the user completes it on Indeed; the post-apply page is recorded", async () => {
    const id = await job(indeed("indeed", "", true, "9999000011112222"), "Indeed Apply job");
    const a = await settled((await start(id, { resume_document_id: resumeA, indeed_window: true })).body.id, ["submitted_verified", "failed", "cancelled", "submission_unconfirmed"]);
    expect(a).toMatchObject({ state: "submitted_verified", route: "indeed_apply", confirmation: { source: "page" } });
    expect(a.steps.map((s) => s.code)).toContain("indeed_apply_detected");
    expect(fx.indeed.submissions).toEqual([{ name: "Simulated User", by: "user" }]); // what the user typed, nothing from Career Atlas
    expect(fx.indeed.automationPosts).toEqual([]);
    expect((await detail(id)).application?.applied_via).toBe("Indeed Apply (completed by you, tracked by Career Atlas)");
  }, T);

  it("Indeed Apply not confirmed in the window → the user records the result", async () => {
    const id = await job(indeed("indeed", "", "click", "3333444455556666"), "Indeed Apply manual");
    // The user opens Indeed Apply but the window ends without a confirmation page.
    const r = await start(id, { resume_document_id: resumeA, indeed_window: true });
    let a = await waitFor(async () => {
      const x = await attempt(r.body.id);
      return x.intervention === "confirm_result" || ["failed", "cancelled"].includes(x.state) ? x : null;
    }, 60_000);
    expect(a).toMatchObject({ state: "needs_review", intervention: "confirm_result", route: "indeed_apply" });
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/resolve`, { method: "POST", json: { outcome: "submitted" } })).body;
    expect(a).toMatchObject({ state: "submitted_verified", confirmation: { source: "user" } });
    expect((await detail(id)).status).toBe("applied");
  }, T);

  it("logs never contain personal details", () => {
    const all = logs.join("\n");
    for (const secret of ["jordan.okoye@example.test", "Okoye", "416 555", "linkedin.com/in", "synthetic resume"]) expect(all).not.toContain(secret);
  });
});
