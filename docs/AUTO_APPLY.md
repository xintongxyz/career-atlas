# Automated applications (Playwright)

Career Atlas can fill in and submit an employer's application form for a saved job, in a
separate browser on your Mac, using **My Profile** and **one resume you choose from Documents**.
It is built to be truthful rather than universal: it automates the forms it understands
(**Workday**, Greenhouse and Lever), follows **Indeed** listings to the employer's own form,
asks you about anything it doesn't know, and marks a job *Applied* only after the employer's
site confirms the submission.

## How to use it

1. Fill in **My Profile → Contact details** (name and email are required; phone, LinkedIn,
   location and work authorization are used when a form asks for them).
2. Keep your resume versions in **Documents** (kind *Resume*, PDF or Word). Any number of
   versions is supported.
3. Open a saved job → **Start application**.
   - Choose exactly one resume. The one linked to the job is preselected, but nothing starts
     until you tick the authorization box under the summary.
   - The dialog shows the company, position, application form URL, the detected system and
     which profile details are present.
   - Choose **Review before submitting** (fill everything, then wait for your approval) or
     **Submit automatically** (submit once every required field is filled from verified data).
4. Click **Start**. You can keep using Career Atlas; progress appears on the job's
   **Auto-apply** tab, as a banner on the job page, and as a small badge next to the status on
   **All Positions** and the **Kanban** board.
5. If it pauses (*Needs review*), the tab shows exactly what is needed: answer the questions,
   approve a declaration, approve the submission, or **Continue in a visible browser** to finish
   something yourself (CAPTCHA, sign-in, an unusual field). Tick *Remember this answer* only for
   answers you want reused for exactly the same question later (they appear under
   **My Profile → Saved application answers** and can be deleted there).

Sites that are not Workday, Greenhouse or Lever are filled the same way when the page has an
ordinary application form: Career Atlas clicks **Apply** (and **Apply without an account** when
that choice is offered, so no account is created) and fills from My Profile. A required answer
that is not in My Profile pauses the attempt. When the form can be completed, it stops on the
review page until you approve Submit. A signed-in Codex (ChatGPT) can choose the next control or
an unclear option; it is not given your profile values. LinkedIn, Ashby and SmartRecruiters stay
manual. Indeed is never automated.

## Workday

