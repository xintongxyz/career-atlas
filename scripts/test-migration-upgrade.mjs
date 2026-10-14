#!/usr/bin/env node
// Upgrade test with realistic synthetic data (runs in CI and before schema changes are committed).
//  1. Build a throwaway SQLite DB at the LAST LOCKED schema (what existing installations run today).
//  2. Fill it with the synthetic demo dataset.
//  3. Apply the new (unlocked) migrations.
//  4. Verify: no table lost rows, every pre-existing primary key still exists, no FK violations.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lock = existsSync("migrations/LOCK.json") ? JSON.parse(readFileSync("migrations/LOCK.json", "utf8")) : {};
const all = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
const base = all.filter((f) => f in lock);
const fresh = all.filter((f) => !(f in lock));
const work = mkdtempSync(join(tmpdir(), "career-atlas-upgrade-"));
const file = join(work, "upgrade.sqlite");

const apply = (db, names) => {
  for (const n of names) {
    db.exec("BEGIN");
    for (const stmt of readFileSync(`migrations/${n}`, "utf8").split("--> statement-breakpoint")) if (stmt.trim()) db.exec(stmt);
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(n);
    db.exec("COMMIT");
  }
};
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'").all().map((r) => r.name);
const counts = (db) => Object.fromEntries(tables(db).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
const hasId = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === "id");

try {
  let db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  apply(db, base);
  db.close();
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", "--sqlite", file, "--email", "demo@example.test"], { stdio: ["ignore", "ignore", "inherit"] });
  db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  const before = counts(db);
  const idSets = Object.fromEntries(tables(db).filter((t) => hasId(db, t)).map((t) => [t, new Set(db.prepare(`SELECT id FROM "${t}"`).all().map((r) => r.id))]));
  if (!fresh.length) {
    console.log(`✓ No new migrations. Synthetic dataset loads cleanly on the locked schema (${Object.values(before).reduce((a, b) => a + b, 0)} rows).`);
  } else {
    apply(db, fresh);
    const after = counts(db);
    const lost = Object.keys(before).filter((t) => (after[t] ?? 0) < before[t]);
    const missingIds = Object.entries(idSets).filter(([t, set]) => {
      const now = new Set(db.prepare(`SELECT id FROM "${t}"`).all().map((r) => r.id));
      return [...set].some((id) => !now.has(id));
    });
    if (lost.length || missingIds.length) {
      console.error(`✗ Upgrade lost data: ${lost.map((t) => `${t} ${before[t]}→${after[t] ?? 0}`).join(", ")} ${missingIds.map(([t]) => `${t} ids missing`).join(", ")}`);
      process.exit(1);
    }
    console.log(`✓ Upgrade ${base.at(-1) ?? "(empty)"} → ${fresh.at(-1)} preserved all rows and IDs.`);
  }
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  db.close();
  if (fk.length) {
    console.error(`✗ ${fk.length} foreign-key violations after upgrade`);
    process.exit(1);
  }
  console.log("✓ No foreign-key violations.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
