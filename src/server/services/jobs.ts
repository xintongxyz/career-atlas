import { EXTRACTABLE_FIELDS, type ExtractableField, type PipelineStatus } from "@shared/constants";
import type { CreateJobInput, JobFields, SavedJobFields, UpdateJobInput } from "@shared/schemas";
import type { DuplicateMatch, EvidenceDTO, JobDetail, OverrideDTO } from "@shared/types";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { canonicalizeUrl, detectPlatform } from "../extraction/platforms";
import { ApiError, conflict, notFound } from "../lib/errors";
import { newId, normalizeName, now } from "../lib/util";
import { EFFECTIVE_STATUS_SQL } from "../repositories/jobs-repo";
import { pruneTranslations } from "./translations";
import { findOrCreateCompany } from "./companies";
import { applicationToDTO, companyToDTO, currentFieldValue, fieldsToColumns, postingToFields, sameValue, tagToDTO } from "./mappers";
import { changeStatus, effectiveStatus, eventInsert, loadSavedJob, runBatch } from "./pipeline";
import { ensureTags, setJobTags } from "./tags";

const {
  jobPostings,
  savedJobs,
  companies,
  applicationEvents,
  extractedFieldEvidence,
  userFieldOverrides,
  jobExtractionJobs,
  jobSourceSnapshots,
  jobTags,
  tags,
} = schema;

// ---------------------------------------------------------------- duplicates

export async function findDuplicates(
  db: Db,
  userId: string,
  input: { url?: string | null; company_name?: string | null; title?: string | null; city?: string | null },
  excludePostingId?: string,
): Promise<DuplicateMatch[]> {
  const matches = new Map<string, DuplicateMatch>();
  const d1 = db.$client;
  const add = (rows: Record<string, unknown>[], reason: DuplicateMatch["reason"]) => {
    for (const r of rows) {
      if (excludePostingId && r.job_posting_id === excludePostingId) continue;
      if (matches.has(r.id as string)) continue;
      matches.set(r.id as string, {
        id: r.id as string,
        job_posting_id: r.job_posting_id as string,
        company_name: r.company_name as string,
        title: r.title as string,
        city: (r.city as string) ?? null,
        status: r.status as PipelineStatus,
        saved_at: r.saved_at as number,
        posting_status: r.posting_status as string,
        reason,
      });
    }
  };
  const select = `SELECT sj.id, sj.job_posting_id, c.name AS company_name, p.title, p.city, sj.saved_at, p.posting_status,
      ${EFFECTIVE_STATUS_SQL} AS status
    FROM saved_jobs sj JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL
    JOIN companies c ON c.id = p.company_id LEFT JOIN applications a ON a.saved_job_id = sj.id
    WHERE sj.user_id = ?`;

  if (input.url) {
    let canonical: string | null = null;
    let info: ReturnType<typeof detectPlatform> | null = null;
    try {
      canonical = canonicalizeUrl(input.url);
      info = detectPlatform(input.url);
    } catch {
      /* invalid URL: nothing to match */
    }
    if (info?.externalId && info.platform !== "company_site") {
      const r = await d1
        .prepare(`${select} AND p.source_platform = ? AND p.external_job_id = ? LIMIT 5`)
        .bind(userId, info.platform, info.externalId)
        .all();
      add(r.results, "same_external_id");
    }
    if (canonical) {
      const r = await d1
        .prepare(`${select} AND (p.canonical_url = ? OR p.original_url = ?) LIMIT 5`)
        .bind(userId, canonical, input.url)
        .all();
      add(r.results, "same_url");
    }
  }
  if (input.company_name && input.title) {
    // Same company + similar title (+ same city when known) is only a *possible*
    // duplicate: the same role is often posted for several teams or reposted.
    const norm = normalizeName(input.company_name);
    const r = await d1
      .prepare(
        `${select} AND c.normalized_name = ? AND lower(p.title) = lower(?) ${input.city ? "AND (p.city IS NULL OR lower(p.city) = lower(?))" : ""} LIMIT 5`,
      )
      .bind(userId, norm, input.title.trim(), ...(input.city ? [input.city.trim()] : []))
      .all();
    add(r.results, "similar");
  }
  return [...matches.values()];
}

// ---------------------------------------------------------------- create

