import { describe, expect, it } from "vitest";
import { classify, fieldKey, matchOption, planForm, type FieldDescriptor, type PlanContext } from "../../src/local/apply/plan";
import { atsFromUrl, applicationUrl, classifyAfterSubmit, successSentence, type PageSignals } from "../../src/local/apply/outcome";
import { supportFor } from "../../src/server/services/apply";
import { profileSchema } from "../../src/shared/profile";

let n = 0;
const f = (o: Partial<FieldDescriptor>): FieldDescriptor => ({ ref: `f${++n}`, control: "text", inputType: "text", name: "", id: "", label: "", placeholder: "", autocomplete: "", required: false, options: [], section: "", demographic: false, value: "", visible: true, ...o });
const yn = [{ value: "1", label: "Yes" }, { value: "0", label: "No" }];

// Fictional applicant.
const profile = profileSchema.parse({
  contact: { first_name: "Mei", last_name: "Lin", email: "mei.lin@example.test", phone: "+1 647 555 0199" },
  based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "work_permit" }],
  driver_licence: { has: false, has_vehicle: null },
  languages: [{ language: "English", level: "professional" }, { language: "French", level: "basic" }],
  education: [{ level: "bachelor", field: "Economics", institution: "Example University", year: 2022 }],
});
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ profile, jobCountry: "Canada", answers: {}, resume: { fileName: "cv.pdf" }, ...over });

describe("field classification", () => {
  it("recognises standard fields by id, name, autocomplete and label", () => {
    expect(classify(f({ id: "first_name", label: "First Name" }))).toBe("first_name");
    expect(classify(f({ autocomplete: "family-name", label: "Surname" }))).toBe("last_name");
    expect(classify(f({ name: "name", label: "Full name ✱" }))).toBe("full_name");
    expect(classify(f({ name: "urls[LinkedIn]", label: "LinkedIn URL" }))).toBe("linkedin");
    expect(classify(f({ name: "email", inputType: "email" }))).toBe("email");
    expect(classify(f({ control: "file", id: "resume", label: "Resume/CV" }))).toBe("resume");
    expect(classify(f({ control: "file", id: "cover_letter", label: "Cover Letter" }))).toBe("cover_letter");
  });
  it("voluntary self-identification and legal declarations are never treated as ordinary fields", () => {
    expect(classify(f({ control: "select", name: "eeo[gender]", label: "Gender" }))).toBe("demographic");
    expect(classify(f({ control: "select", label: "Are you a protected veteran?" }))).toBe("demographic");
    expect(classify(f({ control: "select", label: "Disability status", demographic: true }))).toBe("demographic");
    expect(classify(f({ control: "checkbox", label: "I certify that the information provided is true and complete" }))).toBe("legal");
    expect(classify(f({ control: "text", label: "Electronic signature" }))).toBe("legal");
    expect(classify(f({ control: "checkbox", name: "consent[marketing]", label: "Keep me informed" }))).toBe("legal");
  });
  it("stable keys for answers", () => {
    expect(fieldKey({ name: "question_105", id: "question_105", label: "x" })).toBe("name:question_105");
    expect(fieldKey({ name: "", id: "question_103", label: "x" })).toBe("id:question_103");
    expect(fieldKey({ name: "", id: "130", label: "Gender" })).toBe("label:gender");
  });
});

describe("planning from verified data only", () => {
  it("never turns unknown into 'No' — required unknowns become questions", () => {
    const p = planForm([f({ control: "radio", label: "Do you have access to a vehicle?", required: true, options: yn }), f({ control: "radio", label: "Do you require sponsorship?", required: true, options: yn })], ctx());
    expect(p.actions).toEqual([]);
    expect(p.questions.map((q) => q.reason)).toEqual(["sensitive", "sensitive"]); // vehicle unknown; work permit → future sponsorship is the user's call
  });
  it("answers what the profile states, including an explicit 'No'", () => {
    const p = planForm([f({ control: "radio", label: "Do you have a valid driver's licence?", required: true, options: yn }), f({ control: "select", label: "Are you legally authorized to work in Canada?", options: [{ value: "", label: "Select…" }, ...yn] })], ctx());
    expect(p.actions.map((a) => (a.kind === "choose" ? a.values[0] : null))).toEqual(["No", "Yes"]);
  });
  it("optional unknowns stay empty; demographic questions are never answered", () => {
    const p = planForm([f({ control: "select", label: "Gender", options: [{ value: "x", label: "Decline to self-identify" }] }), f({ label: "Twitter" })], ctx());
    expect(p.actions).toEqual([]);
    expect(p.questions).toEqual([]);
    const req = planForm([f({ control: "select", label: "Race", required: true, options: [{ value: "x", label: "Decline to self-identify" }] })], ctx());
    expect(req.questions[0]).toMatchObject({ reason: "demographic", sensitive: true });
  });
  it("language level and degree are never inferred upwards", () => {
    const p = planForm([f({ control: "radio", label: "Are you fluent in French?", required: true, options: yn }), f({ control: "select", label: "Highest level of education", required: true, options: [{ value: "m", label: "Master's" }, { value: "b", label: "Bachelor's Degree" }] })], ctx());
    expect(p.questions.map((q) => [q.reason, q.hint])).toEqual([["missing", "basic"]]);
    expect(p.actions[0]).toMatchObject({ kind: "choose", values: ["Bachelor's Degree"] });
  });
  it("the user's answers win, then explicitly saved answers; misfits are asked again", () => {
    const withSaved = profileSchema.parse({ ...profile, saved_answers: [{ question: "How did you hear about us?", answer: "LinkedIn" }] });
    const fields = [f({ name: "src", label: "How did you hear about us?", required: true }), f({ name: "q2", control: "select", label: "Shift preference", required: true, options: [{ value: "d", label: "Day" }] })];
    const p = planForm(fields, ctx({ profile: withSaved, answers: { "name:q2": "Night" } }));
    expect(p.actions[0]).toMatchObject({ kind: "fill", value: "LinkedIn", source: "saved_answer" });
    expect(p.questions[0]).toMatchObject({ key: "name:q2", reason: "no_matching_option", hint: "Night" });
  });
  it("only one resume upload; a required unsupported file is asked", () => {
    const p = planForm([f({ control: "file", id: "resume", label: "Resume" }), f({ control: "file", id: "resume2", label: "Resume (again)" }), f({ control: "file", id: "transcript", label: "Transcript", required: true })], ctx());
    expect(p.actions.filter((a) => a.kind === "upload")).toHaveLength(1);
    expect(p.questions[0]).toMatchObject({ reason: "unsupported" });
  });
  it("search comboboxes pick only a suggestion matching every part of the location", () => {
    const p = planForm([f({ control: "combobox", id: "candidate-location", label: "Location (City)", asyncOptions: true })], ctx());
    expect(p.actions[0]).toMatchObject({ kind: "search", value: "Toronto", match: ["Toronto", "Ontario", "Canada"] });
  });
  it("option matching never guesses between candidates", () => {
    expect(matchOption(yn, "yes")?.label).toBe("Yes");
    expect(matchOption([{ value: "a", label: "Yes, I am" }, { value: "b", label: "Yes, with sponsorship" }], "yes")).toBeNull();
    expect(matchOption([{ value: "a", label: "Toronto, ON" }, { value: "b", label: "Toronto, OH" }], "Toronto")).toBeNull();
  });
});

