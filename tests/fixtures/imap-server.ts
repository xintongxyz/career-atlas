// Synthetic IMAP server (plain TCP, tests only) standing in for Gmail. It serves the messages the
// synthetic Workday site "sent" plus decoys, supports exactly what Career Atlas uses (LOGIN, LIST,
// EXAMINE, UID SEARCH SINCE, UID FETCH headers / BODY.PEEK[], LOGOUT) and records every command so
// tests can check that the mailbox was only read (no STORE / COPY / EXPUNGE, no SELECT).
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface FakeMessage {
  from: string;
  subject: string;
  html: string;
  text: string;
  at: number;
  box?: "INBOX" | "Spam";
}

export interface ImapFixture {
  port: number;
  commands: string[];
  logins: { user: string; ok: boolean }[];
  close(): Promise<void>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
const internalDate = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, " ")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
};

/** A multipart/alternative message: quoted-printable text part, base64 HTML part. */
export function rawMessage(m: FakeMessage, to: string): string {
  const qp = m.text.replace(/=/g, "=3D").replace(/[^\x20-\x7e\n]/g, (c) => [...Buffer.from(c)].map((b) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
  const b64 = Buffer.from(m.html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const subject = /[^\x20-\x7e]/.test(m.subject) ? `=?utf-8?B?${Buffer.from(m.subject).toString("base64")}?=` : m.subject;
  return [
    `From: ${m.from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date(m.at).toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="ca-boundary"',
    "",
    "--ca-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp,
    "--ca-boundary",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64,
    "--ca-boundary--",
    "",
  ].join("\r\n");
}

export async function startImapFixture(opts: { user: string; password: string; messages: () => FakeMessage[] }): Promise<ImapFixture> {
  const commands: string[] = [];
  const logins: { user: string; ok: boolean }[] = [];
  const sockets = new Set<Socket>();
  const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let box: "INBOX" | "Spam" | null = null;
    let authed = false;
    let buf = "";
    sock.write("* OK [CAPABILITY IMAP4rev1] synthetic mail ready\r\n");
    const list = () =>
      opts
        .messages()
        .map((m, i) => ({ ...m, uid: i + 1, box: m.box ?? "INBOX" }))
        .filter((m) => m.box === box);
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const [tag, cmdRaw, ...rest] = line.split(" ");
        const cmd = (cmdRaw ?? "").toUpperCase();
        const args = rest.join(" ");
        commands.push(cmd === "LOGIN" ? "LOGIN ***" : `${cmd} ${args}`.trim());
        const ok = (t = "done") => sock.write(`${tag} OK ${t}\r\n`);
        if (cmd === "LOGIN") {
          const m = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(args);
          const good = !!m && unquote(m[1]) === opts.user && unquote(m[2]) === opts.password;
          logins.push({ user: m ? unquote(m[1]) : "", ok: good });
          if (good) {
            authed = true;
            ok("LOGIN completed");
          } else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        } else if (cmd === "LOGOUT") {
          sock.write("* BYE\r\n");
          ok();
          sock.end();
        } else if (!authed) sock.write(`${tag} BAD not authenticated\r\n`);
        else if (cmd === "LIST") {
          sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"\r\n* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"\r\n');
          ok();
        } else if (cmd === "EXAMINE") {
          const name = unquote(args);
          box = name === "INBOX" ? "INBOX" : name === "[Gmail]/Spam" ? "Spam" : null;
          if (!box) sock.write(`${tag} NO no such mailbox\r\n`);
          else {
            sock.write(`* ${list().length} EXISTS\r\n`);
            ok("[READ-ONLY] EXAMINE completed");
          }
        } else if (cmd === "UID" && /^SEARCH /i.test(args)) {
          sock.write(`* SEARCH ${list().map((m) => m.uid).join(" ")}\r\n`);
          ok();
        } else if (cmd === "UID" && /^FETCH /i.test(args)) {
          const [, set, items] = /^FETCH (\S+) (.*)$/i.exec(args) ?? [];
          const uids = new Set(String(set).split(",").map(Number));
          list().forEach((m, i) => {
            if (!uids.has(m.uid)) return;
            const raw = rawMessage(m, opts.user);
            if (/BODY\.PEEK\[\]/i.test(items)) {
              const b = Buffer.from(raw, "latin1");
              sock.write(`* ${i + 1} FETCH (UID ${m.uid} BODY[] {${b.length}}\r\n`);
              sock.write(b);
              sock.write(")\r\n");
            } else {
              const head = Buffer.from(`From: ${m.from}\r\nSubject: ${raw.split("\r\n").find((l) => l.startsWith("Subject: "))!.slice(9)}\r\n\r\n`, "latin1");
              sock.write(`* ${i + 1} FETCH (UID ${m.uid} INTERNALDATE "${internalDate(m.at)}" RFC822.SIZE ${raw.length} BODY[HEADER.FIELDS (FROM SUBJECT)] {${head.length}}\r\n`);
              sock.write(head);
              sock.write(")\r\n");
            }
          });
          ok();
        } else sock.write(`${tag} BAD unsupported in the synthetic server\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    logins,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
