// Synthetic career-site PATTERNS met on live postings (2026-10-15), one page each, fictional:
//   /pat/embed  — the posting and its "Apply online" inside a same-origin iframe; a site search box and a
//                 cookie banner offering "Agree to necessary"; Apply leads to an e-mail login step (…/login)
//   /pat/tab    — "Apply Now" opens the application in a NEW TAB
//   /pat/inline — "Job details" / "Apply" tabs on the posting; the form appears only after "Apply"
//   /pat/emp    — repeated employment / education blocks marked by their container ("employment-form"),
//                 ids "company-name-0", split month / year dates, "Current role", a bare "Add another"
//   /pat/agent  — an UNFAMILIAR site for the runtime browser agent: "I'm interested" instead of Apply, a tip
//                 pop-up, an "Onward" step button, a self-identification question, then Submit
import type { IncomingMessage, ServerResponse } from "node:http";

const page = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:760px;margin:16px auto}.field{margin:8px 0}label{display:block}iframe{width:100%;height:900px;border:0}[hidden]{display:none!important}</style>
</head><body>${body}<script>${script}</script></body></html>`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const block = (i: number) => `<div class="employment-form" data-i="${i}">
  <div class="field"><label for="company-name-${i}">Company name*</label><input id="company-name-${i}" name="company_name_${i}" required></div>
  <div class="field"><label for="title-${i}">Title*</label><input id="title-${i}" name="title_${i}" required></div>
  <div class="field"><label for="start-date-month-${i}">Start date month*</label><select id="start-date-month-${i}" name="start_month_${i}" required><option value="">Select</option>${MONTHS.map((m) => `<option>${m}</option>`).join("")}</select></div>
  <div class="field"><label for="start-date-year-${i}">Start date year*</label><input id="start-date-year-${i}" name="start_year_${i}" required></div>
  <div class="field"><label for="end-date-month-${i}">End date month</label><select id="end-date-month-${i}" name="end_month_${i}"><option value="">Select</option>${MONTHS.map((m) => `<option>${m}</option>`).join("")}</select></div>
  <div class="field"><label for="end-date-year-${i}">End date year</label><input id="end-date-year-${i}" name="end_year_${i}"></div>
  <div class="field"><input type="checkbox" id="current-role-${i}_1" name="current_${i}" value="1"><label for="current-role-${i}_1">Current role</label></div>
