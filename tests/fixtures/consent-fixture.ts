// SYNTHETIC application forms whose only hard part is a CONSENT control (fictional employer "Example Co").
// Each variant is a way real sites draw or behave around "I agree to … Privacy Policy" (2026-10-16):
//   hidden    — the real checkbox is a 1×1 clipped input under the error line; the site draws its own box
//               in the element the input is labelled by (a Recruitee-style form). A click on the input
//               lands on the error line and changes nothing. Its final button is a bare "Send".
//   custom    — a div role="checkbox" that only reacts to real (trusted) clicks or the keyboard.
//   select    — "Do you agree to … Privacy Policy?" as a Yes / No dropdown.
//   rerender  — the site re-renders the consent once after it is ticked, clearing it.
//   iframe    — the whole application (with the hidden-style consent) lives in an embedded frame.
//   twostep   — the same consent asked on step 1 and again on step 2.
//   mixed     — a privacy-policy consent and a separate accuracy certification.
//   arbitration — privacy policy AND binding arbitration in one box.
//   reject    — a box the site never keeps ticked.
//   screening — employer-history / relocation / work-authorization questions with statement options, a
//               privacy acknowledgment as a one-option dropdown, a typed certification.
//   toggle    — no checkbox at all: an "Agree" toggle button beside the statement (rules cannot see it);
//               Next only advances once it is on.
// Every form posts to /consent/<variant>/submit (or /frame/submit); the consent value is in the post.
import type { IncomingMessage, ServerResponse } from "node:http";

