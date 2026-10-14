import { htmlToText } from "../html";
import { cand, mapEmploymentType, type CandidateSet } from "../jsonld";
import type { Adapter } from "./types";

interface SrPosting {
  name: string;
  company?: { name?: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { label?: string };
  function?: { label?: string };
  department?: { label?: string };
  releasedDate?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
  postingUrl?: string;
  applyUrl?: string;
}

const S = "ats_api" as const;
const ev = (k: string, v: unknown) => `SmartRecruiters API ${k}: ${JSON.stringify(v).slice(0, 300)}`;

export const smartRecruitersAdapter: Adapter = {
  name: "smartrecruiters",
  matches: (info) => info.platform === "smartrecruiters" && !!info.meta.company && !!info.externalId,
  async fetch(info, fetchJson) {
    const apiUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(info.meta.company)}/postings/${info.externalId}`;
    const p = (await fetchJson(apiUrl)) as SrPosting | null;
    if (!p) {
      return { adapter: "smartrecruiters", fields: { posting_status: cand("closed", S, "SmartRecruiters API: posting not found (404)", "medium") }, descriptionText: null, sourceTitle: null, structured: null, apiUrl, closed: true };
    }
    const f: CandidateSet = {};
    f.title = cand(p.name.trim(), S, ev("name", p.name), "high");
    if (p.company?.name) f.company_name = cand(p.company.name, S, ev("company.name", p.company.name), "high");
    const loc = p.location ?? {};
    if (loc.city) f.city = cand(loc.city, S, ev("location", loc), "high");
    if (loc.region) f.region = cand(loc.region, S, ev("location", loc), "high");
    if (loc.country) f.country = cand(loc.country.toUpperCase(), S, ev("location", loc), "high");
    if (loc.hybrid) f.work_mode = cand("hybrid", S, ev("location.hybrid", true), "high");
    else if (loc.remote) f.work_mode = cand("remote", S, ev("location.remote", true), "high");
    if (p.typeOfEmployment?.label) f.employment_type = cand(mapEmploymentType(p.typeOfEmployment.label), S, ev("typeOfEmployment", p.typeOfEmployment), "high");
    if (p.function?.label) f.category = cand(p.function.label, S, ev("function", p.function), "medium");
    if (p.department?.label) f.department = cand(p.department.label, S, ev("department", p.department), "high");
    const posted = Date.parse(p.releasedDate ?? "");
    if (Number.isFinite(posted)) f.posted_at = cand(posted, S, ev("releasedDate", p.releasedDate), "high");
    f.posting_status = cand("open", S, ev("postingUrl", p.postingUrl), "high");
    const sections = Object.values(p.jobAd?.sections ?? {}).filter((s) => s?.text);
    const descriptionText = sections.map((s) => `${s.title ?? ""}\n${htmlToText(s.text!)}`.trim()).join("\n\n") || null;
    return { adapter: "smartrecruiters", fields: f, descriptionText, sourceTitle: p.name, structured: { ...p, jobAd: undefined }, apiUrl };
  },
};
