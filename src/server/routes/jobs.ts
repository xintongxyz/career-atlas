import { LIMITS } from "@shared/constants";
import {
  applicationUpdateSchema,
  applyExtractionSchema,
  bulkActionSchema,
  captureSchema,
  extractionOptionsSchema,
  createJobSchema,
  duplicateCheckSchema,
  eventCreateSchema,
  eventUpdateSchema,
  fieldReviewSchema,
  jobListQuerySchema,
  noteSchema,
  statusChangeSchema,
  updateJobSchema,
} from "@shared/schemas";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { dbOf, jsonBody, queryParams, userOf } from "../app";
import { schema } from "../db/client";
import type { HonoEnv } from "../env";
import { ApiError, notFound } from "../lib/errors";
import { boardJobs, listItemsByIds, listJobs } from "../repositories/jobs-repo";
import { createEvent, createNote, deleteEvent, deleteNote, listEvents, listNotes, syncManualFollowUp, updateEvent, updateNote } from "../services/activity";
import { linkDocument, listLinkedDocuments, unlinkDocument } from "../services/documents";
import {
  applyExtraction,
  captureJob,
  dismissExtraction,
  extractFromText,
  getExtraction,
  listExtractionsForJob,
  makeDispatcher,
  refreshJob,
  retryExtraction,
} from "../services/extractions";
import { bulkAction, confirmField, createJob, deleteImpact, deleteJob, findDuplicates, getJobDetail, updateJob } from "../services/jobs";
import { applicationToDTO } from "../services/mappers";
import { changeStatus, loadSavedJob } from "../services/pipeline";


// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dispatcherOf = (c: Context<HonoEnv, any>) => makeDispatcher(c.env);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractionOptions(c: Context<HonoEnv, any>) {
  if (!Number(c.req.header("content-length") ?? 0) && !c.req.header("transfer-encoding")) return {};
  return { useAi: (await jsonBody(c, extractionOptionsSchema)).use_ai };
}

