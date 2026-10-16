// A Dayforce-style employer portal end to end, against the SYNTHETIC site in
// tests/fixtures/dayforce-fixture.ts (fictional applicant, no real employer contacted).
// Covers: posting → Apply → guest application; Ant-style selects (value shown beside an empty search
// input, duplicated options, long lists that need typing, read-only selects, State enabled by
// Country, flag-prefixed dialing codes); Preferred Contact Method = Email from Application Defaults;
// sections saved with their own Update button; several employment and education rows (Update →
// summary → Add); an informational pop-up; a privacy-consent dialog (paused for approval, then
// accepted); Questionnaire; stop before Submit.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const PROFILE = {
  contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test", phone: "+1 647 555 0123", address: "1 Example Street", postal_code: "M5V 1A1" },
  // Written in Chinese on purpose: the form is English (My Profile may be in either language).
  based_in: { city: "Toronto", region: "安大略省", country: "加拿大" },
  work_authorization: [{ country: "Canada", status: "citizen" }],
  experience: [
    { title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: [] },
    { title: "Research Assistant", organization: "Example Institute", start: "2022-09", end: "2023-08", current: false, areas: [] },
  ],
  education: [
    { level: "master", field: "Statistics", institution: "University of Northfield", country: "Canada", completed: false, year: 2026 },
    { level: "bachelor", field: "Economics and Statistics", institution: "Southern University of Foreign Studies", country: "China", completed: true, year: 2022 },
  ],
  application_defaults: { phone_type: "mobile", preferred_contact_method: "email", source: "LinkedIn", prior_employment: "no" },
};

let fx: AtsFixture;
let resume: string;
const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 240_000).catch(async (e) => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    console.log("TIMEOUT", a.state, a.stage, a.steps.slice(-20).map((x) => x.code).join(" | "));
    throw e;
  });
const answer = (id: string, answers: Record<string, unknown>) => api<AttemptDTO>(`/api/apply/attempts/${id}/answers`, { method: "POST", json: { answers, remember: [] } });

beforeAll(async () => {
  fx = await startAtsFixture();
  await api("/api/profile", { method: "PUT", json: { profile: PROFILE } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic resume Alex\n%%EOF\n")], "Resume_Alex.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Alex");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("Dayforce-style portal (synthetic)", () => {
  it("guest application filled from My Profile through every step; consent asked once; stops before Submit", async () => {
    const url = `${fx.url}/dayforce/en-US/northwind/CANDIDATEPORTAL/jobs/10001`;
    const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title: "Product Analyst", country: "Canada", original_url: url }, confirm_duplicate: true } })).body.id;
    let a = await settled((await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
    if (process.env.CA_APPLY_DEBUG) console.log("DF1", a.state, a.intervention, a.error_code, JSON.stringify(a.questions.map((q) => [q.key, q.reason, q.label.slice(0, 60)])), a.steps.map((s) => s.code).join(" | "), JSON.stringify(a.filled.filter((f) => !f.verified)), JSON.stringify(fx.dayforce.nexts));
    // Candidate Info passed on the first Next (personal info saved with Update, rows saved, resume attached).
    expect(fx.dayforce.nexts[0]).toMatchObject({ step: "info", ok: true });
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["notice_acknowledged"]));
    // The privacy notice is the only question: a consent needs the user (no standing permission yet).
    expect(a).toMatchObject({ state: "needs_review", intervention: "approval_needed" });
    expect(a.questions).toHaveLength(1);
    expect(a.questions[0]).toMatchObject({ reason: "legal", meaning: "privacy_notice" });
    expect(fx.dayforce.submissions).toEqual([]);

    // Approved → the run continues to the Submit step and waits for submit approval.
    a = await settled((await answer(a.id, { [a.questions[0].key]: true })).body.id);
    if (process.env.CA_APPLY_DEBUG) console.log("DF2", a.state, a.intervention, a.error_code, JSON.stringify(a.questions.map((q) => [q.key, q.reason])), JSON.stringify(fx.dayforce.nexts));
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    expect(fx.dayforce.submissions).toEqual([]); // nothing submitted without approval

    // Continued in a visible window: the Submit step's "Thank you for your interest." and the site's
    // background requests are NOT a confirmation — nothing may be recorded as submitted.
    await api<AttemptDTO>(`/api/apply/attempts/${a.id}/visible`, { method: "POST" });
    // Wait until the (simulated) window has handed over and ended again.
    a = await waitFor(async () => {
      const x = (await api<AttemptDTO>(`/api/apply/attempts/${a.id}`)).body;
      return x.state === "submitted_verified" || (x.state === "needs_review" && x.steps.some((st, i) => i > 0 && st.code === "manual_handoff") && x.intervention !== "manual_in_browser") ? x : null;
    }, 240_000);
    expect(a.state).not.toBe("submitted_verified");
    expect(a.intervention).toBe("submit_approval");
    expect(fx.dayforce.submissions).toEqual([]);

    // Synthetic only: approve to inspect exactly what the form held at Submit.
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    const sub = fx.dayforce.submissions[0] as { V: Record<string, string>; work: Record<string, unknown>[]; edu: Record<string, unknown>[]; q: Record<string, string>; files: string[] };
    expect(sub.V).toMatchObject({ pi_email: "alex.rivera@example.test", pi_confirm: "alex.rivera@example.test", pi_first: "Alex", pi_last: "Rivera", pi_contact: "Email", rc_select_0: "🇨🇦 +1 Canada", pi_country: "Canada", pi_state: "Ontario", pi_source: "Linkedin" });
    expect(sub.work.map((w) => [w.title, w.company, w.editing])).toEqual([["Data Analyst", "Fabrikam", false], ["Research Assistant", "Example Institute", false]]);
    expect(sub.work[0]).toMatchObject({ current: true, start: "2024-06-01" });
    expect(sub.work[1]).toMatchObject({ current: false, start: "2022-09-01", end: "2023-08-01" });
    expect(sub.edu.map((e) => [e.school, e.degree, e.major, e.notCompleted, e.country])).toEqual([
      ["University of Northfield", "Master's Degree", "Statistics", true, "Canada"],
      ["Southern University of Foreign Studies", "Bachelor's Degree", "Economics and Statistics", false, "China"],
    ]);
    expect(sub.edu.every((e) => !e.start)).toBe(true); // never a made-up start date
    expect(sub.q.auth).toBe("Yes");
    expect(sub.files).toEqual(["Resume_Alex.pdf"]);
  }, 600_000);
});
