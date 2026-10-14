import { EXTRACTABLE_FIELDS, EXTRACTION_TERMINAL, LIMITS, type ExtractableField, type ExtractionStatus } from "@shared/constants";
import { jobFieldsSchema, type CaptureInput, type JobFields } from "@shared/schemas";
import type { ExtractionDTO, ExtractionResult } from "@shared/types";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getAiProvider } from "../ai/provider";
import { getDb, schema, type Db } from "../db/client";
import type { AppEnv, ExtractionMessage } from "../env";
import { defaultDeps, runPipeline, type PipelineDeps } from "../extraction/pipeline";
import { companyHintFromUrl } from "../extraction/platforms";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors";
import { domainOf, newId, now, sha256Hex } from "../lib/util";
import { findOrCreateCompany } from "./companies";
import { findDuplicates, insertJob } from "./jobs";
import { currentFieldValue, fieldsToColumns, sameValue } from "./mappers";
import { eventInsert, loadSavedJob, runBatch } from "./pipeline";

const { jobExtractionJobs, jobPostings, jobSourceSnapshots, extractedFieldEvidence, userFieldOverrides, savedJobs, companies, contacts } = schema;

export const PLACEHOLDER_COMPANY = "Unknown company";

export class RetryableExtractionError extends Error {}

// ---------------------------------------------------------------- dispatch

export interface Dispatcher {
  dispatch(msg: ExtractionMessage): Promise<void>;
}

/** Background task runner when configured (the app); otherwise runs inline (tests, CLI). */
export function makeDispatcher(env: AppEnv, deps?: PipelineDeps): Dispatcher {
  return {
    async dispatch(msg) {
      if (env.EXTRACTION_DISPATCH) await env.EXTRACTION_DISPATCH(msg);
      else await processExtraction(env, msg.extractionId, 1, deps).catch(() => undefined);
    },
  };
}

export async function createExtractionRow(
  db: Db,
  userId: string,
  postingId: string,
  input: { purpose: "initial" | "refresh"; inputType: "url" | "text"; inputUrl: string | null; useAi?: boolean },
) {
  const id = newId();
  const ts = now();
  await runBatch(db, [
    db.insert(jobExtractionJobs).values({
      id,
      userId,
      jobPostingId: postingId,
      purpose: input.purpose,
      inputType: input.inputType,
      inputUrl: input.inputUrl,
      aiRequested: input.useAi ? 1 : 0,
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
    }),
    db.update(jobPostings).set({ extractionStatus: "queued", latestExtractionId: id, updatedAt: ts }).where(eq(jobPostings.id, postingId)),
  ]);
  return id;
}

// ---------------------------------------------------------------- capture

/**
 * "Capture first, enrich second": the job is saved immediately (with the URL
 * and/or pasted text), then extraction runs asynchronously. A failed fetch
 * never loses the saved link.
 */
export async function captureJob(db: Db, userId: string, input: CaptureInput, dispatcher: Dispatcher) {
  if (!input.confirm_duplicate && input.url) {
    const dups = await findDuplicates(db, userId, { url: input.url });
    if (dups.length) throw conflict("possible_duplicate", "Possible duplicate found", { matches: dups });
  }
  const text = input.text?.trim() || null;
  const companyName = (input.url && companyHintFromUrl(input.url)) || PLACEHOLDER_COMPANY;
  const job: JobFields = {
    company_name: companyName,
    title: "",
    original_url: input.url ?? null,
    description_text: text ? text.slice(0, LIMITS.jdMaxChars) : null,
  } as JobFields;
  const { savedJobId, postingId } = await insertJob(db, userId, job, { extractionStatus: "queued" });
  const extractionId = await createExtractionRow(db, userId, postingId, {
    purpose: "initial",
    inputType: text ? "text" : "url",
    inputUrl: input.url ?? null,
    useAi: input.use_ai,
  });
  await dispatcher.dispatch({ extractionId, userId });
  return { saved_job_id: savedJobId, job_posting_id: postingId, extraction_id: extractionId };
}

