// Workday verification e-mails, read from the owner's Gmail (opt-in, Settings → Workday accounts).
//
//   - Access: IMAP over TLS (imap.gmail.com:993) with a Google *app password* the owner created and
//     pasted into Settings. The app password lives only in the macOS Keychain (service "Career Atlas –
//     Gmail app password"); never in Git, SQLite, config files, logs, API responses or process args.
//   - Read-only: mailboxes are opened with EXAMINE and messages fetched with BODY.PEEK, so nothing is
//     marked read, moved or deleted.
//   - Narrow: only messages received since the account step started, from a Workday sender (or with a
//     verification subject), are looked at; only a verification code or a verification link on the
//     employer's own Workday site is taken from them. Mail content is never stored or logged.
//   - Test / dev instances use an in-memory secret store and may point at a local fake server.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { SecretStore } from "./credentials";

export const GMAIL_SERVICE = "Career Atlas – Gmail app password";

export interface ImapTarget {
  host: string;
  port: number;
  /** false only for the synthetic server in tests (never allowed with the Keychain store). */
  secure: boolean;
}

export const GMAIL_IMAP: ImapTarget = { host: "imap.gmail.com", port: 993, secure: true };

export interface Verification {
  code: string | null;
  link: string | null;
}

// ---------------------------------------------------------------- minimal IMAP client (RFC 3501)

interface Record_ {
  /** The response line(s) with each literal replaced by \u0000<index>\u0000. */
  text: string;
  literals: Buffer[];
}

class ImapError extends Error {
  constructor(public code: "auth_failed" | "unreachable" | "protocol") {
    super(code);
  }
}

/** Quoted IMAP string (no CR/LF allowed). */
const qs = (s: string) => {
  if (/[\r\n\0]/.test(s)) throw new ImapError("protocol");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

export class Imap {
  private buf = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private closed = false;
  private seq = 0;

  private constructor(private sock: Socket) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.waiting?.();
    });
    const end = () => {
      this.closed = true;
      this.waiting?.();
    };
    sock.on("close", end);
    sock.on("error", end);
  }

  static async open(target: ImapTarget, timeoutMs = 20_000): Promise<Imap> {
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = target.secure ? tlsConnect({ host: target.host, port: target.port, servername: target.host }) : netConnect({ host: target.host, port: target.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new ImapError("unreachable"));
      }, timeoutMs);
      s.once(target.secure ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", () => {
        clearTimeout(timer);
        reject(new ImapError("unreachable"));
      });
    });
    sock.setTimeout(timeoutMs, () => sock.destroy());
    const c = new Imap(sock);
    const hello = await c.record(timeoutMs);
    if (!/^\* (OK|PREAUTH)/i.test(hello.text)) throw new ImapError("protocol");
    return c;
  }

  /** Next complete response record (handles {n} literals). */
  private async record(timeoutMs = 20_000): Promise<Record_> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = this.take();
      if (r) return r;
      if (this.closed || Date.now() > until) throw new ImapError("unreachable");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        this.waiting = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiting = null;
    }
  }

  private take(): Record_ | null {
    let pos = 0;
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const nl = this.buf.indexOf("\r\n", pos);
      if (nl < 0) return null;
      const line = this.buf.subarray(pos, nl).toString("latin1");
      const m = /\{(\d+)\}$/.exec(line);
      if (!m) {
        text += line;
        this.buf = this.buf.subarray(nl + 2);
        return { text, literals };
      }
      const n = Number(m[1]);
      if (this.buf.length < nl + 2 + n) return null;
      text += `${line.slice(0, m.index)}\u0000${literals.length}\u0000`;
      literals.push(Buffer.from(this.buf.subarray(nl + 2, nl + 2 + n)));
      pos = nl + 2 + n;
    }
  }

  /** Sends a command; resolves with the untagged records once the tagged OK arrives. */
  async cmd(command: string, timeoutMs = 30_000): Promise<Record_[]> {
    const tag = `C${++this.seq}`;
    this.sock.write(`${tag} ${command}\r\n`);
    const out: Record_[] = [];
    for (;;) {
      const r = await this.record(timeoutMs);
      if (r.text.startsWith(`${tag} `)) {
        const status = r.text.slice(tag.length + 1, tag.length + 4).toUpperCase();
        if (status === "OK ") return out;
        if (/^LOGIN|^AUTHENTICATE/i.test(command)) throw new ImapError("auth_failed");
        throw new ImapError("protocol");
      }
      out.push(r);
    }
  }

  async login(user: string, pass: string) {
    await this.cmd(`LOGIN ${qs(user)} ${qs(pass)}`);
  }

  async close() {
    try {
      if (!this.closed) await this.cmd("LOGOUT", 3000);
    } catch {
      /* closing anyway */
    }
    this.sock.destroy();
  }
}

// ---------------------------------------------------------------- MIME → text

const decodeQP = (s: string) => {
  const bytes: number[] = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
};

