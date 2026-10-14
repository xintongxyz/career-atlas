// Shared domain constants used by both the Worker API and the React client.
// Labels are NOT defined here — every user-facing label lives in the i18n
// resource files (src/client/i18n/locales/*), keyed by these values.

export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_TIMEZONE = "America/Toronto";

/**
 * Unified pipeline status shown to the user.
 *
 * Storage model (see DATABASE_SCHEMA.md):
 *  - `saved` / `preparing` / `closed` (pre-application) live on `saved_jobs.stage`.
 *  - Everything from `applied` onward lives on `applications.status` and only
 *    exists once an application record has been created.
 *  - `archived` is derived from `saved_jobs.archived_at` and overrides the others.
 */
export const PIPELINE_STATUSES = [
  "saved",
  "preparing",
  "applied",
  "awaiting_response",
  "assessment",
  "interview",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "closed",
  "archived",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const SAVED_STAGES = ["saved", "preparing", "closed"] as const;
export type SavedStage = (typeof SAVED_STAGES)[number];

export const APPLICATION_STATUSES = [
  "applied",
  "awaiting_response",
  "assessment",
  "interview",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "closed",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses that represent a finished application. */
export const TERMINAL_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "accepted",
  "rejected",
  "withdrawn",
  "closed",
];

/** Statuses meaning the employer has responded in some way. */
export const RESPONSE_STATUSES: readonly ApplicationStatus[] = [
  "assessment",
  "interview",
  "offer",
  "accepted",
  "rejected",
];

/** Kanban columns. Terminal statuses are grouped into one "outcome" column. */
export const BOARD_COLUMNS = [
  { id: "saved", statuses: ["saved"] },
  { id: "preparing", statuses: ["preparing"] },
  { id: "applied", statuses: ["applied", "awaiting_response"] },
  { id: "assessment", statuses: ["assessment"] },
  { id: "interview", statuses: ["interview"] },
  { id: "offer", statuses: ["offer", "accepted"] },
  { id: "closed", statuses: ["rejected", "withdrawn", "closed"] },
] as const satisfies readonly { id: string; statuses: readonly PipelineStatus[] }[];
export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

/** Status a card receives when dropped onto a column. */
export const BOARD_DROP_STATUS: Record<BoardColumnId, PipelineStatus> = {
  saved: "saved",
  preparing: "preparing",
  applied: "applied",
  assessment: "assessment",
  interview: "interview",
  offer: "offer",
  closed: "rejected",
};

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const WORK_MODES = ["remote", "hybrid", "onsite", "unspecified"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "temporary",
  "internship",
  "co_op",
  "freelance",
  "other",
  "unknown",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SENIORITY_LEVELS = [
  "intern",
  "entry",
  "junior",
  "mid",
  "senior",
  "lead",
  "manager",
  "director",
  "executive",
  "unknown",
] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const SALARY_PERIODS = ["hourly", "daily", "weekly", "monthly", "annually", "other", "unknown"] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const SALARY_SOURCES = ["employer", "third_party", "user_estimate", "unknown"] as const;
export type SalarySource = (typeof SALARY_SOURCES)[number];

export const VISA_SPONSORSHIP = ["available", "not_available", "unknown"] as const;
export type VisaSponsorship = (typeof VISA_SPONSORSHIP)[number];

export const POSTING_STATUSES = ["open", "closed", "unknown"] as const;
export type PostingStatus = (typeof POSTING_STATUSES)[number];

export const SOURCE_PLATFORMS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "linkedin",
  "indeed",
  "company_site",
  "other",
  "manual",
] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

/** Extraction state of a posting (summarised on job_postings.extraction_status). */
export const EXTRACTION_STATUSES = [
  "none",
  "queued",
  "fetching",
  "extracting",
  "succeeded",
  "partial",
  "needs_review",
  "access_restricted",
  "failed",
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_TERMINAL: readonly ExtractionStatus[] = [
  "succeeded",
  "partial",
  "needs_review",
  "access_restricted",
  "failed",
];

export const EXTRACTION_INPUT_TYPES = ["url", "text"] as const;
export type ExtractionInputType = (typeof EXTRACTION_INPUT_TYPES)[number];

export const EVIDENCE_SOURCES = ["ats_api", "json_ld", "html_meta", "heuristic", "ai", "user"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const REVIEW_STATUSES = ["needs_review", "confirmed", "overridden", "superseded"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const EVENT_TYPES = [
  "job_saved",
  "details_extracted",
  "job_updated",
  "job_refreshed",
  "status_changed",
  "application_submitted",
  "follow_up_scheduled",
  "recruiter_replied",
  "assessment_received",
  "interview_scheduled",
  "interview_completed",
  "offer_received",
  "rejection_received",
  "note_added",
  "document_linked",
  "archived",
  "restored",
  "custom",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event types a user may log manually from the timeline. */
export const MANUAL_EVENT_TYPES: readonly EventType[] = [
  "recruiter_replied",
  "assessment_received",
  "interview_scheduled",
  "interview_completed",
  "offer_received",
  "rejection_received",
  "follow_up_scheduled",
  "custom",
];

export const REMINDER_KINDS = ["follow_up", "deadline", "interview", "offer_deadline", "apply", "custom"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const DOCUMENT_KINDS = ["resume", "cover_letter", "portfolio", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const CONTACT_KINDS = ["recruiter", "referral", "hiring_manager", "interviewer", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** Allowed upload MIME types → canonical extension. */
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "text/plain": "txt",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
};
/** Types the browser may preview inline (served sandboxed). */
export const PREVIEWABLE_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain"];

/**
 * Structured job fields that support provenance (evidence, confidence,
 * review status and manual overrides). Keys map 1:1 to job_postings columns
 * (salary is handled as one compound field).
 */
export const EXTRACTABLE_FIELDS = [
  "company_name",
  "company_website",
  "title",
  "category",
  "department",
  "seniority",
  "employment_type",
  "posted_at",
  "deadline_at",
  "work_mode",
  "city",
  "region",
  "country",
  "additional_locations",
  "remote_eligible_regions",
  "hybrid_frequency",
  "travel_requirement",
  "relocation_requirement",
  "salary",
  "bonus",
  "commission",
  "equity",
  "benefits",
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
  "posting_status",
] as const;
export type ExtractableField = (typeof EXTRACTABLE_FIELDS)[number];

/** Fields where a wrong value is costly; evidence must be verifiable in the source text. */
export const SENSITIVE_FIELDS: readonly ExtractableField[] = [
  "salary",
  "work_authorization",
  "visa_sponsorship",
  "visa_sponsorship_text",
  "citizenship_restriction",
  "residency_restriction",
  "security_clearance",
  "location_restriction",
  "remote_eligible_regions",
  "work_mode",
  "deadline_at",
];

export const LIST_FIELDS: readonly ExtractableField[] = [
  "additional_locations",
  "remote_eligible_regions",
  "benefits",
  "responsibilities",
  "required_qualifications",
  "preferred_qualifications",
  "technical_skills",
  "soft_skills",
  "tools",
  "education_requirements",
  "language_requirements",
  "certifications",
  "other_requirements",
  "licences",
  "other_hard_requirements",
];

export const LIMITS = {
  urlMaxLength: 2048,
  jdMaxChars: 120_000,
  noteMaxChars: 20_000,
  fetchTimeoutMs: 12_000,
  fetchMaxBytes: 3_000_000,
  fetchMaxRedirects: 5,
  aiInputMaxChars: 24_000,
  extractionStaleMs: 5 * 60_000,
  pageSizeDefault: 50,
  pageSizeMax: 200,
  compareMax: 4,
} as const;

// ---------- bilingual job content ----------

/** UI languages that job content can be translated into. */
export const CONTENT_LANGS = ["en", "zh-CN"] as const;
export type ContentLang = (typeof CONTENT_LANGS)[number];

/**
 * Descriptive fields that may carry an AI translation (display only). Company names, URLs, numbers,
 * salary, dates, enums, places and technical skills/tools are never translated.
 */
export const TRANSLATABLE_FIELDS = [
  "title",
  "department",
  "category",
  "summary",
  "hybrid_frequency",
  "travel_requirement",
  "relocation_requirement",
  "bonus",
  "commission",
  "equity",
  "benefits",
  "responsibilities",
  "required_qualifications",
  "preferred_qualifications",
  "soft_skills",
  "education_requirements",
  "years_experience_text",
  "language_requirements",
  "certifications",
  "other_requirements",
  "work_authorization",
  "visa_sponsorship_text",
  "citizenship_restriction",
  "residency_restriction",
  "security_clearance",
  "location_restriction",
  "licences",
  "other_hard_requirements",
] as const satisfies readonly ExtractableField[];
export type TranslatableField = (typeof TRANSLATABLE_FIELDS)[number];
