// What a page IS before anything on it is touched (unfamiliar employer sites).
//
// "Contains inputs" is not "is an application form". A job posting carries site search, job-alert
// sign-ups, cookie banners and navigation; none of them belong to the application. PAGE_MAP reads
// the page's structure, marks those widgets (data-ca-outside="<kind>") so the scanner, the filler,
// the option reader and the Submit finder never act on them, and marks the application's scope
// (data-ca-app-root) once applicant fields exist outside the widgets. `pageState` then decides,
// from evidence, whether this is a posting, an application step, a sign-in step or unknown.
//
// Widgets are recognised by structure first (a small box with one or two inputs, its own button,
// its surroundings), with wording only as supporting context — never by a site-specific selector.
// Labels and headings only; values are never read.

export type WidgetKind = "search" | "subscription" | "matching" | "chrome" | "cookie";

export interface PageWidget {
  kind: WidgetKind;
  heading: string;
  inputs: number;
  buttons: string[];
}

export interface PageMap {
  url: string;
  /** Visible buttons / links that are not inside a widget. */
  names: string[];
  /** Buttons / links inside site chrome (header, nav, footer): candidates for Apply only. */
  chromeNames: string[];
  /** Buttons inside search / subscription widgets (never acted on as application controls). */
  widgetNames: string[];
  /** Buttons of a cookie banner (the privacy-preserving choice is made by `decideNavigation`). */
  cookieNames: string[];
  widgets: PageWidget[];
  /** Visible fields outside widgets. */
  applicationFields: number;
  /** Distinct applicant meanings among them (first_name, email, phone, resume, address …). */
  semantics: string[];
  applicantFields: number;
  labels: string[];
  headings: string[];
  /** Step markers: a stepper, "Step 2 of 5", or an application address (…/apply, step=…). */
  steps: boolean;
  /** Final-submit controls inside the application scope (outside widgets). */
  submits: string[];
  appRoot: boolean;
  frames: { src: string; area: number }[];
}

export type PageState = "posting" | "application" | "questions" | "review" | "login" | "unknown";

/**
 * A cookie-banner control by what it does: "private" (reject / necessary only — the choice Career Atlas
 * makes), "settings" (opens the preferences; no consent given), "consent" (accepts, including "closing
 * means you accept"), or "other".
 */
export function cookieChoice(text: string): "private" | "settings" | "consent" | "other" {
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (/\b(reject|decline|deny|refuse|disallow|opt[- ]?out|do not (accept|allow|sell))\b|\b(necessary|essential|required|strictly necessary)( cookies)?( only)?\b|\bonly (necessary|essential|required)\b|continue without (accepting|cookies)/.test(t) && !/\ball\b.*\b(accept|allow)|\b(accept|allow) all\b/.test(t)) return "private";
  if (/\b(accept|agree|allow|consent|accepted)\b/.test(t)) return "consent";
  if (/\b(settings|preferences|manage|customi[sz]e|options|choices|details)\b/.test(t)) return "settings";
  return "other";
}

/** A control that starts an application (accessible names often append the job title: "Apply Now <title>"). */
export const APPLY_CTA_RE = /^(apply\b(?!(ing)?\s*(filters?|to (all|selected)))|start (my |your |an )?application\b|begin (my |your |an )?application\b)/i;

/**
 * The page's state from evidence. `inWorkflow`: an Apply / guest action was taken in this run and the
 * page changed. A lone e-mail box never makes an application; neither does a page whose only inputs
 * are widgets.
 */
export function pageState(m: PageMap, ctx: { inWorkflow: boolean; login: boolean }): PageState {
  const strong = m.semantics.length >= 2 || m.semantics.includes("resume");
  if (ctx.login && !strong) return "login";
  if (strong) return "application";
  // Inside the application, a page without fields that shows the application's own Submit: its final step.
  if (ctx.inWorkflow && m.applicationFields === 0 && m.submits.length > 0) return "review";
  if (m.applicationFields > 0 && (ctx.inWorkflow || m.steps)) return "questions";
  if ([...m.names, ...m.chromeNames].some((n) => APPLY_CTA_RE.test(n.trim()))) return "posting";
  return "unknown";
}

