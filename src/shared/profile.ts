// Personal profile used for job matching. Stored only in the local database.
// Every field is optional and `null` means "not specified" — never "no".
import { z } from "zod";

export const EDUCATION_LEVELS = ["high_school", "diploma", "bachelor", "master", "doctorate", "other"] as const;
export const LANGUAGE_LEVELS = ["basic", "intermediate", "professional", "fluent", "native"] as const;
export const AUTH_STATUSES = ["citizen", "permanent_resident", "work_permit", "needs_sponsorship", "other"] as const;
export const CERT_STATUSES = ["held", "in_progress"] as const;

const txt = (max = 300) => z.string().trim().max(max);
const optTxt = (max = 300) => txt(max).nullable().optional();
const month = z.string().regex(/^\d{4}(-\d{2})?$/, "YYYY or YYYY-MM").nullable().optional();
const tags = z.array(txt(120).min(1)).max(200).default([]);

// Plain text (not strictly validated): the profile autosaves while the user is still typing.
const url = optTxt(500);
const yn = z.enum(["yes", "no"]).nullable().optional();

export const PHONE_TYPES = ["mobile", "home", "work"] as const;
/** How the applicant wants employers to contact them — independent of the phone type. */
export const CONTACT_METHODS = ["email", "phone", "text"] as const;
export const YES_NO_DEFAULT_KEYS = [
  "prior_employment",
  "prior_contractor",
  "prior_affiliate",
  "referral",
  "relocation",
  "travel",
  "shift_work",
  "age_18",
  "enrolled_student",
  "full_time_student",
  "coop_program",
  "coop_term_required",
  "internship_mandatory",
  "return_to_school",
  "accept_privacy_notices",
] as const;
export type YesNoDefaultKey = (typeof YES_NO_DEFAULT_KEYS)[number];

