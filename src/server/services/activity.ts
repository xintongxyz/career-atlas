import { MANUAL_EVENT_TYPES, type EventType } from "@shared/constants";
import type { CalendarItem, EventDTO, NoteDTO, ReminderDTO } from "@shared/types";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { badRequest, notFound } from "../lib/errors";
import { newId, now } from "../lib/util";
import { eventInsert, loadSavedJob, recomputeMilestones, runBatch } from "./pipeline";

const { applicationEvents, applications, savedJobs, jobPostings, companies, notes, reminders } = schema;

// ---------------------------------------------------------------- events

export function eventToDTO(e: typeof applicationEvents.$inferSelect, extra?: { company_name?: string; job_title?: string }): EventDTO {
  return {
    id: e.id,
    saved_job_id: e.savedJobId,
    application_id: e.applicationId,
    type: e.type as EventType,
    from_status: e.fromStatus,
    to_status: e.toStatus,
    title: e.title,
    details: e.details,
    metadata: e.metadata ?? null,
    occurred_at: e.occurredAt,
    scheduled_for: e.scheduledFor,
    created_at: e.createdAt,
    ...extra,
  };
}

export async function listEvents(
  db: Db,
  userId: string,
  q: { saved_job_id?: string; company_id?: string; from?: number; to?: number; limit?: number; before?: number },
) {
  const conds = [eq(applicationEvents.userId, userId), isNull(applicationEvents.deletedAt)];
  if (q.saved_job_id) conds.push(eq(applicationEvents.savedJobId, q.saved_job_id));
  if (q.company_id) conds.push(eq(jobPostings.companyId, q.company_id));
  if (q.from != null) conds.push(sql`${applicationEvents.occurredAt} >= ${q.from}`);
  if (q.to != null) conds.push(sql`${applicationEvents.occurredAt} <= ${q.to}`);
  if (q.before != null) conds.push(sql`${applicationEvents.occurredAt} < ${q.before}`);
  const rows = await db
    .select({ e: applicationEvents, company_name: companies.name, job_title: jobPostings.title })
    .from(applicationEvents)
    .innerJoin(savedJobs, eq(savedJobs.id, applicationEvents.savedJobId))
    .innerJoin(jobPostings, eq(jobPostings.id, savedJobs.jobPostingId))
    .innerJoin(companies, eq(companies.id, jobPostings.companyId))
    .where(and(...conds))
    .orderBy(desc(applicationEvents.occurredAt), desc(applicationEvents.createdAt))
    .limit(Math.min(q.limit ?? 100, 500));
  return rows.map((r) => eventToDTO(r.e, { company_name: r.company_name, job_title: r.job_title }));
}

const DAY = 86_400_000;

/** Logs a manual timeline event, updating derived dates and reminders. */
export async function createEvent(
  db: Db,
  userId: string,
  savedJobId: string,
  body: { type: EventType; occurred_at: number; title?: string | null; details?: string | null; scheduled_for?: number | null },
) {
  if (!MANUAL_EVENT_TYPES.includes(body.type)) throw badRequest("event_type_not_manual", "This event type is recorded automatically");
  const { saved, application } = await loadSavedJob(db, userId, savedJobId);
  const ts = now();
  const items: BatchItem<"sqlite">[] = [];
  const eventId = newId();
  items.push(
    db.insert(applicationEvents).values({
      id: eventId,
      userId,
      savedJobId,
      applicationId: application?.id ?? null,
      type: body.type,
      title: body.title ?? null,
      details: body.details ?? null,
      occurredAt: body.occurred_at,
      scheduledFor: body.scheduled_for ?? null,
      createdAt: ts,
    }),
  );
  items.push(db.update(savedJobs).set({ lastActivityAt: Math.max(saved.lastActivityAt, body.occurred_at), updatedAt: ts }).where(eq(savedJobs.id, saved.id)));

  const reminderKind =
    body.type === "interview_scheduled" ? "interview" : body.type === "follow_up_scheduled" ? "follow_up" : body.type === "offer_received" ? "offer_deadline" : null;
  if (reminderKind && body.scheduled_for) {
    items.push(
      db.insert(reminders).values({
        id: newId(),
        userId,
        savedJobId,
        kind: reminderKind,
        title: body.title || `${reminderKind}_default`,
        notes: body.details ?? null,
        dueAt: body.scheduled_for,
        autoKey: `event:${eventId}`,
        createdAt: ts,
        updatedAt: ts,
      }),
    );
  }
  if (application) {
    const patch: Partial<typeof applications.$inferInsert> = { lastActivityAt: Math.max(application.lastActivityAt, body.occurred_at), updatedAt: ts };
    if (body.type === "offer_received" && body.scheduled_for) patch.offerDeadlineAt = body.scheduled_for;
    items.push(db.update(applications).set(patch).where(eq(applications.id, application.id)));
  }
  await runBatch(db, items);
  if (application) {
    await recomputeMilestones(db, userId, application.id);
    await syncNextDates(db, userId, savedJobId);
  }
  return eventId;
}

