// Synthetic Dayforce-style candidate portal (fictional employer) for automated tests. It imitates the
// interaction patterns seen on a live Dayforce posting (2026-10-15, structure only — no data entered):
//   posting → Apply → "Apply without an Account" → Candidate Info → Questionnaire → Submit
//   - Ant-Design-style selects: a search <input role=combobox> whose own value stays empty while the
//     chosen text shows in .ant-select-selection-item; options rendered twice (a visible item plus an
//     accessibility copy); long country lists that need typing; read-only selects (Preferred Contact
//     Method, source); State disabled until Country is chosen; dialing codes with flags
//   - sections that keep edits only after their own "Update" button (personal info, each row)
//   - employment / education rows: one editable row, Update → read-only summary, "Add … History"
//   - an informational pop-up after the resume upload, a privacy-consent dialog on the questionnaire
// Nothing is sent anywhere except this local server; submissions are recorded for assertions.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface DayforceFixtureState {
  submissions: Record<string, unknown>[];
  nexts: { step: string; ok: boolean; errors: string[] }[];
}
export const newDayforceState = (): DayforceFixtureState => ({ submissions: [], nexts: [] });

const COUNTRIES = ["Afghanistan", "Albania", "Algeria", "Argentina", "Australia", "Austria", "Bangladesh", "Belgium", "Brazil", "Bulgaria", "Cambodia", "Cameroon", "Canada", "Chile", "China", "Colombia", "Croatia", "Cuba", "Denmark", "Egypt", "Finland", "France", "Germany", "Ghana", "Greece", "Hong Kong", "Hungary", "India", "Indonesia", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Kenya", "Mexico", "Netherlands", "New Zealand", "Nigeria", "Norway", "Pakistan", "Peru", "Philippines", "Poland", "Portugal", "Romania", "Singapore", "South Africa", "Spain", "Sweden", "Switzerland", "Taiwan", "Thailand", "Turkey", "Ukraine", "United Kingdom", "United States of America", "Vietnam"];
const DIAL = ["🇦🇬 +1 Antigua and Barbuda", "🇧🇸 +1 Bahamas", "🇨🇦 +1 Canada", "🇯🇲 +1 Jamaica", "🇺🇸 +1 United States of America", "🇷🇺 +7 Russian Federation", "🇬🇧 +44 United Kingdom", "🇨🇳 +86 China", "🇮🇳 +91 India"];
const PROVINCES: Record<string, string[]> = { Canada: ["Alberta", "British Columbia", "Ontario", "Quebec"], China: ["Beijing", "Guangdong", "Shanghai"], "United States of America": ["California", "New York"] };

const APP = String.raw`
const ST = { step: 'info', info: { saved: false }, work: [{ editing: true }], edu: [{ editing: true }], files: [], q: {}, consent: false };
const H = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = document.getElementById('app');
const COUNTRIES = ${JSON.stringify(COUNTRIES)};
const DIAL = ${JSON.stringify(DIAL)};
const PROVINCES = ${JSON.stringify(PROVINCES)};
const SOURCES = ['Recruiter', 'Jobillico', 'Workopolis', 'Indeed', 'Agency', 'Employee Referral', 'Other', 'Linkedin', 'Educational Institution'];
let errors = [];

// ---- Ant-style select
function sel(id, label, value, opts, { required = false, readonly = false, disabled = false } = {}) {
  return '<div class="field"><label for="' + id + '">' + H(label) + (required ? ' <span class="req">*</span>' : '') + '</label>' +
    '<div class="ant-select' + (disabled ? ' ant-select-disabled' : '') + '" data-sel="' + id + '" data-opts="' + H(JSON.stringify(opts)) + '">' +
    '<div class="ant-select-selector"><span class="ant-select-selection-search"><input type="search" role="combobox" aria-haspopup="listbox" aria-autocomplete="list" class="ant-select-selection-search-input" id="' + id + '"' + (readonly ? ' readonly' : '') + (disabled ? ' disabled' : '') + (required ? ' aria-required="true"' : '') + '></span>' +
    // Like the live site, a dialing-code select shows only the short form ("🇨🇦 +1") once chosen.
    (value ? '<span class="ant-select-selection-item"><span>' + H(id === 'rc_select_0' ? value.split(' ').slice(0, 2).join(' ') : value) + '</span></span>' : '<span class="ant-select-selection-placeholder"></span>') + '</div></div>' + err(id) + '</div>';
}
function txt(id, label, value, { required = false, type = 'text', area = false } = {}) {
  return '<div class="field"><label for="' + id + '">' + H(label) + (required ? ' <span class="req">*</span>' : '') + '</label>' +
    (area ? '<textarea id="' + id + '">' + H(value) + '</textarea>' : '<input type="' + type + '" id="' + id + '" value="' + H(value) + '"' + (required ? ' aria-required="true"' : '') + '>') + err(id) + '</div>';
}
function chk(id, label, value) { return '<div class="field"><input type="checkbox" id="' + id + '"' + (value ? ' checked' : '') + '><label for="' + id + '">' + H(label) + '</label></div>'; }
function err(id) { const e = errors.find((x) => x.id === id); return e ? '<div role="alert" class="ant-form-item-explain-error">' + H(e.msg) + '</div>' : ''; }

let dd = null;
function closeDD() { if (dd) { dd.remove(); dd = null; } }
function openDD(box) {
  closeDD();
  const id = box.dataset.sel;
  const input = box.querySelector('input');
  if (input.disabled) return;
  const all = JSON.parse(box.dataset.opts);
  const render = () => {
    const q = (input.readOnly ? '' : input.value).toLowerCase();
    const list = all.filter((o) => o.toLowerCase().includes(q));
    // An accessibility copy of each option (visible-sized, like the live site) plus the real item.
    dd.innerHTML = '<div role="listbox" class="a11y">' + list.map((o) => '<div role="option" aria-label="' + H(o) + '">' + H(o) + '</div>').join('') + '</div>' +
      '<div class="rc-virtual-list-holder">' + list.map((o) => '<div class="ant-select-item ant-select-item-option" title="' + H(o) + '"><div class="ant-select-item-option-content">' + H(o) + '</div></div>').join('') + '</div>';
  };
  dd = document.createElement('div');
  dd.className = 'ant-select-dropdown';
  const r = box.getBoundingClientRect();
  dd.style.cssText = 'position:absolute;left:' + (r.left + scrollX) + 'px;top:' + (r.bottom + scrollY) + 'px;width:' + r.width + 'px;z-index:20;background:#fff;border:1px solid #888';
  document.body.appendChild(dd);
  render();
  input.oninput = () => render();
  dd.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.ant-select-item-option');
    if (!item) return; // the accessibility copy is not clickable
    e.preventDefault();
    setValue(id, item.getAttribute('title'));
    closeDD();
    rerender();
  });
}
document.addEventListener('mousedown', (e) => {
  const box = e.target.closest('.ant-select');
  if (box) { openDD(box); return; }
  if (dd && !e.target.closest('.ant-select-dropdown')) closeDD();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDD(); });

const V = {};
function setValue(id, v) { V[id] = v; if (id === 'pi_country') V.pi_state = ''; }
function val(id) { return V[id] || ''; }

// ---- steps
function infoHtml() {
  const pi = ST.info;
  let h = '<h2>Candidate Info</h2><p>Click Import Resume to add this information from your resume.</p>' +
    '<div class="field"><label for="resume">Attachment:</label><div class="ant-upload-wrapper"><input type="file" id="resume" style="display:none"><button type="button" id="import">Import Resume</button>' +
    '<div class="ant-upload-list">' + ST.files.map((f) => '<div class="ant-upload-list-item"><span class="ant-upload-list-item-name">' + H(f) + '</span></div>').join('') + '</div></div></div>';
  h += '<section id="personal"><h3>Personal Information</h3>';
  if (pi.saved && !pi.editing) {
    h += '<div class="summary">' + H(val('pi_first') + ' ' + val('pi_last')) + ' · ' + H(val('pi_email')) + ' · ' + H(val('pi_contact')) + '</div><button type="button" id="editInfo">Edit</button>';
  } else {
    h += txt('pi_email', 'Email Address', val('pi_email'), { required: true }) + txt('pi_confirm', 'Confirm Email Address', val('pi_confirm'), { required: true }) +
      txt('pi_first', 'First Name', val('pi_first'), { required: true }) + txt('pi_middle', 'Middle Name', val('pi_middle')) + txt('pi_last', 'Last Name', val('pi_last'), { required: true }) +
      '<div class="field phone"><span class="sr">Mobile Phone Number</span>' + sel('rc_select_0', 'Country dialing code', val('rc_select_0'), DIAL).replace('<label for="rc_select_0">Country dialing code</label>', '').replace('id="rc_select_0"', 'id="rc_select_0" aria-label="Country dialing code"') + '</div>' +
      txt('pi_mobile', 'Mobile Phone Number', val('pi_mobile'), { required: true }) +
      sel('pi_contact', 'Preferred Contact Method', val('pi_contact'), ['Email', 'Mobile Phone'], { required: true, readonly: true }) +
      sel('pi_country', 'Country', val('pi_country'), COUNTRIES) +
      sel('pi_state', 'State/Province', val('pi_state'), PROVINCES[val('pi_country')] || [], { disabled: !val('pi_country') }) +
      txt('pi_addr', 'Address Line 1', val('pi_addr')) + txt('pi_city', 'City', val('pi_city')) + txt('pi_postal', 'Zip / Postal Code', val('pi_postal')) +
      sel('pi_source', 'How did you hear about this job?', val('pi_source'), SOURCES, { required: true, readonly: true }) +
      '<button type="submit" id="saveInfo">Update</button> <button type="reset" id="cancelInfo">Cancel</button>';
  }
  h += '</section>';
  h += '<section id="work"><h3>Employment History</h3>';
  ST.work.forEach((w, i) => {
    if (!w.editing) { h += '<div class="summary card">' + H(w.title) + ' — ' + H(w.company) + ' <button type="button" data-edit="work.' + i + '">Edit</button> <button type="button" data-del="work.' + i + '">Delete</button></div>'; return; }
    const p = 'jobPostingApplication_workHistory_' + i + '_';
    h += '<div class="row">' + txt(p + 'title', 'Position Title', w.title, { required: true }) + chk(p + 'isCurrent', 'Current Job', w.current) + txt(p + 'companyName', 'Employer Name', w.company, { required: true }) +
      txt(p + 'effectiveStart', 'Start Date', w.start, { type: 'date', required: true }) + (w.current ? '' : txt(p + 'effectiveEnd', 'End Date', w.end, { type: 'date' })) +
      sel(p + 'countryCode', 'Country', w.country, COUNTRIES) + txt(p + 'city', 'City', w.city) + txt(p + 'description', 'Duties and Responsibilities', w.desc, { area: true }) +
      '<button type="submit" data-save="work.' + i + '">Update</button> <button type="reset" data-cancel="work.' + i + '">Cancel</button></div>';
  });
  h += '<button type="button" id="addWork">Add Employment History</button></section>';
  h += '<section id="edu"><h3>Education History</h3>';
  ST.edu.forEach((e, i) => {
    if (!e.editing) { h += '<div class="summary card">' + H(e.school) + ' — ' + H(e.degree) + ', ' + H(e.major) + ' <button type="button" data-edit="edu.' + i + '">Edit</button></div>'; return; }
    const p = 'jobPostingApplication_educationHistory_' + i + '_';
    h += '<div class="row">' + txt(p + 'degreeName', 'Degree', e.degree, { required: true }) + chk(p + 'notCompleted', 'Not Completed', e.notCompleted) + txt(p + 'majorName', 'Major', e.major) + txt(p + 'minorName', 'Minor', e.minor) +
      txt(p + 'effectiveStart', 'Start Date', e.start, { type: 'date' }) + txt(p + 'effectiveEnd', 'End Date', e.end, { type: 'date' }) + txt(p + 'schoolName', 'School', e.school, { required: true }) + sel(p + 'countryCode', 'Country', e.country, COUNTRIES) +
      '<button type="submit" data-save="edu.' + i + '">Update</button> <button type="reset" data-cancel="edu.' + i + '">Cancel</button></div>';
  });
  h += '<button type="button" id="addEdu">Add Education History</button></section>';
  return h;
}
function questionHtml() {
  return '<h2>Questionnaire</h2>' +
    '<fieldset><legend>Are you legally eligible to work in Canada? *</legend><input type="radio" name="q_auth" id="qa_y" value="Yes"' + (ST.q.auth === 'Yes' ? ' checked' : '') + '><label for="qa_y">Yes</label><input type="radio" name="q_auth" id="qa_n" value="No"' + (ST.q.auth === 'No' ? ' checked' : '') + '><label for="qa_n">No</label>' + err('q_auth') + '</fieldset>' +
    '<div class="field"><label for="q_why">Why are you interested in this role?</label><textarea id="q_why">' + H(ST.q.why) + '</textarea></div>';
}
// Like the live site, the Submit step already says "Thank you for your interest." — that is not a confirmation.
function submitHtml() { return '<h2>Review your application</h2><p>Thank you for your interest. Please review before submitting.</p><button type="button" id="submitApp">Submit</button>'; }
function rerender() {
  // Preserve typed values of plain inputs across re-renders (like React state).
  document.querySelectorAll('#app input[type=text], #app input[type=date], #app textarea').forEach((i) => { if (i.id) V[i.id] = i.value; });
  draw();
}
function draw() {
  const steps = ['info', 'questionnaire', 'submit'];
  app.innerHTML = '<ol class="ant-steps">' + steps.map((s) => '<li' + (s === ST.step ? ' aria-current="step"' : '') + '>' + s + '</li>').join('') + '</ol>' +
    (errors.length && !errors.some((e) => e.id) ? '<div role="alert">' + H(errors.map((e) => e.msg).join(' ')) + '</div>' : '') +
    (ST.step === 'info' ? infoHtml() : ST.step === 'questionnaire' ? questionHtml() : submitHtml()) +
    '<footer><button type="button" id="cancelApp">Cancel</button> ' + (ST.step !== 'submit' ? '<button type="button" id="next">Next</button>' : '') + '</footer>';
  // restore plain values into new nodes
  document.querySelectorAll('#app input[type=text], #app input[type=date], #app textarea').forEach((i) => { if (i.id && V[i.id] !== undefined && !i.value) i.value = V[i.id]; });
}
function rowFrom(kind, i) {
  const p = 'jobPostingApplication_' + (kind === 'work' ? 'workHistory_' : 'educationHistory_') + i + '_';
  const g = (k) => { const el = document.getElementById(p + k); return el ? (el.type === 'checkbox' ? el.checked : el.value) : ''; };
  if (kind === 'work') return { title: g('title'), company: g('companyName'), current: g('isCurrent'), start: g('effectiveStart'), end: g('effectiveEnd'), country: val(p + 'countryCode'), city: g('city'), desc: g('description') };
  return { degree: g('degreeName'), notCompleted: g('notCompleted'), major: g('majorName'), minor: g('minorName'), start: g('effectiveStart'), end: g('effectiveEnd'), school: g('schoolName'), country: val(p + 'countryCode') };
}
function modal(html, buttons, onClick) {
  const m = document.createElement('div');
  m.className = 'ant-modal';
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  m.style.cssText = 'position:fixed;top:20%;left:10%;width:70%;background:#fff;border:2px solid #333;padding:16px;z-index:50';
  m.innerHTML = html + '<div>' + buttons.map((b) => '<button type="button" data-m="' + H(b) + '">' + H(b) + '</button>').join(' ') + '</div>';
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) onClick(b.dataset.m, m); });
  document.body.appendChild(m);
}
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'resume' && t.files[0]) {
    ST.files = [t.files[0].name];
    fetch('/dayforce/api/upload', { method: 'POST', body: t.files[0] }).then(() => {
      rerender();
      modal('<h3>Resume uploaded</h3><p>Your resume has been uploaded. Please review the information below before continuing.</p>', ['Got it'], (b, m) => m.remove());
    });
  }
  if (t.type === 'checkbox' && /_isCurrent$|_notCompleted$/.test(t.id)) {
    const [kind, i] = t.id.includes('workHistory') ? ['work', +t.id.split('_')[2]] : ['edu', +t.id.split('_')[2]];
    Object.assign(ST[kind][i], rowFrom(kind, i)); rerender();
  }
  if (t.name === 'q_auth') ST.q.auth = t.value;
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'import') { document.getElementById('resume').click(); return; }
  if (b.id === 'saveInfo') {
    e.preventDefault(); rerender();
    errors = [];
    for (const [id, m] of [['pi_email', 'Email is required'], ['pi_first', 'First name is required'], ['pi_last', 'Last name is required'], ['pi_mobile', 'Mobile phone is required'], ['pi_contact', 'Preferred Contact Method is required'], ['pi_source', 'Please select how you heard about this job']]) if (!val(id)) errors.push({ id, msg: m });
    if (val('pi_email') !== val('pi_confirm')) errors.push({ id: 'pi_confirm', msg: 'Email addresses do not match' });
    if (!errors.length) { ST.info.saved = true; ST.info.editing = false; }
    draw(); return;
  }
  if (b.id === 'editInfo') { ST.info.editing = true; draw(); return; }
  if (b.dataset.save) {
    e.preventDefault();
    const [kind, i] = b.dataset.save.split('.');
    const row = rowFrom(kind, +i);
    errors = [];
    const need = kind === 'work' ? [['title', 'Position Title'], ['company', 'Employer Name'], ['start', 'Start Date']] : [['degree', 'Degree'], ['school', 'School']];
    for (const [k, l] of need) if (!row[k]) errors.push({ id: 'jobPostingApplication_' + (kind === 'work' ? 'workHistory_' : 'educationHistory_') + i + '_' + (kind === 'work' ? { title: 'title', company: 'companyName', start: 'effectiveStart' }[k] : { degree: 'degreeName', school: 'schoolName' }[k]), msg: l + ' is required' });
    if (!errors.length) ST[kind][+i] = { ...row, editing: false };
    else Object.assign(ST[kind][+i], row);
    draw(); return;
  }
  if (b.dataset.edit) { const [kind, i] = b.dataset.edit.split('.'); ST[kind][+i].editing = true; draw(); return; }
  if (b.id === 'addWork') { rerender(); ST.work.push({ editing: true }); draw(); return; }
  if (b.id === 'addEdu') { rerender(); ST.edu.push({ editing: true }); draw(); return; }
  if (b.id === 'next') {
    rerender();
    errors = [];
    if (ST.step === 'info') {
      if (!ST.info.saved || ST.info.editing) errors.push({ msg: 'Please save your personal information (Update) before continuing.' });
      if (ST.work.some((w) => w.editing && (w.title || w.company)) || ST.edu.some((x) => x.editing && (x.school || x.degree))) errors.push({ msg: 'Please save or cancel the open history entries.' });
      if (!ST.files.length) errors.push({ msg: 'Please attach your resume.' });
    }
    if (ST.step === 'questionnaire') {
      if (!ST.q.auth) errors.push({ id: 'q_auth', msg: 'This question is required' });
      ST.q.why = (document.getElementById('q_why') || {}).value || '';
      if (!errors.length && !ST.consent) {
        modal('<h3>Privacy Notice</h3><p>We collect and use your personal information to evaluate your application, as described in our privacy notice.</p><label><input type="checkbox" id="consentBox"> I acknowledge that I have read the privacy notice and consent to the processing of my personal information.</label>', ['I Agree', 'Cancel'], (bn, m) => {
          if (bn === 'I Agree' && document.getElementById('consentBox').checked) { ST.consent = true; m.remove(); document.getElementById('next').click(); }
          if (bn === 'Cancel') m.remove();
        });
        return;
      }
    }
    fetch('/dayforce/api/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: ST.step, ok: !errors.length, errors: errors.map((x) => x.msg) }) });
    if (!errors.length) ST.step = ST.step === 'info' ? 'questionnaire' : 'submit';
    draw(); return;
  }
  if (b.id === 'submitApp') {
    fetch('/dayforce/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ V, work: ST.work, edu: ST.edu, q: ST.q, files: ST.files }) }).then(() => { app.innerHTML = '<h2>Application Submitted</h2><p>Thank you for applying.</p>'; });
  }
});
// Like the live site: background requests (analytics / autosave) keep going — they are not a submission.
setInterval(() => { if (ST.step === 'submit') fetch('/dayforce/api/ping', { method: 'POST', body: '{}' }); }, 700);
window.__DF__ = { ST, V };
draw();
`;

const page = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:760px;margin:16px auto}.field{margin:8px 0}label{display:block}.ant-select{border:1px solid #aaa;min-height:28px;position:relative;cursor:pointer}
.ant-select-selection-search-input{border:0;width:100%;height:26px;background:transparent}.ant-select-selection-item{position:absolute;left:6px;top:4px;pointer-events:none}
.a11y div{height:32px;font-size:1px;color:transparent}.rc-virtual-list-holder{max-height:256px;overflow:auto}.ant-select-item-option{padding:6px;cursor:pointer}
.ant-select-disabled{background:#eee}.summary{padding:8px;border:1px dashed #999;margin:6px 0}.row{border:1px solid #ccc;padding:8px;margin:6px 0}.sr{position:absolute;left:-9999px}</style>
</head><body>${body}<script>${script}</script></body></html>`;

/** Handles /dayforce/... requests; false when not a Dayforce fixture path. */
export async function dayforceRoute(req: IncomingMessage, res: ServerResponse, u: URL, st: DayforceFixtureState): Promise<boolean> {
  if (!u.pathname.startsWith("/dayforce/")) return false;
  const send = (code: number, s: string, type = "text/html; charset=utf-8") => {
    res.writeHead(code, { "content-type": type });
    res.end(s);
  };
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (u.pathname === "/dayforce/api/next") st.nexts.push(JSON.parse(raw));
    if (u.pathname === "/dayforce/api/submit") st.submissions.push(JSON.parse(raw));
    return send(200, "{}", "application/json"), true;
  }
  const m = u.pathname.match(/^\/dayforce\/en-US\/([^/]+)\/CANDIDATEPORTAL\/jobs\/(\d+)(\/apply(\/manualApplication)?)?$/);
  if (!m) return send(404, "not found"), true;
  const [, , job, apply, manual] = m;
  if (manual) return send(200, page("Manual Application", `<div id="app"></div>`, APP)), true;
  if (apply)
    return (
      send(
        200,
        page(
          "Apply",
          `<button type="button" id="guest">Apply without an Account</button><p>or</p><h3>Already Have an Account?</h3><button type="button" id="signin">Sign In</button><p>Don't have an account? <a href="#create">Create one now.</a></p>`,
          `document.getElementById('guest').onclick = () => { location.href = location.pathname + '/manualApplication?applicationSource=Manual'; };`,
        ),
      ),
      true
    );
  return (
    send(
      200,
      page(
        "Job Details",
        `<div role="dialog" aria-label="Cookie Preferences" id="cookies"><h3>Cookie Preferences</h3><p>We use cookies to improve site functionality.</p><button type="button" id="accept">Accept</button><button type="button" id="reject">Reject</button></div>
         <h1>Product Analyst (synthetic) · Req #${job}</h1><p>Markham, ON, Canada</p><button type="button" id="apply">Apply</button><h2>Job Description</h2><p>Fictional posting for tests.</p>`,
        `document.getElementById('reject').onclick = document.getElementById('accept').onclick = () => document.getElementById('cookies').remove();
         document.getElementById('apply').onclick = () => { location.href = location.pathname + '/apply?flowSelection=true'; };`,
      ),
    ),
    true
  );
}
