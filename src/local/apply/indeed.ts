// Indeed: which kind of page a URL is. Career Atlas never clicks, types or reads form content on
// Indeed (its terms forbid automating Indeed Apply and automated access); it only looks at the
// address of the page the USER opened in the visible window, to follow them to the employer's
// application form ("Apply on company site") or to recognise an Indeed-hosted application.
//
// Ported to TypeScript from jiyaa8800/indeed-auto-apply-bot (MIT, © 2026 Jiya Grover):
// indeed/domains.py (INDEED_OWNED_SUFFIXES, is_indeed_owned_host, is_external_employer_url) and the
// URL rules of indeed/page_state.py (classify_url) and indeed/apply.py (_classify_destination).
// Changes: one classifier returning a single kind; the confirmation rule is limited to the Indeed
// Apply host (a generic "thank" path on indeed.com is not treated as a submission). See
// THIRD_PARTY_NOTICES.md.

const INDEED_OWNED_SUFFIXES = [
  "indeed.com",
  "indeed.ae",
  "indeed.com.br",
  "indeed.ca",
  "indeed.cl",
  "indeed.co.in",
  "indeed.co.uk",
  "indeed.de",
  "indeed.es",
  "indeed.fr",
  "indeed.hk",
  "indeed.ie",
  "indeed.it",
  "indeed.com.mx",
  "indeed.nl",
  "indeed.com.pe",
  "indeed.com.ph",
  "indeed.pt",
  "indeed.com.sg",
  "indeed.ch",
  "indeed.com.tw",
];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\.+/, "");
  } catch {
    return "";
  }
};

export function isIndeedOwnedHost(host: string): boolean {
  const h = host.toLowerCase();
  return INDEED_OWNED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export const isIndeedUrl = (url: string) => isIndeedOwnedHost(hostOf(url));

export type IndeedPage =
  | "job_page" // viewjob / search page with a job key
  | "indeed_apply" // Indeed-hosted application (smartapply)
  | "indeed_apply_confirmation" // Indeed Apply's post-apply page
  | "sign_in" // secure.indeed.com auth / login
  | "verification" // bot check — only the user can pass it
  | "indeed_other"
  | "external" // left Indeed: the employer's site
  | "blank";

export function classifyIndeedUrl(url: string): IndeedPage {
  if (!url || url === "about:blank") return "blank";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "blank";
  }
  if (!/^https?:$/.test(u.protocol)) return "blank";
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const query = u.search.toLowerCase();
  if (/bot-detection/.test(query) || /bot-detection/.test(path)) return "verification";
  if (!isIndeedOwnedHost(host)) return "external";
  if (host.includes("smartapply") || path.includes("indeedapply")) {
    return /post-apply/.test(path) ? "indeed_apply_confirmation" : "indeed_apply";
  }
  if (host.startsWith("secure.indeed") && (/\/auth/.test(path) || /\/account\/login/.test(path) || /passport/.test(path))) return "sign_in";
  if (path.includes("/viewjob") || ((u.searchParams.has("jk") || u.searchParams.has("vjk")) && (path.includes("/jobs") || path.includes("/rc/clk") || path.includes("/pagead/clk") || path.includes("/applystart")))) return "job_page";
  return "indeed_other";
}

/** Indeed's stable job key (jk / vjk), used to recognise the same listing. */
export function indeedJobKey(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("jk") ?? u.searchParams.get("vjk");
  } catch {
    return null;
  }
}
