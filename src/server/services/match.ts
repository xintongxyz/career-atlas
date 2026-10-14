// Job ↔ profile matching, computed locally on demand so it always reflects the latest job and
// profile (and applies to every saved job without a separate migration step).
import type { MatchResult, MatchSummary } from "@shared/match";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { chunk } from "../lib/util";
import { matchJob, type JobRequirementsInput } from "../match/engine";
import { postingToFields } from "./mappers";
import { loadSavedJob } from "./pipeline";
import { profileForMatching } from "./profile";

const { jobPostings, extractedFieldEvidence } = schema;
type PostingRow = typeof jobPostings.$inferSelect;
type EvidenceRow = typeof extractedFieldEvidence.$inferSelect;

/** Fields whose current value is an AI inference (no quote from the posting, not entered/confirmed by the user). */
function inferredFields(evidence: EvidenceRow[]): Set<string> {
  const latest = new Map<string, EvidenceRow>();
  for (const e of evidence) if (!latest.has(e.field)) latest.set(e.field, e);
  const out = new Set<string>();
  for (const [field, e] of latest) if (e.source === "ai" && !e.evidence && e.reviewStatus !== "confirmed" && e.reviewStatus !== "overridden") out.add(field);
  return out;
}

function toInput(posting: PostingRow, evidence: EvidenceRow[]): JobRequirementsInput {
  const fields = postingToFields(posting, "", null) as unknown as Record<string, unknown>;
  return { country: posting.country, visa_sponsorship: posting.visaSponsorship, fields, inferred: inferredFields(evidence) };
}

export async function matchForJob(db: Db, userId: string, savedJobId: string): Promise<MatchResult> {
  const { posting } = await loadSavedJob(db, userId, savedJobId);
  const evidence = await db
    .select()
    .from(extractedFieldEvidence)
    .where(and(eq(extractedFieldEvidence.jobPostingId, posting.id), ne(extractedFieldEvidence.reviewStatus, "superseded")))
    .orderBy(desc(extractedFieldEvidence.extractedAt));
  const profile = await profileForMatching(db, userId);
  return matchJob(toInput(posting, evidence), profile?.profile ?? null);
}

/** Summaries for list views (keyed by job posting id). Empty when there is no profile yet. */
export async function matchSummaries(db: Db, userId: string, postingIds: string[]): Promise<Map<string, MatchSummary>> {
  const out = new Map<string, MatchSummary>();
  const profile = await profileForMatching(db, userId);
  if (!profile || !postingIds.length) return out;
  for (const ids of chunk(postingIds, 80)) {
    const [postings, evidence] = await Promise.all([
      db.select().from(jobPostings).where(and(eq(jobPostings.userId, userId), inArray(jobPostings.id, ids))),
      db.select().from(extractedFieldEvidence).where(and(inArray(extractedFieldEvidence.jobPostingId, ids), ne(extractedFieldEvidence.reviewStatus, "superseded"))).orderBy(desc(extractedFieldEvidence.extractedAt)),
    ]);
    for (const p of postings) out.set(p.id, matchJob(toInput(p, evidence.filter((e) => e.jobPostingId === p.id)), profile.profile).summary);
  }
  return out;
}