Workday career sites (`*.myworkdayjobs.com`, `*.myworkdaysite.com`, and company-branded portals
recognised by Workday's own page markup) are a multi-step wizard. Career Atlas:

1. opens the posting, declines non-essential cookies, clicks **Apply** and chooses **Autofill with
   Resume** (the default; *Apply Manually* is the fallback or your choice in the start dialog;
   *Use My Last Application* is never chosen);
2. **Create Account / Sign In** (see *Workday accounts* below) — signs in with a saved account,
   creates one only when you authorised it for this employer, or hands the window to you;
3. **Autofill with Resume** — uploads exactly the selected resume (SHA-256 pinned), waits for
   Workday's parsing, then **reconciles** instead of overwriting:
   - values that already match My Profile are **kept** (not erased and re-typed);
   - values My Profile contradicts are **corrected** (e.g. a mis-parsed e-mail) and listed at Review;
   - values My Profile can't confirm (e.g. a parsed street address) are **kept and flagged** at
     Review; automatic submission waits for your approval when there are any;
   - work / education entries are matched to My Profile by employer/school and title — never
     duplicated. An entry whose dates or details differ asks *Use My Profile / Keep the form's
     values*; an entry not in My Profile asks *Keep / Remove*;
   - files already attached on the employer's site are removed only with your OK, and a file with
     the same name is not assumed to be the same version;
4. recognises each step from the page and fills it: My Information, My Experience (panels, dates
   typed as keystrokes, searchable school / field-of-study / skills lists — exact options only),
   Application Questions, Voluntary Disclosures / Self Identify. Before *Save and Continue* every
   visible required field is checked; conditional questions that appear after an answer are
   filled in a second pass; after *Save and Continue*, the exact fields Workday rejects (live
   "Error: The field … is required" messages) become the questions — the rest stays as it is;
5. **Review** — the review panel shows the resume, your details, experience, education, your
   answers, corrected values and anything only the site's parsing provided. With *Review before
   submitting* (the default) it waits for your approval; *Applied* only after Workday's confirmation.

### Option and question matching (deterministic, no AI)

`src/shared/apply-semantic.ts` decides what an option or a question **means**:

- **Options**: exact → known aliases for the field's domain → context (yes/no wording) → a single
  unambiguous equivalent → otherwise you are asked. Domains: phone type (*Mobile* = *Mobile Phone*,
  *Cellular*, *Cell Phone*, *Personal Mobile*; never *Home / Work / Fax / VoIP*, never an option
  that means two things such as *Work Mobile*), country (*Canada* = *CA*, *Canada (+1)*), province
  (*Ontario* = *ON* — only in a province field), degree (*Bachelor* = *Bachelor's Degree*,
  *Undergraduate Bachelor's*), yes/no (*Yes, I am*, *Affirmative*; two options starting with "Yes"
  are ambiguous). Short codes never match by prefix.
- **Questions**: prior employment with **this** employer (*"Please indicate if you have worked
  with us before."*, *"Have you previously been employed by us?"*, *"Are you a former employee…"*,
  the employer's own name) is distinct from prior application, interview, contractor, affiliate,
  referral, *worked with our employees / clients*; work authorization (with country) is distinct
  from citizenship; sponsorship now vs. in the future; student enrolment, co-op program,
  required co-op work term, internship requirement, return to school, placement length and
  graduation date are all separate; identity questions (Indigenous identity — First Nations,
  Métis, Inuit —, visible minority, race/ethnicity, gender, sexual orientation, disability,
  veteran status) are never answered automatically; declarations, consents, background checks,
  criminal-record and conflict-of-interest questions always need your approval.

### Repeatable sections and tag boxes (`src/local/apply/wd-sections.ts`)

Each Workday section is handled as a unit, from My Profile, and every value is verified on a fresh
read of the page (React re-renders replace elements; controls are found again before each action):

- **Sections and panels** are recognised by Workday's `data-automation-id` markers, by live ids
  (`education-12--degree`: the number is an internal counter, the panel's *position* is used), or by
  the section heading plus one Delete button per entry. The **Add** button used is the one owned by
  that section (its own label, or the nearest heading above it) — Education's Add is never used for
  Websites.
- **Education**: every school keeps its own level, field and year. Existing entries (resume parsing,
  saved drafts) are matched by school (aliases such as "University of X" / "X University" / "uX");
  a wrong degree or field there is corrected from My Profile; new schools are added. Degree: the
  generic option ("Master's Degree"), a specific one ("Master of Science") only if it is the only one
  of that level. Field of study: the exact option; a joint programme ("Economics and Statistics") as
  its exact parts when the box takes several values; never a different major.
- **Websites**: LinkedIn, personal website, portfolio and GitHub (distinct by destination), one row
  each: Add → URL → type (when asked) → Save (when the tenant has one) → verified; no duplicates.
- **Languages**: one entry per saved language; language by name (Mandarin / Chinese aliases), the
  "fluent" box only for a saved fluent / native level, each proficiency control (overall or reading /
  speaking / writing) from the saved level mapped onto the site's scale — unmappable required scales
  are asked, never guessed.
- **Skills**: every saved skill, one search each, the exact suggestion or an unambiguous equivalent
  (Excel → Microsoft Excel, Python → Python (Programming Language); never Excel → Excel VBA, SQL → SQL
  Server); a tag counts only when it shows as selected. Skills the employer's list doesn't offer are
  skipped and listed at Review — they never block the application.
- **How did you hear about us?** comes from the saved job (Indeed route, LinkedIn / Indeed /
  Glassdoor links or `source=` in the job link, a company-site job); hierarchical lists are opened
  (Social Media → LinkedIn, Job Board → Indeed); a truthful broader category is used only when the
  exact source isn't offered; never Referral, Campus, Agency or similar. Unknown source → Application
  Defaults or a question.
- **Work experience**: matched by title (+ company), corrected from My Profile, added when missing;
  a richer description the site already has is kept. Entries the form shows that are not in My
  Profile are kept and listed at Review (removed only when you choose Remove).
- **Optional AI matching** (Settings → Workday accounts → *Use Claude to match unclear options*,
  off by default, needs Claude Code signed in): only when no exact / equivalent option exists, Claude
  receives ONE value (a skill, field of study, language or school) and the option list the site
  showed — nothing else from My Profile — and may name the option that means the same thing; its
  answer must be one of the options. It never supplies applicant facts.
- A section that can't be completed leaves a local diagnostic snapshot (`attempts/<id>/diag-*.json`:
  labels, control kinds, whether a value is present, option counts — never values) and a screenshot.

### Application Defaults (My Profile)

Reusable answers by **meaning** (every field can stay *Not specified* — never treated as "No"):
phone type, country calling code, how you usually hear about jobs; worked for the employer before
(general default plus **per-employer exceptions**), as a contractor, for an affiliate, referred by
an employee; start date, notice period, relocation, travel, shift work, 18 or older; currently
enrolled, full-time student, co-op program, required co-op term, internship mandatory, returning
to school, expected graduation, available placement lengths; sponsorship now / in the future;
salary and hourly expectations. An in-progress degree in My Profile establishes current enrolment
— nothing more (never co-op status). *Remember this answer* on a question saves it here by meaning
(employer-scoped answers for that employer only); identity answers are remembered only as an exact
question you opt into (deletable under *Saved application answers*).

### Workday accounts (Keychain)

Optional, per application, authorised in the start dialog:

- **Sign in automatically with the saved account** (preselected when one exists and *Settings →
  Workday accounts → Sign in automatically* is on). One try; a failure is recorded and never
  retried automatically (no account lock-outs) — you sign in or reset the password yourself.
- **Create a candidate account on <employer site> if I don't have one** (off by default, per
  employer). Uses the e-mail in *My Profile → Contact details* and either a **new strong password
  for each employer** (default) or **your shared password** (opt-in in Settings; typed once into a
  password field, never shown again). Agreements on the registration form are shown to you first
  and ticked only with your approval. "Account already exists" → no duplicate; you sign in or use
  *Forgot your password?*. CAPTCHA, MFA via an authenticator app and SSO are always yours. E-mail
  verification is yours too unless you turn on *Verification e-mails (Gmail)* (below).
- Passwords are stored only in the **macOS Keychain** (service "Career Atlas – Workday account";
  the shared one under "Career Atlas – Workday shared password"), written through `security`'s
  standard input (never a process argument), read back and compared before use, and saved
  *before* a registration is submitted so a created account always has its password. They are
  never in the repository, `.env`, SQLite, attempt records, logs, screenshots or the browser UI
  (the API only reports whether one exists). The non-secret index (which employer site has an
  account for which e-mail, last sign-in, last failure) is `…/CareerAtlas/automation/accounts.json`
  (owner-only). *Settings → Workday accounts* lists them, can forget one (deletes the Keychain item),
  **copy** a saved password to this Mac's clipboard (the local server hands it to `pbcopy`; it never
  travels through HTTP), and **save a password you already have** for an employer site (an account
  you made yourself) so the next application signs in for you.
