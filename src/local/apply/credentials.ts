// Workday candidate-account credentials, kept in the macOS Keychain.
//
//   - Passwords live ONLY in the Keychain (service "Career Atlas – Workday account", one item per
//     employer site). They never enter source code, the SQLite database, config files, logs,
//     screenshots, process arguments or the browser UI of Career Atlas.
//   - `security` is driven through stdin (`security -i`), so the secret is not visible in the
//     process list; every write is read back and compared before it is used.
//   - accounts.json (owner-only, in the data folder) holds the non-secret index: which employer
//     site has an account for which e-mail, when it was created, the last failed sign-in.
//   - Test / dev instances use an in-memory store: tests never touch the real Keychain.
import { execFile, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretStore {
  kind: "keychain" | "memory";
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

const SECURITY = "/usr/bin/security";
export const ACCOUNT_SERVICE = "Career Atlas – Workday account";
export const SHARED_SERVICE = "Career Atlas – Workday shared password";

/** Quote names for `security -i` (service / account names only; secrets are passed as hex). */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function keychainStore(): SecretStore | null {
  if (process.platform !== "darwin" || !existsSync(SECURITY)) return null;
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(SECURITY, args, { timeout: 15_000 }, (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: String(stdout) }));
    });
  const store: SecretStore = {
    kind: "keychain",
    async get(service, account) {
      // -w prints only the secret to stdout; the secret is never an argument.
      const r = await run(["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (r.code !== 0) return null;
      const v = r.out.replace(/\n$/, "");
      // Stored as "ca1:<hex of UTF-8>" so any character survives `security` unchanged.
      return v.startsWith("ca1:") ? Buffer.from(v.slice(4), "hex").toString("utf8") : v;
    },
    async set(service, account, secret) {
      if (/[\r\n\0]/.test(secret)) throw new Error("invalid_secret");
      await new Promise<void>((resolve, reject) => {
        const p = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", reject);
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("keychain_write_failed"))));
        p.stdin.on("error", () => {});
        // The secret is written as plain ASCII "ca1:<hex>" — nothing to quote or escape.
        p.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(account)} -l ${q(service)} -w ca1:${Buffer.from(secret, "utf8").toString("hex")}\n`);
      });
      // Verify before anyone relies on it.
      if ((await store.get(service, account)) !== secret) {
        await store.delete(service, account);
        throw new Error("keychain_verify_failed");
      }
    },
    async delete(service, account) {
      await run(["delete-generic-password", "-s", service, "-a", account]);
    },
  };
  return store;
}

export function memoryStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    kind: "memory",
    get: async (s, a) => m.get(`${s}\n${a}`) ?? null,
    set: async (s, a, v) => void m.set(`${s}\n${a}`, v),
    delete: async (s, a) => void m.delete(`${s}\n${a}`),
  };
}

/** A strong password that satisfies common Workday rules (upper, lower, digit, special, length). */
export function generatePassword(length = 20): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_=+?"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function passwordProblems(pw: string): string[] {
  const out: string[] = [];
  if (pw.length < 8) out.push("length");
  if (!/[A-Z]/.test(pw)) out.push("upper");
  if (!/[a-z]/.test(pw)) out.push("lower");
  if (!/\d/.test(pw)) out.push("digit");
  if (!/[^A-Za-z0-9]/.test(pw)) out.push("special");
  if (/[\r\n\0]/.test(pw)) out.push("invalid");
  return out;
}

/** Workday accounts are per employer site (host), e.g. "acme.wd3.myworkdayjobs.com". */
export function tenantOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

export interface AccountRecord {
  tenant: string;
  email: string;
  mode: "unique" | "shared";
  status: "pending" | "created" | "signed_in";
  created_at: number;
  last_sign_in_at?: number | null;
  last_failure_at?: number | null;
  last_failure_code?: string | null;
}

export type PasswordMode = "unique" | "shared";

/** Non-secret index + Keychain access for Workday candidate accounts. */
export function accountManager(opts: { store: SecretStore | null; dir: string; settings: () => { mode: PasswordMode; autoSignIn: boolean }; failureCooldownMs?: number }) {
  const file = join(opts.dir, "accounts.json");
  const cooldown = opts.failureCooldownMs ?? 24 * 3600_000;
  const read = (): Record<string, AccountRecord> => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, AccountRecord>;
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, AccountRecord>) => {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const key = (tenant: string, email: string) => `${email.toLowerCase()} @ ${tenant}`;
  const store = opts.store;

  return {
    available: !!store,
    storeKind: store?.kind ?? null,
    settings: opts.settings,
    list(): AccountRecord[] {
      return Object.values(read()).sort((a, b) => b.created_at - a.created_at);
    },
    record(tenant: string, email: string): AccountRecord | null {
      return read()[key(tenant, email)] ?? null;
    },
    async hasCredential(tenant: string, email: string) {
      if (!store) return false;
      const r = read()[key(tenant, email)];
      // Shared mode: the owner's one password also signs in to accounts not made by Career Atlas.
      if (r?.mode === "shared" || (!r && opts.settings().mode === "shared")) return !!(await store.get(SHARED_SERVICE, "shared"));
      return !!(await store.get(ACCOUNT_SERVICE, key(tenant, email)));
    },
    async password(tenant: string, email: string): Promise<string | null> {
      if (!store) return null;
      const r = read()[key(tenant, email)];
      return r?.mode === "shared" || (!r && opts.settings().mode === "shared") ? store.get(SHARED_SERVICE, "shared") : store.get(ACCOUNT_SERVICE, key(tenant, email));
    },
    /** A password for a NEW account: generated (unique) or the user's shared one. */
    async newPassword(): Promise<{ password: string; mode: PasswordMode } | null> {
      if (!store) return null;
      if (opts.settings().mode === "shared") {
        const s = await store.get(SHARED_SERVICE, "shared");
        return s ? { password: s, mode: "shared" } : null;
      }
      return { password: generatePassword(), mode: "unique" };
    },
    /** Saves BEFORE the registration is submitted, so a created account is never left without its password. */
    async save(tenant: string, email: string, password: string, mode: PasswordMode, status: AccountRecord["status"]) {
      if (!store) throw new Error("no_secret_store");
      if (mode === "unique") await store.set(ACCOUNT_SERVICE, key(tenant, email), password);
      const all = read();
      const prev = all[key(tenant, email)];
      all[key(tenant, email)] = { tenant, email: email.toLowerCase(), mode, status, created_at: prev?.created_at ?? Date.now(), last_sign_in_at: prev?.last_sign_in_at ?? null, last_failure_at: null, last_failure_code: null };
      write(all);
    },
    mark(tenant: string, email: string, patch: Partial<AccountRecord>) {
      const all = read();
      const r = all[key(tenant, email)];
      if (!r) return;
      all[key(tenant, email)] = { ...r, ...patch };
      write(all);
    },
    /** Recent failed sign-in: never retried automatically (avoids locking the account). */
    blocked(tenant: string, email: string) {
      const r = read()[key(tenant, email)];
      return !!r?.last_failure_at && Date.now() - r.last_failure_at < cooldown;
    },
    async forget(tenant: string, email: string) {
      if (store) await store.delete(ACCOUNT_SERVICE, key(tenant, email));
      const all = read();
      delete all[key(tenant, email)];
      write(all);
    },
    async sharedConfigured() {
      return !!store && !!(await store.get(SHARED_SERVICE, "shared"));
    },
    async setShared(password: string) {
      if (!store) throw new Error("no_secret_store");
      await store.set(SHARED_SERVICE, "shared", password);
    },
    async deleteShared() {
      if (store) await store.delete(SHARED_SERVICE, "shared");
    },
  };
}

export type AccountManager = ReturnType<typeof accountManager>;
