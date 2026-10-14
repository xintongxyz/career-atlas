import type { AppEnv } from "../env";
import { AuthError, type AuthProvider } from "./provider";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Single-user local mode. The server listens on 127.0.0.1 only and rejects foreign Host/Origin
 * headers before the app runs (src/local/runtime.ts); this check is defence in depth.
 * The identity is the owner of the local database (LOCAL_USER_EMAIL), never browser-supplied.
 */
export const localProvider: AuthProvider = {
  name: "local",
  async authenticate(req: Request, env: AppEnv) {
    const host = new URL(req.url).hostname;
    if (!LOCAL_HOSTS.has(host)) throw new AuthError("auth_misconfigured", "Career Atlas only answers on localhost");
    const email = env.LOCAL_USER_EMAIL?.trim().toLowerCase();
    if (!email) throw new AuthError("auth_misconfigured", "Local owner is not configured");
    return { email, subject: "local" };
  },
};
