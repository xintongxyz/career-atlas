// Synthetic Workday career site for automated tests. It imitates Workday's DOM conventions
// (data-automation-id attributes, the apply-options popup, progress bar, formField-* wrappers,
// button listboxes with a decoy selectedItemList, searchable prompts that search on Enter, date
// sections that only commit real keystrokes, Add/Delete panels, server-side "Errors Found"
// validation, resume upload with delete-file, the beecatcher honeypot, the Create Account/Sign In
// step, a draft saved between visits, and a confirmation page). Fictional company; no real
// employer is contacted. Facts that could only be checked on a live tenant before sign-in are
// documented in src/local/apply/workday.ts; the steps after sign-in follow public descriptions and
// are NOT verified against a real tenant.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface WorkdayFixtureState {
  /** The candidate's Workday session (set when the "user" signs in in the visible window). */
  signedIn: boolean;
  uploads: { filename: string; sha256: string; size: number }[];
  deletes: string[];
  saves: Record<string, unknown>[];
  submissions: Record<string, unknown>[];
  /** Anything typed into the sign-in / account form or the honeypot by automation. */
  authTouched: string[];
  /** Candidate accounts on this synthetic site (e-mail → password) — test-only. */
  accounts: Record<string, string>;
  created: string[];
  signIns: string[];
  failures: Record<string, number>;
}

export const newWorkdayState = (): WorkdayFixtureState => ({ signedIn: false, uploads: [], deletes: [], saves: [], submissions: [], authTouched: [], accounts: {}, created: [], signIns: [], failures: {} });

