import { htmlToText } from "../html";
import { cand, mapEmploymentType, type CandidateSet } from "../jsonld";
import type { Adapter } from "./types";

interface LeverPosting {
  id: string;
  text: string;
  categories?: { commitment?: string; department?: string; location?: string; team?: string; allLocations?: string[] };
  workplaceType?: string;
  country?: string;
  descriptionPlain?: string;
  description?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  salaryRange?: { currency?: string; interval?: string; min?: number; max?: number };
  salaryDescriptionPlain?: string;
}

const S = "ats_api" as const;
const ev = (k: string, v: unknown) => `Lever API ${k}: ${JSON.stringify(v).slice(0, 300)}`;

export const leverAdapter: Adapter = {
  name: "lever",
  matches: (info) => info.platform === "lever" && !!info.meta.company && !!info.externalId,
  async fetch(info, fetchJson) {
    const host = info.meta.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    const apiUrl = `https://${host}/v0/postings/${encodeURIComponent(info.meta.company)}/${info.externalId}`;
    const p = (await fetchJson(apiUrl)) as LeverPosting | null;
    if (!p) {
      return { adapter: "lever", fields: { posting_status: cand("closed", S, "Lever API: posting not found (404)", "medium") }, descriptionText: null, sourceTitle: null, structured: null, apiUrl, closed: true };
    }
    const f: CandidateSet = {};
    f.title = cand(p.text.trim(), S, ev("text", p.text), "high");
    const c = p.categories ?? {};
    if (c.commitment) f.employment_type = cand(mapEmploymentType(c.commitment), S, ev("categories.commitment", c.commitment), "high");
    if (c.department || c.team) f.department = cand(c.team ?? c.department, S, ev("categories", { department: c.department, team: c.team }), "high");
    if (c.location) {
      const parts = c.location.split(",").map((s) => s.trim());
      if (!/remote/i.test(parts[0])) f.city = cand(parts[0], S, ev("categories.location", c.location), "medium");
      if (parts[1]) f.region = cand(parts[1], S, ev("categories.location", c.location), "low");
    }
    if (c.allLocations && c.allLocations.length > 1) f.additional_locations = cand(c.allLocations.slice(1), S, ev("categories.allLocations", c.allLocations), "high");
    if (p.country) f.country = cand(p.country, S, ev("country", p.country), "high");
    const wt = p.workplaceType?.toLowerCase();
    if (wt === "remote" || wt === "hybrid" || wt === "onsite") f.work_mode = cand(wt, S, ev("workplaceType", p.workplaceType), "high");
    if (p.createdAt) f.posted_at = cand(p.createdAt, S, ev("createdAt", p.createdAt), "medium");
    if (p.salaryRange && (p.salaryRange.min || p.salaryRange.max)) {
      const iv = (p.salaryRange.interval ?? "").toLowerCase();
      const period = iv.includes("hour") ? "hourly" : iv.includes("month") ? "monthly" : iv.includes("year") ? "annually" : iv.includes("week") ? "weekly" : iv.includes("day") ? "daily" : "unknown";
      f.salary = cand(
        { min: p.salaryRange.min ?? null, max: p.salaryRange.max ?? null, currency: p.salaryRange.currency?.toUpperCase() ?? null, period, source: "employer", text: p.salaryDescriptionPlain?.slice(0, 300) ?? null, compensation_type: null },
        S,
        ev("salaryRange", p.salaryRange),
        "high",
      );
    }
    for (const list of p.lists ?? []) {
      const items = htmlToText(list.content)
        .split("\n")
        .map((s) => s.replace(/^•\s*/, "").trim())
        .filter((s) => s.length > 2);
      const h = list.text.toLowerCase();
      const key = /nice|preferred|bonus|plus/.test(h)
        ? "preferred_qualifications"
        : /require|qualif|you have|looking for|about you|bring|who you are/.test(h)
          ? "required_qualifications"
          : /responsib|you('| wi)ll do|role|day|duties/.test(h)
            ? "responsibilities"
            : /benefit|perk|offer/.test(h)
              ? "benefits"
              : null;
      if (key && items.length && !f[key]) f[key] = cand(items, S, `Lever list "${list.text}": ${items[0]}`, "high");
    }
    f.posting_status = cand("open", S, ev("hostedUrl", p.hostedUrl), "high");
    const sections = [p.descriptionPlain ?? (p.description ? htmlToText(p.description) : ""), ...(p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`), p.additionalPlain ?? ""];
    const descriptionText = sections.filter(Boolean).join("\n\n").trim() || null;
    return { adapter: "lever", fields: f, descriptionText, sourceTitle: p.text, structured: { ...p, description: undefined, descriptionPlain: undefined, lists: undefined }, apiUrl };
  },
};