- **After signing in**, Workday sometimes forgets *Autofill with Resume* and opens the empty form;
  Career Atlas then returns once to the autofill address so the selected resume is uploaded and parsed.
- **Slow pages.** Each step is filled only after it has finished drawing (no spinner, same number of
  fields for about a second). "Continue" is clicked only when it is shown and enabled (Workday
  disables it while it reads the resume; up to 90 s). If the page moves on while it is being filled
  (for example you click *Continue* in the window), filling stops and the new step is read. A page
  that doesn't respond is handed to you (visible window) or paused — never failed with the window closed.

### Verification e-mails (Gmail, opt-in)

Off by default; turned on by the owner on 2026-10-14 for their own Mac. *Settings → Workday accounts
→ Verification e-mails (Gmail)*:

- **Access** is IMAP over TLS to `imap.gmail.com:993` with a Google **app password** (16 letters,
  created at myaccount.google.com/apppasswords; needs 2-Step Verification). It is stored only in
  the macOS Keychain (service "Career Atlas – Gmail app password"), never returned by the API,
  logged or written to SQLite/config. The address (default: the e-mail in My Profile) is in
  `config.json`.
- **Read-only and narrow.** Mailboxes are opened with `EXAMINE`, messages with `BODY.PEEK` — nothing
  is marked read, moved or deleted. Only messages received since the account step began (INBOX and
  Spam) from a Workday sender — or naming the employer's Workday site — are opened, and only a
  verification code or a verification link on the employer's Workday site (https) is taken.
  Nothing from the mailbox is stored or logged; the attempt records only "waiting for the
  verification e-mail" / "e-mail verified" / "not found".