const head = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:760px;margin:16px auto}.field{margin:10px 0}label{display:block}[hidden]{display:none!important}
.consent{position:relative;padding-bottom:4px}.sr{position:absolute;left:9px;top:30px;width:1px;height:1px;margin:0;clip:rect(0,0,0,0);overflow:hidden}
.row{display:flex;gap:8px;align-items:flex-start;cursor:pointer}.box{display:inline-block;width:18px;height:18px;border:2px solid #555;border-radius:3px;flex:none}.box.on{background:#2a6}
.err{min-height:24px;color:#b00;position:relative;background:#fff}.policy{margin-left:4px}</style></head><body>`;

const contact = `<div class="field"><label for="fn">First name *</label><input id="fn" name="first_name" required></div>
<div class="field"><label for="ln">Last name *</label><input id="ln" name="last_name" required></div>
<div class="field"><label for="em">Email *</label><input id="em" name="email" type="email" required></div>`;

const STATEMENT = `I agree to Example Co's <a class="policy" href="#policy">Privacy Policy</a>`;

/** The Recruitee-style control: input clipped to 1×1 under the error line; the drawn box toggles it. */
const hiddenConsent = (name: string, statement = STATEMENT) => `<div class="consent" data-consent="${name}">
  <input type="hidden" name="${name}_id" value="11">
  <input type="checkbox" required class="sr" name="${name}" value="yes" aria-invalid="false" aria-labelledby="${name}-lbl">
  <div id="${name}-lbl" class="row"><span class="box" aria-hidden="true"></span><span>${statement}</span></div>
  <div role="alert" class="err" id="${name}-err"></div>
</div>`;
const hiddenScript = `
document.querySelectorAll('[data-consent]').forEach((w) => {
  const cb = w.querySelector('input[type=checkbox]'), row = w.querySelector('.row'), box = w.querySelector('.box');
  const draw = () => { box.classList.toggle('on', cb.checked); cb.setAttribute('aria-invalid', 'false'); };
  cb.addEventListener('change', draw);
  row.addEventListener('click', (e) => { if (e.target.closest('a')) return; cb.click(); });
});`;

const nextScript = (check: string) => `
document.querySelector('.next').onclick = () => {
  const ok = ['fn', 'ln', 'em'].every((id) => document.getElementById(id).value) && (${check});
  document.querySelector('.step-err').hidden = !!ok;
  if (ok) { document.querySelector('.s1').hidden = true; document.querySelector('.s2').hidden = false; }
};`;

function form(variant: string, action: string): string {
  switch (variant) {
    case "hidden":
    case "frame":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}${hiddenConsent("consent")}<button type="submit">Send</button></form>
<script>${hiddenScript}</script></body></html>`;
    case "custom":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}
  <div class="field"><div role="checkbox" aria-checked="false" aria-required="true" tabindex="0" class="cbx" aria-labelledby="cx-l"><span class="box"></span></div><span id="cx-l">I agree to Example Co's Privacy Policy</span><input type="hidden" name="consent" value=""></div>
  <button type="submit">Submit application</button></form>
<script>
const c = document.querySelector('.cbx');
const flip = () => { const on = c.getAttribute('aria-checked') !== 'true'; c.setAttribute('aria-checked', String(on)); c.querySelector('.box').classList.toggle('on', on); document.querySelector('input[name=consent]').value = on ? 'yes' : ''; };
// Only a real click or the keyboard: script-dispatched clicks are ignored (some component libraries).
c.addEventListener('click', (e) => { if (e.isTrusted) flip(); });
c.addEventListener('keydown', (e) => { if (e.key === ' ' && e.isTrusted) { e.preventDefault(); flip(); } });
</script></body></html>`;
    case "select":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}
  <div class="field"><label for="pp">Do you agree to Example Co's Privacy Policy? *</label><select id="pp" name="privacy" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
  <button type="submit">Submit application</button></form></body></html>`;
    case "rerender":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}
  <div class="field" id="rr"></div>
  <button type="submit">Submit application</button></form>
<script>
let renders = 0;
const render = () => { renders++; document.getElementById('rr').innerHTML = '<label><input type="checkbox" name="consent" value="yes" required> I agree to Example Co\\'s Privacy Policy</label>'; document.querySelector('#rr input').addEventListener('change', (e) => { if (e.target.checked && renders === 1) setTimeout(render, 250); }); };
render();
</script></body></html>`;
    case "twostep":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">
  <section class="s1"><h2>About you</h2>${contact}${hiddenConsent("consent_a")}<p class="step-err" role="alert" hidden>Please complete this step.</p><button type="button" class="next">Next</button></section>
  <section class="s2" hidden><h2>Review</h2>${hiddenConsent("consent_b")}<button type="submit">Submit application</button></section>
</form>
<script>${hiddenScript}${nextScript("document.querySelector('input[name=consent_a]').checked")}</script></body></html>`;
    case "mixed":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}${hiddenConsent("consent")}
  <div class="field"><label><input type="checkbox" name="certify" value="yes" required> I certify that the information in this application is true and complete *</label></div>
  <button type="submit">Submit application</button></form>
<script>${hiddenScript}</script></body></html>`;
    case "arbitration":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}${hiddenConsent("consent", `I agree to Example Co's <a class="policy" href="#policy">Privacy Policy</a> and to resolve any dispute through binding arbitration`)}
  <button type="submit">Submit application</button></form>
<script>${hiddenScript}</script></body></html>`;
    case "reject":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}
  <div class="field"><label><input type="checkbox" name="consent" value="yes" required onclick="return false"> I agree to Example Co's Privacy Policy</label></div>
  <button type="submit">Submit application</button></form></body></html>`;
    case "toggle":
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">
  <section class="s1"><h2>About you</h2>${contact}
    <div class="field agree-row"><p>I agree to Example Co's Privacy Policy.</p><button type="button" class="agree" aria-pressed="false">Agree</button><input type="hidden" name="consent" value=""></div>
    <p class="step-err" role="alert" hidden>Please agree to the Privacy Policy to continue.</p>
    <button type="button" class="next">Next</button></section>
  <section class="s2" hidden><h2>Review</h2><p>Check your details.</p><button type="submit">Submit application</button></section>
</form>
<script>
const t = document.querySelector('.agree');
t.onclick = () => { const on = t.getAttribute('aria-pressed') !== 'true'; t.setAttribute('aria-pressed', String(on)); t.textContent = on ? 'Agreed ✓' : 'Agree'; document.querySelector('input[name=consent]').value = on ? 'yes' : ''; };
${nextScript("document.querySelector('input[name=consent]').value === 'yes'")}
</script></body></html>`;
    case "screening": {
      const sel = (id: string, label: string, options: string[]) => `<div class="field"><label for="${id}">${label} *</label><select id="${id}" name="${id}" required><option value="">Select...</option>${options.map((o) => `<option>${o}</option>`).join("")}</select></div>`;
      return `${head("Apply (synthetic)")}<h1>Analyst (synthetic) — Application</h1>
<form method="post" action="${action}" enctype="multipart/form-data">${contact}
  ${sel("contact_employer", "May we contact your current employer?", ["Yes", "No"])}
  ${sel("work_auth", "Work Authorization", ["I am authorized to work for any employer in the country in which this position is based.", "I require/will require Example Co's sponsorship to obtain work authorization in the country in which this position is based.", "My status to work in the country in which this position is based is unknown."])}
  ${sel("privacy_doc", "Please review the linked document:", ["I acknowledge that I have read and understood the terms of the Example Co Candidate Privacy Notice."])}
  ${sel("prior", "Have you been employed by Example Co, or any subsidiary, affiliate, or business unit of Example Co, in the past?", ["Yes", "No"])}
  ${sel("relocate", "This position is required to work out of an Example Co office in Toronto; if you do not reside within commutable proximity to the office, are you open to relocating?", ["I am willing to relocate before starting employment.", "I am not willing to relocate before starting employment.", "I already reside within commutable distance to Toronto and am able to work at an on-site office."])}
  <div class="field"><label for="certify">I certify that the facts set forth in this Application for Employment are true and complete to the best of my knowledge. I understand that if I am employed, false statements, omissions or misrepresentations may result in my dismissal. I authorize the Employer to make an investigation of any of the facts set forth in this application and release the Employer from any liability. The employer may contact any provided references. *</label><input id="certify" name="certify" required></div>
  <button type="submit">Submit application</button></form></body></html>`;
    }
    default:
      return "";
  }
}

export async function consentRoute(_req: IncomingMessage, res: ServerResponse, u: URL): Promise<boolean> {
  const m = u.pathname.match(/^\/consent\/([a-z]+)(\/frame)?(\/confirmation)?$/);
  if (!m) return false;
  const html = (s: string, status = 200) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(s);
  };
  const [, variant, inFrame, done] = m;
  if (done) return html("<!doctype html><h1>Thank you for applying.</h1><p>Your application has been received.</p>"), true;
  if (variant === "iframe" && !inFrame) {
    html(`${head("Careers — Example Co (synthetic)")}<h1>Careers at Example Co</h1><p>Analyst (synthetic). Apply below.</p><iframe src="/consent/iframe/frame" title="Application" style="width:100%;height:900px;border:0"></iframe></body></html>`);
    return true;
  }
  const page = form(variant === "iframe" ? "frame" : variant, `${u.pathname}/submit`);
  if (!page) return html("not found", 404), true;
  html(page);
  return true;
}