export const PAGE_MAP = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  for (const el of document.querySelectorAll('[data-ca-outside]')) el.removeAttribute('data-ca-outside');
  for (const el of document.querySelectorAll('[data-ca-app-root]')) el.removeAttribute('data-ca-app-root');
  const SKIP_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'password'];
  const fieldsIn = (root) => [...root.querySelectorAll('input, select, textarea')].filter((e) => !SKIP_TYPES.includes((e.getAttribute('type') || '').toLowerCase()) && (vis(e) || (e.getAttribute('type') || '').toLowerCase() === 'file'));
  const all = fieldsIn(document).filter((e) => e.id !== 'lang-select' && e.name !== 'g-recaptcha-response' && e.id !== 'g-recaptcha-response');
  const labelOf = (el) => {
    let l = '';
    if (el.id) { const x = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (x) l = clean(x.innerText); }
    if (!l && el.closest('label')) l = clean(el.closest('label').innerText);
    if (!l) l = clean(el.getAttribute('aria-label') || '');
    const by = el.getAttribute('aria-labelledby');
    if (!l && by) l = clean(by.split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' '));
    return l;
  };
  const desc = (el) => [labelOf(el), el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('type')].join(' ');
  // ---- the smallest box that holds a control and at most two fields of its own (a widget's extent)
  // It stops before page content: the job's own heading (h1), many links / buttons, or long text.
  const boxOf = (el) => {
    let box = el;
    for (let x = el.parentElement, d = 0; x && x !== document.body && d < 8; x = x.parentElement, d++) {
      if (fieldsIn(x).length > 2 || x.querySelector('h1') || x.querySelectorAll('a[href], button, [role="button"]').length > 6 || (x.innerText || '').length > 700) break;
      box = x;
    }
    return box;
  };
  // A box's heading: its own, else the nearest heading just before it.
  const HEAD = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';
  const headingOf = (box) => {
    const own = box.querySelector(HEAD);
    if (own && clean(own.innerText)) return clean(own.innerText);
    for (let x = box, d = 0; x && x !== document.body && d < 4; x = x.parentElement, d++) {
      for (let s = x.previousElementSibling, k = 0; s && k < 3; s = s.previousElementSibling, k++) {
        const h = s.matches(HEAD) ? s : s.querySelector(HEAD);
        if (h && clean(h.innerText)) return clean(h.innerText);
      }
    }
    return clean(box.getAttribute('aria-label') || '');
  };
  const buttonsIn = (root) => [...root.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"]')].filter(vis);
  const nameOf = (b) => clean(b.getAttribute('aria-label') || b.innerText || b.value || '');
  const SEARCH_WORDS = /\bsearch\b|keywords?\b|find (a |your )?(next )?job/i;
  const ALERT_WORDS = /notif|alert|subscri|newsletter|similar jobs|talent (community|network|pool)|stay (connected|in touch)|job ?mail|keep me posted/i;
  const CHROME = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
  const COOKIE = '[id*="cookie" i], [class*="cookie" i], [id*="onetrust" i], [class*="onetrust" i], [id*="consent-banner" i], [class*="consent-banner" i]';
  const isEmail = (el) => (el.getAttribute('type') || '').toLowerCase() === 'email' || /e-?mail/i.test(desc(el));
  const SEM = [
    ['first_name', /first|given|forename/i], ['last_name', /last ?name|family|surname/i], ['full_name', /full ?name|^name$|legal name/i],
    ['email', /e-?mail/i], ['phone', /phone|mobile|\btel\b|cell/i], ['address', /address|street/i], ['city', /\bcity\b|town/i],
    ['postal', /postal|zip/i], ['linkedin', /linkedin/i],
  ];
  const semOf = (el) => {
    if ((el.getAttribute('type') || '').toLowerCase() === 'file') return /resume|cv\b|curriculum|attach|upload|file/i.test(desc(el) + ' ' + (el.closest('div')?.innerText || '').slice(0, 120)) ? 'resume' : null;
    const l = labelOf(el), d = desc(el);
    const hit = SEM.find(([, re]) => re.test(l || d) || re.test(d));
    return hit ? hit[0] : null;
  };
  // A control whose neighbourhood (the first enclosing block with more fields) holds applicant fields is
  // part of an application, whatever its own box looks like (e.g. the application's own e-mail field).
  const besideApplicant = (box) => {
    for (let x = box.parentElement; x && x !== document.body && x !== document.documentElement; x = x.parentElement) {
      const f = fieldsIn(x);
      if (f.length <= 2) continue;
      return new Set(f.map(semOf).filter(Boolean)).size >= 2;
    }
    return false;
  };
  const widgets = [];
  const mark = (box, kind) => {
    if (box.closest('[data-ca-outside]')) return;
    // Never the job's own content: a box holding the page heading or a control that starts the application.
    if (kind !== 'chrome' && (box.querySelector('h1') || buttonsIn(box).some((b) => /^apply\b|^start (my |your |an )?application/i.test(nameOf(b))))) return;
    box.setAttribute('data-ca-outside', kind);
    widgets.push({ kind, heading: headingOf(box).slice(0, 80), inputs: fieldsIn(box).length, buttons: buttonsIn(box).map(nameOf).filter(Boolean).slice(0, 6) });
  };
  // Cookie banners: say "cookie", sit outside any form, outermost match only.
  for (const c of document.querySelectorAll(COOKIE)) {
    if (!vis(c) || c.closest('form') || !/cookie/i.test((c.innerText || '').slice(0, 800))) continue;
    let outer = false;
    for (let x = c.parentElement; x && !outer; x = x.parentElement) outer = x.matches(COOKIE) && vis(x) && /cookie/i.test((x.innerText || '').slice(0, 800));
    if (outer) continue;
    if (fieldsIn(c).length || buttonsIn(c).length) mark(c, 'cookie');
  }
  const applyOnPage = buttonsIn(document).some((b) => /^apply\b|^start (my |your )?application/i.test(nameOf(b)));
  for (const el of all) {
    if (el.closest('[data-ca-outside]')) continue;
    const box = boxOf(el);
    const inBox = fieldsIn(box);
    const t = (el.getAttribute('type') || '').toLowerCase();
    const bigForm = el.form && fieldsIn(el.form).length > 2;
    const explicitSearch = t === 'search' || el.getAttribute('role') === 'searchbox' || !!el.closest('[role="search"]');
    if (!explicitSearch && (bigForm || besideApplicant(box))) continue;
    const words = clean(headingOf(box) + ' ' + (box.innerText || '').slice(0, 300));
    const btns = buttonsIn(box).map(nameOf);
    // Site search: a search-typed control, or one or two fields describing a search with their own Search / Find button.
    const searchy = explicitSearch || (inBox.length <= 2 && SEARCH_WORDS.test(desc(el)) && !inBox.some((x) => (x.getAttribute('type') || '') === 'file')) || (inBox.length <= 2 && btns.some((b) => /^(search|find( jobs?)?)$/i.test(b)) && !isEmail(el));
    if (searchy) { mark(box, 'search'); continue; }
    // Job alerts / newsletters: an e-mail box (at most with a name) that talks about alerts, or sits in a
    // sidebar, or is the only field of its own small form on a page that still offers Apply.
    const others = inBox.filter((x) => x !== el);
    const lone = isEmail(el) && others.every((x) => /name/i.test(desc(x)) && !isEmail(x)) && !inBox.some((x) => /tel|phone/i.test(desc(x)) || (x.getAttribute('type') || '') === 'file');
    const ownForm = !!el.form && fieldsIn(el.form).length <= 2;
    if (lone && (ALERT_WORDS.test(words) || el.closest('aside, [role="complementary"]') || (ownForm && applyOnPage))) { mark(el.form && !box.contains(el.form) ? el.form : box, 'subscription'); continue; }
  }
  // Sign-up forms (talent community, newsletter, job alerts) that ask only for a name and an e-mail: not the
  // application — when they say so, or when the page offers Apply outside them.
  const SIGNUP_WORDS = /talent (community|network|pool)|join (our|the) (team|community|network)|newsletter|subscri|job alert|sign up|stay (connected|in touch)|get (updates|notified)|keep me (posted|informed)/i;
  const blocks = [...document.querySelectorAll('form'), ...document.querySelectorAll('[class*="talent" i], [class*="community" i], [class*="newsletter" i], [class*="subscribe" i], [id*="talent" i], [id*="newsletter" i]')];
  for (const b of blocks) {
    if (b.closest('[data-ca-outside]')) continue;
    const fs = fieldsIn(b).filter((e) => !e.closest('[data-ca-outside]'));
    if (!fs.length || fs.length > 4) continue;
    const sems = fs.map(semOf);
    if (!sems.includes('email') || sems.some((x) => x && !['first_name', 'last_name', 'full_name', 'email'].includes(x)) || fs.some((e) => !semOf(e) && !/name/i.test(desc(e)))) continue;
    const words = clean(headingOf(b) + ' ' + (b.innerText || '').slice(0, 400));
    const applyOutside = buttonsIn(document).some((x) => !b.contains(x) && /^apply\b|^start (my |your |an )?application/i.test(nameOf(x)));
    if (SIGNUP_WORDS.test(words) || ALERT_WORDS.test(words) || applyOutside) mark(b, 'subscription');
  }
  // Job-matching tools ("Upload your resume to see how well you match"): a lone upload on a posting is not
  // the application — when it says so, or when it is the page's only field and Apply is offered elsewhere.
  const MATCH_WORDS = /how well you match|match(es|ing)? (you|your)|see (jobs|roles) (that|which) match|recommend(ed|ations)?|personali[sz]ed jobs|find (jobs|roles) for you|job match/i;
  const remaining = all.filter((e) => !e.closest('[data-ca-outside]'));
  for (const up of remaining.filter((e) => (e.getAttribute('type') || '').toLowerCase() === 'file')) {
    let box = up.parentElement;
    for (let x = box, d = 0; x && x !== document.body && d < 6; x = x.parentElement, d++) {
      if (fieldsIn(x).length > 1 || x.querySelector('h1')) break;
      box = x;
      if (vis(x) && (x.innerText || '').trim().length > 20) break;
    }
    if (!box) continue;
    const words = clean(headingOf(box) + ' ' + (box.innerText || '').slice(0, 300));
    const alone = remaining.length === 1;
    const applyOutside = buttonsIn(document).some((x) => !box.contains(x) && /^apply\b|^start (my |your |an )?application/i.test(nameOf(x)));
    if (MATCH_WORDS.test(words) || (alone && applyOutside)) mark(box, 'matching');
  }
  // Site chrome (page header / navigation / footer): only when it shares no block with the remaining
  // fields — an application's own footer (with its Next button) is part of the application.
  const pre = all.filter((e) => !e.closest('[data-ca-outside]'));
  for (const c of document.querySelectorAll(CHROME)) {
    if (c.closest('[data-ca-outside]') || c.parentElement?.closest(CHROME) || c.closest('form, [role="dialog"], dialog')) continue;
    let shared = false;
    for (let x = c.parentElement; x && x !== document.body && x !== document.documentElement && !shared; x = x.parentElement) shared = pre.some((f) => x.contains(f) && !c.contains(f));
    if (!shared) mark(c, 'chrome');
  }
  // ---- what remains: the application (if anything)
  const inScope = all.filter((e) => !e.closest('[data-ca-outside]'));
  const semantics = new Set();
  const applicant = [];
  const labels = [];
  for (const el of inScope) {
    const l = labelOf(el);
    if (l) labels.push(l.slice(0, 160));
    const sm = semOf(el);
    if (sm) { semantics.add(sm); applicant.push(el); }
  }
  // Application scope: the lowest element holding every applicant field (else every remaining field).
  const holders = applicant.length ? applicant : inScope;
  let root = null;
  if (holders.length) {
    root = holders[0].parentElement;
    while (root && root !== document.documentElement && !holders.every((h) => root.contains(h))) root = root.parentElement;
    if (root) root.setAttribute('data-ca-app-root', '1');
  }
  const names = [];
  const chromeNames = [];
  const widgetNames = [];
  const cookieNames = [];
  for (const b of buttonsIn(document)) {
    const n = nameOf(b);
    if (!n || n.length > 180) continue;
    const w = b.closest('[data-ca-outside]')?.getAttribute('data-ca-outside');
    const list = !w ? names : w === 'chrome' ? chromeNames : w === 'cookie' ? cookieNames : widgetNames;
    if (!list.includes(n)) list.push(n);
  }
  const SUBMIT = /^(submit|submit( my| your)? application|send( my)? application|complete( my)? application|finish( and submit)?)$/i;
  // The application's own Submit (in its scope; on a review page without fields, anywhere outside widgets).
  const submits = buttonsIn(root || document).filter((b) => !b.closest('[data-ca-outside]') && SUBMIT.test(nameOf(b))).map(nameOf);
  const headings = [...document.querySelectorAll('h1, h2')].filter((h) => vis(h) && !h.closest('[data-ca-outside]')).map((h) => clean(h.innerText).slice(0, 100)).filter(Boolean).slice(0, 8);
  const steps = /\/apply\b|\/application\b|[?&]step=|\/candidate\b/i.test(location.pathname + location.search) || !!document.querySelector('[aria-current="step"], [class*="stepper" i], [class*="progress-step" i]') || /\bstep \d+ (of|\/) \d+\b/i.test((document.body?.innerText || '').slice(0, 5000));
  const frames = [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { src: f.src || '', area: (r.width * r.height) / Math.max(1, innerWidth * innerHeight) }; }).filter((f) => /^https?:/.test(f.src) && f.area > 0.25);
  return { url: location.origin + location.pathname, names, chromeNames, widgetNames, cookieNames, widgets, applicationFields: inScope.length, semantics: [...semantics], applicantFields: applicant.length, labels: labels.slice(0, 40), headings, steps, submits: [...new Set(submits)], appRoot: !!root, frames };
})()`;

/**
 * The final Submit that belongs to the application, marked data-ca-submit. Widgets are never candidates.
 * Ownership: a candidate inside a form holding the applicant's fields (earlier, hidden steps of the same
 * form count — a review step often shows no fields) wins; else, within the application scope, the one
 * explicit candidate ("Submit application") or the only candidate. Returns 1 when exactly one control
 * qualifies; 0 (none) or 2+ (ambiguous) mean: do not click.
 */
export const MARK_SUBMIT = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  for (const el of document.querySelectorAll('[data-ca-submit]')) el.removeAttribute('data-ca-submit');
  const SUBMIT = /^(submit|submit( my| your)? application|send( my)? application|complete( my)? application|finish( and submit)?)$/i;
  const EXPLICIT = /application/i;
  const nameOf = (b) => clean(b.getAttribute('aria-label') || b.innerText || b.value || '');
  const cands = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter((b) => vis(b) && !b.closest('[data-ca-outside]') && SUBMIT.test(nameOf(b)));
  if (!cands.length) return 0;
  const SEM = [/first|given/i, /last ?name|family|surname/i, /e-?mail/i, /phone|mobile/i, /address|street/i, /resume|cv\b|curriculum/i, /full ?name|legal name/i];
  const semanticsIn = (root) => {
    const seen = new Set();
    for (const e of root.querySelectorAll('input, select, textarea')) {
      const t = (e.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(t) || e.closest('[data-ca-outside]')) continue;
      const lab = e.id ? (document.querySelector('label[for="' + CSS.escape(e.id) + '"]')?.innerText || '') : '';
      const d = [lab, e.getAttribute('aria-label'), e.name, e.id, e.getAttribute('autocomplete'), t === 'file' ? 'resume' : ''].join(' ');
      SEM.forEach((re, i) => { if (re.test(d)) seen.add(i); });
    }
    return seen.size;
  };
  const pick = (list) => {
    const explicit = list.filter((b) => EXPLICIT.test(nameOf(b)));
    const use = explicit.length ? explicit : list;
    const owners = new Set(use.map((b) => b.form || b.closest('form') || 'page'));
    if (owners.size !== 1) return owners.size;
    use[0].setAttribute('data-ca-submit', '1');
    return 1;
  };
  // 1. The form that holds the application (two or more applicant meanings).
  const owned = cands.filter((b) => { const f = b.form || b.closest('form'); return f && semanticsIn(f) >= 2; });
  if (owned.length) return pick(owned);
  // 2. Otherwise inside the application's scope, outside any form that holds no applicant field at all
  //    (a feedback or newsletter form).
  const root = document.querySelector('[data-ca-app-root]');
  const scoped = cands.filter((b) => (!root || root.contains(b) || b.contains(root) || !b.closest('form')) && !((b.form || b.closest('form')) && semanticsIn(b.form || b.closest('form')) === 0 && [...(b.form || b.closest('form')).querySelectorAll('input, select, textarea')].some((e) => !['hidden', 'submit', 'button'].includes((e.getAttribute('type') || '').toLowerCase()))));
  return scoped.length ? pick(scoped) : 0;
})()`;
