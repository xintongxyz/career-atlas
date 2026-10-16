// Composite controls and meaning from context (src/local/apply/plan.ts). Fictional applicant.
import { describe, expect, it } from "vitest";
import { factCatalog, profileSummary } from "../../src/local/apply/browser-agent";
import { classify, datePartOf, planForm, type FieldDescriptor, type PlanContext } from "../../src/local/apply/plan";
import { profileSchema } from "../../src/shared/profile";
import { LAB_CA } from "../lab/profiles";

let n = 0;
const f = (o: Partial<FieldDescriptor>): FieldDescriptor => ({ ref: `f${++n}`, control: "text", inputType: "text", name: "", id: `i${n}`, label: "", placeholder: "", autocomplete: "", required: true, options: [], section: "", demographic: false, value: "", visible: true, ...o });
const opts = (...l: string[]) => l.map((label) => ({ label, value: label })) as FieldDescriptor["options"];
const ctx = (p: object = LAB_CA): PlanContext => ({ profile: profileSchema.parse(p), jobCountry: "Canada", answers: {}, resume: { fileName: "" } });

describe("composite dates take their question from the group", () => {
  it("bare Month / Year under 'Graduation date' → the one completed degree's end month and year", () => {
    expect(datePartOf(f({ label: "Month *" }))).toBe("month");
    expect(datePartOf(f({ label: "YYYY" }))).toBe("year");
    expect(datePartOf(f({ label: "Start month" }))).toBeNull();
    const month = f({ label: "Month", control: "select", section: "Graduation date", options: opts("Month", "April", "May", "June") });
    const year = f({ label: "Year", control: "select", section: "Date of graduation", options: opts("Year", "2023", "2024") });
    const plan = planForm([month, year], ctx());
    expect(plan.actions.map((a) => (a.kind === "choose" ? a.values[0] : null))).toEqual(["May", "2024"]);
  });
  it("numeric month options are matched by number; several completed degrees are ambiguous (asked)", () => {
    const month = f({ label: "Month", control: "select", section: "Graduation date", options: opts("MM", "04", "05", "06") });
    expect(planForm([month], ctx()).actions[0]).toMatchObject({ kind: "choose", values: ["05"] });
    const two = { ...LAB_CA, education: [...LAB_CA.education, { level: "bachelor", field: "Math", institution: "Example U", completed: true, year: 2020, end: "2020-06" }] };
    const p = planForm([f({ label: "Year", control: "select", section: "Graduation date", options: opts("2020", "2024") })], ctx(two));
    expect(p.actions).toEqual([]);
    expect(p.questions[0]?.hint).toMatch(/Several completed degrees/);
  });
});

describe("meaning from wording, not position", () => {
  it("addresses introduced in different words — and not e-mail / web addresses", () => {
    for (const label of ["Home address", "Start typing your address", "Street address", "Mailing address", "Address line 1"]) expect(classify(f({ label }))).toBe("address");
    for (const label of ["Email address", "Web address", "Address line 2"]) expect(classify(f({ label }))).not.toBe("address");
  });
  it("a typeahead that lists nothing yet is typed and then picked (never left as typed text)", () => {
    const box = f({ label: "Home address", control: "combobox", options: [] });
    expect(planForm([box], ctx()).actions[0]).toMatchObject({ kind: "search", value: "100 Queen St W", match: ["100 Queen St W"] });
  });
  it("a calling-code list by country names or by codes only; the phone country is never the job's", () => {
    const names = f({ label: "Country Phone Code", control: "select", options: opts("Please Select", "American Samoa (+1)", "Australia (+61)", "Canada (+1)") });
    expect(planForm([names], ctx()).actions[0]).toMatchObject({ kind: "choose", values: ["Canada (+1)"] });
    const codes = f({ label: "Dial code", control: "select", options: opts("+33", "+44", "+61", "+1") });
    expect(planForm([codes], ctx()).actions[0]).toMatchObject({ kind: "choose", values: ["+1"] });
    const uk = profileSchema.parse({ contact: { phone: "+44 20 7946 0958" }, based_in: { country: "Canada" } });
    expect(planForm([names], { ...ctx(), profile: uk }).actions).toEqual([]); // +44 is not offered there → not forced onto Canada
  });
  it("local number next to a code control; E.164 in an international widget", () => {
    const local = f({ label: "Phone number", inputType: "tel", phone: { widget: "split", dial: "+1" } });
    expect(planForm([local], ctx()).actions[0]).toMatchObject({ kind: "fill", value: "6135550147" });
    const intl = f({ label: "Phone", inputType: "tel", phone: { widget: "intl", dial: "+61" } });
    expect(planForm([intl], ctx()).actions[0]).toMatchObject({ kind: "fill", value: "+16135550147" });
  });
});

describe("what the model is told about the applicant", () => {
  it("usable facts only; counts are a separate summary", () => {
    const p = profileSchema.parse(LAB_CA);
    const c = factCatalog(p);
    expect(c["education.graduation"]).toBe(true);
    expect(Object.keys(c).some((k) => /_entries$|^skills$|^languages$/.test(k))).toBe(false);
    expect(profileSummary(p)).toEqual({ experience_entries: 1, education_entries: 1, skills: 3, languages: 0 });
  });
});
