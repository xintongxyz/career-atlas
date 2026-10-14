// Bilingual job content: show the AI translation for the current UI language when the job has one,
// otherwise the original text. Originals are always what gets edited, compared as evidence and saved.
import type { ContentLang } from "@shared/constants";
import type { JobListItem, JobTranslations } from "@shared/types";

const base = (l: string) => l.split("-")[0].toLowerCase();

/** True when the job's original text is already in the UI language (no translation needed). */
export function isOriginalLanguage(contentLanguage: string | null | undefined, ui: string): boolean {
  return !!contentLanguage && base(contentLanguage) === base(ui);
}

const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Returns the posting with translated descriptive fields for `lang`, and which fields were translated. */
export function localizePosting<P extends { content_language?: string | null; translations?: JobTranslations | null }>(posting: P, lang: ContentLang): { posting: P; translated: string[] } {
  const values = posting.translations?.values?.[lang];
  if (!values || isOriginalLanguage(posting.content_language, lang)) return { posting, translated: [] };
  const out: Record<string, unknown> = { ...posting };
  const translated: string[] = [];
  for (const [field, v] of Object.entries(values)) {
    // Only replace text that exists in the original; never add content the posting doesn't have.
    if (empty(v) || empty(out[field])) continue;
    out[field] = v;
    translated.push(field);
  }
  return { posting: out as P, translated };
}

/** Job title for list views in the UI language (original when no translation exists). */
export function localizedTitle(job: Pick<JobListItem, "title" | "content_language" | "title_translations">, lang: string): string {
  if (isOriginalLanguage(job.content_language, lang)) return job.title;
  return job.title_translations?.[lang as ContentLang]?.trim() || job.title;
}

/** True when the job has any AI translation for the given UI language. */
export function hasTranslation(posting: { content_language?: string | null; translations?: JobTranslations | null }, lang: ContentLang): boolean {
  return !isOriginalLanguage(posting.content_language, lang) && !!posting.translations?.values?.[lang] && Object.keys(posting.translations.values[lang]!).length > 0;
}
