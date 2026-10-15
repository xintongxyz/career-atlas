import { emptyProfile } from "@shared/profile";
import { describe, expect, it } from "vitest";
import { addPanelButton, decideAdvance, decideNavigation, safeClickName } from "../../src/local/apply/generic";
import { planForm, repeatingValue, type FieldDescriptor } from "../../src/local/apply/plan";

const field = (over: Partial<FieldDescriptor>): FieldDescriptor => ({
  ref: "f1",
  control: "text",
  inputType: "text",
  name: "",
  id: "",
  label: "",
  placeholder: "",
  autocomplete: "",
  required: true,
  options: [],
  section: "",
  demographic: false,
  value: "",
  visible: true,
  ...over,
});

describe("unfamiliar application pages", () => {
  it("clicks Apply, then guest apply, and never Submit or Create account", () => {
    expect(decideNavigation({ names: ["Apply", "Sign In"], applicationFields: 0, labels: [] }, { password: false, challenge: false, cookieDismissed: false })).toMatchObject({ action: "click", why: "apply" });
    expect(decideNavigation({ names: ["Apply without an Account", "Sign In", "Create one now."], applicationFields: 0, labels: [] }, { password: false, challenge: false, cookieDismissed: true })).toMatchObject({ action: "click", why: "guest", name: "Apply without an Account" });
    expect(decideNavigation({ names: ["Sign In"], applicationFields: 0, labels: [] }, { password: true, challenge: false, cookieDismissed: true })).toMatchObject({ action: "login" });
    expect(decideAdvance(["Next", "Cancel"])).toMatchObject({ action: "click", why: "next" });
    expect(decideAdvance(["Submit"])).toMatchObject({ action: "review" });
    expect(decideNavigation({ names: ["Submit"], applicationFields: 0, labels: [] }, { password: false, challenge: false, cookieDismissed: true })).toMatchObject({ action: "fill" });
    expect(safeClickName("Submit", ["Submit", "Next"])).toBeNull();
    expect(safeClickName("Create one now.", ["Create one now."])).toBeNull();
    expect(safeClickName("Next", ["Next"])).toBe("Next");
  });

  it("fills a repeating work and education block from the profile, including a date the site stores as a calendar day", () => {
    const profile = emptyProfile();
    profile.contact = { ...profile.contact, first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test" };
    profile.experience = [{ title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: [], description: "Built reports" }];
    profile.education = [{ level: "master", field: "Statistics", institution: "Example University", country: "Canada", completed: true, year: 2024 }];
    const ctx = { profile, jobCountry: "Canada", answers: {}, resume: { fileName: "Resume.pdf" } };
    const title = field({ id: "jobPostingApplication_workHistory_0_title", label: "Position Title", group: "work", groupIndex: 0 });
    const start = field({ id: "jobPostingApplication_workHistory_0_effectiveStart", label: "Start Date", inputType: "date", group: "work", groupIndex: 0 });
    const school = field({ id: "jobPostingApplication_educationHistory_0_schoolName", label: "School", group: "education", groupIndex: 0 });
    expect(repeatingValue(title, ctx)).toMatchObject({ ok: true, value: "Data Analyst" });
    expect(repeatingValue(start, ctx)).toMatchObject({ ok: true, value: "2024-06-01" });
    expect(repeatingValue(school, ctx)).toMatchObject({ ok: true, value: "Example University" });
    const plan = planForm([title, start, school, field({ id: "confirmEmail", label: "Confirm Email Address" })], ctx);
    expect(plan.actions.map((a) => a.kind === "fill" && a.value)).toEqual(["Data Analyst", "2024-06-01", "Example University", "alex.rivera@example.test"]);
    expect(plan.questions).toEqual([]);
    expect(addPanelButton(["Add Employment History", "Add Cover Letter"], "work")).toBe("Add Employment History");
  });
});
