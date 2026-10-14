import type {
  ApplicationStatus,
  Confidence,
  ContentLang,
  EventType,
  EvidenceSource,
  ExtractableField,
  ExtractionStatus,
  PipelineStatus,
  Priority,
  ReminderKind,
  ReviewStatus,
  SavedStage,
  TranslatableField,
} from "./constants";
import type { JobFields, Salary } from "./schemas";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}

// ---------- extraction ----------

export interface FieldCandidate {
  value: unknown;
  source: EvidenceSource;
  evidence: string | null;
  confidence: Confidence;
}

export interface ResultField extends FieldCandidate {
  /** Other sources disagreed with the chosen value. */
  conflict?: boolean;
  alternatives?: FieldCandidate[];
  /** True when the field should be reviewed before trusting it. */
  needs_review?: boolean;
  /**
   * AI drafts only: where the value came from. "posting" = quote verified in the job description,
   * "web" = researched on another page (source_url), "inferred" = AI judgment, not stated anywhere.
   */
  basis?: "posting" | "web" | "inferred";
  source_url?: string | null;
}

/**
 * AI translations of descriptive job fields, stored on the job (display only, never evidence).
 * The original values stay in the normal fields; `content_language` says which language they are in.
 */
export interface JobTranslations {
  source: "ai";
  generated_at: number;
  values: Partial<Record<ContentLang, Partial<Record<TranslatableField, string | string[]>>>>;
}

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ResultField>>;
  /** AI drafts: language of the original posting and AI translations of descriptive fields. */
  content_language?: string | null;
  translations?: JobTranslations["values"] | null;
  description_text: string | null;
  source_title: string | null;
  warnings: string[];
  ai_used: boolean;
}

export interface ExtractionDTO {
  id: string;
  job_posting_id: string;
  saved_job_id: string | null;
  purpose: "initial" | "refresh";
  input_type: "url" | "text";
  input_url: string | null;
  status: ExtractionStatus;
  adapter: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  result: ExtractionResult | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  applied_at: number | null;
  dismissed_at: number | null;
  /** For refreshes / review: what is currently stored on the posting, by field. */
  current?: Partial<Record<ExtractableField, unknown>>;
  /** Fields the user edited manually (never overwritten by default). */
  overridden_fields?: ExtractableField[];
}

// ---------- jobs ----------

export interface TagDTO {
  id: string;
  name: string;
  color: string | null;
}

export interface JobListItem {
  id: string; // saved job id
  job_posting_id: string;
  company_id: string;
  company_name: string;
  company_domain: string | null;
  company_logo_url: string | null;
  title: string;
  /** Language of the original posting text (null when unknown). */
  content_language: string | null;
  /** AI-translated titles by UI language (display only). */
  title_translations: Partial<Record<ContentLang, string>> | null;
  city: string | null;
  region: string | null;
  country: string | null;
  work_mode: string;
  employment_type: string;
  source_platform: string;
  salary: Salary | null;
  deadline_at: number | null;
  posting_status: string;
  extraction_status: ExtractionStatus;
  status: PipelineStatus;
  stage: SavedStage;
  application_id: string | null;
  application_status: ApplicationStatus | null;
  priority: Priority | null;
  is_starred: boolean;
  interest_level: number | null;
  next_action: string | null;
  follow_up_at: number | null;
  saved_at: number;
  applied_at: number | null;
  last_activity_at: number;
  archived_at: number | null;
  needs_review_count: number;
  /** Extraction finished but not yet reviewed/saved by the user. */
  pending_extraction: boolean;
  tags: TagDTO[];
  /** Profile match summary (only when the user has a profile; computed locally). */
  match?: import("./match").MatchSummary | null;
}

export interface EvidenceDTO {
  id: string;
  field: ExtractableField;
  value: unknown;
  source: EvidenceSource;
  evidence: string | null;
  confidence: Confidence;
  review_status: ReviewStatus;
  extracted_at: number;
}

export interface OverrideDTO {
  field: ExtractableField;
  value: unknown;
  original_value: unknown;
  updated_at: number;
}

export interface ApplicationDTO {
  id: string;
  status: ApplicationStatus;
  applied_at: number;
  applied_via: string | null;
  last_activity_at: number;
  first_response_at: number | null;
  last_response_at: number | null;
  next_follow_up_at: number | null;
  next_interview_at: number | null;
  offer_deadline_at: number | null;
  final_outcome_at: number | null;
  reached_assessment_at: number | null;
  reached_interview_at: number | null;
  reached_offer_at: number | null;
  resume_document_id: string | null;
  cover_letter_document_id: string | null;
  notes: string | null;
}

export interface CompanyDTO {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
  logo_url: string | null;
  industry: string | null;
  description: string | null;
  notes: string | null;
  job_count?: number;
}