export async function updateEvent(db: Db, userId: string, eventId: string, patch: { occurred_at?: number; title?: string | null; details?: string | null }) {
  const e = await db.query.applicationEvents.findFirst({ where: and(eq(applicationEvents.id, eventId), eq(applicationEvents.userId, userId), isNull(applicationEvents.deletedAt)) });
  if (!e) throw notFound("event");
  const set: Partial<typeof applicationEvents.$inferInsert> = {};
  if (patch.occurred_at !== undefined) set.occurredAt = patch.occurred_at;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.details !== undefined) set.details = patch.details;
  if (Object.keys(set).length) await db.update(applicationEvents).set(set).where(eq(applicationEvents.id, eventId));
  const app = await db.query.applications.findFirst({ where: eq(applications.savedJobId, e.savedJobId) });
  if (app) await recomputeMilestones(db, userId, app.id);
}

/** Only manually logged events can be removed; lifecycle events are permanent history. */
export async function deleteEvent(db: Db, userId: string, eventId: string) {
  const e = await db.query.applicationEvents.findFirst({ where: and(eq(applicationEvents.id, eventId), eq(applicationEvents.userId, userId), isNull(applicationEvents.deletedAt)) });
  if (!e) throw notFound("event");
  if (!MANUAL_EVENT_TYPES.includes(e.type as EventType) && e.type !== "note_added") throw badRequest("event_not_deletable", "Lifecycle events cannot be deleted");
  await db.update(applicationEvents).set({ deletedAt: now() }).where(eq(applicationEvents.id, eventId));
  await db.update(reminders).set({ deletedAt: now() }).where(and(eq(reminders.autoKey, `event:${eventId}`), eq(reminders.userId, userId)));
  const app = await db.query.applications.findFirst({ where: eq(applications.savedJobId, e.savedJobId) });
  if (app) {
    await recomputeMilestones(db, userId, app.id);
    await syncNextDates(db, userId, e.savedJobId);
  }
}

// ---------------------------------------------------------------- notes

export async function listNotes(db: Db, userId: string, savedJobId: string): Promise<NoteDTO[]> {
  await loadSavedJob(db, userId, savedJobId);
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.savedJobId, savedJobId), eq(notes.userId, userId), isNull(notes.deletedAt)))
    .orderBy(desc(notes.createdAt));
  return rows.map((n) => ({ id: n.id, body: n.body, created_at: n.createdAt, updated_at: n.updatedAt }));
}

export async function createNote(db: Db, userId: string, savedJobId: string, body: string) {
  await loadSavedJob(db, userId, savedJobId);
  const ts = now();
  const id = newId();
  await runBatch(db, [
    db.insert(notes).values({ id, userId, savedJobId, body, createdAt: ts, updatedAt: ts }),
    eventInsert(db, { userId, savedJobId, type: "note_added", occurredAt: ts, metadata: { note_id: id } }),
    db.update(savedJobs).set({ lastActivityAt: ts }).where(eq(savedJobs.id, savedJobId)),
  ]);
  return { id, body, created_at: ts, updated_at: ts };
}

export async function updateNote(db: Db, userId: string, noteId: string, body: string) {
  const n = await db.query.notes.findFirst({ where: and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt)) });
  if (!n) throw notFound("note");
  await db.update(notes).set({ body, updatedAt: now() }).where(eq(notes.id, noteId));
}

export async function deleteNote(db: Db, userId: string, noteId: string) {
  const n = await db.query.notes.findFirst({ where: and(eq(notes.id, noteId), eq(notes.userId, userId), isNull(notes.deletedAt)) });
  if (!n) throw notFound("note");
  await db.update(notes).set({ deletedAt: now() }).where(eq(notes.id, noteId));
}

// ---------------------------------------------------------------- reminders

function reminderToDTO(r: typeof reminders.$inferSelect, extra?: { company_name?: string | null; job_title?: string | null }): ReminderDTO {
  return { id: r.id, saved_job_id: r.savedJobId, kind: r.kind as ReminderDTO["kind"], title: r.title, notes: r.notes, due_at: r.dueAt, completed_at: r.completedAt, ...extra };
}

