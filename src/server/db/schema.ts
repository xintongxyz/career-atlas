// Career Atlas — relational schema (SQLite).
//
// Conventions
//  - Every table has a stable text primary key (UUID v4 generated in the Worker).
//  - All timestamps are INTEGER epoch milliseconds (UTC). Display time zone is a
//    user preference and is applied only in the UI.
//  - Every user-owned row carries `user_id`; every query is scoped by it.
//  - JSON columns store arrays of strings or small objects as TEXT.
//  - Deletion is soft (`deleted_at` / `archived_at`) wherever history matters.
//
// See DATABASE_SCHEMA.md for the relationship diagram and rationale.


import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });
const createdAt = () => integer("created_at").notNull();
const updatedAt = () => integer("updated_at").notNull();
const jsonList = (name: string) => text(name, { mode: "json" }).$type<string[]>();

// ---------------------------------------------------------------- identity

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  createdAt: createdAt(),
  lastSeenAt: integer("last_seen_at"),
});

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  locale: text("locale").notNull().default("en"),
  timezone: text("timezone").notNull().default("America/Toronto"),
  defaultFollowUpDays: integer("default_follow_up_days").notNull().default(7),
  comparisonJson: text("comparison_json", { mode: "json" }).$type<Record<string, unknown>>(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------- companies

export const companies = sqliteTable(
  "companies",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    domain: text("domain"),
    logoUrl: text("logo_url"),
    industry: text("industry"),
    description: text("description"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("companies_user_name_idx").on(t.userId, t.normalizedName),
    index("companies_user_domain_idx").on(t.userId, t.domain),
  ],
);

// ---------------------------------------------------------------- job postings

export const jobPostings = sqliteTable(
  "job_postings",
  {
    id: id(),
    userId: userId(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),

    // identity & source
    externalJobId: text("external_job_id"),
    originalUrl: text("original_url"),
    canonicalUrl: text("canonical_url"),
    applyUrl: text("apply_url"),
    sourcePlatform: text("source_platform").notNull().default("manual"),
    title: text("title").notNull(),
    titleOriginal: text("title_original"),
    category: text("category"),
    department: text("department"),
    seniority: text("seniority").notNull().default("unknown"),
    employmentType: text("employment_type").notNull().default("unknown"),
    postedAt: integer("posted_at"),
    deadlineAt: integer("deadline_at"),
    postingStatus: text("posting_status").notNull().default("unknown"),
    contentLanguage: text("content_language"),

    // work arrangement
    workMode: text("work_mode").notNull().default("unspecified"),
    city: text("city"),
    region: text("region"),
    country: text("country"),
    additionalLocations: jsonList("additional_locations"),
    remoteEligibleRegions: jsonList("remote_eligible_regions"),
    hybridFrequency: text("hybrid_frequency"),
    travelRequirement: text("travel_requirement"),
    relocationRequirement: text("relocation_requirement"),

    // compensation
    salaryMin: real("salary_min"),
    salaryMax: real("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period").notNull().default("unknown"),
    salarySource: text("salary_source").notNull().default("unknown"),
    salaryText: text("salary_text"),
    compensationType: text("compensation_type"),
    bonus: text("bonus"),
    commission: text("commission"),
    equity: text("equity"),
    benefits: jsonList("benefits"),
    compensationNotes: text("compensation_notes"),

    // description
    descriptionText: text("description_text"),
    summary: text("summary"),
    responsibilities: jsonList("responsibilities"),
    requiredQualifications: jsonList("required_qualifications"),
    preferredQualifications: jsonList("preferred_qualifications"),
    technicalSkills: jsonList("technical_skills"),
    softSkills: jsonList("soft_skills"),
    tools: jsonList("tools"),
    educationRequirements: jsonList("education_requirements"),
    yearsExperienceMin: integer("years_experience_min"),
    yearsExperienceText: text("years_experience_text"),
    languageRequirements: jsonList("language_requirements"),
    certifications: jsonList("certifications"),
    otherRequirements: jsonList("other_requirements"),

    // eligibility & restrictions (only what the posting explicitly states)
    workAuthorization: text("work_authorization"),
    visaSponsorship: text("visa_sponsorship").notNull().default("unknown"),
    visaSponsorshipText: text("visa_sponsorship_text"),
    citizenshipRestriction: text("citizenship_restriction"),
    residencyRestriction: text("residency_restriction"),
    securityClearance: text("security_clearance"),
    locationRestriction: text("location_restriction"),
    licences: jsonList("licences"),
    otherHardRequirements: jsonList("other_hard_requirements"),

    // extraction summary
    extractionStatus: text("extraction_status").notNull().default("none"),
    latestExtractionId: text("latest_extraction_id"),
    lastCheckedAt: integer("last_checked_at"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("job_postings_user_canonical_idx").on(t.userId, t.canonicalUrl),
    index("job_postings_user_external_idx").on(t.userId, t.sourcePlatform, t.externalJobId),
    index("job_postings_user_company_idx").on(t.userId, t.companyId),
    index("job_postings_user_title_idx").on(t.userId, t.title),
  ],
);

// ---------------------------------------------------------------- saved jobs (my relationship to a posting)

export const savedJobs = sqliteTable(
  "saved_jobs",
  {
    id: id(),
    userId: userId(),
    jobPostingId: text("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    /** Pre-application stage: saved | preparing | closed. */
    stage: text("stage").notNull().default("saved"),
    isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
    priority: text("priority"),
    interestLevel: integer("interest_level"),
    fitAssessment: text("fit_assessment"),
    fitScore: integer("fit_score"),
    nextAction: text("next_action"),
    nextActionAt: integer("next_action_at"),
    followUpAt: integer("follow_up_at"),
    resumeDocumentId: text("resume_document_id").references(() => documents.id, { onDelete: "set null" }),
    coverLetterDocumentId: text("cover_letter_document_id").references(() => documents.id, { onDelete: "set null" }),
    referralContactId: text("referral_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    recruiterContactId: text("recruiter_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    applicationNotes: text("application_notes"),
    savedAt: integer("saved_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    archivedAt: integer("archived_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("saved_jobs_user_posting_uq").on(t.userId, t.jobPostingId),
    index("saved_jobs_user_stage_idx").on(t.userId, t.stage),
    index("saved_jobs_user_saved_at_idx").on(t.userId, t.savedAt),
  ],
);

// ---------------------------------------------------------------- applications (only once actually applied)

export const applications = sqliteTable(
  "applications",
  {
    id: id(),
    userId: userId(),
    savedJobId: text("saved_job_id")
      .notNull()
      .references(() => savedJobs.id, { onDelete: "cascade" }),
    jobPostingId: text("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("applied"),
    appliedAt: integer("applied_at").notNull(),
    appliedVia: text("applied_via"),
    lastActivityAt: integer("last_activity_at").notNull(),
    firstResponseAt: integer("first_response_at"),
    lastResponseAt: integer("last_response_at"),
    nextFollowUpAt: integer("next_follow_up_at"),
    nextInterviewAt: integer("next_interview_at"),
    offerDeadlineAt: integer("offer_deadline_at"),
    finalOutcomeAt: integer("final_outcome_at"),
    // Milestones: first time the application ever reached a stage. Monotonic —
    // later status changes never clear them, so historical conversion is exact.
    reachedAssessmentAt: integer("reached_assessment_at"),
    reachedInterviewAt: integer("reached_interview_at"),
    reachedOfferAt: integer("reached_offer_at"),
    resumeDocumentId: text("resume_document_id").references(() => documents.id, { onDelete: "set null" }),
    coverLetterDocumentId: text("cover_letter_document_id").references(() => documents.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("applications_saved_job_uq").on(t.savedJobId),
    index("applications_user_status_idx").on(t.userId, t.status),
    index("applications_user_applied_idx").on(t.userId, t.appliedAt),
  ],
);

// Append-only activity log. Status updates never rewrite past events.
export const applicationEvents = sqliteTable(
  "application_events",
  {
    id: id(),
    userId: userId(),
    savedJobId: text("saved_job_id")
      .notNull()
      .references(() => savedJobs.id, { onDelete: "cascade" }),
    applicationId: text("application_id").references(() => applications.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    title: text("title"),
    details: text("details"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    /** When it happened (user-editable). */
    occurredAt: integer("occurred_at").notNull(),
    /** Optional future date the event refers to (e.g. interview time). */
    scheduledFor: integer("scheduled_for"),
    createdAt: createdAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("events_user_occurred_idx").on(t.userId, t.occurredAt),
    index("events_saved_job_idx").on(t.savedJobId, t.occurredAt),
  ],
);

// ---------------------------------------------------------------- extraction pipeline

export const jobExtractionJobs = sqliteTable(
  "job_extraction_jobs",
  {
    id: id(),
    userId: userId(),
    jobPostingId: text("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull().default("initial"), // initial | refresh
    inputType: text("input_type").notNull(), // url | text
    inputUrl: text("input_url"),
    status: text("status").notNull().default("queued"),
    adapter: text("adapter"),
    attempts: integer("attempts").notNull().default(0),
    /** 1 when the user explicitly asked for AI on this run (Claude Code). Added in 0001. */
    aiRequested: integer("ai_requested").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Candidate field values with provenance (see ExtractionResult in shared/types). */
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    snapshotId: text("snapshot_id"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    appliedAt: integer("applied_at"),
    dismissedAt: integer("dismissed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("extraction_jobs_posting_idx").on(t.jobPostingId, t.createdAt),
    index("extraction_jobs_user_status_idx").on(t.userId, t.status),
  ],
);

// Immutable copies of what the source looked like at fetch / paste time.
export const jobSourceSnapshots = sqliteTable(
  "job_source_snapshots",
  {
    id: id(),
    userId: userId(),
    jobPostingId: text("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    extractionJobId: text("extraction_job_id"),
    method: text("method").notNull(), // ats_api | html | pasted_text | manual
    requestedUrl: text("requested_url"),
    finalUrl: text("final_url"),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    title: text("title"),
    text: text("text").notNull(),
    structuredData: text("structured_data", { mode: "json" }).$type<unknown>(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("snapshots_posting_idx").on(t.jobPostingId, t.fetchedAt)],
);

export const extractedFieldEvidence = sqliteTable(
  "extracted_field_evidence",
  {
    id: id(),
    userId: userId(),
    jobPostingId: text("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    extractionJobId: text("extraction_job_id"),
    field: text("field").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>(),
    source: text("source").notNull(),
    evidence: text("evidence"),
    confidence: text("confidence").notNull(),
    reviewStatus: text("review_status").notNull().default("needs_review"),
    extractedAt: integer("extracted_at").notNull(),
    reviewedAt: integer("reviewed_at"),
  },
  (t) => [index("evidence_posting_field_idx").on(t.jobPostingId, t.field, t.reviewStatus)],
);

// Manual edits of extracted fields. The original extracted value is kept.
export const userFieldOverrides = sqliteTable(
  "user_field_overrides",
  {
    id: id(),
    userId: userId(),
    jobPostingId: text("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>(),
    originalValue: text("original_value", { mode: "json" }).$type<unknown>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("overrides_posting_field_uq").on(t.jobPostingId, t.field)],
);

// ---------------------------------------------------------------- notes, tags

export const notes = sqliteTable(
  "notes",
  {
    id: id(),
    userId: userId(),
    savedJobId: text("saved_job_id")
      .notNull()
      .references(() => savedJobs.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("notes_saved_job_idx").on(t.savedJobId, t.createdAt)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    color: text("color"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tags_user_name_uq").on(t.userId, t.normalizedName)],
);

// Tags attach to the saved-job relationship (one application per saved job, so
// application-level tags would be redundant; see DATABASE_SCHEMA.md).
export const jobTags = sqliteTable(
  "job_tags",
  {
    savedJobId: text("saved_job_id")
      .notNull()
      .references(() => savedJobs.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.savedJobId, t.tagId] }), index("job_tags_tag_idx").on(t.tagId)],
);

// ---------------------------------------------------------------- documents

export const documents = sqliteTable(
  "documents",
  {
    id: id(),
    userId: userId(),
    kind: text("kind").notNull(),
    versionName: text("version_name").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Random, non-enumerable object key. Never exposed to the browser. */
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("documents_user_kind_idx").on(t.userId, t.kind)],
);

export const applicationDocuments = sqliteTable(
  "application_documents",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("other"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.documentId] })],
);

// ---------------------------------------------------------------- contacts, reminders, views

export const contacts = sqliteTable(
  "contacts",
  {
    id: id(),
    userId: userId(),
    companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("other"),
    title: text("title"),
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("contacts_user_idx").on(t.userId)],
);

export const reminders = sqliteTable(
  "reminders",
  {
    id: id(),
    userId: userId(),
    savedJobId: text("saved_job_id").references(() => savedJobs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("custom"),
    title: text("title").notNull(),
    notes: text("notes"),
    dueAt: integer("due_at").notNull(),
    completedAt: integer("completed_at"),
    /** Set for reminders the system created (e.g. default follow-up). */
    autoKey: text("auto_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("reminders_user_due_idx").on(t.userId, t.completedAt, t.dueAt),
    index("reminders_saved_job_idx").on(t.savedJobId),
  ],
);

export const customViews = sqliteTable(
  "custom_views",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    page: text("page").notNull().default("positions"),
    state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("custom_views_user_idx").on(t.userId, t.page)],
);

