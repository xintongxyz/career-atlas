import { describe, expect, it } from "vitest";
import type { DraftCreatedDTO, DraftDTO, JobDetail, JobListItem } from "../../src/shared/types";
import { api } from "./helpers";

// Fictional English posting with AI translations (one record, two languages).
const JD = `Customer Success Manager — Tailwind Traders (fictional)
Team: Customer Experience
Location: Halifax, NS, Canada. Hybrid.
Responsibilities:
- Onboard new B2B customers
- Run quarterly business reviews
Requirements: 3+ years in customer success or account management.`;

const input = {
  origin: "claude_desktop",
  source_url: "https://jobs.example.com/tailwind/csm-42",
  job_description: JD,
  original_language: "en-US",
  fields: {
    company_name: { value: "Tailwind Traders", basis: "posting", evidence: "Customer Success Manager — Tailwind Traders" },
    title: { value: "Customer Success Manager", basis: "posting", evidence: "Customer Success Manager" },
    department: { value: "Customer Experience", basis: "posting", evidence: "Team: Customer Experience" },
    category: { value: "Customer Success", basis: "inferred" },
    responsibilities: { value: ["Onboard new B2B customers", "Run quarterly business reviews"], basis: "posting", evidence: "Onboard new B2B customers" },
    technical_skills: { value: ["Salesforce"], basis: "inferred" },
  },
  translations: {
    "zh-CN": {
      title: "客户成功经理",
      department: "客户体验部",
      category: "客户成功",
      responsibilities: ["为新的B2B客户提供入门引导", "开展季度业务回顾"],
      technical_skills: ["Salesforce（不应被保存：技术名词不翻译）"],
      company_name: "不应被保存",
    },
    en: { title: "Customer Success Manager" },
    fr: { title: "ignored" },
  },
};

describe("bilingual job content", () => {
  it("stores AI translations on the same job, keeps originals and evidence, and drops stale translations", async () => {
    const created = await api<DraftCreatedDTO>("/api/drafts", { method: "POST", json: input });
    expect(created.body.translations.sort()).toEqual(["en", "zh-CN"]);
    const draft = (await api<DraftDTO>(`/api/drafts/${created.body.id}`)).body;
    const r = draft.extraction.result!;
    expect(r.content_language).toBe("en");
    expect(r.translations!["zh-CN"]).toEqual({ title: "客户成功经理", department: "客户体验部", category: "客户成功", responsibilities: ["为新的B2B客户提供入门引导", "开展季度业务回顾"] });

    // The user edits the department before saving → its (now wrong) translation is not kept.
    const fields = { ...Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v!.value])), department: "CX Team", description_text: true };
    const saved = await api<{ saved_job_id: string }>(`/api/drafts/${created.body.id}/save`, { method: "POST", json: { fields } });
    expect(saved.status).toBe(200);
    const job = (await api<JobDetail>(`/api/jobs/${saved.body.saved_job_id}`)).body;
    expect(job.posting.title).toBe("Customer Success Manager");
    expect(job.posting.description_text).toBe(JD); // original JD untouched
    expect(job.posting.content_language).toBe("en");
    expect(job.posting.translations?.source).toBe("ai");
    expect(job.posting.translations?.values["zh-CN"]).toEqual({ title: "客户成功经理", category: "客户成功", responsibilities: ["为新的B2B客户提供入门引导", "开展季度业务回顾"] });
    // Evidence stays the original quote, never the translation.
    expect(job.evidence.find((e) => e.field === "title")?.evidence).toBe("Customer Success Manager");

    const list = (await api<{ items: JobListItem[] }>("/api/jobs?q=Customer%20Success")).body.items;
    expect(list.find((j) => j.id === saved.body.saved_job_id)).toMatchObject({ content_language: "en", title_translations: { "zh-CN": "客户成功经理", en: "Customer Success Manager" } });

    // Editing the original title later removes only the title translation.
    expect((await api(`/api/jobs/${saved.body.saved_job_id}`, { method: "PATCH", json: { job: { title: "Senior Customer Success Manager" } } })).status).toBeLessThan(300);
    const after = (await api<JobDetail>(`/api/jobs/${saved.body.saved_job_id}`)).body;
    expect(after.posting.translations?.values["zh-CN"]?.title).toBeUndefined();
    expect(after.posting.translations?.values["zh-CN"]?.category).toBe("客户成功");
  });

  it("saves without translations when the user unticks them, and existing jobs without translations still work", async () => {
    const created = await api<DraftCreatedDTO>("/api/drafts", { method: "POST", json: { ...input, source_url: "https://jobs.example.com/tailwind/csm-43" } });
    const saved = await api<{ saved_job_id: string }>(`/api/drafts/${created.body.id}/save`, { method: "POST", json: { fields: { company_name: "Tailwind Traders", title: "Customer Success Manager" }, save_translations: false } });
    const job = (await api<JobDetail>(`/api/jobs/${saved.body.saved_job_id}`)).body;
    expect(job.posting.translations).toBeNull();
    const manual = await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Manual Co", title: "Analyst" }, confirm_duplicate: true } });
    const mj = (await api<JobDetail>(`/api/jobs/${manual.body.id}`)).body;
    expect(mj.posting.translations).toBeNull();
    expect(mj.posting.content_language).toBeNull();
  });
});
