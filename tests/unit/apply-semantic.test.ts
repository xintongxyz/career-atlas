import { describe, expect, it } from "vitest";
import { conceptsOf, domainForLabel, matchOptionSemantic, questionMeaning } from "../../src/shared/apply-semantic";

const opts = (...labels: string[]) => labels.map((l) => ({ value: l, label: l }));
const pick = (labels: string[], answer: string, domain: Parameters<typeof matchOptionSemantic>[2] = "generic") => matchOptionSemantic(opts(...labels), answer, domain)?.label ?? null;

describe("semantic option matching", () => {
  it("phone type: Mobile means mobile, never work/home/fax/VoIP", () => {
    for (const o of ["Mobile Phone", "Cellular", "Cell Phone", "Personal Mobile", "Mobile"]) expect(pick([o, "Home Phone", "Work Phone", "Fax"], "Mobile", "phone_type")).toBe(o);
    expect(pick(["Home Phone", "Work Phone", "Fax", "VoIP"], "Mobile", "phone_type")).toBeNull();
    expect(pick(["Work Mobile", "Home"], "Mobile", "phone_type")).toBeNull(); // two meanings → never taken
    expect(pick(["Mobile", "Mobile Phone"], "Mobile", "phone_type")).toBe("Mobile"); // exact wins
    expect(pick(["Mobile Phone", "Cell Phone"], "Mobile", "phone_type")).toBeNull(); // ambiguous → ask
  });
  it("country, province and degree aliases are context-bound", () => {
    expect(pick(["United States of America", "CA", "Mexico"], "Canada", "country")).toBe("CA");
    expect(pick(["Canada (+1)", "United States of America (+1)"], "Canada", "country")).toBe("Canada (+1)");
    expect(pick(["ON", "QC", "BC"], "Ontario", "region")).toBe("ON");
    expect(pick(["Ontario", "Quebec"], "ON", "region")).toBe("Ontario");
    expect(pick(["Ontario", "Quebec"], "ON", "generic")).toBeNull(); // "ON" means nothing outside a province field
    expect(pick(["High School Diploma", "Bachelor's Degree", "Master's Degree"], "Bachelor", "degree")).toBe("Bachelor's Degree");
    expect(pick(["Undergraduate Bachelor's", "Graduate Master's"], "bachelor", "degree")).toBe("Undergraduate Bachelor's");
    expect(pick(["Associate Degree", "Diploma"], "College diploma", "degree")).toBeNull(); // two equivalents → ask
  });
  it("yes / no: aliases and leading words, but never a different meaning", () => {
    expect(pick(["Yes, I am", "No, I am not"], "Yes")).toBe("Yes, I am");
    expect(pick(["Affirmative", "Negative"], "Yes")).toBe("Affirmative");
    expect(pick(["No, I have not", "Yes, I have"], "No")).toBe("No, I have not");
    expect(pick(["Yes - permanent resident", "Yes - work permit", "No"], "Yes")).toBeNull(); // ambiguous
    expect(conceptsOf("yes_no", "Never")).toEqual([]); // "Never" is not a generic "No"
  });
  it("domains from labels", () => {
    expect(domainForLabel("Phone Device Type")).toBe("phone_type");
    expect(domainForLabel("Country Phone Code")).toBe("country");
    expect(domainForLabel("Province or Territory")).toBe("region");
    expect(domainForLabel("Highest level of education")).toBe("degree");
  });
});

describe("question meaning", () => {
  it("prior employment (incl. the real Workday wording) vs. look-alikes", () => {
    for (const q of [
      "Please indicate if you have worked with us before.",
      "Have you worked for this company before?",
      "Have you previously been employed by us?",
      "Are you a former employee of this company?",
      "Have you ever worked for our organization?",
      "Have you worked for Northwind Analytics before?",
    ])
      expect([q, questionMeaning(q, "Northwind Analytics Inc.").meaning]).toEqual([q, "prior_employment"]);
    expect(questionMeaning("Have you applied to this company before?").meaning).toBe("prior_application");
    expect(questionMeaning("Have you interviewed with us before?").meaning).toBe("prior_interview");
    expect(questionMeaning("Have you been a contractor here?").meaning).toBe("prior_contractor");
    expect(questionMeaning("Have you worked for an affiliated company?").meaning).toBe("prior_affiliate");
    expect(questionMeaning("Have you worked with our employees?").meaning).not.toBe("prior_employment");
    expect(questionMeaning("Have you provided services to our clients?").meaning).not.toBe("prior_employment");
    expect(questionMeaning("Have you previously worked with SQL?").meaning).not.toBe("prior_employment");
    expect(questionMeaning("Have you worked in a similar role?").meaning).not.toBe("prior_employment");
  });
  it("eligibility: authorization ≠ citizenship; sponsorship now vs. future; country captured", () => {
    expect(questionMeaning("Are you legally eligible to work in Canada?")).toMatchObject({ meaning: "work_authorization", country: "canada" });
    expect(questionMeaning("Are you a Canadian citizen?")).toMatchObject({ meaning: "citizenship", country: "canada" });
    expect(questionMeaning("Will you now or in the future require sponsorship for employment visa status?").meaning).toBe("sponsorship_future");
    expect(questionMeaning("Do you currently require visa sponsorship?").meaning).toBe("sponsorship_now");
  });
  it("students: enrolment, co-op, work-term requirement and placement length are different questions", () => {
    expect(questionMeaning("Are you currently enrolled in a university program?").meaning).toBe("enrolled_student");
    expect(questionMeaning("Are you enrolled in an accredited co-op program?").meaning).toBe("coop_program");
    expect(questionMeaning("Is this position part of your academic co-op requirement?").meaning).toBe("coop_term_required");
    expect(questionMeaning("Will you return to school after this placement?").meaning).toBe("return_to_school");
    expect(questionMeaning("Are you available for a four-month or eight-month placement?").meaning).toBe("placement_duration");
    expect(questionMeaning("What is your expected graduation date?").meaning).toBe("graduation_date");
    expect(questionMeaning("Is an internship mandatory for your degree?").meaning).toBe("internship_mandatory");
  });
  it("identity questions are recognised and never treated as ordinary questions", () => {
    for (const q of ["Do you identify as an Indigenous person (First Nations, Métis or Inuit)?", "Are you a member of a visible minority?", "Do you identify as a person with a disability?", "What is your sexual orientation?"])
      expect(questionMeaning(q)).toMatchObject({ meaning: "identity", sensitivity: "identity" });
  });
  it("declarations need approval every time", () => {
    for (const q of ["I certify that the information provided is true and complete", "Do you consent to a background check?", "Have you ever been convicted of a criminal offence?"]) expect(questionMeaning(q).approval).toBe(true);
  });
});
