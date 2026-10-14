import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { conflict, notFound } from "../lib/errors";
import { newId, now } from "../lib/util";

const { tags, jobTags } = schema;
const norm = (s: string) => s.trim().toLowerCase();

export async function listTags(db: Db, userId: string) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      usage: sql<number>`(SELECT COUNT(*) FROM ${jobTags} WHERE ${jobTags.tagId} = ${tags.id})`,
    })
    .from(tags)
    .where(eq(tags.userId, userId))
    .orderBy(sql`${tags.name} COLLATE NOCASE`);
}

export async function ensureTags(db: Db, userId: string, names: string[]) {
  const wanted = [...new Map(names.map((n) => [norm(n), n.trim()])).entries()].filter(([k]) => k);
  if (!wanted.length) return [];
  const existing = await db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.normalizedName, wanted.map(([k]) => k))));
  const have = new Map(existing.map((t) => [t.normalizedName, t]));
  const toCreate = wanted
    .filter(([k]) => !have.has(k))
    .map(([k, name]) => ({ id: newId(), userId, name, normalizedName: k, color: null, createdAt: now() }));
  if (toCreate.length) await db.insert(tags).values(toCreate).onConflictDoNothing();
  return [...existing, ...toCreate];
}

/** Replaces the tag set of a saved job. */
export async function setJobTags(db: Db, userId: string, savedJobId: string, names: string[]) {
  const list = await ensureTags(db, userId, names);
  await db.delete(jobTags).where(eq(jobTags.savedJobId, savedJobId));
  if (list.length) {
    await db
      .insert(jobTags)
      .values(list.map((t) => ({ savedJobId, tagId: t.id, createdAt: now() })))
      .onConflictDoNothing();
  }
}

export async function createTag(db: Db, userId: string, name: string, color?: string | null) {
  const existing = await db.query.tags.findFirst({
    where: and(eq(tags.userId, userId), eq(tags.normalizedName, norm(name))),
  });
  if (existing) throw conflict("tag_exists", "Tag already exists");
  const row = { id: newId(), userId, name: name.trim(), normalizedName: norm(name), color: color ?? null, createdAt: now() };
  await db.insert(tags).values(row);
  return { id: row.id, name: row.name, color: row.color };
}

export async function updateTag(db: Db, userId: string, id: string, patch: { name?: string; color?: string | null }) {
  const t = await db.query.tags.findFirst({ where: and(eq(tags.id, id), eq(tags.userId, userId)) });
  if (!t) throw notFound("tag");
  const set: Partial<typeof tags.$inferInsert> = {};
  if (patch.name) {
    const clash = await db.query.tags.findFirst({
      where: and(eq(tags.userId, userId), eq(tags.normalizedName, norm(patch.name))),
    });
    if (clash && clash.id !== id) throw conflict("tag_exists", "Tag already exists");
    set.name = patch.name.trim();
    set.normalizedName = norm(patch.name);
  }
  if (patch.color !== undefined) set.color = patch.color;
  if (Object.keys(set).length) await db.update(tags).set(set).where(eq(tags.id, id));
  return { id, name: set.name ?? t.name, color: set.color !== undefined ? set.color : t.color };
}

export async function deleteTag(db: Db, userId: string, id: string) {
  const t = await db.query.tags.findFirst({ where: and(eq(tags.id, id), eq(tags.userId, userId)) });
  if (!t) throw notFound("tag");
  await db.delete(tags).where(eq(tags.id, id));
}