const charsetText = (b: Buffer, charset: string) => {
  try {
    return new TextDecoder(charset || "utf-8").decode(b);
  } catch {
    return b.toString("utf8");
  }
};

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

/** RFC 2047 encoded words in headers (=?utf-8?B?…?= / =?utf-8?Q?…?=). */
export function decodeHeader(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) => {
    const b = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : decodeQP(data.replace(/_/g, " "));
    return charsetText(b, cs);
  });
}

/** Text of all text/plain and text/html parts (raw message as latin1 string). */
export function messageText(raw: string, depth = 0): { plain: string; html: string } {
  const { headers, body } = splitHeaders(raw);
  const ct = headers["content-type"] ?? "text/plain";
  const out = { plain: "", html: "" };
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary && depth < 5) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const r = messageText(part.replace(/^\r?\n/, ""), depth + 1);
      out.plain += r.plain;
      out.html += r.html;
    }
    return out;
  }
  if (!/^text\/(plain|html)/i.test(ct)) return out;
  const cte = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const bytes = cte === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : cte === "quoted-printable" ? decodeQP(body) : Buffer.from(body, "latin1");
  const text = charsetText(bytes, /charset="?([^";]+)"?/i.exec(ct)?.[1] ?? "utf-8");
  if (/^text\/html/i.test(ct)) out.html += text;
  else out.plain += text;
  return out;
}

// ---------------------------------------------------------------- what counts as a Workday verification

const WORKDAY_HOST = /(^|\.)(myworkdayjobs\.com|myworkday\.com|myworkdaysite\.com|workday\.com)$/i;

/** A message worth opening: from Workday, or a verification subject. */
export function looksLikeWorkdayVerification(from: string, subject: string): boolean {
  return /workday/i.test(from) || /verif|activat|confirm (your )?(e-?mail|account)|one[- ]time|passcode|security code/i.test(subject);
}

const htmlToText = (h: string) =>
  h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ");

/**
 * The verification code or link in a Workday message for this employer site (`tenant` = host).
 * Links are taken only when they point at the employer's Workday site (or Workday's own domains)
 * and look like a verification/activation link.
 */
export function extractVerification(msg: { plain: string; html: string }, tenant: string): Verification {
  const urls = new Set<string>();
  for (const m of msg.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) urls.add(m[1].replace(/&amp;/g, "&"));
  for (const m of `${msg.plain}\n${msg.html}`.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) urls.add(m[0].replace(/&amp;/g, "&"));
  const links: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.host === tenant)) continue;
    const onSite = u.host.toLowerCase() === tenant.toLowerCase() || WORKDAY_HOST.test(u.hostname);
    if (!onSite || !/verif|activat|confirm|validat|token|passwordless/i.test(u.pathname + u.search)) continue;
    links.push(u.toString());
  }
  links.sort((a, b) => Number(new URL(b).host === tenant) - Number(new URL(a).host === tenant));
  const text = `${msg.plain}\n${htmlToText(msg.html)}`;
  let code: string | null = null;
  const near = /\b(?:verification|security|one[- ]time|confirmation|access)?\s*(?:code|passcode|pin)\b[^A-Za-z0-9\n]{0,20}(?:is\b)?[^A-Za-z0-9\n]{0,10}([A-Z0-9]{4,10})\b/gi;
  for (const m of text.matchAll(near)) {
    if (/\d/.test(m[1])) {
      code = m[1];
      break;
    }
  }
  if (!code && /\bcode\b/i.test(text)) {
    // A line holding only the code (common in HTML mails).
    const line = text.split(/\n/).map((l) => l.trim()).find((l) => /^[A-Z0-9]{4,10}$/.test(l) && /\d/.test(l) && !/^(19|20)\d\d$/.test(l));
    if (line) code = line;
  }
  return { code, link: links[0] ?? null };
}

// ---------------------------------------------------------------- the verifier used by the engine

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};

export type MailCheck = "ok" | "auth_failed" | "unreachable" | "not_configured";

