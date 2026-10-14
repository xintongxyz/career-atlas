import type { AppEnv } from "../env";

export interface AiCompletionRequest {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * Pluggable model backend. Implementations return the raw model output
 * (parsed JSON when possible). Callers MUST validate the output — it is
 * untrusted data, never instructions or code.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  completeJson(req: AiCompletionRequest): Promise<unknown>;
}

export class AiError extends Error {
  constructor(
    public code: "ai_not_configured" | "ai_failed" | "ai_invalid_output",
    message: string,
  ) {
    super(message);
  }
}

/** Returns the configured provider, or null when AI is disabled / unavailable. */
export function getAiProvider(env: AppEnv): AiProvider | null {
  return env.AI_PROVIDER === "claude_code" ? (env.AI_LOCAL ?? null) : null;
}

export function parseJsonLoose(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") throw new AiError("ai_invalid_output", "Empty model output");
  const s = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new AiError("ai_invalid_output", "Model output is not JSON");
  }
}
