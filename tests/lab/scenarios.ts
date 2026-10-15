// The lab: SYNTHETIC, randomly generated career sites with hidden ground truth.
//
// A scenario is composed from building blocks (interaction patterns) with randomized labels, option
// order, layout, step order and wrappers — no two seeds look alike, and none is a known ATS. Each block
// declares what the SITE must finally receive (truth), so grading checks the values the site accepted,
// not what the automation believes it typed. The truth lives on the server only; the page shows nothing
// of it (no data attributes, no hints).
import { EXPECT, LAB_CA, LAB_UK } from "./profiles";

export type Who = "ca" | "uk";

export interface FieldTruth {
  /** Submitted form-field name. */
  name: string;
  /** What the field means (for reports). */
  meaning: string;
  /** Expected submitted value: string (normalised compare), RegExp, "" (must stay empty), or a check. */
  expect: string | RegExp | ((v: string | string[] | undefined) => boolean);
  /** An applicant field: a wrong value here is a critical failure. */
  applicant: boolean;
}

export type Outcome = "review" | "login" | "approval" | "questions";

export interface Scenario {
  id: string;
  seed: number;
  who: Who;
  /** The interaction patterns this scenario exercises. */
  patterns: string[];
  outcome: Outcome;
  /** Question labels expected when the outcome is "approval" / "questions". */
  asks: RegExp[];
  fields: FieldTruth[];
  /** Client events that must never happen (widget interactions, ticking declarations …). */
  forbidden: string[];
  pages: Record<string, string>;
  /** The entry page (path under /lab/<id>/). */
  entry: string;
}

// ---------------------------------------------------------------- randomness

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}
type R = ReturnType<typeof rng>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
let uid = 0;
const id = (p: string) => `${p}${++uid}`;
const star = (req: boolean, r: R) => (req ? r.pick([" *", "*", " (required)"]) : "");
/** A field wrapper in one of several layouts (label above, inline, in a table row, inside a fieldset). */
function wrap(r: R, label: string, control: string, forId: string, req = true) {
  const l = `<label for="${forId}">${esc(label)}${star(req, r)}</label>`;
  switch (r.pick(["div", "p", "row", "li"])) {
    case "p":
      return `<p class="q">${l}<br>${control}</p>`;
    case "row":
      return `<div class="row"><span class="cell">${l}</span><span class="cell">${control}</span></div>`;
    case "li":
      return `<ul class="fl"><li>${l} ${control}</li></ul>`;
    default:
      return `<div class="field">${l}${control}</div>`;
  }
}

// ---------------------------------------------------------------- blocks

interface Block {
  pattern: string;
  html: string;
  js?: string;
  fields: FieldTruth[];
  forbidden?: string[];
  outcome?: Outcome;
  asks?: RegExp[];
}

const P = (who: Who) => (who === "ca" ? LAB_CA : LAB_UK);
const E = (who: Who) => EXPECT[who];
const digits = (v: unknown) => String(Array.isArray(v) ? v[0] : (v ?? "")).replace(/\D+/g, "");
const one = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : (v ?? ""));

function names(r: R, who: Who): Block {
  const p = P(who).contact;
  if (r.chance(0.2)) {
    const i = id("nm");
    return { pattern: "name:full", html: wrap(r, r.pick(["Full name", "Name", "Legal name"]), `<input id="${i}" name="full_name" required>`, i), fields: [{ name: "full_name", meaning: "full name", expect: `${p.first_name} ${p.last_name}`, applicant: true }] };
  }
  const a = id("fn");
  const b = id("ln");
  const first = wrap(r, r.pick(["First name", "Given name", "First Name", "Forename"]), `<input id="${a}" name="first_name" required>`, a);
  const last = wrap(r, r.pick(["Last name", "Family name", "Surname", "Last Name"]), `<input id="${b}" name="last_name" required>`, b);
  return {
    pattern: "name:split",
    html: r.chance(0.15) ? last + first : first + last,
    fields: [
      { name: "first_name", meaning: "first name", expect: p.first_name, applicant: true },
      { name: "last_name", meaning: "last name", expect: p.last_name, applicant: true },
    ],
  };
}

function email(r: R, who: Who): Block {
  const i = id("em");
  const type = r.pick(["email", "text"]);
  let html = wrap(r, r.pick(["Email", "E-mail address", "Email address", "Your email"]), `<input id="${i}" type="${type}" name="email" required>`, i);
  const fields: FieldTruth[] = [{ name: "email", meaning: "email", expect: P(who).contact.email, applicant: true }];
  if (r.chance(0.3)) {
    const j = id("em2");
    html += wrap(r, r.pick(["Confirm email", "Re-enter email address"]), `<input id="${j}" type="${type}" name="email_confirm" required>`, j);
    fields.push({ name: "email_confirm", meaning: "email (confirm)", expect: P(who).contact.email, applicant: true });
  }
  return { pattern: "email", html, fields };
}