- **Used when** Workday shows a verification step after an account was created or a sign-in was
  tried *for this application* (account automation authorised in the start dialog). The code is
  typed into Workday's code field, or the link is opened in the automation browser; then sign-in
  continues with the saved password. If nothing arrives within 3 minutes the step is handed to you.
- The real app password is only ever sent to `imap.gmail.com:993` over TLS 1.2+ with certificate
  checks; a verification link is used only when it points at this employer's own site (another
  employer's Workday tenant is refused); messages that name the employer's site are tried first.
- Plain-text IMAP is refused with the real Keychain; tests use a synthetic IMAP server
  (`tests/fixtures/imap-server.ts`) and the in-memory store.

## Indeed

Indeed's terms forbid automated access and automating Indeed Apply, and Indeed offers no
job-seeker API (its Indeed Apply, Job Sync and Disposition Sync APIs are for employers and ATS
partners). So Career Atlas **never clicks, types or reads form content on Indeed**. What it does:

| Indeed application type | What Career Atlas does |
|---|---|
| **Apply on company site** (Indeed redirects to the employer) | *Start application* offers two routes. **Open the Indeed listing in a window**: you click *Apply on company site*; Career Atlas only watches page addresses, follows you to the employer's site and continues there — Workday, Greenhouse or Lever forms are filled as above; other employer sites become "complete it there" with your details and resume at hand. **Or paste the employer's application link** (the page *Apply on company site* opened). Either way the attempt keeps the Indeed listing as its source and the employer URL as its target, and the result is recorded on the **same saved job** (no second record). The link found is offered again for later attempts. |
| **Apply now / Easily apply** (Indeed Apply, `smartapply.indeed.com`) | **Assisted only.** You complete it on Indeed in the window, with a download link to your selected resume and your profile details (copy buttons) in Career Atlas. If Indeed's post-apply page appears, the application is recorded; otherwise you choose *It was submitted* / *It was not submitted*. |
| Sign-in / bot checks on Indeed | Yours to complete in the window; Career Atlas just waits. |

Indeed URL recognition (job pages, `rc/clk`, `applystart`, Indeed Apply, its `post-apply`
confirmation, sign-in and bot-check pages, and "left Indeed" = employer site) is ported from
jiyaa8800/indeed-auto-apply-bot (MIT); see THIRD_PARTY_NOTICES.md.

## States

| State | Meaning |
|---|---|
| Queued · 排队中 | Waiting for the browser worker (one application at a time). |
| Filling · 正在填写 | Opening the form, attaching the resume, filling and checking fields. |
| Needs review · 等待审核 | Paused for you (missing answer, declaration, approval, CAPTCHA, sign-in, site rejected the form). |
| Submitting · 正在提交 | Submit was clicked; waiting for the site's confirmation. |
| Submitted · 已确认投递 | The site confirmed it (confirmation page / message) or you confirmed it. The job is now *Applied*. |
| Unconfirmed · 结果待确认 | Submit was clicked but no confirmation was seen. **Never re-submitted automatically.** Check your email or the site, then choose *It was submitted* / *It was not submitted*. |
| Failed · 投递失败 | Stopped before submitting (unsupported page, resume missing or changed, …). Nothing was sent. |
| Cancelled · 已取消 | You cancelled before submission. |

