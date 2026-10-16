// A SYNTHETIC career site whose job posting carries the structure that once misled the generic flow
// (2026-10-15, a real employer's posting): a prominent "Apply now", "Save job", a "Get notified for similar
// jobs" sign-up (e-mail + Submit), similar-jobs links and a "Find your next job" search with a typeahead.
// None of those widgets belong to the application, which is reached only through Apply.
//
//   /cw/job/1?v=<variant>    the posting
//   /cw/apply/1?v=<variant>  the application: Personal information → Experience → Review (Next buttons are
//                            submit-typed; only "Submit application" posts to /cw/apply/1/submit)
//
// Variants (adversarial): sidebar-first (sidebar before the description in DOM order), search-first (the
// search box is the first input), late-apply (Apply after unrelated buttons), newtab (Apply opens a tab),
// redirect (Apply goes through a redirect to a different application system path), iframe (the
// application is embedded in a frame), multi-submit (the application page also has a newsletter Submit
// and a feedback Submit), unfamiliar ("I'm interested" instead of Apply), dead (Apply does nothing).
// Fictional employer and data. Every widget interaction is recorded in `postingEvents`.
import type { IncomingMessage, ServerResponse } from "node:http";

export const postingEvents: string[] = [];

const page = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:900px;margin:16px auto}.field{margin:8px 0}label{display:block}[hidden]{display:none!important}.cta{background:#fd0;padding:10px 18px;font-weight:bold}.cols{display:flex;gap:24px}.main{flex:3}.side{flex:1}iframe{width:100%;height:1200px;border:0}</style>
</head><body>${body}<script>const log = (ev) => fetch('/cw/log?ev=' + ev);${script}</script></body></html>`;

const header = `<header><a href="/cw">Northwind Careers</a> <nav><a href="/cw/jobs">Jobs</a> <a href="/cw/saved">Saved jobs (0)</a></nav></header>`;
const search = `<section class="find"><h2>Find your next job.</h2><div class="srch"><input id="typehead" role="combobox" aria-expanded="false" aria-controls="sugg" placeholder="Search job title or location" autocomplete="off"><ul id="sugg" role="listbox" hidden><li role="option">Analyst</li><li role="option">Developer</li></ul><button type="button" id="go">Search</button></div></section>`;
const sidebar = `<div class="side"><div class="notify"><h3>Get notified for similar jobs</h3><form id="alerts" class="alert-form"><input id="notifiedEmail" type="email" placeholder="name@example.com"><button type="submit">Submit</button></form><button type="button" id="manage">Manage Alerts</button></div>
  <div class="similar"><h3>Similar jobs</h3><a href="/cw/job/2">Senior Analyst, Data Risk</a><br><a href="/cw/job/3">Director, Platform Lead</a></div></div>`;
const description = `<h1>Product Analyst (synthetic)</h1><p>Toronto, Ontario · Full time</p><h2>Description</h2><p>Work with product teams on analytics. ${"Lorem ipsum dolor sit amet. ".repeat(12)}</p>`;

function postingHtml(v: string): string {
  const applyHref = v === "redirect" ? "/cw/go/1" : `/cw/apply/1?v=${v}`;
  const label = v === "unfamiliar" ? "I'm interested" : "Apply now";
  const apply =
    v === "dead"
      ? `<button type="button" class="cta" id="apply">Apply now</button>`
      : v === "unfamiliar"
        ? `<button type="button" class="cta" id="apply">${label}</button>`
        : `<a class="cta" id="apply" href="${applyHref}"${v === "newtab" ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
  const extra = v === "late-apply" ? `<button type="button">Share via email</button> <button type="button">Print</button> <button type="button">Back to results</button> <a href="/cw/jobs">More jobs</a> ` : "";
  const save = `<form class="save" onsubmit="event.preventDefault(); log('save_job')"><button type="submit">Save job</button></form>`;
  const ctas = `<div class="ctas">${extra}${save} ${apply}</div>`;
  const main = `<div class="main">${description}${ctas}</div>`;
  const cols = v === "sidebar-first" ? `<div class="cols">${sidebar}${main}</div>` : `<div class="cols">${main}${sidebar}</div>`;
  const body = v === "search-first" ? `${header}${search}${cols}` : `${header}${cols}${search}<footer><a href="/cw/legal">Legal</a> <a href="/cw/privacy">Privacy</a></footer>`;
  return page(
    "Product Analyst | Northwind Careers",
    body,
    `document.getElementById('alerts').onsubmit = (e) => { e.preventDefault(); log('subscribed'); };
     document.getElementById('manage').onclick = () => log('manage_alerts');
     const th = document.getElementById('typehead');
     th.addEventListener('input', () => { log('search_typed'); document.getElementById('sugg').hidden = false; });
     th.addEventListener('focus', () => log('search_focused'));
     document.getElementById('go').onclick = () => log('search_clicked');
     ${v === "unfamiliar" ? `document.getElementById('apply').onclick = () => { location.href = '/cw/apply/1?v=${v}'; };` : ""}`,
  );
}

const STEP_JS = `const steps = [...document.querySelectorAll('section.step')];
  const show = (i) => { steps.forEach((s, k) => (s.hidden = k !== i)); history.replaceState(null, '', location.pathname + location.search.replace(/&?step=\\d+/, '') + (location.search ? '&' : '?') + 'step=' + (i + 1)); };
  document.querySelectorAll('button.next').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const sec = b.closest('section.step');
    const missing = [...sec.querySelectorAll('[required]')].filter((x) => !(x.type === 'file' ? x.files.length : x.value));
    sec.querySelector('.err').hidden = !missing.length;
    if (!missing.length) show(steps.indexOf(sec) + 1);
  }));
  show(0);`;

function applicationHtml(v: string, inner = false): string {
  const multi = v === "multi-submit";
  const form = `<form id="application" method="post" action="/cw/apply/1/submit" enctype="multipart/form-data">
  <ol class="stepper"><li aria-current="step">Personal information</li><li>Experience</li><li>Review</li></ol>
  <section class="step"><h2>Personal information</h2>
    <div class="field"><label for="fn">First Name *</label><input id="fn" name="first_name" required></div>
    <div class="field"><label for="ln">Last Name *</label><input id="ln" name="last_name" required></div>
    <div class="field"><label for="em">Email address *</label><input id="em" name="email" type="text" required></div>
    <div class="field"><label for="ph">Phone Number *</label><input id="ph" name="phone" type="tel" required></div>
    <div class="err" role="alert" hidden>Please complete the required fields.</div>
    <button type="submit" class="next">Next</button></section>
  <section class="step"><h2>Experience</h2>
    <div class="field"><label for="cv">Upload resume *</label><input id="cv" name="resume" type="file" required></div>
    <div class="err" role="alert" hidden>Please attach your resume.</div>
    <button type="submit" class="next">Next</button></section>
  <section class="step"><h2>Review your application</h2><p>Check your details before submitting.</p>
    <button type="submit" id="final">Submit application</button></section>
</form>`;
  const extras = multi
    ? `<aside><h3>Give us feedback on this site</h3><form id="fb" onsubmit="event.preventDefault(); log('feedback')"><textarea id="fbt" aria-label="Feedback"></textarea><button type="submit">Submit</button></form></aside>
       <section><h3>Join our talent newsletter</h3><form id="nl" onsubmit="event.preventDefault(); log('subscribed')"><input id="nle" type="email" placeholder="Your email"><button type="submit">Submit</button></form></section>`
    : "";
  return page("Apply | Northwind Careers", `${inner ? "" : header}<h1>Product Analyst (synthetic) — Application</h1>${form}${extras}`, STEP_JS);
}

export async function postingRoute(_req: IncomingMessage, res: ServerResponse, u: URL): Promise<boolean> {
  if (!u.pathname.startsWith("/cw/")) return false;
  const html = (s: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(s);
    return true;
  };
  const v = u.searchParams.get("v") ?? "base";
  const p = u.pathname;
  if (p === "/cw/log") {
    postingEvents.push(String(u.searchParams.get("ev")));
    res.writeHead(204);
    res.end();
    return true;
  }
  if (/^\/cw\/job\/\d+$/.test(p)) return html(postingHtml(v));
  if (p === "/cw/go/1") {
    res.writeHead(302, { location: `/cw/ats/apply/1?v=${v}` });
    res.end();
    return true;
  }
  if (p === "/cw/apply/1" || p === "/cw/ats/apply/1") {
    postingEvents.push(`apply_page:${v}`);
    if (v === "iframe" && !u.searchParams.has("inner")) return html(page("Apply | Northwind Careers", `${header}<h1>Apply</h1><iframe src="/cw/apply/1?v=iframe&inner=1" title="Application"></iframe>`));
    return html(applicationHtml(v, u.searchParams.has("inner")));
  }
  if (/\/confirmation$/.test(p)) return html(page("Thank you", "<h1>Thank you for applying.</h1><p>Your application has been received.</p>"));
  res.writeHead(404);
  res.end("not found");
  return true;
}