const CC_OPTIONS = [
  ["ASM_1", "American Samoa (+1)"],
  ["AUS_61", "Australia (+61)"],
  ["CAN_1", "Canada (+1)"],
  ["FRA_33", "France (+33)"],
  ["GBR_44", "United Kingdom (+44)"],
  ["USA_1", "United States (+1)"],
] as const;

/** A separate country-code control beside a local-number box (default sometimes a WRONG country). */
function phoneSplit(r: R, who: Who): Block {
  const c = id("cc");
  const n = id("ph");
  const codesOnly = r.chance(0.25);
  const opts = (codesOnly ? [["1", "+1"], ["33", "+33"], ["44", "+44"], ["61", "+61"]] : r.shuffle(CC_OPTIONS)) as readonly (readonly [string, string])[];
  const preset = r.pick(["", ...opts.map((o) => o[0])]);
  const select = `<select id="${c}" name="phone_cc" required><option value="">Please select</option>${opts.map(([v, t]) => `<option value="${v}"${v === preset ? " selected" : ""}>${t}</option>`).join("")}</select>`;
  const ccLabel = r.pick(["Country code", "Country Phone Code", "Dial code", "Phone country code"]);
  const numLabel = r.pick(["Phone number", "Mobile number", "Telephone", "Phone"]);
  const html = `<fieldset class="phone"><legend>${r.pick(["Phone", "Contact number", "How can we reach you?"])}</legend>${wrap(r, ccLabel, select, c)}${wrap(r, numLabel, `<input id="${n}" type="${r.pick(["tel", "text"])}" name="phone" required>`, n)}</fieldset>`;
  const ex = E(who);
  return {
    pattern: codesOnly ? "phone:split-codes" : "phone:split-countries",
    html,
    fields: [
      { name: "phone_cc", meaning: "phone country code", expect: codesOnly ? ex.cc : ex.ccOption, applicant: true },
      { name: "phone", meaning: "phone (local)", expect: (v) => digits(v) === ex.national, applicant: true },
    ],
  };
}

/** An international phone widget (flag + dial code) that re-reads what is typed. */
function phoneIntl(r: R, who: Who): Block {
  const n = id("ip");
  const mode = r.pick(["auto", "separate"]);
  const def = r.pick(["1", "44", "61"]);
  const html = wrap(
    r,
    r.pick(["Phone", "Mobile phone", "Phone number"]),
    `<div class="iti" data-mode="${mode}"><button type="button" class="iti__selected-flag" aria-label="Selected country"><span class="iti__selected-dial-code">+${def}</span></button><input id="${n}" type="tel" class="iti-input" name="phone_display" autocomplete="tel" required><input type="hidden" name="phone_e164"></div>`,
    n,
  );
  // Emulates intl-tel-input: "+…" switches the country; in "auto" mode digits without "+" are read as an
  // international number (6135550147 → +61 …), in "separate" mode they stay national under the shown code.
  const js = `document.querySelectorAll('.iti').forEach((w) => {
    const inp = w.querySelector('.iti-input'), dial = w.querySelector('.iti__selected-dial-code'), hid = w.querySelector('input[type=hidden]');
    const CODES = ['44', '61', '33', '1'];
    let cc = dial.textContent.replace('+', '');
    const upd = () => {
      const v = inp.value.trim(); let d = v.replace(/\\D/g, '');
      if (v.startsWith('+') || (w.dataset.mode === 'auto' && d)) { const c = CODES.find((x) => d.startsWith(x)); if (c) { cc = c; d = d.slice(c.length); } }
      dial.textContent = '+' + cc;
      inp.value = !d ? '' : w.dataset.mode === 'auto' ? '+' + cc + ' ' + d : d;
      hid.value = d ? '+' + cc + d : '';
    };
    inp.addEventListener('change', upd); inp.addEventListener('blur', upd);
  });`;
  return { pattern: `phone:intl-${mode}`, html, js, fields: [{ name: "phone_e164", meaning: "phone (international widget)", expect: E(who).e164, applicant: true }] };
}

