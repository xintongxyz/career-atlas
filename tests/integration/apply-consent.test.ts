// Consents end to end on SYNTHETIC forms (tests/fixtures/consent-fixture.ts) with a fictional applicant:
// an approved routine privacy-policy consent is ticked on the SITE (where the site draws its box, with real
// events) and verified, without asking; consents outside the approval stay questions; an approved consent
// the site will not keep is shown as a control problem, never as a new approval. Review mode — every
// "submission" goes to the local fixture only.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Proposer } from "../../src/local/apply/browser-agent";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { agentHook, runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
let fx: AtsFixture;
let resume: string;

const PROFILE = {
  contact: { first_name: "Morgan", last_name: "Lee", email: "morgan.lee@example.test", phone: "+1 613 555 0123" },
  based_in: { city: "Ottawa", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "citizen" }],
};
const NO_STANDING = { read_information: false, routine_terms: false, accuracy_declaration: false, interview_recording: false, recording_training: false, background_check: false, third_party_sharing: false };

const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 300_000);
const run = async (variant: string, defaults: Record<string, unknown>) => {
  await api("/api/profile", { method: "PUT", json: { profile: { ...PROFILE, application_defaults: defaults } } });
  const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Example Co (synthetic)", title: `Analyst — ${variant}`, country: "Canada", original_url: `${fx.url}/consent/${variant}?n=${Math.random().toString(36).slice(2, 8)}` }, confirm_duplicate: true } })).body.id;
  return settled((await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
};
const approve = async (a: AttemptDTO) => settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
const posted = (path: string) => fx.submissions.filter((s) => s.path === path).at(-1)?.fields ?? null;
const asked = (a: AttemptDTO) => a.steps.filter((s) => s.code === "paused").map((s) => s.params?.reason);
const dbg = (a: AttemptDTO) => process.env.CA_APPLY_DEBUG && process.stderr.write(`ATT ${a.state} ${a.intervention} ${a.error_code} Q=${JSON.stringify(a.questions.map((q) => [q.label.slice(0, 60), q.reason, q.blocker, q.hint]))} F=${JSON.stringify(a.filled.map((f) => [f.label.slice(0, 40), f.source, f.verified]))} S=${JSON.stringify(a.steps.map((x) => x.code))}\n`);

beforeAll(async () => {
  fx = await startAtsFixture();
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Morgan.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Morgan");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  agentHook.propose = null;
  await fx?.close();
});

const PRIVACY_ON = { accept_privacy_notices: "yes", standing_consents: NO_STANDING };

describe.skipIf(!ready)("approved consents are executed on the site (synthetic)", () => {
  it("a privacy-policy checkbox the site hides under its own box: ticked where the box is drawn, verified, never asked", async () => {
    let a = await run("hidden", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    expect(a.questions).toEqual([]);
    expect(asked(a)).not.toContain("approval_needed");
    expect(a.filled.find((f) => /privacy policy/i.test(f.label))).toMatchObject({ verified: true });
    a = await approve(a);
    expect(posted("/consent/hidden/submit")).toMatchObject({ first_name: "Morgan", consent: "yes" });
  }, 300_000);

  it("privacy notices on, other categories off: the privacy consent is given, the accuracy certification is asked", async () => {
    const a = await run("mixed", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("approval_needed");
    expect(a.questions.map((q) => [q.reason, q.label])).toEqual([["legal", expect.stringMatching(/certify/i)]]);
    expect(a.questions[0].hint).toMatch(/not authorised: accuracy_declaration/);
    expect(a.filled.find((f) => /privacy policy/i.test(f.label))).toMatchObject({ verified: true });
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 300_000);

  it("not covered by a standing setting: asked once; once approved the same attempt ticks it and never asks again", async () => {
    let a = await run("hidden", { accept_privacy_notices: "no", standing_consents: NO_STANDING });
    dbg(a);
    expect(a.intervention).toBe("approval_needed");
    const q = a.questions[0];
    expect(q).toMatchObject({ reason: "legal", blocker: "authorization" });
    expect(q.hint).toMatch(/not authorised: privacy_notice/);
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/answers`, { method: "POST", json: { answers: { [q.key]: true } } })).body.id);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    expect(a.questions).toEqual([]);
    // Approval re-runs the attempt from the start: the recorded approval is applied to the site again.
    a = await approve(a);
    expect(posted("/consent/hidden/submit")).toMatchObject({ consent: "yes" });
  }, 400_000);

  it("a custom role=checkbox control that only reacts to real clicks", async () => {
    let a = await run("custom", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    a = await approve(a);
    expect(posted("/consent/custom/submit")).toMatchObject({ consent: "yes" });
  }, 300_000);

  it("a Yes / No dropdown: the affirmative option", async () => {
    let a = await run("select", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    a = await approve(a);
    expect(posted("/consent/select/submit")).toMatchObject({ privacy: "Yes" });
  }, 300_000);

  it("a site that re-renders and clears the consent once: ticked again and verified after it settles", async () => {
    let a = await run("rerender", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    a = await approve(a);
    expect(posted("/consent/rerender/submit")).toMatchObject({ consent: "yes" });
  }, 300_000);

  it("the application inside an embedded frame", async () => {
    let a = await run("iframe", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    a = await approve(a);
    expect(posted("/consent/iframe/frame/submit")).toMatchObject({ consent: "yes" });
  }, 300_000);

  it("the same consent on two steps: given on both, asked on neither", async () => {
    let a = await run("twostep", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("submit_approval");
    expect(asked(a)).toEqual(["submit_approval"]);
    a = await approve(a);
    expect(posted("/consent/twostep/submit")).toMatchObject({ consent_a: "yes", consent_b: "yes" });
  }, 300_000);

  it("a privacy policy bundled with binding arbitration is never given automatically", async () => {
    const a = await run("arbitration", PRIVACY_ON);
    dbg(a);
    expect(a.intervention).toBe("approval_needed");
    expect(a.questions[0]).toMatchObject({ reason: "legal" });
    expect(a.questions[0].hint).toMatch(/not authorised: other_binding/);
    expect(a.filled.some((f) => /arbitration/i.test(f.label))).toBe(false);
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 300_000);

  it("a box the site never keeps: shown as an approved consent the site would not keep — not as a new approval", async () => {
    const a = await run("reject", PRIVACY_ON);
    dbg(a);
    expect(a.questions.map((q) => [q.reason, q.blocker])).toEqual([["approved_not_kept", "interaction"]]);
    expect(asked(a)).not.toContain("approval_needed");
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 300_000);
});

/** Stands in for the AI: clicks the button that gives the (approved) consent, then moves on. */
const consentAgent: Proposer = async (_s, user) => {
  const u = JSON.parse(user) as { page: { buttons: { ref: string; text: string; consent?: string }[] } };
  const out = (o: Record<string, unknown>) => ({ reasoning: "scripted", ref: null, fact: null, option: null, checked: null, question: null, status: null, ...o });
  const agree = u.page.buttons.find((b) => /^agree$/i.test(b.text));
  if (agree) return out({ action: "click", ref: agree.ref });
  const next = u.page.buttons.find((b) => /^next$/i.test(b.text));
  if (next) return out({ action: "click", ref: next.ref });
  return out({ action: "finish", status: "blocked" });
};

describe.skipIf(!ready)("an unfamiliar consent control: the AI operates it within the approval (synthetic)", () => {
  it("an 'Agree' toggle rules cannot see — no AI: the step does not advance; AI: clicked, verified, continued", async () => {
    agentHook.propose = null;
    let a = await run("toggle", PRIVACY_ON);
    dbg(a);
    expect(a.error_code).toBe("step_not_advancing");
    agentHook.propose = consentAgent;
    try {
      a = await run("toggle", PRIVACY_ON);
      dbg(a);
      expect(a.steps.find((s) => s.code === "ai_takeover_result")?.params).toEqual({ result: "resolved" });
      expect(a.intervention).toBe("submit_approval");
      a = await approve(a);
    } finally {
      agentHook.propose = null;
    }
    expect(posted("/consent/toggle/submit")).toMatchObject({ consent: "yes" });
  }, 600_000);

  it("the same toggle WITHOUT the applicant's authorisation: the AI's click is refused by Career Atlas", async () => {
    agentHook.propose = consentAgent;
    let a: AttemptDTO;
    try {
      a = await run("toggle", { accept_privacy_notices: "no", standing_consents: NO_STANDING });
      dbg(a);
    } finally {
      agentHook.propose = null;
    }
    expect(a.steps.some((s) => s.code === "agent_refused" && /consent the applicant has not approved/.test(String(s.params?.reason)))).toBe(true);
    expect(a.intervention).not.toBe("submit_approval");
    await api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
  }, 600_000);
});
