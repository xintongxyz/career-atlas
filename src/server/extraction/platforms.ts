import type { SourcePlatform } from "@shared/constants";

export interface PlatformInfo {
  platform: SourcePlatform;
  externalId: string | null;
  /** Platform-specific identifiers needed to call public posting APIs. */
  meta: Record<string, string>;
}

// Query parameters that only carry tracking information. Anything not listed
// here is preserved, because many ATS pages need their query string
// (e.g. ?gh_jid=, ?jk=, ?jobId=, ?currentJobId=).
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "trk",
  "trkinfo",
  "trackingid",
  "refid",
  "lipi",
  "ebp",
  "recommendedflavor",
  "src",
  "ref",
  "referrer",
  "source",
  "gh_src",
  "lever-source",
  "lever-origin",
  "ashby_jid_src",
  "from",
  "vjs",
  "tk",
]);

// Params that look like tracking but identify the job on some sites.
const KEEP_EVEN_IF_TRACKING = new Set(["gh_jid", "jk", "currentjobid", "jobid", "job", "id", "token", "for", "req", "reqid", "postingid"]);

export function detectPlatform(rawUrl: string): PlatformInfo {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const qp = (k: string) => u.searchParams.get(k);

  // Greenhouse hosted boards
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    if (parts[0] === "embed" && qp("for") && qp("token")) {
      return { platform: "greenhouse", externalId: qp("token"), meta: { board: qp("for")!, region: host.includes(".eu.") ? "eu" : "" } };
    }
    const jobsIdx = parts.indexOf("jobs");
    if (jobsIdx > 0 && parts[jobsIdx + 1] && /^\d+$/.test(parts[jobsIdx + 1])) {
      return { platform: "greenhouse", externalId: parts[jobsIdx + 1], meta: { board: parts[jobsIdx - 1], region: host.includes(".eu.") ? "eu" : "" } };
    }
    return { platform: "greenhouse", externalId: qp("gh_jid"), meta: {} };
  }
  // Greenhouse embedded on a company careers site (?gh_jid=123)
  if (qp("gh_jid") && /^\d+$/.test(qp("gh_jid")!)) {
    return { platform: "greenhouse", externalId: qp("gh_jid"), meta: { embedded: "1" } };
  }
  if (/(^|\.)lever\.co$/.test(host) && host.startsWith("jobs.")) {
    if (parts[0] && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) {
      return { platform: "lever", externalId: parts[1].toLowerCase(), meta: { company: parts[0], region: host.includes(".eu.") ? "eu" : "" } };
    }
    return { platform: "lever", externalId: null, meta: {} };
  }
  if (host === "jobs.ashbyhq.com") {
    if (parts[0] && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) {
      return { platform: "ashby", externalId: parts[1].toLowerCase(), meta: { org: decodeURIComponent(parts[0]) } };
    }
    return { platform: "ashby", externalId: null, meta: {} };
  }
  if (qp("ashby_jid") && /^[0-9a-f-]{36}$/i.test(qp("ashby_jid")!)) {
    return { platform: "ashby", externalId: qp("ashby_jid")!.toLowerCase(), meta: { embedded: "1" } };
  }
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    const m = parts[1]?.match(/^(\d{6,})/);
    return { platform: "smartrecruiters", externalId: m ? m[1] : null, meta: parts[0] ? { company: parts[0] } : {} };
  }
  if (/\.myworkdayjobs\.com$/.test(host) || /\.myworkdaysite\.com$/.test(host)) {
    const tenant = host.split(".")[0];
    const jobIdx = parts.indexOf("job");
    // /{locale?}/{site}/job/{location}/{slug}_{reqId}
    const site = jobIdx > 0 ? parts[jobIdx - 1] : parts.find((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p)) ?? "";
    const last = parts[parts.length - 1] ?? "";
    const req = last.includes("_") ? last.slice(last.lastIndexOf("_") + 1) : null;
    const jobPath = jobIdx >= 0 ? parts.slice(jobIdx + 1).join("/") : "";
    return { platform: "workday", externalId: req, meta: { tenant, site, host, jobPath } };
  }
  if (host.endsWith("linkedin.com")) {
    const viewIdx = parts.indexOf("view");
    let id: string | null = qp("currentJobId");
    if (!id && parts[0] === "jobs" && viewIdx >= 0 && parts[viewIdx + 1]) {
      const m = parts[viewIdx + 1].match(/(\d{6,})\/?$/);
      id = m ? m[1] : null;
    }
    return { platform: "linkedin", externalId: id, meta: {} };
  }
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) {
    return { platform: "indeed", externalId: qp("jk") ?? qp("vjk"), meta: {} };
  }
  return { platform: "company_site", externalId: qp("jobId") ?? qp("job_id") ?? qp("id") ?? null, meta: {} };
}

/**
 * Produces a stable URL for duplicate detection without destroying the
 * identifiers a job board needs. Never used to rewrite the stored original URL.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const info = detectPlatform(rawUrl);

  if (info.platform === "linkedin" && info.externalId) return `https://www.linkedin.com/jobs/view/${info.externalId}`;
  if (info.platform === "indeed" && info.externalId) return `https://${u.hostname.replace(/^www\./, "")}/viewjob?jk=${info.externalId}`;
  if (info.platform === "greenhouse" && info.meta.board && info.externalId) {
    return `https://boards.greenhouse.io/${info.meta.board.toLowerCase()}/jobs/${info.externalId}`;
  }
  if (info.platform === "lever" && info.meta.company && info.externalId) {
    return `https://jobs.lever.co/${info.meta.company.toLowerCase()}/${info.externalId}`;
  }
  if (info.platform === "ashby" && info.meta.org && info.externalId) {
    return `https://jobs.ashbyhq.com/${encodeURIComponent(info.meta.org.toLowerCase())}/${info.externalId}`;
  }

  const kept = [...u.searchParams.entries()].filter(([k]) => {
    const key = k.toLowerCase();
    if (KEEP_EVEN_IF_TRACKING.has(key)) return true;
    return !TRACKING_PARAMS.has(key) && !key.startsWith("utm_");
  });
  kept.sort(([a], [b]) => a.localeCompare(b));
  const search = new URLSearchParams(kept).toString();
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  // Treat "/apply" suffixes as the same posting on Lever/Ashby-like pages.
  path = path.replace(/\/apply$/, "");
  return `${u.protocol}//${u.hostname.replace(/^www\./, "")}${u.port ? `:${u.port}` : ""}${path}${search ? `?${search}` : ""}`;
}

/** Best-effort company guess from a URL before any fetching happens. */
export function companyHintFromUrl(rawUrl: string): string | null {
  const info = detectPlatform(rawUrl);
  const slug = info.meta.board ?? info.meta.company ?? info.meta.org ?? info.meta.tenant;
  const pretty = (s: string) =>
    decodeURIComponent(s)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  if (slug) return pretty(slug);
  if (info.platform === "company_site") {
    if (/^[\d.]+$|:|^\[/.test(new URL(rawUrl).hostname)) return null; // IP literals carry no company name
    const host = new URL(rawUrl).hostname.replace(/^(www|careers|jobs|apply|boards)\./, "");
    const base = host.split(".")[0];
    return base ? pretty(base) : null;
  }
  return null;
}
