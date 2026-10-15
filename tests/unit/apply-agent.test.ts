// The runtime browser agent's trusted boundary (src/local/apply/browser-agent.ts): what Career Atlas
// refuses whatever the model proposes, and what the model is told about the applicant (names of facts,
// never their values). Synthetic profile.
import { describe, expect, it } from "vitest";
import { _agentTest, factCatalog, toAgentAction, validate, type AgentAction, type AgentObservation, type ValidationContext } from "../../src/local/apply/browser-agent";
import type { FieldDescriptor } from "../../src/local/apply/plan";
import { profileSchema } from "../../src/shared/profile";

let n = 0;
const f = (o: Partial<FieldDescriptor>): FieldDescriptor => ({ ref: `f${++n}`, control: "text", inputType: "text", name: "", id: "", label: "", placeholder: "", autocomplete: "", required: false, options: [], section: "", demographic: false, value: "", visible: true, ...o });
const profile = profileSchema.parse({ contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test", phone: "+1 555 0100" }, application_defaults: { preferred_contact_method: "email" } });

const fields = [
  f({ ref: "f1", label: "Given name", required: true }),
  f({ ref: "f2", label: "Password", inputType: "password" }),
  f({ ref: "f3", label: "I certify that the information above is true", control: "checkbox", value: false }),
  f({ ref: "f4", label: "Gender", control: "select", options: [{ label: "Woman", value: "w" }, { label: "Prefer not to say", value: "n" }] as FieldDescriptor["options"] }),
  f({ ref: "f5", label: "Which office are you applying to?", control: "select", options: [{ label: "Toronto", value: "t" }, { label: "Montreal", value: "m" }] as FieldDescriptor["options"] }),
  f({ ref: "f6", label: "Are you legally eligible to work in Canada?", control: "radio", options: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }] as FieldDescriptor["options"] }),
];
const obs: AgentObservation = {
  goal: 'Apply for "Analyst" at Northwind',
  page_state: "application",
  widgets: [],
  frames: [],
  url: "https://careers.example.test/apply",
  title: "Apply",
  headings: [],
  dialogs: [],
  errors: [],
  captcha: false,
  password_field: true,
  fields: [],
  buttons: [
    { ref: "b1", text: "Next" },
    { ref: "b2", text: "Submit application" },
    { ref: "b3", text: "Create an account" },
    { ref: "b4", text: "Continue as guest" },
    { ref: "b5", text: "Send my application" },
    { ref: "b6", text: "Sign in" },
    { ref: "b7", text: "Submit", area: "subscription" },
    { ref: "b8", text: "Search", area: "search" },
    { ref: "b9", text: "Accept All Cookies", area: "cookie" },
    { ref: "b10", text: "Reject All", area: "cookie" },
    { ref: "b11", text: "Get updates", area: "subscription" },
    { ref: "b12", text: "Deny", area: "cookie" },
    { ref: "b13", text: "Close - By closing this dialog, you have accepted all cookies.", area: "cookie" },
    { ref: "b14", text: "Media and entertainment", area: "chrome" },
    { ref: "b15", text: "Apply now", area: "chrome" },
    { ref: "b16", text: "Cookie settings", area: "cookie" },
  ],
};
const ctx: ValidationContext = { obs, fields, profile, employer: null };
const v = (a: AgentAction) => validate(a, ctx);

