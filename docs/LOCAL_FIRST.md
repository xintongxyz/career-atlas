# Career Atlas — Local-first operation

Career Atlas runs as a local website on your Mac. (It started on Cloudflare Workers; the React app, the API and every business rule moved over unchanged, only the runtime underneath is new.)

```
Browser (http://127.0.0.1:4310, EN / 中文)
   │  same-origin /api/*
   ▼
Local server (Node ≥ 22.16, src/local)          listens on 127.0.0.1 only
   firewall: Host must be 127.0.0.1/localhost:<port> (DNS-rebinding guard), same-origin writes only
   ▼
Hono app (src/server/app.ts: routes, services, status machine)
   ├─ SQLite  ~/Library/Application Support/CareerAtlas/career-atlas.sqlite
   ├─ files   ~/Library/Application Support/CareerAtlas/documents/
   ├─ tasks   in-process extraction runner, resumes after restart
   ├─ network public-only fetch, checked at connect time (URL import)
   └─ AI      optional: local Claude Code CLI, only when you tick "Use Claude AI" (off by default)
Weekly encrypted backups → ~/CareerAtlasBackups   key: ~/.config/career-atlas/backup.key
```

No Cloudflare account, Docker, cloud database or paid service is needed.

## Daily use

| What | How |
|---|---|
| One-time setup | `npm install`, then `npm run launcher:install` (creates `~/Applications/Career Atlas.app`) |
| Open Career Atlas | Double-click **Career Atlas** (Applications in your home folder, Spotlight or Dock). It starts the server in the background if needed and opens the browser. |
| From Terminal | `npm run start:local -- --open` (foreground, Ctrl+C stops) or `--detach --open` (background) |
| Stop | `npm run stop:local` (pending writes and extractions finish first; the database is closed cleanly) |
| Status | `npm run local -- status` |

The first start (and the first start after you change the code) builds the app automatically. A second launch never starts a second server: it opens the running one. The server uses little memory while idle; it does not need to run when you are not using it, and there is no background service when it is stopped.

`npm run dev` is for development only: it uses a separate database in `.dev-data/` (synthetic data; `npm run local -- seed-demo` with `CAREER_ATLAS_INSTANCE=dev`) and never opens your personal database.

## Where your data lives

| Path | Contents | In Git? |
|---|---|---|
| `~/Library/Application Support/CareerAtlas/career-atlas.sqlite` (+ `-wal`, `-shm`) | All records: companies, jobs, URLs, JDs, snapshots, evidence, overrides, applications, append-only events, notes, reminders, tags, contacts, views, preferences, document metadata | Never |
| `…/CareerAtlas/documents/` | Uploaded resumes / cover letters (never uploaded anywhere) | Never |
| `…/CareerAtlas/config.json` | Local settings (owner identity, AI on/off, backup retention) | Never |
| `…/CareerAtlas/backup-state.json`, `logs/` | Last backup result; server log (no request bodies, JD text or notes) | Never |
| `~/CareerAtlasBackups/personal-<time>/` | Encrypted backups | Never (refused inside the repo) |
| `~/.config/career-atlas/backup.key` | Backup encryption key (mode 0600) | Never |

Guarantees enforced in code (`src/local/config.ts`, `database.ts`):
- the personal data folder may not be inside the repository, `node_modules/` or `dist/`;
- a database that existed before is **never silently recreated**: if the file disappears, the app refuses to start and points to the backups;
- migrations are applied only if their content matches `migrations/LOCK.json`; a database written by a newer version is refused (no accidental downgrade);
- before any pending migration touches an existing database, an encrypted backup is made **and verified**; if that fails, nothing is migrated;
- SQLite runs with WAL + `synchronous=FULL` + foreign keys ON; related writes are one transaction (`batch()` is atomic);
- demo seeding refuses the personal database.

## Automatic saving

