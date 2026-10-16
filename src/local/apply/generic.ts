import { APPLY_CTA_RE, cookieChoice } from "./page-intent";
// Unfamiliar employer sites (not Workday, Greenhouse or Lever).
//
// The loop is OBSERVE → REASON → RETRIEVE → ACT → VERIFY → REPEAT.
// REASON is deterministic: which button is Apply, guest apply, Next, or a cookie banner.
// RETRIEVE stays in the planner (My Profile). ACT/VERIFY stay in interact.ts.
// A model is asked only when that reasoning is stuck, and it never receives profile values.
// Submit, account creation and sign-in are never chosen here.

export interface PageObservation {
  names: string[];
  /** Visible inputs that could belong to an application (not the language picker or a CAPTCHA token). */
  applicationFields: number;
  labels: string[];
  /** Of those, how many look like applicant fields (name, e-mail, phone, resume, address …). */
  applicantFields?: number;
  /** Buttons of a cookie banner (their purpose is read by `cookieChoice`). */
  cookieNames?: string[];
  /** Large embedded frames (src, share of the viewport) — a form may live inside one. */
  frames?: { src: string; area: number }[];
}

export type NavDecision =
  | { action: "click"; name: string; why: "cookie" | "guest" | "apply" }
  | { action: "login" }
  | { action: "captcha" }
  | { action: "fill" }
  | { action: "stuck" };

export type AdvanceDecision = { action: "click"; name: string; why: "next" } | { action: "review" } | { action: "stuck" };

// A bare "Send" is a final submit too (Recruitee and others).
const SUBMIT_RE = /^(submit|submit( my)? application|send|send( my)? application)$/i;
// Moving on inside the application (a "Review" step is not the final submission).
const NEXT_RE = /^(next|continue|save and continue|save & continue|next step|proceed|continue to (the )?next step|review( (my|your))?( application)?|go to review|preview( application)?)$/i;
// Applying without an account (never creates one): "as a guest", "without an account", "manually".
const GUEST_RE = /\b(apply|continue|proceed|start)( as an?| as)? guest\b|\bwithout (an |a |creating an |creating a )?(account|profile|signing in|logging in|sign[- ]?in|log[- ]?in)\b|\bapply manually\b|\bmanual application\b|\bguest (application|apply|checkout)\b|\bno account\b/i;
const CREATE_RE = /create (an |one )?account|create one now|^sign up$|^register$/i;
// A control that starts an application (shared with page-intent.ts).
const APPLY_RE = APPLY_CTA_RE;
// The most privacy-preserving cookie choice offered: reject, else "necessary only".
const COOKIE_RE = /^(reject|reject all|decline|decline all|reject optional( cookies)?|refuse( all)?)$/i;
const COOKIE_NECESSARY_RE = /^(agree to necessary|accept necessary( cookies)?|(use )?necessary (cookies )?only|only necessary( cookies)?|essential (cookies )?only|accept essential( cookies)?|allow necessary( cookies)?)$/i;
const BLOCKED_RE = /^(submit|send application|send$|cancel|delete|remove|sign in|log in|create account|create one now|register|sign up)\b/i;

