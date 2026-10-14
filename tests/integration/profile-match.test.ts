import { describe, expect, it } from "vitest";
import type { MatchResult } from "../../src/shared/match";
import type { ProfileDTO } from "../../src/shared/profile";
import type { JobListItem } from "../../src/shared/types";
import { api } from "./helpers";

// Fictional resume and job.
const RESUME = `Alex Rivera — Toronto, ON
EXPERIENCE
Transaction Monitoring Analyst, Fabrikam Bank (2023-05 – present): investigated AML alerts, prepared STR referrals.
EDUCATION
Bachelor of Commerce, Finance — Example University, 2022
SKILLS: SQL, Excel, Python
LANGUAGES: English (fluent), Spanish (intermediate)
Valid G driver's licence`;

const jobBody = {
  job: {
    company_name: "Northwind Bank (fictional)",
    title: "AML Investigator",
    city: "Toronto",
    country: "Canada",
    required_qualifications: ["2+ years of AML or transaction monitoring experience", "Valid driver's licence and access to a vehicle", "Fluent English"],
    preferred_qualifications: ["CAMS certification", "Experience with Tableau"],
    education_requirements: ["Bachelor's degree in Finance, Economics or a related field"],
  },
  confirm_duplicate: true,
};

describe("profile and job match", () => {
  it("without a profile nothing is judged; list rows have no match", async () => {
    const job = await api<{ id: string }>("/api/jobs", { method: "POST", json: jobBody });
    const m = (await api<MatchResult>(`/api/jobs/${job.body.id}/match`)).body;
    expect(m.summary).toMatchObject({ has_profile: false, level: "insufficient" });
    expect(m.items.every((i) => i.status === "unknown")).toBe(true);
    const list = (await api<{ items: JobListItem[] }>("/api/jobs?q=AML%20Investigator")).body.items;
    expect(list[0].match).toBeNull();
  });

  it("resume import is a draft: verified facts only, sensitive inferences dropped, nothing saved before accept", async () => {
    const draft = await api<{ items: number; verified: number; dropped: { section: string; reason: string }[] }>("/api/profile/drafts", {
      method: "POST",
      json: {
        origin: "claude_desktop",
        resume_text: RESUME,
        items: [
          { section: "experience", value: { title: "Transaction Monitoring Analyst", organization: "Fabrikam Bank", start: "2023-05", current: true, areas: ["AML", "transaction monitoring"] }, basis: "resume", evidence: "Transaction Monitoring Analyst, Fabrikam Bank (2023-05 – present)" },
          { section: "education", value: { level: "bachelor", field: "Finance", institution: "Example University", year: 2022 }, basis: "resume", evidence: "Bachelor of Commerce, Finance — Example University, 2022" },
          { section: "skills", value: ["SQL", "Excel", "Python"], basis: "resume", evidence: "SKILLS: SQL, Excel, Python" },
          { section: "languages", value: { language: "English", level: "fluent" }, basis: "resume", evidence: "English (fluent)" },
          { section: "driver_licence", value: { has: true, type: "G" }, basis: "resume", evidence: "Valid G driver's licence" },
          // Not in the resume: an inference about work authorization must not be imported.
          { section: "work_authorization", value: { country: "Canada", status: "citizen" }, basis: "inferred" },
          { section: "certifications", value: { name: "CAMS", status: "held" }, basis: "resume", evidence: "CAMS certified" },
        ],
      },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.dropped).toContainEqual({ section: "work_authorization", reason: "sensitive_not_verified" });
    expect(draft.body.verified).toBe(5); // the CAMS quote is not in the resume → kept but unverified

    const before = (await api<ProfileDTO>("/api/profile")).body;
    expect(before.profile.experience).toEqual([]); // nothing applied yet
    const cams = before.draft!.items.find((i) => i.section === "certifications")!;
    expect(cams.verified).toBe(false);

    const ids = before.draft!.items.filter((i) => i.verified).map((i) => i.id);
    const accepted = (await api<ProfileDTO>("/api/profile/drafts/accept", { method: "POST", json: { item_ids: ids } })).body;
    expect(accepted.draft).toBeNull();
    expect(accepted.profile.driver_licence).toMatchObject({ has: true, type: "G", has_vehicle: null }); // vehicle: unknown, not "no"
    expect(accepted.profile.certifications).toEqual([]);
    expect(accepted.profile.work_authorization).toEqual([]);
  });

  it("matches saved jobs and recalculates automatically after a profile edit", async () => {
    const list1 = (await api<{ items: JobListItem[] }>("/api/jobs?q=AML%20Investigator")).body.items;
    const id = list1[0].id;
    const m1 = (await api<MatchResult>(`/api/jobs/${id}/match`)).body;
    const find = (m: MatchResult, re: RegExp) => m.items.find((i) => re.test(i.text))!;
    expect(find(m1, /driver/)).toMatchObject({ status: "partial", reason: { code: "vehicle_unknown" }, eligibility: true });
    expect(find(m1, /2\+ years/).status).toBe("met"); // 2023-05 → today
    expect(find(m1, /Fluent English/).status).toBe("met");
    expect(find(m1, /Bachelor/).status).toBe("met");
    expect(find(m1, /Tableau/)).toMatchObject({ category: "preferred", status: "not_met" });
    expect(list1[0].match?.has_profile).toBe(true);

    // The user records that they have no vehicle → the mandatory gap appears everywhere at once.
    const profile = (await api<ProfileDTO>("/api/profile")).body.profile;
    await api("/api/profile", { method: "PUT", json: { profile: { ...profile, driver_licence: { ...profile.driver_licence, has_vehicle: false } } } });
    const m2 = (await api<MatchResult>(`/api/jobs/${id}/match`)).body;
    expect(find(m2, /driver/)).toMatchObject({ status: "not_met", reason: { code: "vehicle_missing" } });
    expect(m2.summary.level).toBe("mandatory_gap");
    const list2 = (await api<{ items: JobListItem[] }>("/api/jobs?q=AML%20Investigator")).body.items;
    expect(list2[0].match).toMatchObject({ level: "mandatory_gap", eligibility_issues: 1 });

    // Adding a certification is picked up immediately.
    await api("/api/profile", { method: "PUT", json: { profile: { ...profile, driver_licence: { has: true, has_vehicle: true }, certifications: [{ name: "CAMS", status: "held" }] } } });
    const m3 = (await api<MatchResult>(`/api/jobs/${id}/match`)).body;
    expect(find(m3, /CAMS/).status).toBe("met");
    expect(m3.summary.level).not.toBe("mandatory_gap");
  });

  it("rejects an invalid profile and unknown documents", async () => {
    expect((await api("/api/profile", { method: "PUT", json: { profile: { languages: [{ language: "English", level: "superhuman" }] } } })).status).toBe(422);
    expect((await api("/api/profile", { method: "PUT", json: { profile: {}, resume_document_id: "nope" } })).status).toBe(404);
  });
});
