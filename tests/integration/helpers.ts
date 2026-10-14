import { SELF } from "./harness";

export const BASE = "http://localhost";

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", BASE);
  const res = await SELF.fetch(`${BASE}${path}`, { ...init, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export const manualJob = (overrides: Record<string, unknown> = {}) => ({
  job: {
    company_name: "Northwind Analytics",
    company_website: overrides.company_name ? null : "https://northwind.example.com",
    title: "Data Analyst",
    city: "Toronto",
    region: "ON",
    country: "Canada",
    work_mode: "hybrid",
    employment_type: "full_time",
    salary: { min: 70000, max: 85000, currency: "CAD", period: "annually", source: "employer", text: "$70,000–$85,000 CAD per year" },
    ...overrides,
  },
});

export async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
