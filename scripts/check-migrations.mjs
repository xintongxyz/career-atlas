#!/usr/bin/env node
// Migration safety gate (runs in CI and before every release).
//  1. History is immutable: every migration recorded in migrations/LOCK.json must still exist with
//     the same SHA-256. Editing or deleting an applied migration fails.
//  2. New migrations (not yet in the lock) are scanned for destructive statements. They fail unless
//     the file contains a reviewed marker:  -- reviewed-destructive: <reason and data plan>
//  3. `--lock` records new migrations in LOCK.json (do this in the same commit that adds them).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const LOCK = "migrations/LOCK.json";
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {};
const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
const hash = (f) => createHash("sha256").update(readFileSync(`migrations/${f}`)).digest("hex");
const DESTRUCTIVE = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bALTER\s+TABLE\s+\S+\s+RENAME\b/i, "RENAME (table/column)"],
  [/\bDELETE\s+FROM\b/i, "DELETE FROM"],
  [/\bUPDATE\s+[`"']?\w+[`"']?\s+SET\b(?![\s\S]*?\bWHERE\b)/i, "UPDATE without WHERE"],
  [/\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i, "PRAGMA foreign_keys=OFF (table rebuild)"],
];
let problems = 0;
for (const [f, h] of Object.entries(lock)) {
  if (!files.includes(f)) {
    console.error(`✗ ${f} is in LOCK.json but was deleted. Applied migrations must never be removed.`);
    problems++;
  } else if (hash(f) !== h) {
    console.error(`✗ ${f} was modified after being locked. Never edit an applied migration — add a new one.`);
    problems++;
  }
}
const fresh = files.filter((f) => !(f in lock));
for (const f of fresh) {
  const sql = readFileSync(`migrations/${f}`, "utf8");
  const reviewed = /--\s*reviewed-destructive:\s*\S+/i.test(sql);
  for (const [re, label] of DESTRUCTIVE) {
    if (re.test(sql) && !reviewed) {
      console.error(`✗ ${f}: contains ${label}. Use an additive (expand → backfill → switch → contract) migration, or add "-- reviewed-destructive: <reason + data plan>" after review.`);
      problems++;
    }
  }
}
if (process.argv.includes("--lock")) {
  if (problems) process.exit(1);
  for (const f of fresh) lock[f] = hash(f);
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.log(`✓ locked ${fresh.length} new migration(s)`);
} else if (problems) {
  process.exit(1);
} else {
  console.log(`✓ ${files.length} migrations: history intact${fresh.length ? `, ${fresh.length} new and non-destructive: ${fresh.join(", ")}` : ""}`);
  if (fresh.length) console.log("  Remember: npm run db:lock in the same commit.");
}
