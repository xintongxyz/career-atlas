// Career sites that need a candidate account (SuccessFactors-like pattern, SYNTHETIC — see
// tests/fixtures/ats-server.ts "/sf/"): a hidden duplicate "Apply now", a redirect while the page is
// being read, a sign-in form drawn by script after a delay. Expected: never "unsupported site"; with a
// saved password (in-memory secret store) and sign-in allowed → signed in once and the form filled;
// a rejected password is never retried.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const EMAIL = "alex.rivera@example.test";
let fx: AtsFixture;
let resume: string;
let host: string;

const job = async (title: string) =>
  (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title, country: "Canada", original_url: `${fx.url}/sf/job/1` }, confirm_duplicate: true } })).body.id;
const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 180_000);
const start = async (title: string, account_mode: "none" | "sign_in") => settled((await api<AttemptDTO>(`/api/jobs/${await job(title)}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true, account_mode } })).body.id);

beforeAll(async () => {
  fx = await startAtsFixture();
  host = new URL(fx.url).host;
  await api("/api/profile", { method: "PUT", json: { profile: { contact: { first_name: "Alex", last_name: "Rivera", email: EMAIL } } } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Alex.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Alex");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("career sites that need an account (synthetic)", () => {
  it("no saved password → paused for sign-in (never 'unsupported site'), nothing typed", async () => {
    const a = await start("Pricing Analyst A", "none");
    expect(a).toMatchObject({ state: "needs_review", intervention: "login_required" });
    expect(fx.sfSignIns).toEqual([]);
  }, 240_000);

  it("saved password + sign-in allowed → signs in once, fills the form, stops before Submit", async () => {
    await runtime.apply.accounts.save(host, EMAIL, "Synthetic-Pass-9!", "unique", "created");
    const a = await start("Pricing Analyst B", "sign_in");
    expect(fx.sfSignIns).toEqual(["ok"]);
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["sign_in_attempt", "signed_in_auto"]));
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    expect(fx.submissions.filter((s) => s.path === "/sf/submit")).toEqual([]);
  }, 240_000);

  it("a rejected password is recorded and never retried", async () => {
    await runtime.apply.accounts.forget(host, EMAIL);
    await runtime.apply.accounts.save(host, EMAIL, "Wrong-Pass-1!", "unique", "created");
    let a = await start("Pricing Analyst C", "sign_in");
    if (process.env.CA_APPLY_DEBUG) process.stderr.write(`C ${a.state} ${a.intervention} ${a.error_code} ${a.steps.map((x) => x.code).join("|")} ${JSON.stringify(fx.sfSignIns)}\n`);
    expect(a).toMatchObject({ intervention: "login_required", error_code: "sign_in_failed" });
    expect(fx.sfSignIns).toEqual(["ok", "rejected"]);
    a = await start("Pricing Analyst D", "sign_in");
    expect(a.intervention).toBe("login_required");
    expect(fx.sfSignIns).toEqual(["ok", "rejected"]); // not tried again
  }, 300_000);
});