export async function refreshJob(db: Db, userId: string, savedJobId: string, dispatcher: Dispatcher, opts: { useAi?: boolean } = {}) {
  const { posting } = await loadSavedJob(db, userId, savedJobId);
  if (!posting.originalUrl) throw badRequest("no_source_url", "This job has no source URL to refresh from");
  const running = await db.query.jobExtractionJobs.findFirst({
    where: and(eq(jobExtractionJobs.jobPostingId, posting.id), sql`${jobExtractionJobs.status} IN ('queued','fetching','extracting')`),
  });
  if (running && now() - running.createdAt < LIMITS.extractionStaleMs) return { extraction_id: running.id };
  const extractionId = await createExtractionRow(db, userId, posting.id, { purpose: "refresh", inputType: "url", inputUrl: posting.originalUrl, useAi: opts.useAi });
  await dispatcher.dispatch({ extractionId, userId });
  return { extraction_id: extractionId };
}

/** Extract from pasted text for an existing job (fallback when the URL is restricted). */
export async function extractFromText(db: Db, userId: string, savedJobId: string, text: string, dispatcher: Dispatcher, opts: { useAi?: boolean } = {}) {
  const { posting } = await loadSavedJob(db, userId, savedJobId);
  const clean = text.trim().slice(0, LIMITS.jdMaxChars);
  if (clean.length < 40) throw badRequest("insufficient_content", "Pasted text is too short");
  await db.update(jobPostings).set({ descriptionText: clean, updatedAt: now() }).where(eq(jobPostings.id, posting.id));
  const extractionId = await createExtractionRow(db, userId, posting.id, { purpose: posting.title ? "refresh" : "initial", inputType: "text", inputUrl: posting.originalUrl, useAi: opts.useAi });
  await dispatcher.dispatch({ extractionId, userId });
  return { extraction_id: extractionId };
}

export async function retryExtraction(db: Db, userId: string, extractionId: string, dispatcher: Dispatcher, opts: { useAi?: boolean } = {}) {
  const ex = await db.query.jobExtractionJobs.findFirst({ where: and(eq(jobExtractionJobs.id, extractionId), eq(jobExtractionJobs.userId, userId)) });
  if (!ex) throw notFound("extraction");
  const newIdValue = await createExtractionRow(db, userId, ex.jobPostingId, { purpose: ex.purpose as "initial" | "refresh", inputType: ex.inputType as "url" | "text", inputUrl: ex.inputUrl, useAi: opts.useAi ?? ex.aiRequested === 1 });
  await dispatcher.dispatch({ extractionId: newIdValue, userId });
  return { extraction_id: newIdValue };
}

// ---------------------------------------------------------------- processing (queue consumer)

export async function processExtraction(env: AppEnv, extractionId: string, attempt: number, deps?: PipelineDeps): Promise<ExtractionStatus> {
  const db = getDb(env.DB);
  const ex = await db.query.jobExtractionJobs.findFirst({ where: eq(jobExtractionJobs.id, extractionId) });
  if (!ex) return "failed";
  if ((EXTRACTION_TERMINAL as readonly string[]).includes(ex.status)) return ex.status as ExtractionStatus;
  const posting = await db.query.jobPostings.findFirst({ where: eq(jobPostings.id, ex.jobPostingId) });
  if (!posting) return "failed";

  const ts = now();
  await runBatch(db, [
    db.update(jobExtractionJobs).set({ status: "fetching", attempts: ex.attempts + 1, startedAt: ex.startedAt ?? ts, updatedAt: ts }).where(eq(jobExtractionJobs.id, ex.id)),
    db.update(jobPostings).set({ extractionStatus: "fetching" }).where(eq(jobPostings.id, posting.id)),
  ]);

  // The posting is only sent to the AI service when the user asked for AI on this extraction.
  const pipelineDeps = deps ?? defaultDeps(ex.aiRequested === 1 ? getAiProvider(env) : null);
  let out;
  try {
    out = await runPipeline({ inputType: ex.inputType as "url" | "text", url: ex.inputUrl, text: ex.inputType === "text" ? posting.descriptionText : null }, pipelineDeps);
  } catch {
    out = { status: "failed" as const, adapter: null, result: null, snapshot: null, errorCode: "internal_error", errorMessage: "Extraction failed unexpectedly", retryable: true };
  }

  if (out.retryable && attempt < 3) {
    await db
      .update(jobExtractionJobs)
      .set({ status: "queued", errorCode: out.errorCode, errorMessage: "Temporary problem — retrying", updatedAt: now() })
      .where(eq(jobExtractionJobs.id, ex.id));
    await db.update(jobPostings).set({ extractionStatus: "queued" }).where(eq(jobPostings.id, posting.id));
    throw new RetryableExtractionError(out.errorCode ?? "retry");
  }

  const finished = now();
  const items: BatchItem<"sqlite">[] = [];
  let snapshotId: string | null = null;
  if (out.snapshot) {
    snapshotId = newId();
    items.push(
      db.insert(jobSourceSnapshots).values({
        id: snapshotId,
        userId: ex.userId,
        jobPostingId: posting.id,
        extractionJobId: ex.id,
        method: out.snapshot.method,
        requestedUrl: out.snapshot.requestedUrl,
        finalUrl: out.snapshot.finalUrl,
        httpStatus: out.snapshot.httpStatus,
        contentType: out.snapshot.contentType,
        title: out.snapshot.title,
        text: out.snapshot.text.slice(0, LIMITS.jdMaxChars),
        structuredData: out.snapshot.structuredData ?? null,
        contentHash: await sha256Hex(out.snapshot.text),
        fetchedAt: finished,
      }),
    );
  }
  items.push(
    db
      .update(jobExtractionJobs)
      .set({ status: out.status, adapter: out.adapter, result: (out.result as unknown as Record<string, unknown>) ?? null, snapshotId, errorCode: out.errorCode, errorMessage: out.errorMessage, finishedAt: finished, updatedAt: finished })
      .where(eq(jobExtractionJobs.id, ex.id)),
  );
  const postingPatch: Partial<typeof jobPostings.$inferInsert> = { extractionStatus: out.status, lastCheckedAt: finished };
  // Preserve the original JD as soon as it is known, even before review.
  if (!posting.descriptionText && out.result?.description_text) postingPatch.descriptionText = out.result.description_text.slice(0, LIMITS.jdMaxChars);
  items.push(db.update(jobPostings).set(postingPatch).where(eq(jobPostings.id, posting.id)));
  await runBatch(db, items);
  return out.status;
}

