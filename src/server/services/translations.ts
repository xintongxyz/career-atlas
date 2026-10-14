// Bilingual job content: AI translations of descriptive fields, stored on the job as display-only
// text. Originals (and their evidence) are never replaced; a translation is never evidence.
import { CONTENT_LANGS, LIST_FIELDS, TRANSLATABLE_FIELDS, type ContentLang, type TranslatableField } from "@shared/constants";
import type { JobTranslations } from "@shared/types";

/** "en-US" → "en", "zh"/"zh-Hans"/"zh_CN" → "zh-CN"; other valid codes are kept; junk → null. */
export function normalizeLang(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const l = raw.trim().replace("_", "-").toLowerCase();
  if (l.startsWith("zh")) return /tw|hk|hant/.test(l) ? "zh-Hant" : "zh-CN";
  if (l.startsWith("en")) return "en";
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(l) ? l : null;
}

const LANG_KEY: Record<string, ContentLang> = { en: "en", "zh-CN": "zh-CN" };

/** Keeps only translatable fields with well-formed values, for the supported UI languages. */
export function sanitizeTranslations(raw: unknown): JobTranslations["values"] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: JobTranslations["values"] = {};
  for (const [rawLang, entries] of Object.entries(raw as Record<string, unknown>)) {
    const lang = LANG_KEY[normalizeLang(rawLang) ?? ""];
    if (!lang || !entries || typeof entries !== "object") continue;
    const clean: Partial<Record<TranslatableField, string | string[]>> = {};
    for (const f of TRANSLATABLE_FIELDS) {
      const v = (entries as Record<string, unknown>)[f];
      if ((LIST_FIELDS as readonly string[]).includes(f)) {
        const list = (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .map((x) => x.trim().slice(0, 1000))
          .slice(0, 60);
        if (list.length) clean[f] = list;
      } else if (typeof v === "string" && v.trim()) {
        clean[f] = v.trim().slice(0, 4000);
      }
    }
    if (Object.keys(clean).length) out[lang] = { ...out[lang], ...clean };
  }
  return Object.keys(out).length ? out : null;
}

/** Drops translations of fields whose original value changed (they would be stale). */
export function pruneTranslations(current: unknown, changedFields: string[]): JobTranslations | null | undefined {
  const t = current as JobTranslations | null | undefined;
  if (!t?.values) return undefined; // nothing stored: no update needed
  const changed = changedFields.filter((f) => (TRANSLATABLE_FIELDS as readonly string[]).includes(f));
  if (!changed.length) return undefined;
  const values: JobTranslations["values"] = {};
  for (const lang of CONTENT_LANGS) {
    const entries = { ...(t.values[lang] ?? {}) };
    for (const f of changed) delete entries[f as TranslatableField];
    if (Object.keys(entries).length) values[lang] = entries;
  }
  return Object.keys(values).length ? { ...t, values } : null;
}
