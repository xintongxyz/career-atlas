// Workday and Indeed end to end: real runtime + real headless browser against SYNTHETIC
// Workday-style and Indeed-style pages on 127.0.0.1 (tests/fixtures). No real employer or Indeed
// page is contacted. "Visible window" logic runs headless here (forceHeadless in the harness).
import type { ApplyOverview, AttemptDTO } from "@shared/apply";
import type { JobDetail, JobListItem } from "@shared/types";
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
  // Explicit user preferences (Application Defaults): "worked here before?" → No; phone type → mobile.
  application_defaults: { prior_employment: "no", phone_type: "mobile" },
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
  settledInner(id, states).catch(async (e) => {
    const a = await attempt(id);
    console.log("TIMEOUT", a.state, a.intervention, a.steps.slice(-12).map((x) => `${new Date(x.at).toISOString().slice(14, 23)} ${x.code}`).join(" | "));
    const open = (await runtime.env.DB.prepare("SELECT id, state, intervention, stage, steps FROM application_attempts WHERE state IN ('queued','filling','submitting','needs_review')").all<{ id: string; state: string; intervention: string | null; stage: string | null; steps: string }>()).results;
    for (const o of open) console.log("OPEN", o.id.slice(0, 8), o.state, o.intervention, o.stage, (JSON.parse(o.steps ?? "[]") as { at: number; code: string }[]).slice(-6).map((x) => `${new Date(x.at).toISOString().slice(14, 23)} ${x.code}`).join(" | "));
    throw e;
  });
