import { SENSITIVE_FIELDS, type Confidence, type EvidenceSource, type ExtractableField } from "@shared/constants";
import type { ExtractionResult, FieldCandidate, ResultField } from "@shared/types";
import { sameValue } from "../services/mappers";
import type { CandidateSet } from "./jsonld";

const SOURCE_RANK: Record<EvidenceSource, number> = { user: 6, ats_api: 5, json_ld: 4, ai: 3, heuristic: 2, html_meta: 1 };
const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function isEmpty(v: unknown) {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0) || v === "unknown" || v === "unspecified";
}

/** Values that disagree in a way that matters (ignores formatting, case, list order). */
function differs(field: ExtractableField, a: unknown, b: unknown): boolean {
  if (field === "salary") {
    const x = a as { min: number | null; max: number | null; currency: string | null; period: string };
    const y = b as typeof x;
    const close = (m: number | null, n: number | null) => m == null || n == null || Math.abs(m - n) <= Math.max(m, n) * 0.01;
    return !(close(x.min, y.min) && close(x.max, y.max) && (!x.currency || !y.currency || x.currency === y.currency));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false; // list content legitimately varies by source
  if (typeof a === "string" && typeof b === "string") {
    const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
    return !(n(a).includes(n(b)) || n(b).includes(n(a)));
  }
  if (typeof a === "number" && typeof b === "number" && field.endsWith("_at")) {
    return Math.abs(a - b) > 36 * 3600_000; // date fields: allow timezone slop
  }
  return !sameValue(a, b);
}

/**
 * Merges candidates from several sources. The highest-ranked candidate wins
 * (confidence first, then source reliability). Disagreements between sources
 * are surfaced as conflicts instead of being silently resolved.
 */
export function mergeCandidates(sets: CandidateSet[]): Partial<Record<ExtractableField, ResultField>> {
  const byField = new Map<ExtractableField, FieldCandidate[]>();
  for (const set of sets) {
    for (const [k, c] of Object.entries(set) as [ExtractableField, FieldCandidate][]) {
      if (!c || isEmpty(c.value)) continue;
      const list = byField.get(k) ?? [];
      list.push(c);
      byField.set(k, list);
    }
  }
  const out: Partial<Record<ExtractableField, ResultField>> = {};
  for (const [field, list] of byField) {
    list.sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || SOURCE_RANK[b.source] - SOURCE_RANK[a.source]);
    const [best, ...rest] = list;
    const conflicting = rest.filter((c) => c.confidence !== "low" && differs(field, best.value, c.value));
    const sensitive = SENSITIVE_FIELDS.includes(field);
    const needsReview =
      conflicting.length > 0 ||
      best.confidence === "low" ||
      (sensitive && (best.source === "ai" || best.source === "heuristic")) ||
      (field === "salary" && hasIncompleteSalary(best.value));
    out[field] = {
      ...best,
      ...(conflicting.length ? { conflict: true, alternatives: conflicting.slice(0, 3) } : {}),
      ...(needsReview ? { needs_review: true } : {}),
    };
  }
  return out;
}

function hasIncompleteSalary(v: unknown): boolean {
  const s = v as { currency: string | null; period: string } | null;
  return !s || !s.currency || s.period === "unknown";
}

export type Outcome = "succeeded" | "partial" | "needs_review";

export function decideOutcome(result: ExtractionResult): Outcome {
  const f = result.fields;
  const coreMissing = !f.title || !f.company_name || !result.description_text;
  if (coreMissing) return "partial";
  const anyReview = Object.values(f).some((x) => x?.needs_review);
  return anyReview ? "needs_review" : "succeeded";
}
