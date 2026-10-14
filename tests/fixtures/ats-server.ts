// Synthetic application forms for automated tests. They imitate the DOM of Greenhouse
// (job-boards.greenhouse.io: #application-form, #first_name, react-select comboboxes,
// #demographic-section, /confirmation) and Lever (jobs.lever.co …/apply: name/email/urls[…],
// cards[…] questions, eeo[…], #btn-submit, /thanks). No real employer is ever contacted.
// Every submission is recorded here so tests can check exactly what was sent.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Submission {
  path: string;
  fields: Record<string, string | string[]>;
  files: { field: string; filename: string; size: number; sha256: string; type: string }[];
}

export interface AtsFixture {
  url: string;
  submissions: Submission[];
  hits: string[];
  close(): Promise<void>;
}

const page = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:sans-serif;max-width:760px;margin:20px auto} .field{margin:10px 0} label{display:block}
  .visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .select__control{border:1px solid #888;padding:4px;position:relative;min-height:24px}
  .select__menu{border:1px solid #444;background:#fff} .select__option{padding:4px;cursor:pointer}
  .error{color:#b00} [hidden]{display:none!important}
  .g-recaptcha{width:304px;height:78px;background:#eee;border:1px solid #ccc}
</style></head><body>${body}<script>${script}</script></body></html>`;

// A small stand-in for react-select: <input role=combobox> + .select__single-value + hidden input.
const combobox = (id: string, label: string, options: string[], required: boolean, extraClass = "") => `
<div class="field ${extraClass}">
  <label id="${id}-label">${label}${required ? " *" : ""}</label>
  <div class="select__control" data-options='${JSON.stringify(options).replace(/'/g, "&#39;")}'>
    <div class="select__single-value"></div>
    <input class="select__input" role="combobox" id="${id}" aria-labelledby="${id}-label" aria-required="${required}" autocomplete="off">
    <input type="hidden" name="${id}">
    <div class="select__menu" hidden></div>
  </div>
</div>`;

const COMBO_JS = `
for (const ctl of document.querySelectorAll('.select__control')) {
  const input = ctl.querySelector('input[role=combobox]'), hidden = ctl.querySelector('input[type=hidden]'), menu = ctl.querySelector('.select__menu'), single = ctl.querySelector('.select__single-value');
  const all = JSON.parse(ctl.dataset.options || '[]');
  const asyncSearch = ctl.closest('.async');
  const render = () => {
    const q = input.value.toLowerCase();
    const list = asyncSearch ? (q.length >= 3 ? all.filter((o) => o.toLowerCase().startsWith(q)) : []) : all.filter((o) => o.toLowerCase().includes(q));
    menu.innerHTML = list.map((o, i) => '<div class="select__option" role="option" id="' + input.id + '-option-' + i + '">' + o + '</div>').join('');
    menu.hidden = !list.length;
  };
  input.addEventListener('focus', render); input.addEventListener('click', render); input.addEventListener('input', () => setTimeout(render, asyncSearch ? 300 : 0));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });
  menu.addEventListener('mousedown', (e) => { const o = e.target.closest('.select__option'); if (!o) return; e.preventDefault(); single.textContent = o.textContent; hidden.value = o.textContent; input.value = ''; menu.hidden = true; });
}`;

function greenhouse(path: string, variant: string) {
  const step2 = variant === "multistep";
  const body = `
