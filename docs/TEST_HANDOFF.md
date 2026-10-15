# Test handoff — automated applications

Durable record for the next agent (Cursor, Codex, Claude). Read this before working on
`src/local/apply/`. Status words: **Implemented** · **Passed synthetic tests** · **Verified on real
website** · **Blocked** · **Not tested**. "Verified on real website" is used only for what a run on a
live employer page actually showed.

## 1. Branch and commit

- Branch: `qa/runtime-agent-dayforce` (from `main` @ `b48f35b`). Not merged; `main` untouched.
- Commit: see `git log -1` on the branch (this file is updated in the same commit).

## 2. Tools discovered (2026-10-15)

| Tool | Where | Callable from the Career Atlas runtime? | Notes |
|---|---|---|---|
| Playwright (`playwright-core` 1.56) + system Chrome | `src/local/apply/*` | **Yes** — the application engine | Own persistent profile in the data folder |
| Codex CLI 0.144.6, ChatGPT sign-in | `~/.local/bin/codex` | **Yes** for single JSON decisions (`src/local/codex.ts`) | Can reach an in-app MCP tool server (tested with a dummy tool): it initialises and lists tools, but tool *calls* need an approval setting — see §10 |
| Claude Code CLI 2.1.295 (desktop bundle) | `~/Library/Application Support/Claude/claude-code/…` | **No** — not signed in for headless use (`auth status: loggedIn false`) | Development session's own sign-in is host-provided and not usable by the app |
| Workspace MCP (`~/Innovation/.mcp.json`) | trendradar only | No browser capability | — |
| `scrape` skill (curl → Scrapling → Playwright) | `~/Innovation/.claude/skills/scrape` | Not installed (documentation only) | — |
| Codex built-in `browser_use` / `computer_use` | Codex features | Not used | Would operate an unscoped browser; Career Atlas keeps its own scoped browser |
| Development session browsers | built-in pane, Claude in Chrome | Development only | Used to inspect the live Dayforce form's *structure* (no personal data typed) |

## 3. What was implemented in this cycle

| Item | Status | Files |
|---|---|---|
| Preferred Contact Method default (`application_defaults.preferred_contact_method`: email / phone / text), My Profile control, semantic options (Email / E-mail / "Contact me by email" / Email address), never inferred from phone type; owner's profile set to **Email** | Implemented · Passed synthetic tests · **Verified on real website** (employer A: "Preferred Contact Method" → Email, verified on the page) | `src/shared/profile.ts`, `src/shared/apply-semantic.ts`, `src/local/apply/plan.ts`, `src/client/pages/profile.tsx`, locales |
| Regression fixed: "Phone Device Type" was classified as a dialing-code field (Cursor rule `^(phone|mobile|cell)`) | Implemented · Passed synthetic tests | `plan.ts` |
| Contact method had been inferred from phone type ("Mobile") — removed | Implemented · Passed synthetic tests | `plan.ts` |
| Component-library dropdowns: value read beside the search input (Ant, react-select, MUI); duplicate accessibility copies of options treated as one option; read-only / disabled dropdowns opened without typing and never waited on; shortened displays accepted ("🇨🇦 +1" for "🇨🇦 +1 Canada") | Implemented · Passed synthetic tests · real website: see §6 | `src/local/apply/dom.ts`, `src/local/apply/interact.ts` |
| Repeated rows on non-Workday forms by meaning (title, employer, dates, school, degree, major, country, completion): saved entry detection, reuse empty row or section-owned Add, row Save/Update, verify summary; each school / job its own values; no invented dates (month → 1st of month on date inputs, noted; year-only → asked if required) | Implemented · Passed synthetic tests · real website: see §6 | `src/local/apply/rows.ts`, `dom.ts` (numbered rows) |
| Removed the Dayforce field-name map (`repeatingValue`), which also put the graduation year into the education *start* date | Implemented | `plan.ts`, `tests/unit/apply-generic.test.ts` |
| Pop-ups / interruptions: routine notices acknowledged; "leave page / unsaved changes" → stay; consent / declarations never auto-clicked (paused with the text); plain privacy notices accepted only with the new standing preference (`accept_privacy_notices`); browser alerts accepted, confirms dismissed | Implemented · Passed synthetic tests | `interact.ts` (`handleNotices`, `commitOpenSections`), `engine.ts` (`notices`) |
| Inline section editors saved with their own Update/Save before Next | Implemented · Passed synthetic tests | `interact.ts`, `engine.ts` |
| Progress labels: the attempt's `stage` shows the field being worked on (label only) | Implemented | `engine.ts`, `rows.ts` |
| Runtime AI agent with browser tools (Codex + in-app MCP server) | **Blocked** — see §10 | draft kept outside the repo |