/** Marks extractions stuck in a non-terminal state as failed (no endless spinners). */
async function expireIfStale(db: Db, ex: typeof jobExtractionJobs.$inferSelect) {
  if ((EXTRACTION_TERMINAL as readonly string[]).includes(ex.status)) return ex;
  const since = ex.updatedAt ?? ex.createdAt;
  if (now() - since < LIMITS.extractionStaleMs) return ex;
  const patch = { status: "failed", errorCode: "timeout", errorMessage: "Extraction did not finish in time. Try again or paste the job description.", finishedAt: now(), updatedAt: now() };
  await db.update(jobExtractionJobs).set(patch).where(eq(jobExtractionJobs.id, ex.id));
  await db.update(jobPostings).set({ extractionStatus: "failed" }).where(and(eq(jobPostings.id, ex.jobPostingId), eq(jobPostings.latestExtractionId, ex.id)));
  return { ...ex, ...patch };
}

// ---------------------------------------------------------------- read

export async function getExtraction(db: Db, userId: string, id: string): Promise<ExtractionDTO> {
  let ex = await db.query.jobExtractionJobs.findFirst({ where: and(eq(jobExtractionJobs.id, id), eq(jobExtractionJobs.userId, userId)) });
  if (!ex) throw notFound("extraction");
  ex = await expireIfStale(db, ex);
  const saved = await db.query.savedJobs.findFirst({ where: eq(savedJobs.jobPostingId, ex.jobPostingId) });
  const dto: ExtractionDTO = {
    id: ex.id,
    job_posting_id: ex.jobPostingId,
    saved_job_id: saved?.id ?? null,
    purpose: ex.purpose as ExtractionDTO["purpose"],
    input_type: ex.inputType as ExtractionDTO["input_type"],
    input_url: ex.inputUrl,
    status: ex.status as ExtractionStatus,
    adapter: ex.adapter,
    attempts: ex.attempts,
    error_code: ex.errorCode,
    error_message: ex.errorMessage,
    result: (ex.result as unknown as ExtractionResult) ?? null,
    created_at: ex.createdAt,
    started_at: ex.startedAt,
    finished_at: ex.finishedAt,
    applied_at: ex.appliedAt,
    dismissed_at: ex.dismissedAt,
  };
  if (dto.result) {
    const posting = await db.query.jobPostings.findFirst({ where: eq(jobPostings.id, ex.jobPostingId) });
    const company = posting ? await db.query.companies.findFirst({ where: eq(companies.id, posting.companyId) }) : null;
    if (posting && company) {
      const current: Partial<Record<ExtractableField, unknown>> = {};
      for (const f of Object.keys(dto.result.fields) as ExtractableField[]) current[f] = currentFieldValue(posting, f, company);
      dto.current = current;
      const overrides = await db.select({ field: userFieldOverrides.field }).from(userFieldOverrides).where(eq(userFieldOverrides.jobPostingId, posting.id));
      dto.overridden_fields = overrides.map((o) => o.field as ExtractableField);
    }
  }
  return dto;
}

