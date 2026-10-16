// Screening questions answered from Application Defaults when the site writes its options as statements,
// acknowledgment dropdowns, typed certifications and permission to contact an employer
// (src/local/apply/plan.ts, src/shared/apply-semantic.ts). Fictional applicant and employer.
import { describe, expect, it } from "vitest";
import { planForm, type FieldDescriptor, type PlanContext } from "../../src/local/apply/plan";
import { consentCategories, questionMeaning } from "../../src/shared/apply-semantic";
import { profileSchema } from "../../src/shared/profile";

const base = {
  contact: { first_name: "Morgan", last_name: "Lee", email: "morgan.lee@example.test" },
  based_in: { city: "Kingston", region: "Ontario", country: "Canada" },
};
const STANDING = { read_information: true, routine_terms: true, accuracy_declaration: true, interview_recording: false, recording_training: false, background_check: true, third_party_sharing: false };
const profileWith = (defaults: Record<string, unknown>, auth: Record<string, unknown> = { country: "Canada", status: "work_permit" }) => profileSchema.parse({ ...base, work_authorization: [auth], application_defaults: defaults });
let n = 0;
const f = (o: Partial<FieldDescriptor>): FieldDescriptor => ({ ref: `f${++n}`, control: "select", inputType: "select", name: "", id: `q${n}`, label: "", placeholder: "", autocomplete: "", required: true, options: [], section: "", demographic: false, value: [], visible: true, ...o });
const opts = (...l: string[]) => [{ label: "Select...", value: "" }, ...l.map((label) => ({ label, value: label }))] as FieldDescriptor["options"];
const ctx = (profile: ReturnType<typeof profileWith>, extra: Partial<PlanContext> = {}): PlanContext => ({ profile, jobCountry: "Canada", employer: "Example Co", answers: {}, resume: { fileName: "" }, consent: { accuracyVerified: true }, ...extra });
const first = (field: FieldDescriptor, c: PlanContext) => planForm([field], c);

const RELOCATE = f({ label: "This position is required to work out of an Example Co office in Toronto; if you do not reside within commutable proximity to the office, are you open to relocating?", options: opts("I am willing to relocate before starting employment.", "I am not willing to relocate before starting employment.", "I already reside within commutable distance to Toronto and am able to work at an on-site office.") });
const AUTH = f({ label: "Work Authorization", options: opts("I am authorized to work for any employer in the country in which this position is based.", "I require/will require Example Co's sponsorship to obtain work authorization in the country in which this position is based.", "My status to work in the country in which this position is based is unknown.") });

describe("yes / no answered through statement options", () => {
  it("relocation: the statement about relocating, by polarity — never 'already reside nearby'", () => {
    expect(first(RELOCATE, ctx(profileWith({ relocation: "yes" }))).actions[0]).toMatchObject({ kind: "choose", values: ["I am willing to relocate before starting employment."] });
    expect(first(RELOCATE, ctx(profileWith({ relocation: "no" }))).actions[0]).toMatchObject({ values: ["I am not willing to relocate before starting employment."] });
    expect(first(RELOCATE, ctx(profileWith({}))).questions[0]).toMatchObject({ reason: "missing" });
  });

  it("work authorization for ANY employer: only when the applicant said the permit is not tied to one employer", () => {
    const open = first(AUTH, ctx(profileWith({}, { country: "Canada", status: "work_permit", any_employer: true })));
    expect(open.actions[0]).toMatchObject({ values: ["I am authorized to work for any employer in the country in which this position is based."] });
    const unstated = first(AUTH, ctx(profileWith({})));
    expect(unstated.actions).toEqual([]);
    expect(unstated.questions[0]).toMatchObject({ reason: "sensitive" });
    expect(first(AUTH, ctx(profileWith({}, { country: "Canada", status: "citizen" }))).actions[0]).toMatchObject({ values: [expect.stringMatching(/any employer/)] });
  });
});

describe("permission to contact the current employer", () => {
  it("is its own meaning, answered from the standing default", () => {
    expect(questionMeaning("May we contact your current employer?").meaning).toBe("contact_employer");
    const q = f({ label: "May we contact your current employer?", options: opts("Yes", "No") });
    expect(first(q, ctx(profileWith({ contact_employer: "yes" }))).actions[0]).toMatchObject({ values: ["Yes"], source: "defaults.contact_employer" });
    expect(first(q, ctx(profileWith({}))).questions[0]).toMatchObject({ reason: "missing" });
  });
});

describe("acknowledgments and certifications", () => {
  it("a dropdown whose only option acknowledges a privacy notice is a consent, given under the privacy setting", () => {
    const q = f({ label: "Please review the linked document:", options: opts("I acknowledge that I have read and understood the terms of the Example Co Candidate Privacy Notice.") });
    expect(first(q, ctx(profileWith({ accept_privacy_notices: "yes" }))).actions[0]).toMatchObject({ kind: "choose", values: [expect.stringMatching(/^I acknowledge/)] });
    expect(first(q, ctx(profileWith({ accept_privacy_notices: "no" }))).questions[0]).toMatchObject({ reason: "legal" });
  });

  const CERT = "I certify that the facts set forth in this Application for Employment are true and complete to the best of my knowledge. I understand that if I am employed, false statements, omissions or misrepresentations may result in my dismissal. I authorize the Employer to make an investigation of any of the facts set forth in this application and release the Employer from any liability. The employer may contact any provided references.";

  it("the standard certification: accuracy + investigation / references (with its release) — no other binding term", () => {
    expect(consentCategories(CERT).sort()).toEqual(["accuracy_declaration", "background_check"]);
    // A release or waiver that is not tied to an authorised check stays binding (always asked).
    expect(consentCategories("I release Example Co from any liability arising from my employment.")).toContain("other_binding");
    expect(consentCategories("I agree to the Privacy Policy and waive my right to a jury trial.")).toContain("other_binding");
  });

  it("a typed certification is a declaration: 'I agree' when every category is authorised, else asked", () => {
    const q = f({ control: "text", inputType: "text", label: CERT, value: "" });
    expect(first(q, ctx(profileWith({ standing_consents: STANDING }))).actions[0]).toMatchObject({ kind: "fill", value: "I agree" });
    const off = first(q, ctx(profileWith({ standing_consents: { ...STANDING, background_check: false } })));
    expect(off.actions).toEqual([]);
    expect(off.questions[0]).toMatchObject({ reason: "legal" });
    expect(off.questions[0].hint).toMatch(/not authorised: background_check/);
  });
});
