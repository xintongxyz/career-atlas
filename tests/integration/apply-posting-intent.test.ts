// Page intent on a job posting (regression for a real failure, reproduced on the SYNTHETIC site in
// tests/fixtures/posting-fixture.ts): the posting carries a job search, a "Get notified" e-mail sign-up
// with its own Submit, Save job and similar-jobs links. The application is reached only through Apply.
// Expected everywhere: Apply is the first action, no widget is touched, the application is entered and
// recognised, only its fields are filled, and the run stops before the application's own Submit.
// Fictional applicant; review mode.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { postingEvents } from "../fixtures/posting-fixture";
import { agentHook, runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
let fx: AtsFixture;
let resume: string;
const WIDGET_EVENTS = ["search_typed", "search_focused", "search_clicked", "subscribed", "manage_alerts", "save_job", "feedback"];

const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 180_000);
const run = async (v: string) => {
  const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind (synthetic)", title: "Product Analyst", country: "Canada", original_url: `${fx.url}/cw/job/1?v=${v}` }, confirm_duplicate: true } })).body.id;
  return settled((await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
};
const codes = (a: AttemptDTO) => a.steps.map((s) => s.code);
/** The application was entered, its form recognised, its own fields filled, and the run stopped at its Submit. */
function expectReachedReview(a: AttemptDTO) {
  expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
  const c = codes(a);
  for (const m of ["apply_clicked", "application_entered", "form_found", "review_reached"]) expect(c).toContain(m);
  // Apply came before anything was filled.
  expect(c.indexOf("apply_clicked")).toBeLessThan(c.indexOf("filled") === -1 ? Infinity : c.indexOf("filled"));
  const labels = a.filled.filter((f) => f.verified).map((f) => f.label);
  expect(labels).toEqual(expect.arrayContaining(["First Name *", "Last Name *", "Email address *", "Phone Number *"]));
  // Nothing outside the application was filled or recorded.
  expect(a.filled.some((f) => /search|notif|newsletter|feedback|name@example/i.test(f.label))).toBe(false);
  expect(postingEvents.filter((e) => WIDGET_EVENTS.includes(e))).toEqual([]);
  expect(fx.submissions.filter((s) => s.path.startsWith("/cw/"))).toEqual([]);
}

beforeAll(async () => {
  fx = await startAtsFixture();
  await api("/api/profile", { method: "PUT", json: { profile: { contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test", phone: "+1 416 555 0100" } } } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Alex.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Alex");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
beforeEach(() => {
  postingEvents.length = 0;
});
afterEach(() => {
  agentHook.propose = null;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("job posting with search and job-alert widgets (synthetic)", () => {
  for (const v of ["sidebar-first", "search-first", "late-apply", "newtab", "redirect", "iframe", "multi-submit"]) {
    it(`variant ${v}: Apply first, widgets untouched, application filled, stops at its own Submit`, async () => {
      expectReachedReview(await run(v));
    }, 240_000);
  }

  it("Apply that does nothing: reported as still on the posting — never filled, never ready to submit", async () => {
    const a = await run("dead");
    expect(a).toMatchObject({ state: "needs_review", intervention: "unexpected_page", error_code: "still_on_posting" });
    expect(codes(a)).toContain("posting_identified");
    expect(codes(a)).not.toContain("form_found");
    expect(a.filled).toEqual([]);
    expect(postingEvents.filter((e) => WIDGET_EVENTS.includes(e))).toEqual([]);
  }, 240_000);

  it("unfamiliar wording without an AI provider: not filled, not ready to submit", async () => {
    const a = await run("unfamiliar");
    expect(a.intervention).not.toBe("submit_approval");
    expect(a.filled).toEqual([]);
    expect(postingEvents.filter((e) => WIDGET_EVENTS.includes(e))).toEqual([]);
  }, 240_000);

  it("unfamiliar wording with the agent: widget actions refused, the start control chosen, application filled", async () => {
    const results: string[] = [];
    let n = 0;
    agentHook.propose = async (_s, user) => {
      const u = JSON.parse(user) as { last_action_result: string; page: { page_state: string; buttons: { ref: string; text: string; area?: string }[] } };
      results.push(u.last_action_result);
      const b = (re: RegExp) => u.page.buttons.find((x) => re.test(x.text));
      const out = (o: Record<string, unknown>) => ({ reasoning: "scripted", ref: null, fact: null, option: null, checked: null, question: null, status: null, ...o });
      n++;
      // Deliberately wrong first: the alert Submit, then the site search — Career Atlas must refuse both.
      if (n === 1) return out({ action: "click", ref: b(/^submit$/i)?.ref });
      if (n === 2) return out({ action: "click", ref: b(/^search$/i)?.ref });
      return out({ action: "click", ref: b(/interested/i)?.ref });
    };
    const a = await run("unfamiliar&x=agent"); // its own job address
    expect(results.some((r) => /REFUSED: .*job-alert/.test(r))).toBe(true);
    expect(results.some((r) => /REFUSED: .*job search/.test(r))).toBe(true);
    expect(codes(a)).toContain("page_assessed");
    expectReachedReview(a);
  }, 240_000);

  it("the original failure: Apply now, never the alert e-mail or its Submit; approval submits the application only", async () => {
    let a = await run("base");
    expectReachedReview(a);
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/approve`, { method: "POST" })).body.id);
    expect(a.state).toBe("submitted_verified");
    const sub = fx.submissions.filter((s) => s.path.startsWith("/cw/"));
    expect(sub.map((s) => s.path)).toEqual(["/cw/apply/1/submit"]);
    expect(sub[0].fields).toMatchObject({ first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test" });
    expect(sub[0].files.map((f) => f.filename)).toEqual(["Resume_Alex.pdf"]);
    expect(postingEvents).not.toContain("subscribed");
  }, 300_000);
});
