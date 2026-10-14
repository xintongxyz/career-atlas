import { describe, expect, it } from "vitest";
import { canonicalizeUrl, companyHintFromUrl, detectPlatform } from "../../src/server/extraction/platforms";

describe("detectPlatform", () => {
  it("recognises ATS URLs and job IDs", () => {
    expect(detectPlatform("https://boards.greenhouse.io/acme/jobs/4012345")).toMatchObject({ platform: "greenhouse", externalId: "4012345", meta: { board: "acme" } });
    expect(detectPlatform("https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=x")).toMatchObject({ platform: "greenhouse", externalId: "4012345" });
    expect(detectPlatform("https://www.acme.com/careers/job?gh_jid=555555")).toMatchObject({ platform: "greenhouse", externalId: "555555" });
    expect(detectPlatform("https://jobs.lever.co/acme/0b4c1a9e-1234-4abc-9def-0123456789ab/apply")).toMatchObject({ platform: "lever", externalId: "0b4c1a9e-1234-4abc-9def-0123456789ab", meta: { company: "acme" } });
    expect(detectPlatform("https://jobs.ashbyhq.com/Acme%20Inc/0b4c1a9e-1234-4abc-9def-0123456789ab")).toMatchObject({ platform: "ashby", meta: { org: "Acme Inc" } });
    expect(detectPlatform("https://jobs.smartrecruiters.com/AcmeCorp/743999999999999-data-analyst")).toMatchObject({ platform: "smartrecruiters", externalId: "743999999999999" });
    expect(detectPlatform("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Toronto-ON/Data-Analyst_R12345")).toMatchObject({ platform: "workday", externalId: "R12345", meta: { tenant: "acme", site: "External", jobPath: "Toronto-ON/Data-Analyst_R12345" } });
    expect(detectPlatform("https://www.linkedin.com/jobs/view/senior-analyst-at-acme-3999999999/")).toMatchObject({ platform: "linkedin", externalId: "3999999999" });
    expect(detectPlatform("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3888888888")).toMatchObject({ platform: "linkedin", externalId: "3888888888" });
    expect(detectPlatform("https://ca.indeed.com/viewjob?jk=abc123def456")).toMatchObject({ platform: "indeed", externalId: "abc123def456" });
  });
});

describe("canonicalizeUrl", () => {
  it("removes tracking params but keeps job identifiers", () => {
    expect(canonicalizeUrl("https://www.acme.com/careers/job?gh_jid=555&utm_source=linkedin&utm_medium=x#apply")).toBe("https://acme.com/careers/job?gh_jid=555");
    expect(canonicalizeUrl("https://careers.example.com/jobs/view?jobId=77&ref=abc&source=feed")).toBe("https://careers.example.com/jobs/view?jobId=77");
    expect(canonicalizeUrl("https://ca.indeed.com/viewjob?jk=abc&from=serp&tk=1")).toBe("https://ca.indeed.com/viewjob?jk=abc");
  });
  it("normalises ATS URLs to one form", () => {
    expect(canonicalizeUrl("https://job-boards.greenhouse.io/Acme/jobs/1?gh_src=1")).toBe("https://boards.greenhouse.io/acme/jobs/1");
    expect(canonicalizeUrl("https://jobs.lever.co/acme/0b4c1a9e-1234-4abc-9def-0123456789ab/apply?lever-source=LinkedIn")).toBe("https://jobs.lever.co/acme/0b4c1a9e-1234-4abc-9def-0123456789ab");
    expect(canonicalizeUrl("https://www.linkedin.com/jobs/view/analyst-3999999999/?trk=abc")).toBe("https://www.linkedin.com/jobs/view/3999999999");
  });
  it("keeps distinct jobs distinct", () => {
    expect(canonicalizeUrl("https://x.com/jobs?id=1")).not.toBe(canonicalizeUrl("https://x.com/jobs?id=2"));
  });
  it("guesses a company from the URL", () => {
    expect(companyHintFromUrl("https://boards.greenhouse.io/maple-leaf/jobs/1")).toBe("Maple Leaf");
    expect(companyHintFromUrl("https://careers.northwind.com/job/1")).toBe("Northwind");
    expect(companyHintFromUrl("http://169.254.169.254/latest")).toBeNull();
  });
});
