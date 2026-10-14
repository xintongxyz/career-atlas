// Personal profile (local only) and resume-import drafts.
import { emptyProfile, PROFILE_SECTIONS, profileSchema, type Profile, type ProfileDraft, type ProfileDraftItem, type ProfileDTO, type ProfileImportInput, type ProfileSection } from "@shared/profile";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { evidenceInSource, normalize } from "../ai/extract-job";
import { schema, type Db } from "../db/client";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { newId, now } from "../lib/util";

const { userProfiles, documents } = schema;

const LIST_SECTIONS = new Set<ProfileSection>(["work_authorization", "languages", "education", "experience", "experience_summary", "certifications", "projects", "skills"]);
/** Facts that decide eligibility: only accepted from a resume when the quote is verified. */
const SENSITIVE_SECTIONS = new Set<ProfileSection>(["work_authorization", "driver_licence", "security_clearance"]);

export async function getProfileRow(db: Db, userId: string) {
  return db.query.userProfiles.findFirst({ where: eq(userProfiles.userId, userId) });
}

/** The confirmed profile, or null when the user has not created one yet. */
export async function profileForMatching(db: Db, userId: string): Promise<{ profile: Profile; updatedAt: number } | null> {
  const row = await getProfileRow(db, userId);
  if (!row) return null;
  const parsed = profileSchema.safeParse(row.data);
  return { profile: parsed.success ? parsed.data : emptyProfile(), updatedAt: row.updatedAt };
}

export async function getProfile(db: Db, userId: string): Promise<ProfileDTO> {
  const row = await getProfileRow(db, userId);
  const parsed = row ? profileSchema.safeParse(row.data) : null;
  return {
    profile: parsed?.success ? parsed.data : emptyProfile(),
    updated_at: row?.updatedAt ?? null,
    resume_document_id: row?.resumeDocumentId ?? null,
    draft: (row?.draft as unknown as ProfileDraft | null) ?? null,
  };
}

async function upsert(db: Db, userId: string, set: Partial<typeof userProfiles.$inferInsert>) {
  const ts = now();
  const row = await getProfileRow(db, userId);
  if (row) await db.update(userProfiles).set({ ...set, updatedAt: ts }).where(eq(userProfiles.userId, userId));
  else await db.insert(userProfiles).values({ userId, data: (set.data ?? emptyProfile()) as Record<string, unknown>, draft: set.draft ?? null, resumeDocumentId: set.resumeDocumentId ?? null, createdAt: ts, updatedAt: ts });
}

export async function saveProfile(db: Db, userId: string, body: { profile: unknown; resume_document_id?: string | null }) {
  const parsed = profileSchema.safeParse(body.profile);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Invalid profile", parsed.error.issues.slice(0, 20));
  const set: Partial<typeof userProfiles.$inferInsert> = { data: parsed.data as unknown as Record<string, unknown> };
  if (body.resume_document_id !== undefined) {
    if (body.resume_document_id) {
      const d = await db.query.documents.findFirst({ where: eq(documents.id, body.resume_document_id) });
      if (!d || d.userId !== userId) throw notFound("document");
    }
    set.resumeDocumentId = body.resume_document_id;
  }
  await upsert(db, userId, set);
  return getProfile(db, userId);
}

// ---------------------------------------------------------------- resume import drafts

const itemSchema = (section: ProfileSection): z.ZodType => {
  const shape = profileSchema.shape[section] as unknown as z.ZodType & { _def: unknown };
  // List sections: validate one element; skills: a single string or a list of strings.
  if (section === "skills") return profileSchema.shape.skills;
  if (LIST_SECTIONS.has(section)) return (profileSchema.shape[section] as unknown as { unwrap(): { element: z.ZodType } }).unwrap().element;
  return shape;
};