export function registerJobRoutes(app: Hono<HonoEnv>) {
  // ---------- list / board / compare ----------
  app.get("/api/jobs", async (c) => {
    const q = queryParams(c, jobListQuerySchema);
    const res = await listJobs(c.env.DB, userOf(c).id, q);
    return c.json({ items: res.items, total: res.total, page: q.page, page_size: q.page_size, salary_filter: res.salary_filter ?? null });
  });

  app.get("/api/board", async (c) => c.json({ items: await boardJobs(c.env.DB, userOf(c).id) }));

  app.get("/api/jobs/compare", async (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean).slice(0, LIMITS.compareMax);
    if (ids.length < 2) throw new ApiError(400, "compare_needs_two", "Select 2 to 4 jobs to compare");
    const db = dbOf(c);
    const details = await Promise.all(ids.map((id) => getJobDetail(db, userOf(c).id, id)));
    return c.json({ items: details });
  });

  app.post("/api/jobs/check-duplicates", async (c) => {
    const body = await jsonBody(c, duplicateCheckSchema);
    return c.json({ matches: await findDuplicates(dbOf(c), userOf(c).id, body) });
  });

  // ---------- create ----------
  app.post("/api/jobs", async (c) => {
    const body = await jsonBody(c, createJobSchema);
    const db = dbOf(c);
    const created = await createJob(db, userOf(c).id, body);
    if (body.personal?.follow_up_at) await syncManualFollowUp(db, userOf(c).id, created.savedJobId, body.personal.follow_up_at);
    return c.json({ id: created.savedJobId, job_posting_id: created.postingId }, 201);
  });

  app.post("/api/jobs/capture", async (c) => {
    const body = await jsonBody(c, captureSchema);
    const res = await captureJob(dbOf(c), userOf(c).id, body, dispatcherOf(c));
    return c.json(res, 202);
  });

  // ---------- detail / update / delete ----------
  app.get("/api/jobs/:id", async (c) => c.json(await getJobDetail(dbOf(c), userOf(c).id, c.req.param("id"))));

  app.patch("/api/jobs/:id", async (c) => {
    const body = await jsonBody(c, updateJobSchema);
    const db = dbOf(c);
    const res = await updateJob(db, userOf(c).id, c.req.param("id"), body);
    if (body.personal && "follow_up_at" in body.personal) await syncManualFollowUp(db, userOf(c).id, c.req.param("id"), body.personal.follow_up_at ?? null);
    return c.json(res);
  });

  app.get("/api/jobs/:id/delete-impact", async (c) => c.json(await deleteImpact(dbOf(c), userOf(c).id, c.req.param("id"))));

  app.delete("/api/jobs/:id", async (c) => {
    await deleteJob(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/api/jobs/bulk", async (c) => {
    const body = await jsonBody(c, bulkActionSchema);
    return c.json(await bulkAction(dbOf(c), userOf(c).id, body.ids, body.action));
  });

  // ---------- status / application ----------
  app.post("/api/jobs/:id/status", async (c) => {
    const body = await jsonBody(c, statusChangeSchema);
    const res = await changeStatus(dbOf(c), userOf(c).id, c.req.param("id"), body.status, { occurredAt: body.occurred_at, note: body.note });
    return c.json(res);
  });

  app.patch("/api/jobs/:id/application", async (c) => {
    const body = await jsonBody(c, applicationUpdateSchema);
    const db = dbOf(c);
    const { application } = await loadSavedJob(db, userOf(c).id, c.req.param("id"));
    if (!application) throw new ApiError(409, "no_application", "This job has not been applied to yet");
    const set: Partial<typeof schema.applications.$inferInsert> = { updatedAt: Date.now() };
    const map: Record<string, keyof typeof set> = {
      applied_at: "appliedAt",
      applied_via: "appliedVia",
      next_follow_up_at: "nextFollowUpAt",
      next_interview_at: "nextInterviewAt",
      offer_deadline_at: "offerDeadlineAt",
      final_outcome_at: "finalOutcomeAt",
      last_response_at: "lastResponseAt",
      resume_document_id: "resumeDocumentId",
      cover_letter_document_id: "coverLetterDocumentId",
      notes: "notes",
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (body as Record<string, unknown>)[k];
      if (v !== undefined) (set as Record<string, unknown>)[col] = v;
    }
    for (const docKey of ["resume_document_id", "cover_letter_document_id"] as const) {
      const docId = body[docKey];
      if (docId) {
        const doc = await db.query.documents.findFirst({ where: and(eq(schema.documents.id, docId), eq(schema.documents.userId, userOf(c).id)) });
        if (!doc) throw notFound("document");
      }
    }
    await db.update(schema.applications).set(set).where(eq(schema.applications.id, application.id));
    // Keep the application_submitted event in sync with an edited applied date.
    if (body.applied_at != null) {
      await db
        .update(schema.applicationEvents)
        .set({ occurredAt: body.applied_at })
        .where(and(eq(schema.applicationEvents.applicationId, application.id), eq(schema.applicationEvents.type, "application_submitted")));
    }
    const fresh = await db.query.applications.findFirst({ where: eq(schema.applications.id, application.id) });
    return c.json(applicationToDTO(fresh!));
  });

  app.get("/api/jobs/:id/documents", async (c) => {
    const db = dbOf(c);
    const { application } = await loadSavedJob(db, userOf(c).id, c.req.param("id"));
    return c.json({ items: application ? await listLinkedDocuments(db, userOf(c).id, application.id) : [] });
  });
  app.post("/api/jobs/:id/documents", async (c) => {
    const body = await jsonBody(c, z.object({ document_id: z.string().max(64), role: z.string().max(40).default("other") }));
    const db = dbOf(c);
    const { application } = await loadSavedJob(db, userOf(c).id, c.req.param("id"));
    if (!application) throw new ApiError(409, "no_application", "Attach documents after applying, or set the planned resume on the job");
    await linkDocument(db, userOf(c).id, application.id, body.document_id, body.role);
    return c.body(null, 204);
  });
  app.delete("/api/jobs/:id/documents/:docId", async (c) => {
    const db = dbOf(c);
    const { application } = await loadSavedJob(db, userOf(c).id, c.req.param("id"));
    if (!application) throw notFound("application");
    await unlinkDocument(db, userOf(c).id, application.id, c.req.param("docId"));
    return c.body(null, 204);
  });

  // ---------- extraction ----------
  app.post("/api/jobs/:id/refresh", async (c) => {
    return c.json(await refreshJob(dbOf(c), userOf(c).id, c.req.param("id"), dispatcherOf(c), await extractionOptions(c)), 202);
  });
  app.post("/api/jobs/:id/extract-text", async (c) => {
    const body = await jsonBody(c, z.object({ text: z.string().min(40).max(LIMITS.jdMaxChars), use_ai: z.boolean().optional() }));
    return c.json(await extractFromText(dbOf(c), userOf(c).id, c.req.param("id"), body.text, dispatcherOf(c), { useAi: body.use_ai }), 202);
  });
  app.get("/api/jobs/:id/extractions", async (c) => c.json({ items: await listExtractionsForJob(dbOf(c), userOf(c).id, c.req.param("id")) }));
  app.post("/api/jobs/:id/fields/review", async (c) => {
    const body = await jsonBody(c, fieldReviewSchema);
    await confirmField(dbOf(c), userOf(c).id, c.req.param("id"), body.field);
    return c.body(null, 204);
  });

  app.get("/api/extractions/:id", async (c) => c.json(await getExtraction(dbOf(c), userOf(c).id, c.req.param("id"))));
  app.post("/api/extractions/:id/apply", async (c) => {
    const body = await jsonBody(c, applyExtractionSchema);
    return c.json(await applyExtraction(dbOf(c), userOf(c).id, c.req.param("id"), body));
  });
  app.post("/api/extractions/:id/dismiss", async (c) => {
    await dismissExtraction(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/api/extractions/:id/retry", async (c) => {
    return c.json(await retryExtraction(dbOf(c), userOf(c).id, c.req.param("id"), dispatcherOf(c), await extractionOptions(c)), 202);
  });

  // ---------- snapshots (original JD history) ----------
  app.get("/api/jobs/:id/snapshots", async (c) => {
    const db = dbOf(c);
    const { posting } = await loadSavedJob(db, userOf(c).id, c.req.param("id"));
    const rows = await db
      .select({
        id: schema.jobSourceSnapshots.id,
        method: schema.jobSourceSnapshots.method,
        requested_url: schema.jobSourceSnapshots.requestedUrl,
        final_url: schema.jobSourceSnapshots.finalUrl,
        http_status: schema.jobSourceSnapshots.httpStatus,
        title: schema.jobSourceSnapshots.title,
        text: schema.jobSourceSnapshots.text,
        content_hash: schema.jobSourceSnapshots.contentHash,
        fetched_at: schema.jobSourceSnapshots.fetchedAt,
      })
      .from(schema.jobSourceSnapshots)
      .where(eq(schema.jobSourceSnapshots.jobPostingId, posting.id))
      .orderBy(schema.jobSourceSnapshots.fetchedAt);
    return c.json({ items: rows.reverse() });
  });

  // ---------- events / notes per job ----------
  app.get("/api/jobs/:id/events", async (c) => {
    await loadSavedJob(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.json({ items: await listEvents(dbOf(c), userOf(c).id, { saved_job_id: c.req.param("id"), limit: 500 }) });
  });
  app.post("/api/jobs/:id/events", async (c) => {
    const body = await jsonBody(c, eventCreateSchema);
    const id = await createEvent(dbOf(c), userOf(c).id, c.req.param("id"), body);
    return c.json({ id }, 201);
  });
  app.patch("/api/events/:id", async (c) => {
    const body = await jsonBody(c, eventUpdateSchema);
    await updateEvent(dbOf(c), userOf(c).id, c.req.param("id"), body);
    return c.body(null, 204);
  });
  app.delete("/api/events/:id", async (c) => {
    await deleteEvent(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/jobs/:id/notes", async (c) => c.json({ items: await listNotes(dbOf(c), userOf(c).id, c.req.param("id")) }));
  app.post("/api/jobs/:id/notes", async (c) => {
    const body = await jsonBody(c, noteSchema);
    return c.json(await createNote(dbOf(c), userOf(c).id, c.req.param("id"), body.body), 201);
  });
  app.patch("/api/notes/:id", async (c) => {
    const body = await jsonBody(c, noteSchema);
    await updateNote(dbOf(c), userOf(c).id, c.req.param("id"), body.body);
    return c.body(null, 204);
  });
  app.delete("/api/notes/:id", async (c) => {
    await deleteNote(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/jobs-by-ids", async (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean).slice(0, 50);
    return c.json({ items: await listItemsByIds(c.env.DB, userOf(c).id, ids) });
  });
}
