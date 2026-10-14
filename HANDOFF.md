# Handoff — Career Atlas

_Last updated: 2026-10-14 · version 0.2.0 (local-first, pre-release)_

Legend: **Implemented**: code exists. **Tested**: covered by passing automated tests or verified by hand. **In use**: running with the owner's personal database. Code being complete ≠ tested ≠ in use.

## Where things stand

Career Atlas is a local website on the owner's Mac (Node + SQLite), developed in the public repository `xintongxyz/career-atlas` (published 2026-10-14 from a fresh history; the earlier private history is archived separately). The personal database was created **empty** at `~/Library/Application Support/CareerAtlas/` on 2026-10-14; no data was migrated, because the Cloudflare Preview held only test records. The Cloudflare runtime code and the Preview resources (Worker, queues, D1) were removed on 2026-10-14 with the owner's approval (docs/LOCAL_FIRST.md › Cloudflare).

Operations: [docs/LOCAL_FIRST.md](docs/LOCAL_FIRST.md) · Policy: [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md) · Design: [ARCHITECTURE.md](ARCHITECTURE.md).

| Area | Implemented | Tested | In use |
|---|---|---|---|
| All tracking features: dashboard, saved jobs, all positions (filters, views, bulk, CSV), job detail, Kanban, timeline, calendar/.ics, reminders, compare, analytics, notes, tags, contacts, archive/restore/delete, JSON/CSV export + import, EN/中文 | ✅ | ✅ integration + e2e; by hand on the personal instance | ✅ |
| URL import (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, JSON-LD, HTML, rules), evidence, review, snapshots, overrides, refresh diff, duplicates, paste fallback | ✅ | ✅ unit + integration + live e2e; live Greenhouse import + review on the personal instance | ✅ |
| Local runtime: node:sqlite D1-style adapter (WAL, FULL sync, FKs, atomic batches), 127.0.0.1 server, Host/Origin firewall, static SPA with CSP, owner-only file permissions | ✅ | ✅ | ✅ |
| Safe database lifecycle: data outside repo, no silent recreation, lock-verified migrations, verified backup before migrating, downgrade refusal, dev/test/demo cannot open the personal folder | ✅ | ✅ tests | ✅ |
| Background extraction runner (retries, restart recovery); public-only fetch checked at connect time | ✅ | ✅ | ✅ |
| Documents stored locally | ✅ | ✅ integration + backup tests + e2e upload/download | ✅ |
| Autosave (Saving/Saved/Failed, debounced text, close-tab guard) | ✅ | ✅ e2e + by hand (save without blur → reload) | ✅ |
| Weekly encrypted backups (every 7 days, 26 kept; on launch/hourly when due), Back up now, Test restore, restore CLI | ✅ | ✅ tests + e2e; on the personal DB: backup → verify → isolated restore identical row by row (20 tables) | ✅ 3 verified personal backups (owner has saved the key) |
| Startup: `start:local`/`stop:local`, Mac launcher (`~/Applications/Career Atlas.app`), `npm run dev` (separate dev DB) | ✅ | ✅ launcher: starts on 127.0.0.1 only, opens the browser, personal DB, rebuilds after code changes, no duplicate instances, clear error dialog, DB unchanged across relaunch | ✅ installed |
| Optional Claude Code AI (subscription auth only, no tools, opt-in per extraction) | ✅ | ✅ fake-CLI tests; **no live call** (CLI not signed in) | **Off** by owner's choice |
| AI drafts: Claude Desktop extension (`integrations/claude-desktop`, `npm run mcp:pack`) + Import from AI; server-side verification; drafts become jobs only on Save (migration 0002, additive) | ✅ | ✅ integration, MCP-over-stdio tests, packaged `.mcpb` walkthrough with a fictional posting → review → save, e2e | Extension to be installed by the owner in Claude Desktop |
| Bilingual job content: AI translations (EN/中文) of descriptive fields stored on the same job (`job_postings.translations`, migration 0003, additive); shown when switching language in job detail, lists, board and Compare with an AI-translation marker and Show original; originals/evidence untouched; stale translations dropped on edit. Manual entry and URL import are not auto-translated | ✅ | ✅ unit, integration, MCP, e2e (English JD → review → save → EN/中文 switch) | ✅ |
| Automated applications (Playwright, `src/local/apply`, docs/AUTO_APPLY.md): Start application with an existing-resume selector (any number of versions, explicit authorization), Greenhouse + Lever adapters with DOM detection, deterministic form planning from My Profile (contact details + approved reusable answers added to the profile JSON), resume pinned by SHA-256 and uploaded byte-exact, pauses for unknown/legal/required-demographic questions, review-before-submit or auto-submit, CAPTCHA/login/validation hand-off, visible-browser continuation, verified confirmation → Applied via `changeStatus` (event metadata with attempt id), Unconfirmed never re-submitted, restart recovery, duplicate prevention, cancellation, local screenshots; Auto-apply tab, banner, badges on All Positions/Kanban, manual assistance for unsupported sites; `application_attempts` (migration 0005, additive); EN/中文 | ✅ | ✅ unit (16), integration with a real headless browser against synthetic Greenhouse/Lever-style forms (9 scenarios), e2e UI flow, by hand on a throwaway instance (EN + 中文). **Not run against any real employer form** | ✅ available; not yet used for a real application |
| My Profile & job match: local profile (`user_profiles`, migration 0004, additive), resume → profile draft via Claude Desktop (`create_profile_draft`, extension v0.4.0) or Import from AI; local rule-based matching (`src/server/match/engine.ts`) with must-have / preferred / unclear, evidence and reasons; failed must-haves never hidden; Match tab, Positions column, Compare row; EN/中文 | ✅ | ✅ unit (licence, uncertain experience, languages, education equivalency, preferred skills, authorization), integration, MCP, e2e | ✅ |

Verified 2026-10-14 after the Cloudflare retirement: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e` (production build, incl. upload and no-external-requests checks), live import e2e, `npm run check:secrets`, `db:check`, `db:test-upgrade`, `npm audit` (0 vulnerabilities). The personal-instance check used records marked `[TEST]`, removed afterwards; the personal database holds only the local user and preferences until the owner starts using it.

## Not done / known gaps

0. Automated applications: the Greenhouse/Lever adapters have only been exercised on synthetic forms that imitate their DOM; the first real application should use *Review before submitting*. Ashby, Workday and other systems get manual assistance only (Phase 3). Cover-letter uploads, date pickers and email security codes pause for the owner.

1. Browser Rendering for JS-only career sites is not implemented (they return `dynamic_content` with the paste fallback). Lever and SmartRecruiters adapters are not yet verified against a live posting; Workday is best-effort.
2. Screenshot/PDF import and JD translation are not implemented. Analytics weekly/monthly series skip empty periods.
3. Main bundle ≈ 740 kB (240 kB gzip); code splitting possible later.

## Next steps (🔑 = owner action / approval)

0. 🔑 Fill in My Profile → Contact details, then try *Start application* on a Greenhouse or Lever job in *Review before submitting* mode. A real submission happens only when the owner approves it.

1. Optional later: 🔑 `claude auth login` and enable AI in Settings.
