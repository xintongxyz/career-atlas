// Automated applications: attempt lifecycle, safety checks and pipeline synchronisation.
//
// The worker (src/local/apply) does the browser work; everything that decides what is allowed
// lives here so it is the same for the API and the worker:
//   - one blocking attempt per job; an uncertain submission must be resolved by the user first
//   - the resume is pinned (document id + sha256 + name + size) and never substituted
//   - "Applied" is set only through changeStatus, after a verified confirmation
import {
  BLOCKING_ATTEMPT_STATES,
  UPLOADABLE_RESUME_TYPES,
  type ApplyOverview,
  type ApplySupport,
  type AttemptDTO,
  type AttemptState,
  type AttemptStep,
  type AttemptSummary,
  type FilledField,
  type InterventionReason,
  type PendingQuestion,
  type ProfileCheckItem,
} from "@shared/apply";
import { emptyProfile, profileSchema, type Profile } from "@shared/profile";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import type { AppEnv } from "../env";
import { detectPlatform } from "../extraction/platforms";
import { ApiError, conflict, notFound } from "../lib/errors";
import { chunk, newId, now, sha256Hex } from "../lib/util";
import { changeStatus, loadSavedJob } from "./pipeline";
import { getProfileRow, profileForMatching } from "./profile";

const { applicationAttempts, documents, applicationDocuments, userProfiles } = schema;
export type AttemptRow = typeof applicationAttempts.$inferSelect;

const MANUAL_PLATFORMS = new Set(["workday", "linkedin", "indeed", "ashby", "smartrecruiters"]);
const MAX_STEPS = 80;

// ---------------------------------------------------------------- helpers

export function supportFor(url: string | null, allowLoopback: boolean): ApplySupport {
  if (!url) return { ats: null, supported: false, mode: "manual", url: null };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ats: null, supported: false, mode: "manual", url };
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(allowLoopback && loopback && u.protocol === "http:")) return { ats: null, supported: false, mode: "manual", url };
  if (loopback && !allowLoopback) return { ats: null, supported: false, mode: "manual", url };
  const p = detectPlatform(url).platform;
  // Greenhouse boards, and Greenhouse embedded on a company site (?gh_jid=…).
  if (p === "greenhouse") return { ats: "greenhouse", supported: true, mode: "adapter", url };
  if (p === "lever" && /^jobs(\.eu)?\.lever\.co$/.test(u.hostname)) return { ats: "lever", supported: true, mode: "adapter", url };
  if (MANUAL_PLATFORMS.has(p)) return { ats: p, supported: false, mode: "manual", url };
  // Unknown site: the worker looks for a Greenhouse/Lever form and stops without filling otherwise.
  return { ats: null, supported: true, mode: "detect", url };
}

function profileCheck(p: Profile | null): ProfileCheckItem[] {
  const c = p?.contact ?? {};
  const has = (v: unknown) => v !== null && v !== undefined && v !== "";
  return [
    { key: "name", ok: has(c.first_name) && has(c.last_name), required: true },
    { key: "email", ok: has(c.email), required: true },
    { key: "phone", ok: has(c.phone), required: false },
    { key: "location", ok: has(p?.based_in.city), required: false },
    { key: "linkedin", ok: has(c.linkedin_url), required: false },
    { key: "work_authorization", ok: (p?.work_authorization.length ?? 0) > 0, required: false },
  ];
}

export async function readDocumentBytes(env: AppEnv, key: string): Promise<Uint8Array | null> {
  const obj = await env.FILES?.get(key);
  if (!obj) return null;
  return new Uint8Array(await new Response(obj.body).arrayBuffer());
}

