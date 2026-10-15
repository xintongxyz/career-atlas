// Asks the local Codex CLI (ChatGPT sign-in) for one decision.
// The prompt contains labels, button names and boolean facts — never profile values,
// resume text, passwords or verification codes. The caller checks the answer against
// the list it supplied and refuses Submit / account creation.

import type { AiProvider } from "../../server/ai/provider";

export interface PublicFacts {
  has_email: boolean;
  has_phone: boolean;
  phone_type: "mobile" | "home" | "work" | null;
  job_source: string | null;
}

const CLICK_SCHEMA = {
  type: "object",
  properties: { click: { type: ["string", "null"], description: "Exact button or link name to press, or null." } },
  required: ["click"],
  additionalProperties: false,
};

const CHOICE_SCHEMA = {
  type: "object",
  properties: { choice: { type: ["string", "null"], description: "Exact option text, or null." } },
  required: ["choice"],
  additionalProperties: false,
};

const CLICK_SYSTEM = `You help fill a job application by choosing the next control to activate.
You receive the visible button and link names and the field labels. You do not receive the applicant's answers.
Return the exact name of one control that moves the application forward (Apply, Apply without an account, Next, Continue) or dismisses a cookie banner.
Return null when you are unsure, when the page is already a form to be filled, or when the only remaining controls submit the application, create an account, sign in, cancel or delete.
Never choose Submit, Sign in, Create account, or Cancel.`;

const CHOICE_SYSTEM = `You match one job-application question to one of the listed options.
You receive the question, the options, and a few facts: whether an email exists, whether a phone exists, the phone type if the person set one, and where this job was saved from.
Return the exact option text only when those facts make one option certainly correct.
Return null when several options could be right, when none is, or when you are unsure. Do not invent an answer. Do not return anything that is not in the option list.`;

export async function reasonClick(provider: AiProvider, obs: { buttons: string[]; labels: string[] }): Promise<string | null> {
  const buttons = [...new Set(obs.buttons.map((b) => b.trim()).filter(Boolean))].slice(0, 40);
  if (!buttons.length) return null;
  try {
    const out = (await provider.completeJson({
      system: CLICK_SYSTEM,
      user: JSON.stringify({ buttons, labels: obs.labels.slice(0, 40) }),
      jsonSchema: CLICK_SCHEMA,
      maxTokens: 120,
    })) as { click?: unknown };
    return typeof out?.click === "string" ? out.click.trim() : null;
  } catch {
    return null;
  }
}

export async function chooseFromFacts(provider: AiProvider, label: string, options: string[], facts: PublicFacts): Promise<string | null> {
  const list = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, 80);
  if (!list.length || !label.trim()) return null;
  try {
    const out = (await provider.completeJson({
      system: CHOICE_SYSTEM,
      user: JSON.stringify({ question: label.slice(0, 300), options: list.map((o) => o.slice(0, 200)), facts }),
      jsonSchema: CHOICE_SCHEMA,
      maxTokens: 120,
    })) as { choice?: unknown };
    const choice = typeof out?.choice === "string" ? out.choice.trim() : null;
    return choice && list.includes(choice) ? choice : null;
  } catch {
    return null;
  }
}
