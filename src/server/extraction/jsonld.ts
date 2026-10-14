import type { Confidence, EmploymentType, EvidenceSource, ExtractableField, SalaryPeriod } from "@shared/constants";
import type { FieldCandidate } from "@shared/types";
import { htmlToText } from "./html";

export type CandidateSet = Partial<Record<ExtractableField, FieldCandidate>>;

export function cand(value: unknown, source: EvidenceSource, evidence: string | null, confidence: Confidence): FieldCandidate {
  return { value, source, evidence: evidence ? evidence.slice(0, 600) : null, confidence };
}

const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "name" in v) return str((v as { name: unknown }).name);
  return null;
};
const arr = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const snippet = (key: string, v: unknown) => `JSON-LD ${key}: ${JSON.stringify(v).slice(0, 300)}`;

export function mapEmploymentType(raw: string): EmploymentType {
  const s = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (s.includes("full")) return "full_time";
  if (s.includes("part")) return "part_time";
  if (s.includes("intern")) return "internship";
  if (s.includes("co_op") || s.includes("coop")) return "co_op";
  if (s.includes("contract") || s.includes("contractor")) return "contract";
  if (s.includes("temp") || s.includes("per_diem") || s.includes("seasonal")) return "temporary";
  if (s.includes("freelance")) return "freelance";
  return "other";
}

export function mapSalaryUnit(raw: string | null | undefined): SalaryPeriod {
  const s = (raw ?? "").toLowerCase();
  if (s.startsWith("hour")) return "hourly";
  if (s.startsWith("day")) return "daily";
  if (s.startsWith("week")) return "weekly";
  if (s.startsWith("month")) return "monthly";
  if (s.startsWith("year") || s.startsWith("annual")) return "annually";
  return "unknown";
}

function toEpoch(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/,/g, "")))) return Number(v.replace(/,/g, ""));
  return null;
};

/** Maps a schema.org JobPosting object to field candidates (source = json_ld). */
export function jobPostingToCandidates(jp: Record<string, unknown>): { fields: CandidateSet; descriptionText: string | null } {
  const f: CandidateSet = {};
  const S: EvidenceSource = "json_ld";
  const title = str(jp.title);
  if (title) f.title = cand(htmlToText(title), S, snippet("title", jp.title), "high");

  const org = jp.hiringOrganization as Record<string, unknown> | undefined;
  const orgName = str(org);
  if (orgName) f.company_name = cand(orgName, S, snippet("hiringOrganization.name", orgName), "high");
  const orgUrl = str(org?.sameAs) ?? str(org?.url);
  if (orgUrl && /^https?:\/\//.test(orgUrl)) f.company_website = cand(orgUrl, S, snippet("hiringOrganization.sameAs", orgUrl), "high");

  const posted = toEpoch(jp.datePosted);
  if (posted) f.posted_at = cand(posted, S, snippet("datePosted", jp.datePosted), "high");
  const valid = toEpoch(jp.validThrough);
  if (valid) f.deadline_at = cand(valid, S, snippet("validThrough", jp.validThrough), "medium");

  const et = arr(jp.employmentType as string | string[]).map(str).filter(Boolean) as string[];
  if (et.length) f.employment_type = cand(mapEmploymentType(et[0]), S, snippet("employmentType", jp.employmentType), "high");

  // Locations
  const places = arr(jp.jobLocation as Record<string, unknown> | Record<string, unknown>[]);
  const addrs = places
    .map((p) => (p?.address ?? p) as Record<string, unknown>)
    .filter((a) => a && typeof a === "object")
    .map((a) => ({ city: str(a.addressLocality), region: str(a.addressRegion), country: str(a.addressCountry) }));
  if (addrs[0]) {
    if (addrs[0].city) f.city = cand(addrs[0].city, S, snippet("jobLocation.address", addrs[0]), "high");
    if (addrs[0].region) f.region = cand(addrs[0].region, S, snippet("jobLocation.address", addrs[0]), "high");
    if (addrs[0].country) f.country = cand(addrs[0].country, S, snippet("jobLocation.address", addrs[0]), "high");
  }
  if (addrs.length > 1) {
    const extra = addrs.slice(1).map((a) => [a.city, a.region, a.country].filter(Boolean).join(", ")).filter(Boolean);
    if (extra.length) f.additional_locations = cand(extra, S, snippet("jobLocation", addrs.slice(1)), "high");
  }
  const locType = str(jp.jobLocationType);
  if (locType && /telecommute/i.test(locType)) {
    f.work_mode = cand("remote", S, snippet("jobLocationType", locType), places.length ? "medium" : "high");
  }
  const applicantReq = arr(jp.applicantLocationRequirements as Record<string, unknown> | Record<string, unknown>[])
    .map(str)
    .filter(Boolean) as string[];
  if (applicantReq.length) f.remote_eligible_regions = cand(applicantReq, S, snippet("applicantLocationRequirements", jp.applicantLocationRequirements), "high");

  // Salary (only employer-published baseSalary; estimatedSalary is NOT employer disclosed)
  const bs = jp.baseSalary as Record<string, unknown> | undefined;
  if (bs && typeof bs === "object") {
    const value = (bs.value ?? {}) as Record<string, unknown>;
    const min = num(value.minValue) ?? num(value.value) ?? num(bs.minValue);
    const max = num(value.maxValue) ?? num(bs.maxValue) ?? (num(value.value) != null ? num(value.value) : null);
    const currency = str(bs.currency)?.toUpperCase() ?? null;
    if (min != null || max != null) {
      f.salary = cand(
        {
          min,
          max,
          currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
          period: mapSalaryUnit(str(value.unitText) ?? str(bs.unitText)),
          source: "employer",
          text: null,
          compensation_type: null,
        },
        S,
        snippet("baseSalary", bs),
        "high",
      );
    }
  }

  const listField = (key: string, field: ExtractableField) => {
    const v = jp[key];
    if (!v) return;
    const items = arr(v as unknown)
      .map((x) => (typeof x === "string" ? htmlToText(x) : str(x)))
      .flatMap((x) => (x ? x.split(/\n+/) : []))
      .map((x) => x.replace(/^[•\-*]\s*/, "").trim())
      .filter((x) => x.length > 1);
    if (items.length) f[field] = cand(items.slice(0, 60), S, snippet(key, v), "high");
  };
  listField("responsibilities", "responsibilities");
  listField("qualifications", "required_qualifications");
  listField("skills", "technical_skills");
  listField("jobBenefits", "benefits");
  listField("educationRequirements", "education_requirements");

  const exp = jp.experienceRequirements as Record<string, unknown> | string | undefined;
  if (exp && typeof exp === "object" && num(exp.monthsOfExperience) != null) {
    const years = Math.floor(num(exp.monthsOfExperience)! / 12);
    f.years_experience_min = cand(years, S, snippet("experienceRequirements", exp), "high");
  }
  const cat = str(jp.occupationalCategory) ?? str(jp.industry);
  if (cat) f.category = cand(cat, S, snippet("occupationalCategory", cat), "medium");

  const desc = typeof jp.description === "string" ? htmlToText(jp.description) : null;
  return { fields: f, descriptionText: desc && desc.length > 50 ? desc : null };
}
