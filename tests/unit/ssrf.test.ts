import { describe, expect, it } from "vitest";
import { isBlockedHostname, isPrivateIPv4, isPrivateIPv6 } from "../../src/server/extraction/ip";
import { assertPublicUrl, FetchError, safeFetch } from "../../src/server/extraction/safe-fetch";

const publicResolver = async () => ["93.184.216.34"];

describe("IP classification", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"])("%s is private", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34"])("%s is public", (ip) => expect(isPrivateIPv4(ip)).toBe(false));
  it.each(["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "ff02::1", "2001:db8::1", "[::1]"])("%s is private v6", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });
  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])("%s is public v6", (ip) => expect(isPrivateIPv6(ip)).toBe(false));
  it("blocks internal hostnames", () => {
    for (const h of ["localhost", "foo.localhost", "metadata.google.internal", "printer.local", "intranet", "db.internal"]) expect(isBlockedHostname(h)).toBe(true);
    expect(isBlockedHostname("boards.greenhouse.io")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  const bad = ["ftp://example.com/x", "file:///etc/passwd", "http://127.0.0.1/", "http://[::1]/", "http://0x7f000001/", "http://2130706433/", "http://169.254.169.254/latest/meta-data", "http://localhost:8080/", "https://example.com:8443/", "http://user:pass@example.com/"];
  it.each(bad)("rejects %s", async (u) => {
    await expect(assertPublicUrl(u, publicResolver)).rejects.toBeInstanceOf(FetchError);
  });
  it("rejects hostnames that resolve to private addresses (DNS check, v4 and v6)", async () => {
    await expect(assertPublicUrl("https://evil.example.com/", async () => ["10.0.0.5"])).rejects.toMatchObject({ code: "blocked_destination" });
    await expect(assertPublicUrl("https://evil.example.com/", async () => ["93.184.216.34", "fd00::1"])).rejects.toMatchObject({ code: "blocked_destination" });
  });
  it("accepts public destinations", async () => {
    await expect(assertPublicUrl("https://jobs.lever.co/acme/123", publicResolver)).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  it("re-validates every redirect hop", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.startsWith("https://public.example.com")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      return new Response("secret");
    }) as unknown as typeof fetch;
    await expect(safeFetch("https://public.example.com/job", { resolver: publicResolver, fetchImpl })).rejects.toMatchObject({ code: "blocked_destination" });
  });
  it("limits redirects", async () => {
    let n = 0;
    const fetchImpl = (async () => new Response(null, { status: 301, headers: { location: `https://public.example.com/${++n}` } })) as unknown as typeof fetch;
    await expect(safeFetch("https://public.example.com/0", { resolver: publicResolver, fetchImpl, maxRedirects: 3 })).rejects.toMatchObject({ code: "too_many_redirects" });
  });
  it("limits response size", async () => {
    const fetchImpl = (async () => new Response("x".repeat(5000), { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(safeFetch("https://public.example.com/", { resolver: publicResolver, fetchImpl, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });
  it("rejects unexpected content types", async () => {
    const fetchImpl = (async () => new Response("binary", { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
    await expect(safeFetch("https://public.example.com/", { resolver: publicResolver, fetchImpl })).rejects.toMatchObject({ code: "unsupported_content_type" });
  });
  it("marks 5xx and 429 as retryable but not 403", async () => {
    const mk = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;
    await expect(safeFetch("https://public.example.com/", { resolver: publicResolver, fetchImpl: mk(503) })).rejects.toMatchObject({ retryable: true });
    await expect(safeFetch("https://public.example.com/", { resolver: publicResolver, fetchImpl: mk(429) })).rejects.toMatchObject({ retryable: true });
    await expect(safeFetch("https://public.example.com/", { resolver: publicResolver, fetchImpl: mk(403) })).rejects.toMatchObject({ retryable: false, status: 403 });
  });
});
