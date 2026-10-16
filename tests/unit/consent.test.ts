// Consent categories by what the text grants (src/shared/apply-semantic.ts › consentCategories).
import { describe, expect, it } from "vitest";
import { consentCategories } from "../../src/shared/apply-semantic";

describe("consent categories", () => {
  it("an interview-recording notice that also allows internal training is TWO categories", () => {
    const t = "To ensure we can focus fully on our conversation, we use BrightHire to record and transcribe interviews. This helps us get to know you better without taking notes, and recordings may be used internally to train our interviewers. Do you consent to having your interviews recorded?";
    expect(consentCategories(t).sort()).toEqual(["interview_recording", "recording_training"]);
    expect(consentCategories("We record video interviews so the hiring team can review them. Do you agree?")).toEqual(["interview_recording"]);
  });
  it("background checks, third-party sharing and binding terms are separate from routine notices", () => {
    expect(consentCategories("I authorize a background check, including criminal record and credit history.")).toContain("background_check");
    expect(consentCategories("We may share your information with our affiliates and partners for marketing purposes.")).toContain("third_party_sharing");
    expect(consentCategories("I agree to binding arbitration of any dispute.")).toContain("other_binding");
    expect(consentCategories("By signing below (e-signature) I accept the offer terms.")).toContain("other_binding");
  });
  it("routine notices and declarations", () => {
    expect(consentCategories("I have read and agree to the Candidate Privacy Notice.")).toEqual(["privacy_notice"]);
    expect(consentCategories("I agree to the application terms and conditions.")).toEqual(["routine_terms"]);
    expect(consentCategories("I certify that the information in this application is true and complete.")).toEqual(["accuracy_declaration"]);
    expect(consentCategories("I have read the information about this position.")).toEqual(["read_information"]);
  });
});
