import type { AppEnv } from "../env";
import { localProvider } from "./local";
import { AuthError, type AuthProvider } from "./provider";

export function getAuthProvider(env: AppEnv): AuthProvider {
  if (env.AUTH_MODE === "local") return localProvider;
  throw new AuthError("auth_misconfigured", "Unknown AUTH_MODE");
}

export { AuthError };