These are execution states of one attempt. The job's pipeline status changes only through the
normal `changeStatus` service, and only after a verified submission: the append-only event
`application_submitted` records `{via: "automation", attempt_id, ats, resume_sha256, …}`, the
application records *Applied via Career Atlas automation (Greenhouse/Lever)* and the resume
actually uploaded, and the resume is linked to the application.

## Safeguards (enforced in code)

- **Never invented.** Values come only from your answers for this attempt, answers you
  explicitly saved for reuse (exact question match), or My Profile. Unknown is never turned
  into "No". Language level, degree equivalence, licence class, work authorization and years of
  experience are never inferred. An answer that doesn't match any option is asked again.
- **Sensitive questions.** Voluntary demographic (EEO) questions are left blank — and asked only
  if a form makes one required. Legal declarations, consents and signatures are ticked only
  with your explicit approval. Work-permit holders are asked about future sponsorship.
- **The selected resume only.** The document id, SHA-256, file name and size are pinned when the
  attempt starts and re-checked before upload. If the file was deleted or changed, the attempt
  fails — another resume is never substituted. The file is uploaded byte for byte; it is never
  modified, renamed or sent to any AI service.
- **Submission.** Every Submit consumes the authorization; *submit_clicked_at* is written to the
  database *before* the click. After a restart, an attempt that was submitting becomes
  *Unconfirmed*; one that never reached Submit simply starts again from the beginning.
- **Verified means verified.** Greenhouse: the `/confirmation` page; Lever: the `/thanks` page; or
  an explicit success message after the form is gone. Errors next to a still-visible form with
  no submission request = *the site rejected it* (nothing sent). Anything else = *Unconfirmed*.
- **Duplicates.** One open attempt per job; a job that already has an application, or an
  unresolved *Unconfirmed* attempt, can't start another; the same form URL can't be submitted
  from two saved jobs.
- **No bypassing.** CAPTCHAs, bot checks and sign-ins you didn't authorise are handed to you in a
  visible window; e-mail codes too, unless you turned on Gmail verification (above). The browser's user agent and behaviour are not disguised.
- **Isolated browser.** Playwright drives Chromium in its own profile folder
  (`…/CareerAtlas/automation/browser-profile`, owner-only). Your everyday Chrome profile,
  passwords and cookies are never opened. The automation browser cannot reach this computer's
  own services or the local network (requests to 127.0.0.1/private addresses are blocked on the
  personal instance).
- **Privacy.** Attempt records store field labels and sources, never the values typed. Logs
  contain attempt ids and error codes only. Screenshots (`…/CareerAtlas/automation/attempts/<id>/`)
  may show your details; they stay on your Mac, are served only to the local app, are not
  included in backups, and are removed at the next start after their job is deleted. None of
  this is ever in Git.

### Visible browser hand-off

A browser that is already running headless cannot become visible. *Continue in a visible
browser* starts a **new visible window**, fills the form again from the beginning (nothing had
been submitted), and then watches: when you finish and the site shows its confirmation, the
attempt becomes *Submitted* and the job *Applied*. If you close the window without submitting,
the attempt returns to *Needs review*; if a submission request was seen but no confirmation,
it becomes *Unconfirmed*. The window stays open for up to 30 minutes.

## What was tested, and how

