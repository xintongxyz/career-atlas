# Testing

| Layer | Tool | Location | Runs |
|---|---|---|---|
| Unit | Vitest (Node) | `tests/unit` | SSRF/IP rules, URL detection & canonicalisation, HTML/JSON-LD parsing, heuristics (EN + 中文), AI output verification & prompt-injection resistance, merge/conflicts, pipeline with mocked network, i18n key/placeholder parity and CJK spacing |
| Integration | Vitest (`tests/integration/harness.ts`: the real runtime — Node + SQLite + file store + task runner — in a temp directory per file) | `tests/integration` | The HTTP API end to end: CRUD, status machine, extraction, documents, export/import, CSRF/firewall, cross-user isolation, deletion |
| Local runtime | Vitest (Node, temp dirs, synthetic data) | `tests/local` | D1 adapter atomicity, restart persistence, no silent DB recreation, migration lock/downgrade refusal, verified pre-migration backup, extraction recovery, AI only on request, Host/Origin firewall, public-only DNS, static files, encrypted backups (verify, tamper, retention), personal-folder isolation, Claude Code adapter with a fake CLI (refuses API-key auth, no tools, scrubbed env) |
| Automated applications | Vitest + Playwright (real headless browser) against **synthetic** Greenhouse/Lever forms, a Workday-style wizard and Indeed-style pages (`tests/fixtures/`, 127.0.0.1); opt-in real Workday sites, non-submitting (`LIVE=1 tests/local/workday-live.test.ts`) | `tests/unit/apply-plan.test.ts`, `tests/integration/apply.test.ts`, `tests/integration/apply-workday-indeed.test.ts`, `e2e/workflow-auto-apply.spec.ts` | Resume selection among many versions and byte-exact upload, missing/changed resume never substituted, autofill accuracy, comboboxes/selects/radios/checkboxes, multi-step forms, unknown and legal questions pause, EEO never answered, review checkpoint, cancellation, restart recovery, duplicate prevention, verified vs ambiguous outcomes (never re-submitted), CAPTCHA/validation stop, status → Applied only via `changeStatus`, no personal values in logs. No real employer is contacted |
| End-to-end | Playwright (Chrome locally, Chromium in CI) | `e2e/core.spec.ts`, `e2e/local.spec.ts`, `e2e/workflow-auto-apply.spec.ts` | The **production build** (`dist/server/main.mjs`, same as `start:local`) against a throwaway SQLite database: core acceptance tests plus autosave-without-blur → reload, pasted JD → background extraction → review, Back up now / Test restore, 中文 |
| Live | Playwright, opt-in (`LIVE=1`) | `e2e/live.spec.ts` | Real Greenhouse and Ashby postings discovered at runtime via their public APIs |

```bash
npm test                 # unit + integration + local runtime safety
npm run test:e2e         # e2e (builds, then starts the production server on :5174 with a throwaway DB)
npm run test:e2e:live    # live extraction against public job boards (network)
npm run typecheck && npm run build
```

## Acceptance criteria coverage

| # | Scenario | Covered by | Last result |
|---|---|---|---|
| 1 | Manual creation persists after reload | `api.test.ts` "Test 1", `core.spec.ts` "Test 1 & 8" | ✅ pass |
| 2 | URL import from a real public posting | `live.spec.ts` (Greenhouse + Ashby), manual browser run on a live Greenhouse posting; restricted-site behaviour in `api.test.ts` / `extraction.test.ts` | ✅ pass (2026-10-13) |
| 3 | No invented salary; unknown fields shown | `api.test.ts` "Test 3", `core.spec.ts` "Test 3", AI hallucination unit tests | ✅ pass |
| 4 | Duplicate detection | `api.test.ts` "Test 4" (URL, ATS id, similar), `core.spec.ts` "Test 4" | ✅ pass |
| 5 | Saved ≠ applied; applied date & dashboard update | `api.test.ts` "Test 5 & 6", `core.spec.ts` "Test 5" | ✅ pass |
| 6 | Applied → Interview → Rejected history kept | `api.test.ts`, `core.spec.ts` "Test 6" | ✅ pass |
| 7 | Language switching keeps pages translated | `i18n.test.ts` (parity), `core.spec.ts` "Test 7" (8 pages in 中文, no raw keys, state preserved) | ✅ pass |
| 8 | Persistence across reload / new browser context | `core.spec.ts` "Test 1 & 8" | ✅ pass (local) |
| 9 | Unauthorized access rejected; no internal-network fetch | `api.test.ts` "Test 9" (CSRF, foreign Host refused, cross-user isolation incl. files, metadata IP blocked, content-sniffed uploads), `ssrf.test.ts` | ✅ pass |
| 10 | Production build, migrations, real use | Build ✅; `npm run start:local` on the personal database: create, edit, autosave, applied → interview, note, reminder, live URL import + review, archive/restore, delete permanently, restart persistence, backup + isolated restore (2026-10-14) | ✅ pass |

The personal-instance check used records marked `[TEST]`, removed afterwards with the app's own delete; the database was left empty.

## Data-protection checks

| Check | Command | What it proves |
|---|---|---|
| Migration history immutable, no unreviewed destructive SQL | `npm run db:check` | Locked migrations unchanged; new ones additive |
| Upgrade with synthetic data | `npm run db:test-upgrade` | Locked schema + demo data → new migrations keep every row, ID and FK |
| Local backup verification | `npm run local -- backup` / Settings → Test restore | Encrypted snapshot restores into an isolated DB: integrity, FKs, per-table counts, documents |
| Personal-folder isolation | `tests/local` | Dev/test/demo instances and demo seeding refuse the personal data folder |
| Deletion regression | `tests/integration/delete.test.ts`, `http-methods.test.ts` | Fully populated job deletes cleanly; empty-body DELETE accepted; other jobs untouched |
| Maintenance mode | `tests/integration/maintenance.test.ts` | Read-only mode blocks all writes, allows reads |
| Seed guard | `npm run local -- seed-demo` (personal instance) | Refuses; only dev/test instances and example.* accounts can be seeded |

## Writing tests

- Prefer integration tests through `SELF.fetch` (from `tests/integration/harness.ts`) for API behaviour; use `manualJob()` helpers in `tests/integration/helpers.ts`.
- Pipeline logic accepts injected network (`PipelineDeps`), so unit tests never hit the internet.
- Every new UI string must be added to both locale files; `i18n.test.ts` fails otherwise.
- Fixtures must be synthetic (example.com/example.test domains, fictional names).
