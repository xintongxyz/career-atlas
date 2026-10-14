# Public release checklist

Nothing here is done without the owner's final approval. Making the repository public, rewriting history and deleting anything require explicit approval in chat.

## 1. Repository hygiene
- [ ] `npm run check:secrets` passes on the release tree
- [ ] gitleaks over the history that will be published passes
- [ ] No real names/emails, job records, resumes, databases, backups, exports, deployment logs or screenshots of real data anywhere in the published tree or history
- [ ] **Publish from a fresh, squashed history.** The private history contains the owner's Cloudflare Preview workers.dev hostname, Access team name and D1 identifiers in early commits (not secrets, but personal deployment identifiers), plus the removed Cloudflare deployment tooling. Publish a single initial commit of the cleaned tree instead of the private history:
  - either a **new public repository** created from that commit (the private repo stays private as the archive), or
  - replacing the private repository's history and then changing visibility (history rewrite; needs explicit approval).
- [ ] Commit author identity is the neutral `Career Atlas Dev <dev@example.test>` (or the owner's chosen public identity)
- [ ] GitHub Actions: no artifacts with personal data (CI only ever ran synthetic tests; e2e failure traces are synthetic and expire after 3 days); no secrets configured for public PRs

## 2. License & docs
- [ ] License: MIT. Verified 2026-10-14: all 147 runtime packages are MIT / ISC / Apache-2.0 / BSD-3-Clause / 0BSD; icons from lucide (ISC); no code copied from reference projects (offerPilot is AGPL-3.0; only ideas were used, see REFERENCE_RESEARCH.md); screenshots made from fictional demo data
- [ ] README (EN + 中文) describes setup, limitations (restricted sites, AI optional) and that every clone gets its own empty database
- [ ] SECURITY.md contact path works (enable private vulnerability reporting)
- [ ] Issue templates point to the right repository (`.github/ISSUE_TEMPLATE/config.yml`)

## 3. Verification on a clean clone
- [ ] `npm ci && npm run typecheck && npm test && npm run build`
- [ ] `npm run test:e2e`
- [ ] `npm run start:local -- --open` creates a new empty database in the clone's own data folder; nothing from the owner's machine is needed
- [ ] `CAREER_ATLAS_INSTANCE=dev npm run local -- seed-demo` + `npm run dev` shows fictional demo data

## 4. After publishing
- [ ] Branch protection on `main`; required CI checks
- [ ] Dependabot and private vulnerability reporting enabled
