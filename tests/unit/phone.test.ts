// The applicant's phone as a number in a country (src/shared/phone.ts). Fictional numbers only.
import { describe, expect, it } from "vitest";
import { canonicalPhone, phoneAccepted, phoneLayout, phoneValue } from "../../src/shared/phone";

// A national number that starts with "61" — the trap: typed without "+1" into an international widget it reads as Australia.
const ca = canonicalPhone("6135550147", { country: "加拿大" })!;

describe("canonical phone", () => {
  it("national digits + the applicant's country → E.164 with the right code", () => {
    expect(ca).toEqual({ e164: "+16135550147", cc: "1", national: "6135550147", country: "Canada" });
    expect(canonicalPhone("(613) 555-0147", { country: "Canada" })?.e164).toBe("+16135550147");
    expect(canonicalPhone("1-613-555-0147", { country: "Canada" })?.e164).toBe("+16135550147");
  });
  it("an explicit phone country code wins over the profile country; a '+' number carries its own", () => {
    expect(canonicalPhone("6135550147", { countryCode: "+1", country: "France" })?.e164).toBe("+16135550147");
    expect(canonicalPhone("+44 20 7946 0958", { country: "Canada" })).toMatchObject({ cc: "44", national: "2079460958", country: "United Kingdom" });
    expect(canonicalPhone("020 7946 0958", { country: "United Kingdom" })?.e164).toBe("+442079460958");
    expect(canonicalPhone("+1 613 555 0147", { country: "United States" })?.country).toBe("United States");
  });
  it("an extension is not part of the number", () => {
    expect(canonicalPhone("613-555-0147 ext. 7", { country: "Canada" })?.e164).toBe("+16135550147");
    expect(canonicalPhone("+1 613 555 0147 x12", {})?.e164).toBe("+16135550147");
  });
  it("no country → no canonical number (never guessed)", () => {
    expect(canonicalPhone("6135550147", {})).toBeNull();
  });
});

describe("which form a field takes", () => {
  it("separate country-code control → local digits; international widget → always E.164", () => {
    expect(phoneValue(ca, phoneLayout({ phone: { widget: "split", dial: "+1" } }, ca, null))).toBe("6135550147");
    expect(phoneValue(ca, phoneLayout({ phone: { widget: "intl", dial: "+61" } }, ca, "Canada"))).toBe("+16135550147");
    expect(phoneValue(ca, phoneLayout({ phone: { widget: "intl", dial: null } }, ca, "Canada"))).toBe("+16135550147");
    expect(phoneValue(ca, phoneLayout({ phone: { widget: "intl", dial: "+1" } }, ca, "Canada"))).toBe("+16135550147");
  });
  it("plain field: '+' placeholder or 'country code' → E.164; same-country job → local; abroad → E.164", () => {
    expect(phoneLayout({ placeholder: "+1 555 555 5555" }, ca, "Canada")).toBe("international");
    expect(phoneLayout({ label: "Phone (include country code)" }, ca, "Canada")).toBe("international");
    expect(phoneLayout({ placeholder: "(555) 555-5555" }, ca, "Canada")).toBe("national");
    expect(phoneLayout({}, ca, "United Kingdom")).toBe("international");
    expect(phoneLayout({}, ca, "United States")).toBe("national"); // same calling code (+1)
  });
});

describe("did the page keep THIS number", () => {
  it("accepts formatting, rejects another country", () => {
    for (const ok of ["+1 613-555-0147", "(613) 555-0147", "6135550147", "16135550147", "+16135550147", "001 613 555 0147"]) expect(phoneAccepted(ok, ca)).toBe(true);
    // The real failure mode: national digits read as +61 (Australia) by an international widget.
    expect(phoneAccepted("+61 3 5550 147", ca)).toBe(false);
    expect(phoneAccepted("+1 1 613 555 0147", ca)).toBe(false); // duplicated +1
    expect(phoneAccepted("555-0147", ca)).toBe(false); // a suffix is not the number
  });
  it("a code shown beside the number must be the applicant's", () => {
    expect(phoneAccepted("6135550147", ca, "+1")).toBe(true);
    expect(phoneAccepted("6135550147", ca, "+61")).toBe(false);
  });
});
