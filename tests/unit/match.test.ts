import { describe, expect, it } from "vitest";
import { extractRequirements, matchJob, type JobRequirementsInput } from "../../src/server/match/engine";
import { profileSchema, type Profile } from "../../src/shared/profile";

const NOW = new Date("2026-10-15T00:00:00Z");

// Fictional candidate.
const mei: Profile = profileSchema.parse({
  based_in: { city: "Toronto", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "permanent_resident" }],
  driver_licence: { has: false, has_vehicle: false },
  languages: [
    { language: "English", level: "professional" },
    { language: "Mandarin", level: "native" },
    { language: "French", level: "basic" },
  ],
  education: [{ level: "bachelor", field: "Economics", institution: "Example University", country: "China", completed: true }],
  experience: [{ title: "AML Analyst", organization: "Fabrikam Bank", start: "2024-03", current: true, areas: ["AML", "transaction monitoring", "risk analysis"] }],
  skills: ["Excel", "SQL", "Python", "MS Office"],
  certifications: [{ name: "CAMS", status: "in_progress" }],
});

const job = (fields: Record<string, unknown>, extra: Partial<JobRequirementsInput> = {}): JobRequirementsInput => ({ country: "Canada", visa_sponsorship: "unknown", fields, inferred: new Set(), ...extra });
const item = (r: ReturnType<typeof matchJob>, text: RegExp) => r.items.find((i) => text.test(i.text))!;

describe("requirement classification", () => {
  it("separates must-have, preferred and unclear, keeping the source wording", () => {
    const reqs = extractRequirements(
      job({
        required_qualifications: ["2+ years of SQL experience", "Experience with Tableau is an asset"],
        preferred_qualifications: ["CAMS certification"],
        technical_skills: ["SQL", "Looker"],
      }),
    );
    expect(reqs.find((r) => r.text === "2+ years of SQL experience")?.category).toBe("mandatory");
    expect(reqs.find((r) => /Tableau/.test(r.text))?.category).toBe("preferred"); // "an asset" inside the required list
    expect(reqs.find((r) => r.text === "CAMS certification")?.category).toBe("preferred");
    expect(reqs.find((r) => r.text === "Looker")?.category).toBe("unclear"); // listed skill, importance not stated
    expect(reqs.some((r) => r.text === "SQL")).toBe(false); // already part of a listed requirement
  });

  it("never treats an AI inference as a verified requirement", () => {
    const reqs = extractRequirements(job({ required_qualifications: ["Valid driver's licence"] }, { inferred: new Set(["required_qualifications"]) }));
    expect(reqs[0]).toMatchObject({ category: "unclear", ai_inferred: true });
  });
});

