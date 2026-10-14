import { describe, expect, it } from "vitest";
import type { DraftCreatedDTO, DraftDTO } from "../../src/shared/types";
import { env } from "./harness";
import { api } from "./helpers";

// Fictional posting used for every AI-draft test.
const JD = `Senior Data Analyst — Lumen Transit Systems (fictional company)
Team: Planning & Insights
Location: Vancouver, BC, Canada. Hybrid: 3 days per week in our office.
Salary range: CAD $95,000 – $115,000 per year.
You will build ridership forecasts and dashboards for city planners.
Requirements: 4+ years of experience with SQL and Python; experience with Tableau.
Applicants must be legally entitled to work in Canada.`;

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  origin: "claude_desktop",
  source_url: "https://jobs.example.com/lumen/senior-data-analyst-123",
  job_description: JD,
  notes: "Company website found via web search.",
  fields: {
    company_name: { value: "Lumen Transit Systems", basis: "posting", evidence: "Senior Data Analyst — Lumen Transit Systems" },
    title: { value: "Senior Data Analyst", basis: "posting", evidence: "Senior Data Analyst" },
    department: { value: "Planning & Insights", basis: "posting", evidence: "Team: Planning & Insights" },
    company_website: { value: "https://lumen.example.com", basis: "web", source_url: "https://lumen.example.com/about" },
    category: { value: "Data & Analytics", basis: "inferred" },
    work_mode: { value: "hybrid", basis: "posting", evidence: "Hybrid: 3 days per week in our office." },
    city: { value: "Vancouver", basis: "posting", evidence: "Location: Vancouver, BC, Canada." },
    salary: { value: { min: 95000, max: 115000, currency: "CAD", period: "annually" }, basis: "posting", evidence: "Salary range: CAD $95,000 – $115,000 per year." },
    work_authorization: { value: "Must be legally entitled to work in Canada", basis: "posting", evidence: "Applicants must be legally entitled to work in Canada." },
    years_experience_min: { value: 4, basis: "posting", evidence: "4+ years of experience with SQL and Python" },
    technical_skills: { value: ["SQL", "Python", "Tableau"], basis: "posting", evidence: "experience with SQL and Python; experience with Tableau" },
    // Claimed from the posting but not in it → must be downgraded to an inference.
    seniority: { value: "senior", basis: "posting", evidence: "This is a senior leadership role" },
    // Sensitive and only inferred → must be dropped, never shown as a fact.
    visa_sponsorship: { value: "not_available", basis: "inferred" },
    ...overrides,
  },
});

