import type { ApiErrorBody } from "@shared/types";
import { Hono, type Context } from "hono";
import type { ZodType } from "zod";
import { AuthError, getAuthProvider } from "./auth";
import { getDb } from "./db/client";
import type { HonoEnv } from "./env";
import { ApiError } from "./lib/errors";
import { registerDraftRoutes } from "./routes/drafts";
import { registerProfileRoutes } from "./routes/profile";
import { registerJobRoutes } from "./routes/jobs";
import { registerMiscRoutes } from "./routes/misc";
import { ensureUser } from "./services/users";

/** Removes anything that could contain user data from a log line (SQL text, params, quoted strings). */
export function scrubLogText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/Failed query:[\s\S]*/i, "Failed query: [redacted]")
    .replace(/params:[\s\S]*/i, "params: [redacted]")
    .replace(/'[^']*'|"[^"]*"/g, "[redacted]")
    .slice(0, 160);
}

export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError(
      422,
      "validation_failed",
      "Invalid input",
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
    );
  }
  return r.data;
}

export async function jsonBody<T>(c: Context<HonoEnv>, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be JSON");
  }
  return parseBody(schema, data);
}

export function queryParams<T>(c: Context<HonoEnv>, schema: ZodType<T>): T {
  return parseBody(schema, c.req.query());
}

export const dbOf = (c: Context<HonoEnv>) => getDb(c.env.DB);
export const userOf = (c: Context<HonoEnv>) => c.get("user");

/** `extend` registers runtime-specific routes (e.g. local backups) behind the same CSRF + auth middleware. */
export function createApp(extend?: (app: Hono<HonoEnv>) => void) {
  const app = new Hono<HonoEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    c.header("x-request-id", c.get("requestId"));
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    if (!c.res.headers.get("x-frame-options")) c.header("x-frame-options", "DENY");
    if (!c.res.headers.get("cache-control")) c.header("cache-control", "no-store");
  });

  // Public, data-free liveness probe.
  app.get("/api/health", (c) => c.json({ ok: true }));

  // CSRF: state-changing requests must come from this origin.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      const self = new URL(c.req.url).origin;
      const site = c.req.header("sec-fetch-site");
      if (origin ? origin !== self : site !== undefined && site !== "same-origin") {
        throw new ApiError(403, "csrf_rejected", "Cross-site request rejected");
      }
      // Only requests that actually carry content need a JSON/multipart type. Body-less writes
      // (e.g. DELETE) may arrive with an empty body stream and `Content-Length: 0`.
      const type = c.req.header("content-type") ?? "";
      const length = c.req.header("content-length");
      const hasContent = length !== undefined ? Number(length) > 0 : !!c.req.header("transfer-encoding") || (!!c.req.raw.body && !!type);
      if (hasContent && !type.startsWith("application/json") && !type.startsWith("multipart/form-data")) {
        throw new ApiError(415, "unsupported_media_type", "Unsupported content type");
      }
    }
    await next();
  });

  // Authentication (every /api route below this line is private).
  app.use("/api/*", async (c, next) => {
    const provider = getAuthProvider(c.env);
    const identity = await provider.authenticate(c.req.raw, c.env);
    const user = await ensureUser(getDb(c.env.DB), identity.email);
    c.set("user", user);
    // Read-only maintenance: data is being backed up or transferred — reject every write.
    if (c.env.MAINTENANCE_MODE === "read_only" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      throw new ApiError(503, "maintenance_read_only", "Career Atlas is temporarily read-only");
    }
    await next();
  });

  registerJobRoutes(app);
  registerMiscRoutes(app);
  registerDraftRoutes(app);
  registerProfileRoutes(app);
  extend?.(app);

  app.all("/api/*", () => {
    throw new ApiError(404, "not_found", "Unknown API route");
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    let status = 500;
    let body: ApiErrorBody["error"] = { code: "internal_error", message: "Something went wrong", request_id: requestId };
    if (err instanceof ApiError) {
      status = err.status;
      body = { code: err.code, message: err.message, details: err.details, request_id: requestId };
    } else if (err instanceof AuthError) {
      status = err.code === "unauthenticated" ? 401 : err.code === "forbidden" ? 403 : 503;
      body = { code: err.code, message: err.code === "auth_misconfigured" ? "Authentication is not configured for this deployment" : err.message, request_id: requestId };
    } else {
      // Log only the error class and a scrubbed message — never request bodies, SQL parameters,
      // job descriptions, notes, files or tokens.
      console.error(JSON.stringify({ level: "error", request_id: requestId, method: c.req.method, route: c.req.routePath, error: (err as Error)?.name, message: scrubLogText((err as Error)?.message), cause: scrubLogText(String((err as { cause?: unknown })?.cause ?? "")) }));
    }
    return c.json({ error: body } satisfies ApiErrorBody, status as 500);
  });

  return app;
}
