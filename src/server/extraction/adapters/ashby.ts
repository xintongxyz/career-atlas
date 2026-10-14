import { htmlToText } from "../html";
import { cand, mapEmploymentType, type CandidateSet } from "../jsonld";
import type { Adapter } from "./types";

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  publishedAt?: string;
  isRemote?: boolean;
  workplaceType?: string;
  address?: { postalAddress?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
    summaryComponents?: { compensationType?: string; interval?: string; currencyCode?: string; minValue?: number; maxValue?: number }[];
  };
}

const S = "ats_api" as const;
const ev = (k: string, v: unknown) => `Ashby API ${k}: ${JSON.stringify(v).slice(0, 300)}`;

export const ashbyAdapter: Adapter = {
  name: "ashby",
  matches: (info) => info.platform === "ashby" && !!info.meta.org && !!info.externalId,
  async fetch(info, fetchJson) {
    const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(info.meta.org)}?includeCompensation=true`;
    const board = (await fetchJson(apiUrl)) as { jobs?: AshbyJob[] } | null;
    const job = board?.jobs?.find((j) => j.id.toLowerCase() === info.externalId);
    if (!job) {
      return { adapter: "ashby", fields: { posting_status: cand("closed", S, "Ashby job board API: posting not listed", "medium") }, descriptionText: null, sourceTitle: null, structured: null, apiUrl, closed: true };
    }
    const f: CandidateSet = {};
    f.title = cand(job.title.trim(), S, ev("title", job.title), "high");
    if (job.department || job.team) f.department = cand(job.team ?? job.department, S, ev("department", job.department), "high");
    if (job.employmentType) f.employment_type = cand(mapEmploymentType(job.employmentType), S, ev("employmentType", job.employmentType), "high");
    const addr = job.address?.postalAddress;
    if (addr?.addressLocality) f.city = cand(addr.addressLocality, S, ev("address", addr), "high");
    if (addr?.addressRegion) f.region = cand(addr.addressRegion, S, ev("address", addr), "high");
    if (addr?.addressCountry) f.country = cand(addr.addressCountry, S, ev("address", addr), "high");
    if (!addr?.addressLocality && job.location && !/remote/i.test(job.location)) f.city = cand(job.location, S, ev("location", job.location), "medium");
    if (job.secondaryLocations?.length) f.additional_locations = cand(job.secondaryLocations.map((l) => l.location), S, ev("secondaryLocations", job.secondaryLocations), "high");
    const wt = job.workplaceType?.toLowerCase().replace(/[^a-z]/g, "");
    if (wt === "remote" || wt === "hybrid" || wt === "onsite") f.work_mode = cand(wt, S, ev("workplaceType", job.workplaceType), "high");
    else if (job.isRemote) f.work_mode = cand("remote", S, ev("isRemote", true), "high");
    const posted = Date.parse(job.publishedAt ?? "");
    if (Number.isFinite(posted)) f.posted_at = cand(posted, S, ev("publishedAt", job.publishedAt), "high");
    const salary = job.compensation?.summaryComponents?.find((c) => c.compensationType === "Salary" && (c.minValue || c.maxValue));
    if (salary) {
      const iv = (salary.interval ?? "").toUpperCase();
      const period = iv.includes("HOUR") ? "hourly" : iv.includes("MONTH") ? "monthly" : iv.includes("YEAR") ? "annually" : iv.includes("WEEK") ? "weekly" : "unknown";
      f.salary = cand(
        { min: salary.minValue ?? null, max: salary.maxValue ?? null, currency: salary.currencyCode?.toUpperCase() ?? null, period, source: "employer", text: job.compensation?.compensationTierSummary ?? null, compensation_type: null },
        S,
        ev("compensation", salary),
        "high",
      );
    }
    const equity = job.compensation?.summaryComponents?.find((c) => /equity/i.test(c.compensationType ?? ""));
    if (equity) f.equity = cand(job.compensation?.compensationTierSummary ?? "Equity", S, ev("compensation.equity", equity), "medium");
    f.posting_status = cand("open", S, ev("jobUrl", job.jobUrl), "high");
    const descriptionText = job.descriptionPlain?.trim() || (job.descriptionHtml ? htmlToText(job.descriptionHtml) : null);
    return { adapter: "ashby", fields: f, descriptionText, sourceTitle: job.title, structured: { ...job, descriptionHtml: undefined, descriptionPlain: undefined }, apiUrl };
  },
};
