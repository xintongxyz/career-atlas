// AI drafts: structured job details proposed by an AI tool (Claude Desktop extension or
// "Import from AI"). A draft is verified, stored, and shown for review; it becomes a job only
// when the user clicks Save, through the same applyExtraction path as every other import.
//
// Verification rules (same spirit as ai/extract-job.ts):
//   basis "posting"  → the evidence quote must occur in the job description; otherwise downgraded
//   basis "web"      → needs a source URL (researched elsewhere, e.g. the company site); review needed
//   basis "inferred" → AI judgment; low confidence, review needed
//   sensitive fields (salary, visa, authorization, eligibility, work mode, deadline) are kept only
//   when verified in the posting. Nothing is invented: missing fields stay missing.
import { EXTRACTABLE_FIELDS, LIMITS, SENSITIVE_FIELDS, type ExtractableField } from "@shared/constants";
import { jobFieldsSchema, salarySchema, type AiImportInput } from "@shared/schemas";
import type { DraftCreatedDTO, DraftDTO, DraftSummaryDTO, ExtractionResult, ResultField } from "@shared/types";
import { and, desc, eq } from "drizzle-orm";
import { evidenceInSource, normalize, salaryNumbersInQuote } from "../ai/extract-job";
import { schema, type Db } from "../db/client";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors";
import { newId, now, sha256Hex } from "../lib/util";
import { applyExtraction, createExtractionRow, PLACEHOLDER_COMPANY } from "./extractions";
import { findDuplicates, insertJob } from "./jobs";

const { jobDrafts, jobExtractionJobs, jobSourceSnapshots } = schema;

const FIELD_ALIASES: Record<string, ExtractableField> = { deadline: "deadline_at", posted: "posted_at", website: "company_website", company: "company_name", location_city: "city" };
const DATE_FIELDS = new Set<ExtractableField>(["deadline_at", "posted_at"]);
const shape = jobFieldsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u);
const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || v === "unknown";

