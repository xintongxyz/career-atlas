// The runtime browser agent on an UNFAMILIAR synthetic site (tests/fixtures/patterns-fixture.ts
// "/pat/agent"): no Apply button, a pop-up, an "Onward" step, a self-identification question.
// A scripted proposer stands in for the GPT provider and reads ONLY the observation Career Atlas sends —
// as the model does. It also proposes forbidden actions on purpose; Career Atlas must refuse them.
// Fictional applicant; review mode — the submission happens only after the test approves it.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Proposer } from "../../src/local/apply/browser-agent";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { agentHook, runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
let fx: AtsFixture;
let resume: string;

const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 180_000);
const run = async (path: string, title: string) => {
  const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title, country: "Canada", original_url: `${fx.url}${path}` }, confirm_duplicate: true } })).body.id;
  return settled((await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
};

interface Obs {
  buttons: { ref: string; text: string; disabled?: boolean }[];
  fields: { ref: string; label: string; control: string; state: string; answer_on_file?: boolean; asked_applicant?: boolean }[];
  dialogs: string[];
}
/** Decides from the observation alone, like the model; logs what it received and proposed. */
function scripted(log: { sent: string[]; proposals: Record<string, unknown>[]; results: string[] }, opts: { askOffice?: boolean } = {}): Proposer {
  const tried = new Set<string>();
  return async (_system, user) => {
    log.sent.push(user);
    const u = JSON.parse(user) as { page: Obs; last_action_result: string };
    log.results.push(u.last_action_result);
    const p = u.page;
    const out = (o: Record<string, unknown>) => {
      const r = { reasoning: "scripted", ref: null, fact: null, option: null, checked: null, question: null, status: null, ...o };
      log.proposals.push(r);
      return r;
    };
    const btn = (re: RegExp) => p.buttons.find((b) => re.test(b.text) && !b.disabled);
    const field = (re: RegExp) => p.fields.find((f) => re.test(f.label));
    if (p.dialogs.length && btn(/^got it$/i)) return out({ action: "dismiss_dialog", ref: btn(/^got it$/i)!.ref });
    for (const [re, fact] of [[/given/i, "contact.first_name"], [/family/i, "contact.last_name"], [/e-?mail/i, "contact.email"]] as const) {
      const f = field(re);
      if (f && f.state === "empty") return out({ action: "fill_from_profile", ref: f.ref, fact });
    }
    const office = field(/office/i);
    if (office && office.state === "empty" && office.answer_on_file) return out({ action: "choose_from_profile", ref: office.ref, fact: "applicant_answer" });
    // Like the live model: the office is the applicant's choice — asked, and asked again while waiting.
    if (office && office.state === "empty" && opts.askOffice) return out({ action: "ask_user", ref: office.ref, question: "Which office?" });
    if (office && office.state === "empty") return out({ action: "choose_option", ref: office.ref, option: "Toronto" });
    const g = field(/gender/i);
    if (g && g.state === "empty" && !tried.has("gender")) {
      tried.add("gender");
      return out({ action: "choose_option", ref: g.ref, option: "Prefer not to say" }); // must be refused
    }
    const cv = p.fields.find((f) => f.control === "file");
    if (cv && cv.state === "empty") return out({ action: "upload_resume", ref: cv.ref });
    const submit = btn(/^submit application$/i);
    if (submit && !tried.has("submit")) {
      tried.add("submit");
      return out({ action: "click", ref: submit.ref }); // must be refused
    }
    if (submit) return out({ action: "finish", status: "review_ready" });
    const next = btn(/^(i'm interested|onward)$/i);
    if (next) return out({ action: "click", ref: next.ref });
    return out({ action: "finish", status: "blocked" });
  };
}

beforeAll(async () => {
  fx = await startAtsFixture();
  await api("/api/profile", { method: "PUT", json: { profile: { contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test" } } } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Alex.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Alex");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterEach(() => {
  agentHook.propose = null;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("runtime browser agent (synthetic unfamiliar site)", () => {
  it("without an AI provider the unfamiliar site is reported as unsupported (unchanged)", async () => {
    const a = await run("/pat/agent/1", "No agent");
    expect(a.error_code).toBe("unsupported_site");
    expect(fx.submissions.filter((s) => s.path === "/pat/agent/1/submit")).toEqual([]);
  }, 240_000);

  it("GPT opens the unfamiliar application; Career Atlas fills it, asks once, gets past an odd step, refuses forbidden actions, submits only on approval", async () => {
    const log = { sent: [] as string[], proposals: [] as Record<string, unknown>[], results: [] as string[] };
    agentHook.propose = scripted(log);
    // 1. "I'm interested" is chosen by the model (no Apply button); the application form is then filled by
    //    Career Atlas from My Profile; the office is not in the profile → asked with the site's own wording.
    let a = await run("/pat/agent/1", "Agent");
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["page_assessed", "apply_clicked", "application_entered", "form_found"]));
    expect(a).toMatchObject({ state: "needs_review", intervention: "missing_information" });
    const q = a.questions.find((x) => /office/i.test(x.label))!;
    expect(q).toMatchObject({ label: "Which office are you applying to? *", required: true });
    expect(q.options).toEqual(expect.arrayContaining(["Toronto", "Montreal"]));
    expect(a.filled.filter((f) => f.verified).map((f) => f.label)).toEqual(expect.arrayContaining(["Given name *", "Family name *", "E-mail address *"]));
    // 2. Answered → resumed: the unfamiliar "Onward" step is handled by the agent; identity and Submit refused.
    await api(`/api/apply/attempts/${a.id}/answers`, { method: "POST", json: { answers: { [q.key]: "Toronto" }, remember: [] } });
    a = await settled(a.id);
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["agent_started", "agent_verified", "agent_refused", "review_reached"]));
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    expect(log.results.some((r) => /^REFUSED: identity questions/.test(r))).toBe(true);
    expect(log.results.some((r) => /^REFUSED: the final submit button/.test(r))).toBe(true);
    // The model never saw the applicant's values — only labels, states and which facts exist.
    const sent = log.sent.join("\n");
    for (const v of ["Alex", "Rivera", "alex.rivera@example.test", "Resume_Alex"]) expect(sent).not.toContain(v);
    expect(fx.submissions.filter((s) => s.path === "/pat/agent/1/submit")).toEqual([]);
    // 3. Application-level approval: Career Atlas (not the model) clicks the application's own Submit.
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    expect(a.state).toBe("submitted_verified");
    const sub = fx.submissions.find((s) => s.path === "/pat/agent/1/submit")!;
    expect(sub.fields).toMatchObject({ given: "Alex", family: "Rivera", mail: "alex.rivera@example.test", office: "Toronto", gender: "" });
    expect(sub.files.map((f) => f.filename)).toEqual(["Resume_Alex.pdf"]);
  }, 400_000);

  it("a model that only proposes forbidden or invalid actions is stopped, nothing is submitted", async () => {
    agentHook.propose = async (_s, user) => {
      const p = (JSON.parse(user) as { page: Obs }).page;
      const b = p.buttons[0];
      return { reasoning: "x", action: "click", ref: b ? "b99999" : null, fact: null, option: null, checked: null, question: null, status: null };
    };
    const before = fx.submissions.length;
    const a = await run("/pat/agent/1?variant=bad", "Bad agent"); // its own URL: the posting above was submitted
    expect(a).toMatchObject({ state: "needs_review", intervention: "unexpected_page", error_code: "agent_failed_repeatedly" });
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["agent_refused", "agent_finished"]));
    expect(fx.submissions.length).toBe(before);
  }, 240_000);
});