export const applicationDefaultsSchema = z.object({
  phone_type: z.enum(PHONE_TYPES).nullable().optional(),
  /** "Preferred contact method" questions (Email / Phone / Text). Never inferred from the phone type. */
  preferred_contact_method: z.enum(CONTACT_METHODS).nullable().optional(),
  /** Standing permission to acknowledge plain recruitment privacy notices (never declarations or background checks). */
  accept_privacy_notices: yn,
  phone_country_code: optTxt(10),
  /** "Have you worked for <this employer> before?" — with per-employer exceptions. */
  prior_employment: yn,
  prior_employment_exceptions: z.array(z.object({ employer: txt(200).min(1), answer: z.enum(["yes", "no"]) })).max(100).default([]),
  prior_contractor: yn,
  prior_affiliate: yn,
  referral: yn,
  relocation: yn,
  travel: yn,
  shift_work: yn,
  age_18: yn,
  // student status — each a separate fact (a student is not necessarily a co-op student)
  enrolled_student: yn,
  full_time_student: yn,
  coop_program: yn,
  coop_term_required: yn,
  internship_mandatory: yn,
  return_to_school: yn,
  expected_graduation: z.string().regex(/^\d{4}(-\d{2})?$/, "YYYY or YYYY-MM").nullable().optional(),
  placement_months: z.array(z.number().int().min(1).max(24)).max(6).default([]),
  // sponsorship needs, independent of the authorization status (a work permit says nothing about the future)
  sponsorship_now: yn,
  sponsorship_future: yn,
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable().optional(),
  notice_period: optTxt(100),
  salary_expectation: optTxt(100),
  hourly_expectation: optTxt(100),
  source: optTxt(200),
  /**
   * Standing consents by CATEGORY (owner opt-in, each separate). A consent is given automatically only
   * when every category its text touches is authorised here; anything else is asked.
   */
  standing_consents: z
    .object({
      /** Ordinary application terms (the terms' text must be readable on the page or at its link). */
      routine_terms: z.boolean().optional(),
      /** "I have read the information about this application / position". */
      read_information: z.boolean().optional(),
      /** "The information I provided is accurate" — only when every filled value was verified. */
      accuracy_declaration: z.boolean().optional(),
      /** Interviews recorded and / or transcribed (e.g. an interview-intelligence tool). */
      interview_recording: z.boolean().optional(),
      /** Recordings used for internal training, quality or model improvement. */
      recording_training: z.boolean().optional(),
      /** Background, criminal, credit or reference checks. */
      background_check: z.boolean().optional(),
      /** Sharing application data with additional third parties or affiliates. */
      third_party_sharing: z.boolean().optional(),
    })
    .default({}),
  /**
   * AI-written answers to open questions ("describe a project"): "on" lets Career Atlas send the facts a
   * question needs (work / project / education / skills entries — never contact details, identity,
   * eligibility or credentials) to the signed-in AI provider. Off unless the owner turns it on.
   */
  ai_answer_writing: z.enum(["on", "off"]).nullable().optional(),
  /** Time-sensitive: an offer / recruiting deadline answer and the date it was given (reused only while fresh). */
  recruiting_deadline: z.object({ answer: txt(500), as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable().optional(),
});
export type ApplicationDefaults = z.infer<typeof applicationDefaultsSchema>;

export const profileSchema = z.object({
  /** Contact details used to fill application forms. */
  contact: z
    .object({
      first_name: optTxt(120),
      last_name: optTxt(120),
      preferred_name: optTxt(120),
      email: optTxt(254),
      phone: optTxt(40),
      linkedin_url: url,
      github_url: url,
      portfolio_url: url,
      website_url: url,
      address: optTxt(300),
      postal_code: optTxt(20),
    })
    .default({}),
  based_in: z.object({ city: optTxt(120), region: optTxt(120), country: optTxt(120) }).default({}),
  work_authorization: z
    .array(z.object({ country: txt(120).min(1), status: z.enum(AUTH_STATUSES), note: optTxt(500), expires: month }))
    .max(20)
    .default([]),
  driver_licence: z
    .object({
      has: z.boolean().nullable().default(null),
      type: optTxt(60),
      jurisdiction: optTxt(120),
      has_vehicle: z.boolean().nullable().default(null),
    })
    .default({ has: null, has_vehicle: null }),
  security_clearance: optTxt(200),
  languages: z.array(z.object({ language: txt(60).min(1), level: z.enum(LANGUAGE_LEVELS) })).max(30).default([]),
  education: z
    .array(
      z.object({
        level: z.enum(EDUCATION_LEVELS),
        field: optTxt(200),
        institution: optTxt(200),
        country: optTxt(120),
        /** false = in progress; null = not specified. */
        completed: z.boolean().nullable().default(true),
        year: z.number().int().min(1950).max(2100).nullable().optional(),
        /** Optional exact months (YYYY or YYYY-MM); `year` stays the graduation / expected year. */
        start: month,
        end: month,
      }),
    )
    .max(20)
    .default([]),
  experience: z
    .array(
      z.object({
        title: txt(200).min(1),
        organization: optTxt(200),
        start: month,
        /** null with current=true means "to date". */
        end: month,
        current: z.boolean().default(false),
        areas: tags,
        description: optTxt(3000),
      }),
    )
    .max(60)
    .default([]),
  /** Explicit "N years of X" statements that override what is computed from dated experience. */
  experience_summary: z.array(z.object({ area: txt(120).min(1), years: z.number().min(0).max(60) })).max(40).default([]),
  skills: tags,
  certifications: z.array(z.object({ name: txt(200).min(1), status: z.enum(CERT_STATUSES).default("held") })).max(60).default([]),
  projects: z.array(z.object({ name: txt(200).min(1), description: optTxt(2000), skills: tags })).max(60).default([]),
  notes: optTxt(4000),
  /**
   * Reusable answers to common application questions. Every value is optional: null / missing
   * means "not specified" and is NEVER treated as "no". Matched by meaning (src/local/apply/semantic.ts),
   * not by wording; identity questions are never answered from here.
   */
  application_defaults: applicationDefaultsSchema.prefault({}),
  /**
   * Answers the user explicitly approved for reuse in application forms (e.g. "How did you hear
   * about us?"). Matched only by the exact (normalized) question text.
   */
  saved_answers: z
    .array(z.object({ question: txt(500).min(1), answer: z.union([txt(4000), z.array(txt(500)).max(50), z.boolean()]), created_at: z.number().int().optional(), employer: optTxt(200) }))
    .max(200)
    .default([]),
});
export type Profile = z.infer<typeof profileSchema>;
export const emptyProfile = (): Profile => profileSchema.parse({});

// ---------- profile drafts (resume import via Claude Desktop or "Import from AI") ----------

export const PROFILE_IMPORT_FORMAT = "career-atlas-profile-import/v1";
export const PROFILE_SECTIONS = [
  "based_in",
  "work_authorization",
  "driver_licence",
  "security_clearance",
  "languages",
  "education",
  "experience",
  "experience_summary",
  "skills",
  "certifications",
  "projects",
] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** One proposed fact. `evidence` is a quote from the resume; verified when found in resume_text. */
const draftItem = z.object({
  section: z.enum(PROFILE_SECTIONS),
  value: z.unknown(),
  evidence: z.string().max(1000).nullable().optional(),
  basis: z.enum(["resume", "inferred"]).catch("inferred").default("inferred"),
});

export const profileImportSchema = z.object({
  format: z.string().max(60).optional(),
  origin: z.enum(["claude_desktop", "paste"]).default("paste"),
  /** Plain text of the resume, used only to verify quotes (not stored). */
  resume_text: z.string().max(100_000).nullable().optional(),
  items: z.array(draftItem).max(400).default([]),
  notes: z.string().max(4000).nullable().optional(),
});
export type ProfileImportInput = z.infer<typeof profileImportSchema>;

export interface ProfileDraftItem {
  id: string;
  section: ProfileSection;
  value: unknown;
  evidence: string | null;
  verified: boolean;
}

export interface ProfileDraft {
  origin: "claude_desktop" | "paste";
  created_at: number;
  items: ProfileDraftItem[];
  dropped: { section: string; reason: string }[];
  notes: string | null;
}

export interface ProfileDTO {
  profile: Profile;
  updated_at: number | null;
  resume_document_id: string | null;
  draft: ProfileDraft | null;
}
