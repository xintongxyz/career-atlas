// Automated applications end to end: real runtime + real headless browser (Playwright) against
// SYNTHETIC Greenhouse/Lever-style forms on 127.0.0.1. No real employer is contacted.
import type { ApplyOverview, AttemptDTO } from "@shared/apply";
import type { ProfileDTO } from "@shared/profile";
import type { EventDTO, JobDetail, JobListItem } from "@shared/types";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { env, runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const T = 60_000;

// Fictional applicant.
const PROFILE = {
  contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test", phone: "+1 416 555 0142", linkedin_url: "https://www.linkedin.com/in/alex-rivera-example" },
  based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "permanent_resident" }],
  driver_licence: { has: null, has_vehicle: null },
  languages: [{ language: "English", level: "fluent" }],
  education: [{ level: "master", field: "Statistics", institution: "Example University", country: "Canada", completed: true, year: 2024 }],
  experience: [{ title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: ["analytics"] }],
  skills: ["SQL", "Python"],
};

const pdf = (label: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% synthetic resume ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function upload(bytes: Uint8Array, name: string, version: string, type = "application/pdf", kind = "resume") {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  form.set("kind", kind);
  form.set("version_name", version);
  const res = await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function job(url: string, title: string) {
  const r = await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title, country: "Canada", city: "Toronto", original_url: url, apply_url: url }, confirm_duplicate: true } });
  expect(r.status).toBe(201);
  return r.body.id;
}

