import { decodeEntities, htmlToText } from "../html";
import { cand, type CandidateSet } from "../jsonld";
import { parseLocationList } from "../location";
import type { Adapter } from "./types";

interface GhJob {
  id: number;
  title: string;
  company_name?: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string };
  content?: string;
  departments?: { name: string }[];
  offices?: { name: string; location?: string | null }[];
  pay_input_ranges?: { min_cents: number; max_cents: number; currency_type: string; title?: string; blurb?: string }[];
}

const S = "ats_api" as const;

export const greenhouseAdapter: Adapter = {
  name: "greenhouse",
  matches: (info) => info.platform === "greenhouse" && !!info.meta.board && !!info.externalId,
  async fetch(info, fetchJson) {
    const host = info.meta.region === "eu" ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
    const apiUrl = `https://${host}/v1/boards/${encodeURIComponent(info.meta.board)}/jobs/${info.externalId}?pay_transparency=true`;
    const job = (await fetchJson(apiUrl)) as GhJob | null;
    if (!job) {
      return { adapter: "greenhouse", fields: { posting_status: cand("closed", S, "Greenhouse API: job not found (404)", "medium") }, descriptionText: null, sourceTitle: null, structured: null, apiUrl, closed: true };
    }
    const f: CandidateSet = {};
    const ev = (k: string, v: unknown) => `Greenhouse API ${k}: ${JSON.stringify(v).slice(0, 300)}`;
    f.title = cand(job.title.trim(), S, ev("title", job.title), "high");
    if (job.company_name) f.company_name = cand(job.company_name, S, ev("company_name", job.company_name), "high");
    if (job.location?.name) {
      const loc = parseLocationList(job.location.name);
      const e = ev("location.name", job.location.name);
      if (loc.remote) f.work_mode = cand("remote", S, e, "medium");
      if (loc.primary.city) f.city = cand(loc.primary.city, S, e, "medium");
      if (loc.primary.region) f.region = cand(loc.primary.region, S, e, loc.primary.country ? "medium" : "low");
      if (loc.primary.country) f.country = cand(loc.primary.country, S, e, "medium");
      if (loc.others.length) f.additional_locations = cand(loc.others, S, e, "high");
    }
    if (job.departments?.[0]?.name) f.department = cand(job.departments[0].name, S, ev("departments", job.departments.map((d) => d.name)), "high");
    if (job.offices && job.offices.length > 1) {
      f.additional_locations = cand(job.offices.slice(1).map((o) => o.location || o.name), S, ev("offices", job.offices.map((o) => o.name)), "high");
    }
    const posted = Date.parse(job.first_published ?? "");
    if (Number.isFinite(posted)) f.posted_at = cand(posted, S, ev("first_published", job.first_published), "high");
    const pay = job.pay_input_ranges?.[0];
    if (pay && (pay.min_cents || pay.max_cents)) {
      const blurb = pay.blurb ? htmlToText(decodeEntities(pay.blurb)) : "";
      const lower = `${pay.title ?? ""} ${blurb}`.toLowerCase();
      const period = /hour/.test(lower) ? "hourly" : /month/.test(lower) ? "monthly" : /year|annual|salary/.test(lower) ? "annually" : "unknown";
      f.salary = cand(
        {
          min: pay.min_cents ? pay.min_cents / 100 : null,
          max: pay.max_cents ? pay.max_cents / 100 : null,
          currency: pay.currency_type?.toUpperCase() ?? null,
          period,
          source: "employer",
          text: pay.title ?? null,
          compensation_type: null,
        },
        S,
        ev("pay_input_ranges", pay),
        period === "unknown" ? "medium" : "high",
      );
    }
    if (job.absolute_url) f.posting_status = cand("open", S, ev("absolute_url", job.absolute_url), "high");
    const descriptionText = job.content ? htmlToText(decodeEntities(job.content)) : null;
    return { adapter: "greenhouse", fields: f, descriptionText, sourceTitle: job.title, structured: { ...job, content: undefined }, apiUrl };
  },
};
