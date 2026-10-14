// Workday candidate accounts end to end, against the SYNTHETIC Workday site (tests/fixtures).
// The test instance uses an in-memory secret store — the real Keychain is never touched here.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const EMAIL = "casey.lin@example.test"; // fictional
const PROFILE = {
  contact: { first_name: "Casey", last_name: "Lin", email: EMAIL, phone: "+1 647 555 0101" },
  based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "citizen" }],
  application_defaults: { prior_employment: "no", phone_type: "mobile", source: "LinkedIn" },
};

let fx: AtsFixture;
let resume: string;
let tenant: string;
const logs: string[] = [];
const accounts = () => runtime.apply.accounts;

async function job(n: number, variant: string) {
  const url = `${fx.url}/wd/northwind/job/Toronto-ON/Analyst_R2${n}?variant=${variant}`;
  const r = await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title: `Analyst ${n}`, country: "Canada", original_url: url }, confirm_duplicate: true } });
  return r.body.id;
}
const start = (id: string, account_mode: "none" | "sign_in" | "create") => api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true, account_mode, entry_mode: "manual" } });
const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) ? a : null;
  }, 120_000);
const cancel = (a: AttemptDTO) => api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });

beforeAll(async () => {
  fx = await startAtsFixture();
  tenant = new URL(fx.url).host;
  for (const m of ["log", "warn", "error", "info"] as const) {
    const orig = console[m];
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    });
  }
  await api("/api/profile", { method: "PUT", json: { profile: PROFILE } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic resume Casey\n%%EOF\n")], "Casey_Lin.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Casey");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  await fx?.close();
});

