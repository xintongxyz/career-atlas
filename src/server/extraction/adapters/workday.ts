import { htmlToText } from "../html";
import { cand, mapEmploymentType, type CandidateSet } from "../jsonld";
import type { Adapter } from "./types";

interface WorkdayResponse {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    timeType?: string;
    startDate?: string;
    jobReqId?: string;
    externalUrl?: string;
    remoteType?: string;
    country?: { descriptor?: string };
  };
  hiringOrganization?: { name?: string };
}

const S = "ats_api" as const;
const ev = (k: string, v: unknown) => `Workday API ${k}: ${JSON.stringify(v).slice(0, 300)}`;

// Uses the public JSON endpoint that Workday career sites themselves call.
export const workdayAdapter: Adapter = {
  name: "workday",
  matches: (info) => info.platform === "workday" && !!info.meta.host && !!info.meta.site && !!info.meta.jobPath,
  async fetch(info, fetchJson) {
    const apiUrl = `https://${info.meta.host}/wday/cxs/${encodeURIComponent(info.meta.tenant)}/${encodeURIComponent(info.meta.site)}/job/${info.meta.jobPath}`;
    const res = (await fetchJson(apiUrl)) as WorkdayResponse | null;
    const p = res?.jobPostingInfo;
    if (!p?.title) {
      if (res === null) {
        return { adapter: "workday", fields: { posting_status: cand("closed", S, "Workday API: posting not found (404)", "low") }, descriptionText: null, sourceTitle: null, structured: null, apiUrl, closed: true };
      }
      return null;
    }
    const f: CandidateSet = {};
    f.title = cand(p.title.trim(), S, ev("title", p.title), "high");
    if (res?.hiringOrganization?.name) f.company_name = cand(res.hiringOrganization.name, S, ev("hiringOrganization", res.hiringOrganization), "high");
    if (p.location) {
      const parts = p.location.split(/[,-]/).map((s) => s.trim()).filter(Boolean);
      if (parts[0] && !/remote/i.test(parts[0])) f.city = cand(parts[0], S, ev("location", p.location), "low");
    }
    if (p.country?.descriptor) f.country = cand(p.country.descriptor, S, ev("country", p.country), "high");
    if (p.additionalLocations?.length) f.additional_locations = cand(p.additionalLocations, S, ev("additionalLocations", p.additionalLocations), "high");
    if (p.timeType) f.employment_type = cand(mapEmploymentType(p.timeType), S, ev("timeType", p.timeType), "medium");
    const rt = p.remoteType?.toLowerCase() ?? "";
    if (rt.includes("hybrid")) f.work_mode = cand("hybrid", S, ev("remoteType", p.remoteType), "high");
    else if (rt.includes("remote")) f.work_mode = cand("remote", S, ev("remoteType", p.remoteType), "high");
    else if (rt.includes("site") || rt.includes("office")) f.work_mode = cand("onsite", S, ev("remoteType", p.remoteType), "high");
    const start = Date.parse(p.startDate ?? "");
    if (Number.isFinite(start)) f.posted_at = cand(start, S, ev("startDate", p.startDate), "medium");
    f.posting_status = cand("open", S, ev("jobReqId", p.jobReqId), "high");
    const descriptionText = p.jobDescription ? htmlToText(p.jobDescription) : null;
    return { adapter: "workday", fields: f, descriptionText, sourceTitle: p.title, structured: { ...p, jobDescription: undefined }, apiUrl };
  },
};
