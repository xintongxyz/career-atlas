import type { Salary } from "@shared/schemas";
import type { TFunction } from "i18next";

export type Lang = "en" | "zh-CN";
const DAY = 86_400_000;

export function formatDate(t: number | null | undefined, lang: Lang, tz: string, opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }) {
  if (t == null) return "";
  return new Intl.DateTimeFormat(lang, { timeZone: tz, ...opts }).format(new Date(t));
}

export function formatDateTime(t: number | null | undefined, lang: Lang, tz: string) {
  return formatDate(t, lang, tz, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatShortDate(t: number | null | undefined, lang: Lang, tz: string) {
  const sameYear = t != null && new Date(t).getFullYear() === new Date().getFullYear();
  return formatDate(t, lang, tz, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function formatRelative(t: number | null | undefined, lang: Lang, now = Date.now()) {
  if (t == null) return "";
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (abs < 60_000) return rtf.format(0, "minute");
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / 3600_000), "hour");
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), "day");
  if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), "month");
  return rtf.format(Math.round(diff / (365 * DAY)), "year");
}

export function daysBetween(a: number, b: number) {
  return Math.floor((b - a) / DAY);
}

export function formatNumber(n: number, lang: Lang, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(lang, opts).format(n);
}

export function formatPercent(v: number | null, lang: Lang) {
  if (v == null) return "—";
  return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 }).format(v);
}

function amount(n: number, lang: Lang) {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: n < 1000 ? 2 : 0 }).format(n);
}

/**
 * Human salary text, e.g. "90,000–110,000 CAD / year". The ISO currency code is
 * always explicit (a bare "$" is ambiguous) and missing currency or period is never guessed.
 */
export function formatSalary(s: Salary | null | undefined, t: TFunction, lang: Lang): string {
  if (!s || (s.min == null && s.max == null)) return s?.text ?? t("salary.notDisclosed");
  const range = s.min != null && s.max != null && s.min !== s.max ? `${amount(s.min, lang)}–${amount(s.max, lang)}` : amount((s.min ?? s.max)!, lang);
  const period = s.period && s.period !== "unknown" ? t(`salary.per.${s.period}`) : "";
  return [range, s.currency ?? "", period].filter(Boolean).join(" ").replace(" /", " /");
}

/** Converts a timestamp to the value of a <input type="date"> in the given time zone. */
export function toDateInput(t: number | null | undefined, tz: string): string {
  if (t == null) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  return p;
}

/** Timestamp for a local date (and optional time) in the given time zone. */
export function fromDateInput(value: string, tz: string, time = "12:00"): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  // Start from the UTC guess, then correct by the zone offset at that instant.
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = zoneOffsetMs(guess, tz);
  return guess - offset;
}

export function toDateTimeInput(t: number | null | undefined, tz: string): string {
  if (t == null) return "";
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function fromDateTimeInput(value: string, tz: string): number | null {
  if (!value) return null;
  const [date, time] = value.split("T");
  return fromDateInput(date, tz, time ?? "12:00");
}

function zoneOffsetMs(t: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Y/M/D of a timestamp in a zone (for calendar grids). */
export function zonedYmd(t: number, tz: string) {
  const [y, m, d] = toDateInput(t, tz).split("-").map(Number);
  return { y, m, d };
}

export function formatFileSize(bytes: number, lang: Lang) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, lang, { maximumFractionDigits: 0 })} KB`;
  return `${formatNumber(bytes / 1024 / 1024, lang, { maximumFractionDigits: 1 })} MB`;
}

export function locationText(j: { city?: string | null; region?: string | null; country?: string | null }) {
  return [j.city, j.region, j.country].filter(Boolean).join(", ");
}