export function mailVerifier(opts: { store: SecretStore | null; settings: () => { enabled: boolean; address: string | null }; target?: ImapTarget; pollMs?: number }) {
  let target = opts.target ?? GMAIL_IMAP;
  const store = opts.store;
  const addr = (fallback?: string | null) => (opts.settings().address || fallback || "").trim().toLowerCase();
  const password = async (address: string) => (store && address ? store.get(GMAIL_SERVICE, address) : null);

  const session = async (address: string): Promise<Imap> => {
    const pw = await password(address);
    if (!pw) throw new ImapError("auth_failed");
    if (!target.secure && store?.kind === "keychain") throw new ImapError("unreachable"); // never plain text with real mail
    const c = await Imap.open(target);
    try {
      await c.login(address, pw.replace(/\s+/g, ""));
    } catch (e) {
      await c.close();
      throw e;
    }
    return c;
  };

  /** One look through INBOX (and Spam) for a matching message received after `since`. */
  const look = async (c: Imap, boxes: string[], tenant: string, since: number): Promise<Verification | null> => {
    for (const box of boxes) {
      await c.cmd(`EXAMINE ${qs(box)}`);
      const found = (await c.cmd(`UID SEARCH SINCE ${imapDate(since - 86_400_000)}`)).flatMap((r) => (/^\* SEARCH\b/i.test(r.text) ? r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean) : []));
      const uids = found.map(Number).filter(Number.isFinite).sort((a, b) => a - b).slice(-30);
      if (!uids.length) continue;
      const heads = await c.cmd(`UID FETCH ${uids.join(",")} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])`);
      const candidates: { uid: number; at: number; workday: boolean }[] = [];
      for (const r of heads) {
        const uid = Number(/\bUID (\d+)/i.exec(r.text)?.[1]);
        const at = Date.parse((/INTERNALDATE "([^"]+)"/i.exec(r.text)?.[1] ?? "").trim().replace(/^(\d+)-(\w+)-(\d+) /, "$2 $1 $3 "));
        const size = Number(/RFC822\.SIZE (\d+)/i.exec(r.text)?.[1] ?? 0);
        const li = /\u0000(\d+)\u0000/.exec(r.text);
        const head = li ? splitHeaders(`${r.literals[Number(li[1])].toString("latin1")}\r\n\r\n`).headers : {};
        if (!uid || !Number.isFinite(at) || at < since - 120_000 || size > 3_000_000) continue;
        const from = decodeHeader(head.from ?? "");
        if (!looksLikeWorkdayVerification(from, decodeHeader(head.subject ?? ""))) continue;
        candidates.push({ uid, at, workday: /workday/i.test(from) });
      }
      for (const cand of candidates.sort((a, b) => b.at - a.at)) {
        const full = await c.cmd(`UID FETCH ${cand.uid} (BODY.PEEK[])`);
        for (const r of full) {
          const li = /\u0000(\d+)\u0000/.exec(r.text);
          if (!li) continue;
          const msg = messageText(r.literals[Number(li[1])].toString("latin1"));
          // Not from a Workday address: only when the message itself is about this employer's Workday site.
          if (!cand.workday && !`${msg.plain} ${msg.html}`.toLowerCase().includes(tenant.toLowerCase())) continue;
          const v = extractVerification(msg, tenant);
          if (v.code || v.link) return v;
        }
      }
    }
    return null;
  };

  return {
    get available() {
      return !!store;
    },
    storeKind: store?.kind ?? null,
    settings: opts.settings,
    address: addr,
    async configured(fallback?: string | null) {
      const a = addr(fallback);
      return opts.settings().enabled && !!a && !!(await password(a));
    },
    async hasPassword(address: string) {
      return !!(await password(address.trim().toLowerCase()));
    },
    async setPassword(address: string, pw: string) {
      if (!store) throw new Error("no_secret_store");
      await store.set(GMAIL_SERVICE, address.trim().toLowerCase(), pw.replace(/\s+/g, ""));
    },
    async deletePassword(address: string) {
      if (store) await store.delete(GMAIL_SERVICE, address.trim().toLowerCase());
    },
    /** Signs in and opens INBOX read-only. */
    async check(fallback?: string | null): Promise<MailCheck> {
      const a = addr(fallback);
      if (!a || !(await password(a))) return "not_configured";
      let c: Imap | null = null;
      try {
        c = await session(a);
        await c.cmd("EXAMINE INBOX");
        return "ok";
      } catch (e) {
        return e instanceof ImapError && e.code === "auth_failed" ? "auth_failed" : "unreachable";
      } finally {
        await c?.close();
      }
    },
    /**
     * Waits for the Workday verification message for `tenant` that arrived after `since`.
     * Returns null on timeout, when not configured, or when the mailbox can't be reached.
     */
    async waitForWorkday(o: { tenant: string; since: number; timeoutMs: number; fallbackAddress?: string | null; stop?: () => Promise<boolean> }): Promise<Verification | null> {
      if (!(await this.configured(o.fallbackAddress))) return null;
      const a = addr(o.fallbackAddress);
      let c: Imap | null = null;
      const until = Date.now() + o.timeoutMs;
      try {
        c = await session(a);
        const boxes = ["INBOX"];
        // Gmail's Spam folder, found by its special-use flag (its name is localised).
        for (const r of await c.cmd('LIST "" "*"')) {
          const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))/i.exec(r.text);
          if (m && /\\Junk/i.test(m[1])) boxes.push((m[2] ?? m[3]).replace(/\\(.)/g, "$1"));
        }
        while (Date.now() < until) {
          if (o.stop && (await o.stop())) return null;
          const v = await look(c, boxes, o.tenant, o.since);
          if (v) return v;
          await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
        }
        return null;
      } catch {
        return null;
      } finally {
        await c?.close();
      }
    },
    /** Tests only: point at a synthetic IMAP server. */
    _setTarget(t: ImapTarget) {
      target = t;
    },
  };
}

export type MailVerifier = ReturnType<typeof mailVerifier>;