describe("AI drafts (Claude Desktop extension / Import from AI)", () => {
  it("verifies every field, keeps the original JD, and does not create a job until Save", async () => {
    const before = (await api<{ total: number }>("/api/jobs")).body.total;
    const created = await api<DraftCreatedDTO>("/api/drafts", { method: "POST", json: draftInput() });
    expect(created.status).toBe(201);
    // The response tells the AI only what it needs: no existing records, no personal data.
    expect(Object.keys(created.body).sort()).toEqual(["accepted_fields", "dropped", "id", "needs_review_fields", "possible_duplicate", "review_path", "translations"]);
    expect(created.body.dropped).toContainEqual({ field: "visa_sponsorship", reason: "sensitive_not_verified" });
    expect(created.body.needs_review_fields).toEqual(expect.arrayContaining(["company_website", "category", "seniority"]));
    expect(created.body.accepted_fields).toEqual(expect.arrayContaining(["company_name", "title", "salary", "work_mode", "work_authorization"]));
    expect((await api<{ total: number }>("/api/jobs")).body.total).toBe(before);

    const draft = (await api<DraftDTO>(`/api/drafts/${created.body.id}`)).body;
    const f = draft.extraction.result!.fields;
    expect(f.salary).toMatchObject({ basis: "posting", confidence: "high" });
    expect(f.company_website).toMatchObject({ basis: "web", source_url: "https://lumen.example.com/about", needs_review: true });
    expect(f.category).toMatchObject({ basis: "inferred", confidence: "low", evidence: null });
    expect(f.seniority).toMatchObject({ basis: "inferred", needs_review: true });
    expect(f.visa_sponsorship).toBeUndefined();
    expect(draft.extraction.result!.description_text).toBe(JD);
    expect((await api<{ items: { id: string }[] }>("/api/drafts")).body.items.map((d) => d.id)).toContain(created.body.id);

    const fields = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v!.value]));
    const saved = await api<{ saved_job_id: string }>(`/api/drafts/${created.body.id}/save`, { method: "POST", json: { fields: { ...fields, description_text: true }, review_later: ["category"] } });
    expect(saved.status).toBe(200);
    const job = (await api<{ posting: Record<string, unknown>; company: { name: string; website: string | null } }>(`/api/jobs/${saved.body.saved_job_id}`)).body;
    expect(job.posting.title).toBe("Senior Data Analyst");
    expect(job.posting.original_url).toBe("https://jobs.example.com/lumen/senior-data-analyst-123");
    expect(job.posting.description_text).toBe(JD);
    expect(job.posting.department).toBe("Planning & Insights");
    const snaps = await env.DB.prepare("SELECT method, text FROM job_source_snapshots WHERE job_posting_id = (SELECT job_posting_id FROM saved_jobs WHERE id = ?)").bind(saved.body.saved_job_id).all<{ method: string; text: string }>();
    expect(snaps.results).toEqual([{ method: "pasted_text", text: JD }]);
    const ev = await env.DB.prepare("SELECT field, review_status FROM extracted_field_evidence WHERE job_posting_id = (SELECT job_posting_id FROM saved_jobs WHERE id = ?) AND field = 'category'").bind(saved.body.saved_job_id).first<{ review_status: string }>();
    expect(ev?.review_status).toBe("needs_review");

    // Saved drafts leave the inbox and cannot be saved twice.
    expect((await api<{ items: { id: string }[] }>("/api/drafts")).body.items.map((d) => d.id)).not.toContain(created.body.id);
    expect((await api(`/api/drafts/${created.body.id}/save`, { method: "POST", json: { fields } })).status).toBe(409);
  });

  it("flags a duplicate URL, requires confirmation, and can be discarded", async () => {
    const first = await api<DraftCreatedDTO>("/api/drafts", { method: "POST", json: draftInput() });
    expect(first.body.possible_duplicate).toBe(true);
    const save = await api<{ error: { code: string } }>(`/api/drafts/${first.body.id}/save`, { method: "POST", json: { fields: { company_name: "Lumen Transit Systems", title: "Senior Data Analyst" } } });
    expect(save.status).toBe(409);
    expect(save.body.error.code).toBe("possible_duplicate");
    expect((await api(`/api/drafts/${first.body.id}/discard`, { method: "POST" })).status).toBe(204);
    expect((await api<{ items: { id: string }[] }>("/api/drafts")).body.items.map((d) => d.id)).not.toContain(first.body.id);
  });

  it("accepts bare values from other AI tools as unverified inferences, and rejects empty input", async () => {
    const r = await api<DraftCreatedDTO>("/api/drafts", { method: "POST", json: { job_description: JD, fields: { company_name: "Lumen Transit Systems", title: "Data Analyst", salary: { min: 1, max: 2, currency: "CAD", period: "annually" }, made_up_field: "x" } } });
    expect(r.status).toBe(201);
    expect(r.body.needs_review_fields).toEqual(expect.arrayContaining(["company_name", "title"]));
    expect(r.body.dropped).toEqual(expect.arrayContaining([{ field: "salary", reason: "sensitive_not_verified" }, { field: "made_up_field", reason: "unknown_field" }]));
    expect((await api("/api/drafts", { method: "POST", json: { fields: {} } })).status).toBe(422);
  });

  it("refuses to save without company and title", async () => {
    const r = await api<DraftCreatedDTO>("/api/drafts", { method: "POST", json: { job_description: JD, source_url: "https://jobs.example.com/other-1", fields: {} } });
    expect((await api<{ error: { code: string } }>(`/api/drafts/${r.body.id}/save`, { method: "POST", json: { fields: { title: "X" } } })).body.error.code).toBe("company_required");
  });
});
