// Workday verification e-mails and slow Workday pages, end to end, against SYNTHETIC servers only:
// the synthetic Workday site (tests/fixtures/workday-fixture.ts) and a synthetic IMAP server standing
// in for Gmail (tests/fixtures/imap-server.ts). The test instance uses the in-memory secret store.
import type { AttemptDTO } from "@shared/apply";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { startImapFixture, type ImapFixture } from "../fixtures/imap-server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
const EMAIL = "riley.chen@example.test"; // fictional
const APP_PW = "qwertyuiopasdfgh"; // fictional
const PROFILE = {
  contact: { first_name: "Riley", last_name: "Chen", email: EMAIL, phone: "+1 647 555 0199" },
  based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
  work_authorization: [{ country: "Canada", status: "citizen" }],
  education: [{ level: "master", field: "Statistics", institution: "Example University", country: "Canada", completed: true, year: 2024 }],
  experience: [{ title: "Data Analyst", organization: "Fabrikam", start: "2024-06", current: true, areas: ["analytics"] }],
  application_defaults: { prior_employment: "no", phone_type: "mobile", source: "LinkedIn" },
};

let fx: AtsFixture;
let imap: ImapFixture;
let resume: string;
const logs: string[] = [];

async function job(n: number, variant: string) {
  const url = `${fx.url}/wd/northwind/job/Toronto-ON/Analyst_R3${n}?variant=${variant}`;
  const r = await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title: `Analyst ${n}`, country: "Canada", original_url: url }, confirm_duplicate: true } });
  return r.body.id;
}
const start = (id: string, account_mode: "none" | "sign_in" | "create") => api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true, account_mode, entry_mode: "autofill" } });
const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 240_000);
const cancel = (a: AttemptDTO) => api(`/api/apply/attempts/${a.id}/cancel`, { method: "POST" });
const codes = (a: AttemptDTO) => a.steps.map((s) => s.code);

beforeAll(async () => {
  fx = await startAtsFixture();
  imap = await startImapFixture({ user: EMAIL, password: APP_PW, messages: () => fx.workday.outbox.map((m) => ({ ...m })) });
  runtime.apply.mail!._setTarget({ host: "127.0.0.1", port: imap.port, secure: false });
  for (const m of ["log", "warn", "error", "info"] as const) {
    const orig = console[m];
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    });
  }
  await api("/api/profile", { method: "PUT", json: { profile: PROFILE } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic resume Riley\n%%EOF\n")], "Riley_Chen.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Riley");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  await fx?.close();
  await imap?.close();
});

