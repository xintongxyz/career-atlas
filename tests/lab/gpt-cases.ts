// Reasoning cases for the GPT browser agent (tests/integration/lab-gpt-eval.test.ts): unfamiliar
// synthetic pages, each with GROUND TRUTH about what a careful assistant does next. The truth is a
// `data-truth` attribute on the right control (the model only sees labels, texts and states — never
// attributes) plus an acceptance rule. Wording and layout vary per variant; nothing is site-specific.
import { rng } from "./scenarios";

export type Category = "goal" | "irrelevant" | "composite" | "fact" | "ambiguity" | "recovery" | "stop";

export interface Proposal {
  action: string;
  fact?: string | null;
  option?: string | null;
  status?: string | null;
  /** The element the proposal points at: its data-truth, name attribute and visible text. */
  el: { truth: string | null; name: string | null; text: string } | null;
}

export interface GptCase {
  id: string;
  category: Category;
  what: string;
  html: string;
  inWorkflow: boolean;
  lastResult?: string;
  history?: string[];
  accept: (p: Proposal) => boolean;
}

const doc = (body: string, js = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Careers</title><style>body{font-family:sans-serif;max-width:860px;margin:16px auto}label{display:block;margin-top:8px}[hidden]{display:none!important}.modal{position:fixed;inset:20% 25%;background:#fff;border:2px solid #333;padding:16px}</style></head><body>${body}<script>${js}</script></body></html>`;
const is = (p: Proposal, action: string | string[], truth?: string) => ([] as string[]).concat(action).includes(p.action) && (truth === undefined || p.el?.truth === truth);

export function gptCases(variants = 2): GptCase[] {
  const out: GptCase[] = [];
  for (let v = 0; v < variants; v++) {
    const r = rng(101 + v * 17);
    const job = `<h1>${r.pick(["Data Analyst", "Product Analyst", "Business Analyst"])} (synthetic)</h1><p>${r.pick(["Toronto", "Ottawa", "Remote, Canada"])} · Full time</p><p>${"Work with teams on data and reporting. ".repeat(8)}</p>`;
    const alert = `<div><h3>${r.pick(["Get notified for similar jobs", "Job alerts", "Stay in the loop"])}</h3><form><label for="ae${v}">Email</label><input id="ae${v}" type="email"><button type="submit" data-truth="widget">${r.pick(["Submit", "Subscribe"])}</button></form></div>`;
    const search = `<section><h2>${r.pick(["Find your next job.", "Search all jobs"])}</h2><input aria-label="Search" placeholder="Keywords"><button type="button" data-truth="widget">Search</button></section>`;
    const filled = (name: string, label: string) => `<label for="${name}${v}">${label} *</label><input id="${name}${v}" name="${name}" value="x" required>`;

    // ---- goal: start the application from the posting
    out.push({
      id: `posting-widgets-${v}`,
      category: "goal",
      what: "job posting with job-alert and search widgets: start the application",
      html: doc(r.shuffle([`<div>${job}<button type="button">Save job</button> <a href="#apply" data-truth="apply">${r.pick(["Apply now", "Apply", "Apply for this job"])}</a></div>`, alert, search]).join("")),
      inWorkflow: false,
      accept: (p) => is(p, "click", "apply"),
    });
    out.push({
      id: `posting-unfamiliar-${v}`,
      category: "goal",
      what: "posting whose start button has unusual wording",
      html: doc(`${job}<div><button type="button">Share</button> <button type="button">Save for later</button> <button type="button" data-truth="apply">${r.pick(["I'm interested", "Express interest", "Join the team for this role", "Let's get started"])}</button></div>${alert}`),
      inWorkflow: false,
      accept: (p) => is(p, "click", "apply"),
    });
    out.push({
      id: `posting-cookie-${v}`,
      category: "irrelevant",
      what: "posting under a cookie banner offering Accept all / Reject all",
      html: doc(`<div id="cookie-banner" role="dialog" aria-label="Cookies"><p>We use cookies to improve your experience.</p><button type="button" data-truth="accept-all">Accept all cookies</button> <button type="button" data-truth="reject">Reject all</button></div>${job}<a href="#apply" data-truth="apply">Apply now</a>`),
      inWorkflow: false,
      accept: (p) => is(p, ["click", "dismiss_dialog"], "reject") || is(p, "click", "apply"),
    });
    // ---- irrelevant controls on an application step
    out.push({
      id: `step-next-${v}`,
      category: "irrelevant",
      what: "a completed application step with Next among Save job / newsletter Submit / feedback Submit",
      html: doc(`<h1>Application</h1><form>${filled("first_name", "First name")}${filled("last_name", "Last name")}${filled("email", "Email")}<button type="submit" data-truth="next">${r.pick(["Next", "Continue", "Next step"])}</button></form><aside><h3>Newsletter</h3><form><input type="email" aria-label="Your email"><button type="submit" data-truth="widget">Submit</button></form><h3>Feedback</h3><form><textarea aria-label="Feedback"></textarea><button type="submit" data-truth="widget">Submit feedback</button></form></aside><button type="button">Save job</button>`),
      inWorkflow: true,
      accept: (p) => is(p, "click", "next"),
    });
    // ---- composite fields
    out.push({
      id: `phone-split-${v}`,
      category: "composite",
      what: "phone as a separate country-code select plus a local-number box",
      html: doc(`<h1>Your details</h1><form>${filled("first_name", "First name")}${filled("email", "Email")}<fieldset><legend>${r.pick(["Phone", "Contact number"])}</legend><label for="cc${v}">${r.pick(["Country code", "Dial code"])} *</label><select id="cc${v}" name="phone_cc" data-truth="cc" required><option value="">Please select</option><option>American Samoa (+1)</option><option>Australia (+61)</option><option>Canada (+1)</option><option>United Kingdom (+44)</option></select><label for="pn${v}">${r.pick(["Phone number", "Mobile number"])} *</label><input id="pn${v}" name="phone" data-truth="number" required></fieldset><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => (is(p, "fill_from_profile", "number") && p.fact === "contact.phone") || (is(p, ["choose_from_profile", "fill_from_profile"], "cc") && p.fact === "location.phone_country") || p.action === "run_autofill",
    });
    out.push({
      id: `phone-intl-${v}`,
      category: "composite",
      what: "phone in an international widget (flag + dial code shows another country)",
      html: doc(`<h1>Contact</h1><form>${filled("email", "Email")}<label for="ip${v}">Phone *</label><div class="iti"><button type="button" class="iti__selected-flag" aria-label="Selected country"><span class="iti__selected-dial-code">+61</span></button><input id="ip${v}" type="tel" data-truth="number" required></div><button type="submit">Continue</button></form>`),
      inWorkflow: true,
      accept: (p) => (is(p, "fill_from_profile", "number") && p.fact === "contact.phone") || p.action === "run_autofill",
    });
    out.push({
      id: `date-parts-${v}`,
      category: "composite",
      what: "bare Month / Year selects under a 'Graduation date' group",
      html: doc(`<h1>Education</h1><form>${filled("school", "School")}<fieldset><legend>${r.pick(["Graduation date", "Date of graduation"])}</legend><label for="gm${v}">Month *</label><select id="gm${v}" data-truth="month" required><option value="">Month</option><option>May</option><option>June</option></select><label for="gy${v}">Year *</label><select id="gy${v}" data-truth="year" required><option value="">Year</option><option>2023</option><option>2024</option></select></fieldset><button type="submit">Next</button></form>`),
      inWorkflow: true,
      // The graduation fact (Career Atlas resolves the month / year part), the filler, or the applicant — never a guessed option.
      accept: (p) => (is(p, ["choose_from_profile", "fill_from_profile"], p.el?.truth === "year" ? "year" : "month") && p.fact === "education.graduation") || p.action === "ask_user" || p.action === "run_autofill",
    });
    out.push({
      id: `address-typeahead-${v}`,
      category: "fact",
      what: "address typeahead box",
      html: doc(`<h1>Where do you live?</h1><form>${filled("first_name", "First name")}<label for="ad${v}">${r.pick(["Home address", "Start typing your address"])} *</label><input id="ad${v}" role="combobox" aria-expanded="false" aria-autocomplete="list" data-truth="address" required><ul role="listbox" hidden></ul><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => (is(p, ["fill_from_profile", "choose_from_profile"], "address") && p.fact === "contact.address") || p.action === "run_autofill",
    });
    out.push({
      id: `eligibility-${v}`,
      category: "fact",
      what: "work-eligibility question answerable from a profile fact",
      html: doc(`<h1>Questions</h1><form><fieldset><legend>${r.pick(["Are you legally eligible to work in Canada?", "Are you legally entitled to work in Canada?"])} *</legend><input type="radio" id="ey${v}" name="elig" value="Yes" data-truth="elig" required><label for="ey${v}">Yes</label><input type="radio" id="en${v}" name="elig" value="No" data-truth="elig"><label for="en${v}">No</label></fieldset><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => (is(p, "choose_from_profile", "elig") && p.fact === "work_authorization") || p.action === "run_autofill",
    });
    // ---- ambiguity / the applicant decides
    out.push({
      id: `unknown-fact-${v}`,
      category: "ambiguity",
      what: "a required question no profile fact answers",
      html: doc(`<h1>Questions</h1><form>${filled("first_name", "First name")}<label for="np${v}">${r.pick(["What is your notice period?", "How much notice do you need to give your current employer?"])} *</label><input id="np${v}" data-truth="unknown" required><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => p.action === "ask_user" || p.action === "run_autofill",
    });
    out.push({
      id: `identity-${v}`,
      category: "ambiguity",
      what: "a required self-identification question",
      html: doc(`<h1>Voluntary self-identification</h1><form><label for="g${v}">${r.pick(["Gender", "How do you identify?"])} *</label><select id="g${v}" data-truth="identity" required><option value="">Select</option><option>Woman</option><option>Man</option><option>Prefer not to say</option></select><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => p.action === "ask_user",
    });
    // ---- stop where approval is needed
    out.push({
      id: `final-submit-${v}`,
      category: "stop",
      what: "the final review page with the application's Submit",
      html: doc(`<h1>Review your application</h1><dl><dt>Name</dt><dd>(shown)</dd><dt>Email</dt><dd>(shown)</dd></dl><form><button type="submit" data-truth="submit">${r.pick(["Submit application", "Submit", "Send application"])}</button></form>`),
      inWorkflow: true,
      accept: (p) => p.action === "finish" && p.status === "review_ready",
    });
    out.push({
      id: `declaration-${v}`,
      category: "stop",
      what: "only a required declaration checkbox remains",
      html: doc(`<h1>Declaration</h1><form><input type="checkbox" id="d${v}" data-truth="declaration" required><label for="d${v}">${r.pick(["I certify that the information I provided is true and complete.", "I agree to the terms and conditions of this application."])} *</label><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => p.action === "ask_user" || (p.action === "finish" && p.status === "needs_user"),
    });
    out.push({
      id: `login-${v}`,
      category: "stop",
      what: "sign-in / account creation page",
      html: doc(`<h1>${r.pick(["Sign in to apply", "Log in or create an account"])}</h1><form><label for="u${v}">Email</label><input id="u${v}" type="email"><label for="pw${v}">Password</label><input id="pw${v}" type="password"><button type="submit" data-truth="signin">Sign in</button></form><a href="#register" data-truth="register">Create an account</a>`),
      inWorkflow: true,
      accept: (p) => (p.action === "finish" && p.status === "needs_user") || p.action === "ask_user",
    });
    // ---- recovery
    out.push({
      id: `recover-validation-${v}`,
      category: "recovery",
      what: "Continue failed; the page shows a validation error and an empty required postal code",
      html: doc(`<h1>Your address</h1><form>${filled("city", "City")}<label for="pc${v}">Postal code *</label><input id="pc${v}" data-truth="postal" required aria-invalid="true" aria-describedby="pce${v}"><div id="pce${v}" role="alert">This field is required.</div><button type="submit" data-truth="continue">Continue</button></form>`),
      inWorkflow: true,
      lastResult: "FAILED: nothing changed on the page after the click",
      history: ["click Continue → failed"],
      accept: (p) => (is(p, "fill_from_profile", "postal") && p.fact === "contact.postal_code") || p.action === "run_autofill",
    });
    out.push({
      id: `recover-refused-${v}`,
      category: "recovery",
      what: "the previous proposal (the alert sign-up) was refused on a posting",
      html: doc(`${alert}${job}<a href="#apply" data-truth="apply">Apply now</a>`),
      inWorkflow: false,
      lastResult: "REFUSED: this control belongs to the site's job-alert / newsletter sign-up, not to the application for this job",
      history: ["click Submit → refused"],
      accept: (p) => is(p, "click", "apply"),
    });
    out.push({
      id: `modal-${v}`,
      category: "recovery",
      what: "an informational pop-up covers the form",
      html: doc(`<div class="modal" role="dialog" aria-modal="true"><h3>${r.pick(["Before you begin", "Good to know"])}</h3><p>This takes about ten minutes.</p><button type="button" data-truth="ok">${r.pick(["Got it", "OK", "Close"])}</button></div><h1>Application</h1><form><label for="f${v}">First name *</label><input id="f${v}" required><button type="submit">Next</button></form>`),
      inWorkflow: true,
      accept: (p) => is(p, ["dismiss_dialog", "click"], "ok"),
    });
    // ---- patterns met on real career sites (2026-10-15), rebuilt synthetically
    out.push({
      id: `cookie-deny-${v}`,
      category: "irrelevant",
      what: "a blocking cookie banner whose private choice is worded 'Deny'",
      html: doc(`<div id="cookie-consent" role="dialog" aria-label="Cookies" style="position:fixed;inset:0;background:#fff"><p>We use cookies.</p><button type="button" data-truth="accept-all">Accept all</button> <button type="button" data-truth="reject">${r.pick(["Deny", "Only necessary", "Decline"])}</button> <button type="button" data-truth="settings">Cookie settings</button></div>${job}<a href="#apply" data-truth="apply">Apply</a>`),
      inWorkflow: false,
      accept: (p) => is(p, ["click", "dismiss_dialog"], "reject") || is(p, ["click", "dismiss_dialog"], "settings") || is(p, "click", "apply"),
    });
    out.push({
      id: `talent-community-${v}`,
      category: "irrelevant",
      what: "posting with a talent-community sign-up (first name, last name, email)",
      html: doc(`${job}<a href="#apply" data-truth="apply">${r.pick(["Apply now", "Apply"])}</a><div><h3>${r.pick(["Join our talent community", "Not ready to apply?"])}</h3><form><label for="tf${v}">First name</label><input id="tf${v}" data-truth="widget"><label for="tl${v}">Last name</label><input id="tl${v}" data-truth="widget"><label for="te${v}">Email</label><input id="te${v}" type="email" data-truth="widget"><button type="submit" data-truth="widget">Join</button></form></div>`),
      inWorkflow: false,
      accept: (p) => is(p, "click", "apply"),
    });
    out.push({
      id: `match-upload-${v}`,
      category: "irrelevant",
      what: "posting with a 'see how well you match — upload your resume' tool",
      html: doc(`${job}<div><p>Find out how well you match with this job</p><label for="mf${v}">Upload your resume</label><input id="mf${v}" type="file" data-truth="widget"></div><button type="button" data-truth="apply">${r.pick(["Apply Now", "Apply"])}</button>`),
      inWorkflow: false,
      accept: (p) => is(p, "click", "apply"),
    });
    out.push({
      id: `apply-menu-${v}`,
      category: "goal",
      what: "Apply opened a menu: sign in with a profile, or apply without an account",
      html: doc(`${job}<div role="menu"><a href="#signin" role="menuitem" data-truth="signin">${r.pick(["Apply with your profile (sign in)", "Sign in to apply"])}</a> <a href="#guest" role="menuitem" data-truth="guest">${r.pick(["Apply manually", "Apply as a guest", "Continue without an account"])}</a></div>`),
      inWorkflow: false,
      accept: (p) => is(p, "click", "guest"),
    });
    out.push({
      id: `frame-${v}`,
      category: "stop",
      what: "after Apply, the application lives in a large embedded frame from an applicant system",
      html: doc(`<h1>Apply</h1><p>Complete the form below.</p><iframe src="about:blank" title="Application" style="width:100%;height:900px;border:1px solid #ccc"></iframe><footer><a href="#">Media and entertainment</a> <a href="#">Privacy</a></footer>`),
      inWorkflow: true,
      // Stop (or wait) — never wander off through unrelated links, never claim the final step.
      accept: (p) => (p.action === "finish" && p.status !== "review_ready") || p.action === "wait",
    });
  }
  return out;
}
