// Fictional applicants for the lab (tests/lab). No real person's data.
// LAB_CA's national number starts with "61" on purpose: typed without "+1" into an international phone
// widget it is read as Australia (+61) — the failure the lab must catch.
export const LAB_CA = {
  contact: {
    first_name: "Maya",
    last_name: "Okafor",
    email: "maya.okafor@example.test",
    phone: "6135550147",
    address: "100 Queen St W",
    postal_code: "M5H 2N2",
    linkedin_url: "https://www.linkedin.com/in/maya-okafor-example",
  },
  based_in: { city: "Toronto", region: "安大略省", country: "加拿大" },
  application_defaults: { phone_type: "mobile", preferred_contact_method: "email" },
  work_authorization: [{ country: "Canada", status: "citizen" }],
  education: [{ level: "master", field: "Statistics", institution: "University of Northfield", completed: true, year: 2024, start: "2022-09", end: "2024-05" }],
  experience: [{ title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: [] }],
  skills: ["SQL", "Python", "Tableau"],
} as const;

export const LAB_UK = {
  contact: {
    first_name: "Oliver",
    last_name: "Hart",
    email: "oliver.hart@example.test",
    phone: "+44 20 7946 0958",
    address: "221 Example Road",
    postal_code: "NW1 6XE",
  },
  based_in: { city: "London", region: "England", country: "United Kingdom" },
  application_defaults: { phone_type: "mobile", preferred_contact_method: "email" },
  work_authorization: [{ country: "Canada", status: "work_permit" }],
  education: [{ level: "bachelor", field: "Economics", institution: "Example College", completed: true, year: 2021, start: "2018-09", end: "2021-06" }],
  experience: [{ title: "Analyst", organization: "Contoso", start: "2021-09", current: true, areas: [] }],
  skills: ["Excel", "SQL"],
} as const;

export type LabProfile = typeof LAB_CA | typeof LAB_UK;
/** The canonical answers the grader expects for each applicant. */
export const EXPECT = {
  ca: { e164: "+16135550147", national: "6135550147", cc: "1", country: "Canada", ccOption: "CAN_1", province: "ON", countryIso: "CA", city: "Toronto", postal: "M5H 2N2", street: "100 Queen St W" },
  uk: { e164: "+442079460958", national: "2079460958", cc: "44", country: "United Kingdom", ccOption: "GBR_44", province: "ENG", countryIso: "GB", city: "London", postal: "NW1 6XE", street: "221 Example Road" },
} as const;
