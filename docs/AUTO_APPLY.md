# Automated applications (Playwright)

Career Atlas can fill in and submit an employer's application form for a saved job, in a
separate browser on your Mac, using **My Profile** and **one resume you choose from Documents**.
It is built to be truthful rather than universal: it automates the forms it understands
(Greenhouse and Lever), asks you about anything it doesn't know, and marks a job *Applied*
only after the employer's site confirms the submission.

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

Sites that are not supported (Workday, LinkedIn, Indeed, Ashby, SmartRecruiters, unknown
sites without a Greenhouse/Lever form) get **manual assistance** instead: your details ready to
copy and a link to the form. Mark the job applied yourself afterwards.

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

## Supported and untested

| System | Status |
|---|---|
| Greenhouse (job-boards.greenhouse.io, boards.greenhouse.io, embedded `?gh_jid=`) | Adapter implemented; tested only against **synthetic** forms that imitate its DOM (react-select comboboxes, `#demographic-section`, `/confirmation`). **Not yet run against a real employer.** |
| Lever (jobs.lever.co, jobs.eu.lever.co) | Adapter implemented; tested only against **synthetic** forms (`urls[…]`, `cards[…]`, `eeo[…]`, `#btn-submit`, `/thanks`). Lever uses an invisible hCaptcha on submit; if it shows a challenge, the attempt pauses for you. **Not yet run against a real employer.** |
| Workday, Ashby, SmartRecruiters, iCIMS, Taleo, SuccessFactors, LinkedIn Easy Apply, Indeed | Not supported → manual assistance. |

Known limits: company-specific Greenhouse "email security code" steps and custom question types
(date pickers, file uploads other than the resume, cover letters) pause for you. Location
autocomplete is chosen only when exactly one suggestion matches your city, region and country.

## Synthetic test (no real submission)

All automated tests use synthetic forms on 127.0.0.1 (`tests/fixtures/ats-server.ts`) and
fictional applicants; no employer is contacted.

```bash
npx vitest run tests/integration/apply.test.ts   # real headless browser + real runtime, 9 scenarios
npx vitest run tests/unit/apply-plan.test.ts     # field planning and outcome rules
npx playwright test apply                        # the UI flow end to end (production build)
```

To click through it yourself on a **throwaway** instance (never the personal database): start
the fixture server and a test instance, then create a job whose application URL is
`http://127.0.0.1:<fixture-port>/greenhouse/demo/jobs/1` (variants: `?variant=multistep`,
`ambiguous`, `validate`, `captcha`; Lever: `/lever/demo/<uuid>/apply`). Only test/dev instances
accept 127.0.0.1 targets.

Real employer forms have **not** been submitted by Career Atlas's tests. The first real use should
be in *Review before submitting* mode, checking the screenshot before approving.

## Requirements

- Node.js 22.16+, `npm install` (adds `playwright-core`, Apache-2.0; no browser download).
- A browser: Playwright's Chromium if installed (`npx playwright install chromium`, optional),
  otherwise the installed **Google Chrome** application is used with a separate profile.
- No accounts, API keys or paid services. Sites that require signing in (not Greenhouse/Lever
  normally) are handed to you in the visible window; the session stays in the isolated profile.

## Reviewed open-source projects

Ideas, not code, from: [devdattatalele/auto-apply](https://github.com/devdattatalele/auto-apply)
(MIT; locator chain, react-select handling), [andrewmillercode/Autofill-Jobs](https://github.com/andrewmillercode/Autofill-Jobs)
(MIT; Greenhouse/Lever field names) and [Br1an67/OpenJobAutofill](https://github.com/Br1an67/OpenJobAutofill)
(MIT; per-field confidence, "needs attention" marking). Not adopted: automatic EEO/consent
answers, guessed answers, "no error = submitted", e-mail/OTP scraping, account creation,
CAPTCHA workarounds, and profile storage synced to a cloud account.
