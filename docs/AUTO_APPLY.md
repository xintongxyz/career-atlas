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

Sites that are not supported (LinkedIn, Ashby, SmartRecruiters, iCIMS, Taleo, unknown sites
without a Workday/Greenhouse/Lever form) get **manual assistance** instead: your details ready to
copy and a link to the form. Mark the job applied yourself afterwards.

## Workday

Workday career sites (`*.myworkdayjobs.com`, `*.myworkdaysite.com`, and company-branded portals
recognised by Workday's own page markup) are a multi-step wizard. Career Atlas:

1. opens the posting, declines non-essential cookies, clicks **Apply** and chooses **Apply
   Manually** (no resume parsing). If an employer only offers *Autofill with Resume*, it uses that
   and treats everything Workday pre-filled as unverified (see below);
2. **Create Account / Sign In** — most employers require it. In the background the attempt pauses
   (*Needs review*). Click **Continue in a visible browser**: a window opens on the sign-in page;
   **you** sign in or create the account (and confirm the e-mail if asked). Career Atlas never
   creates accounts, generates or types passwords, reads your e-mail or ticks agreements. As soon
   as the application steps appear, filling continues in that window. The session is kept in
   Career Atlas's own browser profile, so later attempts usually skip the sign-in;
3. recognises each step from the page (steps differ between employers) and fills it:
   - **My Information** — name, address, city, province (dropdown), postal code, e-mail, country
     and phone code (searchable lists), phone number. Phone *device type*, "How did you hear about
     us?" and "Have you worked here before?" are asked (tick *Remember* to reuse your answer);
   - **My Experience** — attaches exactly the selected resume (any other file already attached is
     removed first); adds and fills one **Work Experience** panel per My Profile entry (title,
     company, "I currently work here", From/To month and year — typed as real keystrokes, which
     Workday requires) and one **Education** panel (school and field of study from the searchable
     lists — only an exact option is taken; degree by level, never by equivalence; final year);
     adds your skills that the employer's list offers exactly; LinkedIn. Entries already on the
     form (a saved draft from an earlier attempt) are matched, not duplicated;
   - **Application Questions** — answered from My Profile when it states the fact (work
     authorization, sponsorship, driver's licence, languages); dates, open questions and anything
     else are asked. Conditional questions that appear after an answer are handled on the next pass;
   - **Voluntary Disclosures / Self Identify** — gender, ethnicity, veteran and disability are
     never answered automatically; if Workday makes them required you choose (e.g. "I do not wish
     to answer"). Terms and consents are ticked only with your approval;
   - after **Save and Continue**, errors Workday reports on the step are turned into the exact
     questions to fix;
4. **Review** — a screenshot is saved. With *Review before submitting* (the default, and
   recommended until Workday has been validated on a real submission) it waits for your
   approval; then it clicks Submit and records the application only when Workday shows its
   confirmation ("Application Submitted" / "You have submitted…"). Anything else is *Unconfirmed*.

*Autofill with Resume*: Workday's parsing is not trusted. Values it pre-filled that My Profile
doesn't confirm are shown to you (pre-filled with Workday's value) to confirm or correct, and work
or education entries that aren't in My Profile are listed with **Keep / Remove**.

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
- **No bypassing.** CAPTCHAs, bot checks, sign-ins and email codes are handed to you in a visible
  window. The browser's user agent and behaviour are not disguised.
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
| Workday | ✅ multi-step wizard: sign-in pause (no typing into account forms or the honeypot), continuing after the user signs in in the window, My Information, resume upload (exact file, SHA-256 checked by the fixture), work and education panels (added once, matched later), dates by keystroke, searchable lists, listboxes, conditional question, step validation errors → exact question, voluntary disclosures and terms → your decision, review → approval → Submit → confirmation → Applied; Autofill-with-Resume values and extra entries confirmed by you, a different attached resume removed; ambiguous result → Unconfirmed (no retry); closed posting; duplicate prevention | ✅ 2026-10-14 on four public tenants (NVIDIA, Mastercard, Salesforce, and one more public posting): Workday recognised, Apply → Apply Manually opened, step 1 "Create Account/Sign In" recognised (of 6–7 steps), nothing fillable on it (sign-in fields and honeypot excluded), no request sent. Steps **after** sign-in could not be checked without an account | ❌ none |
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
- No API keys or paid services. Workday accounts are created / signed into **by you** in the
  visible window (one per employer, Workday's rule); the session stays in Career Atlas's isolated
  browser profile (`…/CareerAtlas/automation/browser-profile`), never in Git or logs.

## Reused open-source code

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for exactly which files were ported or
adapted (all MIT) and which projects were reviewed but not used (e.g. Sambhav101/workday-autofill
has no license, so none of its code was taken).
