// Backup encryption, byte-compatible with scripts/lib-crypto.mjs (AES-256-GCM, "CABK1" header).
// The key lives OUTSIDE the repository and outside the backup folder:
//   ~/.config/career-atlas/backup.key   (mode 0600; override with CA_BACKUP_KEY_FILE)
// The key is never printed or logged; only a short fingerprint is.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAGIC = Buffer.from("CABK1");

export const keyPath = () => process.env.CA_BACKUP_KEY_FILE || join(homedir(), ".config", "career-atlas", "backup.key");

export function loadKey({ create = false } = {}): { key: Buffer; created: boolean } {
  const p = keyPath();
  let created = false;
  if (!existsSync(p)) {
    if (!create) throw new Error(`Backup key not found at ${p}. Restore it from your password manager or set CA_BACKUP_KEY_FILE.`);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
    chmodSync(p, 0o600);
    created = true;
  }
  const key = Buffer.from(readFileSync(p, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`Invalid backup key in ${p}`);
  return { key, created };
}

export const keyFingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function encrypt(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a Career Atlas encrypted backup file");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(5, 17));
  decipher.setAuthTag(blob.subarray(17, 33));
  return Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]); // throws if tampered / wrong key
}

export const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
