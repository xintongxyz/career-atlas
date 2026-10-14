import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Error with a stable machine-readable `code`. The client maps codes to
 * localized messages; `message` is an English fallback and never contains
 * internal details (stack traces, SQL, upstream bodies).
 */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const badRequest = (code: string, message?: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const conflict = (code: string, message?: string, details?: unknown) =>
  new ApiError(409, code, message, details);
