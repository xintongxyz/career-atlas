import { LIMITS } from "@shared/constants";
import { isBlockedHostname, isIpLiteral, isPrivateAddress } from "./ip";
import { nodeResolver, publicFetch } from "./net";

export class FetchError extends Error {
  constructor(
    public code:
      | "invalid_url"
      | "blocked_destination"
      | "dns_failed"
      | "timeout"
      | "too_many_redirects"
      | "too_large"
      | "unsupported_content_type"
      | "http_error"
      | "network_error",
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
  }
}

export type Resolver = (host: string) => Promise<string[]>;


const ALLOWED_TYPES = ["text/html", "application/xhtml+xml", "application/json", "application/ld+json", "text/plain", "application/xml", "text/xml"];

export interface SafeFetchOptions {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
  redirects: number;
}

/** Validates a URL as a public HTTP(S) destination. Throws FetchError otherwise. */
export async function assertPublicUrl(raw: string, resolver: Resolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("invalid_url", "Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("invalid_url", "Only http(s) URLs are allowed");
  if (u.username || u.password) throw new FetchError("blocked_destination", "Credentials in URL are not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new FetchError("blocked_destination", "Non-standard ports are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) throw new FetchError("blocked_destination", "Private address");
    return u;
  }
  if (isBlockedHostname(host)) throw new FetchError("blocked_destination", "Blocked hostname");
  let ips: string[];
  try {
    ips = await resolver(host);
  } catch {
    throw new FetchError("dns_failed", "DNS lookup failed", undefined, true);
  }
  if (!ips.length) throw new FetchError("dns_failed", "Host does not resolve");
  if (ips.some(isPrivateAddress)) throw new FetchError("blocked_destination", "Host resolves to a private address");
  return u;
}

/**
 * SSRF-hardened fetch for user-supplied URLs:
 * http(s) only, default ports only, no private/loopback/link-local/metadata
 * destinations (checked on the literal host and on DNS answers, IPv4 + IPv6),
 * manual redirects re-validated at every hop, timeouts, size and type limits.
 * The default fetch additionally re-checks the resolved address at connect time (./net.ts).
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const resolver = opts.resolver ?? nodeResolver;
  const doFetch = opts.fetchImpl ?? publicFetch;
  const maxRedirects = opts.maxRedirects ?? LIMITS.fetchMaxRedirects;
  const maxBytes = opts.maxBytes ?? LIMITS.fetchMaxBytes;
  const deadline = Date.now() + (opts.timeoutMs ?? LIMITS.fetchTimeoutMs);
  let current = raw;
  let method = opts.method ?? "GET";
  let body = opts.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, resolver);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError("timeout", "Request timed out", undefined, true);
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; CareerAtlas/1.0; personal job tracker; +https://github.com/)",
          accept: opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
          "accept-language": "en,zh-CN;q=0.8",
          ...opts.headers,
        },
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new FetchError("timeout", "Request timed out", undefined, true);
      throw new FetchError("network_error", "Network error", undefined, true);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, url).toString();
      if (res.status === 303) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      await res.body?.cancel();
      throw new FetchError("http_error", `HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500);
    }
    if (contentType && !ALLOWED_TYPES.some((t) => contentType.startsWith(t))) {
      await res.body?.cancel();
      throw new FetchError("unsupported_content_type", "Unsupported content type");
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new FetchError("too_large", "Response too large");
    }
    const text = await readCapped(res, maxBytes);
    return { status: res.status, finalUrl: url.toString(), contentType, text, redirects: hop };
  }
  throw new FetchError("too_many_redirects", "Too many redirects");
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError("too_large", "Response too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}
