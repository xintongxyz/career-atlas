import { describe, expect, it } from "vitest";
import { fieldQueries, formUrl, jobSourceOf, matchDegree, matchFieldOfStudy, matchLanguage, matchProficiency, matchSchool, matchSkill, matchSource, sameSchool, schoolQueries, urlKey } from "../../src/shared/apply-match";

describe("skills", () => {
  const opts = ["Excel VBA", "Microsoft Excel", "Microsoft Power BI", "Python (Programming Language)", "SQL", "SQL Server", "MySQL", "R (Programming Language)", "Tableau"];
  it("exact, vendor-prefixed and qualified equivalents", () => {
    expect(matchSkill("Excel", opts).pick).toBe("Microsoft Excel");
    expect(matchSkill("SQL", opts).pick).toBe("SQL");
    expect(matchSkill("python", opts).pick).toBe("Python (Programming Language)");
    expect(matchSkill("R", opts).pick).toBe("R (Programming Language)");
    expect(matchSkill("Power BI", opts).pick).toBe("Microsoft Power BI");
  });
  it("never a different skill", () => {
    expect(matchSkill("Excel", ["Excel VBA", "Excel Macros"]).pick).toBeNull();
    expect(matchSkill("SQL", ["SQL Server", "MySQL"]).pick).toBeNull();
    expect(matchSkill("Stata", opts).pick).toBeNull();
  });
});

describe("education", () => {
  it("school aliases", () => {
    expect(sameSchool("University of Northfield", "Northfield University")).toBe(true);
    expect(sameSchool("uNorthfield", "University of Northfield")).toBe(true);
    expect(sameSchool("University of Northfield", "Northfield College")).toBe(false);
    expect(schoolQueries("University of Northfield")).toEqual(["University of Northfield", "Northfield University", "Northfield"]);
    expect(matchSchool("University of Northfield", ["Northfield College", "University of Northfield", "University of Southfield"]).pick).toBe("University of Northfield");
  });
  const degrees = ["High School Diploma", "Associate Degree", "Bachelor's Degree", "Bachelor of Arts", "Bachelor of Science", "Master's Degree", "Master of Science", "Master of Business Administration (MBA)", "Doctorate"];
  it("degree per level: the generic option, never the other level", () => {
    expect(matchDegree("master", degrees).pick).toBe("Master's Degree");
    expect(matchDegree("bachelor", degrees).pick).toBe("Bachelor's Degree");
    expect(matchDegree("master", ["Master of Science", "Master of Arts"]).pick).toBeNull(); // specific credential would be a guess
    expect(matchDegree("master", ["Bachelors", "Master of Science"]).pick).toBe("Master of Science"); // the only master's option
    expect(matchDegree("doctorate", degrees).pick).toBe("Doctorate");
  });
  it("field of study: exact, or the parts of a joint programme when several values are allowed", () => {
    const f = ["Applied Statistics", "Biostatistics", "Business Economics", "Economics", "Statistics"];
    expect(matchFieldOfStudy("Statistics", f, false).picks).toEqual(["Statistics"]);
    expect(matchFieldOfStudy("Economics and Statistics", f, true)).toMatchObject({ picks: ["Economics", "Statistics"], how: "parts" });
    expect(matchFieldOfStudy("Economics and Statistics", f, false).picks).toEqual([]);
    expect(matchFieldOfStudy("Economics & Statistics", [...f, "Economics and Statistics"], true).picks).toEqual(["Economics and Statistics"]);
    expect(matchFieldOfStudy("Data Science", f, true).picks).toEqual([]);
    expect(fieldQueries("Economics and Statistics")).toEqual(["Economics and Statistics", "Economics", "Statistics"]);
  });
});

describe("languages", () => {
  it("language names and saved proficiency levels", () => {
    expect(matchLanguage("Mandarin", ["Chinese - Mandarin", "Mandarin", "Cantonese"]).pick).toBe("Mandarin");
    expect(matchLanguage("Mandarin", ["Chinese", "English"]).pick).toBe("Chinese");
    const scale = ["Beginner", "Intermediate", "Advanced", "Fluent"];
    expect(matchProficiency("intermediate", scale).pick).toBe("Intermediate");
    expect(matchProficiency("fluent", scale).pick).toBe("Fluent");
    expect(matchProficiency("native", scale).pick).toBe("Fluent"); // top of a scale without "native"
    expect(matchProficiency("native", ["1 - Basic", "2 - Conversational", "3 - Fluent", "4 - Native / Bilingual"]).pick).toBe("4 - Native / Bilingual");
    expect(matchProficiency("professional", ["Low", "Medium", "High"]).pick).toBeNull(); // unmappable → asked
  });
});

describe("websites", () => {
  it("compares URLs by destination", () => {
    expect(urlKey("https://www.linkedin.com/in/someone/")).toBe(urlKey("linkedin.com/in/someone"));
    expect(urlKey("https://example.test/a")).not.toBe(urlKey("https://example.test/b"));
    expect(formUrl("example.test/me")).toBe("https://example.test/me");
  });
});

describe("source of the job", () => {
  it("from the saved job only", () => {
    expect(jobSourceOf({ originalUrl: "https://acme.wd3.myworkdayjobs.com/x/job/y?source=LinkedIn" })).toBe("linkedin");
    expect(jobSourceOf({ route: "indeed_company_site", originalUrl: "https://ca.indeed.com/viewjob?jk=1" })).toBe("indeed");
    expect(jobSourceOf({ sourcePlatform: "company_site", originalUrl: "https://acme.example.test/careers/1" })).toBeNull(); // a link type, not where it was found
    expect(jobSourceOf({ sourcePlatform: "workday", originalUrl: "https://acme.wd3.myworkdayjobs.com/x/job/y" })).toBeNull();
  });
  it("exact leaf, else a truthful category; never referral or campus", () => {
    const top = ["Employee Referral", "Campus Recruitment", "Job Board", "Social Media", "Company Website", "Recruitment Agency"];
    expect(matchSource("linkedin", top)).toEqual({ leaf: null, categories: ["Social Media", "Job Board"] });
    expect(matchSource("linkedin", ["LinkedIn", "Facebook"]).leaf).toBe("LinkedIn");
    expect(matchSource("company_site", top).leaf).toBe("Company Website");
    expect(matchSource("indeed", ["Employee Referral", "Campus Recruitment"])).toEqual({ leaf: null, categories: [] });
  });
});