const sig = (o: Partial<PageSignals>): PageSignals => ({ url: "https://job-boards.greenhouse.io/acme/jobs/1", title: "", hasForm: true, formVisible: true, challenge: false, password: false, errors: [], invalid: 0, text: "", greenhouseIframe: null, greenhouseForm: true, leverForm: false, ...o });

describe("submission outcome", () => {
  it("verified only with the site's confirmation", () => {
    expect(classifyAfterSubmit("greenhouse", sig({ url: "https://job-boards.greenhouse.io/acme/jobs/1/confirmation", text: "Thank you for applying.", formVisible: false }), true)).toMatchObject({ kind: "verified", text: "Thank you for applying." });
    expect(classifyAfterSubmit("lever", sig({ url: "https://jobs.lever.co/acme/uuid/thanks?x=secret", text: "Application submitted!", formVisible: false }), true)).toMatchObject({ kind: "verified", url: "https://jobs.lever.co/acme/uuid/thanks" });
    // Success words while the form is still showing are not enough.
    expect(classifyAfterSubmit("greenhouse", sig({ text: "Thank you for applying" }), true).kind).toBe("pending");
    // A blank page after the click is not a confirmation.
    expect(classifyAfterSubmit("greenhouse", sig({ formVisible: false, hasForm: false }), true).kind).toBe("pending");
  });
  it("local validation errors only when no submission request was made", () => {
    expect(classifyAfterSubmit("greenhouse", sig({ errors: ["Email is required"] }), false).kind).toBe("validation_errors");
    expect(classifyAfterSubmit("greenhouse", sig({ errors: ["Email is required"] }), true).kind).toBe("pending");
  });
  it("CAPTCHA and email codes are handed to the user", () => {
    expect(classifyAfterSubmit("lever", sig({ challenge: true }), false).kind).toBe("challenge");
    expect(classifyAfterSubmit("greenhouse", sig({ text: "We sent a security code to your email. Enter the code" }), true).kind).toBe("email_code");
  });
  it("success sentences and ATS detection", () => {
    expect(successSentence("Header. Your application has been received. Footer")).toBe("Your application has been received.");
    expect(atsFromUrl("https://job-boards.greenhouse.io/acme/jobs/1")).toBe("greenhouse");
    expect(atsFromUrl("https://jobs.eu.lever.co/acme/x")).toBe("lever");
    expect(atsFromUrl("https://acme.wd3.myworkdayjobs.com/x")).toBeNull();
    expect(applicationUrl("lever", "https://jobs.lever.co/acme/0b6c0a6e-1111-4222-8333-444455556666")).toMatch(/\/apply$/);
  });
});

describe("site support", () => {
  it("Greenhouse and Lever are automated; Workday/LinkedIn get manual help; loopback only on test instances", () => {
    expect(supportFor("https://job-boards.greenhouse.io/acme/jobs/123", false)).toMatchObject({ ats: "greenhouse", mode: "adapter" });
    expect(supportFor("https://acme.com/careers?gh_jid=123", false)).toMatchObject({ ats: "greenhouse", mode: "adapter" });
    expect(supportFor("https://jobs.lever.co/acme/0b6c0a6e-1111-4222-8333-444455556666", false)).toMatchObject({ ats: "lever", mode: "adapter" });
    expect(supportFor("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/x_R1", false)).toMatchObject({ supported: false, mode: "manual", ats: "workday" });
    expect(supportFor("https://www.linkedin.com/jobs/view/123", false)).toMatchObject({ supported: false });
    expect(supportFor("http://acme.com/jobs/1", false)).toMatchObject({ supported: false }); // https only
    expect(supportFor("http://127.0.0.1:9999/greenhouse/x/jobs/1", false)).toMatchObject({ supported: false });
    expect(supportFor("http://127.0.0.1:9999/greenhouse/x/jobs/1", true)).toMatchObject({ supported: true, mode: "detect" });
    expect(supportFor(null, false)).toMatchObject({ supported: false });
  });
});
