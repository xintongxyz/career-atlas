import {
  APPLICATION_STATUSES,
  RESPONSE_STATUSES,
  SAVED_STAGES,
  TERMINAL_APPLICATION_STATUSES,
  type ApplicationStatus,
  type EventType,
  type PipelineStatus,
  type SavedStage,
} from "@shared/constants";
import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId, now } from "../lib/util";

const { savedJobs, applications, applicationEvents, jobPostings, companies, reminders, userPreferences } = schema;

export type SavedJobRow = typeof savedJobs.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;

export async function runBatch(db: Db, items: BatchItem<"sqlite">[]) {
  if (!items.length) return;
  await db.batch(items as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

export function effectiveStatus(saved: SavedJobRow, app: ApplicationRow | null | undefined): PipelineStatus {
  if (saved.archivedAt) return "archived";
  if (app) return app.status as PipelineStatus;
  return saved.stage as PipelineStatus;
}

export async function loadSavedJob(db: Db, userId: string, savedJobId: string) {
  // Separate lookups instead of one wide 4-table join (keeps result sets narrow).
  const saved = await db.query.savedJobs.findFirst({ where: and(eq(savedJobs.id, savedJobId), eq(savedJobs.userId, userId)) });
  if (!saved) throw notFound("job");
  const [posting, application] = await Promise.all([
    db.query.jobPostings.findFirst({ where: and(eq(jobPostings.id, saved.jobPostingId), eq(jobPostings.userId, userId), isNull(jobPostings.deletedAt)) }),
    db.query.applications.findFirst({ where: and(eq(applications.savedJobId, saved.id), eq(applications.userId, userId)) }),
  ]);
  if (!posting) throw notFound("job");
  const company = await db.query.companies.findFirst({ where: eq(companies.id, posting.companyId) });
  if (!company) throw notFound("job");
  return { saved, posting, company, application: application ?? null };
}

export function eventInsert(
  db: Db,
  e: {
    userId: string;
    savedJobId: string;
    applicationId?: string | null;
    type: EventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    title?: string | null;
    details?: string | null;
    metadata?: Record<string, unknown> | null;
    occurredAt: number;
    scheduledFor?: number | null;
  },
) {
  return db.insert(applicationEvents).values({
    id: newId(),
    userId: e.userId,
    savedJobId: e.savedJobId,
    applicationId: e.applicationId ?? null,
    type: e.type,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    title: e.title ?? null,
    details: e.details ?? null,
    metadata: e.metadata ?? null,
    occurredAt: e.occurredAt,
    scheduledFor: e.scheduledFor ?? null,
    createdAt: now(),
  });
}

async function followUpDays(db: Db, userId: string): Promise<number> {
  const p = await db.query.userPreferences.findFirst({ where: eq(userPreferences.userId, userId) });
  return p?.defaultFollowUpDays ?? 7;
}

const DAY = 86_400_000;
const minDefined = (a: number | null, b: number) => (a == null ? b : Math.min(a, b));

/** Milestone updates when an application reaches `status` at time `at`. */
function milestonePatch(app: Pick<ApplicationRow, "firstResponseAt" | "reachedAssessmentAt" | "reachedInterviewAt" | "reachedOfferAt" | "lastResponseAt">, status: ApplicationStatus, at: number) {
  const patch: Partial<ApplicationRow> = {};
  if (RESPONSE_STATUSES.includes(status)) {
    patch.firstResponseAt = minDefined(app.firstResponseAt, at);
    patch.lastResponseAt = Math.max(app.lastResponseAt ?? 0, at);
  }
  if (status === "assessment") patch.reachedAssessmentAt = minDefined(app.reachedAssessmentAt, at);
  if (status === "interview") patch.reachedInterviewAt = minDefined(app.reachedInterviewAt, at);
  if (status === "offer" || status === "accepted") patch.reachedOfferAt = minDefined(app.reachedOfferAt, at);
  return patch;
}

export interface StatusChangeResult {
  from: PipelineStatus;
  to: PipelineStatus;
  applicationId: string | null;
  changed: boolean;
}

/**
 * The single place where pipeline status changes happen. Every change writes
 * an append-only event in the same atomic batch as the state update.
 */
export async function changeStatus(
  db: Db,
  userId: string,
  savedJobId: string,
  target: PipelineStatus,
  opts: { occurredAt?: number | null; note?: string | null; metadata?: Record<string, unknown> | null; appliedVia?: string | null; resumeDocumentId?: string | null } = {},
): Promise<StatusChangeResult> {
  const { saved, application } = await loadSavedJob(db, userId, savedJobId);
  const from = effectiveStatus(saved, application);
  const at = opts.occurredAt ?? now();
  const ts = now();
  if (from === target) return { from, to: target, applicationId: application?.id ?? null, changed: false };

  const items: BatchItem<"sqlite">[] = [];
  const touchSaved: Partial<SavedJobRow> = { lastActivityAt: Math.max(saved.lastActivityAt, at), updatedAt: ts };

  // Archive / restore
  if (target === "archived") {
    items.push(db.update(savedJobs).set({ ...touchSaved, archivedAt: at }).where(eq(savedJobs.id, saved.id)));
    items.push(
      eventInsert(db, { userId, savedJobId, applicationId: application?.id, type: "archived", fromStatus: from, toStatus: "archived", details: opts.note, occurredAt: at }),
    );
    await runBatch(db, items);
    return { from, to: target, applicationId: application?.id ?? null, changed: true };
  }

  let underlying = from;
  if (from === "archived") {
    touchSaved.archivedAt = null;
    underlying = application ? (application.status as PipelineStatus) : (saved.stage as PipelineStatus);
    items.push(
      eventInsert(db, { userId, savedJobId, applicationId: application?.id, type: "restored", fromStatus: "archived", toStatus: underlying, occurredAt: at }),
    );
    if (underlying === target) {
      items.unshift(db.update(savedJobs).set(touchSaved).where(eq(savedJobs.id, saved.id)));
      await runBatch(db, items);
      return { from, to: target, applicationId: application?.id ?? null, changed: true };
    }
  }

  // Pre-application stages
  if ((SAVED_STAGES as readonly string[]).includes(target)) {
    if (application) {
      throw conflict(
        "application_exists",
        "This job already has an application. Use Withdrawn or Closed instead of moving it back.",
      );
    }
    items.unshift(db.update(savedJobs).set({ ...touchSaved, stage: target as SavedStage }).where(eq(savedJobs.id, saved.id)));
    items.push(
      eventInsert(db, { userId, savedJobId, type: "status_changed", fromStatus: underlying, toStatus: target, details: opts.note, occurredAt: at }),
    );
    await runBatch(db, items);
    return { from, to: target, applicationId: null, changed: true };
  }

  if (!(APPLICATION_STATUSES as readonly string[]).includes(target)) throw badRequest("invalid_status");
  const status = target as ApplicationStatus;

  // First application: create the application record.
  if (!application) {
    const appId = newId();
    const days = await followUpDays(db, userId);
    const followUp = days > 0 && !TERMINAL_APPLICATION_STATUSES.includes(status) ? at + days * DAY : null;
    const base = { firstResponseAt: null, reachedAssessmentAt: null, reachedInterviewAt: null, reachedOfferAt: null, lastResponseAt: null };
    items.unshift(db.update(savedJobs).set(touchSaved).where(eq(savedJobs.id, saved.id)));
    items.push(
      db.insert(applications).values({
        id: appId,
        userId,
        savedJobId,
        jobPostingId: saved.jobPostingId,
        status,
        appliedAt: at,
        lastActivityAt: at,
        nextFollowUpAt: followUp,
        finalOutcomeAt: TERMINAL_APPLICATION_STATUSES.includes(status) ? at : null,
        appliedVia: opts.appliedVia ?? null,
        resumeDocumentId: opts.resumeDocumentId ?? saved.resumeDocumentId,
        coverLetterDocumentId: saved.coverLetterDocumentId,
        createdAt: ts,
        updatedAt: ts,
        ...base,
        ...milestonePatch(base, status, at),
      }),
    );
    items.push(
      eventInsert(db, { userId, savedJobId, applicationId: appId, type: "application_submitted", fromStatus: underlying, toStatus: "applied", details: opts.note, metadata: opts.metadata, occurredAt: at }),
    );
    if (status !== "applied") {
      items.push(
        eventInsert(db, { userId, savedJobId, applicationId: appId, type: "status_changed", fromStatus: "applied", toStatus: status, occurredAt: at }),
      );
    }
    if (followUp) {
      items.push(
        db.insert(reminders).values({
          id: newId(),
          userId,
          savedJobId,
          kind: "follow_up",
          title: "follow_up_default",
          dueAt: followUp,
          autoKey: `follow_up:${appId}`,
          createdAt: ts,
          updatedAt: ts,
        }),
      );
      items.push(
        eventInsert(db, { userId, savedJobId, applicationId: appId, type: "follow_up_scheduled", occurredAt: at, scheduledFor: followUp, metadata: { auto: true, days } }),
      );
    }
    await runBatch(db, items);
    return { from, to: target, applicationId: appId, changed: true };
  }

  // Existing application: move along the lifecycle.
  const appPatch: Partial<ApplicationRow> = {
    status,
    lastActivityAt: Math.max(application.lastActivityAt, at),
    updatedAt: ts,
    ...milestonePatch(application, status, at),
  };
  if (TERMINAL_APPLICATION_STATUSES.includes(status)) appPatch.finalOutcomeAt = at;
  else if (application.finalOutcomeAt) appPatch.finalOutcomeAt = null;

  items.unshift(db.update(savedJobs).set(touchSaved).where(eq(savedJobs.id, saved.id)));
  items.push(db.update(applications).set(appPatch).where(eq(applications.id, application.id)));
  items.push(
    eventInsert(db, { userId, savedJobId, applicationId: application.id, type: "status_changed", fromStatus: underlying, toStatus: status, details: opts.note, occurredAt: at }),
  );
  // A finished application no longer needs automatic follow-up reminders.
  if (TERMINAL_APPLICATION_STATUSES.includes(status)) {
    items.push(
      db
        .update(reminders)
        .set({ completedAt: ts, updatedAt: ts })
        .where(and(eq(reminders.autoKey, `follow_up:${application.id}`), isNull(reminders.completedAt))),
    );
    items.push(db.update(applications).set({ nextFollowUpAt: null }).where(eq(applications.id, application.id)));
  }
  await runBatch(db, items);
  return { from, to: target, applicationId: application.id, changed: true };
}

/**
 * Rebuilds applied_at and milestone timestamps from the event log. Used after
 * a user edits or deletes historical events, so analytics stay consistent.
 */
export async function recomputeMilestones(db: Db, userId: string, applicationId: string) {
  const app = await db.query.applications.findFirst({
    where: and(eq(applications.id, applicationId), eq(applications.userId, userId)),
  });
  if (!app) return;
  const events = await db
    .select()
    .from(applicationEvents)
    .where(and(eq(applicationEvents.savedJobId, app.savedJobId), isNull(applicationEvents.deletedAt)));
  let appliedAt: number | null = null;
  const m = { firstResponseAt: null as number | null, lastResponseAt: null as number | null, reachedAssessmentAt: null as number | null, reachedInterviewAt: null as number | null, reachedOfferAt: null as number | null };
  const responseEventTypes = new Set(["recruiter_replied", "assessment_received", "interview_scheduled", "offer_received", "rejection_received"]);
  for (const e of events) {
    if (e.type === "application_submitted") appliedAt = minDefined(appliedAt, e.occurredAt);
    const to = e.toStatus as ApplicationStatus | null;
    if (e.type === "status_changed" && to) Object.assign(m, milestonePatch(m, to, e.occurredAt));
    if (responseEventTypes.has(e.type)) {
      m.firstResponseAt = minDefined(m.firstResponseAt, e.occurredAt);
      m.lastResponseAt = Math.max(m.lastResponseAt ?? 0, e.occurredAt);
    }
    if (e.type === "interview_scheduled" || e.type === "interview_completed") m.reachedInterviewAt = minDefined(m.reachedInterviewAt, e.occurredAt);
    if (e.type === "assessment_received") m.reachedAssessmentAt = minDefined(m.reachedAssessmentAt, e.occurredAt);
    if (e.type === "offer_received") m.reachedOfferAt = minDefined(m.reachedOfferAt, e.occurredAt);
  }
  await db
    .update(applications)
    .set({ ...m, appliedAt: appliedAt ?? app.appliedAt, updatedAt: now() })
    .where(eq(applications.id, applicationId));
}
