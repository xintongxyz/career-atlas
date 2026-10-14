// Gmail verification reader: MIME decoding, what is taken from a message, and the IMAP client
// against a synthetic server (read-only commands only). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryStore } from "../../src/local/apply/credentials";
import { decodeHeader, extractVerification, looksLikeWorkdayVerification, mailVerifier, messageText } from "../../src/local/apply/mail";
import { rawMessage, startImapFixture, type FakeMessage, type ImapFixture } from "../fixtures/imap-server";

const TENANT = "northwind.wd3.myworkdayjobs.com";
const USER = "casey.lin@example.test";
const APP_PW = "abcdefghijklmnop"; // fictional

describe("message parsing", () => {
  it("decodes multipart quoted-printable / base64 bodies and encoded headers", () => {
    const raw = rawMessage({ from: "x", subject: "Vérification", html: "<p>Code: <b>482913</b> — café</p>", text: "Your code is 482913 — café", at: Date.now() }, USER);
    const m = messageText(raw);
    expect(m.plain).toContain("482913 — café");
    expect(m.html).toContain("<b>482913</b>");
    expect(decodeHeader("=?utf-8?B?VsOpcmlmaWNhdGlvbg==?=")).toBe("Vérification");
    expect(decodeHeader("=?UTF-8?Q?Caf=C3=A9_code?=")).toBe("Café code");
  });

  it("takes the code next to the word “code”, never a year or an address number", () => {
    expect(extractVerification({ plain: "Your verification code is: 482913. Office: 2024 Example Street.", html: "" }, TENANT).code).toBe("482913");
    expect(extractVerification({ plain: "", html: "<p>Your verification code is:</p><p><b>A7K29Q</b></p>" }, TENANT).code).toBe("A7K29Q");
    expect(extractVerification({ plain: "Thanks for applying in 2026. Code of conduct attached.", html: "" }, TENANT).code).toBeNull();
  });

  it("takes only verification links on the employer's Workday site", () => {
    const html = `<a href="https://evil.example.test/verify?t=1">Verify</a> <a href="https://${TENANT}/en-US/Northwind/activate/abc123?redirect=x&amp;y=1">Verify Account</a> <a href="https://${TENANT}/en-US/Northwind/help">Help</a>`;
    expect(extractVerification({ plain: "", html }, TENANT).link).toBe(`https://${TENANT}/en-US/Northwind/activate/abc123?redirect=x&y=1`);
    expect(extractVerification({ plain: "https://evil.example.test/verify?t=2", html: "" }, TENANT).link).toBeNull();
    expect(extractVerification({ plain: `http://${TENANT}/activate/abc`, html: "" }, TENANT).link).toBeNull(); // not https
  });

  it("only Workday senders or verification subjects are opened", () => {
    expect(looksLikeWorkdayVerification("Northwind <northwind@workday.example.test>", "Welcome")).toBe(true);
    expect(looksLikeWorkdayVerification("Bank <alerts@bank.example.test>", "Your statement")).toBe(false);
    expect(looksLikeWorkdayVerification("someone@example.test", "Verify your candidate account")).toBe(true);
  });
});

describe("IMAP (synthetic server)", () => {
  let fx: ImapFixture;
  const now = Date.now();
  const messages: FakeMessage[] = [
    { from: "Bank <alerts@bank.example.test>", subject: "Your security code", html: "<p>Your security code is 999111</p>", text: "Your security code is 999111", at: now - 1000 },
    { from: "Northwind Analytics <northwind@workday.example.test>", subject: "Your verification code", html: "<p>Your verification code is:</p><p><b>111222</b></p>", text: "Your verification code is: 111222", at: now - 3 * 3600_000 }, // too old
  ];
  const store = memoryStore();
  let enabled = true;
  const mail = mailVerifier({ store, settings: () => ({ enabled, address: USER }), pollMs: 200 });

  beforeAll(async () => {
    fx = await startImapFixture({ user: USER, password: APP_PW, messages: () => messages });
    mail._setTarget({ host: "127.0.0.1", port: fx.port, secure: false });
  });
  afterAll(() => fx?.close());

  it("not configured → nothing is read", async () => {
    expect(await mail.check()).toBe("not_configured");
    expect(await mail.waitForWorkday({ tenant: TENANT, since: now - 60_000, timeoutMs: 500 })).toBeNull();
    expect(fx.commands).toEqual([]);
  });

  it("wrong app password → auth_failed; right one → ok", async () => {
    await mail.setPassword(USER, "wrongwrongwrongw");
    expect(await mail.check()).toBe("auth_failed");
    await mail.setPassword(USER, "abcd efgh ijkl mnop"); // pasted with spaces, as Google shows it
    expect(await mail.check()).toBe("ok");
  });

  it("finds the new Workday message (also in Spam), ignores old and non-Workday mail, and only reads", async () => {
    // Nothing new yet: times out.
    expect(await mail.waitForWorkday({ tenant: TENANT, since: now - 60_000, timeoutMs: 800 })).toBeNull();
    setTimeout(() => messages.push({ from: "Northwind Analytics <northwind@workday.example.test>", subject: "Your verification code", html: "<p>Your verification code is:</p><p><b>604381</b></p>", text: "Your verification code is: 604381", at: Date.now(), box: "Spam" }), 300);
    const v = await mail.waitForWorkday({ tenant: TENANT, since: now - 60_000, timeoutMs: 5000 });
    expect(v).toEqual({ code: "604381", link: null });
    const verbs = new Set(fx.commands.map((c) => c.split(" ")[0]));
    expect([...verbs].sort()).toEqual(["EXAMINE", "LIST", "LOGIN", "LOGOUT", "UID"]);
    expect(fx.commands.filter((c) => c.startsWith("UID FETCH") && !/BODY\.PEEK/.test(c))).toEqual([]);
    expect(fx.commands.some((c) => /STORE|COPY|EXPUNGE|SELECT/.test(c))).toBe(false);
  });

  it("turned off in Settings → not read even with a saved password", async () => {
    enabled = false;
    const before = fx.commands.length;
    expect(await mail.waitForWorkday({ tenant: TENANT, since: now - 60_000, timeoutMs: 500 })).toBeNull();
    expect(fx.commands.length).toBe(before);
    enabled = true;
  });

  it("refuses plain-text IMAP with the real Keychain store", async () => {
    const fakeKeychain = { ...memoryStore(), kind: "keychain" as const };
    await fakeKeychain.set("Career Atlas – Gmail app password", USER, APP_PW);
    const m = mailVerifier({ store: fakeKeychain, settings: () => ({ enabled: true, address: USER }) });
    m._setTarget({ host: "127.0.0.1", port: fx.port, secure: false });
    expect(await m.check()).toBe("unreachable");
  });
});