export async function listExtractionsForJob(db: Db, userId: string, savedJobId: string) {
  const { posting } = await loadSavedJob(db, userId, savedJobId);
  return db
    .select({ id: jobExtractionJobs.id, status: jobExtractionJobs.status, purpose: jobExtractionJobs.purpose, created_at: jobExtractionJobs.createdAt, applied_at: jobExtractionJobs.appliedAt })
    .from(jobExtractionJobs)
    .where(eq(jobExtractionJobs.jobPostingId, posting.id))
    .orderBy(desc(jobExtractionJobs.createdAt))
    .limit(20);
}

// ---------------------------------------------------------------- apply (human review)

const APPLY_KEYS = new Set<string>([...EXTRACTABLE_FIELDS, "description_text"]);

export async function applyExtraction(db: Db, userId: string, id: string, body: { fields: Record<string, unknown>; review_later?: string[] }) {
  const ex = await db.query.jobExtractionJobs.findFirst({ where: and(eq(jobExtractionJobs.id, id), eq(jobExtractionJobs.userId, userId)) });
  if (!ex) throw notFound("extraction");
  if (!(EXTRACTION_TERMINAL as readonly string[]).includes(ex.status)) throw conflict("extraction_not_finished", "Extraction is still running");
  const result = (ex.result as unknown as ExtractionResult | null) ?? { fields: {}, description_text: null, source_title: null, warnings: [], ai_used: false };
  const posting = await db.query.jobPostings.findFirst({ where: and(eq(jobPostings.id, ex.jobPostingId), eq(jobPostings.userId, userId)) });
  if (!posting) throw notFound("job");
  const saved = await db.query.savedJobs.findFirst({ where: eq(savedJobs.jobPostingId, posting.id) });
  if (!saved) throw notFound("job");

  const unknownKeys = Object.keys(body.fields).filter((k) => !APPLY_KEYS.has(k));
  if (unknownKeys.length) throw badRequest("unknown_fields", "Unknown fields", { fields: unknownKeys });
  const raw: Record<string, unknown> = { ...body.fields };
  if ("description_text" in raw && (raw.description_text === true || raw.description_text == null)) raw.description_text = result.description_text;
  const parsed = jobFieldsSchema.partial().safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Invalid field values", parsed.error.issues);
  const fields = parsed.data;
  const reviewLater = new Set(body.review_later ?? []);
  const ts = now();
  const items: BatchItem<"sqlite">[] = [];

  // Company
  let companyId = posting.companyId;
  const oldCompanyId = posting.companyId;
  if (fields.company_name) {
    const currentCompany = await db.query.companies.findFirst({ where: eq(companies.id, posting.companyId) });
    if (!currentCompany || currentCompany.name !== fields.company_name) {
      const c = await findOrCreateCompany(db, userId, fields.company_name, fields.company_website ?? null);
      companyId = c.id;
    }
  }
  if (fields.company_website) {
    const c = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    if (c && !c.website) items.push(db.update(companies).set({ website: fields.company_website, domain: domainOf(fields.company_website), updatedAt: ts }).where(eq(companies.id, c.id)));
  }

  const cols = fieldsToColumns(fields);
  const anyReview = [...reviewLater].some((k) => k in fields);
  items.push(
    db
      .update(jobPostings)
      .set({ ...cols, companyId, extractionStatus: anyReview ? "needs_review" : "succeeded", updatedAt: ts })
      .where(eq(jobPostings.id, posting.id)),
  );

  // Evidence + overrides
  const existingOverrides = new Set((await db.select({ field: userFieldOverrides.field }).from(userFieldOverrides).where(eq(userFieldOverrides.jobPostingId, posting.id))).map((o) => o.field));
  const appliedFields: string[] = [];
  for (const key of EXTRACTABLE_FIELDS) {
    if (!(key in fields)) continue;
    appliedFields.push(key);
    const value = (fields as Record<string, unknown>)[key];
    const candidate = result.fields[key];
    const edited = candidate ? !sameValue(candidate.value, value) : true;
    items.push(
      db
        .update(extractedFieldEvidence)
        .set({ reviewStatus: "superseded" })
        .where(and(eq(extractedFieldEvidence.jobPostingId, posting.id), eq(extractedFieldEvidence.field, key), ne(extractedFieldEvidence.reviewStatus, "superseded"))),
    );
    items.push(
      db.insert(extractedFieldEvidence).values({
        id: newId(),
        userId,
        jobPostingId: posting.id,
        extractionJobId: ex.id,
        field: key,
        value: value ?? null,
        source: edited ? "user" : (candidate?.source ?? "user"),
        evidence: candidate?.evidence ?? null,
        confidence: edited ? "high" : (candidate?.confidence ?? "high"),
        reviewStatus: reviewLater.has(key) ? "needs_review" : edited ? "overridden" : "confirmed",
        extractedAt: ts,
        reviewedAt: reviewLater.has(key) ? null : ts,
      }),
    );
    if (edited && candidate) {
      items.push(
        db
          .insert(userFieldOverrides)
          .values({ id: newId(), userId, jobPostingId: posting.id, field: key, value: value ?? null, originalValue: candidate.value, createdAt: ts, updatedAt: ts })
          .onConflictDoUpdate({ target: [userFieldOverrides.jobPostingId, userFieldOverrides.field], set: { value: value ?? null, originalValue: candidate.value, updatedAt: ts } }),
      );
    } else if (!edited && existingOverrides.has(key)) {
      // The user explicitly accepted the newly extracted value.
      items.push(db.delete(userFieldOverrides).where(and(eq(userFieldOverrides.jobPostingId, posting.id), eq(userFieldOverrides.field, key))));
    }
  }
  items.push(db.update(jobExtractionJobs).set({ appliedAt: ts, updatedAt: ts }).where(eq(jobExtractionJobs.id, ex.id)));
  items.push(db.update(savedJobs).set({ lastActivityAt: ts, updatedAt: ts }).where(eq(savedJobs.id, saved.id)));
  items.push(
    eventInsert(db, {
      userId,
      savedJobId: saved.id,
      type: ex.purpose === "refresh" ? "job_refreshed" : "details_extracted",
      occurredAt: ts,
      metadata: { extraction_id: ex.id, fields: appliedFields.slice(0, 50), review_later: [...reviewLater].slice(0, 50) },
    }),
  );
  await runBatch(db, items);
  if (companyId !== oldCompanyId) await deleteOrphanCompany(db, userId, oldCompanyId);
  return { applied: appliedFields.length, saved_job_id: saved.id };
}

