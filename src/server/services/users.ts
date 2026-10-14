import { comparisonPrefsSchema, type ComparisonPrefs } from "@shared/schemas";
import type { MeDTO } from "@shared/types";
import { eq } from "drizzle-orm";
import { getAiProvider } from "../ai/provider";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import type { AppEnv, CurrentUser } from "../env";
import { newId, now } from "../lib/util";

const { users, userPreferences } = schema;

/** Maps a verified identity to a local user row (auto-provisioned on first login). */
export async function ensureUser(db: Db, email: string): Promise<CurrentUser> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  const ts = now();
  if (existing) {
    if (!existing.lastSeenAt || ts - existing.lastSeenAt > 3600_000) {
      await db.update(users).set({ lastSeenAt: ts }).where(eq(users.id, existing.id));
    }
    return { id: existing.id, email: existing.email };
  }
  const id = newId();
  await db.insert(users).values({ id, email, createdAt: ts, lastSeenAt: ts }).onConflictDoNothing();
  const row = await db.query.users.findFirst({ where: eq(users.email, email) });
  await db.insert(userPreferences).values({ userId: row!.id, updatedAt: ts }).onConflictDoNothing();
  return { id: row!.id, email: row!.email };
}

export async function getPreferences(db: Db, userId: string): Promise<MeDTO["preferences"]> {
  const p = await db.query.userPreferences.findFirst({ where: eq(userPreferences.userId, userId) });
  const comparison: ComparisonPrefs = comparisonPrefsSchema.parse(p?.comparisonJson ?? {});
  return {
    locale: (p?.locale === "zh-CN" ? "zh-CN" : "en") as MeDTO["preferences"]["locale"],
    timezone: p?.timezone ?? "America/Toronto",
    default_follow_up_days: p?.defaultFollowUpDays ?? 7,
    comparison,
  };
}

export async function updatePreferences(
  db: Db,
  userId: string,
  patch: { locale?: string; timezone?: string; default_follow_up_days?: number; comparison?: ComparisonPrefs },
) {
  const set: Partial<typeof userPreferences.$inferInsert> = { updatedAt: now() };
  if (patch.locale) set.locale = patch.locale;
  if (patch.timezone) set.timezone = patch.timezone;
  if (patch.default_follow_up_days !== undefined) set.defaultFollowUpDays = patch.default_follow_up_days;
  if (patch.comparison) set.comparisonJson = patch.comparison as unknown as Record<string, unknown>;
  await db
    .insert(userPreferences)
    .values({ userId, updatedAt: now(), ...set })
    .onConflictDoUpdate({ target: userPreferences.userId, set });
  return getPreferences(db, userId);
}

export function appConfig(env: AppEnv): MeDTO["config"] {
  const maxUpload = Number(env.MAX_UPLOAD_BYTES ?? 0) || 0;
  return {
    app_env: env.APP_ENV,
    auth_mode: env.AUTH_MODE,
    ai_enabled: !!getAiProvider(env),
    ai_provider: env.AI_PROVIDER ?? "none",
    uploads_enabled: !!env.FILES && maxUpload > 0,
    queue_enabled: !!env.EXTRACTION_DISPATCH,
    demo: env.APP_ENV === "demo",
    max_upload_bytes: maxUpload,
    read_only: env.MAINTENANCE_MODE === "read_only",
  };
}

export { newId };
