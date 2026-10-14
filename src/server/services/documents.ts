import { ALLOWED_UPLOAD_TYPES, PREVIEWABLE_TYPES, type DocumentKind } from "@shared/constants";
import type { DocumentDTO } from "@shared/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import type { AppEnv } from "../env";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { newId, now, sha256Hex } from "../lib/util";

const { documents, applications, savedJobs, applicationDocuments } = schema;

/** Verifies the file's magic bytes match its declared type (never trust the browser's MIME). */
export function sniffMatches(mime: string, bytes: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (mime) {
    case "application/pdf":
      return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return starts(0x50, 0x4b, 0x03, 0x04); // ZIP container
    case "application/msword":
      return starts(0xd0, 0xcf, 0x11, 0xe0);
    case "text/plain":
    case "text/markdown":
      return !bytes.subarray(0, 4096).includes(0);
    default:
      return false;
  }
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "_").slice(0, 180) || "file";
}

export async function uploadDocument(
  db: Db,
  env: AppEnv,
  userId: string,
  file: File,
  meta: { kind: DocumentKind; version_name: string; notes?: string | null },
): Promise<DocumentDTO> {
  const maxBytes = Number(env.MAX_UPLOAD_BYTES ?? 0) || 0;
  if (!env.FILES || maxBytes <= 0) throw new ApiError(503, "uploads_disabled", "File storage is not configured");
  if (file.size === 0) throw badRequest("empty_file", "File is empty");
  if (file.size > maxBytes) throw new ApiError(413, "file_too_large", "File is too large", { max_bytes: maxBytes });
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (!(mime in ALLOWED_UPLOAD_TYPES)) throw new ApiError(415, "unsupported_file_type", "Unsupported file type");
  const buf = await file.arrayBuffer();
  if (!sniffMatches(mime, new Uint8Array(buf))) throw new ApiError(415, "file_content_mismatch", "File content does not match its type");

  const id = newId();
  // Random, non-enumerable key; never derived from the file name.
  const r2Key = `users/${userId}/documents/${crypto.randomUUID()}`;
  const sha256 = await sha256Hex(buf);
  await env.FILES.put(r2Key, buf, { httpMetadata: { contentType: mime }, customMetadata: { documentId: id } });
  const ts = now();
  const row = {
    id,
    userId,
    kind: meta.kind,
    versionName: meta.version_name,
    fileName: safeFileName(file.name),
    mimeType: mime,
    sizeBytes: file.size,
    r2Key,
    sha256,
    notes: meta.notes ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
  try {
    await db.insert(documents).values(row);
  } catch (e) {
    await env.FILES.delete(r2Key);
    throw e;
  }
  return { id, kind: row.kind, version_name: row.versionName, file_name: row.fileName, mime_type: mime, size_bytes: row.sizeBytes, notes: row.notes, created_at: ts, usage_count: 0 };
}

export async function listDocuments(db: Db, userId: string): Promise<DocumentDTO[]> {
  const rows = await db
    .select({
      d: documents,
      usage: sql<number>`(SELECT COUNT(*) FROM ${applications} a WHERE a.resume_document_id = ${documents.id} OR a.cover_letter_document_id = ${documents.id})
        + (SELECT COUNT(*) FROM ${savedJobs} s WHERE (s.resume_document_id = ${documents.id} OR s.cover_letter_document_id = ${documents.id})
             AND NOT EXISTS (SELECT 1 FROM ${applications} a2 WHERE a2.saved_job_id = s.id))
        + (SELECT COUNT(*) FROM ${applicationDocuments} ad WHERE ad.document_id = ${documents.id})`,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.createdAt));
  return rows.map(({ d, usage }) => ({
    id: d.id,
    kind: d.kind,
    version_name: d.versionName,
    file_name: d.fileName,
    mime_type: d.mimeType,
    size_bytes: d.sizeBytes,
    notes: d.notes,
    created_at: d.createdAt,
    usage_count: Number(usage),
  }));
}

export async function getDocument(db: Db, userId: string, id: string) {
  const d = await db.query.documents.findFirst({ where: and(eq(documents.id, id), eq(documents.userId, userId), isNull(documents.deletedAt)) });
  if (!d) throw notFound("document");
  return d;
}

/** Streams a private file after the ownership check. Inline only for safe preview types, sandboxed. */
export async function documentResponse(db: Db, env: AppEnv, userId: string, id: string, inline: boolean): Promise<Response> {
  const d = await getDocument(db, userId, id);
  if (!env.FILES) throw new ApiError(503, "uploads_disabled", "File storage is not configured");
  const obj = await env.FILES.get(d.r2Key);
  if (!obj) throw notFound("file");
  const disposition = inline && PREVIEWABLE_TYPES.includes(d.mimeType) ? "inline" : "attachment";
  const ascii = d.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(obj.body, {
    headers: {
      "content-type": d.mimeType,
      "content-length": String(d.sizeBytes),
      "content-disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.fileName)}`,
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      // Browsers' built-in PDF viewers refuse to run under a CSP sandbox, so PDFs get a
      // locked-down policy without it; every other type is fully sandboxed.
      "content-security-policy":
        d.mimeType === "application/pdf"
          ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'"
          : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function updateDocument(db: Db, userId: string, id: string, patch: { kind?: string; version_name?: string; notes?: string | null }) {
  await getDocument(db, userId, id);
  const set: Partial<typeof documents.$inferInsert> = { updatedAt: now() };
  if (patch.kind) set.kind = patch.kind;
  if (patch.version_name) set.versionName = patch.version_name;
  if (patch.notes !== undefined) set.notes = patch.notes;
  await db.update(documents).set(set).where(eq(documents.id, id));
}

/** Permanently deletes the file from R2 and its metadata; links are cleared (FK set null). */
export async function deleteDocument(db: Db, env: AppEnv, userId: string, id: string) {
  const d = await getDocument(db, userId, id);
  // Metadata first: if that fails the file is still there; an orphaned file is harmless, a lost one is not.
  await db.delete(documents).where(eq(documents.id, id));
  if (env.FILES) await env.FILES.delete(d.r2Key);
}

export async function linkDocument(db: Db, userId: string, applicationId: string, documentId: string, role: string) {
  await getDocument(db, userId, documentId);
  const app = await db.query.applications.findFirst({ where: and(eq(applications.id, applicationId), eq(applications.userId, userId)) });
  if (!app) throw notFound("application");
  await db.insert(applicationDocuments).values({ applicationId, documentId, role, createdAt: now() }).onConflictDoNothing();
}

export async function unlinkDocument(db: Db, userId: string, applicationId: string, documentId: string) {
  const app = await db.query.applications.findFirst({ where: and(eq(applications.id, applicationId), eq(applications.userId, userId)) });
  if (!app) throw notFound("application");
  await db.delete(applicationDocuments).where(and(eq(applicationDocuments.applicationId, applicationId), eq(applicationDocuments.documentId, documentId)));
}

export async function listLinkedDocuments(db: Db, userId: string, applicationId: string) {
  return db
    .select({ id: documents.id, kind: documents.kind, version_name: documents.versionName, file_name: documents.fileName, mime_type: documents.mimeType, role: applicationDocuments.role })
    .from(applicationDocuments)
    .innerJoin(documents, eq(documents.id, applicationDocuments.documentId))
    .where(and(eq(applicationDocuments.applicationId, applicationId), eq(documents.userId, userId)));
}