export async function listReminders(db: Db, userId: string, q: { status?: "open" | "completed" | "all"; saved_job_id?: string; due_before?: number }) {
  const conds = [eq(reminders.userId, userId), isNull(reminders.deletedAt)];
  if (q.status === "open" || !q.status) conds.push(isNull(reminders.completedAt));
  if (q.status === "completed") conds.push(sql`${reminders.completedAt} IS NOT NULL`);
  if (q.saved_job_id) conds.push(eq(reminders.savedJobId, q.saved_job_id));
  if (q.due_before != null) conds.push(sql`${reminders.dueAt} <= ${q.due_before}`);
  const rows = await db
    .select({ r: reminders, company_name: companies.name, job_title: jobPostings.title })
    .from(reminders)
    .leftJoin(savedJobs, eq(savedJobs.id, reminders.savedJobId))
    .leftJoin(jobPostings, eq(jobPostings.id, savedJobs.jobPostingId))
    .leftJoin(companies, eq(companies.id, jobPostings.companyId))
    .where(and(...conds))
    .orderBy(asc(reminders.dueAt))
    .limit(500);
  return rows.map((r) => reminderToDTO(r.r, { company_name: r.company_name, job_title: r.job_title }));
}

export async function createReminder(db: Db, userId: string, body: { title: string; kind: string; due_at: number; saved_job_id?: string | null; notes?: string | null }) {
  if (body.saved_job_id) await loadSavedJob(db, userId, body.saved_job_id);
  const ts = now();
  const id = newId();
  await db.insert(reminders).values({ id, userId, savedJobId: body.saved_job_id ?? null, kind: body.kind, title: body.title, notes: body.notes ?? null, dueAt: body.due_at, createdAt: ts, updatedAt: ts });
  if (body.saved_job_id) await syncNextDates(db, userId, body.saved_job_id);
  return id;
}

export async function updateReminder(db: Db, userId: string, id: string, patch: { title?: string; kind?: string; due_at?: number; notes?: string | null; completed?: boolean }) {
  const r = await db.query.reminders.findFirst({ where: and(eq(reminders.id, id), eq(reminders.userId, userId), isNull(reminders.deletedAt)) });
  if (!r) throw notFound("reminder");
  const set: Partial<typeof reminders.$inferInsert> = { updatedAt: now() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.due_at !== undefined) set.dueAt = patch.due_at;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.completed !== undefined) set.completedAt = patch.completed ? now() : null;
  await db.update(reminders).set(set).where(eq(reminders.id, id));
  if (r.savedJobId) await syncNextDates(db, userId, r.savedJobId);
}

export async function deleteReminder(db: Db, userId: string, id: string) {
  const r = await db.query.reminders.findFirst({ where: and(eq(reminders.id, id), eq(reminders.userId, userId), isNull(reminders.deletedAt)) });
  if (!r) throw notFound("reminder");
  await db.update(reminders).set({ deletedAt: now() }).where(eq(reminders.id, id));
  if (r.savedJobId) await syncNextDates(db, userId, r.savedJobId);
}

/** Keeps the personal follow-up date in sync with a single reminder. */
export async function syncManualFollowUp(db: Db, userId: string, savedJobId: string, followUpAt: number | null) {
  const key = `follow_up_manual:${savedJobId}`;
  const existing = await db.query.reminders.findFirst({ where: and(eq(reminders.autoKey, key), eq(reminders.userId, userId)) });
  const ts = now();
  if (followUpAt == null) {
    if (existing) await db.update(reminders).set({ deletedAt: ts }).where(eq(reminders.id, existing.id));
  } else if (existing) {
    await db.update(reminders).set({ dueAt: followUpAt, deletedAt: null, completedAt: null, updatedAt: ts }).where(eq(reminders.id, existing.id));
  } else {
    await db.insert(reminders).values({ id: newId(), userId, savedJobId, kind: "follow_up", title: "follow_up_default", dueAt: followUpAt, autoKey: key, createdAt: ts, updatedAt: ts });
  }
  await syncNextDates(db, userId, savedJobId);
}

