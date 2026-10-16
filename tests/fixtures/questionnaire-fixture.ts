// A SYNTHETIC application questionnaire with the question types of a real paused application
// (2026-10-15), rebuilt with fictional wording where possible: education rows whose school list does not
// contain the applicant's school (but offers "Other") and whose discipline list lacks the exact major; a
// degree-completion question; a 1–2 paragraph / 500-word project question; an offer-deadline question; a
// future-sponsorship question; an interview recording + training consent; current-or-previous employer /
// title; country of residence. Posts to /qa/1/submit.
import type { IncomingMessage, ServerResponse } from "node:http";

const SCHOOLS = ["University of Northfield", "Northfield College", "Example Institute", "Example State University", "Other"];
const DISCIPLINES = ["Computer Science", "Data Science", "Economics", "Mathematics", "Statistics", "Other"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const COUNTRIES = ["Australia", "Brazil", "Canada", "France", "Germany", "India", "United Kingdom", "United States"];

const edu = (i: number) => `<div class="education--form" data-i="${i}">
  <div class="field"><label for="school--${i}">School *</label><div class="cs"><input id="school--${i}" class="cs-in" role="combobox" aria-expanded="false" autocomplete="off" required><ul role="listbox" class="cs-list" hidden></ul><input type="hidden" name="school_${i}"></div></div>
  <div class="field"><label for="degree--${i}">Degree *</label><select id="degree--${i}" name="degree_${i}" required><option value="">Select</option><option>Bachelor's Degree</option><option>Master's Degree</option><option>Doctorate</option></select></div>
  <div class="field"><label for="discipline--${i}">Discipline *</label><select id="discipline--${i}" name="discipline_${i}" required><option value="">Select</option>${DISCIPLINES.map((d) => `<option>${d}</option>`).join("")}</select></div>
  <div class="field"><label for="start-date-month--${i}">Start date month *</label><select id="start-date-month--${i}" name="start_month_${i}" required><option value="">Select</option>${MONTHS.map((m) => `<option>${m}</option>`).join("")}</select></div>
  <div class="field"><label for="start-date-year--${i}">Start date year *</label><input id="start-date-year--${i}" name="start_year_${i}" required></div>
  <div class="field"><label for="end-date-month--${i}">End date month</label><select id="end-date-month--${i}" name="end_month_${i}"><option value="">Select</option>${MONTHS.map((m) => `<option>${m}</option>`).join("")}</select></div>
  <div class="field"><label for="end-date-year--${i}">End date year</label><input id="end-date-year--${i}" name="end_year_${i}"></div>
</div>`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Apply — Data Analyst (synthetic)</title>
<style>body{font-family:sans-serif;max-width:820px;margin:16px auto}.field{margin:8px 0}label{display:block}[hidden]{display:none!important}textarea{width:100%;height:160px}</style></head><body>
<h1>Data Analyst, Intern (synthetic)</h1>
<form id="application-form" method="post" action="/qa/1/submit" enctype="multipart/form-data">
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
  <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div class="field"><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required></div>
  <h2>Education</h2><div id="edu">${edu(0)}${edu(1)}</div>
  <h2>Questions</h2>
  <div class="field"><label for="q_complete">When do you expect to complete your degree? *</label><input id="q_complete" name="q_complete" required></div>
  <div class="field"><label for="q_project">Please tell us in 1-2 paragraphs (500 words or less) about a past data-related project you’ve worked on. Please describe the problem you were trying to solve, the data you used and what you found. *</label><textarea id="q_project" name="q_project" required></textarea></div>
  <div class="field"><label for="q_deadline">Do you have an active offer deadline or another recruiting-process deadline we should be aware of? If yes, please share the deadline date. *</label><textarea id="q_deadline" name="q_deadline" required></textarea></div>
  <div class="field"><label for="q_sponsor">Do you require visa sponsorship, now or in the future, to continue working in Canada? *</label><select id="q_sponsor" name="q_sponsor" required><option value="">Select</option><option>Yes, I will require visa sponsorship now or in the future to continue working in the country where this role is based.</option><option>No, I do not require visa sponsorship now or in the future to continue working in the country where this role is based.</option></select></div>
  <div class="field"><label for="q_record">To ensure we can focus fully on our conversation, we use an interview tool to record and transcribe interviews. Recordings may also be used internally to train our interviewers. Do you consent to having your interviews recorded? *</label><select id="q_record" name="q_record" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
  <div class="field"><label for="q_employer">Who is your current or previous employer? *</label><input id="q_employer" name="q_employer" required></div>
  <div class="field"><label for="q_title">What is your current or previous job title? *</label><input id="q_title" name="q_title" required></div>
  <div class="field"><label for="q_country">Please select the country where you currently reside. *</label><select id="q_country" name="q_country" required><option value="">Select</option>${COUNTRIES.map((c) => `<option>${c}</option>`).join("")}</select></div>
  <button type="submit">Submit application</button>
</form>
<script>
const SCHOOLS = ${JSON.stringify(SCHOOLS)};
document.querySelectorAll('.cs').forEach((w) => {
  const inp = w.querySelector('.cs-in'), list = w.querySelector('.cs-list'), hid = w.querySelector('input[type=hidden]');
  // A remote-style search: only schools whose name contains the typed text are offered; only a click commits.
  const show = () => { const q = inp.value.trim().toLowerCase(); const m = q ? SCHOOLS.filter((s) => s.toLowerCase().includes(q)) : []; list.innerHTML = m.map((s) => '<li role="option">' + s + '</li>').join(''); list.hidden = !m.length; inp.setAttribute('aria-expanded', String(!!m.length)); };
  inp.addEventListener('input', () => { hid.value = ''; show(); });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (!li) return; e.preventDefault(); inp.value = li.textContent; hid.value = li.textContent; list.hidden = true; inp.setAttribute('aria-expanded', 'false'); });
  inp.addEventListener('blur', () => setTimeout(() => { if (!hid.value) inp.value = ''; list.hidden = true; inp.setAttribute('aria-expanded', 'false'); }, 150));
});
</script></body></html>`;

export async function questionnaireRoute(_req: IncomingMessage, res: ServerResponse, u: URL): Promise<boolean> {
  if (!u.pathname.startsWith("/qa/")) return false;
  if (/^\/qa\/\d+$/.test(u.pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return true;
  }
  if (/\/confirmation$/.test(u.pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><h1>Thank you for applying.</h1><p>Your application has been received.</p>");
    return true;
  }
  res.writeHead(404);
  res.end("not found");
  return true;
}