Every change is written to SQLite when you make it:
- **Explicit actions** (status changes, Kanban moves, archive/restore, tags, dates, selects) save immediately; the status machine (`services/pipeline.ts › changeStatus`) writes the state and its event in one transaction.
- **Free text** on the job page (fit assessment, next action, applied via, application notes) saves about one second after you stop typing, and immediately when you leave the field.
- The header shows **Saving… / Saved / Failed to save**.
- Closing the tab while a save is in flight, an autosave is pending, a new note is unsent or the edit form has changes asks for confirmation. Small writes use `fetch(…, { keepalive: true })` so one already sent completes even if the tab closes.
- Forms that create something new (manual job, note, reminder, event) keep their explicit Save / Add button so half-typed text never becomes a record.

Saving never involves GitHub, Cloudflare or an export.

## Job import and background extraction

All extraction paths from the Cloudflare version work locally: Greenhouse, Lever, Ashby, SmartRecruiters and Workday APIs, schema.org JobPosting, public HTML, rule-based parsing, evidence, manual review, snapshots, overrides, refresh diff, duplicate detection and the paste-JD fallback. LinkedIn/Indeed/Glassdoor are still never fetched; logins and CAPTCHAs are never bypassed.

- The job is saved first; extraction runs in the background (2 at a time) and the UI shows progress as before.
- Timeouts, HTTP 429 and 5xx are retried with backoff (3 attempts). Failures are shown with Retry and Paste-description options.
- Extractions interrupted by quitting, a crash or sleep are resumed when Career Atlas next starts (rows from the last 24 h). Nothing runs while the Mac is off or the app is stopped.
- URL fetches can only reach **public** addresses: the check happens when the connection is made, so a public name that resolves to your router, `localhost` or a cloud metadata address is refused (tested with `localtest.me`).

## AI extraction with Claude Code (optional)

**Findings (verified 2026-10-14 against the official docs and the installed CLI 2.1.295):**
- `claude -p` (non-interactive) is documented and supports `--json-schema` (validated output in `structured_output`), `--tools ""` (no tools), `--safe-mode` (no CLAUDE.md, hooks, plugins, skills or MCP; authentication still works), `--strict-mcp-config`, `--no-session-persistence`. `--bare` is **not** used because it ignores subscription sign-in.
- Claude Pro/Max sign-in (`claude auth login`) is the default auth for Claude Code. The Help Center says Claude and Claude Code share the plan's usage limits; it does not explicitly mention `-p`, so treat each extraction as using your allowance.
- **Billing precedence:** in `-p` mode an `ANTHROPIC_API_KEY` in the environment is *always* used and billed per token. Career Atlas therefore starts the CLI with an allow-listed environment (no `ANTHROPIC_*`, `CLAUDE_CODE_USE_*` or proxy variables) and runs it only when `claude auth status` reports `authMethod: "claude.ai"`. API-key, token, helper and Bedrock/Vertex sign-ins are refused. **Career Atlas cannot create API charges.**
- If "extra usage / usage credits" is enabled on your Claude account, usage beyond your plan limit may be billed at API rates. Check **claude.ai → Settings → Usage** and leave it off (or capped) if you do not want that.
- **Open question for you:** Anthropic's Consumer Terms restrict access "through automated or non-human means" except via an API key, and the Agent SDK docs say third-party developers may not offer claude.ai login in their products. Career Atlas is your own tool, invoked by you per job, but the docs do not explicitly address that case. AI therefore stays **off by default**, runs only on an explicit click, and rule-based extraction remains fully functional without it.
- The CLI bundled with the Claude desktop app is found automatically, but it is **not signed in on its own**; the desktop app's session is not reused.

**Enable:** in Terminal run `claude auth login` yourself (choose your Claude plan, not Console/API), then Settings → AI extraction → tick "Offer Claude AI when importing jobs". Check with `npm run local -- claude-check` (status only) or `npm run local -- claude-check --sample` (one extraction of a built-in **fictional** posting).

**What is sent:** only the posting text being extracted (inside `<job_posting>` delimiters, injection markers stripped) with a fixed extraction instruction. Never notes, history, resumes or other records. Output is schema-validated; values without a verbatim quote from the posting are dropped or downgraded (unchanged logic in `ai/extract-job.ts`). The CLI runs in an empty temporary directory with no tools, one call at a time, 3-minute timeout.

