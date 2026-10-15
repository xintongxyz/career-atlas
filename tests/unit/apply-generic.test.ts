import { emptyProfile } from "@shared/profile";
import { describe, expect, it } from "vitest";
import { addPanelButton, decideAdvance, decideNavigation, safeClickName } from "../../src/local/apply/generic";
import { planForm, type FieldDescriptor } from "../../src/local/apply/plan";
import { rowRole } from "../../src/local/apply/rows";

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

  it("repeated rows are recognised by meaning (not by one site's field names) and left to the rows handler", () => {
    const profile = emptyProfile();
    profile.contact = { ...profile.contact, email: "alex.rivera@example.test" };
    const ctx = { profile, jobCountry: "Canada", answers: {}, resume: { fileName: "Resume.pdf" } };
    const w = (label: string, extra: Partial<FieldDescriptor> = {}) => field({ label, group: "work", groupIndex: 0, ...extra });
    const e = (label: string, extra: Partial<FieldDescriptor> = {}) => field({ label, group: "education", groupIndex: 1, ...extra });
    expect(rowRole("work", w("Position Title"))).toBe("title");
    expect(rowRole("work", w("Employer Name"))).toBe("company");
    expect(rowRole("work", w("Current Job", { control: "checkbox" }))).toBe("current");
    expect(rowRole("work", w("Start Date", { inputType: "date" }))).toBe("start");
    expect(rowRole("work", w("Duties and Responsibilities", { control: "textarea" }))).toBe("description");
    expect(rowRole("work", w("Country", { control: "combobox" }))).toBe("country");
    expect(rowRole("education", e("School"))).toBe("school");
    expect(rowRole("education", e("Degree"))).toBe("degree");
    expect(rowRole("education", e("Major"))).toBe("major");
    expect(rowRole("education", e("Minor"))).toBe("minor");
    expect(rowRole("education", e("Not Completed", { control: "checkbox" }))).toBe("notCompleted");
    expect(rowRole("education", e("End Date", { inputType: "date" }))).toBe("end");
    // The generic planner does not fill rows field by field.
    const plan = planForm([w("Position Title"), e("School"), field({ id: "confirmEmail", label: "Confirm Email Address" })], ctx);
    expect(plan.actions.map((a) => a.kind === "fill" && a.value)).toEqual(["alex.rivera@example.test"]);
    expect(addPanelButton(["Add Employment History", "Add Cover Letter"], "work")).toBe("Add Employment History");
  });
});

describe("guest routes by meaning", () => {
  it("chooses the account-free route however it is worded, never sign-in", () => {
    for (const g of ["Apply as a guest", "Apply manually", "Continue without an account", "Apply without an Account", "Continue as guest", "Proceed without signing in"])
      expect(decideNavigation({ names: ["Sign in to apply", g], applicationFields: 0, labels: [] }, { password: false, challenge: false, cookieDismissed: true })).toMatchObject({ action: "click", why: "guest", name: g });
    expect(decideNavigation({ names: ["Sign in to apply", "Create an account"], applicationFields: 0, labels: [] }, { password: false, challenge: false, cookieDismissed: true }).action).not.toBe("click");
  });
});