<h1>Data Analyst (synthetic)</h1><p>Northwind Analytics — Toronto, Canada</p>
${variant === "captcha" ? '<div class="g-recaptcha" title="reCAPTCHA challenge"></div>' : ""}
<form id="application-form" class="application--form" method="post" action="${path}/submit${variant ? `?variant=${variant}` : ""}" enctype="multipart/form-data" novalidate>
 <section id="step-1">
  <h2>Apply for this job</h2>
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" name="first_name" autocomplete="given-name" aria-required="true"></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" autocomplete="family-name" aria-required="true"></div>
  <div class="field"><label for="preferred_name">Preferred First Name</label><input id="preferred_name" name="preferred_name"></div>
  <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" aria-required="true"></div>
  <div class="field phone"><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" aria-required="true"></div>
  ${combobox("candidate-location", "Location (City)", ["Toronto, Ontario, Canada", "Toronto, Ohio, United States", "Ottawa, Ontario, Canada"], true, "async")}
  <div class="field"><label for="resume">Resume/CV *</label><button type="button">Attach</button><input id="resume" name="resume" type="file" class="visually-hidden" accept=".pdf,.doc,.docx,.txt,.rtf" aria-required="true"></div>
  <div class="field"><label for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file" class="visually-hidden"></div>
  ${step2 ? '<button type="button" id="next">Next</button>' : ""}
 </section>
 <section id="step-2" ${step2 ? "hidden" : ""}>
  <h2>Additional questions</h2>
  <div class="field"><label for="question_101">LinkedIn Profile</label><input id="question_101" name="question_101"></div>
  <div class="field"><label for="question_102">Website</label><input id="question_102" name="question_102"></div>
  ${combobox("question_103", "Are you legally authorized to work in Canada?", ["Yes", "No"], true)}
  ${combobox("question_104", "Will you now or in the future require sponsorship for employment visa status?", ["Yes", "No"], true)}
  <div class="field"><label for="question_105">How did you hear about this job? *</label><input id="question_105" name="question_105" aria-required="true"></div>
  <fieldset class="field"><legend>Which of these tools have you used?</legend>
    <label><input type="checkbox" name="question_106[]" id="question_106[]_1" value="1"> SQL</label>
    <label><input type="checkbox" name="question_106[]" id="question_106[]_2" value="2"> Python</label>
    <label><input type="checkbox" name="question_106[]" id="question_106[]_3" value="3"> Tableau</label>
  </fieldset>
  <div class="field"><label for="question_107">Highest level of education</label><select id="question_107" name="question_107"><option value="">Select…</option><option>High School</option><option>Bachelor's Degree</option><option>Master's Degree</option><option>Doctorate</option></select></div>
  <div class="field"><label><input type="checkbox" id="question_108" name="question_108" value="1" aria-required="true"> I certify that the information provided is true and complete. *</label></div>
 </section>
 <section id="demographic-section">
  <h2>Voluntary Self-Identification</h2>
  <div class="field"><label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select…</option><option>Female</option><option>Male</option><option>Decline to self-identify</option></select></div>
  <div class="field"><label for="veteran_status">Veteran Status</label><select id="veteran_status" name="veteran_status"><option value="">Select…</option><option>I am not a protected veteran</option><option>I don't wish to answer</option></select></div>
 </section>
 <div class="errors" role="alert" hidden></div>
 <button type="submit" class="btn btn--pill" ${step2 ? "hidden" : ""}>Submit application</button>
</form>`;
  const script = `${COMBO_JS}
const form = document.getElementById('application-form');
const next = document.getElementById('next');
if (next) next.addEventListener('click', () => { document.getElementById('step-1').hidden = true; document.getElementById('step-2').hidden = false; next.remove(); form.querySelector('button[type=submit]').hidden = false; });
form.addEventListener('submit', (e) => {
  const errs = [];
  for (const el of form.querySelectorAll('[aria-required=true]')) {
    const ok = el.type === 'file' ? el.files.length > 0 : el.type === 'checkbox' ? el.checked : el.getAttribute('role') === 'combobox' ? !!el.closest('.select__control').querySelector('input[type=hidden]').value : !!el.value.trim();
    el.setAttribute('aria-invalid', ok ? 'false' : 'true');
    if (!ok) errs.push((document.querySelector('label[for="' + el.id + '"]') || document.getElementById(el.id + '-label') || el.closest('label') || {}).textContent + ' is required');
  }
  if (${variant === "validate" ? "true" : "false"}) errs.push('Phone number is not valid for the selected country');
  const box = form.querySelector('.errors');
  if (errs.length) { e.preventDefault(); box.hidden = false; box.textContent = errs.join(' '); }
});`;
  return page("Job Application for Data Analyst at Northwind Analytics", body, script);
}

function lever(path: string, variant: string) {
  const card = "0f5c1a2e-0000-4000-8000-000000000001";
  const body = `
