// Optional AI help for unfamiliar option lists (owner opt-in: Settings → "Use Claude to match
// unclear options"; requires the local Claude Code integration with subscription sign-in).
//
// Only used after the deterministic matchers (src/shared/apply-match.ts) found no unambiguous
// option. Claude receives ONE value (a skill, a field of study, a language or a school name) and the
// option labels the employer's site showed — nothing else from My Profile, no resume, no passwords or
// codes — and may only say which option means exactly the same thing, or none. The answer is checked
// against the list; Claude never supplies applicant facts (degrees, authorization, identity, …).
import type { AppEnv } from "../../server/env";

export type AssistPurpose = "skill" | "field_of_study" | "language" | "school";

const SCHEMA = {
  type: "object",
  properties: { choice: { type: ["string", "null"], description: "The exact option text that means the same as the value, or null." } },
  required: ["choice"],
  additionalProperties: false,
};

const SYSTEM = `You match one value to a list of options from a job application form.
Return the option whose meaning is EXACTLY the same as the value (same skill, same academic field, same language, same institution — e.g. a vendor prefix, an abbreviation, a translation or an official alternative name).
Return null when no option is the same thing, when several could be, or when you are unsure. A broader, narrower or merely related option is NOT the same thing (Excel ≠ Excel VBA, Statistics ≠ Biostatistics, Economics and Statistics ≠ Economics).
Copy the chosen option text exactly. Do not add anything else.`;

export function aiOptionMatcher(env: AppEnv) {
  return async (purpose: AssistPurpose, value: string, options: string[]): Promise<string | null> => {
    const provider = env.AI_LOCAL;
    if (!provider || env.AI_PROVIDER !== "claude_code") return null;
    const list = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, 200);
    if (!list.length || !value.trim()) return null;
    try {
      const out = (await provider.completeJson({ system: SYSTEM, user: JSON.stringify({ purpose, value: value.slice(0, 200), options: list.map((o) => o.slice(0, 200)) }), jsonSchema: SCHEMA, maxTokens: 200 })) as { choice?: unknown };
      const choice = typeof out?.choice === "string" ? out.choice.trim() : null;
      return choice && list.includes(choice) ? choice : null;
    } catch {
      return null; // AI is a fallback: unavailable → the deterministic outcome stands
    }
  };
}
