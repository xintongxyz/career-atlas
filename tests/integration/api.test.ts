import { env, SELF } from "./harness";
import { describe, expect, it } from "vitest";
import type { DashboardDTO, EventDTO, ExtractionDTO, JobDetail, JobListItem } from "../../src/shared/types";
import { api, manualJob, waitFor } from "./helpers";

type Created = { id: string; job_posting_id: string };

describe("Test 1 — manual job creation & persistence", () => {
  it("creates a job with company, salary and location and reads it back", async () => {
    const created = await api<Created>("/api/jobs", { method: "POST", json: manualJob() });
    expect(created.status).toBe(201);
    const detail = await api<JobDetail>(`/api/jobs/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.company.name).toBe("Northwind Analytics");
    expect(detail.body.posting.title).toBe("Data Analyst");
    expect(detail.body.posting.city).toBe("Toronto");
    expect(detail.body.posting.salary).toMatchObject({ min: 70000, max: 85000, currency: "CAD", period: "annually", source: "employer" });
    expect(detail.body.status).toBe("saved");
    // Persisted in the database (not memory): a direct query sees the row.
    const row = await env.DB.prepare("SELECT title FROM job_postings WHERE id = ?").bind(created.body.job_posting_id).first<{ title: string }>();
    expect(row?.title).toBe("Data Analyst");
  });

  it("rejects invalid input with a structured 422 error", async () => {
    const res = await api<{ error: { code: string } }>("/api/jobs", { method: "POST", json: { job: { company_name: "", title: "" } } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
  });

  it("rejects min salary greater than max", async () => {
    const res = await api("/api/jobs", { method: "POST", json: manualJob({ title: "Bad salary", salary: { min: 90000, max: 10000, currency: "CAD", period: "annually", source: "employer" } }) });
    expect(res.status).toBe(422);
  });
});

describe("Test 3 — partial extraction never invents salary", () => {
  it("extracts pasted text without salary and leaves salary unknown", async () => {
    const text = `Junior Data Analyst
Maple Leaf Robotics — Toronto, ON

About the role
We are hiring a Junior Data Analyst to support our operations team. This is a hybrid role; employees work from our Toronto office three days per week.

Responsibilities:
• Build dashboards in Tableau
• Write SQL queries to analyse production data

Requirements:
• 2+ years of experience in data analysis
• Proficiency in SQL and Python
• Must be legally authorized to work in Canada`;
    const cap = await api<{ saved_job_id: string; extraction_id: string }>("/api/jobs/capture", { method: "POST", json: { text } });
    expect(cap.status).toBe(202);
    const ex = await waitFor(async () => {
      const r = await api<ExtractionDTO>(`/api/extractions/${cap.body.extraction_id}`);
      return ["succeeded", "partial", "needs_review", "failed", "access_restricted"].includes(r.body.status) ? r.body : null;
    });
    expect(["partial", "needs_review", "succeeded"]).toContain(ex.status);
    const f = ex.result!.fields;
    expect(f.salary).toBeUndefined();
    expect(f.work_mode?.value).toBe("hybrid");
    expect(f.work_mode?.evidence).toContain("three days per week");
    expect(f.hybrid_frequency?.value).toMatch(/three days per week/i);
    expect(f.work_authorization?.evidence).toContain("legally authorized to work in Canada");
    // Authorization requirement must NOT be turned into a sponsorship claim.
    expect(f.visa_sponsorship).toBeUndefined();
    expect(f.years_experience_min?.value).toBe(2);
    expect((f.responsibilities?.value as string[]).length).toBe(2);

    // Original JD is preserved immediately, before any review.
    const detail = await api<JobDetail>(`/api/jobs/${cap.body.saved_job_id}`);
    expect(detail.body.posting.description_text).toContain("Build dashboards in Tableau");

    // Apply with review: salary remains "not disclosed".
    const applied = await api(`/api/extractions/${ex.id}/apply`, {
      method: "POST",
      json: { fields: { title: "Junior Data Analyst", company_name: "Maple Leaf Robotics", work_mode: "hybrid", work_authorization: f.work_authorization!.value }, review_later: ["work_authorization"] },
    });
    expect(applied.status).toBe(200);
    const after = await api<JobDetail>(`/api/jobs/${cap.body.saved_job_id}`);
    expect(after.body.posting.salary).toBeNull();
    expect(after.body.company.name).toBe("Maple Leaf Robotics");
    const ev = after.body.evidence.find((e) => e.field === "work_authorization");
    expect(ev?.review_status).toBe("needs_review");
    expect(after.body.evidence.find((e) => e.field === "work_mode")?.review_status).toBe("confirmed");
  });
});

describe("Test 4 — duplicate detection", () => {
  it("warns on the same URL and allows explicit continue", async () => {
    const url = "https://boards.greenhouse.io/exampleco/jobs/4012345?gh_src=abc&utm_source=linkedin";
    const first = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ title: "Product Analyst", original_url: url }) });
    expect(first.status).toBe(201);
    const second = await api<{ error: { code: string; details: { matches: { reason: string; id: string }[] } } }>("/api/jobs", {
      method: "POST",
      json: manualJob({ title: "Product Analyst (copy)", original_url: "https://boards.greenhouse.io/exampleco/jobs/4012345" }),
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("possible_duplicate");
    expect(second.body.error.details.matches[0].id).toBe(first.body.id);
    expect(["same_external_id", "same_url"]).toContain(second.body.error.details.matches[0].reason);
    const capture = await api<{ error: { code: string } }>("/api/jobs/capture", { method: "POST", json: { url } });
    expect(capture.status).toBe(409);
    const forced = await api("/api/jobs", { method: "POST", json: { ...manualJob({ title: "Product Analyst", original_url: url }), confirm_duplicate: true } });
    expect(forced.status).toBe(201);
  });

  it("flags same company + title + city as a possible duplicate", async () => {
    await api("/api/jobs", { method: "POST", json: manualJob({ company_name: "Contoso Ltd", title: "BI Developer", city: "Ottawa" }) });
    const dup = await api<{ matches: { reason: string }[] }>("/api/jobs/check-duplicates", { method: "POST", json: { company_name: "Contoso", title: "BI Developer", city: "Ottawa" } });
    expect(dup.body.matches.some((m) => m.reason === "similar")).toBe(true);
  });
});

describe("Test 5 & 6 — application tracking and status history", () => {
  it("saved jobs are not applications; applying updates dashboard; history is preserved", async () => {
    const before = await api<DashboardDTO>("/api/dashboard");
    const created = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Fabrikam", title: "Analytics Engineer" }) });
    const mid = await api<DashboardDTO>("/api/dashboard");
    expect(mid.body.counts.saved_total).toBe(before.body.counts.saved_total + 1);
    expect(mid.body.counts.applications_total).toBe(before.body.counts.applications_total);

    const appliedAt = Date.UTC(2026, 9, 1, 14, 0);
    const r1 = await api<{ to: string; changed: boolean }>(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "applied", occurred_at: appliedAt } });
    expect(r1.body.changed).toBe(true);
    const after = await api<DashboardDTO>("/api/dashboard");
    expect(after.body.counts.applications_total).toBe(before.body.counts.applications_total + 1);
    expect(after.body.counts.awaiting_response).toBe(before.body.counts.awaiting_response + 1);
    const detail = await api<JobDetail>(`/api/jobs/${created.body.id}`);
    expect(detail.body.application?.applied_at).toBe(appliedAt);
    expect(detail.body.application?.next_follow_up_at).toBe(appliedAt + 7 * 86_400_000);

    await api(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "interview", occurred_at: appliedAt + 5 * 86_400_000 } });
    await api(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "rejected", occurred_at: appliedAt + 12 * 86_400_000 } });

    const events = await api<{ items: EventDTO[] }>(`/api/jobs/${created.body.id}/events`);
    const transitions = events.body.items.filter((e) => e.type === "status_changed" || e.type === "application_submitted").map((e) => `${e.from_status}->${e.to_status}`);
    expect(transitions).toEqual(["interview->rejected", "applied->interview", "saved->applied"]);
    const final = await api<JobDetail>(`/api/jobs/${created.body.id}`);
    expect(final.body.status).toBe("rejected");
    expect(final.body.application?.reached_interview_at).toBe(appliedAt + 5 * 86_400_000);
    expect(final.body.application?.final_outcome_at).toBe(appliedAt + 12 * 86_400_000);
    // Auto follow-up reminder is completed once the application is finished.
    expect(final.body.application?.next_follow_up_at).toBeNull();

    // Rejected-after-interview still counts as an interview in analytics.
    const analytics = await api<{ rates: { interview_rate: { numerator: number } } }>(`/api/analytics?from=${appliedAt - 1}&to=${appliedAt + 1}`);
    expect(analytics.body.rates.interview_rate.numerator).toBe(1);
  });

  it("refuses to move an application back to a pre-application stage", async () => {
    const created = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Tailspin", title: "Data Engineer" }) });
    await api(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "applied" } });
    const back = await api<{ error: { code: string } }>(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "saved" } });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe("application_exists");
  });

  it("archive and restore are recorded and reversible", async () => {
    const created = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Litware", title: "Analyst" }) });
    await api(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "archived" } });
    let d = await api<JobDetail>(`/api/jobs/${created.body.id}`);
    expect(d.body.status).toBe("archived");
    await api("/api/jobs/bulk", { method: "POST", json: { ids: [created.body.id], action: { type: "restore" } } });
    d = await api<JobDetail>(`/api/jobs/${created.body.id}`);
    expect(d.body.status).toBe("saved");
  });
});

describe("filters and manual overrides", () => {
  it("salary filter only compares the same currency and period and reports exclusions", async () => {
    await api("/api/jobs", { method: "POST", json: manualJob({ company_name: "SalaryCo A", title: "Role A", salary: { min: 60000, max: 75000, currency: "CAD", period: "annually", source: "employer" } }) });
    await api("/api/jobs", { method: "POST", json: manualJob({ company_name: "SalaryCo B", title: "Role B", salary: { min: 45, max: 55, currency: "CAD", period: "hourly", source: "employer" } }) });
    await api("/api/jobs", { method: "POST", json: manualJob({ company_name: "SalaryCo C", title: "Role C", salary: null }) });
    const res = await api<{ items: JobListItem[]; salary_filter: { excluded_unknown: number; excluded_not_comparable: number } }>(
      "/api/jobs?q=SalaryCo&salary_min=70000&salary_currency=CAD&salary_period=annually",
    );
    expect(res.body.items.map((i) => i.company_name)).toEqual(["SalaryCo A"]);
    expect(res.body.salary_filter.excluded_unknown).toBe(1);
    expect(res.body.salary_filter.excluded_not_comparable).toBe(1);
  });

  it("editing an extracted field records an override that keeps the original value", async () => {
    const text = "Senior Platform Engineer\n\nThis is a fully remote position open to candidates located in Canada. Compensation: CAD $120,000 - $140,000 per year. We are unable to sponsor visas for this role.";
    const cap = await api<{ saved_job_id: string; extraction_id: string }>("/api/jobs/capture", { method: "POST", json: { text } });
    const ex = await waitFor(async () => {
      const r = await api<ExtractionDTO>(`/api/extractions/${cap.body.extraction_id}`);
      return r.body.result ? r.body : null;
    });
    expect(ex.result!.fields.salary?.value).toMatchObject({ min: 120000, max: 140000, currency: "CAD", period: "annually" });
    expect(ex.result!.fields.visa_sponsorship?.value).toBe("not_available");
    expect(ex.result!.fields.remote_eligible_regions?.value).toEqual(["Canada"]);
    await api(`/api/extractions/${ex.id}/apply`, { method: "POST", json: { fields: { title: "Senior Platform Engineer", company_name: "Remote Co", work_mode: "remote" } } });
    await api(`/api/jobs/${cap.body.saved_job_id}`, { method: "PATCH", json: { job: { work_mode: "hybrid" } } });
    const d = await api<JobDetail>(`/api/jobs/${cap.body.saved_job_id}`);
    expect(d.body.posting.work_mode).toBe("hybrid");
    const o = d.body.overrides.find((x) => x.field === "work_mode");
    expect(o?.value).toBe("hybrid");
    expect(o?.original_value).toBe("remote");
    // Editing back to the extracted value removes the override.
    await api(`/api/jobs/${cap.body.saved_job_id}`, { method: "PATCH", json: { job: { work_mode: "remote" } } });
    const back = await api<JobDetail>(`/api/jobs/${cap.body.saved_job_id}`);
    expect(back.body.overrides.find((x) => x.field === "work_mode")).toBeUndefined();
  });
});

describe("Test 9 — security", () => {
  it("rejects cross-site writes (CSRF)", async () => {
    const res = await api<{ error: { code: string } }>("/api/jobs", { method: "POST", json: manualJob(), headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf_rejected");
  });

  it("refuses non-localhost hosts (fails closed)", async () => {
    // The firewall rejects foreign Host headers before the app runs (DNS rebinding).
    const res = await SELF.fetch("https://career-atlas.example.com/api/me");
    expect(res.status).toBe(403);
  });

  it("cannot read another user's records", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('other-user', 'other@example.test', ?)").bind(now),
      env.DB.prepare("INSERT INTO companies (id, user_id, name, normalized_name, created_at, updated_at) VALUES ('other-co', 'other-user', 'Secret Co', 'secret co', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO job_postings (id, user_id, company_id, title, created_at, updated_at) VALUES ('other-post', 'other-user', 'other-co', 'Hidden Role', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO saved_jobs (id, user_id, job_posting_id, saved_at, last_activity_at, updated_at) VALUES ('other-saved', 'other-user', 'other-post', ?, ?, ?)").bind(now, now, now),
      env.DB.prepare("INSERT INTO documents (id, user_id, kind, version_name, file_name, mime_type, size_bytes, r2_key, sha256, created_at, updated_at) VALUES ('other-doc', 'other-user', 'resume', 'v1', 'cv.pdf', 'application/pdf', 10, 'users/other-user/documents/x', 'abc', ?, ?)").bind(now, now),
    ]);
    expect((await api(`/api/jobs/other-saved`)).status).toBe(404);
    expect((await api(`/api/jobs/other-saved/status`, { method: "POST", json: { status: "applied" } })).status).toBe(404);
    expect((await api(`/api/documents/other-doc/content`)).status).toBe(404);
    expect((await api(`/api/companies/other-co`)).status).toBe(404);
    const list = await api<{ items: JobListItem[] }>("/api/jobs?q=Hidden");
    expect(list.body.items).toHaveLength(0);
  });

  it("blocks extraction from private network URLs", async () => {
    const cap = await api<{ extraction_id: string }>("/api/jobs/capture", { method: "POST", json: { url: "http://169.254.169.254/latest/meta-data/" } });
    expect(cap.status).toBe(202);
    const ex = await waitFor(async () => {
      const r = await api<ExtractionDTO>(`/api/extractions/${cap.body.extraction_id}`);
      return ["failed", "access_restricted"].includes(r.body.status) ? r.body : null;
    });
    expect(ex.error_code).toBe("blocked_destination");
  });

  it("does not fetch platforms that prohibit automated access, but keeps the link", async () => {
    const cap = await api<{ saved_job_id: string; extraction_id: string }>("/api/jobs/capture", { method: "POST", json: { url: "https://www.linkedin.com/jobs/view/3999999999/" } });
    const ex = await waitFor(async () => {
      const r = await api<ExtractionDTO>(`/api/extractions/${cap.body.extraction_id}`);
      return r.body.status === "access_restricted" ? r.body : null;
    });
    expect(ex.error_code).toBe("platform_restricted");
    const d = await api<JobDetail>(`/api/jobs/${cap.body.saved_job_id}`);
    expect(d.body.posting.original_url).toBe("https://www.linkedin.com/jobs/view/3999999999/");
  });

  it("validates uploads by content, not by declared type", async () => {
    const form = new FormData();
    form.append("file", new File(["<script>alert(1)</script>"], "resume.pdf", { type: "application/pdf" }));
    form.append("kind", "resume");
    form.append("version_name", "Fake PDF");
    const res = await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } });
    expect(res.status).toBe(415);
  });

  it("stores and serves a real PDF privately with safe headers", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    const form = new FormData();
    form.append("file", new File([pdf], "Resume — Data Analyst.pdf", { type: "application/pdf" }));
    form.append("kind", "resume");
    form.append("version_name", "Resume — Data Analyst — Oct 2026");
    const up = await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } });
    expect(up.status).toBe(201);
    const doc = (await up.json()) as { id: string };
    const res = await SELF.fetch(`http://localhost/api/documents/${doc.id}/content?disposition=inline`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(pdf.byteLength);
  });
});

describe("backup", () => {
  it("exports JSON and re-imports with duplicate detection", async () => {
    const exp = await api<{ format: string; data: Record<string, unknown[]> }>("/api/export/json");
    expect(exp.body.format).toBe("career-atlas-export");
    const preview = await api<{ will_import: { jobs: number; skipped_duplicates: number } }>("/api/import", { method: "POST", json: { mode: "preview", data: exp.body } });
    expect(preview.status).toBe(200);
    // Everything with a URL already exists → skipped; URL-less jobs would import as new copies.
    expect(preview.body.will_import.skipped_duplicates).toBeGreaterThan(0);
    const bad = await api("/api/import", { method: "POST", json: { mode: "preview", data: { hello: "world" } } });
    expect(bad.status).toBe(400);
  });

  it("CSV export neutralises formula injection", async () => {
    await api("/api/jobs", { method: "POST", json: manualJob({ company_name: "=HYPERLINK(\"http://x\")", title: "CSV Test" }) });
    const res = await SELF.fetch("http://localhost/api/export/csv", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{}" });
    const csv = await res.text();
    expect(csv).toContain("'=HYPERLINK");
  });
});

describe("timeline, reminders, calendar", () => {
  it("logs an interview with a reminder and exports ICS", async () => {
    const created = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Woodgrove", title: "Data Scientist" }) });
    await api(`/api/jobs/${created.body.id}/status`, { method: "POST", json: { status: "applied" } });
    const when = Date.now() + 3 * 86_400_000;
    const ev = await api(`/api/jobs/${created.body.id}/events`, { method: "POST", json: { type: "interview_scheduled", occurred_at: Date.now(), scheduled_for: when, title: "Panel interview" } });
    expect(ev.status).toBe(201);
    const d = await api<JobDetail>(`/api/jobs/${created.body.id}`);
    expect(d.body.application?.next_interview_at).toBe(when);
    expect(d.body.application?.reached_interview_at).not.toBeNull();
    const ics = await SELF.fetch(`http://localhost/api/calendar.ics?from=${Date.now() - 86_400_000}&to=${Date.now() + 10 * 86_400_000}&lang=zh-CN`);
    const text = await ics.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("Woodgrove");
  });
});

describe("dashboard pipeline", () => {
  it("counts saved and preparing jobs separately from applications", async () => {
    const before = await api<DashboardDTO>("/api/dashboard");
    const count = (d: DashboardDTO, s: string) => d.pipeline.find((p) => p.status === s)!.count;
    const a = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Pipeline Co A", title: "Role P1" }) });
    const b = await api<Created>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Pipeline Co B", title: "Role P2" }) });
    await api(`/api/jobs/${b.body.id}/status`, { method: "POST", json: { status: "preparing" } });
    const after = await api<DashboardDTO>("/api/dashboard");
    expect(count(after.body, "saved")).toBe(count(before.body, "saved") + 1);
    expect(count(after.body, "preparing")).toBe(count(before.body, "preparing") + 1);
    void a;
  });
});
