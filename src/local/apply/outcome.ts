// What a page is showing, decided from observable signals only (pure, unit-tested).
//
// A click on Submit proves nothing. "Verified" needs a confirmation the site itself shows: the
// ATS's confirmation URL, or an explicit success message after the application form is gone.
// Anything in between is "unconfirmed" and is never retried automatically.

export interface PageSignals {
  url: string;
  title: string;
  hasForm: boolean;
  formVisible: boolean;
  challenge: boolean;
  password: boolean;
  errors: string[];
  invalid: number;
  text: string;
  greenhouseIframe: string | null;
  greenhouseForm: boolean;
  leverForm: boolean;
}

export type Ats = "greenhouse" | "lever";

export function atsFromUrl(raw: string): Ats | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)greenhouse\.io$/.test(host)) return "greenhouse";
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) return "lever";
  return null;
}

export function atsFromSignals(s: Pick<PageSignals, "url" | "greenhouseForm" | "leverForm">): Ats | null {
  return atsFromUrl(s.url) ?? (s.greenhouseForm ? "greenhouse" : s.leverForm ? "lever" : null);
}

/** The page that holds the application form, for a posting URL. */
export function applicationUrl(ats: Ats, raw: string): string {
  const u = new URL(raw);
  if (ats === "lever") {
    // jobs.lever.co/<company>/<uuid>[/apply]
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) u.pathname = `/${parts[0]}/${parts[1]}/apply`;
  }
  return u.toString();
}

const SUCCESS_TEXT = [
  /thank you for (applying|your application|your interest)/i,
  /thanks for applying/i,
  /application (has been |was )?(successfully )?(submitted|received|sent)/i,
  /(we('ve| have)|we) received your application/i,
  /your application (is|has been) (on its way|in)/i,
];

export function successSentence(text: string): string | null {
  for (const re of SUCCESS_TEXT) {
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, text.lastIndexOf(".", m.index) + 1);
      const end = text.indexOf(".", m.index + m[0].length);
      return text.slice(start, end === -1 ? Math.min(text.length, m.index + 200) : end + 1).trim().slice(0, 300);
    }
  }
  return null;
}

export function confirmationUrl(ats: Ats | null, url: string): boolean {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (ats === "greenhouse") return /\/confirmation\/?$/.test(path);
  if (ats === "lever") return /\/thanks\/?$/.test(path);
  return /\/(confirmation|thanks|thank-you|application-submitted)\/?$/.test(path);
}

export type Outcome =
  | { kind: "verified"; text: string | null; url: string }
  | { kind: "validation_errors"; errors: string[] }
  | { kind: "challenge" }
  | { kind: "email_code" }
  | { kind: "pending" };

/**
 * Classifies the page after Submit was clicked. `posted` = a form submission request was seen.
 * The caller keeps polling while "pending" and treats a final "pending" as unconfirmed.
 */
export function classifyAfterSubmit(ats: Ats | null, s: PageSignals, posted: boolean): Outcome {
  const sentence = successSentence(s.text);
  const urlOk = confirmationUrl(ats, s.url);
  if (urlOk && (sentence || !s.formVisible)) return { kind: "verified", text: sentence, url: stripQuery(s.url) };
  if (sentence && !s.formVisible) return { kind: "verified", text: sentence, url: stripQuery(s.url) };
  if (/(security|verification) code|code (was|has been) sent|enter the code/i.test(s.text) && !sentence) return { kind: "email_code" };
  if (s.challenge) return { kind: "challenge" };
  // Errors next to a still-visible form, and no submission request: the site rejected it locally.
  if (!posted && s.formVisible && (s.errors.length || s.invalid)) return { kind: "validation_errors", errors: s.errors.slice(0, 10).map((e) => e.slice(0, 200)) };
  return { kind: "pending" };
}

export const stripQuery = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return u.slice(0, 300);
  }
};
