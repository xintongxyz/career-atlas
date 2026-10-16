// Automated applications: attempt lifecycle, safety checks and pipeline synchronisation.
//
// The worker (src/local/apply) does the browser work; everything that decides what is allowed
// lives here so it is the same for the API and the worker:
//   - one blocking attempt per job; an uncertain submission must be resolved by the user first
//   - the resume is pinned (document id + sha256 + name + size) and never substituted
//   - "Applied" is set only through changeStatus, after a verified confirmation
import {
  BLOCKING_ATTEMPT_STATES,
  classificationUrl,
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
import { conceptsOf, norm, yesNoOf } from "@shared/apply-semantic";
import { emptyProfile, profileSchema, type Profile } from "@shared/profile";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import type { AppEnv } from "../env";
import { detectPlatform } from "../extraction/platforms";
import { ApiError, conflict, notFound } from "../lib/errors";
import { chunk, newId, now, sha256Hex } from "../lib/util";
import { changeStatus, loadSavedJob } from "./pipeline";
import { getProfileRow, profileForMatching } from "./profile";

const { applicationAttempts, documents, applicationDocuments, userProfiles, jobPostings, companies } = schema;

const EMPLOYER_SCOPED = new Set(["prior_employment", "prior_application", "prior_interview", "prior_contractor", "prior_affiliate", "referral", "current_employee", "relative_employee"]);
const YES_NO_KEYS: Record<string, keyof Profile["application_defaults"]> = {
  prior_contractor: "prior_contractor",
  prior_affiliate: "prior_affiliate",
  referral: "referral",
  contact_employer: "contact_employer",
  relocation: "relocation",
  travel: "travel",
  shift_work: "shift_work",
  age_18: "age_18",
  enrolled_student: "enrolled_student",
  full_time_student: "full_time_student",
  coop_program: "coop_program",
  coop_term_required: "coop_term_required",
  internship_mandatory: "internship_mandatory",
  return_to_school: "return_to_school",
  sponsorship_now: "sponsorship_now",
  sponsorship_future: "sponsorship_future",
};
const TEXT_KEYS: Record<string, keyof Profile["application_defaults"]> = { notice_period: "notice_period", salary: "salary_expectation", hourly_rate: "hourly_expectation", source: "source" };

/** Saves a remembered answer as a structured Application Default when its meaning is one. */
function rememberByMeaning(profile: Profile, q: PendingQuestion, answer: unknown, employer: string | null): boolean {
  const d = profile.application_defaults as Record<string, unknown> & Profile["application_defaults"];
  const m = q.meaning ?? "";
  if (m === "identity") return false; // exact-question only (opt-in, deletable)
  if (m === "phone_type") {
    const c = conceptsOf("phone_type", String(answer))[0];
    if (c !== "mobile" && c !== "home" && c !== "work") return false;
    d.phone_type = c;
    return true;
  }
  if (m === "prior_employment") {
    const yn = yesNoOf(answer);
    if (!yn || !employer) return false;
    // Per employer: the general default stays as set in My Profile.
    d.prior_employment_exceptions = [...d.prior_employment_exceptions.filter((e) => norm(e.employer) !== norm(employer)), { employer, answer: yn }];
    return true;
  }
  if (YES_NO_KEYS[m]) {
    const yn = yesNoOf(answer);
    if (!yn) return false;
    d[YES_NO_KEYS[m]] = yn as never;
    return true;
  }
  if (m === "start_date" && typeof answer === "string" && /^\d{4}-\d{2}-\d{2}$/.test(answer)) return (d.start_date = answer), true;
  if (m === "graduation_date" && typeof answer === "string" && /^\d{4}(-\d{2})?$/.test(answer)) return (d.expected_graduation = answer), true;
  // Time-sensitive: stored with today's date, reused only while fresh.
  if (m === "recruiting_deadline" && typeof answer === "string" && answer.trim()) return (d.recruiting_deadline = { answer: answer.trim().slice(0, 500), as_of: new Date().toISOString().slice(0, 10) }), true;
  if (TEXT_KEYS[m] && typeof answer === "string" && answer.trim()) return (d[TEXT_KEYS[m]] = answer.trim().slice(0, 200) as never), true;
  return false;
}
/** Education start dates answered per school (a month and a year question, or one date) → "YYYY-MM". */
export function educationStarts(questions: PendingQuestion[], answers: Record<string, unknown>): { entry: string; start: string }[] {
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const byEntry = new Map<string, { month?: number; year?: number }>();
  for (const q of questions) {
    if (q.meaning !== "education_start" || !q.entry || answers[q.key] === undefined) continue;
    const v = String(answers[q.key]).trim();
    const cur = byEntry.get(q.entry) ?? {};
    const full = v.match(/^(\d{4})-(\d{1,2})/);
    if (full) {
      cur.year = Number(full[1]);
      cur.month = Number(full[2]);
    } else if (/year/i.test(q.label) && /^\d{4}$/.test(v)) cur.year = Number(v);
    else if (/month/i.test(q.label)) {
      const i = MONTHS.findIndex((m) => m.startsWith(v.toLowerCase().slice(0, 3)));
      const n = i >= 0 ? i + 1 : Number(v);
      if (n >= 1 && n <= 12) cur.month = n;
    }
    byEntry.set(q.entry, cur);
  }
  return [...byEntry].filter(([, d]) => d.year && d.month).map(([entry, d]) => ({ entry, start: `${d.year}-${String(d.month).padStart(2, "0")}` }));
}

export type AttemptRow = typeof applicationAttempts.$inferSelect;

// Sites whose terms rule out automation stay manual. Everything else is tried by the generic flow
// (Ashby, SmartRecruiters, iCIMS, Dayforce, custom sites): it works from what the page shows.
const MANUAL_PLATFORMS = new Set(["linkedin"]);
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
  const p = detectPlatform(classificationUrl(url, allowLoopback)).platform;
  // Workday career sites (*.myworkdayjobs.com, *.myworkdaysite.com). Company-branded Workday portals
  // on other domains are recognised on the page ("detect").
  if (p === "workday") return { ats: "workday", supported: true, mode: "adapter", url };
  // Indeed listings: the user clicks Apply in a visible window; Career Atlas follows to the
  // employer's form, or assists with an Indeed-hosted application. Indeed itself is never automated.
  if (p === "indeed") return { ats: "indeed", supported: true, mode: "indeed", url };
  // Greenhouse boards, and Greenhouse embedded on a company site (?gh_jid=…).
  if (p === "greenhouse") return { ats: "greenhouse", supported: true, mode: "adapter", url };
  if (p === "lever" && /^jobs(\.eu)?\.lever\.co$/.test(u.hostname)) return { ats: "lever", supported: true, mode: "adapter", url };
  if (MANUAL_PLATFORMS.has(p)) return { ats: p, supported: false, mode: "manual", url };
  // Unknown site: the worker looks for a Workday/Greenhouse/Lever form and stops without filling otherwise.
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
    source_url: r.sourceUrl,
    route: (r.route as AttemptDTO["route"]) ?? null,
    entry_mode: (r.entryMode as AttemptDTO["entry_mode"]) ?? null,
    account_mode: (r.accountMode as AttemptDTO["account_mode"]) ?? null,
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
    answered: Object.entries((r.answers as Record<string, unknown> | null) ?? {})
      .filter(([k]) => !k.startsWith("__")) // __labels, __generated: internal (generated answers are listed from `filled`)
      .map(([key, value]) => ({ key, label: ((r.answers as Record<string, unknown>).__labels as Record<string, string> | undefined)?.[key] ?? key, value: value as string | string[] | boolean })),
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
  // An employer form found behind the listing by an earlier attempt (e.g. Indeed → Workday).
  const resolved = rows.find((r) => r.sourceUrl && r.targetUrl !== r.sourceUrl && r.route !== "indeed_apply");
  return {
    support: { ...support, resolved_url: resolved?.targetUrl ?? null },
    resumes: docs.map((d) => ({ id: d.id, version_name: d.versionName, file_name: d.fileName, mime_type: d.mimeType, size_bytes: d.sizeBytes, created_at: d.createdAt, notes: d.notes, uploadable: UPLOADABLE_RESUME_TYPES.includes(d.mimeType) })),
    default_resume_id: preferred,
    profile_check: profileCheck(profile?.profile ?? null),
    attempts,
    blocked_by: blocking ? blocking.state : application ? "already_applied" : null,
    worker: env.APPLY ? env.APPLY.status() : { available: false, browser: null, reason: "not_configured" },
    account: support.ats === "workday" && env.APPLY && support.url ? await env.APPLY.accountStatus(support.url, profile?.profile.contact.email ?? null) : null,
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

export async function startAttempt(db: Db, env: AppEnv, userId: string, savedJobId: string, body: { resume_document_id: string; submit_mode: "auto" | "review"; target_url?: string; indeed_window?: boolean; entry_mode?: "autofill" | "manual"; account_mode?: "none" | "sign_in" | "create" }) {
  if (!env.APPLY) throw new ApiError(503, "automation_unavailable", "Application automation is not available");
  const worker = env.APPLY.status();
  if (!worker.available) throw new ApiError(503, "automation_unavailable", worker.reason ?? "No browser available");
  const { saved, posting, application } = await loadSavedJob(db, userId, savedJobId);
  if (saved.archivedAt) throw conflict("job_archived", "Restore the job before applying");
  if (application) throw conflict("already_applied", "This job already has an application");
  const jobUrl = posting.applyUrl || posting.originalUrl || posting.canonicalUrl;
  const jobSupport = supportFor(jobUrl, env.APPLY.allowLoopback);
  // Where the form actually is. The job keeps its original URL (e.g. the Indeed listing); the
  // employer's application URL is stored on the attempt.
  let support = jobSupport;
  let sourceUrl: string | null = null;
  let route: AttemptDTO["route"] = "adapter";
  let visible = 0;
  if (body.target_url) {
    support = supportFor(body.target_url, env.APPLY.allowLoopback);
    if (!support.supported || (support.mode !== "adapter" && support.mode !== "detect")) throw conflict("unsupported_site", "This application link is not a supported employer form");
    if (body.target_url !== jobUrl) sourceUrl = jobUrl;
    route = jobSupport.mode === "indeed" ? "indeed_company_site" : "adapter";
  } else if (jobSupport.mode === "indeed") {
    // Indeed is never automated: the user clicks Apply in a visible window and Career Atlas follows.
    if (!body.indeed_window) throw new ApiError(422, "indeed_needs_link_or_window", "Paste the employer's application link, or open the Indeed listing in a window");
    sourceUrl = jobUrl;
    route = null; // decided when the user's click lands on the employer's site or on Indeed Apply
    visible = 1;
  }
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
    sourceUrl,
    route,
    visible,
    entryMode: body.entry_mode ?? "autofill",
    accountMode: body.account_mode ?? "none",
    ats: support.ats === "indeed" ? null : support.ats,
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
  // Labels are kept with the answers (local only) so Review can list "question → your answer".
  const labels = { ...((answers.__labels as Record<string, string> | undefined) ?? {}) };
  for (const [k, v] of Object.entries(body.answers)) {
    if (!known.has(k) || v === "" || v === null) continue;
    answers[k] = v;
    labels[k] = known.get(k)!.label.slice(0, 300);
  }
  answers.__labels = labels;
  // A missing education start date answered for a school is that school's fact: saved to its entry.
  const starts = educationStarts(questions, answers);
  if (starts.length) {
    const row = await getProfileRow(db, userId);
    const parsed = profileSchema.safeParse(row?.data ?? {});
    if (row && parsed.success) {
      const profile = parsed.data;
      let changed = false;
      for (const s of starts) {
        const e = profile.education.find((x) => x.institution && norm(x.institution) === norm(s.entry) && !x.start);
        if (e) {
          e.start = s.start;
          changed = true;
        }
      }
      if (changed) await db.update(userProfiles).set({ data: profileSchema.parse(profile) as unknown as Record<string, unknown>, updatedAt: now() }).where(eq(userProfiles.userId, userId));
    }
  }
  // Remember only what the user explicitly ticked, keyed by the exact question text.
  if (body.remember.length) {
    const row = await getProfileRow(db, userId);
    const parsed = profileSchema.safeParse(row?.data ?? {});
    const profile = parsed.success ? parsed.data : emptyProfile();
    const posting = await db.query.jobPostings.findFirst({ where: eq(jobPostings.id, r.jobPostingId) });
    const company = posting ? await db.query.companies.findFirst({ where: eq(companies.id, posting.companyId) }) : null;
    for (const k of body.remember) {
      const q = known.get(k);
      if (!q || answers[k] === undefined || q.rememberable === false) continue;
      // By meaning where it is a structured Application Default; otherwise the exact question text.
      if (!rememberByMeaning(profile, q, answers[k], company?.name ?? null)) {
        const employerScoped = !!q.meaning && EMPLOYER_SCOPED.has(q.meaning);
        const list = profile.saved_answers.filter((s) => !(s.question.trim().toLowerCase() === q.label.trim().toLowerCase() && (s.employer ?? null) === (employerScoped ? company?.name ?? null : null)));
        list.push({ question: q.label, answer: answers[k] as string, created_at: now(), employer: employerScoped ? company?.name ?? null : null });
        profile.saved_answers = list;
      }
    }
    const clean = profileSchema.safeParse(profile).success ? profileSchema.parse(profile) : profileSchema.parse({ ...profile, application_defaults: (parsed.success ? parsed.data : emptyProfile()).application_defaults });
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
  // Also for applications the user completed themselves (Indeed Apply, unsupported employer sites).
  const userCompleted = r.state === "needs_review" && ["confirm_result", "indeed_apply_assisted", "employer_site_manual"].includes(r.intervention ?? "");
  if (!userCompleted) requireState(r, ["submission_unconfirmed"]);
  const ts = now();
  if (outcome === "submitted") {
    await updateAttempt(db, id, { state: "submitted_verified", confirmationSource: "user", confirmedAt: ts, finishedAt: ts, intervention: null, questions: [] }, { code: "user_confirmed" });
    await syncApplied(db, userId, await getAttemptRow(db, userId, id));
  } else {
    await updateAttempt(db, id, { state: "failed", errorCode: "user_reported_not_submitted", finishedAt: ts, intervention: null, questions: [] }, { code: "user_reported_not_submitted" });
  }
  return getAttempt(db, userId, id);
}

// ---------------------------------------------------------------- pipeline sync

const ATS_NAMES: Record<string, string> = { workday: "Workday", greenhouse: "Greenhouse", lever: "Lever" };
function appliedVia(r: AttemptRow) {
  if (r.route === "indeed_apply") return "Indeed Apply (completed by you, tracked by Career Atlas)";
  const ats = r.ats ? ATS_NAMES[r.ats] ?? r.ats : null;
  if (r.route === "employer_manual") return "Employer site (completed by you, tracked by Career Atlas)";
  const base = `Career Atlas automation${ats ? ` (${ats})` : ""}`;
  return r.route === "indeed_company_site" ? `${base} via Indeed` : base;
}

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
      appliedVia: appliedVia(r),
      resumeDocumentId: docUsable ? doc.id : null,
      metadata: { via: r.route === "indeed_apply" || r.route === "employer_manual" ? "assisted" : "automation", route: r.route, source_url: r.sourceUrl, attempt_id: r.id, ats: r.ats, confirmation: r.confirmationSource, resume_sha256: r.resumeSha256, resume_file_name: r.resumeFileName },
    });
    appId = res.applicationId;
  }
  if (appId) {
    if (docUsable) await db.insert(applicationDocuments).values({ applicationId: appId, documentId: doc.id, role: "resume", createdAt: now() }).onConflictDoNothing();
    await db.update(applicationAttempts).set({ applicationId: appId, updatedAt: now() }).where(eq(applicationAttempts.id, r.id));
  }
}