/** next_follow_up_at / next_interview_at always reflect the earliest open reminder. */
export async function syncNextDates(db: Db, userId: string, savedJobId: string) {
  const app = await db.query.applications.findFirst({ where: and(eq(applications.savedJobId, savedJobId), eq(applications.userId, userId)) });
  const open = await db
    .select({ kind: reminders.kind, due: sql<number>`MIN(${reminders.dueAt})` })
    .from(reminders)
    .where(and(eq(reminders.savedJobId, savedJobId), isNull(reminders.completedAt), isNull(reminders.deletedAt)))
    .groupBy(reminders.kind);
  const min = (k: string) => open.find((o) => o.kind === k)?.due ?? null;
  if (app) {
    await db
      .update(applications)
      .set({ nextFollowUpAt: min("follow_up"), nextInterviewAt: min("interview") })
      .where(eq(applications.id, app.id));
  }
}

// ---------------------------------------------------------------- calendar

export async function calendarItems(db: Db, userId: string, from: number, to: number): Promise<CalendarItem[]> {
  const d1 = db.$client;
  const [rem, applied, deadlines, offers] = await Promise.all([
    d1
      .prepare(
        `SELECT r.id, r.kind, r.title, r.due_at, r.completed_at, r.saved_job_id, c.name AS company_name, p.title AS job_title
         FROM reminders r LEFT JOIN saved_jobs sj ON sj.id = r.saved_job_id LEFT JOIN job_postings p ON p.id = sj.job_posting_id
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE r.user_id = ? AND r.deleted_at IS NULL AND r.due_at BETWEEN ? AND ? ORDER BY r.due_at`,
      )
      .bind(userId, from, to)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT a.id, a.applied_at, a.saved_job_id, c.name AS company_name, p.title AS job_title FROM applications a
         JOIN job_postings p ON p.id = a.job_posting_id JOIN companies c ON c.id = p.company_id
         WHERE a.user_id = ? AND a.applied_at BETWEEN ? AND ?`,
      )
      .bind(userId, from, to)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT sj.id AS saved_job_id, p.id, p.deadline_at, c.name AS company_name, p.title AS job_title FROM saved_jobs sj
         JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL JOIN companies c ON c.id = p.company_id
         WHERE sj.user_id = ? AND sj.archived_at IS NULL AND p.deadline_at BETWEEN ? AND ?`,
      )
      .bind(userId, from, to)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT a.id, a.offer_deadline_at, a.saved_job_id, c.name AS company_name, p.title AS job_title FROM applications a
         JOIN job_postings p ON p.id = a.job_posting_id JOIN companies c ON c.id = p.company_id
         WHERE a.user_id = ? AND a.offer_deadline_at BETWEEN ? AND ? AND a.status IN ('offer')`,
      )
      .bind(userId, from, to)
      .all<Record<string, unknown>>(),
  ]);
  const items: CalendarItem[] = [];
  const s = (v: unknown) => (v == null ? null : String(v));
  for (const r of rem.results) {
    // Offer deadlines from reminders and from the application row are the same thing.
    if (r.kind === "offer_deadline") continue;
    items.push({
      id: `r:${r.id}`,
      kind: r.kind === "interview" ? "interview" : r.kind === "follow_up" ? "follow_up" : "reminder",
      at: r.due_at as number,
      title: r.title as string,
      saved_job_id: s(r.saved_job_id),
      company_name: s(r.company_name),
      job_title: s(r.job_title),
      reminder_id: r.id as string,
      completed: r.completed_at != null,
    });
  }
  for (const r of applied.results) items.push({ id: `a:${r.id}`, kind: "applied", at: r.applied_at as number, title: "applied", saved_job_id: s(r.saved_job_id), company_name: s(r.company_name), job_title: s(r.job_title) });
  for (const r of deadlines.results) items.push({ id: `d:${r.id}`, kind: "deadline", at: r.deadline_at as number, title: "deadline", saved_job_id: s(r.saved_job_id), company_name: s(r.company_name), job_title: s(r.job_title) });
  for (const r of offers.results) items.push({ id: `o:${r.id}`, kind: "offer_deadline", at: r.offer_deadline_at as number, title: "offer_deadline", saved_job_id: s(r.saved_job_id), company_name: s(r.company_name), job_title: s(r.job_title) });
  return items.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- ICS

const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function foldLine(line: string): string {
  // RFC 5545: lines longer than 75 octets are folded.
  const out: string[] = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = 75;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(events: { uid: string; start: number; durationMin?: number; summary: string; description?: string | null }[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Career Atlas//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  const stamp = icsDate(Date.now());
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@career-atlas`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.start + (e.durationMin ?? 30) * 60_000)}`,
      foldLine(`SUMMARY:${icsEscape(e.summary)}`),
    );
    if (e.description) lines.push(foldLine(`DESCRIPTION:${icsEscape(e.description)}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export const DAY_MS = DAY;
