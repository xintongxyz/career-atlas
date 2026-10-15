// Phone numbers as the applicant's phone, not as text.
//
// Four separate things: the COUNTRY the number belongs to (its calling code), the NATIONAL number,
// the canonical international form (E.164: "+" + code + national number), and the phone TYPE (mobile /
// home / work — a separate setting, never part of the number). The country comes from the saved number
// itself ("+44 …"), else the saved phone country code, else the applicant's own country — never from the
// employer's location. A form's field decides which form is typed (local digits next to a separate
// country-code control, E.164 in an international phone widget), and acceptance compares normalised
// numbers including the country code: "+61 3 5550 147" is NOT "613 555 0147" in Canada.
import { englishCountry } from "./apply-semantic";

/** Calling codes by English country name (the countries the app knows, plus common ones). */
export const CALLING_CODES: Record<string, string> = {
  Canada: "1",
  "United States": "1",
  "United Kingdom": "44",
  Australia: "61",
  "New Zealand": "64",
  Ireland: "353",
  France: "33",
  Germany: "49",
  Italy: "39",
  Spain: "34",
  Netherlands: "31",
  Switzerland: "41",
  Sweden: "46",
  China: "86",
  "Hong Kong": "852",
  Taiwan: "886",
  Japan: "81",
  "South Korea": "82",
  Singapore: "65",
  India: "91",
  Pakistan: "92",
  Philippines: "63",
  Mexico: "52",
  Brazil: "55",
  "South Africa": "27",
  Nigeria: "234",
};

/** For a calling code shared by several countries, the one used when only the code is known. */
const PRIMARY: Record<string, string> = { "1": "Canada" };

export interface CanonicalPhone {
  /** "+16135550147" */
  e164: string;
  /** Calling code digits, e.g. "1". */
  cc: string;
  /** National significant number, e.g. "6135550147" (no trunk "0"). */
  national: string;
  /** English country name the code belongs to (the applicant's own country when it shares the code). */
  country: string | null;
}

const digitsOf = (s: string) => s.replace(/\D+/g, "");
const KNOWN_CODES = [...new Set(Object.values(CALLING_CODES))].sort((a, b) => b.length - a.length);

/**
 * The applicant's phone in canonical form, or null when its country cannot be established (then the
 * number is only typed into a field that does not need a country — never guessed).
 */
export function canonicalPhone(raw: string | null | undefined, opts: { countryCode?: string | null; country?: string | null }): CanonicalPhone | null {
  // An extension is not part of the number ("… ext. 7", "… x7", "… #7").
  const text = String(raw ?? "").trim().replace(/\s*(?:,|;)?\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i, "");
  let d = digitsOf(text);
  if (d.length < 6) return null;
  const home = opts.country ? englishCountry(opts.country) : null;
  const countryFor = (cc: string) => (home && CALLING_CODES[home] === cc ? home : (PRIMARY[cc] ?? Object.keys(CALLING_CODES).find((k) => CALLING_CODES[k] === cc) ?? null));
  // Written internationally: the code is part of the number.
  if (/^(\+|00)/.test(text)) {
    if (text.startsWith("00")) d = d.slice(2);
    const cc = KNOWN_CODES.find((c) => d.startsWith(c));
    if (!cc) return null;
    return { e164: `+${d}`, cc, national: d.slice(cc.length), country: countryFor(cc) };
  }
  const cc = digitsOf(opts.countryCode ?? "") || (home ? (CALLING_CODES[home] ?? "") : "");
  if (!cc) return null;
  let national = d;
  if (cc === "1" && d.length === 11 && d.startsWith("1")) national = d.slice(1);
  else if (cc !== "1" && d.startsWith("0")) national = d.slice(1); // trunk prefix
  return { e164: `+${cc}${national}`, cc, national, country: countryFor(cc) };
}

export type PhoneLayout = "international" | "national";

/**
 * Which form a field takes: the national number next to a separate country-code control, E.164 in an
 * international widget or where the field asks for "+";
 * a plain field gets the national number for a job in the same country, else E.164.
 */
export function phoneLayout(
  field: { placeholder?: string; label?: string; phone?: { widget: "intl" | "split" | null; dial: string | null } | null },
  canon: CanonicalPhone,
  jobCountry: string | null,
): PhoneLayout {
  const w = field.phone ?? null;
  if (w?.widget === "split") return "national";
  // International widgets: always "+<code><number>" — it sets the widget's country in every mode, whereas
  // digits without "+" are re-read as an international number by some widgets (6135550147 → +61 …).
  if (w?.widget === "intl") return "international";
  const hint = `${field.placeholder ?? ""} ${field.label ?? ""}`;
  if (/^\s*\+/.test(field.placeholder ?? "") || /country code|international|include (the )?\+|e\.164/i.test(hint)) return "international";
  const job = jobCountry ? CALLING_CODES[englishCountry(jobCountry)] : undefined;
  return job === canon.cc ? "national" : "international";
}

export function phoneValue(canon: CanonicalPhone, layout: PhoneLayout): string {
  return layout === "international" ? canon.e164 : canon.national;
}

/**
 * Did the page keep THIS number? Formatting is ignored; the country is not: a value written with "+"
 * (or 00) must carry exactly this code, a country-code control or widget beside it must show this code,
 * and a value without one must be the national number (or code + national without "+").
 */
export function phoneAccepted(actual: string, canon: CanonicalPhone, dial?: string | null): boolean {
  const text = String(actual ?? "").trim();
  if (!text) return false;
  if (dial && digitsOf(dial) && digitsOf(dial) !== canon.cc) return false;
  let d = digitsOf(text);
  if (/^(\+|00)/.test(text)) {
    if (text.startsWith("00")) d = d.slice(2);
    return d === canon.cc + canon.national;
  }
  return d === canon.national || d === canon.cc + canon.national || (canon.cc !== "1" && d === `0${canon.national}`);
}