function personalColumns(p: SavedJobFields | undefined) {
  if (!p) return {};
  const out: Partial<typeof savedJobs.$inferInsert> = {};
  if (p.is_starred !== undefined) out.isStarred = p.is_starred;
  if (p.priority !== undefined) out.priority = p.priority;
  if (p.interest_level !== undefined) out.interestLevel = p.interest_level;
  if (p.fit_assessment !== undefined) out.fitAssessment = p.fit_assessment;
  if (p.fit_score !== undefined) out.fitScore = p.fit_score;
  if (p.next_action !== undefined) out.nextAction = p.next_action;
  if (p.next_action_at !== undefined) out.nextActionAt = p.next_action_at;
  if (p.follow_up_at !== undefined) out.followUpAt = p.follow_up_at;
  if (p.resume_document_id !== undefined) out.resumeDocumentId = p.resume_document_id;
  if (p.cover_letter_document_id !== undefined) out.coverLetterDocumentId = p.cover_letter_document_id;
  if (p.referral_contact_id !== undefined) out.referralContactId = p.referral_contact_id;
  if (p.recruiter_contact_id !== undefined) out.recruiterContactId = p.recruiter_contact_id;
  if (p.application_notes !== undefined) out.applicationNotes = p.application_notes;
  return out;
}

export interface CreatedJob {
  savedJobId: string;
  postingId: string;
}

/** Creates company (if needed), posting, saved-job relationship and the "saved" event. */
export async function insertJob(
  db: Db,
  userId: string,
  job: JobFields,
  opts: { personal?: SavedJobFields; extractionStatus?: string; savedAt?: number; sourcePlatform?: string } = {},
): Promise<CreatedJob> {
  const company = await findOrCreateCompany(db, userId, job.company_name, job.company_website);
  const ts = now();
  const savedAt = opts.savedAt ?? ts;
  const postingId = newId();
  const savedJobId = newId();
  let canonical: string | null = null;
  let platform = job.source_platform ?? opts.sourcePlatform ?? "manual";
  let externalId = job.external_job_id ?? null;
  if (job.original_url) {
    canonical = canonicalizeUrl(job.original_url);
    const info = detectPlatform(job.original_url);
    if (!job.source_platform || job.source_platform === "manual") platform = info.platform;
    externalId = externalId ?? info.externalId;
  }
  const cols = fieldsToColumns(job);
  const items: BatchItem<"sqlite">[] = [
    db.insert(jobPostings).values({
      ...cols,
      id: postingId,
      userId,
      companyId: company.id,
      title: job.title,
      canonicalUrl: canonical,
      sourcePlatform: platform,
      externalJobId: externalId,
      extractionStatus: opts.extractionStatus ?? "none",
      createdAt: ts,
      updatedAt: ts,
    }),
    db.insert(savedJobs).values({
      id: savedJobId,
      userId,
      jobPostingId: postingId,
      stage: "saved",
      savedAt,
      lastActivityAt: savedAt,
      updatedAt: ts,
      ...personalColumns(opts.personal),
    }),
    eventInsert(db, { userId, savedJobId, type: "job_saved", toStatus: "saved", occurredAt: savedAt }),
  ];
  await runBatch(db, items);
  if (opts.personal?.tags?.length) await setJobTags(db, userId, savedJobId, opts.personal.tags);
  return { savedJobId, postingId };
}

export async function createJob(db: Db, userId: string, input: CreateJobInput) {
  if (!input.confirm_duplicate) {
    const dups = await findDuplicates(db, userId, {
      url: input.job.original_url,
      company_name: input.job.company_name,
      title: input.job.title,
      city: input.job.city,
    });
    if (dups.length) throw conflict("possible_duplicate", "Possible duplicate found", { matches: dups });
  }
  const created = await insertJob(db, userId, input.job, { personal: input.personal });
  if (input.initial_status !== "saved") {
    await changeStatus(db, userId, created.savedJobId, input.initial_status as PipelineStatus, {
      occurredAt: input.initial_status === "applied" ? (input.applied_at ?? now()) : undefined,
    });
  }
  return created;
}

// ---------------------------------------------------------------- detail