<div class="application-page">
<h2>Business Analyst (synthetic)</h2>
<form id="application-form" method="POST" action="${path}${variant ? `?variant=${variant}` : ""}" enctype="multipart/form-data">
 <h4>Submit your application</h4>
 <ul>
  <li class="application-question resume"><div class="application-label">Resume/CV <span class="required">✱</span></div>
    <input type="file" name="resume" id="resume-upload-input" class="invisible-resume-upload" data-qa="input-resume" aria-required="true"></li>
  <li class="application-question"><label><div class="application-label">Full name <span class="required">✱</span></div><input type="text" name="name" data-qa="name-input" required></label></li>
  <li class="application-question"><label><div class="application-label">Email <span class="required">✱</span></div><input type="email" name="email" required></label></li>
  <li class="application-question"><label><div class="application-label">Phone</div><input type="text" name="phone"></label></li>
  <li class="application-question"><label><div class="application-label">Current location</div><input type="text" name="location"></label></li>
  <li class="application-question"><label><div class="application-label">Current company</div><input type="text" name="org"></label></li>
 </ul>
 <h4>Links</h4>
 <ul>
  <li class="application-question"><label><div class="application-label">LinkedIn URL</div><input type="text" name="urls[LinkedIn]"></label></li>
  <li class="application-question"><label><div class="application-label">GitHub URL</div><input type="text" name="urls[GitHub]"></label></li>
  <li class="application-question"><label><div class="application-label">Portfolio URL</div><input type="text" name="urls[Portfolio]"></label></li>
 </ul>
 <ul>
  <li class="application-question custom-question"><div class="application-label">Are you legally authorized to work in Canada? <span class="required">✱</span></div>
   <div data-qa="multiple-choice"><label><input type="radio" name="cards[${card}][field0]" value="Yes" required> Yes</label><label><input type="radio" name="cards[${card}][field0]" value="No"> No</label></div></li>
  <li class="application-question custom-question"><div class="application-label">Do you have a valid driver's license? <span class="required">✱</span></div>
   <div data-qa="multiple-choice"><label><input type="radio" name="cards[${card}][field1]" value="Yes" required> Yes</label><label><input type="radio" name="cards[${card}][field1]" value="No"> No</label></div></li>
  <li class="application-question custom-question"><label><div class="application-label">Anything else you'd like us to know?</div><textarea name="cards[${card}][field2]"></textarea></label></li>
 </ul>
 <div class="eeo-section"><h4>U.S. Equal Employment Opportunity information</h4>
  <label>Gender<select name="eeo[gender]"><option value="">Select ...</option><option>Female</option><option>Male</option><option>Decline to self-identify</option></select></label>
  <label>Race<select name="eeo[race]"><option value="">Select ...</option><option>White</option><option>Asian</option><option>Decline to self-identify</option></select></label>
 </div>
 <div id="h-captcha" class="h-captcha"></div>
 <button id="btn-submit" type="button" data-qa="btn-submit" class="postings-btn template-btn-submit">Submit application</button>
</form></div>`;
  const script = `document.getElementById('btn-submit').addEventListener('click', () => { const f = document.getElementById('application-form'); if (f.reportValidity()) f.submit(); });`;
  return page("Northwind Analytics - Business Analyst", body, script);
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startAtsFixture(): Promise<AtsFixture> {
  const submissions: Submission[] = [];
  const hits: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const variant = u.searchParams.get("variant") ?? "";
    hits.push(`${req.method} ${u.pathname}`);
    const html = (s: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(s);
    };
    const delay = Number(u.searchParams.get("delay") ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));

    if (req.method === "POST") {
      const raw = await readBody(req);
      const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const sub: Submission = { path: u.pathname, fields: {}, files: [] };
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") {
          const prev = sub.fields[k];
          sub.fields[k] = prev === undefined ? v : ([] as string[]).concat(prev, v);
        } else if (v.size) {
          const buf = Buffer.from(await v.arrayBuffer());
          sub.files.push({ field: k, filename: v.name, size: v.size, sha256: createHash("sha256").update(buf).digest("hex"), type: v.type });
        }
      }
      submissions.push(sub);
      const base = u.pathname.replace(/\/submit$/, "");
      if (variant === "ambiguous") return html(page("Processing", "<p>Please wait while we process your request.</p>"));
      const thanks = u.pathname.startsWith("/lever") ? `${base.replace(/\/apply$/, "")}/thanks` : `${base}/confirmation`;
      res.writeHead(303, { location: thanks });
      return res.end();
    }
    if (/^\/greenhouse\/[^/]+\/jobs\/\d+\/confirmation$/.test(u.pathname)) return html(page("Thank you", "<h1>Thank you for applying.</h1><p>Your application has been received.</p>"));
    if (/^\/greenhouse\/[^/]+\/jobs\/\d+$/.test(u.pathname)) return html(greenhouse(u.pathname, variant));
    if (/^\/lever\/[^/]+\/[0-9a-f-]{36}\/thanks$/.test(u.pathname)) return html(page("Thanks", "<h3>Application submitted!</h3><p>Thanks for applying to Northwind Analytics.</p>"));
    if (/^\/lever\/[^/]+\/[0-9a-f-]{36}\/apply$/.test(u.pathname)) return html(lever(u.pathname, variant));
    if (u.pathname === "/other/careers") return html(page("Careers", "<h1>Careers</h1><form><input name=q></form>"));
    html("Not found", 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    submissions,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
