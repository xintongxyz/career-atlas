// Encrypted, verified backups of the local database and documents.
//
//   <backupDir>/<instance>-<UTC stamp>/
//     db.sqlite.enc     consistent online snapshot of the SQLite database (AES-256-GCM)
//     files/<id>.enc    each document file, checked against its stored SHA-256 first
//     manifest.json     non-sensitive metadata: schema version, row counts, checksums, verification
//
// A backup is written to "<name>.partial", test-restored into an isolated temporary database
// (integrity check, foreign keys, per-table row counts, document checksums) and only then renamed
// to its final name. A failed backup becomes "<name>.failed" and never replaces or prunes a good one.
import { backup as sqliteBackup } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { LocalConfig } from "./config";
import { decrypt, encrypt, keyFingerprint, loadKey, sha256 } from "./crypto";
import { LocalD1 } from "./d1-sqlite";
import { appliedMigrations, tableCounts } from "./database";

export const BACKUP_FORMAT = "career-atlas-backup";
export const LOCAL_BACKUP_VERSION = 3;
export const DEFAULT_KEEP = 26;
export const DEFAULT_INTERVAL_DAYS = 7;

export interface LocalManifest {
  format: string;
  version: number;
  source: "local-sqlite";
  instance: string;
  encrypted: true;
  cipher: "aes-256-gcm";
  key_fingerprint: string;
  created_at: string;
  reason: string;
  schema_version: string | null;
  migrations: string[];
  table_counts: Record<string, number>;
  db_sha256: string;
  documents: { id: string; r2_key: string; size_bytes: number; sha256: string }[];
  missing_documents: string[];
  verified: boolean;
  verify_error: string | null;
}

export interface BackupState {
  last_success_at?: string;
  last_success_dir?: string;
  last_attempt_at?: string;
  last_error?: string | null;
  last_verified_restore_at?: string;
}

const statePath = (cfg: LocalConfig) => join(cfg.dataDir, "backup-state.json");

export function readBackupState(cfg: LocalConfig): BackupState {
  try {
    return JSON.parse(readFileSync(statePath(cfg), "utf8")) as BackupState;
  } catch {
    return {};
  }
}