export function toDTO(r: AttemptRow, doc?: { deletedAt: number | null; sha256: string } | null): AttemptDTO {
  return {
    id: r.id,
    job_id: r.savedJobId,
    state: r.state as AttemptState,
    stage: r.stage,
    ats: r.ats,
    target_url: r.targetUrl,
    submit_mode: r.submitMode === "auto" ? "auto" : "review",
    resume: {
      id: r.resumeDocumentId,
      version_name: r.resumeVersionName,
      file_name: r.resumeFileName,
      sha256: r.resumeSha256,
      size_bytes: r.resumeSizeBytes,
      still_available: !!doc && !doc.deletedAt,
      unchanged: doc ? doc.sha256 === r.resumeSha256 : null,
    },
    visible: !!r.visible,
    intervention: (r.intervention as InterventionReason | null) ?? null,
    questions: (r.questions as PendingQuestion[] | null) ?? [],
    filled: (r.filled as FilledField[] | null) ?? [],
    steps: (r.steps as AttemptStep[] | null) ?? [],
    error_code: r.errorCode,
    error_message: r.errorMessage,
    confirmation: { text: r.confirmationText, url: r.confirmationUrl, at: r.confirmedAt, source: (r.confirmationSource as "page" | "user" | null) ?? null },
    evidence: (r.evidence as string[] | null) ?? [],
    submit_clicked_at: r.submitClickedAt,
    created_at: r.createdAt,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    updated_at: r.updatedAt,
  };
}

export async function getAttemptRow(db: Db, userId: string, id: string) {
  const r = await db.query.applicationAttempts.findFirst({ where: and(eq(applicationAttempts.id, id), eq(applicationAttempts.userId, userId)) });
  if (!r) throw notFound("attempt");
  return r;
}

async function dtoWithDoc(db: Db, r: AttemptRow) {
  const doc = r.resumeDocumentId ? await db.query.documents.findFirst({ where: eq(documents.id, r.resumeDocumentId) }) : null;
  return toDTO(r, doc ?? null);
}

export async function getAttempt(db: Db, userId: string, id: string) {
  return dtoWithDoc(db, await getAttemptRow(db, userId, id));
}

/** Appends a progress step and applies a patch (used by the worker and the API). */
export async function updateAttempt(db: Db, id: string, patch: Partial<typeof applicationAttempts.$inferInsert>, step?: Omit<AttemptStep, "at">) {
  const set: Partial<typeof applicationAttempts.$inferInsert> = { ...patch, updatedAt: now() };
  if (step) {
    const row = await db.query.applicationAttempts.findFirst({ where: eq(applicationAttempts.id, id) });
    const steps = ((row?.steps as AttemptStep[] | null) ?? []).concat({ at: now(), ...step }).slice(-MAX_STEPS);
    set.steps = steps;
  }
  await db.update(applicationAttempts).set(set).where(eq(applicationAttempts.id, id));
}

// ---------------------------------------------------------------- overview / list

export async function applyOverview(db: Db, env: AppEnv, userId: string, savedJobId: string): Promise<ApplyOverview> {
  const { saved, posting, application } = await loadSavedJob(db, userId, savedJobId);
  const allowLoopback = env.APPLY?.allowLoopback ?? false;
  const support = supportFor(posting.applyUrl || posting.originalUrl || posting.canonicalUrl, allowLoopback);
  const docs = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.kind, "resume"), isNull(documents.deletedAt)))
    .orderBy(desc(documents.createdAt));
  const profile = await profileForMatching(db, userId);
  const profileRow = await getProfileRow(db, userId);
  const rows = await db.select().from(applicationAttempts).where(and(eq(applicationAttempts.userId, userId), eq(applicationAttempts.savedJobId, savedJobId))).orderBy(desc(applicationAttempts.createdAt));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const attempts = await Promise.all(rows.map((r) => (r.resumeDocumentId && docById.has(r.resumeDocumentId) ? toDTO(r, docById.get(r.resumeDocumentId)) : dtoWithDoc(db, r))));
  const blocking = rows.find((r) => (BLOCKING_ATTEMPT_STATES as readonly string[]).includes(r.state));
  const preferred = [saved.resumeDocumentId, profileRow?.resumeDocumentId].find((id) => id && docById.has(id)) ?? null;
  return {
    support,
    resumes: docs.map((d) => ({ id: d.id, version_name: d.versionName, file_name: d.fileName, mime_type: d.mimeType, size_bytes: d.sizeBytes, created_at: d.createdAt, notes: d.notes, uploadable: UPLOADABLE_RESUME_TYPES.includes(d.mimeType) })),
    default_resume_id: preferred,
    profile_check: profileCheck(profile?.profile ?? null),
    attempts,
    blocked_by: blocking ? blocking.state : application ? "already_applied" : null,
    worker: env.APPLY ? env.APPLY.status() : { available: false, browser: null, reason: "not_configured" },
  };
}