/** A single box that formats as (XXX) XXX-XXXX — North American numbers only (Canadian applicant). */
function phoneMasked(r: R, who: Who): Block {
  const n = id("pm");
  const html = wrap(r, r.pick(["Phone number", "Daytime phone", "Contact phone"]), `<input id="${n}" class="mask" name="phone_masked" placeholder="(___) ___-____" required>`, n);
  const js = `document.querySelectorAll('input.mask').forEach((i) => { const f = () => { const d = i.value.replace(/\\D/g, '').slice(0, 10); i.value = d.length < 4 ? d : d.length < 7 ? '(' + d.slice(0, 3) + ') ' + d.slice(3) : '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); }; i.addEventListener('input', f); i.addEventListener('change', f); i.addEventListener('blur', f); });`;
  return { pattern: "phone:masked-national", html, js, fields: [{ name: "phone_masked", meaning: "phone (masked national)", expect: (v) => digits(v) === E(who).national, applicant: true }] };
}

/** One box that asks for the full international number. */
function phonePlus(r: R, who: Who): Block {
  const n = id("pp");
  const html = wrap(r, r.pick(["Phone (with country code)", "International phone number", "Phone"]), `<input id="${n}" type="tel" name="phone_intl" placeholder="+1 555 555 5555" required>`, n);
  return { pattern: "phone:plus-placeholder", html, fields: [{ name: "phone_intl", meaning: "phone (international, one box)", expect: (v) => one(v).trim().startsWith("+") && digits(v) === `${E(who).cc}${E(who).national}`, applicant: true }] };
}

function phoneType(r: R): Block {
  const i = id("pt");
  const opts = r.shuffle([r.pick(["Mobile", "Cell", "Cell phone"]), r.pick(["Home", "Landline"]), r.pick(["Work", "Business"])]);
  const html = wrap(r, r.pick(["Phone type", "Phone Device Type", "Type of phone", "Phone (device) type"]), `<select id="${i}" name="phone_type" required><option value="">Select</option>${opts.map((o) => `<option>${o}</option>`).join("")}</select>`, i);
  return { pattern: "phone:type", html, fields: [{ name: "phone_type", meaning: "phone type", expect: /^(mobile|cell|cell phone)$/i, applicant: true }] };
}

const PROVINCES: Record<string, [string, string][]> = {
  CA: [["ON", "Ontario"], ["QC", "Quebec"], ["BC", "British Columbia"]],
  GB: [["ENG", "England"], ["SCT", "Scotland"], ["WLS", "Wales"]],
  US: [["NY", "New York"], ["CA", "California"]],
  AU: [["NSW", "New South Wales"]],
};

/** Street / city / postal + country → dependent province (disabled until a country is chosen, filled late). */
function address(r: R, who: Who): Block {
  const [s, c, z, k, pv] = [id("st"), id("ci"), id("zp"), id("co"), id("pv")];
  const countries = r.shuffle([["CA", "Canada"], ["US", "United States"], ["GB", "United Kingdom"], ["AU", "Australia"]]);
  const parts = [
    wrap(r, r.pick(["Address line 1", "Street address", "Address"]), `<input id="${s}" name="street" required>`, s),
    wrap(r, r.pick(["City", "Town/City", "City / Town"]), `<input id="${c}" name="city" required>`, c),
    wrap(r, r.pick(["Postal code", "ZIP / Postal code", "Postcode"]), `<input id="${z}" name="postal" required>`, z),
  ];
  const country = wrap(r, r.pick(["Country", "Country of residence"]), `<select id="${k}" name="country" class="dep-country" required><option value="">Select…</option>${countries.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`, k);
  const prov = wrap(r, r.pick(["Province", "Province/State", "State / Province / Region"]), `<select id="${pv}" name="province" class="dep-prov" required disabled><option value="">Select…</option></select>`, pv);
  const js = `const PROV = ${JSON.stringify(PROVINCES)};
  document.querySelectorAll('select.dep-country').forEach((sel) => sel.addEventListener('change', () => {
    const p = sel.closest('form').querySelector('select.dep-prov'); p.disabled = true; p.innerHTML = '<option value="">Loading…</option>';
    setTimeout(() => { p.innerHTML = '<option value="">Select…</option>' + (PROV[sel.value] || []).map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join(''); p.disabled = false; }, 400);
  }));`;
  const ex = E(who);
  return {
    pattern: "address:dependent",
    html: r.shuffle(parts).join("") + country + prov,
    js,
    fields: [
      { name: "street", meaning: "street", expect: ex.street, applicant: true },
      { name: "city", meaning: "city", expect: ex.city, applicant: true },
      { name: "postal", meaning: "postal code", expect: ex.postal, applicant: true },
      { name: "country", meaning: "country", expect: ex.countryIso, applicant: true },
      { name: "province", meaning: "province (dependent)", expect: ex.province, applicant: true },
    ],
  };
}