export async function dismissExtraction(db: Db, userId: string, id: string) {
  const ex = await db.query.jobExtractionJobs.findFirst({ where: and(eq(jobExtractionJobs.id, id), eq(jobExtractionJobs.userId, userId)) });
  if (!ex) throw notFound("extraction");
  const ts = now();
  const hasEvidence = await db.query.extractedFieldEvidence.findFirst({ where: eq(extractedFieldEvidence.jobPostingId, ex.jobPostingId) });
  await runBatch(db, [
    db.update(jobExtractionJobs).set({ dismissedAt: ts, updatedAt: ts }).where(eq(jobExtractionJobs.id, id)),
    db
      .update(jobPostings)
      .set({ extractionStatus: hasEvidence ? "succeeded" : "none" })
      .where(and(eq(jobPostings.id, ex.jobPostingId), eq(jobPostings.latestExtractionId, id))),
  ]);
}

async function deleteOrphanCompany(db: Db, userId: string, companyId: string) {
  const stillUsed = await db.query.jobPostings.findFirst({ where: eq(jobPostings.companyId, companyId) });
  if (stillUsed) return;
  const hasContacts = await db.query.contacts.findFirst({ where: eq(contacts.companyId, companyId) });
  const c = await db.query.companies.findFirst({ where: and(eq(companies.id, companyId), eq(companies.userId, userId)) });
  if (!hasContacts && c && !c.notes && !c.description) await db.delete(companies).where(eq(companies.id, companyId));
}
