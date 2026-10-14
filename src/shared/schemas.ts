import { z } from "zod";
import {
  APPLICATION_STATUSES,
  CONTACT_KINDS,
  DOCUMENT_KINDS,
  EMPLOYMENT_TYPES,
  EVENT_TYPES,
  LIMITS,
  LOCALES,
  PIPELINE_STATUSES,
  POSTING_STATUSES,
  PRIORITIES,
  REMINDER_KINDS,
  SALARY_PERIODS,
  SALARY_SOURCES,
  SENIORITY_LEVELS,
  SOURCE_PLATFORMS,
  VISA_SPONSORSHIP,
  WORK_MODES,
} from "./constants";

// ---------- primitives ----------

const trimmed = (max: number) => z.string().trim().max(max);
const optText = (max = 2000) =>
  trimmed(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();
const textList = (maxItems = 60, maxLen = 1000) => z.array(trimmed(maxLen).min(1)).max(maxItems);

export const httpUrl = z
  .string()
  .trim()
  .max(LIMITS.urlMaxLength)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "invalid_url");

const optUrl = httpUrl
  .or(z.literal(""))
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

/** Timestamps travel as epoch milliseconds. */
export const epochMs = z.number().int().min(0).max(8_640_000_000_000_000);
const optEpoch = epochMs.nullable().optional();

// ---------- jobs ----------

