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
export const SUPPORTED_ATS = ["workday", "greenhouse", "lever"] as const;
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
  "indeed_apply_assisted", // an Indeed-hosted application: the user completes it on Indeed
  "employer_site_manual", // the employer's site is not supported: the user completes it there
  "confirm_result", // the window closed without a confirmation the app could see: did it go through?
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
  /** Recognised meaning (prior_employment, coop_program, phone_type, identity, …) — lets "Remember" save it by meaning. */
  meaning?: string | null;
  /** False for declarations / consents: those are approved each time. */
  rememberable?: boolean;
}

export interface FilledField {
  label: string;
  /** Profile path or "answer" / "saved_answer" / "resume" / "site" (kept as the site filled it). */
  source: string;
  verified: boolean;
  /** "kept": already right on the page; "corrected": a value the site had filled (e.g. from resume parsing) was replaced from My Profile; "parsed": filled by the site's resume parsing and not confirmed by My Profile. */
  status?: "filled" | "kept" | "corrected" | "parsed";
  /** Only for "parsed": the value the site filled, shown for review (stored locally only). */
  value?: string | null;
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
  /** The listing the user started from (e.g. Indeed) when the form is elsewhere. */
  source_url: string | null;
  route: AttemptRoute | null;
  entry_mode: "autofill" | "manual" | null;
  account_mode: "none" | "sign_in" | "create" | null;
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
  /** The user's answers for this attempt (question → answer), for Review. Local only. */
  answered: { key: string; label: string; value: string | string[] | boolean }[];
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

export const ATTEMPT_ROUTES = ["adapter", "indeed_company_site", "indeed_apply", "employer_manual"] as const;
export type AttemptRoute = (typeof ATTEMPT_ROUTES)[number];

export interface ApplySupport {
  ats: string | null;
  supported: boolean;
  /**
   * adapter: Workday / Greenhouse / Lever form · detect: unknown site, the worker looks for a supported
   * form · indeed: an Indeed listing (the user clicks Apply; Career Atlas follows to the employer's
   * form, or assists with Indeed Apply) · manual: copy-ready assistance only.
   */
  mode: "adapter" | "detect" | "indeed" | "manual";
  url: string | null;
  /** Employer application URL found by an earlier attempt for this job (e.g. behind Indeed). */
  resolved_url?: string | null;
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
  /** Workday only: the candidate account for this employer site (never a password). */
  account: AccountStatus | null;
}

export const startApplySchema = z.object({
  resume_document_id: z.string().min(1).max(64),
  submit_mode: z.enum(["auto", "review"]),
  /** The employer's application link (e.g. copied from Indeed's "Apply on company site"). */
  target_url: z.string().trim().url().max(2000).optional(),
  /** Indeed: open the listing in a visible window; the user clicks Apply and Career Atlas follows. */
  indeed_window: z.boolean().optional(),
  /** Workday: Autofill with Resume (default) or Apply Manually. */
  entry_mode: z.enum(["autofill", "manual"]).optional(),
  /** Workday account automation for THIS application: none, sign in with a saved credential, or also create an account (explicit, per employer). */
  account_mode: z.enum(["none", "sign_in", "create"]).optional(),
  /** The user ticked the authorization checkbox in the confirmation dialog. */
  confirm: z.literal(true),
});

export const answerSchema = z.object({
  answers: z.record(z.string().max(200), z.union([z.string().max(4000), z.array(z.string().max(500)).max(50), z.boolean()])),
  /** Keys whose answers should be remembered for future applications (explicit approval). */
  remember: z.array(z.string().max(200)).max(100).default([]),
});

export const resolveSchema = z.object({ outcome: z.enum(["submitted", "not_submitted"]) });

export const accountSettingsSchema = z.object({ password_mode: z.enum(["unique", "shared"]).optional(), auto_sign_in: z.boolean().optional() });
export const sharedPasswordSchema = z.object({ password: z.string().min(8).max(200), confirm: z.string().max(200) });

/** Resume types an application form can receive. */
export const UPLOADABLE_RESUME_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"];

/**
 * Test/dev instances serve synthetic ATS forms from 127.0.0.1 under /wd/, /indeed/ and
 * /indeed/smartapply/. This maps such a URL to the real-site shape it imitates, so URL rules are
 * exercised by the tests. Only applies when loopback targets are allowed (never on the personal
 * instance); every other URL is returned unchanged.
 */
export function classificationUrl(raw: string, allowLoopback: boolean): string {
  if (!allowLoopback) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) return raw;
  const rest = `${u.search}${u.hash}`;
  if (u.pathname.startsWith("/indeed/smartapply/")) return `https://smartapply.indeed.com/${u.pathname.slice("/indeed/smartapply/".length)}${rest}`;
  if (u.pathname.startsWith("/indeed/")) return `https://www.indeed.com/${u.pathname.slice("/indeed/".length)}${rest}`;
  if (u.pathname.startsWith("/wd/")) return `https://fixture.wd1.myworkdayjobs.com/${u.pathname.slice("/wd/".length)}${rest}`;
  return raw;
}

/** Workday candidate-account status for an employer site (never contains a password). */
export interface AccountStatus {
  /** A secure store (macOS Keychain) is available. */
  available: boolean;
  store: "keychain" | "memory" | null;
  tenant: string;
  email: string | null;
  /** A saved credential exists for this employer site and e-mail. */
  credential: boolean;
  /** A recent sign-in failed: not retried automatically. */
  blocked: boolean;
  password_mode: "unique" | "shared";
  shared_configured: boolean;
  auto_sign_in: boolean;
}