describe("browser agent: trusted validation", () => {
  it("allows ordinary navigation and profile-backed filling", () => {
    expect(v({ action: "click", ref: "b1" })).toBeNull();
    expect(v({ action: "click", ref: "b4" })).toBeNull(); // guest: no account is created
    expect(v({ action: "fill_from_profile", ref: "f1", fact: "contact.first_name" })).toBeNull();
    expect(v({ action: "choose_option", ref: "f5", option: "Toronto" })).toBeNull();
    expect(v({ action: "choose_from_profile", ref: "f6", fact: "work_authorization" })).toBeNull();
  });
  it("never clicks the final submit button, whatever it is called", () => {
    expect(v({ action: "click", ref: "b2" })).toMatch(/final submit/);
    expect(v({ action: "click", ref: "b5" })).toMatch(/final submit/);
  });
  it("never acts on site widgets (search, job alerts) and picks only private cookie choices", () => {
    expect(v({ action: "click", ref: "b11" })).toMatch(/job-alert/);
    expect(v({ action: "click", ref: "b8" })).toMatch(/job search/);
    expect(v({ action: "click", ref: "b7" })).toMatch(/job-alert|final submit/);
    expect(v({ action: "dismiss_dialog", ref: "b9" })).toMatch(/cookie/);
    expect(v({ action: "dismiss_dialog", ref: "b10" })).toBeNull();
    expect(v({ action: "click", ref: "b12" })).toBeNull(); // "Deny" is the private choice
    expect(v({ action: "click", ref: "b16" })).toBeNull(); // opening the settings is not consent
    expect(v({ action: "dismiss_dialog", ref: "b13" })).toMatch(/never accept/); // closing = accepting
    expect(v({ action: "click", ref: "b14" })).toMatch(/navigation/);
    expect(v({ action: "click", ref: "b15" })).toBeNull(); // an Apply link in the header starts the application
  });
  it("never creates accounts or signs in, and never touches passwords", () => {
    expect(v({ action: "click", ref: "b3" })).toMatch(/accounts/);
    expect(v({ action: "click", ref: "b6" })).toMatch(/accounts/);
    expect(v({ action: "fill_from_profile", ref: "f2", fact: "contact.email" })).toMatch(/password/);
  });
  it("declarations and identity questions belong to the applicant", () => {
    expect(v({ action: "set_checkbox", ref: "f3", checked: true })).toMatch(/approval/);
    expect(v({ action: "set_checkbox", ref: "f3", checked: false })).toBeNull();
    expect(v({ action: "choose_option", ref: "f4", option: "Prefer not to say" })).toMatch(/identity/);
    expect(v({ action: "choose_from_profile", ref: "f4", fact: "contact.first_name" })).toMatch(/identity/);
  });
  it("eligibility questions are not answered with a free option choice (never invented)", () => {
    expect(v({ action: "choose_option", ref: "f6", option: "Yes" })).toMatch(/about the applicant/);
  });
  it("refs and facts must exist; options must be offered", () => {
    expect(v({ action: "click", ref: "b404" })).toMatch(/unknown ref/);
    expect(v({ action: "fill_from_profile", ref: "f1", fact: "contact.password" })).toMatch(/unknown fact/);
    expect(v({ action: "fill_from_profile", ref: "f1", fact: "defaults.anything" })).toMatch(/unknown preference/);
    expect(v({ action: "choose_option", ref: "f5", option: "Vancouver" })).toMatch(/not offered/);
    expect(v({ action: "ask_user", question: " " })).toMatch(/question/);
  });
  it("parses only well-formed proposals", () => {
    expect(toAgentAction({ action: "click", ref: "b1" })).toEqual({ action: "click", ref: "b1" });
    expect(toAgentAction({ action: "click", ref: null })).toBeNull();
    expect(toAgentAction({ action: "run_shell", ref: "x" })).toBeNull();
    expect(toAgentAction({ action: "finish", status: "submitted", reasoning: "done" })).toMatchObject({ action: "finish", status: "blocked" });
  });
});

describe("browser agent: what the model learns about the applicant", () => {
  it("names which facts exist, never their values (except non-personal preferences)", () => {
    const c = factCatalog(profile);
    expect(c["contact.first_name"]).toBe(true);
    expect(c["contact.github_url"]).toBe(false);
    expect(c["defaults.preferred_contact_method"]).toBe("email");
    const text = JSON.stringify(c);
    for (const v of ["Alex", "Rivera", "example.test", "555"]) expect(text).not.toContain(v);
  });
});

describe("browser agent: field state in the observation", () => {
  it("shows the selected option only for questions that are not about the applicant", () => {
    const opts = (...l: string[]) => l.map((label) => ({ label, value: label })) as FieldDescriptor["options"];
    expect(_agentTest.stateOf(f({ label: "Which office are you applying to?", control: "select", options: opts("Toronto", "Montreal"), value: ["Toronto"] }))).toBe("selected: Toronto");
    expect(_agentTest.stateOf(f({ label: "Are you legally eligible to work in Canada?", control: "radio", options: opts("Yes", "No"), value: ["Yes"] }))).toBe("filled");
    expect(_agentTest.stateOf(f({ label: "Gender", control: "select", options: opts("Woman", "Man"), value: ["Woman"] }))).toBe("filled");
    expect(_agentTest.stateOf(f({ label: "Country", control: "select", options: opts("Canada", "France"), value: ["Canada"] }))).toBe("filled");
    expect(_agentTest.stateOf(f({ label: "First name", value: "Alex" }))).toBe("filled");
    expect(_agentTest.stateOf(f({ label: "First name", value: "" }))).toBe("empty");
  });
});
