import type { ApiErrorBody } from "@shared/types";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    // keepalive lets a small write finish even if the tab is closed right after the change.
    const keepalive = method !== "GET" && (payload === undefined || (typeof payload === "string" && payload.length < 60_000));
    res = await fetch(path, { method, body: payload, headers, credentials: "same-origin", keepalive, ...init });
  } catch {
    throw new ApiRequestError(0, "network_error", "Network error");
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    if (type.includes("application/json")) {
      const err = (await res.json()) as ApiErrorBody;
      throw new ApiRequestError(res.status, err.error?.code ?? "unknown_error", err.error?.message ?? "Request failed", err.error?.details, err.error?.request_id);
    }
    // Non-JSON error pages (e.g. the local firewall) land here.
    throw new ApiRequestError(res.status, res.status === 401 || res.status === 403 ? "unauthenticated" : "unknown_error", `HTTP ${res.status}`);
  }
  if (!type.includes("application/json")) throw new ApiRequestError(res.status, "unauthenticated", "Unexpected response");
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form),
  /** Fetches a binary/text download (CSV, JSON, ICS) with the same auth & CSRF rules. */
  async download(path: string, init?: { method?: string; body?: unknown }): Promise<Blob> {
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      credentials: "same-origin",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) throw new ApiRequestError(res.status, "download_failed", `HTTP ${res.status}`);
    return res.blob();
  },
};

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
