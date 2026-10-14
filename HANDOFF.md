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

Verified 2026-10-14 after the Cloudflare retirement: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e` (production build, incl. upload and no-external-requests checks), live import e2e, `npm run check:secrets`, `db:check`, `db:test-upgrade`, `npm audit` (0 vulnerabilities). The personal-instance check used records marked `[TEST]`, removed afterwards; the personal database holds only the local user and preferences until the owner starts using it.

## Not done / known gaps

1. Browser Rendering for JS-only career sites is not implemented (they return `dynamic_content` with the paste fallback). Lever and SmartRecruiters adapters are not yet verified against a live posting; Workday is best-effort.
2. Screenshot/PDF import and JD translation are not implemented. Analytics weekly/monthly series skip empty periods.
3. Main bundle ≈ 740 kB (240 kB gzip); code splitting possible later.

## Next steps (🔑 = owner action / approval)

1. Optional later: 🔑 `claude auth login` and enable AI in Settings.