/** Latest pending/active attempt per saved job (for All Positions and Kanban). */
export async function attemptSummaries(db: Db, userId: string, savedJobIds: string[]): Promise<Map<string, AttemptSummary>> {
  const out = new Map<string, AttemptSummary>();
  const states = ["queued", "filling", "needs_review", "submitting", "submission_unconfirmed"];
  for (const ids of chunk(savedJobIds, 80)) {
    const rows = await db
      .select({ id: applicationAttempts.id, savedJobId: applicationAttempts.savedJobId, state: applicationAttempts.state, intervention: applicationAttempts.intervention, updatedAt: applicationAttempts.updatedAt })
      .from(applicationAttempts)
      .where(and(eq(applicationAttempts.userId, userId), inArray(applicationAttempts.savedJobId, ids), inArray(applicationAttempts.state, states)))
      .orderBy(desc(applicationAttempts.createdAt));
    for (const r of rows) if (!out.has(r.savedJobId)) out.set(r.savedJobId, { id: r.id, state: r.state as AttemptState, intervention: (r.intervention as InterventionReason | null) ?? null, updated_at: r.updatedAt });
  }
  return out;
}

// ---------------------------------------------------------------- start

export async function startAttempt(db: Db, env: AppEnv, userId: string, savedJobId: string, body: { resume_document_id: string; submit_mode: "auto" | "review" }) {
  if (!env.APPLY) throw new ApiError(503, "automation_unavailable", "Application automation is not available");
  const worker = env.APPLY.status();
  if (!worker.available) throw new ApiError(503, "automation_unavailable", worker.reason ?? "No browser available");
  const { saved, posting, application } = await loadSavedJob(db, userId, savedJobId);
  if (saved.archivedAt) throw conflict("job_archived", "Restore the job before applying");
  if (application) throw conflict("already_applied", "This job already has an application");
  const support = supportFor(posting.applyUrl || posting.originalUrl || posting.canonicalUrl, env.APPLY.allowLoopback);
  if (!support.supported || !support.url) throw conflict("unsupported_site", "This site is not supported for automatic applications");

  // Duplicate protection: one blocking attempt per job, and never the same form twice.
  const existing = await db.select().from(applicationAttempts).where(and(eq(applicationAttempts.userId, userId), eq(applicationAttempts.savedJobId, savedJobId)));
  const blocking = existing.find((r) => (BLOCKING_ATTEMPT_STATES as readonly string[]).includes(r.state));
  if (blocking) throw conflict(blocking.state === "submission_unconfirmed" ? "attempt_unconfirmed" : blocking.state === "submitted_verified" ? "already_applied" : "attempt_active", "An application attempt already exists for this job", { attempt_id: blocking.id });
  const sameTarget = await db
    .select({ id: applicationAttempts.id, savedJobId: applicationAttempts.savedJobId })
    .from(applicationAttempts)
    .where(and(eq(applicationAttempts.userId, userId), eq(applicationAttempts.targetUrl, support.url), inArray(applicationAttempts.state, ["submitting", "submitted_verified", "submission_unconfirmed"]), ne(applicationAttempts.savedJobId, savedJobId)));
  if (sameTarget.length) throw conflict("duplicate_target", "This application form was already submitted from another saved job", { job_id: sameTarget[0].savedJobId });

  // The exact resume the user chose — verified on disk now, pinned by hash for later.
  const doc = await db.query.documents.findFirst({ where: and(eq(documents.id, body.resume_document_id), eq(documents.userId, userId), isNull(documents.deletedAt)) });
  if (!doc || doc.kind !== "resume") throw notFound("document");
  if (!UPLOADABLE_RESUME_TYPES.includes(doc.mimeType)) throw new ApiError(415, "resume_type_not_uploadable", "Application forms accept PDF or Word resumes");
  const bytes = await readDocumentBytes(env, doc.r2Key);
  if (!bytes) throw new ApiError(409, "resume_file_missing", "The selected resume file is missing");
  if ((await sha256Hex(bytes.buffer as ArrayBuffer)) !== doc.sha256) throw new ApiError(409, "resume_file_changed", "The selected resume file does not match its record");

  const profile = await profileForMatching(db, userId);
  const missing = profileCheck(profile?.profile ?? null).filter((i) => i.required && !i.ok);
  if (missing.length) throw new ApiError(422, "profile_incomplete", "Add your name and email to My Profile first", { missing: missing.map((m) => m.key) });

  const ts = now();
  const id = newId();
  await db.insert(applicationAttempts).values({
    id,
    userId,
    savedJobId,
    jobPostingId: posting.id,
    resumeDocumentId: doc.id,
    resumeSha256: doc.sha256,
    resumeFileName: doc.fileName,
    resumeVersionName: doc.versionName,
    resumeMimeType: doc.mimeType,
    resumeSizeBytes: doc.sizeBytes,
    targetUrl: support.url,
    ats: support.ats,
    state: "queued",
    submitMode: body.submit_mode,
    submitAuthorized: body.submit_mode === "auto" ? 1 : 0,
    answers: {},
    steps: [{ at: ts, code: "queued" }],
    createdAt: ts,
    updatedAt: ts,
  });
  env.APPLY.enqueue(id);
  return getAttempt(db, userId, id);
}

