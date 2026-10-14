// Network access for URL import in the local runtime.
//
// The server runs on the owner's computer, next to their router, printers and local services, so
// URL import is locked down: every connection is checked AT CONNECT TIME against the resolved
// address (no DNS rebinding between the check and the request), in addition to safeFetch's
// URL checks.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { promises as dns } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { isPrivateAddress } from "./ip";
import type { Resolver } from "./safe-fetch";

export const nodeResolver: Resolver = async (host) => {
  const res = await dns.lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that refuses private, loopback, link-local and metadata addresses. */
export function publicOnlyLookup(hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb) {
  const opts = typeof options === "number" ? { family: options } : (options ?? {});
  dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, "");
    const list = addresses as LookupAddress[];
    const blocked = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || blocked) {
      const e = new Error("Blocked destination: resolves to a private address") as NodeJS.ErrnoException;
      e.code = "EBLOCKED";
      return cb(e, "");
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: publicOnlyLookup as never }, connections: 8 });

/** fetch() that can only reach public addresses. Proxy environment variables are ignored. */
export const publicFetch: typeof fetch = ((input: string | URL, init?: RequestInit) =>
  undiciFetch(input as string, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