/** A typeahead address box: the street is accepted only when a suggestion is picked. */
function addressAutocomplete(r: R, who: Who): Block {
  const i = id("aa");
  const ex = E(who);
  const html = wrap(r, r.pick(["Home address", "Address", "Start typing your address"]), `<div class="ac"><input id="${i}" class="ac-in" role="combobox" aria-expanded="false" aria-autocomplete="list" autocomplete="off" required><ul role="listbox" class="ac-list" hidden></ul><input type="hidden" name="street_ac"></div>`, i);
  const js = `document.querySelectorAll('.ac').forEach((w) => {
    const inp = w.querySelector('.ac-in'), list = w.querySelector('.ac-list'), hid = w.querySelector('input[type=hidden]');
    const SUG = ${JSON.stringify([`${ex.street}, ${ex.city}`, `${ex.street.replace(/^\d+/, "12")}, ${ex.city}`, `1 Example Ave, ${ex.city}`])};
    inp.addEventListener('input', () => { hid.value = ''; const q = inp.value.toLowerCase(); const m = q.length >= 3 ? SUG.filter((s) => s.toLowerCase().includes(q.slice(0, 6))) : [];
      list.innerHTML = m.map((s) => '<li role="option">' + s + '</li>').join(''); list.hidden = !m.length; inp.setAttribute('aria-expanded', String(!!m.length)); });
    list.addEventListener('click', (e) => { const li = e.target.closest('li'); if (!li) return; inp.value = li.textContent; hid.value = li.textContent; list.hidden = true; inp.setAttribute('aria-expanded', 'false'); });
  });`;
  return { pattern: "address:autocomplete", html, js, fields: [{ name: "street_ac", meaning: "address (autocomplete, committed)", expect: `${ex.street}, ${ex.city}`, applicant: true }] };
}