| | Synthetic tests (fixtures on 127.0.0.1) | Real website, non-submitting | Real submission |
|---|---|---|---|
| Workday | ✅ resume-first (Autofill with Resume, parsed values kept / corrected / flagged, entry conflicts and extra entries asked, no duplicates), semantic options (Mobile Phone, ON), screening by meaning (prior employment default No vs. prior application; co-op never inferred; Indigenous identity asked), attachments removed only with OK (same name ≠ same file), accounts (registration with generated password, session reuse, sign-in from secure storage, wrong password never retried, existing account, terms approval, password policy, verification e-mail, CAPTCHA, no secrets in logs/DB), sign-in pause (no typing into account forms or the honeypot without authorization), continuing after the user signs in in the window, My Information, resume upload (exact file, SHA-256 checked by the fixture), work and education panels (added once, matched later), dates by keystroke, searchable lists, listboxes, conditional question, step validation errors → exact question, voluntary disclosures and terms → your decision, review → approval → Submit → confirmation → Applied; Autofill-with-Resume values and extra entries confirmed by you, a different attached resume removed; ambiguous result → Unconfirmed (no retry); closed posting; duplicate prevention | ✅ 2026-10-14 on four public tenants (NVIDIA, Mastercard, Salesforce, and one more public posting): Workday recognised, Apply → Apply Manually opened, step 1 "Create Account/Sign In" recognised (of 6–7 steps), nothing fillable on it (sign-in fields and honeypot excluded), no request sent. Steps **after** sign-in could not be checked without an account | ❌ none |
| Indeed | ✅ listing recognition; "Apply on company site" followed from the user's click (pop-up tab, `applystart` redirect) to a Workday form and submitted, recorded on the original saved job; pasted employer link → Lever; Indeed Apply completed by the user → post-apply recorded; Indeed Apply without confirmation → you record it; no request from Career Atlas to Indeed | ❌ not performed — Indeed's terms forbid automated access, so no automated test touches indeed.com | ❌ none |
| Greenhouse | ✅ (see earlier scenarios) | ❌ | ❌ |
| Lever | ✅ | ❌ | ❌ |
| Ashby, SmartRecruiters, iCIMS, Taleo, SuccessFactors, LinkedIn | — manual assistance only | — | — |

Known limits: Workday tenants that put the account step at the end, hierarchical "How did you
hear about us?" lists, Workday's own **Self Identify** disability form (handled as voluntary
disclosure, but not seen live), e-mail security codes and cover letters pause for you. Real
Workday markup after sign-in is based on public sources and could differ by employer; the first
real application should use *Review before submitting* and the review screenshot.

## Synthetic test (no real submission)

All automated tests use synthetic pages on 127.0.0.1 (`tests/fixtures/`: Greenhouse/Lever forms,
a Workday-style wizard and Indeed-style listings) and fictional applicants.

```bash
npx vitest run tests/integration/apply.test.ts                  # Greenhouse / Lever, 9 scenarios
npx vitest run tests/integration/apply-workday-indeed.test.ts   # Workday wizard + Indeed routing, 12 scenarios
npx vitest run tests/integration/apply-workday-accounts.test.ts # Workday accounts (in-memory secret store), 5 scenarios
npx vitest run tests/unit/apply-semantic.test.ts                # option / question meaning, positive and negative
npx vitest run tests/unit/apply-plan.test.ts                    # planning, outcome and URL rules
npx playwright test workflow-auto-apply                         # UI flows (production build)
LIVE=1 npx vitest run tests/local/workday-live.test.ts          # real Workday sites, stops at sign-in, never types
```

Only test/dev instances accept 127.0.0.1 targets. Real employer forms have **not** been submitted
by any test.

## Requirements

- Node.js 22.16+, `npm install` (adds `playwright-core`, Apache-2.0; no browser download).
- A browser: Playwright's Chromium if installed (`npx playwright install chromium`, optional),
  otherwise the installed **Google Chrome** application is used with a separate profile.
- No API keys or paid services. Workday accounts: signed into / created by Career Atlas only as you
  authorise per application (passwords in the macOS Keychain), otherwise by you in the visible
  window; the session stays in Career Atlas's isolated browser profile
  (`…/CareerAtlas/automation/browser-profile`), never in Git or logs.

## Reused open-source code

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for exactly which files were ported or
adapted (all MIT) and which projects were reviewed but not used (e.g. Sambhav101/workday-autofill
has no license, so none of its code was taken).