function normalizeValue(field: ExtractableField, value: unknown, evidence: string | null): { ok: true; value: unknown } | { ok: false } {
  let v = value;
  if (DATE_FIELDS.has(field)) {
    if (typeof v === "string") v = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:00Z` : v);
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
  }
  if (field === "salary") {
    const s = (v ?? {}) as Record<string, unknown>;
    v = {
      min: typeof s.min === "number" ? s.min : null,
      max: typeof s.max === "number" ? s.max : null,
      currency: typeof s.currency === "string" ? s.currency : null,
      period: typeof s.period === "string" ? s.period : "unknown",
      source: "employer",
      text: (typeof s.text === "string" ? s.text : evidence)?.slice(0, 500) ?? null,
      compensation_type: null,
    };
    const r = salarySchema.safeParse(v);
    return r.success ? { ok: true, value: r.data } : { ok: false };
  }
  if (typeof v === "string" && Array.isArray((shape[field]?.safeParse([]) as { data?: unknown }).data)) v = [v];
  const r = shape[field]?.safeParse(v);
  return r?.success ? { ok: true, value: r.data } : { ok: false };
}

/** Converts and verifies AI-proposed fields into an ExtractionResult with per-field basis. */
export function convertAiImport(input: AiImportInput): { result: ExtractionResult; dropped: { field: string; reason: string }[] } {
  const jd = input.job_description?.trim() ? input.job_description.trim().slice(0, LIMITS.jdMaxChars) : null;
  const src = jd ? normalize(jd) : "";
  const fields: Partial<Record<ExtractableField, ResultField>> = {};
  const dropped: { field: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const [rawKey, entry] of Object.entries(input.fields)) {
    const key = (FIELD_ALIASES[rawKey] ?? rawKey) as ExtractableField;
    if (!(EXTRACTABLE_FIELDS as readonly string[]).includes(key)) {
      dropped.push({ field: rawKey, reason: "unknown_field" });
      continue;
    }
    if (isEmpty(entry.value)) continue;
    const evidence = entry.evidence?.trim() ? entry.evidence.trim().slice(0, 600) : null;
    const norm = normalizeValue(key, entry.value, evidence);
    if (!norm.ok) {
      dropped.push({ field: key, reason: "invalid_value" });
      warnings.push(`ai_invalid_value:${key}`);
      continue;
    }
    let basis = entry.basis;
    const sourceUrl = isHttp(entry.source_url) ? entry.source_url : key === "company_website" && isHttp(norm.value) ? norm.value : null;
    if (basis === "posting") {
      const verified = !!jd && evidenceInSource(evidence, src) && (key !== "salary" || salaryNumbersInQuote(norm.value as { min: number | null; max: number | null }, evidence));
      if (!verified) {
        basis = "inferred";
        warnings.push(`ai_quote_not_found:${key}`);
      }
    } else if (basis === "web" && !sourceUrl) {
      basis = "inferred";
    }
    if (basis !== "posting" && (SENSITIVE_FIELDS.includes(key) || key === "salary")) {
      // Costly if wrong: only accepted when the posting itself says so (verified quote).
      dropped.push({ field: key, reason: "sensitive_not_verified" });
      warnings.push(`ai_sensitive_dropped:${key}`);
      continue;
    }
    fields[key] =
      basis === "posting"
        ? { value: norm.value, source: "ai", evidence, confidence: "high", basis }
        : basis === "web"
          ? { value: norm.value, source: "ai", evidence: evidence ? `${evidence} — ${sourceUrl}` : sourceUrl, confidence: "medium", basis, source_url: sourceUrl, needs_review: true }
          : { value: norm.value, source: "ai", evidence: null, confidence: "low", basis: "inferred", needs_review: true };
  }
  return { result: { fields, description_text: jd, source_title: null, warnings: [...new Set(warnings)], ai_used: true }, dropped };
}

const cv = (r: ExtractionResult, f: ExtractableField) => {
  const v = r.fields[f]?.value;
  return typeof v === "string" && v.trim() ? v : null;
};

export async function createDraft(db: Db, userId: string, input: AiImportInput): Promise<DraftCreatedDTO> {
  const { result, dropped } = convertAiImport(input);
  const id = newId();
  const ts = now();
  await db.insert(jobDrafts).values({
    id,
    userId,
    origin: input.origin,
    status: "pending",
    sourceUrl: input.source_url ?? null,
    descriptionText: result.description_text,
    result: result as unknown as Record<string, unknown>,
    notes: input.notes?.trim() || null,
    createdAt: ts,
    updatedAt: ts,
  });
  const dups = input.source_url ? await findDuplicates(db, userId, { url: input.source_url }) : [];
  const entries = Object.entries(result.fields) as [string, ResultField][];
  return {
    id,
    review_path: `/drafts/${id}`,
    possible_duplicate: dups.length > 0,
    accepted_fields: entries.filter(([, f]) => !f.needs_review).map(([k]) => k),
    needs_review_fields: entries.filter(([, f]) => f.needs_review).map(([k]) => k),
    dropped,
  };
}

async function loadDraft(db: Db, userId: string, id: string) {
  const d = await db.query.jobDrafts.findFirst({ where: and(eq(jobDrafts.id, id), eq(jobDrafts.userId, userId)) });
  if (!d) throw notFound("draft");
  return d;
}

const summary = (d: typeof jobDrafts.$inferSelect): DraftSummaryDTO => {
  const r = d.result as unknown as ExtractionResult;
  return { id: d.id, origin: d.origin as DraftSummaryDTO["origin"], company_name: cv(r, "company_name"), title: cv(r, "title"), source_url: d.sourceUrl, created_at: d.createdAt };
};

export async function listDrafts(db: Db, userId: string): Promise<DraftSummaryDTO[]> {
  const rows = await db.select().from(jobDrafts).where(and(eq(jobDrafts.userId, userId), eq(jobDrafts.status, "pending"))).orderBy(desc(jobDrafts.createdAt)).limit(100);
  return rows.map(summary);
}

export async function getDraft(db: Db, userId: string, id: string): Promise<DraftDTO> {
  const d = await loadDraft(db, userId, id);
  const result = d.result as unknown as ExtractionResult;
  return {
    ...summary(d),
    status: d.status as DraftDTO["status"],
    notes: d.notes,
    saved_job_id: d.savedJobId,
    url_duplicates: d.sourceUrl && d.status === "pending" ? await findDuplicates(db, userId, { url: d.sourceUrl }) : [],
    extraction: {
      id: d.id,
      job_posting_id: "",
      saved_job_id: null,
      purpose: "initial",
      input_type: d.descriptionText ? "text" : "url",
      input_url: d.sourceUrl,
      status: "needs_review",
      adapter: "ai_import",
      attempts: 0,
      error_code: null,
      error_message: null,
      result,
      created_at: d.createdAt,
      started_at: null,
      finished_at: d.createdAt,
      applied_at: null,
      dismissed_at: null,
      current: {},
      overridden_fields: [],
    },
  };
}

/** Turns a reviewed draft into a job: same validation and save path as every extraction. */
export async function saveDraft(db: Db, userId: string, id: string, body: { fields: Record<string, unknown>; review_later?: string[]; confirm_duplicate?: boolean }) {
  const d = await loadDraft(db, userId, id);
  if (d.status !== "pending") throw conflict("draft_not_pending", "This draft was already saved or discarded");
  const result = d.result as unknown as ExtractionResult;

  // Validate first so a rejected save never leaves a half-created job behind.
  const allowed = new Set<string>([...EXTRACTABLE_FIELDS, "description_text"]);
  const unknownKeys = Object.keys(body.fields).filter((k) => !allowed.has(k));
  if (unknownKeys.length) throw badRequest("unknown_fields", "Unknown fields", { fields: unknownKeys });
  const raw = { ...body.fields };
  if (raw.description_text === true) raw.description_text = result.description_text;
  const parsed = jobFieldsSchema.partial().safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Invalid field values", parsed.error.issues);
  const company = (parsed.data.company_name ?? "").trim();
  if (!company) throw badRequest("company_required", "Enter the company before saving");
  if (!(parsed.data.title ?? "").trim()) throw badRequest("title_required", "Enter the job title before saving");

  if (!body.confirm_duplicate && d.sourceUrl) {
    const dups = await findDuplicates(db, userId, { url: d.sourceUrl });
    if (dups.length) throw conflict("possible_duplicate", "Possible duplicate found", { matches: dups });
  }

  const { savedJobId, postingId } = await insertJob(db, userId, { company_name: company || PLACEHOLDER_COMPANY, title: "", original_url: d.sourceUrl, description_text: d.descriptionText } as never, {
    extractionStatus: "needs_review",
  });
  const extractionId = await createExtractionRow(db, userId, postingId, { purpose: "initial", inputType: d.descriptionText ? "text" : "url", inputUrl: d.sourceUrl });
  const ts = now();
  let snapshotId: string | null = null;
  if (d.descriptionText) {
    // The original job description exactly as provided, kept as an immutable snapshot.
    snapshotId = newId();
    await db.insert(jobSourceSnapshots).values({
      id: snapshotId,
      userId,
      jobPostingId: postingId,
      extractionJobId: extractionId,
      method: "pasted_text",
      requestedUrl: d.sourceUrl,
      finalUrl: d.sourceUrl,
      httpStatus: null,
      contentType: "text/plain",
      title: null,
      text: d.descriptionText,
      structuredData: null,
      contentHash: await sha256Hex(d.descriptionText),
      fetchedAt: ts,
    });
  }
  await db
    .update(jobExtractionJobs)
    .set({ status: "needs_review", adapter: "ai_import", result: d.result, snapshotId, finishedAt: ts, startedAt: ts, updatedAt: ts })
    .where(eq(jobExtractionJobs.id, extractionId));
  const applied = await applyExtraction(db, userId, extractionId, { fields: body.fields, review_later: body.review_later });
  await db.update(jobDrafts).set({ status: "saved", savedJobId, updatedAt: now() }).where(eq(jobDrafts.id, d.id));
  return { saved_job_id: applied.saved_job_id };
}

export async function discardDraft(db: Db, userId: string, id: string) {
  const d = await loadDraft(db, userId, id);
  if (d.status !== "pending") return;
  await db.update(jobDrafts).set({ status: "discarded", updatedAt: now() }).where(eq(jobDrafts.id, d.id));
}