export const salarySchema = z
  .object({
    min: z.number().nonnegative().max(100_000_000).nullable(),
    max: z.number().nonnegative().max(100_000_000).nullable(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    period: z.enum(SALARY_PERIODS),
    source: z.enum(SALARY_SOURCES),
    text: optText(500),
    compensation_type: optText(100),
  })
  .refine((s) => s.min == null || s.max == null || s.min <= s.max, { message: "salary_min_gt_max" });
export type Salary = z.infer<typeof salarySchema>;

/** Editable job posting fields (manual entry, edits and applied extractions). */
export const jobFieldsSchema = z.object({
  company_name: trimmed(200).min(1),
  company_website: optUrl,
  title: trimmed(300).min(1),
  title_original: optText(300),
  category: optText(120),
  department: optText(120),
  seniority: z.enum(SENIORITY_LEVELS).optional(),
  employment_type: z.enum(EMPLOYMENT_TYPES).optional(),
  external_job_id: optText(200),
  original_url: optUrl,
  apply_url: optUrl,
  source_platform: z.enum(SOURCE_PLATFORMS).optional(),
  posted_at: optEpoch,
  deadline_at: optEpoch,
  posting_status: z.enum(POSTING_STATUSES).optional(),
  content_language: optText(20),

  work_mode: z.enum(WORK_MODES).optional(),
  city: optText(120),
  region: optText(120),
  country: optText(120),
  additional_locations: textList(30, 200).optional(),
  remote_eligible_regions: textList(30, 200).optional(),
  hybrid_frequency: optText(200),
  travel_requirement: optText(300),
  relocation_requirement: optText(300),

  salary: salarySchema.nullable().optional(),
  bonus: optText(300),
  commission: optText(300),
  equity: optText(300),
  benefits: textList(60, 300).optional(),
  compensation_notes: optText(2000),

  description_text: z.string().max(LIMITS.jdMaxChars).nullable().optional(),
  summary: optText(4000),
  responsibilities: textList().optional(),
  required_qualifications: textList().optional(),
  preferred_qualifications: textList().optional(),
  technical_skills: textList(80, 120).optional(),
  soft_skills: textList(40, 120).optional(),
  tools: textList(80, 120).optional(),
  education_requirements: textList(20, 500).optional(),
  years_experience_min: z.number().int().min(0).max(50).nullable().optional(),
  years_experience_text: optText(300),
  language_requirements: textList(20, 200).optional(),
  certifications: textList(30, 200).optional(),
  other_requirements: textList(40, 500).optional(),

  work_authorization: optText(1000),
  visa_sponsorship: z.enum(VISA_SPONSORSHIP).optional(),
  visa_sponsorship_text: optText(1000),
  citizenship_restriction: optText(1000),
  residency_restriction: optText(1000),
  security_clearance: optText(1000),
  location_restriction: optText(1000),
  licences: textList(20, 300).optional(),
  other_hard_requirements: textList(30, 500).optional(),
});
export type JobFields = z.infer<typeof jobFieldsSchema>;

/** Personal tracking fields on the saved-job relationship. */
export const savedJobFieldsSchema = z.object({
  is_starred: z.boolean().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  interest_level: z.number().int().min(1).max(5).nullable().optional(),
  fit_assessment: optText(4000),
  fit_score: z.number().int().min(1).max(5).nullable().optional(),
  next_action: optText(500),
  next_action_at: optEpoch,
  follow_up_at: optEpoch,
  resume_document_id: z.string().max(64).nullable().optional(),
  cover_letter_document_id: z.string().max(64).nullable().optional(),
  referral_contact_id: z.string().max(64).nullable().optional(),
  recruiter_contact_id: z.string().max(64).nullable().optional(),
  application_notes: optText(LIMITS.noteMaxChars),
  tags: z.array(trimmed(40).min(1)).max(30).optional(),
});
export type SavedJobFields = z.infer<typeof savedJobFieldsSchema>;

export const createJobSchema = z.object({
  job: jobFieldsSchema,
  personal: savedJobFieldsSchema.optional(),
  initial_status: z.enum(["saved", "preparing", "applied"]).default("saved"),
  applied_at: optEpoch,
  /** Set when the user has seen the duplicate warning and chose to continue. */
  confirm_duplicate: z.boolean().optional(),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = z.object({
  job: jobFieldsSchema.partial().optional(),
  personal: savedJobFieldsSchema.optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

export const duplicateCheckSchema = z.object({
  url: httpUrl.optional(),
  company_name: trimmed(200).optional(),
  title: trimmed(300).optional(),
  city: trimmed(120).optional(),
});

// ---------- capture / extraction ----------

export const captureSchema = z
  .object({
    url: httpUrl.optional(),
    text: z.string().max(LIMITS.jdMaxChars).optional(),
    confirm_duplicate: z.boolean().optional(),
    /** Explicitly request AI-assisted extraction (needed when AI runs only on request, e.g. Claude Code). */
    use_ai: z.boolean().optional(),
  })
  .refine((v) => !!v.url || (v.text && v.text.trim().length >= 40), { message: "url_or_text_required" });
export type CaptureInput = z.infer<typeof captureSchema>;

/** Optional body for refresh / retry. */
export const extractionOptionsSchema = z.object({ use_ai: z.boolean().optional() });

export const applyExtractionSchema = z.object({
  /** Field keys the user accepted, with their final (possibly edited) values. */
  fields: z.record(z.string(), z.unknown()),
  /** Fields accepted without review; they stay flagged as needs_review. */
  review_later: z.array(z.string()).max(100).optional(),
});

export const fieldReviewSchema = z.object({
  field: z.string().max(60),
  action: z.enum(["confirm"]),
});

// ---------- status / applications ----------

export const statusChangeSchema = z.object({
  status: z.enum(PIPELINE_STATUSES),
  occurred_at: optEpoch,
  note: optText(2000),
});
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

export const applicationUpdateSchema = z.object({
  applied_at: optEpoch,
  applied_via: optText(200),
  next_follow_up_at: optEpoch,
  next_interview_at: optEpoch,
  offer_deadline_at: optEpoch,
  final_outcome_at: optEpoch,
  last_response_at: optEpoch,
  resume_document_id: z.string().max(64).nullable().optional(),
  cover_letter_document_id: z.string().max(64).nullable().optional(),
  notes: optText(LIMITS.noteMaxChars),
});

export const eventCreateSchema = z.object({
  type: z.enum(EVENT_TYPES),
  occurred_at: epochMs,
  title: optText(300),
  details: optText(4000),
  /** Optional future date for scheduling events (interview time, follow-up date). */
  scheduled_for: optEpoch,
});

export const eventUpdateSchema = z.object({
  occurred_at: epochMs.optional(),
  title: optText(300),
  details: optText(4000),
});

export const bulkActionSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(500),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add_tag"), tag: trimmed(40).min(1) }),
    z.object({ type: z.literal("remove_tag"), tag: trimmed(40).min(1) }),
    z.object({ type: z.literal("archive") }),
    z.object({ type: z.literal("restore") }),
    z.object({ type: z.literal("set_priority"), priority: z.enum(PRIORITIES).nullable() }),
  ]),
});

// ---------- misc entities ----------

export const noteSchema = z.object({ body: trimmed(LIMITS.noteMaxChars).min(1) });

export const tagSchema = z.object({
  name: trimmed(40).min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

export const reminderSchema = z.object({
  title: trimmed(300).min(1),
  kind: z.enum(REMINDER_KINDS).default("custom"),
  due_at: epochMs,
  saved_job_id: z.string().max(64).nullable().optional(),
  notes: optText(2000),
});
export const reminderUpdateSchema = reminderSchema.partial().extend({
  completed: z.boolean().optional(),
});

export const contactSchema = z.object({
  name: trimmed(200).min(1),
  kind: z.enum(CONTACT_KINDS).default("other"),
  title: optText(200),
  email: z.string().trim().email().max(320).or(z.literal("")).nullable().optional(),
  phone: optText(60),
  linkedin_url: optUrl,
  company_id: z.string().max(64).nullable().optional(),
  notes: optText(4000),
});

export const companyUpdateSchema = z.object({
  name: trimmed(200).min(1).optional(),
  website: optUrl,
  industry: optText(120),
  description: optText(4000),
  notes: optText(LIMITS.noteMaxChars),
});

export const documentMetaSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  version_name: trimmed(200).min(1),
  notes: optText(2000),
});

export const comparisonPrefsSchema = z.object({
  preferred_work_modes: z.array(z.enum(WORK_MODES)).max(4).default([]),
  preferred_cities: z.array(trimmed(120).min(1)).max(20).default([]),
  min_salary: z.number().nonnegative().nullable().default(null),
  min_salary_currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  min_salary_period: z.enum(SALARY_PERIODS).default("annually"),
  preferred_categories: z.array(trimmed(120).min(1)).max(20).default([]),
  preferred_employment_types: z.array(z.enum(EMPLOYMENT_TYPES)).max(9).default([]),
  weights: z
    .object({
      work_mode: z.number().min(0).max(5).default(3),
      location: z.number().min(0).max(5).default(2),
      salary: z.number().min(0).max(5).default(3),
      category: z.number().min(0).max(5).default(2),
      employment_type: z.number().min(0).max(5).default(2),
    })
    .default({ work_mode: 3, location: 2, salary: 3, category: 2, employment_type: 2 }),
});
export type ComparisonPrefs = z.infer<typeof comparisonPrefsSchema>;

export const preferencesSchema = z.object({
  locale: z.enum(LOCALES).optional(),
  timezone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "invalid_timezone")
    .optional(),
  default_follow_up_days: z.number().int().min(0).max(90).optional(),
  comparison: comparisonPrefsSchema.optional(),
});