export async function getJobDetail(db: Db, userId: string, savedJobId: string): Promise<JobDetail> {
  const { saved, posting, company, application } = await loadSavedJob(db, userId, savedJobId);
  const [tagRows, evidenceRows, overrideRows, latestExtraction, snapshotCount] = await Promise.all([
    db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(jobTags)
      .innerJoin(tags, eq(tags.id, jobTags.tagId))
      .where(eq(jobTags.savedJobId, saved.id))
      .orderBy(sql`${tags.name} COLLATE NOCASE`),
    db
      .select()
      .from(extractedFieldEvidence)
      .where(and(eq(extractedFieldEvidence.jobPostingId, posting.id), ne(extractedFieldEvidence.reviewStatus, "superseded")))
      .orderBy(desc(extractedFieldEvidence.extractedAt)),
    db.select().from(userFieldOverrides).where(eq(userFieldOverrides.jobPostingId, posting.id)),
    db.query.jobExtractionJobs.findFirst({
      where: eq(jobExtractionJobs.jobPostingId, posting.id),
      orderBy: desc(jobExtractionJobs.createdAt),
    }),
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(jobSourceSnapshots)
      .where(eq(jobSourceSnapshots.jobPostingId, posting.id)),
  ]);

  // Keep only the most recent evidence row per field.
  const seen = new Set<string>();
  const evidence: EvidenceDTO[] = [];
  for (const e of evidenceRows) {
    if (seen.has(e.field)) continue;
    seen.add(e.field);
    evidence.push({
      id: e.id,
      field: e.field as ExtractableField,
      value: e.value,
      source: e.source as EvidenceDTO["source"],
      evidence: e.evidence,
      confidence: e.confidence as EvidenceDTO["confidence"],
      review_status: e.reviewStatus as EvidenceDTO["review_status"],
      extracted_at: e.extractedAt,
    });
  }
  const overrides: OverrideDTO[] = overrideRows.map((o) => ({
    field: o.field as ExtractableField,
    value: o.value,
    original_value: o.originalValue,
    updated_at: o.updatedAt,
  }));

  return {
    id: saved.id,
    status: effectiveStatus(saved, application),
    posting: {
      ...postingToFields(posting, company.name, company.website),
      id: posting.id,
      canonical_url: posting.canonicalUrl,
      extraction_status: posting.extractionStatus as JobDetail["posting"]["extraction_status"],
      latest_extraction_id: posting.latestExtractionId,
      last_checked_at: posting.lastCheckedAt,
      created_at: posting.createdAt,
      updated_at: posting.updatedAt,
      translations: (posting.translations as unknown as JobDetail["posting"]["translations"]) ?? null,
    },
    company: companyToDTO(company),
    personal: {
      stage: saved.stage as JobDetail["personal"]["stage"],
      is_starred: saved.isStarred,
      priority: saved.priority as JobDetail["personal"]["priority"],
      interest_level: saved.interestLevel,
      fit_assessment: saved.fitAssessment,
      fit_score: saved.fitScore,
      next_action: saved.nextAction,
      next_action_at: saved.nextActionAt,
      follow_up_at: saved.followUpAt,
      resume_document_id: saved.resumeDocumentId,
      cover_letter_document_id: saved.coverLetterDocumentId,
      referral_contact_id: saved.referralContactId,
      recruiter_contact_id: saved.recruiterContactId,
      application_notes: saved.applicationNotes,
      saved_at: saved.savedAt,
      last_activity_at: saved.lastActivityAt,
      archived_at: saved.archivedAt,
    },
    application: application ? applicationToDTO(application) : null,
    tags: tagRows.map(tagToDTO),
    evidence,
    overrides,
    latest_extraction: latestExtraction
      ? {
          id: latestExtraction.id,
          status: latestExtraction.status as JobDetail["posting"]["extraction_status"],
          purpose: latestExtraction.purpose as "initial" | "refresh",
          error_code: latestExtraction.errorCode,
          error_message: latestExtraction.errorMessage,
          created_at: latestExtraction.createdAt,
          finished_at: latestExtraction.finishedAt,
          applied_at: latestExtraction.appliedAt,
          dismissed_at: latestExtraction.dismissedAt,
        }
      : null,
    snapshot_count: Number(snapshotCount[0]?.n ?? 0),
  };
}

// ---------------------------------------------------------------- update

/**
 * Updates posting and personal fields. Editing a field that has extracted
 * evidence records a manual override (keeping the original extracted value) so
 * later refreshes never silently overwrite what the user confirmed.
 */