export async function createProfileDraft(db: Db, userId: string, input: ProfileImportInput) {
  const src = input.resume_text?.trim() ? normalize(input.resume_text) : "";
  const items: ProfileDraftItem[] = [];
  const dropped: { section: string; reason: string }[] = [];
  for (const raw of input.items) {
    let value = raw.value;
    if (raw.section === "skills" && typeof value === "string") value = [value];
    const r = itemSchema(raw.section).safeParse(value);
    if (!r.success) {
      dropped.push({ section: raw.section, reason: "invalid_value" });
      continue;
    }
    const evidence = raw.evidence?.trim() ? raw.evidence.trim().slice(0, 600) : null;
    const verified = raw.basis === "resume" && !!src && evidenceInSource(evidence, src);
    let v = r.data as Record<string, unknown>;
    if (SENSITIVE_SECTIONS.has(raw.section) && !verified) {
      dropped.push({ section: raw.section, reason: "sensitive_not_verified" });
      continue;
    }
    if (raw.section === "driver_licence" && !verified) {
      // Never import a "no" from an inference.
      v = { ...v, has: v.has === false ? null : v.has, has_vehicle: v.has_vehicle === false ? null : v.has_vehicle };
    }
    items.push({ id: newId(), section: raw.section, value: v, evidence, verified });
  }
  const draft: ProfileDraft = { origin: input.origin, created_at: now(), items, dropped, notes: input.notes?.trim() || null };
  await upsert(db, userId, { draft: draft as unknown as Record<string, unknown> });
  return { items: items.length, verified: items.filter((i) => i.verified).length, dropped };
}

const keyOf = (section: ProfileSection, v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  const k = section === "languages" ? o.language : section === "work_authorization" ? o.country : section === "certifications" ? o.name : section === "projects" ? o.name : section === "experience_summary" ? o.area : JSON.stringify(v);
  return String(k ?? "").trim().toLowerCase();
};

/** Adds the accepted draft items to the profile (lists are merged, nothing existing is deleted). */
export async function acceptProfileDraft(db: Db, userId: string, itemIds: string[]) {
  const row = await getProfileRow(db, userId);
  const draft = row?.draft as unknown as ProfileDraft | null;
  if (!row || !draft) throw notFound("profile_draft");
  const profile = profileSchema.parse(row.data ?? {}) as Record<string, unknown>;
  const chosen = draft.items.filter((i) => itemIds.includes(i.id));
  if (!chosen.length && itemIds.length) throw badRequest("no_items", "Nothing selected");
  for (const it of chosen) {
    if (!PROFILE_SECTIONS.includes(it.section)) continue;
    if (it.section === "skills") {
      const have = new Set((profile.skills as string[]).map((s) => s.toLowerCase()));
      for (const s of it.value as string[]) if (!have.has(s.toLowerCase())) (profile.skills as string[]).push(s);
    } else if (LIST_SECTIONS.has(it.section)) {
      const list = profile[it.section] as unknown[];
      const k = keyOf(it.section, it.value);
      const at = ["languages", "work_authorization", "certifications", "experience_summary", "projects"].includes(it.section) ? list.findIndex((x) => keyOf(it.section, x) === k) : -1;
      if (at >= 0) list[at] = it.value; // newer statement replaces the same language/certificate/…
      else if (!list.some((x) => JSON.stringify(x) === JSON.stringify(it.value))) list.push(it.value);
    } else if (it.section === "security_clearance") {
      profile.security_clearance = it.value as string;
    } else {
      // Objects (based_in, driver_licence): only fill in what the draft states.
      const cur = (profile[it.section] ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(it.value as Record<string, unknown>)) if (v !== null && v !== undefined && v !== "") cur[k] = v;
      profile[it.section] = cur;
    }
  }
  const clean = profileSchema.parse(profile);
  await db.update(userProfiles).set({ data: clean as unknown as Record<string, unknown>, draft: null, updatedAt: now() }).where(eq(userProfiles.userId, userId));
  return getProfile(db, userId);
}

export async function discardProfileDraft(db: Db, userId: string) {
  const row = await getProfileRow(db, userId);
  if (row?.draft) await db.update(userProfiles).set({ draft: null, updatedAt: now() }).where(eq(userProfiles.userId, userId));
}
