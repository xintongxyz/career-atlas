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
| Codex CLI 0.144.6, ChatGPT sign-in | `~/.local/bin/codex` | **Yes** — structured JSON decisions with every Codex tool switched off (`src/local/codex.ts › execArgs`); drives the runtime browser agent (§17) | Runs without Claude Desktop or Cursor; no API key, no separate billing |
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
| Runtime browser agent: observe → GPT proposes one structured action → Career Atlas validates → trusted Playwright tools execute → verify → repeat (§17) | Implemented · Passed synthetic tests · **Verified live with the real GPT provider on a synthetic site** · Not yet run on a real employer site | `src/local/apply/browser-agent.ts`, `engine.ts › agentOrStop`, `src/local/runtime.ts`, `src/local/codex.ts` |

## 4. Tests executed

- `npm run typecheck`, `npm test` (unit + integration), `npm run build`, `npm run test:e2e`, `npm run db:check`, `npm run check:secrets` — results in §5.
- New: `tests/integration/apply-dayforce.test.ts` with `tests/fixtures/dayforce-fixture.ts` (synthetic Dayforce-style portal built from the live page's structure).
- Unit: `tests/unit/apply-plan.test.ts` (preferred contact method, phone-type regression), `tests/unit/apply-generic.test.ts` (row roles by meaning).
- Runtime agent: `tests/unit/apply-agent.test.ts` (trusted validation, fact catalog, field state), `tests/unit/codex-args.test.ts` (no tools, read-only), `tests/integration/apply-agent.test.ts` (scripted proposer on the unfamiliar synthetic site), `tests/integration/apply-agent-live.test.ts` (opt-in, real GPT, synthetic).

## 5. Synthetic results (2026-10-15, branch head)

- `npm run typecheck` ✓ · `npm run build` ✓ · `npm run db:check` ✓ (8 migrations, no schema change) · `npm run check:secrets` ✓ · `npm audit` 0 vulnerabilities
- `npm test`: 34 files passed, 2 skipped — 280 tests passed, 4 skipped (opt-in live tests)
- `npm run test:e2e`: 21 passed, 2 skipped
- Opt-in live: `apply-agent-live.test.ts` with the real GPT provider — passed (§17)

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

- **Runtime browser agent — built without giving the model tools (§17).** Earlier, Codex-with-MCP-tools needed unattended tool approval (`default_tools_approval_mode="approve"`, or Claude Code `--permission-mode dontAsk`); the development environment's safety policy refused both ("Create Unsafe Agents"). Not pursued. Instead the model only *proposes* JSON actions and Career Atlas executes them with its own checks — no approval setting, no unsafe flag, no model access to the shell or browser.
- The agent does **not** sign in, create accounts, type passwords, read e-mail codes, tick declarations, answer identity questions or click the final Submit (all refused in `validate()`). Sites needing these still pause for the owner (existing flows handle saved-password sign-in and Workday accounts).
- Education start / end months are now optional fields in My Profile (filled for one entry so far); other entries still ask when a site requires a date.
- reCAPTCHA on Dayforce may gate Next / Submit on some runs; never bypassed.

## 11. Needs local authentication or the owner's consent

- First real-site run of the runtime agent (review mode, saved job, guest / no account) — when the owner chooses a posting.
- Answers to genuinely unknown facts asked by employer A's form (§6).
- Any real submission (never done in testing).

## 12. Recommended next steps

1. Run the runtime agent (§17) on real saved jobs that end in `unsupported_site` / "unexpected page", review mode; add a synthetic fixture per new pattern.
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
| Unfamiliar site (no Apply button, odd step names, pop-up, identity question) — runtime agent | scripted proposer: reach Submit, refusals, ask → answer → resume, bad model stopped (`apply-agent.test.ts`) | Real GPT on the synthetic site: **passed** (§17); real employer site: Not tested |

Known flake: `apply-workday-indeed.test.ts` "resume-first" timed out once inside a full parallel run (a re-run
stayed at "opening"); it passes alone and as a file (12/12). Watch for it in CI.

## 16. Hand-off for Cursor (only what is unresolved)

1. **Runtime browser agent (§17).** Extend by adding *actions* in `browser-agent.ts` (schema + `toAgentAction` + `validate` + `act`), never by giving the model tools or loosening `validate()`. Every new action needs a refusal test in `tests/unit/apply-agent.test.ts`.
2. **Remove Cursor's Dayforce-specific code paths in `fillPage`** (`commit("workHistory_")`, `panelActions`, the "Dayforce renders some inputs twice" required-field exception) — they are now inert because `rows.ts` owns repeated rows; deleting them needs a careful regression run.
3. **More real-site runs** on saved jobs from other ATSs (Ashby, SmartRecruiters, iCIMS, Taleo, Greenhouse, Lever) in review mode, guest / no account, and a synthetic fixture per new interaction pattern found.
4. Privacy-consent and informational pop-ups were exercised only synthetically; capture the first real one (structure only) when it appears.

## 17. Runtime browser agent (GPT proposes, Career Atlas acts)

**Where it runs.** `genericFlow` → when the built-in flows cannot go further (would have been `unsupported_site`), `agentOrStop` starts `runBrowserAgent` once per run if the GPT provider is ready (`codex.ready()`: the owner's ChatGPT sign-in through the local Codex CLI; Claude Desktop / Cursor not needed). Without it: unchanged behaviour.

**Loop (per step).** OBSERVE (`observeForModel`: URL, headings, dialogs, errors, buttons `b…`, fields `f…` with label / control / required / options / state, CAPTCHA and password flags) → PROPOSE (`codex exec`, tools off, JSON schema `PROPOSAL_SCHEMA`) → VALIDATE (`validate()`, trusted) → ACT (`interact.ts` primitives; profile values resolved by Career Atlas) → VERIFY (value read back / page changed / file attached) → result fed into the next observation. Recovery: failures reported to the model; 4 failures or refusals stop the run; a repeated ask ends it with the questions.

**What the model sees about the applicant.** Only which facts exist (`factCatalog`: true / false / counts) and non-personal preferences (e.g. preferred contact method). Typed values show as `filled`; a selected option is shown only for questions that are not about the applicant. Never: names, e-mail, phone, address, documents, passwords, codes, eligibility answers.

**Hard limits (code, not prompt).** No final Submit (any wording) · no account creation / sign-in · no password fields · declarations / agreements only with the applicant's answer · identity questions only with the applicant's answer · eligibility questions not answered by free option choice · refs must be in the current observation · options must be offered · facts must be in the catalog. The agent's "final step" claim is checked: only a page with a visible Submit goes to the normal approval gate (`reviewPage` → `submitGate`), and only an application-level approval lets Career Atlas — never the model — click Submit.

**Evidence (2026-10-15, live, `apply-agent-live.test.ts`, synthetic site + fictional applicant, review mode).**
Run 1: GPT clicked "I'm interested" (no Apply button) → dismissed the tip pop-up → filled given name, family name, e-mail from facts (each verified on the page) → judged "Which office?" the applicant's choice → `ask_user` → attached the resume → `finish needs_user`. Career Atlas paused with the site's question (3–6 s per proposal).
Run 2 (after the answer): same path, `choose_from_profile applicant_answer` for the office (verified) → resume → clicked "Onward" → `finish review_ready` → Career Atlas confirmed Submit was visible → paused `submit_approval`. Nothing submitted; no applicant value in any prompt (asserted).
An earlier version looped on the same question until the step limit; fixed (asked fields marked, repeat ask ends the run, answers usable as `applicant_answer`).

**Next agent.**
1. Reproduce: `npx vitest run tests/unit/apply-agent.test.ts tests/integration/apply-agent.test.ts`; live (owner's ChatGPT sign-in, synthetic only): `CA_LIVE_CODEX=1 CA_AGENT_EVIDENCE=/tmp/agent.jsonl npx vitest run tests/integration/apply-agent-live.test.ts`.
2. Trace a run: `CA_APPLY_DEBUG=1` prints `AGENT {step, url, counts, proposal}` lines (structure only).
3. Not done: date pickers and multi-select tag inputs as agent actions; frames (the agent works on the current page / frame view only); real-site runs. Do not add sign-in, account creation, e-mail codes or Submit to the agent — those stay in the dedicated, owner-authorised flows.

## 18. Page intent (a posting is not a form) — critical fix, 2026-10-15

**Failure (real, employer H, review mode).** Career Atlas did not click the posting's
prominent "Apply now". It filled the sidebar "Get notified for similar jobs" e-mail (recorded as "Email address —
filled and verified, 1 of 1") and paused at **Ready to submit**: the sidebar's "Submit" had been taken for the
application's final Submit. Approving would have subscribed the owner to job alerts. GPT was never asked.

**Root causes (reproduced from the attempt record and the live page's structure).**
1. `PAGE_CONTROLS` counted every input outside header/nav/footer as an application field; the alert e-mail
   (`type=email`) made the posting look like a form, so `decideNavigation` chose *fill* instead of Apply.
2. `fillPage` acted on the whole page (and opened comboboxes to read options — the footer job search).
3. `decideAdvance` treated any button named "Submit" as the final step; `submitButton()` matched the
   sidebar's; `reviewPage` → `submitGate` → `submit_approval` ("ready to submit").
4. The GPT agent ran only after the rules gave up (`agentOrStop`), never on this page.

**Fix (general, no site rules).**
- `src/local/apply/page-intent.ts` — `PAGE_MAP` reads the page's structure and marks widgets
  (`data-ca-outside`): site **search** (search-typed or a one/two-field box with its own Search/Find),
  **subscription** (an e-mail box, at most with a name, that talks about alerts / newsletters, sits in a
  sidebar, or is the only field of its own small form on a page that still offers Apply), **cookie**
  banners, page-level **chrome**. Guards: never a box holding the page's h1 or an Apply control, never a
  control whose neighbourhood holds applicant fields, never inside a large form; an application's own
  footer (with Next) is not chrome. The scanner skips marked controls, so the filler, the option reader,
  rows and verification cannot touch them.
- `pageState`: **posting** (Apply offered, no application evidence) · **application** (≥ 2 applicant meanings
  or a resume upload) · **questions** (fields after entering the workflow, or step markers) · **login** ·
  **unknown**. A lone e-mail is never an application.
- `genericFlow` order: observe + purpose → milestones → cookie / guest / sign-in / CAPTCHA (fixed rules) →
  on **posting / unknown** pages the **GPT agent decides** the next step (one validated, verified action;
  refused proposals are fed back) → fixed Apply rule as fallback → **fill only inside the application** →
  Next inside it → final step.
- Milestones recorded as steps: `posting_identified`, `apply_clicked`, `application_entered` (verified on the
  next page), `form_found`, `review_reached`. `reviewPage` fails closed without `form_found`
  (`still_on_posting` / `application_form_not_found`), and clicks only the Submit marked by `MARK_SUBMIT`:
  outside widgets, in the form that holds the applicant's fields (hidden earlier steps count), explicit
  "… application" wording preferred; none → `submit_not_in_application`, several forms → `submit_ambiguous`.
- Agent: observation now carries `goal` (job title, employer), `page_state`, `widgets`, and each button's
  `area`; `validate()` refuses search / subscription controls and non-private cookie choices; the resume
  upload counts only when the page shows the file.

**Tests.** `tests/fixtures/posting-fixture.ts` (synthetic posting with Apply now, Save job, alert sign-up +
Submit, similar jobs, typeahead search; multi-step application with submit-typed Next) and
`tests/integration/apply-posting-intent.test.ts`: variants sidebar-first, search-first, late-apply, newtab,
redirect, iframe, multi-submit (newsletter + feedback Submit on the application), dead Apply
(`still_on_posting`), unfamiliar wording without AI (not filled, not ready) and with the agent (widget
proposals refused), and the original case through approval (only the application is posted). The main case
**fails on the previous engine** (it reached `submit_approval`) and passes now. Unit: `apply-page-intent.test.ts`.

**Real GPT evidence (sanitized).**
- Synthetic posting (`apply-agent-live.test.ts`): page_state *posting*, widgets *subscription: Get notified for
  similar jobs*, *search: Find your next job.* → reasoning "This is the Product Analyst posting, and Apply now
  starts its application." → click Apply now → `application_entered`, `form_found`; widget events: none. Same
  with "I'm interested" wording.
- **Real posting of employer H** (`apply-posting-probe-live.test.ts`, navigation only, empty profile, nothing typed):
  OBSERVATION page_state *posting*; widgets *subscription: Get notified for similar jobs* (e-mail + Submit +
  Manage Alerts), *search: Global search*, cookie link, header / footer chrome; Apply candidates: "Apply Now
  <job title>". REASONING "The page is the target job posting, and 'Apply Now' starts its application."
  ACTION click Apply Now — allowed. VERIFICATION page changed → the site's own application page, read as
  *application* (19 fields: resume, first / last name, address, postal code, e-mail, phone). Stopped there.

**Not done / blocked.**
- Full real run of employer H from the owner's app: the old faulty attempt (paused at "ready to submit") blocks
  a new one and must be **cancelled by the owner** in the app (cancelling it from the development session was
  refused by the session's safety check — owner data). Then: Start application, review mode, no account.
- Cookie banners offering only "Accept all" / "Manage settings" are left alone (no privacy-preserving choice);
  a banner that blocks clicks would need the owner.

## 19. General web understanding — the lab, the GPT evaluation, real-site probes (2026-10-15)

**Philosophy.** No more site-by-site fixes. Every failure found is reduced to a general root cause, fixed
once, and covered by randomly generated synthetic sites (`tests/lab`) — never by a selector for one employer.

### Phone (owner's number verified)

The owner's saved number was checked read-only in the app: the national digits match the number the owner
confirmed; the country comes from the profile country (Canada → +1). A value of the form "+61 3 …" is what an
international phone widget makes of those digits typed WITHOUT "+1" (it reads "61" as Australia) — and the old
check accepted it (it compared only the last 7 digits). Fix (`src/shared/phone.ts`): canonical number
(country from the saved "+" number, else the phone country code, else the applicant's own country — never the
job's); layout decides the typed form (local next to a separate code control; "+1…" in international widgets;
plain fields: local for a same-country job, else "+1…"); acceptance compares the normalised number INCLUDING
the code and the code shown beside it — never a suffix. The calling-code list is matched by country name
("Canada (+1)", not the first "+1" — American Samoa) or by code when only codes are listed. No profile change
was needed; the owner may optionally set Application Defaults → phone country code "+1".

### Root causes fixed (general)

| Found by | Root cause | Fix |
|---|---|---|
| lab | "Review application" / "Proceed" not treated as moving on | step vocabulary (generic.ts) |
| lab | "Start application" known to the page model but not to the navigation rule | one shared CTA definition |
| lab | typeahead with no options until typing planned as a fixed list | type, then pick the matching suggestion |
| lab | a successful pick was erased (the "close menu" step cleared the box) | close the list only |
| lab | typed query text counted as a choice | only a clicked option, shown with the list closed, counts |
| lab | bare Month / Year had no meaning; completed-degree graduation unmapped | meaning from the group heading; one completed degree's end date (several → asked) |
| lab | a verified choice reset by the site, or a control enabled late (State after Country) → asked | one more pass for lost / late controls |
| lab | single-URL multi-step forms judged "not advancing" (URL compared) | progress judged by page content |
| lab | guest routes worded "Apply as a guest / manually / without an account" | guest by meaning |
| lab | "Home address", "Current country" not recognised | meaning from wording, not from the first word |
| real (employer I, ADP system) | the validator refused "Deny" (only knew "Reject") | cookie controls by purpose (private / settings / consent) |
| real (employer N, embedded Greenhouse board) | application in an embedded frame unseen by GPT; a navigation link was clicked | frames in the observation; site navigation not clickable unless it starts the application |
| real (employer O) | a "see how well you match — upload your resume" tool made the posting look like a form | job-match uploads and talent-community sign-ups are widgets |
| GPT eval | counts in the fact list were mistaken for facts | counts moved to `profile_summary`; real `education.graduation` fact |
| unseen lab seeds | a dropdown's options were read page-wide, so a neighbouring list still closing was taken as its options | options must belong to the control (its aria-controls list, and not showing before it was opened) |
| unseen lab seeds | an answered dropdown was re-opened just to read options, leaving it "searching" (read as empty) | answered controls are not re-opened |

### What GPT now sees (no applicant values)

goal (job title, employer) · page_state · widgets (search, sign-up, matching, chrome, cookie) · frames · per
button: text, area · per field: label, control, required, state (empty / filled / site option for non-personal
questions), options, group heading, help text (aria-describedby), placeholder (site example), invalid flag,
related controls (phone: separate code control / international widget and the code shown) · which profile
facts exist · counts (profile_summary).

### Synthetic results (kept separate from real sites)

**Lab** (`tests/lab`, `tests/integration/lab-batch.test.ts`; seeded generator, hidden ground truth, graded on what
the site RECEIVED after approval; fictional applicants incl. a Canadian number starting with "61" and a UK number
saved with "+44"):

| Batch | Sites | Field identification | Profile mapping | Semantic verification | Navigation | Workflow completion | False completions | Unauthorized | Wrong applicant values |
|---|---|---|---|---|---|---|---|---|---|
| first run (seeds 1–14, before fixes) | 14 | 16/16 | 16/16 | 16/16 | 4/14 | 2/11 | 0 | 0 | 0 |
| development (seeds 1–50, after fixes) | 50 | 284/284 | 284/284 | 284/284 | 48/50 | 33/35 | 0 | 0 | 0 |
| generalization (unseen seeds 51–100) | 50 | 276/276 | 276/276 | 276/276 | 47/50 | 33/36 | 0 | 0 | 0 |
| confirmation after the last fixes (unseen seeds 101–130) | 30 | 144/144 | 144/144 | 144/144 | 30/30 | 17/17 | 0 | 0 | 0 |

The 3 misses of the unseen batch (a searchable country dropdown next to an address typeahead) had the last two
root causes above; after the fixes all 3 seeds (and the 2 earlier ones with the same pattern) pass individually.

Patterns covered (each in several random layouts, labels and orders): posting vs form, apply buttons, job alerts,
search, talent community, job-match uploads, apply menus (sign-in vs guest), cookie overlays, modals, login
pages, multi-step with review step, final submit; phone split (country names / codes only, preset to a wrong
country), international widget (auto / separate modes), masked local, "+" box, phone type; address with
dependent province (late-loaded), address typeahead (commit required); searchable dropdown (typed text
discarded); month / year parts; resume upload behind a button; required declaration; conditional
eligibility → sponsorship; skill tags; delayed rendering, re-rendering, lost selections, new tabs, iframes.

**GPT reasoning evaluation** (`tests/integration/lab-gpt-eval.test.ts`, opt-in, real GPT via Codex, nothing
executed; ground truth hidden in attributes the model never sees):

| Category | Correct (final run) |
|---|---|
| goal (start the right application, incl. unusual wording, apply menus) | 6/6 |
| ignores irrelevant controls (widgets, cookie consent, talent community, match upload) | 10/10 |
| composite fields (phone split / widget, date parts) | 6/6 |
| correct profile fact | 4/4 |
| ambiguity (unknown fact, identity) | 4/4 |
| stops where approval is needed (final submit, declaration, login, frame) | 7/8 |
| recovery (validation error, refused proposal, modal) | 6/6 |
| **all** | **43/44** |

The miss: on a page whose application lives in a frame, GPT proposed scrolling instead of stopping (harmless;
the engine opens frames itself before asking GPT). An earlier run scored 33/34 (the miss led to the fact-list
fix); a second run 42/44 exposed two rubric mistakes (corrected: the new graduation fact is a valid answer; any
non-final "finish" is a valid stop).

### Real-website results (navigation only — nothing typed, no profile, no accounts, no submission)

`tests/integration/apply-posting-probe-live.test.ts` on 10 saved postings of different systems (employers
I–R; ADP, Jobvite, Oracle Cloud, three custom career-site platforms, an embedded Greenhouse board, a
job-matching career site, two corporate sites):

| Run | Reached the application / its entry step | Correctly reported blocked | Wrong / failed |
|---|---|---|---|
| first | 6/10 | 1 (403 Forbidden) | 3: cookie "Deny" refused by the validator; a navigation link clicked (frame not visible to GPT); posting misread (match upload) |
| after the general fixes (the 3 re-probed) | 9/10 | 1 | 0 |

False completions: 0. Unauthorized actions: 0 submissions, 0 consents, 0 typing; one irrelevant navigation
click in the first run (no data sent) — now refused by the navigation guard.

### Regression status (after all changes)

`npm run typecheck` ✓ · `npm test` 317 passed, 7 skipped (opt-in live) · `npm run build` ✓ · `npm run test:e2e` 21 passed ·
`db:check` ✓ · `check:secrets` ✓ · `npm audit` 0. Two existing tests changed for a reason: the Greenhouse phone is
now checked as the same Canadian number (local digits in a plain box for a job in Canada, or "+1 …"), and the
Workday rejection test now uses a postal code in the wrong format ("m5h2n2" → asked → "M5H 2N2"), because the
phone is now entered as Workday wants it (local digits beside its own "Canada (+1)" prompt) and is no longer
rejected. The lab batch runs as its own CI job (its browser load slowed the timing-sensitive integration tests).

### Remaining unhandled patterns

- Screenshot / visual reasoning is not used (DOM structure only).
- Multiselect tag inputs are left empty (optional in the lab; no profile → tag mapping yet).
- CAPTCHA / bot walls (e.g. 403) are reported, never bypassed; sites requiring accounts pause for the owner.
- The real run of employer H (§18) still needs the owner to cancel the old faulty attempt (§18).

### How to run

```bash
npm test                                                                 # includes 4 generated sites
npm run test:lab                                                         # 16 sites (CI job "lab", report uploaded)
CA_LAB_N=50 CA_LAB_SEED=51 CA_LAB_REPORT=/tmp/lab.md npm run test:lab
CA_LIVE_CODEX=1 CA_GPT_EVAL_REPORT=/tmp/gpt.md npx vitest run tests/integration/lab-gpt-eval.test.ts
CA_LIVE_CODEX=1 CA_LIVE_POSTING_URL=<posting> npx vitest run tests/integration/apply-posting-probe-live.test.ts
```

## 20. The answer engine (application questions answered from verified records) — 2026-10-15

**Investigation (the owner's real paused application, employer N; sanitized).** 12 pending questions, by root cause:

| Question | Category | Root cause |
|---|---|---|
| School (bachelor's university) | dropdown rejected | not in the site's school list; no alias / equivalence / "Other" fallback |
| Discipline | dropdown rejected | major not in the list; no equivalence check |
| Start month / year (bachelor's) | genuinely absent | no start date in that education entry |
| "When do you expect to complete your degree?" | present, not recognised | "complete your degree" not a graduation question; only the year retrieved |
| 1–2 paragraph / 500-word data project | needs synthesis | no answer-writing capability (and mislabelled "motivation") |
| Offer / recruiting deadline | personal, time-sensitive | correctly asked; no dated storage |
| Future sponsorship (Canada) | personal decision | correctly not inferred from a work permit; asked |
| Interview recording + training consent | consequential consent | no standing-consent categories |
| Current or previous employer / title | present, not retrieved | only a role marked "current" was used; all roles had ended |
| Country of residence | present, not recognised | that wording not recognised (profile country stored in Chinese) |

**Implemented.** QUESTION → INTENT → EVIDENCE → ANSWER → SITE ACTION → VERIFICATION:
- Retrieval (`plan.ts`): latest employer + title from the same record ("current or previous" / "most recent"; strictly
  "current" still needs a current role); residence however asked; degree completion from the one degree in progress,
  month + year in text ("December 2026"; several in progress → asked).
- Answer engine (`src/local/apply/answer-engine.ts`): topic, limits (words / characters / paragraphs / maxlength) and
  writability (personal facts and decisions are never written); evidence = only the work / project / education / skills
  entries the topic needs + the job description; the provider returns sentences with evidence ids; `checkDraft` rejects
  uncited sentences, numbers / percentages / amounts not in the cited evidence (whole numbers — "25%" is not supported
  by "2025"), tools not in the evidence, names not in the evidence / job / question; one repair round, then unsupported
  sentences are dropped; filled only if the page keeps the whole text; cached with the attempt (`answers.__generated`)
  and listed at review with its flags. Gated by Application Defaults → "AI answer writing" (off by default).
- Options (`rows.ts`): school / major not listed under the profile's name → shorter searches + "Other" looked up →
  `judgeOption` (same institution; for majors also a broader containing field; never "Other", never another school) →
  else the site's "Other" → else asked.
- Standing consents (`standing_consents`, `consentCategories`, `standingConsent`): per category; a consent is given only
  if every category its text touches is authorised; accuracy only over verified values; terms only when the linked terms
  loaded; arbitration / signatures / waivers never. Unanswered consents show their categories and the missing ones.
- Asked once, stored where it belongs: education start dates → that school's entry (`entry` on the question);
  recruiting deadline → `recruiting_deadline {answer, as_of}`, reused 21 days; sponsorship → `sponsorship_future`.
- Statuses: profile fact (source = profile path, e.g. `experience.latest`), AI-written (`ai_generated`, status
  `generated`, flags), site option, consent (`consent.<categories>`), needs user (`missing`), needs consent (`legal` +
  category gap), site rejected (`not_accepted` / `no_matching_option`).

**Synthetic results.** Unit: retrieval, consents, limits, evidence, claim check, judge (`answer-engine.test.ts`,
`consent.test.ts`). Integration (`apply-answers.test.ts`, synthetic questionnaire, fictional applicant, scripted writer):
with AI writing + recording consents on, only the deadline, sponsorship and the bachelor's start date are asked; after
answering, the start date is saved to that school, sponsorship and the dated deadline to defaults; the written answer is
not rewritten on re-run; the submission carries latest employer / title, Canada, "December 2026", consent "Yes",
"Other" for the unlisted school, "Statistics" for the major. With everything off: facts still retrieved, nothing sent to
AI, the project and the consent asked.
**Real provider (fictional applicant):** 5 writing questions → 5 answers within limits, 0 flags, 0 re-check problems;
the same project question for two roles chose different evidence (internship vs. forecasting project); the deadline
question was refused; judge: "Economic Statistics" → "Statistics" (broader), an unlisted school → none, an abbreviation →
the same university, an unrelated major → none (after "Other" was removed from the judge's choices — it had once been
called "broader"). End to end on the synthetic questionnaire with the real writer: answer written, filled, verified,
listed; only the genuine unknowns asked.

**Real application (employer N, owner-approved re-run, review mode, nothing submitted).** Owner settings applied
through the app (verified backup first; everything else in the profile unchanged): AI answer writing on, all seven
consent categories. The original attempt had been cancelled by the owner; a new attempt was started on the same job.
- Before: 12 questions. After: **5** — bachelor's start month + year (absent), offer deadline (personal), future
  sponsorship (decision), and the interview consent: its text touches interview recording, internal training AND the
  employer's privacy notice; the owner authorised the first two, and the privacy-notice permission is the separate
  "Acknowledge recruitment privacy notices" setting — so it is asked (correct).
- Answered automatically and verified on the page: employer + title (latest role), country of residence (Canada),
  degree completion (master's in progress), the data-project answer (AI-written: 2 paragraphs, 128 words ≤ 500, 0 flags,
  whole text kept), school and discipline of the bachelor's degree ("Other": not listed).
- Two real-site fixes found: a consent asked as a searchable dropdown had unknown options (now "Yes" is searched and
  must be found exactly); the section heading was wrongly part of the consent text (now only the question + options).
- No false completion (state: approval / questions), nothing submitted.

**Privacy.** Only evidence entries go to the provider (unit + integration tests assert no name / e-mail / phone /
eligibility / city in what is sent); the navigation agent still sees no values; generated text stays in the local
attempt; logs and steps carry word counts and flag counts only; tests and fixtures use fictional data; no real
values in Git (grep before commit).

**Limitations.** Answers are only as specific as the records (short experience descriptions → concise answers); no
resume-text retrieval yet (structured profile only); the claim check is lexical (it catches invented numbers, tools and
names, not every paraphrased exaggeration — review stays mandatory before submit); option equivalence needs the AI
setting; "Other" free-text follow-up fields are not filled yet.

## 21. Architecture correction: one AI-directed loop, adapters as accelerators — 2026-10-16

### Diagnosis (before the change)

- **Who decided:** deterministic flows owned every step. Workday, Greenhouse / Lever and the generic flow each had
  their own loop; GPT was consulted only by the generic flow on postings / unknown pages, and as a last resort
  after the generic flow gave up. Inside a known ATS, GPT was never consulted.
- **What a surprise did:** of 56 exits in `engine.ts`, every structural surprise ended the run and went to the
  applicant — an unrecognised Workday page ("unexpected page", e.g. the owner's IKO run after My Information), Save
  and Continue not advancing, Next not available, a site rejecting a value, a control the planner could not
  operate ("not accepted", "no matching option"). Unfamiliar STRUCTURE and missing FACTS ended up in the same
  question list.
- **Disconnected tools:** the agent could not read a control's real options, pick a profile fact from a custom
  widget, or use the answer engine; the deterministic code had those abilities but did not expose them.
- **No memory, no measure:** the agent's context died with each run (an answer → the attempt re-runs from the
  start → the same problem again); nothing measured model calls, tokens or time. Each Codex call carries ~9.7k
  tokens of Codex's own instructions, so the number of calls dominates cost.

### Change (incremental; adapters kept)

- **`aiTakeover(page, why, done)` (engine.ts)** — one mechanism for every flow. When a flow's expectation fails it
  hands the AI the observed page plus `why` (what it expected — no applicant values); the agent acts with Career
  Atlas's validated tools until `done(page)` (the flow's own recognition succeeds again: a Workday step, a changed
  page, filled controls), or it reports genuinely missing facts / decisions, or a blocker. Wired into: Workday
  unrecognised page, Next not available, step not advancing, site-rejected fields; Greenhouse / Lever / generic
  questions caused by controls (`resolveInteractions`); generic "Next did not advance". The adapter resumes after.
- **General tools for the agent (browser-agent.ts, interact.ts):** `read_options` (open a dropdown / autocomplete /
  menu — field or button — and read the choices that appeared), `pick_from_profile` (Career Atlas resolves the
  fact, opens the control, picks the choice that means it — rules, then the equivalence judge — clicks and
  verifies the control shows it), `write_answer` (the answer engine fills an open question). Validation keeps every
  boundary (no Submit, accounts, passwords, widgets, identity / declarations without the applicant).
- **Blocker classes:** each paused question carries `blocker` = personal_fact | authorization | synthesis |
  interaction | page | external (`blockerOf`). Interaction questions go to the AI first; only what it cannot
  resolve, and genuine facts / decisions, reach the applicant. A page the AI cannot get past → `ai_could_not_resolve`.
- **Memory within the attempt:** a solved take-over is kept as a playbook (actions + the visible texts they targeted,
  no values) in the attempt; when the same page appears again (re-run after an answer, approval, restart) it is
  replayed through the same validated tools with **no model call**; if the replay does not reach `done`, the AI
  decides as usual.
- **Cost / latency:** `run_metrics` step per run (model calls, tokens reported by Codex, model seconds, run seconds,
  take-overs, resolved); unrecognised pages are judged once they stop changing (no fixed 15 s / 45 s waits);
  review pages inside the workflow are recognised without a model call.

### What is AI-directed vs deterministic

| Deterministic (fast, verified) | AI-directed (understanding, recovery) |
|---|---|
| filling known fields from the profile, rows, Workday sections, phone layouts, consents by category, review gate, Submit (only on approval) | postings and unknown pages, unfamiliar controls (custom pickers, odd wizards), pages an adapter does not recognise, steps that do not advance, rejected values, open answers (answer engine) |

### Evidence (synthetic sites, fictional applicant)

| Scenario | Old architecture (AI not available) | New (AI) |
|---|---|---|
| Workday tenant inserts an unfamiliar page between steps | paused, `workday_page_unrecognised` (applicant asked) | AI read it, chose "Continue with my application", pressed "Proceed →", verified; adapter resumed → Review |
| Unknown site, required custom country picker (no select / option roles) | paused, `step_not_advancing` | AI `pick_from_profile` → Canada chosen and verified → Review → approved → submitted with country=Canada |
| A page nobody can get past ("something went wrong") | — | AI reported it: `ai_could_not_resolve`, no questions invented, attempt kept |

**Real provider (CA_LIVE_CODEX=1), actual trace:**
- Workday gate: OBSERVE page_state "questions", headings "Before you continue / How would you like to continue?" →
  REASON "a non-personal continuation choice before the application" → ACTION choose_option → VERIFY "option selected
  and verified" → ACTION click "Proceed →" → VERIFY "page changed" → the Workday adapter recognised My Experience and
  continued to Review. The two later re-runs of the same attempt replayed it: 0 model calls.
- Custom picker: REASON "the page requires a country of residence through a custom picker before it can advance" →
  ACTION pick_from_profile → VERIFY "“Canada” chosen and shown by the control" → Review.

**Cost (same scenarios, real provider):** Workday gate attempt (3 runs): before replay 4 model calls; after 2
(+ 2 replays, 0 calls). Custom picker: 2 calls before (one on the review page), 1 after. Each call: ~3.5–10k tokens
(mostly Codex's own instructions), 3–10 s.

**GPT reasoning evaluation after the change (44 cases, real provider, fresh run):** 43/44 (goal 6/6, irrelevant
10/10, composite 6/6, fact 3/4, ambiguity 4/4, stop 8/8, recovery 6/6); ~3.2 s per decision. The previous run
scored 41/44 because the model used the new `pick_from_profile` on an address typeahead and on an international phone
widget's country selector — valid uses with the right fact on the right control, so the rubric now accepts them (a
wrong fact or target still fails). The remaining miss is genuine: a street-address autocomplete picked with
`location.full` instead of `contact.address`; the prompt now states what each location fact contains (not re-run).

**Regression:** `npm test` 341 passed, 10 skipped (opt-in live); `npm run test:e2e` 21 passed; typecheck, build,
secret scan clean.

### Remaining

- Replays are per attempt (not shared across employers by design — layouts are not memorised as knowledge).
- Visual (screenshot) reasoning is not used; the agent reads structure and text.
- The agent acts one decision per call; multi-action plans per call would cut calls further on long unfamiliar pages.
- Real-site validation of take-over on the owner's paused applications is pending the owner's go-ahead.
