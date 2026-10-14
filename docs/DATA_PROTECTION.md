# Data Protection Policy (authoritative)

This document is the single source of truth for how Career Atlas protects personal data while the code keeps changing. `AGENTS.md` (loaded by Claude Code through `CLAUDE.md`) contains the mandatory short form. If anything conflicts, **this document wins**. Operational details: [LOCAL_FIRST.md](LOCAL_FIRST.md).

> **The database is the long-lived source of truth. The UI is a replaceable presentation layer.**
> Any instance the owner actively uses contains real personal data. Treat it that way.

## 1. What is public and what is private

| Public source (GitHub) | Private runtime data (never in Git) |
|---|---|
| React UI, API, business logic, local runtime (`src/`) | The personal SQLite database and its `-wal`/`-shm` files |
| Schema (`src/server/db/schema.ts`) and migrations + `migrations/LOCK.json` | Uploaded documents, `config.json`, logs |
| Generic configuration (no personal values) | Backups, exports, the backup key, any cloud deployment config |
| Docs, screenshots of **fictional** data, synthetic fixtures (`example.com` / `example.test`) | Claude Code credentials (managed by the CLI, never read by Career Atlas) |

**Where the private data lives:** `~/Library/Application Support/CareerAtlas/` (database, documents, settings), `~/CareerAtlasBackups/` (encrypted backups), `~/.config/career-atlas/backup.key`. All outside the repository. The app has no code path that touches Git: saving a job never creates a commit, and nothing in the runtime can push.

**Automated guards:** the code refuses to place the personal database inside the repo, `node_modules/` or `dist/`, and refuses backups inside the repo or the data folder. `.gitignore` excludes `*.sqlite*`, `*.db`, `*.enc`, `*.sql` (except migrations), exports, `.dev-data/`, `.e2e-data/`, `.preview-data/`. Dev/test instances refuse the personal data folder; demo seeding refuses it too. The pre-commit hook runs `scripts/check-secrets.mjs --staged` (blocks dumps, databases, backups, keys, tokens, non-example emails, hosted-deployment hostnames); CI repeats it and runs gitleaks over the full history. `localStorage` only holds UI conveniences.

## 2. Instances

| Instance | Started by | Data | Who may write |
|---|---|---|---|
| **Personal** (`CAREER_ATLAS_INSTANCE=personal`, default) | `npm run start:local`, Mac launcher | **Real** — `~/Library/Application Support/CareerAtlas` | Only the owner through the app; automation only via the backup-gated CLI commands below |
| Dev | `npm run dev` | Synthetic — `.dev-data/` | Yes |
| Test | `npm test`, `npm run test:e2e`, preview builds | Synthetic — temp dirs / `.e2e-data/` / `.preview-data/` | Yes |

Dev/test instances default to a temporary backup folder, never `~/CareerAtlasBackups`.

**Never, without the owner's explicit approval in chat:** delete, reset, recreate, reseed, restore over, run synthetic or destructive tests against, or hand-edit the personal database. That includes `DROP`, unscoped `DELETE`/`UPDATE`, deleting or moving the `.sqlite` files and `restore --replace-live`. Otherwise only **read-only** checks run against it.

## 3. Changing the code

- Develop with `npm run dev` (dev database) and synthetic data. Reproduce bugs there, never with real rows. Never copy real data into code, fixtures, issues, prompts, screenshots or logs.
- Verify: `npm run typecheck && npm test && npm run build`, `npm run test:e2e` (runs the production build), `npm run check:secrets`, and for schema changes `npm run db:check && npm run db:test-upgrade`.
- Commit and push source only. The personal database is never part of a release; updating = pulling code and restarting.
- UI redesigns never require a database change. Keep IDs, `/jobs/:id` URLs, notes, histories (`application_events` is append-only) and confirmed/overridden fields intact. Map old values explicitly.

## 4. Schema evolution rules