export interface JobDetail {
  id: string;
  status: PipelineStatus;
  posting: JobFields & {
    id: string;
    canonical_url: string | null;
    extraction_status: ExtractionStatus;
    latest_extraction_id: string | null;
    last_checked_at: number | null;
    created_at: number;
    updated_at: number;
    translations: JobTranslations | null;
  };
  company: CompanyDTO;
  personal: {
    stage: SavedStage;
    is_starred: boolean;
    priority: Priority | null;
    interest_level: number | null;
    fit_assessment: string | null;
    fit_score: number | null;
    next_action: string | null;
    next_action_at: number | null;
    follow_up_at: number | null;
    resume_document_id: string | null;
    cover_letter_document_id: string | null;
    referral_contact_id: string | null;
    recruiter_contact_id: string | null;
    application_notes: string | null;
    saved_at: number;
    last_activity_at: number;
    archived_at: number | null;
  };
  application: ApplicationDTO | null;
  tags: TagDTO[];
  evidence: EvidenceDTO[];
  overrides: OverrideDTO[];
  latest_extraction: Pick<ExtractionDTO, "id" | "status" | "purpose" | "error_code" | "error_message" | "created_at" | "finished_at" | "applied_at" | "dismissed_at"> | null;
  snapshot_count: number;
}

export interface EventDTO {
  id: string;
  saved_job_id: string;
  application_id: string | null;
  type: EventType;
  from_status: string | null;
  to_status: string | null;
  title: string | null;
  details: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: number;
  scheduled_for: number | null;
  created_at: number;
  company_name?: string;
  job_title?: string;
}

export interface NoteDTO {
  id: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface ReminderDTO {
  id: string;
  saved_job_id: string | null;
  kind: ReminderKind;
  title: string;
  notes: string | null;
  due_at: number;
  completed_at: number | null;
  company_name?: string | null;
  job_title?: string | null;
}

export interface DocumentDTO {
  id: string;
  kind: string;
  version_name: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  notes: string | null;
  created_at: number;
  usage_count: number;
}

export interface ContactDTO {
  id: string;
  name: string;
  kind: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  company_id: string | null;
  company_name?: string | null;
  notes: string | null;
}

export interface DuplicateMatch {
  id: string; // saved job id
  job_posting_id: string;
  company_name: string;
  title: string;
  city: string | null;
  status: PipelineStatus;
  saved_at: number;
  posting_status: string;
  reason: "same_external_id" | "same_url" | "similar";
}

export interface MeDTO {
  user: { id: string; email: string };
  preferences: {
    locale: "en" | "zh-CN";
    timezone: string;
    default_follow_up_days: number;
    comparison: import("./schemas").ComparisonPrefs;
  };
  config: {
    app_env: string;
    auth_mode: string;
    ai_enabled: boolean;
    ai_provider: string;
    uploads_enabled: boolean;
    queue_enabled: boolean;
    demo: boolean;
    max_upload_bytes: number;
    read_only: boolean;
  };
}

export interface CalendarItem {
  id: string;
  kind: "applied" | "follow_up" | "interview" | "deadline" | "offer_deadline" | "reminder";
  at: number;
  title: string;
  saved_job_id: string | null;
  company_name: string | null;
  job_title: string | null;
  reminder_id?: string;
  completed?: boolean;
}

export interface DashboardDTO {
  counts: {
    saved_total: number;
    applications_total: number;
    awaiting_response: number;
    interviews: number;
    offers: number;
    follow_ups_due: number;
    needs_review: number;
  };
  pipeline: { status: PipelineStatus; count: number }[];
  recent_events: EventDTO[];
  upcoming: CalendarItem[];
  overdue: CalendarItem[];
}

export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null; // null = insufficient data
}

export interface AnalyticsDTO {
  range: { from: number | null; to: number | null };
  totals: {
    saved: number;
    applied: number;
    responses: number;
    assessments: number;
    interviews: number;
    offers: number;
    rejections: number;
    withdrawals: number;
    active: number;
  };
  by_status: { status: string; count: number }[];
  by_week: { period: string; applied: number; saved: number }[];
  by_month: { period: string; applied: number; saved: number }[];
  rates: {
    response_rate: Ratio;
    interview_rate: Ratio;
    offer_rate: Ratio;
    interview_to_offer: Ratio;
  };
  time: {
    first_response_days: { count: number; average: number | null; median: number | null };
    stage_days: { status: string; count: number; average: number | null; median: number | null }[];
    open_applications_age_days: { count: number; median: number | null };
    overdue_follow_ups: number;
  };
  segments: Record<
    "category" | "resume" | "work_mode" | "city" | "source" | "month",
    { key: string; applied: number; responses: number; interviews: number; offers: number }[]
  >;
}

export interface DraftSummaryDTO {
  id: string;
  origin: "claude_desktop" | "paste";
  company_name: string | null;
  title: string | null;
  source_url: string | null;
  created_at: number;
}

export interface DraftDTO extends DraftSummaryDTO {
  status: "pending" | "saved" | "discarded";
  notes: string | null;
  saved_job_id: string | null;
  /** Shaped like an extraction so the standard review screen can show it. */
  extraction: ExtractionDTO;
  url_duplicates: DuplicateMatch[];
}

export interface DraftCreatedDTO {
  id: string;
  review_path: string;
  possible_duplicate: boolean;
  accepted_fields: string[];
  needs_review_fields: string[];
  dropped: { field: string; reason: string }[];
  /** Languages with AI translations, e.g. ["en", "zh-CN"]. */
  translations: string[];
}