export async function updateJob(db: Db, userId: string, savedJobId: string, input: UpdateJobInput) {
  const { saved, posting, company } = await loadSavedJob(db, userId, savedJobId);
  const ts = now();
  const items: BatchItem<"sqlite">[] = [];
  const changedFields: string[] = [];

  if (input.job) {
    const job = input.job;
    let companyId = posting.companyId;
    if (job.company_name && job.company_name.trim() !== company.name) {
      const c = await findOrCreateCompany(db, userId, job.company_name, job.company_website ?? company.website);
      companyId = c.id;
      changedFields.push("company_name");
    } else if (job.company_website !== undefined && job.company_website !== company.website) {
      await db
        .update(companies)
        .set({ website: job.company_website, domain: job.company_website ? new URL(job.company_website).hostname.replace(/^www\./, "") : null, updatedAt: ts })
        .where(eq(companies.id, company.id));
      changedFields.push("company_website");
    }
    const cols = fieldsToColumns(job);
    if (job.original_url !== undefined) {
      cols.canonicalUrl = job.original_url ? canonicalizeUrl(job.original_url) : null;
    }
    for (const f of EXTRACTABLE_FIELDS) {
      if (f === "company_name" || f === "company_website") continue;
      if (!(f in job)) continue;
      const before = currentFieldValue(posting, f, company);
      const after = (job as Record<string, unknown>)[f];
      if (!sameValue(before, after)) changedFields.push(f);
    }
    // A translation of text the user just changed would be stale: drop it (the original is shown).
    const pruned = pruneTranslations(posting.translations, changedFields);
    if (pruned !== undefined) (cols as Record<string, unknown>).translations = pruned;
    items.push(db.update(jobPostings).set({ ...cols, companyId, updatedAt: ts }).where(eq(jobPostings.id, posting.id)));

    // Overrides + evidence review state for edited extracted fields.
    if (changedFields.length) {
      const evidence = await db
        .select()
        .from(extractedFieldEvidence)
        .where(
          and(
            eq(extractedFieldEvidence.jobPostingId, posting.id),
            inArray(extractedFieldEvidence.field, changedFields),
            ne(extractedFieldEvidence.reviewStatus, "superseded"),
          ),
        )
        .orderBy(desc(extractedFieldEvidence.extractedAt));
      const latestByField = new Map<string, (typeof evidence)[number]>();
      for (const e of evidence) if (!latestByField.has(e.field)) latestByField.set(e.field, e);
      for (const [field, e] of latestByField) {
        const value = field === "company_name" ? job.company_name : (job as Record<string, unknown>)[field];
        if (sameValue(value, e.value)) {
          // Edited back to the extracted value: no override needed.
          items.push(db.delete(userFieldOverrides).where(and(eq(userFieldOverrides.jobPostingId, posting.id), eq(userFieldOverrides.field, field))));
          items.push(
            db
              .update(extractedFieldEvidence)
              .set({ reviewStatus: "confirmed", reviewedAt: ts })
              .where(and(eq(extractedFieldEvidence.id, e.id))),
          );
          continue;
        }
        items.push(
          db
            .insert(userFieldOverrides)
            .values({ id: newId(), userId, jobPostingId: posting.id, field, value, originalValue: e.value, createdAt: ts, updatedAt: ts })
            .onConflictDoUpdate({ target: [userFieldOverrides.jobPostingId, userFieldOverrides.field], set: { value, updatedAt: ts } }),
        );
        items.push(
          db
            .update(extractedFieldEvidence)
            .set({ reviewStatus: "overridden", reviewedAt: ts })
            .where(and(eq(extractedFieldEvidence.jobPostingId, posting.id), eq(extractedFieldEvidence.field, field), ne(extractedFieldEvidence.reviewStatus, "superseded"))),
        );
      }
      items.push(
        eventInsert(db, {
          userId,
          savedJobId,
          type: "job_updated",
          occurredAt: ts,
          metadata: { fields: changedFields.slice(0, 40) },
        }),
      );
    }
  }

  if (input.personal) {
    const cols = personalColumns(input.personal);
    if (Object.keys(cols).length) {
      items.push(db.update(savedJobs).set({ ...cols, updatedAt: ts }).where(eq(savedJobs.id, saved.id)));
    }
  }
  await runBatch(db, items);
  if (input.personal?.tags) await setJobTags(db, userId, saved.id, input.personal.tags);
  return { changed_fields: changedFields };
}

/** Marks the latest evidence for a field as confirmed by the user. */
export async function confirmField(db: Db, userId: string, savedJobId: string, field: string) {
  const { posting } = await loadSavedJob(db, userId, savedJobId);
  await db
    .update(extractedFieldEvidence)
    .set({ reviewStatus: "confirmed", reviewedAt: now() })
    .where(
      and(
        eq(extractedFieldEvidence.jobPostingId, posting.id),
        eq(extractedFieldEvidence.field, field),
        eq(extractedFieldEvidence.reviewStatus, "needs_review"),
      ),
    );
}