// ---------------------------------------------------------------- user actions

function requireState(r: AttemptRow, states: AttemptState[]) {
  if (!states.includes(r.state as AttemptState)) throw conflict("attempt_state", `Not possible while the attempt is ${r.state}`, { state: r.state });
}

export async function answerAttempt(db: Db, env: AppEnv, userId: string, id: string, body: { answers: Record<string, unknown>; remember: string[] }) {
  const r = await getAttemptRow(db, userId, id);
  requireState(r, ["needs_review"]);
  const questions = (r.questions as PendingQuestion[] | null) ?? [];
  const known = new Map(questions.map((q) => [q.key, q]));
  const answers: Record<string, unknown> = { ...((r.answers as Record<string, unknown> | null) ?? {}) };
  for (const [k, v] of Object.entries(body.answers)) if (known.has(k) && v !== "" && v !== null) answers[k] = v;
  // Remember only what the user explicitly ticked, keyed by the exact question text.
  if (body.remember.length) {
    const row = await getProfileRow(db, userId);
    const parsed = profileSchema.safeParse(row?.data ?? {});
    const profile = parsed.success ? parsed.data : emptyProfile();
    for (const k of body.remember) {
      const q = known.get(k);
      if (!q || answers[k] === undefined) continue;
      const list = profile.saved_answers.filter((s) => s.question.trim().toLowerCase() !== q.label.trim().toLowerCase());
      list.push({ question: q.label, answer: answers[k] as string, created_at: now() });
      profile.saved_answers = list;
    }
    const clean = profileSchema.parse(profile);
    if (row) await db.update(userProfiles).set({ data: clean as unknown as Record<string, unknown>, updatedAt: now() }).where(eq(userProfiles.userId, userId));
    else await db.insert(userProfiles).values({ userId, data: clean as unknown as Record<string, unknown>, createdAt: now(), updatedAt: now() });
  }
  await updateAttempt(db, id, { answers, state: "queued", intervention: null, questions: [] }, { code: "answers_received", params: { count: Object.keys(body.answers).length } });
  env.APPLY?.enqueue(id);
  return getAttempt(db, userId, id);
}