describe("matching", () => {
  it("missing mandatory driver's licence is a separate eligibility gap, never hidden by the score", () => {
    const r = matchJob(
      job({
        required_qualifications: ["Valid driver's license and access to a vehicle.", "Proficiency with Microsoft Excel and SQL", "AML knowledge: understanding of money laundering"],
        education_requirements: ["Bachelor's degree in Economics, Finance, or a related field."],
      }),
      mei,
      NOW,
    );
    const lic = item(r, /driver/);
    expect(lic).toMatchObject({ status: "not_met", category: "mandatory", eligibility: true, reason: { code: "licence_missing" } });
    expect(r.summary.level).toBe("mandatory_gap");
    expect(r.summary.eligibility_issues).toBe(1);
    expect(r.summary.score).toBeGreaterThan(50); // the rest fits well, but the gap is still reported first
  });

  it("unknown profile facts stay unknown (never a 'no')", () => {
    const p = profileSchema.parse({ ...mei, driver_licence: { has: null }, languages: [], work_authorization: [] });
    const r = matchJob(job({ required_qualifications: ["Valid driver's licence required", "Fluent English", "Must be legally eligible to work in Canada"] }), p, NOW);
    for (const i of r.items) expect(i.status).toBe("unknown");
    expect(r.summary.mandatory.not_met).toBe(0);
  });

  it("uncertain work experience: undated roles cannot be evaluated; flexible wording gives partial, not a fail", () => {
    const undated = profileSchema.parse({ ...mei, experience: [{ title: "Risk Analyst", organization: "Contoso", areas: ["risk analysis"] }] });
    expect(item(matchJob(job({ required_qualifications: ["3+ years of risk analysis experience"] }), undated, NOW), /risk/).status).toBe("unknown");

    const r = matchJob(job({ required_qualifications: ["Ideally 4 years in risk analysis or AML; candidates with approximately 1 year of relevant experience may be considered"] }), mei, NOW);
    expect(item(r, /risk analysis/)).toMatchObject({ status: "partial", flexible: true, reason: { code: "exp_flexible" } });

    const strict = matchJob(job({ required_qualifications: ["5 years of AML investigation experience"] }), mei, NOW);
    expect(item(strict, /AML/)).toMatchObject({ status: "not_met", reason: { code: "exp_below", params: { need: "5" } } });
    expect(matchJob(job({ required_qualifications: ["2 years of AML experience"] }), mei, NOW).items[0].status).toBe("met");
  });

  it("language proficiency: level and 'and/or' are respected", () => {
    const bilingual = matchJob(job({ language_requirements: ["Bilingual (English and French) – fluent written and spoken"] }), mei, NOW);
    expect(bilingual.items[0]).toMatchObject({ status: "not_met", kind: "language", reason: { code: "lang_below" } });
    expect(matchJob(job({ language_requirements: ["Professional English or French"] }), mei, NOW).items[0].status).toBe("met");
    const asset = matchJob(job({ preferred_qualifications: ["Mandarin is an asset"] }), mei, NOW).items[0];
    expect(asset).toMatchObject({ status: "met", category: "preferred" });
    expect(matchJob(job({ language_requirements: ["Fluent Spanish required"] }), mei, NOW).items[0].reason.code).toBe("lang_missing");
  });

  it("education equivalency: alternatives give partial; foreign degrees are noted, not failed", () => {
    const diploma = profileSchema.parse({ ...mei, education: [{ level: "diploma", field: "Business", country: "Canada" }] });
    expect(matchJob(job({ education_requirements: ["Bachelor's degree or equivalent combination of education and experience"] }), diploma, NOW).items[0]).toMatchObject({ status: "partial", reason: { code: "edu_below_equivalent" } });
    expect(matchJob(job({ education_requirements: ["Master's degree in Statistics required"] }), mei, NOW).items[0]).toMatchObject({ status: "not_met", reason: { code: "edu_below" } });
    expect(matchJob(job({ education_requirements: ["Bachelor's degree in Economics, Finance, or a related field"] }), mei, NOW).items[0]).toMatchObject({ status: "met", reason: { code: "edu_met_foreign", params: { country: "China" } } });
    expect(matchJob(job({ education_requirements: ["Secondary education (high school diploma) or equivalent work experience required"] }), mei, NOW).items[0].status).toBe("met");
  });

  it("preferred skills and certifications: met, missing, in progress", () => {
    const r = matchJob(job({ preferred_qualifications: ["Experience with Tableau or Power BI", "CAMS/ACFCS certifications"], technical_skills: ["SQL", "Snowflake"] }), mei, NOW);
    expect(item(r, /Tableau/)).toMatchObject({ status: "not_met", category: "preferred", reason: { code: "skill_missing" } });
    expect(item(r, /CAMS/)).toMatchObject({ status: "partial", reason: { code: "cert_in_progress", params: { name: "CAMS" } } });
    expect(item(r, /^SQL$/)).toMatchObject({ status: "met", category: "unclear" });
    expect(item(r, /^Snowflake$/).status).toBe("not_met");
    expect(r.summary.eligibility_issues).toBe(0);
  });

  it("work authorization: PR meets 'eligible to work'; sponsorship and citizen-only are flagged, not hidden", () => {
    expect(matchJob(job({ work_authorization: "Must be legally eligible to work in Canada" }), mei, NOW).items[0].status).toBe("met");
    expect(matchJob(job({ citizenship_restriction: "Canadian citizenship required" }), mei, NOW).items[0]).toMatchObject({ status: "not_met", reason: { code: "auth_citizen_only" }, eligibility: true });
    const visa = profileSchema.parse({ ...mei, work_authorization: [{ country: "Canada", status: "needs_sponsorship" }] });
    expect(matchJob(job({ work_authorization: "Must be authorized to work in Canada" }), visa, NOW).items[0].reason.code).toBe("auth_sponsorship");
  });

  it("a failed must-have is reported even when too little is known for a score", () => {
    const sparse = profileSchema.parse({ driver_licence: { has: false } });
    const r = matchJob(job({ required_qualifications: ["Valid driver's licence", "3+ years of logistics experience"] }), sparse, NOW);
    expect(r.summary.score).toBeNull();
    expect(r.summary.level).toBe("mandatory_gap");
  });

  it("without a profile nothing is judged", () => {
    const r = matchJob(job({ required_qualifications: ["SQL"] }), null, NOW);
    expect(r.summary).toMatchObject({ has_profile: false, level: "insufficient", score: null });
  });
});
