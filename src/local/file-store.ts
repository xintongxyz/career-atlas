// Local replacement for the R2 bucket used by the Documents feature.
//
// Files live in <dataDir>/documents/<key> (the key is the random `r2_key` column; the column name
// is historical). Writes are atomic (temp file + fsync + rename). Nothing is ever uploaded.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { FileStore } from "../server/env";

export function localFileStore(root: string): FileStore & { pathOf(key: string): string } {
  const base = resolve(root);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const pathOf = (key: string) => {
    const p = resolve(base, key);
    if (!p.startsWith(base + sep) || key.includes("\0")) throw new Error("Invalid document key");
    return p;
  };
  return {
    pathOf,
    async put(key, value) {
      const p = pathOf(key);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      const tmp = `${p}.tmp-${process.pid}`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, new Uint8Array(value as ArrayBuffer));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, p);
    },
    async get(key) {
      const p = pathOf(key);
      if (!existsSync(p)) return null;
      const bytes = readFileSync(p);
      return { body: new Blob([bytes]).stream(), size: bytes.byteLength };
    },
    async delete(key) {
      rmSync(pathOf(key), { force: true });
    },
  };
}

export const documentPath = (root: string, key: string) => join(root, key);
