import type { CandidateSet } from "../jsonld";
import type { PlatformInfo } from "../platforms";

export interface AdapterResult {
  adapter: string;
  fields: CandidateSet;
  descriptionText: string | null;
  sourceTitle: string | null;
  structured: unknown;
  apiUrl: string;
  /** The public API reports the posting no longer exists. */
  closed?: boolean;
}

/** Fetches JSON through the SSRF-safe fetcher; returns null on 404. */
export type JsonFetcher = (url: string) => Promise<unknown | null>;

export interface Adapter {
  name: string;
  matches(info: PlatformInfo): boolean;
  fetch(info: PlatformInfo, fetchJson: JsonFetcher): Promise<AdapterResult | null>;
}
