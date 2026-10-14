import type { ExtractableField } from "@shared/constants";
import type { JobFields, Salary } from "@shared/schemas";
import type { ApplicationDTO, CompanyDTO, TagDTO } from "@shared/types";
import type { schema } from "../db/client";

type PostingRow = typeof schema.jobPostings.$inferSelect;
type PostingInsert = typeof schema.jobPostings.$inferInsert;
type ApplicationRow = typeof schema.applications.$inferSelect;
type CompanyRow = typeof schema.companies.$inferSelect;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Posting fields stored 1:1 in a column (snake_case API key → camelCase column). */
const DIRECT_FIELDS = [
  "title",
  "title_original",
  "category",
  "department",
  "seniority",
  "employment_type",
  "external_job_id",
  "original_url",
  "apply_url",
  "source_platform",
  "posted_at",
  "deadline_at",
  "posting_status",
  "content_language",
  "work_mode",
  "city",
  "region",
  "country",
  "additional_locations",
  "remote_eligible_regions",
  "hybrid_frequency",
  "travel_requirement",
  "relocation_requirement",
  "bonus",
  "commission",
  "equity",
  "benefits",
  "compensation_notes",
  "description_text",
  "summary",
  "responsibilities",
  "required_qualifications",
  "preferred_qualifications",
  "technical_skills",
  "soft_skills",
  "tools",
  "education_requirements",
  "years_experience_min",
  "years_experience_text",
  "language_requirements",
  "certifications",
  "other_requirements",
  "work_authorization",
  "visa_sponsorship",
  "visa_sponsorship_text",
  "citizenship_restriction",
  "residency_restriction",
  "security_clearance",
  "location_restriction",
  "licences",
  "other_hard_requirements",
] as const;

export function salaryFromRow(r: PostingRow): Salary | null {
  if (r.salaryMin == null && r.salaryMax == null && !r.salaryText) return null;
  return {
    min: r.salaryMin,
    max: r.salaryMax,
    currency: r.salaryCurrency,
    period: r.salaryPeriod as Salary["period"],
    source: r.salarySource as Salary["source"],
    text: r.salaryText,
    compensation_type: r.compensationType,
  };
}

export function postingToFields(r: PostingRow, companyName: string, companyWebsite: string | null): JobFields {
  const out: Record<string, unknown> = { company_name: companyName, company_website: companyWebsite };
  for (const f of DIRECT_FIELDS) {
    const v = (r as Record<string, unknown>)[camel(f)];
    out[f] = v ?? (Array.isArray(v) ? [] : null);
  }
  out.salary = salaryFromRow(r);
  return out as JobFields;
}

/** Converts (partial) API fields into posting column values. Company fields are ignored. */
export function fieldsToColumns(fields: Partial<JobFields>): Partial<PostingInsert> {
  const out: Record<string, unknown> = {};
  for (const f of DIRECT_FIELDS) {
    if (f in fields) {
      const v = (fields as Record<string, unknown>)[f];
      if (v === undefined) continue;
      out[camel(f)] = v;
    }
  }
  if ("salary" in fields) {
    const s = fields.salary;
    out.salaryMin = s?.min ?? null;
    out.salaryMax = s?.max ?? null;
    out.salaryCurrency = s?.currency ?? null;
    out.salaryPeriod = s?.period ?? "unknown";
    out.salarySource = s?.source ?? "unknown";
    out.salaryText = s?.text ?? null;
    out.compensationType = s?.compensation_type ?? null;
  }
  return out as Partial<PostingInsert>;
}

/** Current stored value of an extractable field, for diffing and overrides. */
export function currentFieldValue(r: PostingRow, field: ExtractableField, company: CompanyRow): unknown {
  if (field === "company_name") return company.name;
  if (field === "company_website") return company.website;
  if (field === "salary") return salaryFromRow(r);
  return (r as Record<string, unknown>)[camel(field)] ?? null;
}

export function applicationToDTO(a: ApplicationRow): ApplicationDTO {
  return {
    id: a.id,
    status: a.status as ApplicationDTO["status"],
    applied_at: a.appliedAt,
    applied_via: a.appliedVia,
    last_activity_at: a.lastActivityAt,
    first_response_at: a.firstResponseAt,
    last_response_at: a.lastResponseAt,
    next_follow_up_at: a.nextFollowUpAt,
    next_interview_at: a.nextInterviewAt,
    offer_deadline_at: a.offerDeadlineAt,
    final_outcome_at: a.finalOutcomeAt,
    reached_assessment_at: a.reachedAssessmentAt,
    reached_interview_at: a.reachedInterviewAt,
    reached_offer_at: a.reachedOfferAt,
    resume_document_id: a.resumeDocumentId,
    cover_letter_document_id: a.coverLetterDocumentId,
    notes: a.notes,
  };
}

export function companyToDTO(c: CompanyRow, jobCount?: number): CompanyDTO {
  return {
    id: c.id,
    name: c.name,
    website: c.website,
    domain: c.domain,
    logo_url: c.logoUrl,
    industry: c.industry,
    description: c.description,
    notes: c.notes,
    ...(jobCount !== undefined ? { job_count: jobCount } : {}),
  };
}

export function tagToDTO(t: { id: string; name: string; color: string | null }): TagDTO {
  return { id: t.id, name: t.name, color: t.color };
}

/** Stable JSON comparison used for diffs. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return null;
    if (typeof v === "string") return v.trim().replace(/\s+/g, " ");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, norm(o[k])]),
      );
    }
    if (Array.isArray(v)) return v.map(norm);
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