- **Versioned migrations only.** Edit `schema.ts` → `npm run db:generate` → review the SQL → `npm run db:test-upgrade` → `npm run db:lock` in the same commit.
- **History is immutable.** `migrations/LOCK.json` stores each migration's SHA-256; CI fails on edits and the local runtime refuses to apply a migration that differs from the lock.
- **Additive first:** new nullable/defaulted columns, new tables, new enum values. The API and UI must tolerate older data.
- **Restructuring uses expand → backfill → switch → contract.** Old structures are never dropped in the same release.
- **Destructive statements** (`DROP TABLE/COLUMN`, `RENAME`, `DELETE FROM`, `UPDATE` without `WHERE`, `PRAGMA foreign_keys=OFF` rebuilds) fail `db:check` unless marked `-- reviewed-destructive: <reason + data plan>`, approved by the owner, and preceded by a verified backup.
- **Applying migrations to the personal database** happens automatically at the next start, but **only after an encrypted backup has been created and verified**; if that fails the app does not start and nothing is changed. A database written by a newer version is refused.
- `npm run db:test-upgrade` builds the last locked schema, loads synthetic data, applies new migrations and checks rows, IDs and foreign keys.

## 5. Backups and recovery

- Weekly encrypted (AES-256-GCM) backups of the database and documents to `~/CareerAtlasBackups/personal-<time>/`, run at launch / hourly when due; missed weeks run at the next launch. Also before every migration and on demand (Settings → Back up now, `npm run local -- backup`).
- Every backup is test-restored into an isolated database (integrity, foreign keys, row counts, schema version, document checksums) before it counts. Failed runs never replace or prune a valid backup.
- Retention: newest 26 verified weekly points (≈ 6 months), never fewer than 4. Old Cloudflare-era backups and failed runs are never pruned automatically. Deleting unverified backups needs the owner's approval.
- Key: `~/.config/career-atlas/backup.key`, kept separate from the backups; manifests record its fingerprint and restore refuses a different key. Store a copy in a password manager (`npm run local -- key` shows where; the key is never printed or logged).
- Restore procedures: [LOCAL_FIRST.md › Restore](LOCAL_FIRST.md#restore). Never restore an older snapshot over the live database automatically: it would erase later records. Prefer an isolated restore; `--replace-live` needs the owner's approval and keeps the current files.
- Rehearse: Settings → Test restore (each backup is already verified when written).

## 6. Moving to another computer

Copy the newest `~/CareerAtlasBackups/personal-…` folder and the key file (from your password manager) to the new machine, install Career Atlas, then `npm run local -- restore --from <folder> --replace-live --approve` before entering any data there. Never run two copies that both change; there is no sync. No data passes through GitHub, CI or logs.

## 7. Deleting data in the app

- **Archive** is the default: reversible, keeps all history. Restore brings the job back.
- **Delete permanently** shows an impact summary, offers "Archive instead" and needs an explicit acknowledgement. It removes only that job's records via foreign-key cascades (tested).

## 8. Privacy in logs, debugging and AI

- Logs contain only request ids, routes, error classes and scrubbed messages (`scrubLogText`) — never request bodies, JD text, notes, files, SQL parameters or tokens.
- AI is optional and only sees the posting being extracted, only when the owner ticks "Use Claude AI". It never receives the database, notes, histories or resumes. The Claude Code adapter runs with no tools, no MCP, no CLAUDE.md, a scrubbed environment and subscription auth only (never API keys). The UI states that it uses an online service and the Claude plan's allowance.
- The local server listens on `127.0.0.1` only and rejects foreign `Host` headers (DNS rebinding) and cross-origin writes. URL import can only reach public addresses (checked at connect time).
- Screenshots and examples use fictional data only.

## 9. Open-source release gate

Before the repository is made public (owner approval required), see `docs/RELEASE_CHECKLIST.md`: the public repository is published from a fresh single-commit history (the private history keeps deployment identifiers and author details), with no backups, databases or exports anywhere, secret scans passing and the MIT license.

## 10. Cloudflare (retired)

Career Atlas started on Cloudflare Workers. The Preview deployment only ever held test data; its Worker, queues and D1 database were deleted on 2026-10-14 with the owner's approval, after verifying a final encrypted backup. No normal feature uses Cloudflare. Never touch unrelated Cloudflare projects.
