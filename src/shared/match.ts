// Result of comparing one job's requirements with the user's profile (computed locally).

export type RequirementCategory = "mandatory" | "preferred" | "unclear";
export type RequirementKind = "licence" | "authorization" | "clearance" | "language" | "education" | "experience" | "certification" | "skill" | "other";
export type MatchStatus = "met" | "partial" | "not_met" | "unknown";

export interface MatchItem {
  id: string;
  /** Requirement wording from the job (original language), and where it came from. */
  text: string;
  field: string;
  index: number | null;
  category: RequirementCategory;
  kind: RequirementKind;
  /** True when the requirement itself is an AI inference (not quoted from the posting). */
  ai_inferred: boolean;
  /** The posting allows alternatives / flexibility ("or equivalent", "may be considered"). */
  flexible: boolean;
  status: MatchStatus;
  /** i18n key under `match.reasons.*` plus parameters. */
  reason: { code: string; params?: Record<string, string | number> };
  /** What in the profile supports the result (shown to the user). */
  profile_evidence: string | null;
  /** Mandatory eligibility items (licence, work authorization, clearance, …) get their own section. */
  eligibility: boolean;
}

export interface MatchSummary {
  has_profile: boolean;
  /** strong | good | partial | weak, or mandatory_gap when any must-have is not met, or insufficient. */
  level: "strong" | "good" | "partial" | "weak" | "mandatory_gap" | "insufficient";
  /** 0-100 from evaluable items only; null when too little can be evaluated. Never hides mandatory gaps. */
  score: number | null;
  mandatory: { met: number; partial: number; not_met: number; unknown: number; total: number };
  preferred: { met: number; partial: number; not_met: number; unknown: number; total: number };
  eligibility_issues: number;
}

export interface MatchResult {
  summary: MatchSummary;
  items: MatchItem[];
  computed_at: number;
}