function writeBackupState(cfg: LocalConfig, patch: Partial<BackupState>) {
  const next = { ...readBackupState(cfg), ...patch };
  writeFileSync(`${statePath(cfg)}.tmp`, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${statePath(cfg)}.tmp`, statePath(cfg));
  return next;
}

export function assertBackupDirAllowed(cfg: LocalConfig) {
  const root = resolve(cfg.backupDir) + sep;
  if (root.startsWith(resolve(cfg.appRoot) + sep)) throw new Error(`Refusing to store backups inside the source directory (${cfg.backupDir}).`);
  if (root.startsWith(resolve(cfg.dataDir) + sep)) throw new Error("Backups must not be stored inside the data directory they protect.");
}

const prefixOf = (cfg: LocalConfig) => cfg.kind; // personal-…, dev-…, test-…

/** Verified backups of this instance, newest first. */
export function listBackups(cfg: LocalConfig): { name: string; dir: string; manifest: LocalManifest }[] {
  if (!existsSync(cfg.backupDir)) return [];
  const out: { name: string; dir: string; manifest: LocalManifest }[] = [];
  for (const name of readdirSync(cfg.backupDir)) {
    if (!name.startsWith(`${prefixOf(cfg)}-`) || name.endsWith(".partial") || name.endsWith(".failed")) continue;
    const dir = join(cfg.backupDir, name);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as LocalManifest;
      if (manifest.format === BACKUP_FORMAT && manifest.source === "local-sqlite" && manifest.verified) out.push({ name, dir, manifest });
    } catch {
      /* not a complete backup */
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Decrypts and checks a backup into an isolated directory. Returns the restored database path. */
export function restoreInto(dir: string, target: { dbPath: string; documentsDir?: string }, key: Buffer): { counts: Record<string, number>; schema: string | null; documents: number } {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as LocalManifest;
  if (manifest.format !== BACKUP_FORMAT || manifest.source !== "local-sqlite") throw new Error("Not a local Career Atlas backup");
  if (manifest.key_fingerprint !== keyFingerprint(key)) throw new Error(`Backup was encrypted with a different key (${manifest.key_fingerprint})`);
  if (existsSync(target.dbPath)) throw new Error(`Refusing to restore over an existing file: ${target.dbPath}`);
  const plain = decrypt(readFileSync(join(dir, "db.sqlite.enc")), key);
  if (sha256(plain) !== manifest.db_sha256) throw new Error("Database checksum mismatch");
  writeFileSync(target.dbPath, plain, { mode: 0o600 });
  const d1 = new LocalD1(target.dbPath);
  try {
    const ic = d1.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ic.integrity_check !== "ok") throw new Error(`Integrity check failed: ${ic.integrity_check}`);
    const fk = d1.db.prepare("PRAGMA foreign_key_check").all();
    if (fk.length) throw new Error(`${fk.length} foreign-key problems`);
    const counts = tableCounts(d1);
    const diff = Object.keys({ ...counts, ...manifest.table_counts }).filter((t) => counts[t] !== manifest.table_counts[t]);
    if (diff.length) throw new Error(`Row counts differ in: ${diff.join(", ")}`);
    const schema = appliedMigrations(d1).at(-1) ?? null;
    if (schema !== manifest.schema_version) throw new Error("Schema version differs from manifest");
    let documents = 0;
    for (const doc of manifest.documents) {
      const bytes = decrypt(readFileSync(join(dir, "files", `${doc.id}.enc`)), key);
      if (sha256(bytes) !== doc.sha256) throw new Error(`Document ${doc.id} checksum mismatch`);
      if (target.documentsDir) {
        const p = resolve(target.documentsDir, doc.r2_key);
        if (!p.startsWith(resolve(target.documentsDir) + sep)) throw new Error("Invalid document key in backup");
        mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(p, bytes, { mode: 0o600 });
      }
      documents++;
    }
    return { counts, schema, documents };
  } finally {
    d1.close();
  }
}

/** Verifies an existing backup by restoring it into a throwaway directory. */
export function verifyBackup(dir: string, key = loadKey().key) {
  const work = mkdtempSync(join(tmpdir(), "career-atlas-verify-"));
  try {
    return restoreInto(dir, { dbPath: join(work, "verify.sqlite"), documentsDir: join(work, "documents") }, key);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface BackupResult {
  ok: boolean;
  dir: string;
  manifest: LocalManifest;
  pruned: string[];
  keyCreated: boolean;
}

let inFlight: Promise<BackupResult> | null = null;

/** Creates an encrypted, verified backup. Concurrent calls share one run. */
export function createBackup(cfg: LocalConfig, d1: LocalD1, opts: { reason?: string; keep?: number } = {}): Promise<BackupResult> {
  if (!inFlight) inFlight = runBackup(cfg, d1, opts).finally(() => (inFlight = null));
  return inFlight;
}

async function runBackup(cfg: LocalConfig, d1: LocalD1, opts: { reason?: string; keep?: number }): Promise<BackupResult> {
  assertBackupDirAllowed(cfg);
  mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
  const { key, created: keyCreated } = loadKey({ create: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${prefixOf(cfg)}-${stamp}`;
  const partial = join(cfg.backupDir, `${name}.partial`);
  const finalDir = join(cfg.backupDir, name);
  mkdirSync(join(partial, "files"), { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), "career-atlas-backup-")); // plaintext only lives here, briefly
  writeBackupState(cfg, { last_attempt_at: new Date().toISOString() });
  let manifest: LocalManifest | null = null;
  try {
    // 1. Consistent snapshot while the app keeps running (SQLite online backup API).
    const snap = join(work, "snapshot.sqlite");
    await sqliteBackup(d1.db, snap);
    const snapDb = new LocalD1(snap);
    let counts: Record<string, number>;
    let migrations: string[];
    let docs: { id: string; r2_key: string; size_bytes: number; sha256: string }[];
    try {
      snapDb.db.exec("PRAGMA journal_mode = DELETE");
      counts = tableCounts(snapDb);
      migrations = appliedMigrations(snapDb);
      docs = snapDb.db.prepare("SELECT id, r2_key, size_bytes, sha256 FROM documents").all() as typeof docs;
    } finally {
      snapDb.close();
    }
    const plain = readFileSync(snap);
    writeFileSync(join(partial, "db.sqlite.enc"), encrypt(plain, key), { mode: 0o600 });

    // 2. Documents.
    const included: typeof docs = [];
    const missing: string[] = [];
    for (const d of docs) {
      const p = resolve(cfg.documentsDir, d.r2_key);
      if (!existsSync(p)) {
        missing.push(d.id);
        continue;
      }
      const bytes = readFileSync(p);
      if (sha256(bytes) !== d.sha256) throw new Error(`Document ${d.id} does not match its stored checksum`);
      writeFileSync(join(partial, "files", `${d.id}.enc`), encrypt(bytes, key), { mode: 0o600 });
      included.push({ id: d.id, r2_key: d.r2_key, size_bytes: Number(d.size_bytes), sha256: d.sha256 });
    }

    manifest = {
      format: BACKUP_FORMAT,
      version: LOCAL_BACKUP_VERSION,
      source: "local-sqlite",
      instance: cfg.kind,
      encrypted: true,
      cipher: "aes-256-gcm",
      key_fingerprint: keyFingerprint(key),
      created_at: new Date().toISOString(),
      reason: opts.reason ?? "manual",
      schema_version: migrations.at(-1) ?? null,
      migrations,
      table_counts: counts,
      db_sha256: sha256(plain),
      documents: included,
      missing_documents: missing,
      verified: false,
      verify_error: null,
    };
    writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

    // 3. Verify by test-restoring into an isolated database.
    verifyBackup(partial, key);
    manifest.verified = true;
    writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    renameSync(partial, finalDir);
    const now = new Date().toISOString();
    writeBackupState(cfg, { last_success_at: now, last_success_dir: finalDir, last_error: null, last_verified_restore_at: now });
    const pruned = pruneBackups(cfg, opts.keep ?? cfg.settings.backup_keep ?? DEFAULT_KEEP);
    return { ok: true, dir: finalDir, manifest, pruned, keyCreated };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    if (manifest) {
      manifest.verify_error = msg;
      try {
        writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      } catch {
        /* ignore */
      }
    }
    try {
      renameSync(partial, `${finalDir}.failed`);
    } catch {
      /* ignore */
    }
    writeBackupState(cfg, { last_error: msg });
    throw new Error(`Backup failed: ${msg}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Keeps the newest `keep` VERIFIED backups of this instance. Never touches other instances, old Cloudflare-era backups or failed runs. */
export function pruneBackups(cfg: LocalConfig, keep: number): string[] {
  if (!(keep >= 4)) keep = 4; // never prune below a month of weekly history
  const all = listBackups(cfg);
  const pruned: string[] = [];
  for (const b of all.slice(keep)) {
    rmSync(b.dir, { recursive: true, force: true });
    pruned.push(b.name);
  }
  return pruned;
}

export function backupDue(cfg: LocalConfig, now = Date.now()): boolean {
  const days = cfg.settings.backup_interval_days ?? DEFAULT_INTERVAL_DAYS;
  const last = readBackupState(cfg).last_success_at ?? listBackups(cfg)[0]?.manifest.created_at;
  return !last || now - Date.parse(last) >= days * 86_400_000;
}

export function backupSummary(cfg: LocalConfig) {
  const state = readBackupState(cfg);
  const list = listBackups(cfg);
  const days = cfg.settings.backup_interval_days ?? DEFAULT_INTERVAL_DAYS;
  const last = state.last_success_at ?? list[0]?.manifest.created_at ?? null;
  return {
    backup_dir: cfg.backupDir,
    interval_days: days,
    keep: cfg.settings.backup_keep ?? DEFAULT_KEEP,
    count: list.length,
    last_success_at: last,
    next_due_at: last ? new Date(Date.parse(last) + days * 86_400_000).toISOString() : null,
    last_error: state.last_error ?? null,
    last_verified_restore_at: state.last_verified_restore_at ?? null,
    total_bytes: list.reduce((n, b) => n + dirSize(b.dir), 0),
    recent: list.slice(0, 8).map((b) => ({ name: b.name, created_at: b.manifest.created_at, reason: b.manifest.reason, rows: Object.values(b.manifest.table_counts).reduce((x, y) => x + y, 0), documents: b.manifest.documents.length, schema_version: b.manifest.schema_version })),
  };
}

function dirSize(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return n;
}