describe.skipIf(!ready)("Workday verification e-mail via Gmail (synthetic IMAP) and slow pages", () => {
  it("Settings: the app password is validated, kept in the secret store and never returned", async () => {
    let v = await api<Record<string, unknown>>("/api/local/mail");
    expect(v.body).toMatchObject({ enabled: false, password_saved: false, profile_email: EMAIL, effective_address: EMAIL });
    expect((await api("/api/local/mail", { method: "PUT", json: { app_password: "short" } })).status).toBe(422);
    v = await api<Record<string, unknown>>("/api/local/mail", { method: "PUT", json: { app_password: "qwer tyui opas dfgh", enabled: true } });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ enabled: true, password_saved: true });
    expect(JSON.stringify(v.body)).not.toContain(APP_PW);
    expect((await api<{ result: string }>("/api/local/mail/check", { method: "POST" })).body.result).toBe("ok");
  });

  it("new account → verification code e-mailed → read from the mailbox and entered → Autofill continues", async () => {
    const a = await settled((await start(await job(1, "login+verify"), "create")).body.id);
    expect(fx.workday.created).toContain(EMAIL);
    expect(fx.workday.verified).toContain(EMAIL);
    expect(codes(a)).toEqual(expect.arrayContaining(["workday_account_created", "workday_mail_waiting", "workday_email_verified", "uploaded_resume", "workday_step"]));
    expect(a.steps.find((s) => s.code === "workday_email_verified")?.params).toEqual({ via: "code" });
    expect(a.state).not.toBe("failed");
    // The code itself is never recorded.
    const code = /\b(\d{6})\b/.exec(fx.workday.outbox.at(-1)!.text)![1];
    expect(JSON.stringify(a)).not.toContain(code);
    expect(imap.commands.some((c) => /STORE|COPY|EXPUNGE|SELECT/.test(c))).toBe(false);
    await cancel(a);
  }, 300_000);

  it("verification link → opened on the employer's site → signed in again → Autofill restored after Workday dropped it", async () => {
    await runtime.apply.accounts.forget(new URL(fx.url).host, EMAIL);
    delete fx.workday.accounts[EMAIL];
    fx.workday.signedIn = false;
    const a = await settled((await start(await job(2, "login+verifylink+losemode"), "create")).body.id);
    expect(fx.workday.verified.filter((e) => e === EMAIL).length).toBe(2);
    expect(fx.workday.signIns).toContain(EMAIL);
    expect(a.steps.find((s) => s.code === "workday_email_verified")?.params).toEqual({ via: "link" });
    expect(codes(a)).toEqual(expect.arrayContaining(["workday_signed_in_auto", "workday_autofill_resumed", "uploaded_resume"]));
    expect(a.state).not.toBe("failed");
    await cancel(a);
  }, 300_000);

  it("Gmail turned off → the verification step is handed to the user, nothing is read", async () => {
    await api("/api/local/mail", { method: "PUT", json: { enabled: false } });
    await runtime.apply.accounts.forget(new URL(fx.url).host, EMAIL);
    delete fx.workday.accounts[EMAIL];
    fx.workday.signedIn = false;
    const before = imap.commands.length;
    const a = await settled((await start(await job(3, "login+verify"), "create")).body.id);
    expect(a).toMatchObject({ intervention: "login_required", error_code: "verification_required" });
    expect(imap.commands.length).toBe(before);
    await cancel(a);
    await api("/api/local/mail", { method: "PUT", json: { enabled: true } });
  }, 300_000);

  it("slow resume parsing (Continue disabled > 15 s) and forms drawn late: waits instead of failing", async () => {
    fx.workday.signedIn = true;
    const uploads = fx.workday.uploads.length;
    const a = await settled((await start(await job(4, "slowparse+slowrender"), "none")).body.id);
    expect(a.state).toBe("needs_review");
    expect(a.error_code ?? null).not.toBe("timeout");
    expect(fx.workday.uploads.length).toBe(uploads + 1);
    // It reached the parsed form and filled it (not an empty page clicked through).
    const steps = a.steps.filter((s) => s.code === "workday_step").map((s) => s.params?.step);
    expect(steps).toEqual(expect.arrayContaining(["My Information", "My Experience"]));
    expect(a.filled.length).toBeGreaterThan(3);
    await cancel(a);
  }, 300_000);

  it("Settings: an existing password can be saved for a site; it is never returned", async () => {
    const r = await api<Record<string, unknown>>("/api/local/accounts/existing", { method: "PUT", json: { site: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/x", email: EMAIL, password: "My-Own-Pass-1!" } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("My-Own-Pass-1!");
    expect(await runtime.apply.accounts.password("acme.wd5.myworkdayjobs.com", EMAIL)).toBe("My-Own-Pass-1!");
    expect((r.body as { accounts: { tenant: string }[] }).accounts.map((x) => x.tenant)).toContain("acme.wd5.myworkdayjobs.com");
  });

  it("no app password, code or account password reaches the logs or the database", async () => {
    const secrets = [APP_PW, "My-Own-Pass-1!", ...Object.values(fx.workday.accounts), ...fx.workday.outbox.map((m) => /\b(\d{6})\b/.exec(m.text)?.[1]).filter(Boolean)] as string[];
    const all = logs.join("\n");
    const dump = JSON.stringify((await runtime.env.DB.prepare("SELECT * FROM application_attempts").all()).results);
    for (const s of secrets) {
      expect(all).not.toContain(s);
      expect(dump).not.toContain(s);
    }
  });
});
