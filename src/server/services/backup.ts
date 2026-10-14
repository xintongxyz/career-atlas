import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { badRequest } from "../lib/errors";
import { chunk, newId, now } from "../lib/util";
import { listJobs } from "../repositories/jobs-repo";
import { findOrCreateCompany } from "./companies";
import { runBatch } from "./pipeline";
import { ensureTags } from "./tags";

const T = schema;
export const EXPORT_FORMAT = "career-atlas-export";
export const EXPORT_VERSION = 1;

type Row = Record<string, unknown>;
const strip = (rows: Row[], ...keys: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))));

/** Full JSON export of the user's database rows. Uploaded file *contents* are not included. */
export async function exportJson(db: Db, userId: string) {
  const by = <Tbl extends { userId: unknown }>(table: Tbl) => eq((table as unknown as { userId: typeof T.companies.userId }).userId, userId);
  const [prefs, companies, postings, saved, apps, events, notes, tags, reminders, contacts, views, documents, snapshots, evidence, overrides] = await Promise.all([
    db.select().from(T.userPreferences).where(eq(T.userPreferences.userId, userId)),
    db.select().from(T.companies).where(by(T.companies)),
    db.select().from(T.jobPostings).where(by(T.jobPostings)),
    db.select().from(T.savedJobs).where(by(T.savedJobs)),
    db.select().from(T.applications).where(by(T.applications)),
    db.select().from(T.applicationEvents).where(by(T.applicationEvents)),
    db.select().from(T.notes).where(by(T.notes)),
    db.select().from(T.tags).where(by(T.tags)),
    db.select().from(T.reminders).where(by(T.reminders)),
    db.select().from(T.contacts).where(by(T.contacts)),
    db.select().from(T.customViews).where(by(T.customViews)),
    db.select().from(T.documents).where(by(T.documents)),
    db.select().from(T.jobSourceSnapshots).where(by(T.jobSourceSnapshots)),
    db.select().from(T.extractedFieldEvidence).where(by(T.extractedFieldEvidence)),
    db.select().from(T.userFieldOverrides).where(by(T.userFieldOverrides)),
  ]);
  const savedIds = new Set(saved.map((s) => s.id));
  const jobTags = (await db.select().from(T.jobTags)).filter((jt) => savedIds.has(jt.savedJobId));
  const appIds = new Set(apps.map((a) => a.id));
  const appDocs = (await db.select().from(T.applicationDocuments)).filter((ad) => appIds.has(ad.applicationId));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    notice:
      "This file contains your database records only. Uploaded document files (resumes, cover letters) are NOT included; documents lists their metadata. Download files separately from the Documents page.",
    data: {
      preferences: strip(prefs as Row[], "userId"),
      companies: strip(companies as Row[], "userId"),
      job_postings: strip(postings as Row[], "userId"),
      saved_jobs: strip(saved as Row[], "userId"),
      applications: strip(apps as Row[], "userId"),
      application_events: strip(events as Row[], "userId"),
      notes: strip(notes as Row[], "userId"),
      tags: strip(tags as Row[], "userId"),
      job_tags: jobTags as Row[],
      reminders: strip(reminders as Row[], "userId"),
      contacts: strip(contacts as Row[], "userId"),
      custom_views: strip(views as Row[], "userId"),
      documents: strip(documents as Row[], "userId", "r2Key"),
      application_documents: appDocs as Row[],
      job_source_snapshots: strip(snapshots as Row[], "userId"),
      extracted_field_evidence: strip(evidence as Row[], "userId"),
      user_field_overrides: strip(overrides as Row[], "userId"),
    },
  };
}