describe.skipIf(!ready)("Workday accounts (synthetic site, in-memory secret store)", () => {
  it("creating an account is a separate, explicit authorization: registers with the profile e-mail and a generated password kept in the secret store", async () => {
    const id = await job(1, "login");
    let a = await settled((await start(id, "create")).body.id);
    expect(fx.workday.created).toEqual([EMAIL]);
    const stored = await accounts().password(tenant, EMAIL);
    expect(stored).toBeTruthy();
    expect(stored).toBe(fx.workday.accounts[EMAIL]); // the password Workday received is the one saved
    expect(stored!.length).toBeGreaterThanOrEqual(16);
    expect(accounts().record(tenant, EMAIL)).toMatchObject({ status: "created", mode: "unique" });
    expect(fx.workday.authTouched).not.toContain("beecatcher");
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["workday_account_creating", "workday_account_created", "workday_step"]));
    await cancel(a);

    // The browser session is reused for the next application on the same site (no new sign-in).
    const id2 = await job(2, "login");
    a = await settled((await start(id2, "sign_in")).body.id);
    expect(fx.workday.signIns).toEqual([]);
    expect(a.steps.map((s) => s.code)).toContain("workday_step");
    await cancel(a);
  }, 300_000);

  it("signs in with the saved credential when the session has expired; a wrong password is never retried automatically", async () => {
    fx.workday.signedIn = false;
    const id = await job(3, "login");
    let a = await settled((await start(id, "sign_in")).body.id);
    expect(fx.workday.signIns).toEqual([EMAIL]);
    expect(a.steps.map((s) => s.code)).toContain("workday_signed_in_auto");
    await cancel(a);

    // The password was changed on the site: one failed try, then a pause — and no second try later.
    fx.workday.signedIn = false;
    fx.workday.accounts[EMAIL] = "Changed-elsewhere-1!";
    const id2 = await job(4, "login");
    a = await settled((await start(id2, "sign_in")).body.id);
    expect(a).toMatchObject({ state: "needs_review", intervention: "login_required", error_code: "sign_in_failed" });
    expect(fx.workday.failures[EMAIL]).toBe(1);
    await cancel(a);
    const id3 = await job(5, "login");
    a = await settled((await start(id3, "sign_in")).body.id);
    expect(a).toMatchObject({ intervention: "login_required", error_code: "sign_in_failed_recently" });
    expect(fx.workday.failures[EMAIL]).toBe(1); // not retried: no lock-out
    await cancel(a);
  }, 300_000);

  it("account already exists → sign-in / recovery offered, no duplicate; registration agreements need approval; verification e-mail and CAPTCHA are handed over", async () => {
    // The saved credential is forgotten, but the site still has the account.
    await accounts().forget(tenant, EMAIL);
    fx.workday.signedIn = false;
    let a = await settled((await start(await job(6, "login"), "create")).body.id);
    expect(a).toMatchObject({ intervention: "login_required", error_code: "account_exists" });
    expect(await accounts().password(tenant, EMAIL)).toBeNull(); // the unused generated password is not kept
    expect(fx.workday.created).toEqual([EMAIL]);
    await cancel(a);

    // A registration form with an agreement: asked first, then registered.
    delete fx.workday.accounts[EMAIL];
    a = await settled((await start(await job(7, "login+terms"), "create")).body.id);
    expect(a.intervention).toBe("approval_needed");
    expect(a.questions[0]).toMatchObject({ key: `account_terms:${tenant}`, reason: "legal", label: expect.stringMatching(/Candidate Privacy Notice/) });
    expect(fx.workday.created).toEqual([EMAIL]); // nothing registered before approval
    a = await settled((await api<AttemptDTO>(`/api/apply/attempts/${a.id}/answers`, { method: "POST", json: { answers: { [`account_terms:${tenant}`]: true }, remember: [] } })).body.id);
    expect(fx.workday.created).toEqual([EMAIL, EMAIL]);
    expect(a.steps.map((s) => s.code)).toContain("workday_account_created");
    await cancel(a);

    // E-mail verification after registration.
    await accounts().forget(tenant, EMAIL);
    delete fx.workday.accounts[EMAIL];
    fx.workday.signedIn = false;
    a = await settled((await start(await job(8, "login+verify"), "create")).body.id);
    expect(a).toMatchObject({ intervention: "login_required", error_code: "verification_required" });
    expect(await accounts().password(tenant, EMAIL)).toBe(fx.workday.accounts[EMAIL]); // created: the password is kept
    await cancel(a);

    // CAPTCHA on registration: never bypassed.
    await accounts().forget(tenant, EMAIL);
    delete fx.workday.accounts[EMAIL];
    fx.workday.signedIn = false;
    a = await settled((await start(await job(9, "login+signupcaptcha"), "create")).body.id);
    expect(a.intervention).toBe("captcha");
    expect(await accounts().password(tenant, EMAIL)).toBeNull();
    await cancel(a);
  }, 400_000);

  it("shared-password mode: stored only in the secret store, never returned; the employer's password rules are respected", async () => {
    // The API validates and never echoes the password.
    expect((await api("/api/local/accounts/shared-password", { method: "PUT", json: { password: "Abcdef1!x", confirm: "different" } })).status).toBe(422);
    expect((await api("/api/local/accounts/shared-password", { method: "PUT", json: { password: "weakpassword", confirm: "weakpassword" } })).status).toBe(422);
    const ok = await api<Record<string, unknown>>("/api/local/accounts/shared-password", { method: "PUT", json: { password: "Shared-Pass-2026!", confirm: "Shared-Pass-2026!" } });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain("Shared-Pass-2026!");
    const view = await api<Record<string, unknown>>("/api/local/accounts");
    expect(view.body).toMatchObject({ shared_configured: true, store: "memory" });
    expect(JSON.stringify(view.body)).not.toMatch(/Shared-Pass|Changed-elsewhere/);
    await api("/api/local/accounts", { method: "PATCH", json: { password_mode: "shared" } });

    // A site whose rules the stored password does not meet → paused, nothing kept for that site.
    await accounts().setShared("weakpass"); // bypasses the API check on purpose
    await accounts().forget(tenant, EMAIL);
    delete fx.workday.accounts[EMAIL];
    fx.workday.signedIn = false;
    const a = await settled((await start(await job(10, "login"), "create")).body.id);
    expect(a).toMatchObject({ intervention: "login_required", error_code: "password_policy" });
    expect(fx.workday.accounts[EMAIL]).toBeUndefined();
    await cancel(a);
    await api("/api/local/accounts", { method: "PATCH", json: { password_mode: "unique" } });
    await api("/api/local/accounts/shared-password", { method: "DELETE" });
  }, 300_000);

  it("no password ever reaches logs, attempt records or the database", async () => {
    const secrets = ["Shared-Pass-2026!", "weakpass", "Changed-elsewhere-1!", ...Object.values(fx.workday.accounts)].filter(Boolean);
    const all = logs.join("\n");
    for (const s of secrets) expect(all).not.toContain(s);
    const dump = JSON.stringify((await runtime.env.DB.prepare("SELECT * FROM application_attempts").all()).results);
    const prof = JSON.stringify((await runtime.env.DB.prepare("SELECT * FROM user_profiles").all()).results);
    for (const s of secrets) {
      expect(dump).not.toContain(s);
      expect(prof).not.toContain(s);
    }
  });
});