const start = (jobId: string, resume: string, mode: "auto" | "review" = "auto") => api<AttemptDTO & { error?: { code: string } }>(`/api/jobs/${jobId}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: mode, confirm: true } });
const attempt = async (id: string) => (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
const settled = (id: string, states = ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"]) =>
  waitFor(async () => {
    const a = await attempt(id);
    return states.includes(a.state) ? a : null;
  }, 45_000);
const detail = async (id: string) => (await api<JobDetail>(`/api/jobs/${id}`)).body;

let fx: AtsFixture;
let resumeA: string, resumeB: string, bytesB: Uint8Array;
const logs: string[] = [];

beforeAll(async () => {
  fx = await startAtsFixture();
  for (const m of ["log", "warn", "error", "info"] as const) {
    const orig = console[m];
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    });
  }
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("automated applications (synthetic forms, headless browser)", () => {
  it("refuses to start until the profile has a name and email; lists every resume version", async () => {
    const gh = await job(`${fx.url}/greenhouse/northwind/jobs/1001`, "Data Analyst");
    resumeA = await upload(pdf("A"), "Alex_Rivera_General.pdf", "General 2026");
    bytesB = pdf("B — analytics");
    resumeB = await upload(bytesB, "Alex_Rivera_Analytics.pdf", "Analytics focus");
    await upload(pdf("C"), "Resume_C.pdf", "Research");
    await upload(pdf("D"), "Resume_D.pdf", "Finance");
    await upload(pdf("E"), "Resume_E.pdf", "Short");
    await upload(new Uint8Array(Buffer.from("plain text resume")), "resume.txt", "Plain text", "text/plain");
    await upload(pdf("CL"), "Cover.pdf", "Cover letter", "application/pdf", "cover_letter");

    const ov = (await api<ApplyOverview>(`/api/jobs/${gh}/apply`)).body;
    expect(ov.resumes).toHaveLength(6); // all resume versions, no cover letters, no hard-coded limit
    expect(ov.resumes.find((r) => r.file_name === "resume.txt")?.uploadable).toBe(false);
    expect(ov.support).toMatchObject({ mode: "detect", supported: true });
    expect(ov.worker.available).toBe(true);
    expect(ov.profile_check.find((c) => c.key === "email")).toMatchObject({ ok: false, required: true });

    expect((await start(gh, resumeB)).body).toMatchObject({ error: { code: "profile_incomplete" } });
    await api<ProfileDTO>("/api/profile", { method: "PUT", json: { profile: PROFILE } });
    expect((await api(`/api/jobs/${gh}/apply`, { method: "POST", json: { resume_document_id: resumeB, submit_mode: "auto" } })).status).toBe(422); // no explicit confirmation
    const txt = ov.resumes.find((r) => r.file_name === "resume.txt")!.id;
    expect((await start(gh, txt)).status).toBe(415);
    const cover = (await api<{ items: { id: string; kind: string }[] }>("/api/documents")).body.items.find((d) => d.kind === "cover_letter")!.id;
    expect((await start(gh, cover)).status).toBe(404);
    expect((await start(gh, "no-such-doc")).status).toBe(404);
  });

  it("Greenhouse-style form: fills from the profile, pauses for unknown and legal questions, then submits the SELECTED resume and verifies", async () => {
    const gh = (await api<{ items: JobListItem[] }>("/api/jobs?q=Data%20Analyst")).body.items[0].id;
    const r = await start(gh, resumeB);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: "queued", resume: { id: resumeB, file_name: "Alex_Rivera_Analytics.pdf", sha256: sha(bytesB) } });

    let a = await settled(r.body.id);
    expect(a.state).toBe("needs_review");
    expect(a.intervention).toBe("approval_needed");
    const keys = a.questions.map((q) => q.key).sort();
    expect(keys).toEqual(["name:question_105", "name:question_108"]); // "how did you hear" (open) + certification (legal)
    expect(a.questions.find((q) => q.key === "name:question_108")).toMatchObject({ reason: "legal", sensitive: true });
    expect(fx.submissions).toHaveLength(0);
    expect((await detail(gh)).status).toBe("saved"); // starting never marks Applied

    // Shown on All Positions and Kanban without touching the pipeline status.
    const row = (await api<{ items: JobListItem[] }>("/api/jobs?q=Data%20Analyst")).body.items[0];
    expect(row).toMatchObject({ status: "saved", automation: { state: "needs_review", intervention: "approval_needed" } });
    const board = (await api<{ items: JobListItem[] }>("/api/board")).body.items.find((i) => i.id === gh);
    expect(board?.automation?.state).toBe("needs_review");

    // Starting a second attempt while one is pending is refused.
    expect((await start(gh, resumeA)).body).toMatchObject({ error: { code: "attempt_active" } });

    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/answers`, { method: "POST", json: { answers: { "name:question_105": "Company website", "name:question_108": true }, remember: ["name:question_105", "name:question_108"] } })).body;
    expect(a.state).toBe("queued");
    a = await settled(a.id);
    expect(a.state).toBe("submitted_verified");
    expect(a.confirmation).toMatchObject({ source: "page" });
    expect(a.confirmation.url).toMatch(/\/confirmation$/);
    expect(a.confirmation.text).toMatch(/Thank you for applying/);
    expect(a.evidence).toContain("confirmation.png");

    expect(fx.submissions).toHaveLength(1);
    const s = fx.submissions[0];
    expect(s.fields).toMatchObject({
      first_name: "Alex",
      last_name: "Rivera",
      email: "alex.rivera@example.test",
      phone: "+1 416 555 0142",
      "candidate-location": "Toronto, Ontario, Canada", // not "Toronto, Ohio"
      question_101: "https://www.linkedin.com/in/alex-rivera-example",
      question_103: "Yes", // permanent resident → authorised
      question_104: "No", // permanent resident → no sponsorship
      question_105: "Company website",
      question_107: "Master's Degree",
      question_108: "1",
    });
    // Voluntary self-identification is never answered; optional unknowns stay empty.
    expect(s.fields.gender).toBe("");
    expect(s.fields.veteran_status).toBe("");
    expect(s.fields.question_102).toBe("");
    expect(s.fields["question_106[]"]).toBeUndefined();
    // Exactly the selected resume, byte for byte; nothing in the cover-letter slot.
    expect(s.files).toEqual([expect.objectContaining({ field: "resume", filename: "Alex_Rivera_Analytics.pdf", sha256: sha(bytesB) })]);

    // Pipeline: Applied through changeStatus, with the attempt and resume recorded.
    const d = await detail(gh);
    expect(d.status).toBe("applied");
    expect(d.application?.resume_document_id).toBe(resumeB);
    expect(d.application?.applied_via).toMatch(/Career Atlas automation/);
    const events = (await api<{ items: EventDTO[] }>(`/api/jobs/${gh}/events`)).body.items;
    const submitted = events.filter((e) => e.type === "application_submitted");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].metadata).toMatchObject({ via: "automation", attempt_id: a.id, resume_sha256: sha(bytesB) });

    // Remembered answers were saved to the profile only because they were ticked.
    const prof = (await api<ProfileDTO>("/api/profile")).body.profile;
    expect(prof.saved_answers.map((x) => x.question)).toEqual(expect.arrayContaining(["How did you hear about this job? *"]));

    // A verified job can't be applied to again.
    expect((await start(gh, resumeA)).body).toMatchObject({ error: { code: "already_applied" } });
    expect(fx.submissions).toHaveLength(1);
  }, T);

  it("Lever-style form in review mode: asks what the profile doesn't say, waits for approval, then submits", async () => {
    const lv = await job(`${fx.url}/lever/northwind/0b6c0a6e-1111-4222-8333-444455556666/apply`, "Business Analyst");
    const r = await start(lv, resumeA, "review");
    let a = await settled(r.body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "missing_information" });
    // Driver's licence is "not specified" in the profile → asked, never answered "No".
    expect(a.questions).toEqual([expect.objectContaining({ label: expect.stringMatching(/driver's license/), kind: "radio", options: ["Yes", "No"], sensitive: true })]);
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/answers`, { method: "POST", json: { answers: { [a.questions[0].key]: "Yes" }, remember: [] } })).body;
    a = await settled(a.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    expect(a.filled.length).toBeGreaterThan(5);
    expect(a.filled.every((f) => !("value" in f))).toBe(true); // values are never stored in the attempt
    expect(fx.submissions).toHaveLength(1); // nothing sent yet
    a = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body;
    a = await settled(a.id);
    expect(a.state).toBe("submitted_verified");
    expect(a.confirmation.url).toMatch(/\/thanks$/);
    const s = fx.submissions[1];
    expect(s.fields).toMatchObject({ name: "Alex Rivera", email: "alex.rivera@example.test", org: "Fabrikam", "urls[LinkedIn]": "https://www.linkedin.com/in/alex-rivera-example", "eeo[gender]": "", "eeo[race]": "" });
    expect(Object.entries(s.fields).find(([k]) => k.endsWith("[field0]"))?.[1]).toBe("Yes");
    expect(Object.entries(s.fields).find(([k]) => k.endsWith("[field1]"))?.[1]).toBe("Yes");
    expect(s.files[0]).toMatchObject({ field: "resume", filename: "Alex_Rivera_General.pdf" });
    expect((await detail(lv)).status).toBe("applied");
    // The remembered certification is not reused for this unrelated question set.
    const prof = (await api<ProfileDTO>("/api/profile")).body.profile;
    expect(prof.saved_answers.some((x) => /driver/i.test(x.question))).toBe(false);
  }, T);

  it("multi-step form, with approved saved answers reused", async () => {
    const id = await job(`${fx.url}/greenhouse/northwind/jobs/1002?variant=multistep`, "Data Analyst II");
    const a = await settled((await start(id, resumeB)).body.id);
    expect(a.state).toBe("submitted_verified");
    expect(a.steps.map((s) => s.code)).toContain("next_step");
    expect(fx.submissions.at(-1)?.fields.question_105).toBe("Company website");
    expect(a.filled.find((f) => f.label.startsWith("How did you hear"))?.source).toBe("saved_answer");
  }, T);

  it("ambiguous result → Unconfirmed, never re-submitted; the user resolves it", async () => {
    const id = await job(`${fx.url}/greenhouse/northwind/jobs/1003?variant=ambiguous`, "Data Analyst III");
    const before = fx.submissions.length;
    const a = await settled((await start(id, resumeB)).body.id);
    expect(a.state).toBe("submission_unconfirmed");
    expect(a.submit_clicked_at).toBeTypeOf("number");
    expect((await detail(id)).status).toBe("saved"); // not Applied without confirmation
    await runtime.apply.idle();
    expect(fx.submissions.length).toBe(before + 1); // exactly one submission, no automatic retry
    expect((await start(id, resumeB)).body).toMatchObject({ error: { code: "attempt_unconfirmed" } });
    expect((await api(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).status).toBe(409);
    const list = (await api<{ items: JobListItem[] }>("/api/jobs?q=Data%20Analyst%20III")).body.items[0];
    expect(list.automation?.state).toBe("submission_unconfirmed");

    const resolved = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}/resolve`, { method: "POST", json: { outcome: "submitted" } })).body;
    expect(resolved).toMatchObject({ state: "submitted_verified", confirmation: { source: "user" } });
    expect((await detail(id)).status).toBe("applied");
  }, T);

  it("a site that rejects the form, a CAPTCHA, and an unsupported page all stop without submitting", async () => {
    const before = fx.submissions.length;
    const v = await job(`${fx.url}/greenhouse/northwind/jobs/1004?variant=validate`, "Validation test");
    const a = await settled((await start(v, resumeB)).body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "validation_errors" });
    expect(a.error_message).toMatch(/Phone number is not valid/);

    const c = await job(`${fx.url}/greenhouse/northwind/jobs/1005?variant=captcha`, "Captcha test");
    const b = await settled((await start(c, resumeB)).body.id);
    expect(b).toMatchObject({ state: "needs_review", intervention: "captcha", submit_clicked_at: null });

    const o = await job(`${fx.url}/other/careers`, "Unsupported site");
    const u = await settled((await start(o, resumeB)).body.id);
    expect(u).toMatchObject({ state: "failed", error_code: "unsupported_site" });
    expect(u.filled).toEqual([]);

    expect(fx.submissions.length).toBe(before);
    for (const j of [v, c, o]) expect((await detail(j)).status).toBe("saved");
    // Cancelling a paused attempt.
    expect((await api<AttemptDTO>(`/api/apply/attempts/${b.id}/cancel`, { method: "POST" })).body.state).toBe("cancelled");
  }, T);

  it("cancellation while filling; a missing or changed resume is never substituted", async () => {
    const before = fx.submissions.length;
    const slow = await job(`${fx.url}/greenhouse/northwind/jobs/1006?delay=4000`, "Slow page");
    const r = await start(slow, resumeB);
    await waitFor(async () => ((await attempt(r.body.id)).state === "filling" ? true : null));
    await api(`/api/apply/attempts/${r.body.id}/cancel`, { method: "POST" });
    expect((await settled(r.body.id)).state).toBe("cancelled");

    // Review mode → paused before submit → the resume is deleted → approval → fails, nothing sent.
    const tmp = await upload(pdf("temp"), "Temp.pdf", "Temporary");
    const g = await job(`${fx.url}/greenhouse/northwind/jobs/1007`, "Missing resume");
    let a = await settled((await start(g, tmp, "review")).body.id);
    expect(a.intervention).toBe("submit_approval");
    await api(`/api/documents/${tmp}`, { method: "DELETE" });
    await api(`/api/apply/attempts/${a.id}/approve`, { method: "POST" });
    a = await settled(a.id, ["failed", "submitted_verified", "submission_unconfirmed"]);
    expect(a).toMatchObject({ state: "failed", error_code: "resume_unavailable", resume: { file_name: "Temp.pdf", still_available: false } });

    // A file changed on disk behind Career Atlas' back is refused at start.
    const changed = await upload(pdf("orig"), "Changed.pdf", "Changed");
    const row = (await env.DB.prepare("SELECT r2_key FROM documents WHERE id = ?").bind(changed).first<{ r2_key: string }>())!;
    writeFileSync(join(runtime.cfg.documentsDir, row.r2_key), pdf("tampered"));
    const h = await job(`${fx.url}/greenhouse/northwind/jobs/1008`, "Changed resume");
    expect((await start(h, changed)).body).toMatchObject({ error: { code: "resume_file_changed" } });
    expect(fx.submissions.length).toBe(before);
  }, T);

  it("restart recovery: an interrupted submission becomes Unconfirmed; an interrupted fill starts again", async () => {
    const now = Date.now();
    const user = (await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>())!.id;
    const mk = async (title: string, state: string, url: string) => {
      const jid = await job(url, title);
      const sj = (await env.DB.prepare("SELECT job_posting_id FROM saved_jobs WHERE id = ?").bind(jid).first<{ job_posting_id: string }>())!;
      const id = `rec-${state}-${now}`;
      await env.DB.prepare(
        "INSERT INTO application_attempts (id, user_id, saved_job_id, job_posting_id, resume_document_id, resume_sha256, resume_file_name, resume_version_name, resume_mime_type, resume_size_bytes, target_url, state, submit_mode, submit_authorized, submit_clicked_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(id, user, jid, sj.job_posting_id, resumeB, sha(bytesB), "Alex_Rivera_Analytics.pdf", "Analytics focus", "application/pdf", bytesB.byteLength, url, state, "auto", state === "submitting" ? 0 : 1, state === "submitting" ? now : null, now, now)
        .run();
      return { jid, id };
    };
    const before = fx.submissions.length;
    const sub = await mk("Recovery submitting", "submitting", `${fx.url}/greenhouse/northwind/jobs/1009`);
    const fill = await mk("Recovery filling", "filling", `${fx.url}/greenhouse/northwind/jobs/1010`);
    const res = await runtime.apply.recover();
    expect(res).toMatchObject({ unconfirmed: 1, requeued: 1 });
    expect((await attempt(sub.id)).state).toBe("submission_unconfirmed");
    expect((await settled(fill.id)).state).toBe("submitted_verified");
    expect(fx.submissions.length).toBe(before + 1); // only the never-submitted one ran
    expect((await detail(sub.jid)).status).toBe("saved");
    expect((await detail(fill.jid)).status).toBe("applied");
  }, T);

  it("attempt history is kept per job, and logs never contain personal details", async () => {
    const id = (await api<{ items: JobListItem[] }>("/api/jobs?q=Missing%20resume")).body.items[0].id;
    const ov = (await api<ApplyOverview>(`/api/jobs/${id}/apply`)).body;
    expect(ov.attempts).toHaveLength(1);
    expect(ov.attempts[0].steps.length).toBeGreaterThan(2);
    const all = logs.join("\n");
    for (const secret of ["alex.rivera@example.test", "Rivera", "416 555", "linkedin.com/in", "Company website", "synthetic resume"]) expect(all).not.toContain(secret);
  });
});