## 4. Tests executed

- `npm run typecheck`, `npm test` (unit + integration), `npm run build`, `npm run test:e2e`, `npm run db:check`, `npm run check:secrets` — results in §5.
- New: `tests/integration/apply-dayforce.test.ts` with `tests/fixtures/dayforce-fixture.ts` (synthetic Dayforce-style portal built from the live page's structure).
- Unit: `tests/unit/apply-plan.test.ts` (preferred contact method, phone-type regression), `tests/unit/apply-generic.test.ts` (row roles by meaning).

## 5. Synthetic results (2026-10-15, branch head)

- `npm run typecheck` ✓ · `npm run build` ✓ · `npm run db:check` ✓ (8 migrations, no schema change) · `npm run check:secrets` ✓
- `npm test`: 29 files passed, 1 skipped — 258 tests passed, 3 skipped (opt-in live tests)
- `npm run test:e2e`: 21 passed, 2 skipped

## 6. Real website results

### Employer A (Dayforce candidate portal)

The owner's saved job, the owner's selected resume, review mode, guest application (no account).
Historical failed attempt preserved.

**Result (2026-10-15): reached the final Submit step — Verified on real website. Not submitted** (paused at `submit_approval`; 54 filled values verified on the page, 0 unverified).

| Behaviour | Status on the live site |
|---|---|
| Posting → Apply → "Apply without an Account" (no account created) | Verified on real website |
| Email + confirm email, names, mobile number | Verified on real website |
| Country dialing code (shown as "🇨🇦 +1") | Verified on real website (after fixes) |
| Preferred Contact Method = Email (from Application Defaults) | Verified on real website |
| Address country / province (profile country written "加拿大" → searched as "Canada") | Verified on real website (after fixes) |
| How did you hear about this job? → Linkedin (from the saved job's source) | Verified on real website |
| Resume upload (the exact selected file) | Verified on real website |
| 4 employment rows, each saved with Update and shown as a summary | Verified on real website |
| 2 education rows (each school with its own degree, major and dates) | Verified on real website |
| Personal-info section saved with its own Update | Verified on real website |
| Next → Questionnaire → Next → Submit step | Verified on real website |
| Questionnaire: three questions whose answers were not in My Profile | Answered by the owner (genuinely unknown facts), then verified |
| Final Submit button | Detected; **not clicked** |
| Informational pop-ups / privacy consent | None appeared on this posting during these runs — Not tested on real website (synthetic only) |

Facts the owner supplied during the test were stored in My Profile where reusable (education dates, work
authorization) or used for that application only. Preferred contact method set to Email (My Profile).

### Employer B (SAP SuccessFactors)

The owner's two attempts failed with
"something went wrong" (`worker_error`) about one second after Apply.

| Finding (live site) | General failure mode | Fix | Status |
|---|---|---|---|
| Apply redirects to `career2.successfactors.eu`; reading the page during the redirect crashed ("Execution context was destroyed") | any site that navigates after a click | `navigationSafe(page)`: every page read waits for the new document and retries (all tabs) | Implemented · synthetic · **Verified on real website** (no crash) |
| Two "Apply now" controls, the first hidden | duplicated responsive controls | click the first *visible* match | Implemented · synthetic · Verified on real website |
| Sign-in page drawn by script after load → judged empty → `unsupported_site` | late-rendering pages | wait until the page shows controls and stops changing before deciding | Implemented · synthetic · Verified on real website (now pauses with "sign-in required") |
| SuccessFactors requires a candidate account (no guest) | sign-in on non-Workday sites | saved password (Keychain, per host) used once when the application allows sign-in; success only when the password field stays gone on a drawn page; a rejected password is recorded and never retried; in the visible window filling continues after the user signs in | Implemented · Passed synthetic tests (`apply-signin-sites.test.ts`) · real: **Not tested** (no saved password for that site; no account created) |

Real result (attempt `0952ddf2`): paused `login_required` at the SuccessFactors sign-in — correct, nothing typed.
To go further the owner must sign in (visible window) or save that site's password in Settings → Workday accounts →
"Add a password you already have". Creating SuccessFactors accounts automatically is
not implemented (it would need the runtime agent or a dedicated flow, plus the owner's consent for account terms).

Structure observed on employer A's form (development browser, no personal data typed):
- Posting → Apply → `…/apply?flowSelection=true` (Apply without an Account / Sign In / Create one now) → `…/apply/manualApplication` with steps **Candidate Info → Questionnaire → Submit**; a reCAPTCHA badge is present.
- Ant Design selects: `input[type=search][role=combobox]` whose value stays empty; the choice shows in `.ant-select-selection-item`. Country list = 250 options in one scrolling list; dialing codes "🇨🇦 +1 Canada" (shown as "🇨🇦 +1" once chosen); Preferred Contact Method = Email / Mobile Phone (read-only); "How did you hear about this job?" = Recruiter, Jobillico, Workopolis, Indeed, Agency, Employee Referral, Other, Linkedin, Educational Institution (read-only).
- Personal info, each employment row and each education row have their own **Update / Cancel**; "Add Employment History", "Add Education History".
- Education row: Degree (text), Not Completed (checkbox), Major, Minor, Start Date, End Date (date inputs), School (text), Country / State selects.

## 7. Exact failures encountered (real employer-A runs, in order)

1. Country dialing code and address Country unverified (46/48) — duplicate option copies; short display "🇨🇦 +1"; refs changing after re-render.
2. Runs stalled > 10 min after the resume upload — typing into read-only / disabled dropdowns (15 s waits) and per-option round trips on 250-item lists.
3. Personal-info Update never pressed — the button sits > 6 wrappers away from its fields.
4. Address Country still unverified — the profile country is written in Chinese ("加拿大"); the form searches English names.
5. Education start date required — not in My Profile (asked; owner answered; now stored).
6. Questionnaire: work authorization, salary, accommodation — not in My Profile (asked; owner answered).

## 8–9. Root causes and fixes

| Symptom | Root cause | Fix |
|---|---|---|
| Country / dialing-code selects "did not persist" | (a) two DOM copies of every option (visible item + accessibility copy) → the picker saw two matches and chose nothing; (b) the dialing-code select displays only "🇨🇦 +1" after a choice, so verification against "Canada" failed | `bestOption` / text-grouping in `interact.ts`; `comboPick` (search → pick → verify, fallback open-and-pick) and `shownMatches` |
| Preferred Contact Method not selected | value inferred from phone type ("Mobile") instead of a real preference; read-only select typed into | new default + semantic domain; read-only selects opened without typing |
| Only first work / education row handled | field-name map for index 0 only; rows need Update and become summaries | `rows.ts` (meaning-based, Add / Update / verify per entry) |
| Runs stalled for >10 min after the resume upload | picker typed into read-only / disabled dropdowns (State before Country); each Playwright fill waited 15 s, many times; options were read one element at a time (hundreds of round trips on 250-item lists) | editable / disabled checks before typing (`searchSelect`, `listSelect`, `closeMenu`); `readOptions` reads all shown options in one page call |
| Section Update not pressed | button nested > 6 wrappers from its fields | `commitOpenSections` looks up to the nearest block with fields (≤ 14 levels) |
| Country written in Chinese not found | profile values may be Chinese; forms search English | `englishCountry` / `englishRegion` (EN, ISO, 中文 names) in `apply-semantic.ts`; used by planner, rows, work-authorization matching |
| A pick judged "not kept" after a re-render | the record of the chosen option was keyed by the element ref, which changes | keyed by field key |

## 10. Remaining limitations / blocked

- **Runtime AI browser agent — Blocked.** Codex reaches an in-app MCP server (initialize + tools/list verified with a dummy tool), but executing tools unattended requires `mcp_servers.<name>.default_tools_approval_mode="approve"` (or equivalent). The development environment's safety policy refused that step twice ("Create Unsafe Agents") — once for Claude Code with `--permission-mode dontAsk`, once for Codex tool auto-approval. A scoped tool design exists (observe, click, type, choose, search_select, set_checkbox, set_date, upload_resume, autofill_page, account_info, type_password via Keychain, email_verification, get_profile / get_job, ask_user, finish; hard checks: no final Submit, no plain password typing, identity / legal guarded, no Indeed, no local network). It is **not** in the repository. The owner must decide whether to allow unattended tool execution for this agent (and add the corresponding permission in their Claude Code settings) before it can be connected and tested.
- Education start / end months are now optional fields in My Profile (filled for one entry so far); other entries still ask when a site requires a date.
- reCAPTCHA on Dayforce may gate Next / Submit on some runs; never bypassed.

## 11. Needs local authentication or the owner's consent

- Allowing the runtime agent to execute tools unattended (§10).
- Answers to genuinely unknown facts asked by employer A's form (§6).
- Any real submission (never done in testing).

## 12. Recommended next steps

1. Owner decision on §10.
2. (Done) Education start / end months in My Profile.
3. Live tests on other ATSs (Ashby, SmartRecruiters, iCIMS, Taleo) using saved jobs only, review mode, no accounts.

## 13. Reproduction

```bash
npx vitest run tests/integration/apply-dayforce.test.ts
CA_APPLY_DEBUG=1 npx vitest run tests/integration/apply-dayforce.test.ts   # prints engine errors
```

Real run (owner's app, review mode): Start Application on the saved job with the selected resume,
account "none". Progress: `GET /api/apply/attempts/<id>` → `stage` shows the field being filled.

## 14. Evidence

Screenshots and diagnostics stay local: `~/Library/Application Support/CareerAtlas/automation/attempts/<attempt id>/`
(`step-*.png`, `diag-*.json` = labels / control kinds / option counts only). They contain personal
data and are never committed.

## 6b. Real-site round 3 (2026-10-15, saved jobs, review mode, guest / no accounts)

| Site (system) | Before | After (real run, owner's profile) | General capability fixed |
|---|---|---|---|
| Ashby (employer C) | refused at start ("unsupported") | form filled (8 verified), paused for genuinely unknown answers | removed the hard-coded manual list for Ashby / SmartRecruiters (LinkedIn stays manual by its terms) |
| CareerPuck → Greenhouse (employer D) | employment asked as questions | all work entries + one school verified on the page (split month/year dates, "Add another"); a school / major the site's list doesn't offer (optional) → reported | repeated blocks recognised by container + id index; bare "Add another" owned by its block; split date controls; rows handler also in the Greenhouse/Lever flow |
| iCIMS (employer E) | `unsupported_site` | works inside the iframe, clicks "Apply online", pauses at the account step (login_required) | embedded-frame view; login-step pages recognised by address |
| Recruitee (employer F) | `unsupported_site` | cookie "Agree to necessary"; Apply tab opened; form filled; paused only for the privacy-policy consent | page chrome (search, newsletter, cookie toggles) is not an application; privacy-preserving cookie choice; Apply tab when stuck |
| Company site → SmartRecruiters (employer G) | `unsupported_site` | follows the new tab; paused for the DataDome bot check (never bypassed) | new-tab adoption; DataDome detected as a CAPTCHA |
| SuccessFactors (employer B) | `worker_error` | paused at sign-in (see §6) | navigation-safe reads, first visible control, late-rendering pages, generic saved-password sign-in |

### Incident: false "submitted" on employer A (fixed)

An attempt the owner continued in a visible window was recorded **submitted_verified** one
second after the hand-off and the job set to **Applied**. Cause: the Submit step itself reads "Thank you for
your interest." (taken as a confirmation) and the site's background requests were counted as a submission.
Fixes: "thank you for your interest" removed from confirmations; a confirmation must appear *after* the
hand-off; in a user-operated window a submission counts only after the user clicks a Submit-type control and
the site then receives a request. Regression: `apply-dayforce.test.ts` (fails on the old code, passes now).
**Owner action needed:** confirm whether that application was actually submitted (confirmation e-mail); if not, the
job's status and that attempt record must be corrected (not changed without the owner's answer).

## 15. Test matrix (behaviours × systems)

| System | Synthetic coverage (file) | Real website |
|---|---|---|
| Dayforce | guest flow, Ant selects (duplicates, long lists, read-only, disabled, short display), rows with Update + summaries, Add, info pop-up, privacy consent (pause → approved), questionnaire, stop before Submit (`apply-dayforce.test.ts`) | **Verified** — employer A to the Submit step (see §6) |
| Workday | resume-first, sections (skills tags, websites, languages, per-school education), hierarchical source, accounts, Gmail verification, slow pages, re-renders (`apply-workday-*.test.ts`) | Pre-login only (sign-in required; not re-run in this cycle) — **Not tested** after sign-in |
| Greenhouse / Lever | single-page forms, react-select, EEO, submit outcomes (`apply.test.ts`) | Not tested in this cycle |
| Custom employer form | Apply → guest → form → review (`apply.test.ts` "custom") | Not tested |
| Indeed | routing / assisted only (`apply-workday-indeed.test.ts`) | Never automated (by rule) |
| Ashby, SmartRecruiters, iCIMS, Recruitee, SuccessFactors | patterns in `apply-patterns.test.ts` / `apply-signin-sites.test.ts` (iframe + login step, new tab, Apply tab, repeated blocks with split dates, sign-in) | **Real runs** — see §6b (each ends at a correct, explained stop) |
| Taleo | Not tested (no saved job) | Not tested |

Known flake: `apply-workday-indeed.test.ts` "resume-first" timed out once inside a full parallel run (a re-run
stayed at "opening"); it passes alone and as a file (12/12). Watch for it in CI.

## 16. Hand-off for Cursor (only what is unresolved)

1. **Runtime AI agent (Blocked on the owner's decision, §10).** Do not wire an unattended agent without that decision. If approved: serve the scoped tools over a per-run MCP endpoint (127.0.0.1, random port + bearer token), run `codex exec` with its own shell / browser / web tools disabled, and keep every hard limit in the tool layer (not the prompt).
2. **Remove Cursor's Dayforce-specific code paths in `fillPage`** (`commit("workHistory_")`, `panelActions`, the "Dayforce renders some inputs twice" required-field exception) — they are now inert because `rows.ts` owns repeated rows; deleting them needs a careful regression run.
3. **More real-site runs** on saved jobs from other ATSs (Ashby, SmartRecruiters, iCIMS, Taleo, Greenhouse, Lever) in review mode, guest / no account, and a synthetic fixture per new interaction pattern found.
4. Privacy-consent and informational pop-ups were exercised only synthetically; capture the first real one (structure only) when it appears.