/** Review mode, or a retry after the site rejected the form: the user approves one submission. */
export async function approveSubmit(db: Db, env: AppEnv, userId: string, id: string) {
  const r = await getAttemptRow(db, userId, id);
  requireState(r, ["needs_review"]);
  if (r.intervention !== "submit_approval" && r.intervention !== "validation_errors") throw conflict("attempt_state", "Nothing is waiting for submit approval");
  await updateAttempt(db, id, { submitAuthorized: 1, state: "queued", intervention: null }, { code: "submit_approved" });
  env.APPLY?.enqueue(id);
  return getAttempt(db, userId, id);
}

export async function cancelAttempt(db: Db, env: AppEnv, userId: string, id: string) {
  const r = await getAttemptRow(db, userId, id);
  if (r.state === "submitting") throw conflict("cannot_cancel_submitting", "The application is being submitted and can no longer be cancelled");
  requireState(r, ["queued", "filling", "needs_review"]);
  const ts = now();
  // A queued or paused attempt has no browser: cancel at once. A filling one stops at the next step.
  if (r.state === "filling") await updateAttempt(db, id, { cancelRequestedAt: ts }, { code: "cancel_requested" });
  else await updateAttempt(db, id, { cancelRequestedAt: ts, state: "cancelled", finishedAt: ts, intervention: null }, { code: "cancelled" });
  env.APPLY?.cancel(id);
  return getAttempt(db, userId, id);
}

/** Continue a paused attempt in a visible browser window (the form is filled again there). */
export async function continueVisible(db: Db, env: AppEnv, userId: string, id: string) {
  const r = await getAttemptRow(db, userId, id);
  requireState(r, ["needs_review"]);
  await updateAttempt(db, id, { visible: 1, state: "queued", intervention: null }, { code: "visible_requested" });
  env.APPLY?.enqueue(id);
  return getAttempt(db, userId, id);
}

/** The user resolves an uncertain submission (e.g. after checking their email). */
export async function resolveAttempt(db: Db, userId: string, id: string, outcome: "submitted" | "not_submitted") {
  const r = await getAttemptRow(db, userId, id);
  requireState(r, ["submission_unconfirmed"]);
  const ts = now();
  if (outcome === "submitted") {
    await updateAttempt(db, id, { state: "submitted_verified", confirmationSource: "user", confirmedAt: ts, finishedAt: ts }, { code: "user_confirmed" });
    await syncApplied(db, userId, await getAttemptRow(db, userId, id));
  } else {
    await updateAttempt(db, id, { state: "failed", errorCode: "user_reported_not_submitted", finishedAt: ts }, { code: "user_reported_not_submitted" });
  }
  return getAttempt(db, userId, id);
}

// ---------------------------------------------------------------- pipeline sync

/**
 * After a verified submission: Applied through changeStatus (append-only event with the attempt
 * reference), and the application records the resume that was actually uploaded.
 */
export async function syncApplied(db: Db, userId: string, r: AttemptRow) {
  if (r.state !== "submitted_verified") return;
  const { application } = await loadSavedJob(db, userId, r.savedJobId);
  let appId = application?.id ?? null;
  const doc = r.resumeDocumentId ? await db.query.documents.findFirst({ where: eq(documents.id, r.resumeDocumentId) }) : null;
  const docUsable = !!doc && !doc.deletedAt && doc.sha256 === r.resumeSha256;
  if (!application) {
    const res = await changeStatus(db, userId, r.savedJobId, "applied", {
      occurredAt: r.confirmedAt ?? now(),
      appliedVia: `Career Atlas automation${r.ats ? ` (${r.ats === "greenhouse" ? "Greenhouse" : r.ats === "lever" ? "Lever" : r.ats})` : ""}`,
      resumeDocumentId: docUsable ? doc.id : null,
      metadata: { via: "automation", attempt_id: r.id, ats: r.ats, confirmation: r.confirmationSource, resume_sha256: r.resumeSha256, resume_file_name: r.resumeFileName },
    });
    appId = res.applicationId;
  }
  if (appId) {
    if (docUsable) await db.insert(applicationDocuments).values({ applicationId: appId, documentId: doc.id, role: "resume", createdAt: now() }).onConflictDoNothing();
    await db.update(applicationAttempts).set({ applicationId: appId, updatedAt: now() }).where(eq(applicationAttempts.id, r.id));
  }
}
