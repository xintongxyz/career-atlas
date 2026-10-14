import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { notFound } from "../lib/errors";
import { domainOf, newId, normalizeName, now } from "../lib/util";
import { companyToDTO } from "./mappers";

const { companies, jobPostings } = schema;

/** Re-uses an existing company by website domain, then by normalized name. */
export async function findOrCreateCompany(
  db: Db,
  userId: string,
  name: string,
  website?: string | null,
): Promise<typeof companies.$inferSelect> {
  const domain = domainOf(website);
  const normalized = normalizeName(name) || name.toLowerCase();
  if (domain) {
    const byDomain = await db.query.companies.findFirst({
      where: and(eq(companies.userId, userId), eq(companies.domain, domain), isNull(companies.deletedAt)),
    });
    if (byDomain) return byDomain;
  }
  const byName = await db.query.companies.findFirst({
    where: and(eq(companies.userId, userId), eq(companies.normalizedName, normalized), isNull(companies.deletedAt)),
  });
  if (byName) {
    if (!byName.website && website) {
      await db
        .update(companies)
        .set({ website, domain, updatedAt: now() })
        .where(eq(companies.id, byName.id));
      return { ...byName, website, domain };
    }
    return byName;
  }
  const row = {
    id: newId(),
    userId,
    name: name.trim(),
    normalizedName: normalized,
    website: website ?? null,
    domain,
    logoUrl: null,
    industry: null,
    description: null,
    notes: null,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
  };
  await db.insert(companies).values(row);
  return row;
}

export async function listCompanies(db: Db, userId: string) {
  const rows = await db
    .select({
      company: companies,
      jobCount: sql<number>`(SELECT COUNT(*) FROM ${jobPostings} jp WHERE jp.company_id = ${companies.id} AND jp.deleted_at IS NULL)`,
    })
    .from(companies)
    .where(and(eq(companies.userId, userId), isNull(companies.deletedAt)))
    .orderBy(sql`${companies.name} COLLATE NOCASE`);
  return rows.map((r) => companyToDTO(r.company, Number(r.jobCount)));
}

export async function getCompany(db: Db, userId: string, id: string) {
  const c = await db.query.companies.findFirst({
    where: and(eq(companies.id, id), eq(companies.userId, userId), isNull(companies.deletedAt)),
  });
  if (!c) throw notFound("company");
  return c;
}

export async function updateCompany(
  db: Db,
  userId: string,
  id: string,
  patch: { name?: string; website?: string | null; industry?: string | null; description?: string | null; notes?: string | null },
) {
  const c = await getCompany(db, userId, id);
  const set: Partial<typeof companies.$inferInsert> = { updatedAt: now() };
  if (patch.name !== undefined) {
    set.name = patch.name;
    set.normalizedName = normalizeName(patch.name) || patch.name.toLowerCase();
  }
  if (patch.website !== undefined) {
    set.website = patch.website;
    set.domain = domainOf(patch.website);
  }
  if (patch.industry !== undefined) set.industry = patch.industry;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.notes !== undefined) set.notes = patch.notes;
  await db.update(companies).set(set).where(eq(companies.id, c.id));
  return companyToDTO({ ...c, ...set } as typeof c);
}