const html = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font-family:sans-serif;max-width:860px;margin:16px auto}
 [data-automation-id^="formField-"]{margin:10px 0}
 label,legend{display:block;font-weight:600}
 [role=listbox]{border:1px solid #444;background:#fff;list-style:none;padding:0;margin:0}
 [role=option]{padding:4px;cursor:pointer}
 [data-automation-id="selectedItemList"]{border:0;display:inline}
 [data-automation-id="selectedItem"]{display:inline-block;background:#eee;margin:2px;padding:2px 6px}
 [data-automation-id="inputAlert"],[data-automation-id="errorHeading"]{color:#b00}
 .panel{border:1px solid #ccc;padding:8px;margin:8px 0}
 [hidden]{display:none!important}
 .wd-popup{position:fixed;top:30%;left:30%;background:#fff;border:2px solid #333;padding:20px}
</style></head><body>${body}<script>${script}</script></body></html>`;

function jobPage(base: string, q: string, variant: string) {
  if (variant === "closed") return html("Careers", `<div data-automation-id="errorMessage">The page you are looking for doesn't exist.</div>`);
  const opts = variant === "autofill" ? ["autofillWithResume", "useMyLastApplication"] : ["autofillWithResume", "applyManually", "useMyLastApplication"];
  const names: Record<string, string> = { autofillWithResume: "Autofill with Resume", applyManually: "Apply Manually", useMyLastApplication: "Use My Last Application" };
  return html(
    "Data Analyst (synthetic)",
    `<div data-automation-id="legalNotice">This site uses cookies. <button data-automation-id="legalNoticeDeclineButton">Decline</button><button data-automation-id="legalNoticeAcceptButton">Accept Cookies</button></div>
<div data-automation-id="jobPostingPage"><h2 data-automation-id="jobPostingHeader">Data Analyst (synthetic)</h2>
<a data-automation-id="adventureButton" href="#" role="button">Apply</a>
<div data-automation-id="jobPostingDescription"><p>Northwind Analytics (fictional) — Toronto, Ontario.</p></div></div>
<div data-automation-id="wd-popup-frame" class="wd-popup" hidden><div data-automation-id="wd-popup-content">
${opts.map((o) => `<a data-automation-id="${o}" href="${base}/apply/${o}${q}">${names[o]}</a><br>`).join("")}
</div></div>`,
    `document.querySelector('[data-automation-id="adventureButton"]').addEventListener('click', (e) => { e.preventDefault(); document.querySelector('.wd-popup').hidden = false; });
document.querySelector('[data-automation-id="legalNoticeDeclineButton"]').addEventListener('click', () => document.querySelector('[data-automation-id="legalNotice"]').remove());`,
  );
}

// The application wizard (client-side, like Workday's React app).
const APP_JS = String.raw`
const CFG = window.__WD__;
const KEY = 'wdDraft:' + CFG.job;
const V = (CFG.variant || '').split(/[+ ]/);
const has = (x) => V.includes(x);
let S = JSON.parse(localStorage.getItem(KEY) || 'null') || { v: { country: 'United States of America' }, work: [], edu: [], skills: [], files: has('oldfile') ? ['Old_Resume.pdf'] : has('samename') ? [CFG.samename] : [] };
// Autofill with Resume: first an upload page; after the upload Workday "parses" the resume and
// pre-fills the form — partly right, partly wrong, partly not in the applicant's profile.
const PARSED = () => ({ parsed: true, v: { country: 'Canada', 'legalName--firstName': 'Jordan', 'legalName--lastName': 'Okoye', email: 'j.okoye@example.test', addressLine1: '1 Parsed Street', city: 'Toronto', phone: '4165550142' },
  work: [{ jobTitle: 'Data Analyst', companyName: 'Fabrikam', current: true, startDate: '06/2024' }, { jobTitle: 'Research Assistant', companyName: 'Example University', current: false, startDate: '01/2022', endDate: '12/2022' }, { jobTitle: 'Barista', companyName: 'Parsed Café', current: false, startDate: '01/2019', endDate: '12/2019' }],
  edu: [{ school: ['Example University'], degree: "Master's Degree", field: ['Statistics'], lastYear: '2024' }], skills: [], files: S.files });
const autofillPending = () => CFG.mode === 'autofillWithResume' && !S.parsed;
const save = () => localStorage.setItem(KEY, JSON.stringify(S));
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
let seq = 0;
const id = () => 'input-' + (++seq);
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STEPS = ['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Review'];
const needAuth = () => CFG.login && !CFG.signedIn;
let authView = 'create';
let authError = '';
let verifyPending = false;
let step = 0;
let errors = [];
const app = document.getElementById('app');

// ---------- field builders (value lives in S.v[name] or a panel object)
function req(r) { return r ? '<abbr title="required">*</abbr>' : ''; }
// Live Workday shows field errors as plain text "Error: The field … is required and must have a value."
function alert(name) { const e = errors.find((x) => x.name === name); return e ? '<p class="css-1x5orh4" id="error-' + esc(name) + '"><b>Error:</b> ' + esc(e.msg) + '</p>' : ''; }
function inv(name) { return errors.some((x) => x.name === name) ? ' aria-invalid="true"' : ''; }
function text(name, label, r, bind, area) {
  const i = id();
  const v = bind.get();
  return '<div data-automation-id="formField-' + name + '"><label for="' + i + '">' + esc(label) + req(r) + '</label>' +
    (area ? '<textarea id="' + i + '" data-b="' + bind.k + '"' + inv(name) + '>' + esc(v) + '</textarea>' : '<input type="text" id="' + i + '" data-b="' + bind.k + '" value="' + esc(v) + '"' + inv(name) + '>') + alert(name) + '</div>';
}
function listbox(name, label, options, r, bind) {
  const v = bind.get();
  const lid = id();
  return '<div data-automation-id="formField-' + name + '"><label id="' + lid + '">' + esc(label) + req(r) + '</label><button type="button" aria-haspopup="listbox" aria-labelledby="' + lid + '" data-lb="' + bind.k + '" data-opts="' + esc(JSON.stringify(options)) + '"' + inv(name) + '>' + esc(v || 'Select One') + '</button>' + alert(name) + '</div>';
}
function prompt(name, label, options, r, bind, multi) {
  const vals = [].concat(bind.get() || []);
  const i = id();
  return '<div data-automation-id="formField-' + name + '"><label for="' + i + '">' + esc(label) + req(r) + '</label><div data-automation-id="multiselectInputContainer"><ul data-automation-id="selectedItemList" role="listbox">' +
    vals.map((x) => '<li role="option" data-automation-id="selectedItem">' + esc(x) + '</li>').join('') + '</ul><input id="' + i + '" data-automation-id="searchBox" placeholder="Search" data-pr="' + bind.k + '" data-multi="' + (multi ? 1 : 0) + '" data-opts="' + esc(JSON.stringify(options)) + '"' + inv(name) + '></div>' + alert(name) + '</div>';
}
function radio(name, label, options, r, bind) {
  const v = bind.get();
  return '<fieldset data-automation-id="formField-' + name + '"><legend>' + esc(label) + req(r) + '</legend>' + options.map((o) => { const i = id(); return '<input type="radio" id="' + i + '" name="' + name + '" value="' + o.value + '" data-b="' + bind.k + '"' + (v === o.value ? ' checked' : '') + '><label for="' + i + '">' + esc(o.label) + '</label>'; }).join('') + alert(name) + '</fieldset>';
}
function checkbox(name, label, r, bind) {
  const i = id();
  return '<div data-automation-id="formField-' + name + '"><input type="checkbox" id="' + i + '" data-b="' + bind.k + '"' + (bind.get() ? ' checked' : '') + inv(name) + '><label for="' + i + '">' + esc(label) + req(r) + '</label>' + alert(name) + '</div>';
}
function date(name, label, parts, r, bind) {
  const v = String(bind.get() || '');
  const bits = v ? v.split('/') : [];
  const lid = id();
  let k = 0;
  const box = (p) => { const val = bits[k++] || ''; return '<input type="text" role="spinbutton" aria-label="' + p + '" data-automation-id="dateSection' + p + '-input" data-dt="' + bind.k + '" data-part="' + p + '" value="' + esc(val) + '">'; };
  return '<div data-automation-id="formField-' + name + '"><label id="' + lid + '">' + esc(label) + req(r) + '</label><div data-automation-id="dateInputWrapper" role="group" aria-labelledby="' + lid + '">' + parts.map(box).join('/') + '</div>' + alert(name) + '</div>';
}

// ---------- bindings: "k" is a path like v.city or work.0.jobTitle
const B = {};
function bind(path) {
  const k = path;
  B[k] = {
    get: () => path.split('.').reduce((o, p) => (o == null ? undefined : o[p]), S),
    set: (val) => { const ps = path.split('.'); let o = S; for (let i = 0; i < ps.length - 1; i++) o = o[ps[i]]; o[ps[ps.length - 1]] = val; save(); },
  };
  return { k, get: B[k].get };
}

// ---------- steps
const QS = {
  auth: { label: 'Are you legally authorized to work in Canada?', name: 'primaryQuestionnaire--auth' },
  sponsor: { label: 'Will you now or in the future require sponsorship for employment visa status?', name: 'primaryQuestionnaire--sponsor' },
  why: { label: 'Please describe your sponsorship needs', name: 'primaryQuestionnaire--sponsorDetails' },
  licence: { label: "Do you have a valid driver's license?", name: 'primaryQuestionnaire--licence' },
  start: { label: 'What is your earliest available start date?', name: 'primaryQuestionnaire--start' },
};
function stepHtml() {
  if (step === 0) return '<div data-automation-id="applyFlowMyInfoPage"><h2>My Information</h2>' +
    prompt('source', 'How Did You Hear About Us?', ['Job Board', 'LinkedIn', 'Company Website', 'Employee Referral'], true, bind('v.source')) +
    radio('candidateIsPreviousWorker', 'Please indicate if you have worked with us before.', [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }], true, bind('v.prev')) +
    listbox('country', 'Country', ['Canada', 'United States of America'], true, bind('v.country')) +
    text('legalName--firstName', 'Given Name(s)', true, bind('v.legalName--firstName')) +
    text('legalName--lastName', 'Family Name', true, bind('v.legalName--lastName')) +
    text('addressLine1', 'Address Line 1', false, bind('v.addressLine1')) +
    text('city', 'City', true, bind('v.city')) +
    listbox('countryRegion', 'Province or Territory', has('codes') ? ['BC', 'ON', 'QC'] : ['British Columbia', 'Ontario', 'Quebec'], true, bind('v.region')) +
    text('postalCode', 'Postal Code', false, bind('v.postalCode')) +
    text('emailAddress', 'Email Address', true, bind('v.email')) +
    listbox('phoneType', 'Phone Device Type', ['Home Phone', 'Mobile Phone', 'Work Phone'], true, bind('v.phoneType')) +
    prompt('countryPhoneCode', 'Country Phone Code', ['Canada (+1)', 'United States of America (+1)', 'United Kingdom (+44)'], true, bind('v.phoneCode')) +
    text('phoneNumber', 'Phone Number', true, bind('v.phone')) +
    '<input type="text" name="website" data-automation-id="beecatcher" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" data-hp="1">' +
    '</div>';
  if (step === 1) {
    let h = '<div data-automation-id="applyFlowMyExpPage"><h2>My Experience</h2><div role="group" aria-labelledby="we-h"><h3 id="we-h">Work Experience</h3>';
    S.work.forEach((w, i) => {
      h += '<div class="panel" data-automation-id="workExperience-' + (i + 1) + '"><h4>Work Experience ' + (i + 1) + '</h4>' +
        text('jobTitle', 'Job Title', true, bind('work.' + i + '.jobTitle')) +
        text('companyName', 'Company', true, bind('work.' + i + '.companyName')) +
        text('location', 'Location', false, bind('work.' + i + '.location')) +
        checkbox('currentlyWorkHere', 'I currently work here', false, bind('work.' + i + '.current')) +
        date('startDate', 'From', ['Month', 'Year'], true, bind('work.' + i + '.startDate')) +
        (w.current ? '' : date('endDate', 'To', ['Month', 'Year'], true, bind('work.' + i + '.endDate'))) +
        text('roleDescription', 'Role Description', false, bind('work.' + i + '.roleDescription'), true) +
        '<button type="button" data-automation-id="panel-set-delete-button" aria-label="Delete Work Experience ' + (i + 1) + '" data-del="work.' + i + '">Delete</button></div>';
    });
    h += '<button type="button" data-automation-id="add-button" aria-label="Add Work Experience" data-add="work">' + (S.work.length ? 'Add Another' : 'Add') + '</button></div>';
    h += '<div role="group" aria-labelledby="ed-h"><h3 id="ed-h">Education</h3>';
    S.edu.forEach((e, i) => {
      h += '<div class="panel" data-automation-id="education-' + (i + 1) + '"><h4>Education ' + (i + 1) + '</h4>' +
        prompt('schoolName', 'School or University', ['Example College', 'Example University', 'University of Example Studies'], true, bind('edu.' + i + '.school')) +
        listbox('degree', 'Degree', ['High School Diploma', 'Associate Degree', "Bachelor's Degree", "Master's Degree", 'Doctorate'], true, bind('edu.' + i + '.degree')) +
        prompt('fieldOfStudy', 'Field of Study', ['Computer Science', 'Economics', 'Statistics'], false, bind('edu.' + i + '.field')) +
        date('lastYearAttended', 'To (Actual or Expected)', ['Year'], false, bind('edu.' + i + '.lastYear')) +
        '<button type="button" data-automation-id="panel-set-delete-button" aria-label="Delete Education ' + (i + 1) + '" data-del="edu.' + i + '">Delete</button></div>';
    });
    h += '<button type="button" data-automation-id="add-button" aria-label="Add Education" data-add="edu">' + (S.edu.length ? 'Add Another' : 'Add') + '</button></div>';
    h += '<div role="group"><h3>Skills</h3>' + prompt('skills', 'Type to Add Skills', ['Excel', 'Power BI', 'Python', 'R', 'SQL', 'Tableau'], false, bind('skills'), true) + '</div>';
    h += '<div role="group"><h3>Resume/CV</h3><div data-automation-id="formField-resume"><label>Upload a file (5MB max)' + req(true) + '</label><div data-automation-id="attachments-FileUpload"><div data-automation-id="file-upload-drop-zone">Drop file here or select files</div><input type="file" data-automation-id="file-upload-input-ref" style="display:none"></div>' +
      S.files.map((f) => '<div data-automation-id="file-upload-item"><span>' + esc(f) + '</span> <div data-automation-id="file-upload-successful">Successfully Uploaded!</div><button type="button" data-automation-id="delete-file" data-file="' + esc(f) + '" aria-label="Delete ' + esc(f) + '">Delete</button></div>').join('') + alert('resume') + '</div></div>';
    h += text('linkedInAccount', 'LinkedIn', false, bind('v.linkedin'));
    return h + '</div>';
  }
  if (step === 2) return '<div data-automation-id="applyFlowPrimaryQuestionsPage"><h2>Application Questions</h2>' +
    listbox(QS.auth.name, QS.auth.label, ['Yes', 'No'], true, bind('v.qAuth')) +
    listbox(QS.sponsor.name, QS.sponsor.label, ['Yes', 'No'], true, bind('v.qSponsor')) +
    (S.v.qSponsor === 'Yes' ? text(QS.why.name, QS.why.label, true, bind('v.qWhy'), true) : '') +
    radio(QS.licence.name, QS.licence.label, [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], true, bind('v.qLicence')) +
    radio('primaryQuestionnaire--applied', 'Have you applied to Northwind Analytics before?', [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], true, bind('v.qApplied')) +
    listbox('primaryQuestionnaire--coop', 'Are you enrolled in an accredited co-op program?', ['Yes', 'No'], true, bind('v.qCoop')) +
    date(QS.start.name, QS.start.label, ['Month', 'Day', 'Year'], true, bind('v.qStart')) + '</div>';
  if (step === 3) return '<section data-automation-id="applyFlowVoluntaryDisclosuresPage"><h2>Voluntary Disclosures</h2>' +
    listbox('gender', 'Gender', ['Female', 'Male', 'I do not wish to answer'], true, bind('v.gender')) +
    listbox('ethnicity', 'Ethnicity', ['Asian', 'Black', 'White', 'I do not wish to answer'], true, bind('v.ethnicity')) +
    listbox('veteranStatus', 'Veteran Status', ['I am not a veteran', 'I am a veteran', 'I do not wish to answer'], true, bind('v.veteran')) +
    listbox('indigenous', 'Do you identify as Indigenous (First Nations, Métis or Inuit)?', ['Yes', 'No', 'I prefer not to answer'], true, bind('v.indigenous')) +
    checkbox('acceptTermsAndAgreements', 'I have read and consent to the terms and conditions', true, bind('v.terms')) + '</section>';
  return '<div data-automation-id="applyFlowReviewPage"><h2>Review</h2><dl>' +
    Object.entries(S.v).filter(([k]) => !/^q|gender|ethnicity|veteran|terms/.test(k)).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') +
    '</dl><p>Work experience: ' + S.work.length + '; Education: ' + S.edu.length + '; Files: ' + esc(S.files.join(', ')) + '</p></div>';
}

function authHtml() {
  const err = authError ? '<div data-automation-id="errorMessage" role="alert">' + esc(authError) + '</div>' : '';
  if (verifyPending) return '<div data-automation-id="signInContent"><h3>Verify your account</h3><p>A verification code was sent to your email.</p><input type="text" data-automation-id="verificationCode" data-auth="1"></div>';
  if (authView === 'signin') return '<div data-automation-id="signInContent"><h3>Sign In</h3>' + err + '<form data-automation-id="signInFormo" onsubmit="return false">' +
    '<div data-automation-id="formField-email"><label>Email Address*</label><input type="text" data-automation-id="email" data-auth="1"></div>' +
    '<div data-automation-id="formField-password"><label>Password*</label><input type="password" data-automation-id="password" data-auth="1"></div>' +
    '<button type="button" data-automation-id="signInSubmitButton">Sign In</button> <button type="button" data-automation-id="createAccountLink">Create Account</button> <button type="button" data-automation-id="forgotPasswordLink">Forgot your password?</button></form></div>';
  return '<div data-automation-id="signInContent"><h3>Create Account</h3>' + err + '<form data-automation-id="signInFormo" onsubmit="return false">' +
    '<div data-automation-id="formField-email"><label>Email Address*</label><input type="text" data-automation-id="email" data-auth="1"></div>' +
    '<div data-automation-id="formField-password"><label>Password*</label><input type="password" data-automation-id="password" data-auth="1"></div>' +
    '<div data-automation-id="formField-verifyPassword"><label>Verify New Password*</label><input type="password" data-automation-id="verifyPassword" data-auth="1"></div>' +
    (has('terms') ? '<div><input type="checkbox" id="terms-cb" data-automation-id="createAccountCheckbox" data-auth="1"><label for="terms-cb">I agree to the Northwind Analytics Candidate Privacy Notice</label></div>' : '') +
    (has('signupcaptcha') && CFG.captchaShown ? '<div class="g-recaptcha" title="reCAPTCHA challenge" style="width:304px;height:478px;background:#eee"></div>' : '') +
    '<div data-automation-id="noCaptchaWrapper"></div><input type="text" name="website" data-automation-id="beecatcher" data-auth="1" style="position:absolute;left:-9999px">' +
    '<button type="button" data-automation-id="createAccountSubmitButton">Create Account</button> <button type="button" data-automation-id="signInLink">Sign In</button></form></div>';
}

function render() {
  seq = 0;
  if (needAuth()) {
    app.innerHTML = '<div data-automation-id="applyFlowPage"><h2 data-automation-id="jobTitleHeading">Data Analyst (synthetic)</h2>' + progress(-1) + authHtml() + '</div>';
    if (CFG.autologin && !CFG.autologinStarted) { CFG.autologinStarted = true; setTimeout(() => post('/wd/api/user-signed-in', {}).then(() => { CFG.signedIn = true; render(); }), 1500); } // the user signing in by hand
    return;
  }
  if (autofillPending()) {
    app.innerHTML = '<div data-automation-id="applyFlowPage"><h2 data-automation-id="jobTitleHeading">Data Analyst (synthetic)</h2>' + progress(0) +
      '<div data-automation-id="applyFlowAutofillPage"><h2>Autofill with Resume</h2><div data-automation-id="formField-resume"><label>Upload your resume to fill in the application</label><div data-automation-id="attachments-FileUpload"><div data-automation-id="file-upload-drop-zone">Drop file here or select files</div><input type="file" data-automation-id="file-upload-input-ref" style="display:none"></div></div></div>' +
      '<div data-automation-id="pageFooter"><button type="button" data-automation-id="pageFooterNextButton">Continue</button></div></div>';
    return;
  }
  app.innerHTML = '<div data-automation-id="applyFlowPage"><h2 data-automation-id="jobTitleHeading">Data Analyst (synthetic)</h2>' + progress(step) +
    (errors.length ? '<div data-automation-id="errorHeading">Errors Found</div>' : '') + stepHtml() +
    '<div data-automation-id="pageFooter">' + (step > 0 ? '<button type="button" data-automation-id="pageFooterBackButton">Back</button> ' : '') +
    '<button type="button" data-automation-id="pageFooterNextButton">' + (step === 4 ? 'Submit' : 'Save and Continue') + '</button></div></div>';
}
function progress(active) {
  const all = (CFG.login ? ['Create Account/Sign In'] : []).concat(STEPS);
  const at = active < 0 ? 0 : active + (CFG.login ? 1 : 0);
  return '<ol data-automation-id="progressBar">' + all.map((s, i) => i === at ? '<li data-automation-id="progressBarActiveStep">current step ' + (i + 1) + ' of ' + all.length + ' ' + s + '</li>' : '<li data-automation-id="progressBarInactiveStep">step ' + (i + 1) + ' of ' + all.length + ' ' + s + '</li>').join('') + '</ol>';
}

// ---------- validation (server-side in real Workday: happens on Save and Continue)
function validate() {
  const e = [];
  const need = (name, v, label) => { if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) e.push({ name, msg: 'The field ' + label + ' is required and must have a value.' }); };
  const v = S.v;
  if (step === 0) {
    need('source', v.source, 'How Did You Hear About Us?'); need('candidateIsPreviousWorker', v.prev, 'Previous worker'); need('country', v.country, 'Country');
    need('legalName--firstName', v['legalName--firstName'], 'Given Name(s)'); need('legalName--lastName', v['legalName--lastName'], 'Family Name'); need('city', v.city, 'City');
    need('countryRegion', v.region, 'Province or Territory'); need('emailAddress', v.email, 'Email Address'); need('phoneType', v.phoneType, 'Phone Device Type');
    need('countryPhoneCode', v.phoneCode, 'Country Phone Code'); need('phoneNumber', v.phone, 'Phone Number');
    if (has('validate') && v.phone && /[^0-9]/.test(v.phone)) e.push({ name: 'phoneNumber', msg: 'Phone number must contain only digits.' });
  }
  if (step === 1) {
    S.work.forEach((w) => { need('jobTitle', w.jobTitle, 'Job Title'); need('companyName', w.companyName, 'Company'); need('startDate', w.startDate, 'From'); if (!w.current) need('endDate', w.endDate, 'To'); });
    S.edu.forEach((x) => { need('schoolName', x.school, 'School'); need('degree', x.degree, 'Degree'); });
    need('resume', S.files, 'Resume');
  }
  if (step === 2) { need('primaryQuestionnaire--applied', v.qApplied, 'applied before'); need('primaryQuestionnaire--coop', v.qCoop, 'co-op'); need(QS.auth.name, v.qAuth, 'authorization'); need(QS.sponsor.name, v.qSponsor, 'sponsorship'); if (v.qSponsor === 'Yes') need(QS.why.name, v.qWhy, 'details'); need(QS.licence.name, v.qLicence, 'licence'); need(QS.start.name, v.qStart, 'start date'); }
  if (step === 3) { need('indigenous', v.indigenous, 'Indigenous identity'); need('gender', v.gender, 'Gender'); need('ethnicity', v.ethnicity, 'Ethnicity'); need('veteranStatus', v.veteran, 'Veteran Status'); if (!v.terms) e.push({ name: 'acceptTermsAndAgreements', msg: 'You must accept the terms.' }); }
  return e;
}

// ---------- events
let menu = null;
function closeMenu() { if (menu) { menu.remove(); menu = null; } }
function openMenu(anchor, options, onPick) {
  closeMenu();
  menu = document.createElement('ul');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('data-automation-id', 'activeListContainer');
  const fill = () => { if (menu) menu.innerHTML = options.map((o) => '<li role="option" data-automation-id="promptOption"><div>' + esc(o) + '</div></li>').join(''); };
  if (anchor.tagName === 'BUTTON') setTimeout(fill, 600); else fill(); // listbox options load after opening
  const r = anchor.getBoundingClientRect();
  menu.style.cssText = 'position:absolute;left:' + (r.left + scrollX) + 'px;top:' + (r.bottom + scrollY) + 'px;min-width:200px;z-index:9';
  document.body.appendChild(menu);
  menu.addEventListener('mousedown', (e) => { const li = e.target.closest('[role=option]'); if (!li) return; e.preventDefault(); const structural = onPick(li.textContent.trim()); closeMenu(); if (structural) render(); });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  const t = e.target;
  if (t.dataset && t.dataset.pr && e.key === 'Enter') {
    e.preventDefault();
    const q = t.value.toLowerCase();
    const opts = JSON.parse(t.dataset.opts).filter((o) => o.toLowerCase().includes(q));
    openMenu(t, opts, (pick) => {
      const b = B[t.dataset.pr];
      if (t.dataset.multi === '1') { const cur = [].concat(b.get() || []); if (!cur.includes(pick)) cur.push(pick); b.set(cur); } else b.set(pick);
      const list = t.closest('[data-automation-id="multiselectInputContainer"]').querySelector('[data-automation-id="selectedItemList"]');
      list.innerHTML = [].concat(b.get() || []).map((x) => '<li role="option" data-automation-id="selectedItem">' + esc(x) + '</li>').join('');
      t.value = '';
      return false;
    });
  }
  // Date sections commit typed digits only (a value set without keystrokes is not saved).
  if (t.dataset && t.dataset.dt && /^[0-9]$/.test(e.key)) t.dataset.typed = (t.dataset.typed || '') + e.key;
  if (t.dataset && t.dataset.dt && (e.key === 'Backspace' || e.key === 'Delete')) t.dataset.typed = '';
});
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.dt) {
    const wrap = t.closest('[data-automation-id="dateInputWrapper"]');
    const parts = [...wrap.querySelectorAll('[data-dt]')].map((x) => x.dataset.typed !== undefined && x.dataset.typed !== '' ? x.dataset.typed : (x.value && x.dataset.committed ? x.value : ''));
    if (parts.every(Boolean)) { B[t.dataset.dt].set(parts.map((p, i) => (i < parts.length - 1 ? p.padStart(2, '0') : p)).join('/')); }
  }
});
document.addEventListener('select', () => {}, true);
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.auth) post('/wd/api/authtouched', { field: t.getAttribute('data-automation-id') });
  if (t.dataset.hp) post('/wd/api/authtouched', { field: 'beecatcher' });
  if (t.dataset.b && t.type !== 'radio' && t.type !== 'checkbox') B[t.dataset.b].set(t.value);
  if (t.dataset.dt && !t.dataset.typed) t.dataset.typed = '';
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.type === 'radio') B[t.dataset.b].set(t.value);
  if (t.type === 'checkbox') { B[t.dataset.b].set(t.checked); if (/\.current$/.test(t.dataset.b)) render(); }
  if (t.type === 'file' && t.files[0]) {
    const f = t.files[0];
    const fd = new FormData(); fd.append('file', f);
    fetch('/wd/api/upload', { method: 'POST', body: fd }).then(() => {
      S.files = S.files.concat(f.name);
      if (autofillPending()) { setTimeout(() => { S = PARSED(); save(); step = 0; render(); }, 800); return; } // parsing…
      save(); render();
    });
  }
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-automation-id="file-upload-drop-zone"]');
  if (!t) { if (menu && !e.target.closest('[role=listbox]')) closeMenu(); return; }
  if (t.dataset.lb) {
    const b = B[t.dataset.lb];
    openMenu(t, JSON.parse(t.dataset.opts), (pick) => {
      const before = b.get();
      b.set(pick);
      t.textContent = pick;
      t.removeAttribute('aria-invalid');
      // Conditional question: appears only when sponsorship is needed (re-render like a React state change).
      return t.dataset.lb === 'v.qSponsor' && (before === 'Yes') !== (pick === 'Yes');
    });
    return;
  }
  if (t.dataset.add) { (t.dataset.add === 'work' ? S.work : S.edu).push(t.dataset.add === 'work' ? { current: false } : {}); save(); render(); return; }
  if (t.dataset.del) { const [g, i] = t.dataset.del.split('.'); S[g].splice(Number(i), 1); save(); render(); return; }
  const a = t.getAttribute('data-automation-id');
  const val = (id) => { const el = document.querySelector('[data-automation-id="signInContent"] [data-automation-id="' + id + '"]'); return el ? el.value : ''; };
  if (a === 'signInLink') { authView = 'signin'; authError = ''; render(); return; }
  if (a === 'createAccountLink') { authView = 'create'; authError = ''; render(); return; }
  if (a === 'createAccountSubmitButton') {
    if (has('signupcaptcha')) { CFG.captchaShown = true; render(); return; } // a challenge only the user can pass
    const cb = document.querySelector('[data-automation-id="createAccountCheckbox"]');
    post('/wd/api/create', { email: val('email'), password: val('password'), verify: val('verifyPassword'), terms: cb ? cb.checked : null, needTerms: has('terms') }).then((r) => r.json()).then((j) => {
      if (j.error) { authError = j.error; render(); return; }
      if (has('verify')) { verifyPending = true; render(); return; }
      CFG.signedIn = true; render();
    });
    return;
  }
  if (a === 'signInSubmitButton') {
    post('/wd/api/signin', { email: val('email'), password: val('password') }).then((r) => r.json()).then((j) => {
      if (j.error) { authError = j.error; render(); return; }
      CFG.signedIn = true; render();
    });
    return;
  }
  if (a === 'delete-file') { post('/wd/api/delete', { name: t.dataset.file }); S.files = S.files.filter((x) => x !== t.dataset.file); save(); render(); return; }
  if (a === 'pageFooterBackButton') { errors = []; step = Math.max(0, step - 1); render(); return; }
  if (a === 'pageFooterNextButton' && autofillPending()) { return; } // waits for the upload
  if (a === 'pageFooterNextButton') {
    if (step === 4) {
      t.disabled = true;
      post('/wd/api/submit', S).then((r) => r.json()).then(() => {
        localStorage.removeItem(KEY);
        app.innerHTML = '<div data-automation-id="applicationSubmittedPage"><h2>Application Submitted</h2><p>Thank you for applying. You have submitted your application for Data Analyst (synthetic).</p><a href="/wd/' + CFG.tenant + '/userHome">Go to Candidate Home</a></div>';
      });
      return;
    }
    errors = validate();
    if (!errors.length) { post('/wd/api/save', S); step += 1; }
    render();
  }
});
// Values set by script (fill) commit for plain inputs; date parts are marked committed only by keystrokes above.
render();
`;

function appPage(job: string, tenant: string, mode: string, variant: string, signedIn: boolean, samename: string) {
  const v = variant.split(/[+ ]/);
  const cfg = { job, tenant, mode, variant, login: v.includes("login") || v.includes("autologin"), autologin: v.includes("autologin"), signedIn, samename };
  return html("Apply — Data Analyst (synthetic)", `<div id="app"></div>`, `window.__WD__ = ${JSON.stringify(cfg)};\n${APP_JS}`);
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Handles /wd/... requests; returns false when the path is not a Workday fixture path. */
export async function workdayRoute(req: IncomingMessage, res: ServerResponse, u: URL, st: WorkdayFixtureState): Promise<boolean> {
  if (!u.pathname.startsWith("/wd/")) return false;
  const send = (code: number, s: string, type = "text/html; charset=utf-8") => {
    res.writeHead(code, { "content-type": type });
    res.end(s);
  };
  const variant = u.searchParams.get("variant") ?? "";
  if (req.method === "POST") {
    const raw = await body(req);
    if (u.pathname === "/wd/api/upload") {
      const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const f = form.get("file") as File;
      const buf = Buffer.from(await f.arrayBuffer());
      st.uploads.push({ filename: f.name, size: f.size, sha256: createHash("sha256").update(buf).digest("hex") });
      return send(200, "{}", "application/json"), true;
    }
    const json = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (u.pathname === "/wd/api/user-signed-in") st.signedIn = true; // the user, by hand, in the visible window
    if (u.pathname === "/wd/api/create") {
      const email = String(json.email ?? "").toLowerCase();
      const pw = String(json.password ?? "");
      const err =
        !email ? "Email Address is required."
        : st.accounts[email] !== undefined ? "An account with this email address already exists."
        : pw.length < 8 || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw) ? "Password must contain at least 8 characters, an uppercase letter, a lowercase letter, a number and a special character."
        : pw !== String(json.verify ?? "") ? "Passwords do not match."
        : json.needTerms && json.terms !== true ? "You must accept the Candidate Privacy Notice."
        : "";
      if (err) return send(200, JSON.stringify({ error: err }), "application/json"), true;
      st.accounts[email] = pw;
      st.created.push(email);
      st.signedIn = true;
      return send(200, "{}", "application/json"), true;
    }
    if (u.pathname === "/wd/api/signin") {
      const email = String(json.email ?? "").toLowerCase();
      if ((st.failures[email] ?? 0) >= 3) return send(200, JSON.stringify({ error: "Your account is locked. Reset your password." }), "application/json"), true;
      if (st.accounts[email] === undefined || st.accounts[email] !== String(json.password ?? "")) {
        st.failures[email] = (st.failures[email] ?? 0) + 1;
        return send(200, JSON.stringify({ error: "Invalid username or password." }), "application/json"), true;
      }
      st.signedIn = true;
      st.signIns.push(email);
      return send(200, "{}", "application/json"), true;
    }
    if (u.pathname === "/wd/api/authtouched") st.authTouched.push(String(json.field));
    if (u.pathname === "/wd/api/delete") st.deletes.push(String(json.name));
    if (u.pathname === "/wd/api/save") st.saves.push(json);
    if (u.pathname === "/wd/api/submit") {
      st.submissions.push(json);
      const ref = String(req.headers.referer ?? "");
      if (/variant=ambiguous/.test(ref)) return await new Promise<void>((r) => setTimeout(r, 60_000)).then(() => send(200, "{}", "application/json")), true;
    }
    return send(200, "{}", "application/json"), true;
  }
  const m = u.pathname.match(/^\/wd\/([^/]+)\/job\/([^/]+)\/([^/]+?)(\/apply\/(\w+))?$/);
  if (m) {
    const [, tenant, , , , mode] = m;
    const base = u.pathname.replace(/\/apply\/\w+$/, "");
    if (mode) return send(200, appPage(base, tenant, mode, variant, st.signedIn, u.searchParams.get("samename") ?? "Resume.pdf")), true;
    return send(200, jobPage(base, u.search, variant)), true;
  }
  if (/^\/wd\/[^/]+\/userHome$/.test(u.pathname)) return send(200, html("Candidate Home", `<h2>My Applications</h2><p>Data Analyst (synthetic) — Submitted</p>`)), true;
  return send(404, "not found"), true;
}