</div>`;

export async function patternsRoute(_req: IncomingMessage, res: ServerResponse, u: URL): Promise<boolean> {
  if (!u.pathname.startsWith("/pat/")) return false;
  const html = (s: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(s);
    return true;
  };
  const p = u.pathname;
  if (/\/confirmation$/.test(p)) return html(page("Thank you", "<h1>Thank you for applying.</h1>"));
  // ---- embedded posting + login step
  if (p === "/pat/embed/1")
    return html(
      page(
        "Careers",
        `<header><input type="search" aria-label="Search jobs"></header><div id="cc" role="dialog" aria-label="Cookies"><p>We use cookies.</p><button id="nec">Agree to necessary</button><button id="all">Agree to all</button></div><iframe id="content_iframe" src="/pat/embed/1/inner?in_iframe=1" title="content"></iframe>`,
        `document.getElementById('nec').onclick = document.getElementById('all').onclick = () => document.getElementById('cc').remove();`,
      ),
    );
  if (p === "/pat/embed/1/inner") return html(page("Posting", `<h1>Analyst (synthetic)</h1><p>Returning candidate? <a href="/pat/embed/1/login">Log back in!</a></p><a href="/pat/embed/1/login" role="button">Apply online</a>`));
  if (p === "/pat/embed/1/login") return html(page("Login", `<h2>Please enter your e-mail to continue</h2><form><label for="em">Email</label><input id="em" type="email" name="email"><button type="button">Next</button></form>`));
  // ---- new tab
  if (p === "/pat/tab/1") return html(page("Posting", `<h1>Analyst (synthetic)</h1><a href="/pat/tab/1/form" target="_blank" rel="noopener">Apply Now</a>`));
  if (p === "/pat/tab/1/form" || p === "/pat/inline/1/form")
    return html(
      page(
        "Apply",
        `<form id="application-form" method="post" action="${p.replace(/\/form$/, "/submit")}" enctype="multipart/form-data"><h1>Apply</h1>
        <div class="field"><label for="fn">First name *</label><input id="fn" name="first_name" autocomplete="given-name" required></div>
        <div class="field"><label for="ln">Last name *</label><input id="ln" name="last_name" autocomplete="family-name" required></div>
        <div class="field"><label for="em">Email *</label><input id="em" name="email" type="email" required></div>
        <div class="field"><label for="cv">Resume *</label><input id="cv" name="resume" type="file" required></div>
        <button type="submit">Submit application</button></form>`,
      ),
    );
  // ---- Apply tab on the posting
  if (p === "/pat/inline/1")
    return html(
      page(
        "Posting",
        `<nav><a href="#d">Job details</a> <button id="applyTab">Apply</button></nav><div id="details"><h1>Analyst (synthetic)</h1><p>Description.</p><form><label for="nl">Newsletter</label><input id="nl" type="email" name="newsletter"></form></div><div id="apply" hidden></div>`,
        `document.getElementById('applyTab').onclick = () => { location.href = '/pat/inline/1/form'; };`,
      ),
    );
  // ---- repeated blocks with split dates
  if (p === "/pat/emp/1")
    return html(
      page(
        "Apply",
        `<form id="application-form" method="post" action="/pat/emp/1/submit" enctype="multipart/form-data"><h1>Apply for this job</h1>
        <div class="field"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
        <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
        <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
        <div class="field"><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required></div>
        <div id="emp">${block(0)}</div><button type="button" id="addEmp">Add another</button>
        <div class="education--form"><div class="field"><label for="school--0">School</label><input id="school--0" name="school_0"></div>
        <div class="field"><label for="degree--0">Degree</label><select id="degree--0" name="degree_0"><option value="">Select</option><option>Bachelor's Degree</option><option>Master's Degree</option><option>Doctorate</option></select></div>
        <div class="field"><label for="discipline--0">Discipline</label><input id="discipline--0" name="discipline_0"></div></div>
        <button type="submit">Submit application</button></form>`,
        `const tpl = ${JSON.stringify(block(0))};
         document.getElementById('addEmp').onclick = () => { const i = document.querySelectorAll('.employment-form').length; const d = document.createElement('div'); d.innerHTML = tpl.replace(/-0\\b/g, '-' + i).replace(/_0\\b/g, '_' + i).replace(/data-i="0"/, 'data-i="' + i + '"').replace(/-0_1/g, '-' + i + '_1'); document.getElementById('emp').appendChild(d.firstElementChild); };`,
      ),
    );
  // ---- unfamiliar vocabulary: only the runtime browser agent gets through it
  if (p === "/pat/agent/1") return html(page("Opening", `<h1>Analyst (synthetic)</h1><p>Description.</p><button id="go">I'm interested</button>`, `document.getElementById('go').onclick = () => { location.href = '/pat/agent/1/form'; };`));
  if (p === "/pat/agent/1/form")
    return html(
      page(
        "Your details",
        `<div role="dialog" aria-modal="true" id="tip"><p>Tip: this takes about three minutes.</p><button type="button" id="ok">Got it</button></div>
        <form id="f" method="post" action="/pat/agent/1/submit" enctype="multipart/form-data">
        <section id="a"><h2>About you</h2>
        <div class="field"><label for="gn">Given name *</label><input id="gn" name="given" required></div>
        <div class="field"><label for="fam">Family name *</label><input id="fam" name="family" required></div>
        <div class="field"><label for="mail">E-mail address *</label><input id="mail" name="mail" type="email" required></div>
        <div class="field"><label for="office">Which office are you applying to? *</label><select id="office" name="office" required><option value="">Choose</option><option>Toronto</option><option>Montreal</option></select></div>
        <div class="field"><label for="g">Gender (optional)</label><select id="g" name="gender"><option value="">Choose</option><option>Woman</option><option>Man</option><option>Prefer not to say</option></select></div>
        <div id="err" role="alert" hidden>Please complete the required fields.</div>
        <button type="button" id="on">Onward</button></section>
        <section id="b" hidden><h2>Check and send</h2><div class="field"><label for="cv">CV</label><input id="cv" name="resume" type="file"></div><button type="submit">Submit application</button></section></form>`,
        `document.getElementById('ok').onclick = () => document.getElementById('tip').remove();
         document.getElementById('on').onclick = () => {
           const ok = ['gn', 'fam', 'mail', 'office'].every((id) => document.getElementById(id).value);
           document.getElementById('err').hidden = ok;
           if (ok) { document.getElementById('a').hidden = true; document.getElementById('b').hidden = false; }
         };`,
      ),
    );
  res.writeHead(404);
  res.end("not found");
  return true;
}
