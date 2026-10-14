# Third-party notices

Career Atlas's application automation (`src/local/apply/`) contains code ported to TypeScript from,
or selector lists and logic adapted from, the MIT-licensed projects below. Each file that uses them
names its source in a header comment. Nothing from these projects is installed, bundled or run.

| Project | Used in | What was reused |
|---|---|---|
| [jiyaa8800/indeed-auto-apply-bot](https://github.com/jiyaa8800/indeed-auto-apply-bot) (© 2026 Jiya Grover) | `src/local/apply/indeed.ts` | Ported: `indeed/domains.py` (Indeed-owned domain list, `is_indeed_owned_host`, `is_external_employer_url`), the URL rules of `indeed/page_state.py` (`classify_url`) and `indeed/apply.py` (`_classify_destination`). Test fixtures follow its documented Apply-button test ids. |
| [AbhishekMandapmalvi/AutoApply](https://github.com/AbhishekMandapmalvi/AutoApply) (© 2026 Abhishek Mandapmalvi) | `src/local/apply/workday.ts`, `engine.ts` | Adapted from `bot/apply/workday.py`: Apply-button selector candidates, the listbox dropdown strategy (`button[aria-haspopup=listbox]` → `[role=listbox] [role=option]`), page-error selectors, Submit candidates, `thankYouMessage`. |
| [Harsh-H-Shah/PaperPlane](https://github.com/Harsh-H-Shah/PaperPlane) (© 2026 Harsh Haresh Shah) | `src/local/apply/workday.ts` | From `backend/src/fillers/workday_filler.py`: choose "Apply Manually" in Workday's apply-options popup. |
| [devdattatalele/auto-apply](https://github.com/devdattatalele/auto-apply) (© 2026 Devdatta Talele) | `src/local/apply/workday.ts` | From `lib/workday.mjs`: Workday sign-in page detection selectors (used only to recognise the page and pause — never to sign in). |
| [andrewmillercode/Autofill-Jobs](https://github.com/andrewmillercode/Autofill-Jobs) (© 2025 Andrew Miller) | `src/local/apply/plan.ts`, `dom.ts`, `engine.ts` | Greenhouse / Lever / Workday field names (`src/public/contentScripts/utils.js`). |

Reviewed but **not** used: Sambhav101/workday-autofill (no license — no code taken),
nicolomantini/LinkedIn-Easy-Apply-Bot (Apache-2.0; LinkedIn only), LuisMIguelFurlanettoSousa/auto-apply-bot
(MIT; no Workday code), Br1an67/OpenJobAutofill (MIT; ideas only).

Behaviour deliberately not adopted from any of them: creating accounts or typing passwords, reading
e-mail verification codes, ticking terms or answering EEO questions automatically, default or
generated answers, automating Indeed Apply, disguising the browser or simulating "human" delays, and
treating "no error" or a Submit click as a successful application.

## MIT License (applies to each project above, with its copyright line)

Copyright (c) 2026 Jiya Grover
Copyright (c) 2026 Abhishek Mandapmalvi
Copyright (c) 2026 Harsh Haresh Shah
Copyright (c) 2026 Devdatta Talele
Copyright (c) 2025 Andrew Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
