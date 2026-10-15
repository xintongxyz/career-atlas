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
}

export type NavDecision =
  | { action: "click"; name: string; why: "cookie" | "guest" | "apply" }
  | { action: "login" }
  | { action: "captcha" }
  | { action: "fill" }
  | { action: "stuck" };

export type AdvanceDecision = { action: "click"; name: string; why: "next" } | { action: "review" } | { action: "stuck" };

const SUBMIT_RE = /^(submit|submit( my)? application|send application)$/i;
const NEXT_RE = /^(next|continue|save and continue|save & continue|next step)$/i;
const GUEST_RE = /apply without an account|continue as guest|apply as guest/i;
const CREATE_RE = /create (an |one )?account|create one now|^sign up$|^register$/i;
const APPLY_RE = /^apply\b/i;
const COOKIE_RE = /^(reject|reject all|decline|decline all)$/i;
const BLOCKED_RE = /^(submit|send application|cancel|delete|remove|sign in|log in|create account|create one now|register|sign up)\b/i;

export function decideNavigation(obs: PageObservation, ctx: { password: boolean; challenge: boolean; cookieDismissed: boolean }): NavDecision {
  const names = obs.names.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (ctx.challenge) return { action: "captcha" };
  const cookie = names.find((n) => COOKIE_RE.test(n));
  if (cookie && !ctx.cookieDismissed) return { action: "click", name: cookie, why: "cookie" };
  // A password field is a sign-in or account form. Never type the profile into it and never create an account.
  if (ctx.password) return { action: "login" };
  const guest = names.find((n) => GUEST_RE.test(n));
  if (guest) return { action: "click", name: guest, why: "guest" };
  if (obs.applicationFields === 0) {
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
  const labels = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'password'].includes(t)) continue;
    if (el.id === 'lang-select' || el.name === 'g-recaptcha-response') continue;
    if (!vis(el) && t !== 'file') continue;
    applicationFields++;
    let label = '';
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) label = clean(l.innerText);
    }
    if (!label) label = clean(el.getAttribute('aria-label') || '');
    if (label) labels.push(label.slice(0, 160));
  }
  return { names, applicationFields, labels: labels.slice(0, 40) };
})()`;