const settledInner = (id: string, states: string[]) =>
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
  "wd:phoneType": "Mobile Phone",
  "wd:primaryQuestionnaire--licence": "Yes",
  "wd:primaryQuestionnaire--start": "2026-12-01",
  "wd:primaryQuestionnaire--applied": "No",
  "wd:primaryQuestionnaire--coop": "No",
  "wd:gender": "I do not wish to answer",
  "wd:ethnicity": "I do not wish to answer",
  "wd:veteranStatus": "I do not wish to answer",
  "wd:indigenous": "I prefer not to answer",
  "wd:acceptTermsAndAgreements": true,
  "work_conflict:1": "Use My Profile",
  "work_extra:barista parsed café": "Remove",
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
    expect(ov.account).toMatchObject({ available: true, store: "memory", credential: false });
  });

  it("sign-in required without account automation: pauses, never types into the account form; continues after the user signs in", async () => {
    fx.workday.signedIn = false;
    const id = await job(wd("login", 2), "Workday sign-in");
    let a = await settled((await start(id, { resume_document_id: resumeB })).body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "login_required", ats: "workday", account_mode: "none" });
    expect(fx.workday.authTouched).toEqual([]); // no email, password or honeypot typed

    const id2 = await job(wd("autologin", 3), "Workday sign-in visible");
    a = await settled((await start(id2, { resume_document_id: resumeB })).body.id);
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/visible`, { method: "POST" })).body;
    a = await settled(a.id);
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["waiting_for_you", "workday_signed_in", "workday_step"]));
    expect(fx.workday.authTouched).toEqual([]);
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, T);

  it("resume-first: Autofill with Resume, parsed values kept / corrected / flagged, entries reconciled, screening by meaning, review, verified", async () => {
    fx.workday.signedIn = true;
    const id = await job(wd(), "Data Analyst (Workday)");
    const r = await start(id, { resume_document_id: resumeB });
    expect(r.body).toMatchObject({ entry_mode: "autofill", account_mode: "none" });

    // My Information after parsing: correct values kept, the wrong e-mail corrected from My Profile,
    // the parsed street address kept but flagged; "worked with us before" → No (Application Defaults);
    // phone type → "Mobile Phone" (semantic match). Only "How did you hear" is asked.
    let a = await settled(r.body.id);
    expect(a.steps.find((s) => s.code === "workday_entered")?.params).toEqual({ mode: "autofill" });
    expect(fx.workday.uploads[0]?.sha256).toBe(sha(bytesB));
    expect(keys(a)).toEqual(["wd:source"]);
    const st = (label: RegExp) => a.filled.find((f) => label.test(f.label))?.status;
    expect(st(/Given Name/)).toBe("kept");
    expect(st(/Email/)).toBe("corrected");
    expect(a.filled.find((f) => /Address Line 1/.test(f.label))).toMatchObject({ status: "parsed", value: "1 Parsed Street", verified: false });
    a = await answer(a.id, { "wd:source": "LinkedIn" }, ["wd:source"]);

    // My Experience: the parsed entry with a different end date and the parsed entry not in My Profile are the user's decisions.
    a = await settled(a.id);
    expect(keys(a)).toEqual(["work_conflict:1", "work_extra:barista parsed café"]);
    expect(a.questions.find((q) => q.key === "work_conflict:1")?.label).toMatch(/“12\/2022” ≠ “12\/2023”/);
    a = await answer(a.id, { "work_conflict:1": "Use My Profile", "work_extra:barista parsed café": "Remove" });

    // Application Questions: authorization and sponsorship from My Profile; prior application, co-op,
    // licence and start date are NOT inferred (different meanings from prior employment / student status).
    a = await settled(a.id);
    expect(keys(a)).toEqual(["wd:primaryQuestionnaire--applied", "wd:primaryQuestionnaire--coop", "wd:primaryQuestionnaire--licence", "wd:primaryQuestionnaire--start"]);
    expect(a.questions.find((q) => q.key === "wd:primaryQuestionnaire--applied")?.meaning).toBe("prior_application");
    expect(a.questions.find((q) => q.key === "wd:primaryQuestionnaire--coop")?.meaning).toBe("coop_program");
    a = await answer(a.id, { "wd:primaryQuestionnaire--applied": "No", "wd:primaryQuestionnaire--coop": "No", "wd:primaryQuestionnaire--licence": "Yes", "wd:primaryQuestionnaire--start": "2026-12-01" }, ["wd:primaryQuestionnaire--coop"]);

    // Voluntary disclosures: identity questions (incl. Indigenous identity) and the terms are the user's.
    a = await settled(a.id);
    expect(a.intervention).toBe("approval_needed");
    expect(keys(a)).toEqual(["wd:acceptTermsAndAgreements", "wd:ethnicity", "wd:gender", "wd:indigenous", "wd:veteranStatus"]);
    expect(a.questions.find((q) => q.key === "wd:indigenous")).toMatchObject({ reason: "demographic", meaning: "identity", options: ["Yes", "No", "I prefer not to answer"] });
    expect(a.questions.find((q) => q.key === "wd:acceptTermsAndAgreements")).toMatchObject({ reason: "legal", rememberable: false });
    a = await answer(a.id, { "wd:gender": "I do not wish to answer", "wd:ethnicity": "I do not wish to answer", "wd:veteranStatus": "I do not wish to answer", "wd:indigenous": "I prefer not to answer", "wd:acceptTermsAndAgreements": true });

    // Review: waits for approval; nothing submitted yet.
    a = await settled(a.id);
    expect(a.intervention).toBe("submit_approval");
    expect(fx.workday.submissions).toHaveLength(0);
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body;
    a = await settled(a.id);
    expect(a.state).toBe("submitted_verified");

    const s = fx.workday.submissions[0] as { v: Record<string, unknown>; work: Record<string, unknown>[]; edu: Record<string, unknown>[]; skills: string[]; files: string[] };
    expect(s.v).toMatchObject({ email: "jordan.okoye@example.test", addressLine1: "1 Parsed Street", prev: "false", phoneType: "Mobile Phone", region: "Ontario", source: "LinkedIn", qAuth: "Yes", qSponsor: "No", qApplied: "no", qCoop: "No", qStart: "12/01/2026", indigenous: "I prefer not to answer", terms: true });
    expect(s.work.map((w) => [w.jobTitle, w.endDate ?? null])).toEqual([["Data Analyst", null], ["Research Assistant", "12/2023"]]); // corrected, no duplicate, Barista removed
    expect(s.edu).toHaveLength(1);
    expect(s.files).toEqual(["Jordan_Analytics.pdf"]);
    expect(s.skills).toEqual(expect.arrayContaining(["SQL", "Python"]));
    expect(fx.workday.authTouched).toEqual([]);
    expect((await detail(id)).status).toBe("applied");

    // Remembered by meaning: "how did you hear" and co-op status are now Application Defaults.
    const prof = (await api<{ profile: { application_defaults: Record<string, unknown> } }>("/api/profile")).body.profile;
    expect(prof.application_defaults).toMatchObject({ source: "LinkedIn", coop_program: "no", prior_employment: "no", phone_type: "mobile" });
  }, 400_000);

  it("Apply Manually (fallback / chosen): an attachment already on the form is removed only with the user's OK; same name ≠ same file", async () => {
    fx.workday.signedIn = true;
    const id = await job(`${wd("samename", 4)}&samename=Jordan_Analytics.pdf`, "Workday attachments");
    let a = await settled((await start(id, { resume_document_id: resumeB, entry_mode: "manual" })).body.id);
    expect(a.steps.find((s) => s.code === "workday_entered")?.params).toEqual({ mode: "manual" });
    a = await answerKnown(a, COMMON);
    // A file with the selected resume's name is already attached — maybe an older version.
    expect(a.intervention).toBe("approval_needed");
    expect(a.questions[0]).toMatchObject({ key: "attachment:jordan analytics pdf", options: ["Remove", "Keep"] });
    expect(fx.workday.deletes).toEqual([]);
    a = await settled((await answer(a.id, { "attachment:jordan analytics pdf": "Remove" })).id);
    expect(fx.workday.deletes).toEqual(["Jordan_Analytics.pdf"]);
    expect(fx.workday.uploads.at(-1)?.sha256).toBe(sha(bytesB));
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 300_000);

  it("the site rejects a value on Save and Continue: the exact field is asked (live Workday error text); province codes match", async () => {
    fx.workday.signedIn = true;
    const id = await job(wd("validate+codes", 5), "Workday validation");
    let a = await settled((await start(id, { resume_document_id: resumeB, entry_mode: "manual" })).body.id);
    a = await answerKnown(a, COMMON);
    expect(a.questions.map((q) => q.key)).toEqual(["wd:phoneNumber"]);
    expect(a.questions[0]).toMatchObject({ reason: "not_accepted" });
    expect(a.error_message).toMatch(/only digits/);
    const v = (fx.workday.saves.at(-1)?.v ?? {}) as Record<string, string>;
    a = await settled((await answer(a.id, { "wd:phoneNumber": "4165550142" })).id);
    expect(a.steps.filter((s) => s.code === "workday_step").map((s) => s.params?.step)).toContain("My Experience");
    expect(((fx.workday.saves.at(-1)?.v ?? v) as Record<string, string>).region).toBe("ON"); // Ontario ↔ ON in a province field
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 300_000);

  it("ambiguous result after Submit → Unconfirmed, never re-submitted; closed postings fail", async () => {
    fx.workday.signedIn = true;
    const before = fx.workday.submissions.length;
    const id = await job(wd("ambiguous", 6), "Workday ambiguous");
    let a = await settled((await start(id, { resume_document_id: resumeB, submit_mode: "auto" })).body.id);
    a = await answerKnown(a, COMMON);
    // Values only resume parsing provided (the street address) hold automatic submission for review.
    expect(a).toMatchObject({ intervention: "submit_approval", error_code: "parsed_values_need_review" });
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    expect(a.state).toBe("submission_unconfirmed");
    expect((await detail(id)).status).toBe("saved");
    await runtime.apply.idle();
    expect(fx.workday.submissions.length).toBe(before + 1); // exactly one request — no retry
    expect((await start(id, { resume_document_id: resumeB })).body).toMatchObject({ error: { code: "attempt_unconfirmed" } });

    const closed = await job(wd("closed", 7), "Workday closed");
    expect(await settled((await start(closed, { resume_document_id: resumeA })).body.id)).toMatchObject({ state: "failed", error_code: "posting_gone" });
  }, 400_000);
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
    expect(a.entry_mode).toBe("autofill");
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