## AI drafts: Claude Desktop extension and "Import from AI"

Claude does the research in your normal Claude Desktop chat (no API key, no extra billing; Claude Desktop runs the extension with its built-in Node). Career Atlas only receives the result as a **draft**.

**Set up once**
1. `npm run mcp:pack` → `dist/career-atlas.mcpb`.
2. Claude Desktop → Settings → Extensions → Advanced settings → **Install Extension…** → choose `dist/career-atlas.mcpb` → Install. Leave the address at `http://127.0.0.1:4310`.

**Use**
1. Open Career Atlas (launcher).
2. In Claude Desktop: *"Add this job to Career Atlas: <link or pasted job description>"*. Allow the Career Atlas tool when Claude asks.
3. The draft opens in your browser (or: Dashboard → *AI drafts waiting for your review*).
4. Check the labels — **Verified in posting** (green, exact quote found), **From the web** (blue, with the page link), **AI inference** (orange, Claude's judgment) — edit or untick anything, then **Save selected fields**. *Dismiss* discards the draft.

**Without Claude Desktop:** Add job → **Import from AI** → *Copy prompt for your AI* → paste it into ChatGPT (or any AI) with the job link/description → paste the answer back → *Create draft for review* → review and save as above.

Rules the app enforces regardless of the AI: values claimed from the posting must have a quote that really appears in the job description (otherwise they become inferences); salary, visa sponsorship, work authorization, eligibility, work arrangement and deadlines are only accepted with such a quote; missing details stay empty; duplicate job links are flagged before saving; the original link and job description are stored with the job. The extension can only create drafts and answer "already saved: yes/no"; it cannot see, edit or delete your jobs.

## Weekly encrypted backups

- **When:** at launch and every hour while the app runs, a backup is made if the last successful one is 7 days old or older. If the Mac was off on the due day, the backup runs at the next launch. Plus **Back up now** in Settings, `npm run local -- backup`, and automatically before every schema migration. Data only changes while the app runs, so this covers every change without a background service.
- **What:** a consistent online snapshot of the SQLite database (SQLite backup API, safe while the app runs) and every document file, each AES-256-GCM encrypted, plus a non-sensitive `manifest.json` (schema version, row counts, checksums, key fingerprint).
- **Verified every time:** each backup is written to `<name>.partial`, restored into an isolated temporary database (integrity check, foreign keys, per-table row counts, schema version, document checksums) and only then renamed. A failed run becomes `<name>.failed` and never replaces, or causes pruning of, a good backup. Settings → **Test restore** repeats the check on demand.
- **Retention:** the newest **26** verified personal backups (about six months of weekly points) are kept; older verified ones are pruned after a new one succeeds. Never fewer than 4. Failed runs, Cloudflare backups (`preview-…`) and other instances are never pruned automatically. Each backup is small (the database plus documents, compressed by nothing, typically well under a few MB); Settings shows the total size.
- **Key:** `~/.config/career-atlas/backup.key`, separate from the backups. Run `npm run local -- key` to see its path and fingerprint (the key is never printed). Open the file yourself and save its single line in your password manager. Without the key, backups cannot be read.
- **Off-site (optional):** `~/CareerAtlasBackups` is encrypted, so it may be synced to a private cloud drive. Keep the key elsewhere.

### Restore

```bash
npm run local -- backups                                      # list verified backups
npm run local -- verify --name personal-<time>                # test-restore only
npm run local -- restore --from ~/CareerAtlasBackups/personal-<time> --to ~/Desktop/check.sqlite   # isolated copy
npm run stop:local
npm run local -- restore --from ~/CareerAtlasBackups/personal-<time> --replace-live            # dry run
npm run local -- restore --from ~/CareerAtlasBackups/personal-<time> --replace-live --approve  # replace
```

`--replace-live` refuses while the app runs, first backs up the current database, keeps the current files as `*.before-restore-<time>` (nothing is deleted), then restores and verifies. Restoring an old backup discards changes made after it, so prefer an isolated restore to recover a single record.

## Updating the app and changing the UI

Pulling new code and restarting rebuilds the app; the database stays where it is. Schema changes follow [DATA_PROTECTION.md](DATA_PROTECTION.md) §4 (additive migrations, lock file, upgrade test) and are applied at the next start after a verified backup. UI redesigns never touch the database. IDs and `/jobs/:id` URLs, notes and histories stay valid.

## Feature parity (Cloudflare version → local)

| Feature | Local status | How it is provided | Tested |
|---|---|---|---|
| Dashboard, Saved Jobs, All Positions (filters, sorting, saved views, bulk, CSV), Job detail, Kanban, Timeline, Calendar (month/list, `.ics`), Compare, Analytics | ✅ same code | unchanged React app + Hono routes + SQL read models on SQLite | API integration tests on the real runtime, 8 core e2e on the production build; verified by hand on the personal instance |
| Companies, contacts, notes, tags, reminders, follow-ups, preferences | ✅ | unchanged services | integration + e2e |
| Manual creation, editable JD, application tracking, status machine, append-only events, milestones | ✅ | `changeStatus` unchanged, atomic `batch()` | integration + e2e |
| Archive, Restore, Delete permanently with impact summary | ✅ | FK cascades enforced (`foreign_keys=ON`) | delete tests + e2e |
| JSON / CSV export and JSON import (preview + duplicate skip) | ✅ | unchanged | integration |
| English / 中文 switching | ✅ | unchanged; new strings in both catalogs | i18n parity + e2e |
| URL import: Greenhouse, Lever, Ashby, SmartRecruiters, Workday, JSON-LD, HTML, rules, evidence, review, snapshots, overrides, refresh diff, duplicates, paste fallback | ✅ | unchanged pipeline; Node DNS + connect-time public-only fetch | unit + integration; live Greenhouse/Ashby e2e passed locally |
| Background extraction, progress, retries, failure handling | ✅ | in-process runner (replaces Queues) + restart recovery | local tests (recovery, retry) |
| AI-assisted extraction | ✅ optional | Claude Desktop extension → AI drafts (no API billing); Import from AI for other tools; Claude Code CLI on request (off) | integration + MCP stdio tests, packaged-bundle walkthrough, e2e |
| Documents (resume/cover letter upload, preview, link to applications) | ✅ **now enabled** (R2 was never enabled on Preview) | local file store, atomic writes, sniffing + ownership checks unchanged | integration + backup tests |
| Autosave with Saving/Saved/Failed + close-tab protection | ✅ new | mutation-cache indicator, debounced text fields, keepalive | e2e (save without blur → reload) |
| Weekly encrypted backups, Back up now, Test restore, restore CLI | ✅ new | `src/local/backup.ts` | local tests + e2e |
| Cloudflare Access sign-in, public URL, rate limits | ✗ by design | local-only, single user, loopback + Host/Origin firewall | firewall tests |
| Read-only maintenance mode | kept (`MAINTENANCE_MODE`) | rejects writes, e.g. during a restore | integration |

## Cloudflare (retired 2026-10-14)

Career Atlas started on Cloudflare Workers. The Preview deployment held only test records (checked twice read-only: three archived test jobs, their events, four company rows and the owner's sign-in; no applications, notes, reminders, contacts or documents), so no data was migrated; the personal database started empty.

Deleted with the owner's approval on 2026-10-14, after verifying a final encrypted backup restores (34 rows): Worker `career-atlas-preview`, Queues `career-atlas-preview-extraction` and `career-atlas-preview-extraction-dlq`, D1 `career-atlas-preview`. Unrelated projects were not touched. The local Wrangler configuration, the `wrangler` dependency and the deploy workflow were removed; one encrypted Preview backup is kept temporarily as a recovery archive.

Nothing in Career Atlas uses Cloudflare any more.
