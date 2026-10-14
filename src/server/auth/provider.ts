import type { AppEnv } from "../env";

export interface AuthIdentity {
  email: string;
  /** Provider-specific subject, kept for future multi-user support. */
  subject?: string;
}

/**
 * Interchangeable authentication backend. Implementations must verify the
 * request cryptographically (or be restricted to local development) and must
 * never trust identifiers sent by the browser.
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(req: Request, env: AppEnv): Promise<AuthIdentity>;
}

export class AuthError extends Error {
  constructor(
    public code: "unauthenticated" | "forbidden" | "auth_misconfigured",
    message: string,
  ) {
    super(message);
  }
}
