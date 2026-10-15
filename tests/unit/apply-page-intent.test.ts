// Page state from evidence (src/local/apply/page-intent.ts): inputs alone never make an application.
import { describe, expect, it } from "vitest";
import { APPLY_CTA_RE, pageState, type PageMap } from "../../src/local/apply/page-intent";

const map = (o: Partial<PageMap>): PageMap => ({ url: "https://careers.example.test/job/1", names: [], chromeNames: [], widgetNames: [], cookieNames: [], widgets: [], applicationFields: 0, semantics: [], applicantFields: 0, labels: [], headings: [], steps: false, submits: [], appRoot: false, frames: [], ...o });
const out = { inWorkflow: false, login: false };

describe("page state", () => {
  it("a posting whose only inputs are a job search and an alert e-mail is a posting", () => {
    const m = map({ names: ["Save job", "Apply Now Product Analyst"], widgetNames: ["Submit", "Search"], widgets: [{ kind: "subscription", heading: "Get notified for similar jobs", inputs: 1, buttons: ["Submit"] }, { kind: "search", heading: "Find your next job.", inputs: 1, buttons: ["Search"] }] });
    expect(pageState(m, out)).toBe("posting");
  });
  it("a lone e-mail field is not an application form", () => {
    expect(pageState(map({ names: ["Apply now"], applicationFields: 1, semantics: ["email"] }), out)).toBe("posting");
    expect(pageState(map({ names: ["Continue"], applicationFields: 1, semantics: ["email"] }), out)).toBe("unknown");
  });
  it("two applicant meanings, or a resume upload, make an application", () => {
    expect(pageState(map({ applicationFields: 4, semantics: ["first_name", "email"] }), out)).toBe("application");
    expect(pageState(map({ applicationFields: 1, semantics: ["resume"] }), out)).toBe("application");
  });
  it("questions without applicant fields are an application step only inside the workflow (or with step markers)", () => {
    expect(pageState(map({ applicationFields: 3 }), out)).toBe("unknown");
    expect(pageState(map({ applicationFields: 3 }), { inWorkflow: true, login: false })).toBe("questions");
    expect(pageState(map({ applicationFields: 3, steps: true }), out)).toBe("questions");
  });
  it("a sign-in step is login unless a full application is already on the page", () => {
    expect(pageState(map({ applicationFields: 1, semantics: ["email"] }), { inWorkflow: true, login: true })).toBe("login");
    expect(pageState(map({ applicationFields: 5, semantics: ["first_name", "last_name", "email"] }), { inWorkflow: true, login: true })).toBe("application");
  });
  it("recognises controls that start an application, including names that append the job title", () => {
    for (const n of ["Apply", "Apply now", "Apply Now Product Management Analyst", "Apply online", "Start application", "Begin your application"]) expect(APPLY_CTA_RE.test(n)).toBe(true);
    for (const n of ["Apply filters", "Applying filters", "Save job", "Submit", "Search", "Get notified"]) expect(APPLY_CTA_RE.test(n)).toBe(false);
  });
});