// ---------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  "company",
  "title",
  "status",
  "priority",
  "work_mode",
  "employment_type",
  "city",
  "region",
  "country",
  "salary_min",
  "salary_max",
  "salary_currency",
  "salary_period",
  "salary_source",
  "source",
  "deadline",
  "saved_at",
  "applied_at",
  "tags",
] as const;

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(db: Db, userId: string, headers: Record<string, string>, statusLabels: Record<string, string>) {
  const all: Awaited<ReturnType<typeof listJobs>>["items"] = [];
  for (let page = 1; page < 100; page++) {
    const res = await listJobs(db.$client, userId, { archived: "include", page, page_size: 200, sort: "saved_at", dir: "desc" });
    all.push(...res.items);
    if (res.items.length < 200) break;
  }
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : "");
  const lines = [CSV_COLUMNS.map((c) => csvCell(headers[c] ?? c)).join(",")];
  for (const j of all) {
    lines.push(
      [
        j.company_name,
        j.title,
        statusLabels[j.status] ?? j.status,
        j.priority,
        j.work_mode,
        j.employment_type,
        j.city,
        j.region,
        j.country,
        j.salary?.min,
        j.salary?.max,
        j.salary?.currency,
        j.salary?.period,
        j.salary?.source,
        j.source_platform,
        iso(j.deadline_at),
        iso(j.saved_at),
        iso(j.applied_at),
        j.tags.map((t) => t.name).join("; "),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- import

const rowsOf = z.array(z.record(z.string(), z.unknown())).default([]);
const importFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().min(1).max(EXPORT_VERSION),
  data: z.object({
    preferences: rowsOf,
    companies: rowsOf,
    job_postings: rowsOf,
    saved_jobs: rowsOf,
    applications: rowsOf,
    application_events: rowsOf,
    notes: rowsOf,
    tags: rowsOf,
    job_tags: rowsOf,
    reminders: rowsOf,
    contacts: rowsOf,
    custom_views: rowsOf,
    documents: rowsOf,
    application_documents: rowsOf,
    job_source_snapshots: rowsOf,
    extracted_field_evidence: rowsOf,
    user_field_overrides: rowsOf,
  }),
});

export interface ImportReport {
  counts: Record<string, number>;
  duplicates: { company: string; title: string; reason: string }[];
  will_import: { jobs: number; skipped_duplicates: number };
  warnings: string[];
  imported?: Record<string, number>;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Two-step import: `preview` validates and reports what would happen,
 * `commit` writes. Every imported row gets a fresh ID (no collisions with
 * existing data); postings that already exist (same canonical URL or ATS job
 * ID) are skipped together with their dependent rows.
 */
export async function importJson(db: Db, userId: string, input: unknown, mode: "preview" | "commit"): Promise<ImportReport> {
  const parsed = importFileSchema.safeParse(input);
  if (!parsed.success) throw badRequest("invalid_import_file", "Not a valid Career Atlas export file", parsed.error.issues.slice(0, 5));
  const d = parsed.data.data;
  const warnings: string[] = [];
  if (d.documents.length) warnings.push("documents_metadata_only");

  const companyById = new Map(d.companies.map((c) => [str(c.id), c]));
  const existing = await db
    .select({ id: T.jobPostings.id, canonicalUrl: T.jobPostings.canonicalUrl, platform: T.jobPostings.sourcePlatform, externalJobId: T.jobPostings.externalJobId })
    .from(T.jobPostings)
    .where(and(eq(T.jobPostings.userId, userId), isNull(T.jobPostings.deletedAt)));
  const urls = new Set(existing.map((e) => e.canonicalUrl).filter(Boolean));
  const ext = new Set(existing.filter((e) => e.externalJobId && e.platform !== "manual" && e.platform !== "company_site").map((e) => `${e.platform}:${e.externalJobId}`));

  const duplicates: ImportReport["duplicates"] = [];
  const keepPostings: Row[] = [];
  for (const p of d.job_postings) {
    if (!str(p.id) || typeof p.title !== "string") continue;
    const canonical = str(p.canonicalUrl);
    const key = str(p.externalJobId) ? `${str(p.sourcePlatform)}:${str(p.externalJobId)}` : null;
    const company = str(companyById.get(str(p.companyId))?.name) ?? "?";
    if ((canonical && urls.has(canonical)) || (key && ext.has(key))) {
      duplicates.push({ company, title: str(p.title) ?? "", reason: canonical && urls.has(canonical) ? "same_url" : "same_external_id" });
      continue;
    }
    keepPostings.push(p);
  }
  const report: ImportReport = {
    counts: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length])),
    duplicates: duplicates.slice(0, 200),
    will_import: { jobs: keepPostings.length, skipped_duplicates: duplicates.length },
    warnings,
  };
  if (mode === "preview") return report;

  // ---------- commit ----------
  const ts = now();
  const idMap = new Map<string, string>();
  const remap = (old: unknown) => {
    const o = str(old);
    if (!o) return null;
    let n = idMap.get(o);
    if (!n) {
      n = newId();
      idMap.set(o, n);
    }
    return n;
  };
  const mapped = (old: unknown) => (str(old) ? (idMap.get(str(old)!) ?? null) : null);
  const items: BatchItem<"sqlite">[] = [];
  const imported: Record<string, number> = {};
  const inc = (k: string) => (imported[k] = (imported[k] ?? 0) + 1);

  // Companies: merge into existing ones by domain/name.
  const companyMap = new Map<string, string>();
  for (const p of keepPostings) {
    const oldCid = str(p.companyId);
    if (!oldCid || companyMap.has(oldCid)) continue;
    const c = companyById.get(oldCid);
    const company = await findOrCreateCompany(db, userId, str(c?.name) || "Unknown company", str(c?.website));
    companyMap.set(oldCid, company.id);
  }

  const keptPostingIds = new Set(keepPostings.map((p) => str(p.id)!));
  for (const p of keepPostings) {
    const id = remap(p.id)!;
    const row = { ...p, id, userId, companyId: companyMap.get(str(p.companyId)!)!, latestExtractionId: null, createdAt: num(p.createdAt) ?? ts, updatedAt: num(p.updatedAt) ?? ts } as typeof T.jobPostings.$inferInsert;
    items.push(db.insert(T.jobPostings).values(row));
    inc("job_postings");
  }
  const keptSaved = d.saved_jobs.filter((s) => keptPostingIds.has(str(s.jobPostingId) ?? ""));
  for (const s of keptSaved) {
    items.push(
      db.insert(T.savedJobs).values({
        ...(s as object),
        id: remap(s.id)!,
        userId,
        jobPostingId: mapped(s.jobPostingId)!,
        resumeDocumentId: null,
        coverLetterDocumentId: null,
        referralContactId: null,
        recruiterContactId: null,
        savedAt: num(s.savedAt) ?? ts,
        lastActivityAt: num(s.lastActivityAt) ?? ts,
        updatedAt: ts,
      } as typeof T.savedJobs.$inferInsert),
    );
    inc("saved_jobs");
  }
  const keptSavedIds = new Set(keptSaved.map((s) => str(s.id)!));
  const keptApps = d.applications.filter((a) => keptSavedIds.has(str(a.savedJobId) ?? ""));
  for (const a of keptApps) {
    items.push(
      db.insert(T.applications).values({
        ...(a as object),
        id: remap(a.id)!,
        userId,
        savedJobId: mapped(a.savedJobId)!,
        jobPostingId: mapped(a.jobPostingId)!,
        resumeDocumentId: null,
        coverLetterDocumentId: null,
        appliedAt: num(a.appliedAt) ?? ts,
        lastActivityAt: num(a.lastActivityAt) ?? ts,
        createdAt: num(a.createdAt) ?? ts,
        updatedAt: ts,
      } as typeof T.applications.$inferInsert),
    );
    inc("applications");
  }
  for (const e of d.application_events.filter((e) => keptSavedIds.has(str(e.savedJobId) ?? ""))) {
    items.push(
      db.insert(T.applicationEvents).values({ ...(e as object), id: newId(), userId, savedJobId: mapped(e.savedJobId)!, applicationId: mapped(e.applicationId), occurredAt: num(e.occurredAt) ?? ts, createdAt: num(e.createdAt) ?? ts } as typeof T.applicationEvents.$inferInsert),
    );
    inc("application_events");
  }
  for (const n of d.notes.filter((n) => keptSavedIds.has(str(n.savedJobId) ?? ""))) {
    items.push(db.insert(T.notes).values({ ...(n as object), id: newId(), userId, savedJobId: mapped(n.savedJobId)!, body: str(n.body) ?? "", createdAt: num(n.createdAt) ?? ts, updatedAt: num(n.updatedAt) ?? ts } as typeof T.notes.$inferInsert));
    inc("notes");
  }
  for (const r of d.reminders) {
    const sj = str(r.savedJobId);
    if (sj && !keptSavedIds.has(sj)) continue;
    items.push(
      db.insert(T.reminders).values({ ...(r as object), id: newId(), userId, savedJobId: sj ? mapped(sj) : null, autoKey: null, title: str(r.title) ?? "", dueAt: num(r.dueAt) ?? ts, createdAt: num(r.createdAt) ?? ts, updatedAt: ts } as typeof T.reminders.$inferInsert),
    );
    inc("reminders");
  }
  for (const s of d.job_source_snapshots.filter((s) => keptPostingIds.has(str(s.jobPostingId) ?? ""))) {
    items.push(db.insert(T.jobSourceSnapshots).values({ ...(s as object), id: newId(), userId, jobPostingId: mapped(s.jobPostingId)!, extractionJobId: null } as typeof T.jobSourceSnapshots.$inferInsert));
    inc("job_source_snapshots");
  }
  for (const e of d.extracted_field_evidence.filter((e) => keptPostingIds.has(str(e.jobPostingId) ?? ""))) {
    items.push(db.insert(T.extractedFieldEvidence).values({ ...(e as object), id: newId(), userId, jobPostingId: mapped(e.jobPostingId)!, extractionJobId: null } as typeof T.extractedFieldEvidence.$inferInsert));
    inc("extracted_field_evidence");
  }
  for (const o of d.user_field_overrides.filter((o) => keptPostingIds.has(str(o.jobPostingId) ?? ""))) {
    items.push(db.insert(T.userFieldOverrides).values({ ...(o as object), id: newId(), userId, jobPostingId: mapped(o.jobPostingId)! } as typeof T.userFieldOverrides.$inferInsert).onConflictDoNothing());
    inc("user_field_overrides");
  }
  for (const c of d.contacts) {
    if (!str(c.name)) continue;
    const companyId = str(c.companyId) && companyById.has(str(c.companyId)) ? (companyMap.get(str(c.companyId)!) ?? (await findOrCreateCompany(db, userId, str(companyById.get(str(c.companyId))?.name) ?? "Unknown company")).id) : null;
    items.push(db.insert(T.contacts).values({ ...(c as object), id: newId(), userId, companyId, name: str(c.name)!, createdAt: num(c.createdAt) ?? ts, updatedAt: ts } as typeof T.contacts.$inferInsert));
    inc("contacts");
  }
  for (const v of d.custom_views) {
    if (!str(v.name) || typeof v.state !== "object") continue;
    items.push(db.insert(T.customViews).values({ id: newId(), userId, name: str(v.name)!, page: str(v.page) ?? "positions", state: v.state as Record<string, unknown>, createdAt: ts, updatedAt: ts }));
    inc("custom_views");
  }

  for (const part of chunk(items, 40)) await runBatch(db, part);

  // Tags last (needs saved-job ids to exist).
  const tagNameById = new Map(d.tags.map((t) => [str(t.id), str(t.name)]));
  const wantedTags = d.job_tags.filter((jt) => keptSavedIds.has(str(jt.savedJobId) ?? ""));
  const names = [...new Set(wantedTags.map((jt) => tagNameById.get(str(jt.tagId))).filter((n): n is string => !!n))];
  const tagRows = await ensureTags(db, userId, names);
  const tagIdByName = new Map(tagRows.map((t) => [t.normalizedName, t.id]));
  const tagInserts: BatchItem<"sqlite">[] = [];
  for (const jt of wantedTags) {
    const name = tagNameById.get(str(jt.tagId));
    const tagId = name ? tagIdByName.get(name.toLowerCase()) : null;
    const sj = mapped(jt.savedJobId);
    if (tagId && sj) tagInserts.push(db.insert(T.jobTags).values({ savedJobId: sj, tagId, createdAt: ts }).onConflictDoNothing());
  }
  for (const part of chunk(tagInserts, 50)) await runBatch(db, part);
  imported.job_tags = tagInserts.length;

  return { ...report, imported };
}