export const customViewSchema = z.object({
  name: trimmed(80).min(1),
  page: z.enum(["positions"]).default("positions"),
  state: z.record(z.string(), z.unknown()),
});

// ---------- listing ----------

const csv = z
  .string()
  .max(2000)
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

export const jobListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: csv.optional(),
  work_mode: csv.optional(),
  employment_type: csv.optional(),
  priority: csv.optional(),
  source: csv.optional(),
  tag: csv.optional(),
  company_id: z.string().max(64).optional(),
  location: z.string().trim().max(120).optional(),
  skill: z.string().trim().max(120).optional(),
  restriction: z.enum(["any", "work_authorization", "visa_not_available", "citizenship", "security_clearance", "none_known"]).optional(),
  needs_review: z.enum(["true", "false"]).optional(),
  starred: z.enum(["true", "false"]).optional(),
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
  scope: z.enum(["all", "pre_application", "applications"]).default("all"),
  salary_min: z.coerce.number().nonnegative().optional(),
  salary_currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  salary_period: z.enum(SALARY_PERIODS).optional(),
  saved_from: z.coerce.number().int().optional(),
  saved_to: z.coerce.number().int().optional(),
  applied_from: z.coerce.number().int().optional(),
  applied_to: z.coerce.number().int().optional(),
  sort: z
    .enum(["saved_at", "applied_at", "updated_at", "company", "title", "deadline_at", "salary", "priority", "last_activity_at"])
    .default("saved_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const analyticsQuerySchema = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

export const importSchema = z.object({
  mode: z.enum(["preview", "commit"]),
  data: z.unknown(),
});

export { APPLICATION_STATUSES };

// ---------- AI import (Claude Desktop extension, "Import from AI") ----------

export const AI_IMPORT_FORMAT = "career-atlas-ai-import/v1";
export const AI_BASES = ["posting", "web", "inferred"] as const;

const aiImportField = z.preprocess(
  // A bare value ("title": "Data Analyst") is accepted and treated as an unverified inference.
  (v) => (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object) ? v : { value: v }),
  z.object({
    value: z.unknown(),
    basis: z.enum(AI_BASES).catch("inferred").default("inferred"),
    evidence: z.string().max(2000).nullable().optional().catch(null),
    source_url: z.string().max(LIMITS.urlMaxLength).nullable().optional().catch(null),
  }),
);

/** Structured job details proposed by an AI tool. Validated and verified again on the server. */
export const aiImportSchema = z
  .object({
    format: z.string().max(60).optional(),
    source_url: httpUrl.nullable().optional(),
    job_description: z.string().max(LIMITS.jdMaxChars).nullable().optional(),
    fields: z.record(z.string().max(60), aiImportField).default({}),
    notes: z.string().max(4000).nullable().optional(),
    origin: z.enum(["claude_desktop", "paste"]).default("paste"),
  })
  .refine((v) => !!v.source_url || (v.job_description?.trim().length ?? 0) >= 40, { message: "url_or_text_required" });
export type AiImportInput = z.infer<typeof aiImportSchema>;

export const draftSaveSchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  review_later: z.array(z.string()).max(100).optional(),
  confirm_duplicate: z.boolean().optional(),
});
