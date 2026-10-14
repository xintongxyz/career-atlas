import type { ContactDTO } from "@shared/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { notFound } from "../lib/errors";
import { escapeLike, newId, now } from "../lib/util";
import { EFFECTIVE_STATUS_SQL } from "../repositories/jobs-repo";

const { contacts, companies, customViews } = schema;

// ---------------------------------------------------------------- contacts

type ContactInput = { name: string; kind: string; title?: string | null; email?: string | null; phone?: string | null; linkedin_url?: string | null; company_id?: string | null; notes?: string | null };

export async function listContacts(db: Db, userId: string): Promise<ContactDTO[]> {
  const rows = await db
    .select({ c: contacts, company_name: companies.name })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.userId, userId), isNull(contacts.deletedAt)))
    .orderBy(sql`${contacts.name} COLLATE NOCASE`);
  return rows.map(({ c, company_name }) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    title: c.title,
    email: c.email,
    phone: c.phone,
    linkedin_url: c.linkedinUrl,
    company_id: c.companyId,
    company_name,
    notes: c.notes,
  }));
}

async function assertCompany(db: Db, userId: string, companyId: string | null | undefined) {
  if (!companyId) return;
  const c = await db.query.companies.findFirst({ where: and(eq(companies.id, companyId), eq(companies.userId, userId)) });
  if (!c) throw notFound("company");
}

export async function createContact(db: Db, userId: string, input: ContactInput) {
  await assertCompany(db, userId, input.company_id);
  const id = newId();
  const ts = now();
  await db.insert(contacts).values({
    id,
    userId,
    name: input.name,
    kind: input.kind,
    title: input.title ?? null,
    email: input.email || null,
    phone: input.phone ?? null,
    linkedinUrl: input.linkedin_url ?? null,
    companyId: input.company_id ?? null,
    notes: input.notes ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

export async function updateContact(db: Db, userId: string, id: string, input: Partial<ContactInput>) {
  const c = await db.query.contacts.findFirst({ where: and(eq(contacts.id, id), eq(contacts.userId, userId), isNull(contacts.deletedAt)) });
  if (!c) throw notFound("contact");
  await assertCompany(db, userId, input.company_id);
  const set: Partial<typeof contacts.$inferInsert> = { updatedAt: now() };
  if (input.name !== undefined) set.name = input.name;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.title !== undefined) set.title = input.title;
  if (input.email !== undefined) set.email = input.email || null;
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.linkedin_url !== undefined) set.linkedinUrl = input.linkedin_url;
  if (input.company_id !== undefined) set.companyId = input.company_id;
  if (input.notes !== undefined) set.notes = input.notes;
  await db.update(contacts).set(set).where(eq(contacts.id, id));
}

export async function deleteContact(db: Db, userId: string, id: string) {
  const c = await db.query.contacts.findFirst({ where: and(eq(contacts.id, id), eq(contacts.userId, userId), isNull(contacts.deletedAt)) });
  if (!c) throw notFound("contact");
  await db.update(contacts).set({ deletedAt: now() }).where(eq(contacts.id, id));
}

// ---------------------------------------------------------------- saved views

export async function listViews(db: Db, userId: string, page = "positions") {
  const rows = await db
    .select()
    .from(customViews)
    .where(and(eq(customViews.userId, userId), eq(customViews.page, page)))
    .orderBy(desc(customViews.updatedAt));
  return rows.map((v) => ({ id: v.id, name: v.name, page: v.page, state: v.state, updated_at: v.updatedAt }));
}

export async function saveView(db: Db, userId: string, input: { name: string; page: string; state: Record<string, unknown> }, id?: string) {
  const ts = now();
  if (id) {
    const v = await db.query.customViews.findFirst({ where: and(eq(customViews.id, id), eq(customViews.userId, userId)) });
    if (!v) throw notFound("view");
    await db.update(customViews).set({ name: input.name, state: input.state, updatedAt: ts }).where(eq(customViews.id, id));
    return id;
  }
  const newViewId = newId();
  await db.insert(customViews).values({ id: newViewId, userId, name: input.name, page: input.page, state: input.state, createdAt: ts, updatedAt: ts });
  return newViewId;
}

export async function deleteView(db: Db, userId: string, id: string) {
  const v = await db.query.customViews.findFirst({ where: and(eq(customViews.id, id), eq(customViews.userId, userId)) });
  if (!v) throw notFound("view");
  await db.delete(customViews).where(eq(customViews.id, id));
}

// ---------------------------------------------------------------- global search

export async function globalSearch(db: Db, userId: string, q: string) {
  const d1 = db.$client;
  const like = `%${escapeLike(q)}%`;
  const [jobs, comps] = await Promise.all([
    d1
      .prepare(
        `SELECT sj.id, p.title, c.name AS company_name, p.city, ${EFFECTIVE_STATUS_SQL} AS status
         FROM saved_jobs sj JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL
         JOIN companies c ON c.id = p.company_id LEFT JOIN applications a ON a.saved_job_id = sj.id
         WHERE sj.user_id = ? AND (p.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR p.city LIKE ? ESCAPE '\\')
         ORDER BY sj.last_activity_at DESC LIMIT 8`,
      )
      .bind(userId, like, like, like)
      .all(),
    d1
      .prepare(
        `SELECT c.id, c.name, c.domain, (SELECT COUNT(*) FROM job_postings p WHERE p.company_id = c.id AND p.deleted_at IS NULL) AS job_count
         FROM companies c WHERE c.user_id = ? AND c.deleted_at IS NULL AND c.name LIKE ? ESCAPE '\\' ORDER BY c.name COLLATE NOCASE LIMIT 5`,
      )
      .bind(userId, like)
      .all(),
  ]);
  return { jobs: jobs.results, companies: comps.results };
}
