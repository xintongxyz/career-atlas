// Automated job applications (Playwright, local only). These are EXECUTION states of one
// automation attempt — they never replace the application pipeline. A job becomes "Applied"
// only through changeStatus, and only after the submission was verified.
import { z } from "zod";

export const ATTEMPT_STATES = [
  "queued",
  "filling",
  "needs_review",
  "submitting",
  "submitted_verified",
  "submission_unconfirmed",
  "failed",
  "cancelled",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** States in which the worker owns the attempt (or will pick it up). */
export const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = ["queued", "filling", "submitting"];
/** States that block starting another attempt for the same job. */
export const BLOCKING_ATTEMPT_STATES: readonly AttemptState[] = ["queued", "filling", "needs_review", "submitting", "submitted_verified", "submission_unconfirmed"];
export const FINAL_ATTEMPT_STATES: readonly AttemptState[] = ["submitted_verified", "failed", "cancelled"];

/** Application systems with a working adapter. Everything else gets manual assistance. */
export const SUPPORTED_ATS = ["greenhouse", "lever"] as const;
export type SupportedAts = (typeof SUPPORTED_ATS)[number];

/** Why an attempt is waiting for the user. */
export const INTERVENTION_REASONS = [
  "missing_information", // a required field has no verified value
  "approval_needed", // a legal declaration / consent needs explicit approval
  "submit_approval", // review mode: everything is filled, waiting for "Submit"
  "captcha", // a CAPTCHA or bot check is shown — never bypassed
  "login_required",
  "unsupported_field", // a required field type the engine cannot fill
  "validation_errors", // the site rejected the form before submitting
  "unexpected_page",
  "manual_in_browser", // the user is finishing in a visible browser window
] as const;
export type InterventionReason = (typeof INTERVENTION_REASONS)[number];

export const QUESTION_KINDS = ["text", "textarea", "select", "radio", "checkbox", "multi", "date", "number"] as const;

/** A question the engine could not answer from verified data. */
export interface PendingQuestion {
  key: string;
  label: string;
  kind: (typeof QUESTION_KINDS)[number];
  required: boolean;
  options: string[];
  /** missing | sensitive | legal | demographic | unsupported | open_ended | no_matching_option */
  reason: string;
  /** Sensitive answers (eligibility, legal) can still be remembered, but only when the user ticks it. */
  sensitive: boolean;
  /** What the profile says, when it says something that did not fit the options. */
  hint?: string | null;
}

export interface FilledField {
  label: string;
  /** Profile path or "answer" / "saved_answer" / "resume". Values are never stored here. */
  source: string;
  verified: boolean;
}

export interface AttemptStep {
  at: number;
  /** Stable code translated in the UI, e.g. opening, detected_ats, filled, uploaded_resume. */
  code: string;
  params?: Record<string, string | number>;
}

export interface AttemptDTO {
  id: string;
  job_id: string;
  state: AttemptState;
  stage: string | null;
  ats: string | null;
  target_url: string;
  submit_mode: "auto" | "review";
  resume: { id: string | null; version_name: string; file_name: string; sha256: string; size_bytes: number; still_available: boolean; unchanged: boolean | null };
  visible: boolean;
  intervention: InterventionReason | null;
  questions: PendingQuestion[];
  filled: FilledField[];
  steps: AttemptStep[];
  error_code: string | null;
  error_message: string | null;
  confirmation: { text: string | null; url: string | null; at: number | null; source: "page" | "user" | null };
  evidence: string[];
  submit_clicked_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

/** Small summary for list views (All Positions, Kanban). */
export interface AttemptSummary {
  id: string;
  state: AttemptState;
  intervention: InterventionReason | null;
  updated_at: number;
}

export interface ApplySupport {
  ats: string | null;
  supported: boolean;
  /** "detect": unknown site; the worker will look for a supported form and otherwise stop. */
  mode: "adapter" | "detect" | "manual";
  url: string | null;
}

export interface ProfileCheckItem {
  key: string;
  ok: boolean;
  required: boolean;
}

export interface ApplyOverview {
  support: ApplySupport;
  resumes: { id: string; version_name: string; file_name: string; mime_type: string; size_bytes: number; created_at: number; notes: string | null; uploadable: boolean }[];
  default_resume_id: string | null;
  profile_check: ProfileCheckItem[];
  attempts: AttemptDTO[];
  blocked_by: string | null;
  worker: { available: boolean; browser: string | null; reason: string | null };
}

export const startApplySchema = z.object({
  resume_document_id: z.string().min(1).max(64),
  submit_mode: z.enum(["auto", "review"]),
  /** The user ticked the authorization checkbox in the confirmation dialog. */
  confirm: z.literal(true),
});

export const answerSchema = z.object({
  answers: z.record(z.string().max(200), z.union([z.string().max(4000), z.array(z.string().max(500)).max(50), z.boolean()])),
  /** Keys whose answers should be remembered for future applications (explicit approval). */
  remember: z.array(z.string().max(200)).max(100).default([]),
});

export const resolveSchema = z.object({ outcome: z.enum(["submitted", "not_submitted"]) });

/** Resume types an application form can receive. */
export const UPLOADABLE_RESUME_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"];