// ---------------------------------------------------------------- delete / bulk

/** What a permanent delete would remove (shown to the user before confirming). */
export async function deleteImpact(db: Db, userId: string, savedJobId: string) {
  const { saved, posting, application } = await loadSavedJob(db, userId, savedJobId);
  const q = (sql: string, ...b: unknown[]) => db.$client.prepare(sql).bind(...b).first<{ n: number }>().then((r) => r?.n ?? 0);
  return {
    application: !!application,
    events: await q("SELECT COUNT(*) n FROM application_events WHERE saved_job_id = ? AND deleted_at IS NULL", saved.id),
    notes: await q("SELECT COUNT(*) n FROM notes WHERE saved_job_id = ? AND deleted_at IS NULL", saved.id),
    reminders: await q("SELECT COUNT(*) n FROM reminders WHERE saved_job_id = ? AND deleted_at IS NULL", saved.id),
    snapshots: await q("SELECT COUNT(*) n FROM job_source_snapshots WHERE job_posting_id = ?", posting.id),
    // Documents are only unlinked (never deleted) — they may be used by other jobs.
    linked_documents: await q("SELECT COUNT(*) n FROM application_documents ad JOIN applications a ON a.id = ad.application_id WHERE a.saved_job_id = ?", saved.id),
  };
}

/**
 * Permanently deletes one saved job and its posting. Foreign keys cascade to exactly this job's
 * dependents (application, events, notes, reminders, tags links, snapshots, extraction runs,
 * evidence, overrides). Companies, documents, contacts and other jobs are never touched.
 */
export async function deleteJob(db: Db, userId: string, savedJobId: string) {
  const { posting } = await loadSavedJob(db, userId, savedJobId);
  try {
    await db.delete(jobPostings).where(and(eq(jobPostings.id, posting.id), eq(jobPostings.userId, userId)));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", where: "deleteJob", error: (e as Error)?.name, cause: String((e as { cause?: unknown })?.cause ?? "").slice(0, 120) }));
    throw new ApiError(500, "delete_failed", "The job could not be deleted. Nothing was removed.");
  }
}

export async function bulkAction(
  db: Db,
  userId: string,
  ids: string[],
  action:
    | { type: "add_tag"; tag: string }
    | { type: "remove_tag"; tag: string }
    | { type: "archive" }
    | { type: "restore" }
    | { type: "set_priority"; priority: "high" | "medium" | "low" | null },
) {
  const owned = await db
    .select({ id: savedJobs.id })
    .from(savedJobs)
    .where(and(eq(savedJobs.userId, userId), inArray(savedJobs.id, ids)));
  const ownedIds = owned.map((o) => o.id);
  if (!ownedIds.length) throw notFound("jobs");
  const ts = now();
  switch (action.type) {
    case "add_tag": {
      const [tag] = await ensureTags(db, userId, [action.tag]);
      await db
        .insert(jobTags)
        .values(ownedIds.map((id) => ({ savedJobId: id, tagId: tag.id, createdAt: ts })))
        .onConflictDoNothing();
      break;
    }
    case "remove_tag": {
      const tag = await db.query.tags.findFirst({
        where: and(eq(tags.userId, userId), eq(tags.normalizedName, action.tag.trim().toLowerCase())),
      });
      if (tag) await db.delete(jobTags).where(and(eq(jobTags.tagId, tag.id), inArray(jobTags.savedJobId, ownedIds)));
      break;
    }
    case "set_priority":
      await db.update(savedJobs).set({ priority: action.priority, updatedAt: ts }).where(inArray(savedJobs.id, ownedIds));
      break;
    case "archive":
    case "restore":
      for (const id of ownedIds) {
        const { saved, application } = await loadSavedJob(db, userId, id);
        const isArchived = !!saved.archivedAt;
        if (action.type === "archive" && !isArchived) await changeStatus(db, userId, id, "archived");
        if (action.type === "restore" && isArchived) {
          const underlying = (application?.status ?? saved.stage) as PipelineStatus;
          await changeStatus(db, userId, id, underlying);
        }
      }
      break;
  }
  return { affected: ownedIds.length };
}

export async function recentEventsForJob(db: Db, userId: string, savedJobId: string) {
  return db
    .select()
    .from(applicationEvents)
    .where(and(eq(applicationEvents.userId, userId), eq(applicationEvents.savedJobId, savedJobId), isNull(applicationEvents.deletedAt)))
    .orderBy(desc(applicationEvents.occurredAt), desc(applicationEvents.createdAt));
}