export function decideNavigation(obs: PageObservation, ctx: { password: boolean; challenge: boolean; cookieDismissed: boolean }): NavDecision {
  const names = obs.names.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (ctx.challenge) return { action: "captcha" };
  const cookie = names.find((n) => COOKIE_RE.test(n)) ?? names.find((n) => COOKIE_NECESSARY_RE.test(n)) ?? (obs.cookieNames ?? []).find((n) => cookieChoice(n) === "private");
  if (cookie && !ctx.cookieDismissed) return { action: "click", name: cookie, why: "cookie" };
  // A password field is a sign-in or account form. Never type the profile into it and never create an account.
  if (ctx.password) return { action: "login" };
  const guest = names.find((n) => GUEST_RE.test(n));
  if (guest) return { action: "click", name: guest, why: "guest" };
  // Inputs that are not an application (site search, newsletter, cookie toggles) don't make a form:
  // a posting with an Apply button and no applicant fields is still a posting.
  const applicantFields = obs.applicantFields ?? obs.applicationFields;
  const applyOffered = names.some((n) => APPLY_RE.test(n) && !GUEST_RE.test(n) && !CREATE_RE.test(n));
  // Later steps of an application (a questionnaire) have no name / e-mail fields and no Apply button:
  // they are still forms to fill.
  if (obs.applicationFields === 0 || (applicantFields === 0 && applyOffered)) {
    const apply = names.find((n) => APPLY_RE.test(n) && !GUEST_RE.test(n) && !CREATE_RE.test(n));
    if (apply) return { action: "click", name: apply, why: "apply" };
    if (names.some((n) => SUBMIT_RE.test(n))) return { action: "fill" };
    if (names.some((n) => /^sign in$/i.test(n))) return { action: "login" };
    return { action: "stuck" };
  }
  return { action: "fill" };
}

export function decideAdvance(names: string[]): AdvanceDecision {
  const clean = names.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  const next = clean.find((n) => NEXT_RE.test(n));
  if (next) return { action: "click", name: next, why: "next" };
  if (clean.some((n) => SUBMIT_RE.test(n))) return { action: "review" };
  return { action: "stuck" };
}

/** A model-proposed click is used only when that exact control is on the page and it is not a submit/account/sign-in control. */
export function safeClickName(name: string, allowed: string[]): string | null {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n || !allowed.some((a) => a.replace(/\s+/g, " ").trim() === n)) return null;
  if (BLOCKED_RE.test(n) || SUBMIT_RE.test(n) || CREATE_RE.test(n)) return null;
  return n;
}

const ADD_WORK = /^add (another )?(employment|work)( history| experience)?$/i;
const ADD_EDU = /^add (another )?(education|school)( history)?$/i;

export function addPanelButton(names: string[], group: "work" | "education"): string | null {
  const re = group === "work" ? ADD_WORK : ADD_EDU;
  return names.map((n) => n.replace(/\s+/g, " ").trim()).find((n) => re.test(n)) ?? null;
}

export function panelCount(fields: { group?: string | null; groupIndex?: number | null }[], group: string): number {
  return new Set(fields.filter((f) => f.group === group && f.groupIndex != null).map((f) => f.groupIndex)).size;
}

/** Reads button names and field labels. Values are not included. */
export const PAGE_CONTROLS = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const names = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (!vis(el)) continue;
    const n = clean(el.getAttribute('aria-label') || el.innerText);
    if (n && n.length < 180 && !names.includes(n)) names.push(n);
  }
  let applicationFields = 0;
  let applicantFields = 0;
  const labels = [];
  // Page chrome is not an application: header / navigation / footer / site search / cookie banners.
  const chrome = (el) => !!el.closest('header, nav, footer, [role="search"], [role="navigation"], [role="banner"], [role="contentinfo"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i], [class*="newsletter" i]');
  const APPLICANT = /(first|last|given|family|full|legal)[ _-]?name|^name$|e-?mail|phone|mobile|resume|cv\b|curriculum|cover letter|address|postal|zip|city|linkedin|country/i;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'password', 'search'].includes(t)) continue;
    if (el.id === 'lang-select' || el.name === 'g-recaptcha-response') continue;
    if (!vis(el) && t !== 'file') continue;
    if (chrome(el)) continue;
    applicationFields++;
    let label = '';
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) label = clean(l.innerText);
    }
    if (!label) label = clean(el.getAttribute('aria-label') || '');
    if (label) labels.push(label.slice(0, 160));
    if (APPLICANT.test([label, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), t === 'file' ? 'resume' : ''].join(' '))) applicantFields++;
  }
  const frames = [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { src: f.src || '', area: (r.width * r.height) / Math.max(1, innerWidth * innerHeight) }; }).filter((f) => /^https?:/.test(f.src) && f.area > 0.25);
  return { names, applicationFields, applicantFields, labels: labels.slice(0, 40), frames };
})()`;