/** A custom searchable dropdown: typing filters; only a clicked option counts (typed text is discarded). */
function searchCountry(r: R, who: Who): Block {
  const i = id("sc");
  const all = r.shuffle(["Canada", "United States", "United Kingdom", "Australia", "France", "Cameroon"]);
  const html = wrap(r, r.pick(["Country of residence", "Where do you live?", "Current country"]), `<div class="cs"><input id="${i}" class="cs-in" role="combobox" aria-expanded="false" autocomplete="off" placeholder="Search…" required><ul role="listbox" class="cs-list" hidden>${all.map((c) => `<li role="option">${c}</li>`).join("")}</ul><input type="hidden" name="residence"></div>`, i);
  const js = `document.querySelectorAll('.cs').forEach((w) => {
    const inp = w.querySelector('.cs-in'), list = w.querySelector('.cs-list'), hid = w.querySelector('input[type=hidden]');
    const show = () => { const q = inp.value.toLowerCase(); list.querySelectorAll('li').forEach((li) => (li.hidden = !!q && !li.textContent.toLowerCase().includes(q))); list.hidden = false; inp.setAttribute('aria-expanded', 'true'); };
    inp.addEventListener('focus', show); inp.addEventListener('click', show); inp.addEventListener('input', () => { hid.value = ''; show(); });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (!li) return; e.preventDefault(); inp.value = li.textContent; hid.value = li.textContent; list.hidden = true; inp.setAttribute('aria-expanded', 'false'); });
    inp.addEventListener('blur', () => setTimeout(() => { if (!hid.value) inp.value = ''; list.hidden = true; inp.setAttribute('aria-expanded', 'false'); }, 150));
  });`;
  return { pattern: "dropdown:searchable", html, js, fields: [{ name: "residence", meaning: "country (searchable dropdown, committed)", expect: E(who).country, applicant: true }] };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function gradDate(r: R, who: Who): Block {
  const [m, y] = [id("gm"), id("gy")];
  const end = P(who).education[0].end;
  const label = r.pick(["Graduation date", "Date of graduation", "When did you graduate?"]);
  const html = `<fieldset class="date"><legend>${label}</legend>${wrap(r, "Month", `<select id="${m}" name="grad_month" required><option value="">Month</option>${MONTHS.map((x, k) => `<option value="${String(k + 1).padStart(2, "0")}">${x}</option>`).join("")}</select>`, m)}${wrap(r, "Year", `<select id="${y}" name="grad_year" required><option value="">Year</option>${Array.from({ length: 16 }, (_, k) => 2012 + k).map((x) => `<option>${x}</option>`).join("")}</select>`, y)}</fieldset>`;
  return {
    pattern: "date:month-year",
    html,
    fields: [
      { name: "grad_month", meaning: "graduation month", expect: end.slice(5, 7), applicant: true },
      { name: "grad_year", meaning: "graduation year", expect: end.slice(0, 4), applicant: true },
    ],
  };
}

function resume(r: R): Block {
  const i = id("cv");
  const html = r.chance(0.5)
    ? `<div class="up"><label for="${i}" class="btn">${r.pick(["Attach resume/CV", "Upload your resume", "Choose file"])}</label><input id="${i}" type="file" name="resume" accept=".pdf,.doc,.docx" style="position:absolute;left:-9999px" required></div>`
    : wrap(r, r.pick(["Resume", "CV", "Resume/CV"]), `<input id="${i}" type="file" name="resume" required>`, i);
  return { pattern: "upload:resume", html, fields: [{ name: "resume", meaning: "resume file", expect: /^Resume_Lab\.pdf$/, applicant: true }] };
}

function legal(r: R): Block {
  const i = id("lg");
  const html = `<div class="decl"><input type="checkbox" id="${i}" name="certify" value="yes" required> <label for="${i}">${r.pick(["I certify that the information provided is true and complete.", "I attest that my answers are accurate and I agree to the terms of this application."])}</label></div>`;
  return { pattern: "checkbox:declaration", html, fields: [{ name: "certify", meaning: "declaration (never ticked without approval)", expect: "", applicant: false }], outcome: "approval", asks: [/certify|attest/i] };
}

function conditional(r: R, who: Who): Block {
  const [y, n, sy, sn] = [id("ey"), id("en"), id("sy"), id("sn")];
  const q1 = r.pick(["Are you legally eligible to work in Canada?", "Are you legally entitled to work in Canada?"]);
  const q2 = r.pick(["Will you now or in the future require sponsorship for employment visa status?", "Do you require visa sponsorship to work in Canada?"]);
  const html = `<fieldset class="cond"><legend>${q1} *</legend><input type="radio" id="${y}" name="eligible" value="Yes" required><label for="${y}">Yes</label> <input type="radio" id="${n}" name="eligible" value="No"><label for="${n}">No</label></fieldset>
  <fieldset class="cond2" hidden><legend>${q2} *</legend><input type="radio" id="${sy}" name="sponsor" value="Yes"><label for="${sy}">Yes</label> <input type="radio" id="${sn}" name="sponsor" value="No"><label for="${sn}">No</label></fieldset>`;
  const js = `document.querySelectorAll('input[name=eligible]').forEach((x) => x.addEventListener('change', () => { const f = x.closest('form').querySelector('.cond2'); const on = x.value === 'Yes' && x.checked; f.hidden = !on; f.querySelectorAll('input').forEach((i) => (i.required = on)); }));`;
  // A citizen needs no sponsorship; for a work-permit holder only the applicant can say (asked, never inferred).
  const permit = P(who).work_authorization[0].status === "work_permit";
  return {
    pattern: "conditional:eligibility",
    html,
    js,
    fields: [
      { name: "eligible", meaning: "work eligibility", expect: "Yes", applicant: true },
      { name: "sponsor", meaning: "sponsorship (revealed by the first answer)", expect: permit ? "" : "No", applicant: true },
    ],
    ...(permit ? { outcome: "questions" as const, asks: [/sponsor/i] } : {}),
  };
}

function skills(r: R, who: Who): Block {
  const i = id("sk");
  const want = P(who).skills.slice(0, 2);
  const html = wrap(r, r.pick(["Skills", "Key skills", "Add your skills"]), `<div class="tags"><span class="chips"></span><input id="${i}" class="tag-in" placeholder="Type a skill and press Enter"></div>`, i, false);
  const js = `document.querySelectorAll('.tags').forEach((w) => { const inp = w.querySelector('.tag-in'), chips = w.querySelector('.chips');
    const add = () => { const v = inp.value.trim(); if (!v) return; chips.insertAdjacentHTML('beforeend', '<span class="chip">' + v + '<input type="hidden" name="skills[]" value="' + v.replace(/"/g, '') + '"></span>'); inp.value = ''; };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }); });`;
  return { pattern: "tags:skills", html, js, fields: [{ name: "skills[]", meaning: "skills as tags (optional)", expect: (v) => !v || want.every((s) => ([] as string[]).concat(v).includes(s)), applicant: false }] };
}

// ---------------------------------------------------------------- pages

const STYLE = `<style>body{font-family:sans-serif;max-width:880px;margin:16px auto}.field,.q,.row{margin:8px 0}label{display:block}.row .cell{display:inline-block;min-width:200px}[hidden]{display:none!important}.cta{background:#fd0;padding:8px 16px}.modal{position:fixed;inset:20% 25%;background:#fff;border:2px solid #333;padding:16px;z-index:10}</style>`;
const html = (title: string, body: string, js = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body>${body}<script>const LOG = (ev) => fetch(location.pathname.split('/').slice(0, 3).join('/') + '/log?ev=' + ev);${js}</script></body></html>`;

/** A job posting with distractions: job alerts, search, Save job, and (randomly) a talent-community sign-up,
 * a job-matching resume upload, a blocking cookie overlay, and an Apply menu (sign in vs. guest). */
function postingPage(r: R, applyHref: string, sc: { newtab: boolean; extras: Set<string> }): { body: string; js: string; forbidden: string[] } {
  const apply = r.pick(["Apply now", "Apply", "Apply for this job", "Start application"]);
  const alert = `<div class="side"><h3>${r.pick(["Get notified for similar jobs", "Job alerts", "Stay in touch"])}</h3><form class="alert"><input type="email" name="alert_email" placeholder="name@example.com"><button type="submit">${r.pick(["Submit", "Subscribe", "Sign up"])}</button></form></div>`;
  const search = `<section><h2>${r.pick(["Find your next job.", "Search jobs", "Explore careers"])}</h2><input name="q" role="combobox" placeholder="${r.pick(["Search job title or location", "Keywords", "Search"])}"><button type="button" class="srch">Search</button></section>`;
  const talent = sc.extras.has("talent")
    ? `<div class="tc"><h3>${r.pick(["Join our talent community", "Not ready to apply?", "Stay connected"])}</h3><form class="talent"><label for="tf">First name</label><input id="tf" name="tc_first"><label for="tl">Last name</label><input id="tl" name="tc_last"><label for="te">Email</label><input id="te" type="email" name="tc_email"><button type="submit">${r.pick(["Join", "Submit", "Sign up"])}</button></form></div>`
    : "";
  const match = sc.extras.has("match") ? `<div class="match"><p>${r.pick(["Find out how well you match with this job", "See jobs recommended for you"])}</p><label class="btn">Upload your resume<input type="file" class="mfile" style="position:absolute;left:-9999px"></label></div>` : "";
  const menu = sc.extras.has("menu");
  const cta = menu
    ? `<div class="am"><button type="button" class="cta amb">${apply}</button><div class="amenu" hidden><a href="#signin" class="ams">${r.pick(["Apply with your profile (sign in)", "Sign in to apply"])}</a> <a href="${applyHref}">${r.pick(["Apply manually", "Apply as a guest", "Continue without an account"])}</a></div></div>`
    : `<a class="cta" href="${applyHref}"${sc.newtab ? ' target="_blank"' : ""}>${apply}</a>`;
  const main = `<div class="main"><h1>Data Analyst (synthetic)</h1><p>Toronto · Full time</p><p>${"Help teams use data. ".repeat(10)}</p><div class="ctas"><button type="button" class="save">Save job</button> ${cta}</div></div>`;
  const privateChoice = r.pick(["Deny", "Reject all", "Only necessary cookies", "Decline"]);
  const cookie = sc.extras.has("cookie") ? `<div id="cookie-consent" class="cookie-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50"><div style="background:#fff;margin:20% auto;width:60%;padding:16px" role="dialog" aria-label="Cookies"><p>We use cookies to personalise content.</p><button type="button" class="ck-acc">Accept all cookies</button> <button type="button" class="ck-priv">${privateChoice}</button> <button type="button" class="ck-set">Cookie settings</button></div></div>` : "";
  const body = `${cookie}<header><a href="#">Careers</a></header>${r.shuffle([main, alert, search, talent, match].filter(Boolean)).join("")}<footer><a href="#">Privacy</a></footer>`;
  const js = `document.querySelectorAll('form.alert').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault(); LOG('subscribed'); }));
    document.querySelectorAll('form.talent').forEach((f) => { f.addEventListener('submit', (e) => { e.preventDefault(); LOG('talent_joined'); }); f.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => LOG('talent_typed'))); });
    document.querySelectorAll('.mfile').forEach((i) => i.addEventListener('change', () => LOG('match_uploaded')));
    document.querySelectorAll('input[name=q]').forEach((i) => i.addEventListener('input', () => LOG('search_typed')));
    document.querySelectorAll('.srch').forEach((b) => (b.onclick = () => LOG('search_clicked')));
    document.querySelectorAll('.save').forEach((b) => (b.onclick = () => LOG('save_job')));
    document.querySelectorAll('.amb').forEach((b) => (b.onclick = () => (b.parentElement.querySelector('.amenu').hidden = false)));
    document.querySelectorAll('.ams').forEach((a) => a.addEventListener('click', () => LOG('signin_chosen')));
    document.querySelectorAll('.ck-acc').forEach((b) => (b.onclick = () => { LOG('cookies_accepted'); document.getElementById('cookie-consent').remove(); }));
    document.querySelectorAll('.ck-priv').forEach((b) => (b.onclick = () => document.getElementById('cookie-consent').remove()));`;
  return { body, js, forbidden: ["subscribed", "search_typed", "search_clicked", "save_job", "talent_joined", "talent_typed", "match_uploaded", "signin_chosen", "cookies_accepted"] };
}

/** Steps → one form; "Next"-type buttons (submit-typed) reveal the next step; only the final button posts. */
function applicationPage(r: R, steps: Block[][], base: string, o: { review: boolean; modal: boolean; delayed: boolean; rerender: boolean; lostSelect: boolean }) {
  const nextLabel = r.pick(["Next", "Continue", "Save and continue", "Next step"]);
  const sections = steps.map((blocks, k) => `<section class="step"><h2>${r.pick(["Your details", "Step " + (k + 1), "Personal information", "About you", "Questions"])}</h2>${blocks.map((b) => b.html).join("")}<div class="err" role="alert" hidden>Please complete the required fields.</div><button type="submit" class="next">${nextLabel}</button></section>`);
  if (o.review) sections.push(`<section class="step"><h2>Review your application</h2><p>Please check your answers before submitting.</p><button type="submit" class="next">Review application</button></section>`);
  sections.push(`<section class="step"><h2>${r.pick(["Submit", "Final step", "Almost done"])}</h2><p>By submitting you confirm your application.</p><button type="submit" id="final">${r.pick(["Submit application", "Submit", "Send application"])}</button></section>`);
  // The review-step button and the last "next" both move on; the final section is the only one that posts.
  const form = `<form id="app" method="post" action="${base}/submit" enctype="multipart/form-data"><ol class="stepper">${sections.map((_, k) => `<li${k === 0 ? ' aria-current="step"' : ""}>Step ${k + 1}</li>`).join("")}</ol>${sections.join("")}</form>`;
  const stepJs = `const steps = [...document.querySelectorAll('section.step')];
    const show = (i) => steps.forEach((s, k) => (s.hidden = k !== i));
    document.querySelectorAll('button.next').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); const sec = b.closest('section.step');
      const miss = [...sec.querySelectorAll('[required]')].filter((x) => !x.disabled && !x.closest('[hidden]') && (x.type === 'file' ? !x.files.length : x.type === 'checkbox' ? !x.checked : x.type === 'radio' ? !sec.querySelector('input[name="' + x.name + '"]:checked') : !x.value));
      sec.querySelector('.err') && (sec.querySelector('.err').hidden = !miss.length); if (!miss.length) show(steps.indexOf(sec) + 1); }));
    document.getElementById('final').addEventListener('click', () => LOG('final_submit'));
    document.querySelectorAll('input[name=certify]').forEach((c) => c.addEventListener('change', () => c.checked && LOG('certify_ticked')));
    show(0);`;
  const lost = o.lostSelect ? `let once = new WeakSet(); document.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { if (once.has(s) || s.name === 'country') return; once.add(s); setTimeout(() => { s.value = ''; }, 300); }));` : "";
  const rer = o.rerender ? `document.querySelectorAll('#app input:not([type=file]):not([type=hidden]):not([type=radio]):not([type=checkbox]):not(.ac-in):not(.cs-in):not(.iti-input):not(.tag-in):not(.mask)').forEach((i) => i.addEventListener('change', function h() { if (i.dataset.rr) return; const c = i.cloneNode(true); c.value = i.value; c.dataset.rr = '1'; c.removeAttribute('data-ca-ref'); i.replaceWith(c); }, { once: true }));` : "";
  const blockJs = [...new Set(steps.flat().map((b) => b.js).filter(Boolean))].join("\n");
  const modal = o.modal ? `<div class="modal" role="dialog" aria-modal="true"><h3>${r.pick(["Before you begin", "Welcome", "Good to know"])}</h3><p>This application takes about ten minutes.</p><button type="button" class="mok">${r.pick(["Got it", "OK", "Continue", "Close"])}</button></div>` : "";
  const modalJs = o.modal ? `document.querySelectorAll('.mok').forEach((b) => (b.onclick = () => b.closest('.modal').remove()));` : "";
  const content = `<h1>Data Analyst (synthetic) — Application</h1>${modal}<div id="holder">${o.delayed ? "" : form}</div>`;
  const init = `${modalJs}${blockJs}\n${stepJs}\n${lost}\n${rer}`;
  const js = o.delayed ? `setTimeout(() => { document.getElementById('holder').innerHTML = ${JSON.stringify(form)}; (function(){ ${init} })(); }, 1500); ${modalJs}` : init;
  return html("Apply", content, js);
}

// ---------------------------------------------------------------- scenarios

export function makeScenario(seed: number): Scenario {
  const r = rng(seed * 7919 + 13);
  const who: Who = r.chance(0.25) ? "uk" : "ca";
  const kind = r.pick(["form", "form", "form", "form", "form", "login", "legal"]);
  const base = `/lab/s${seed}`;
  const posting = kind === "login" || r.chance(0.6);
  const newtab = posting && r.chance(0.2);
  const pages: Record<string, string> = {};
  const forbidden: string[] = ["final_submit_before_approval", "certify_ticked"];
  // Blocks
  const phone = who === "ca" ? r.pick([phoneSplit, phoneIntl, phoneMasked, phonePlus]) : r.pick([phoneSplit, phoneIntl, phonePlus]);
  const pool = r.shuffle([address, addressAutocomplete, searchCountry, gradDate, conditional, skills, phoneType]);
  const step1: Block[] = r.shuffle([names(r, who), email(r, who), phone(r, who)]);
  const more = pool.slice(0, 1 + Math.floor(r.next() * 3)).map((f) => (f as (r: R, w: Who) => Block)(r, who));
  const step2: Block[] = r.shuffle([...more, resume(r)]);
  if (kind === "legal") step2.push(legal(r));
  const steps = r.chance(0.4) ? [[...step1, ...step2]] : [step1, step2];
  const blocks = steps.flat();
  const o = { review: r.chance(0.5), modal: r.chance(0.3), delayed: r.chance(0.2), rerender: r.chance(0.25), lostSelect: r.chance(0.15) };
  if (kind === "login") {
    const p = postingPage(r, `${base}/login`, { newtab: false, extras: new Set() });
    pages["job"] = html("Data Analyst | Careers", p.body, p.js);
    pages["login"] = html(
      "Sign in",
      `<h1>Sign in to apply</h1><form class="login"><label for="u">Email</label><input id="u" type="email" name="user"><label for="pw">Password</label><input id="pw" type="password" name="pw"><button type="submit">Sign in</button></form><p>New here? <a href="${base}/register">Create an account</a></p>`,
      `document.querySelector('form.login').addEventListener('submit', (e) => { e.preventDefault(); LOG('login_submitted'); }); document.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => LOG('login_typed')));`,
    );
    return { id: `s${seed}`, seed, who, patterns: ["page:posting", "page:login"], outcome: "login", asks: [], fields: [], forbidden: [...forbidden, ...p.forbidden, "login_typed", "login_submitted"], pages, entry: "job" };
  }
  pages["apply"] = applicationPage(r, steps, base, o);
  let entry = "apply";
  const distractions = new Set(posting ? ["talent", "match", "cookie", "menu", "iframe"].filter(() => r.chance(0.3)) : []);
  if (distractions.has("menu")) distractions.delete("iframe");
  if (distractions.has("iframe")) {
    // The application inside a frame on the employer's page (as many career sites embed their ATS).
    pages["apply-frame"] = html("Apply", `<header><a href="#">Careers</a></header><h1>Apply</h1><iframe src="${base}/apply" title="Application" style="width:100%;height:1400px;border:0"></iframe>`);
  }
  if (posting) {
    const p = postingPage(r, distractions.has("iframe") ? `${base}/apply-frame` : `${base}/apply`, { newtab, extras: distractions });
    pages["job"] = html("Data Analyst | Careers", p.body, p.js);
    forbidden.push(...p.forbidden);
    entry = "job";
  }
  const patterns = [
    ...(posting ? ["page:posting"] : []),
    "page:multistep",
    ...(o.review ? ["page:review-step"] : []),
    ...(o.modal ? ["popup:modal"] : []),
    ...(o.delayed ? ["dynamic:delayed"] : []),
    ...(o.rerender ? ["dynamic:rerender"] : []),
    ...(o.lostSelect ? ["dynamic:lost-selection"] : []),
    ...(newtab ? ["nav:new-tab"] : []),
    ...[...distractions].map((x) => ({ talent: "posting:talent-community", match: "posting:job-match-upload", cookie: "popup:cookie-overlay", menu: "posting:apply-menu", iframe: "nav:iframe" })[x]!),
    ...blocks.map((b) => b.pattern),
  ];
  // A declaration (approval) outranks a missing answer (questions); otherwise the run should reach review.
  const outcome: Outcome = blocks.some((b) => b.outcome === "approval") ? "approval" : (blocks.find((b) => b.outcome)?.outcome ?? "review");
  return { id: `s${seed}`, seed, who, patterns, outcome, asks: blocks.flatMap((b) => b.asks ?? []), fields: blocks.flatMap((b) => b.fields), forbidden, pages, entry };
}

export const PROFILE_OF = { ca: LAB_CA, uk: LAB_UK } as const;
