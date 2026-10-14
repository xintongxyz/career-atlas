import type { ExtractionStatus } from "@shared/constants";
import type { ExtractionResult } from "@shared/types";
import { aiExtract } from "../ai/extract-job";
import type { AiProvider } from "../ai/provider";
import { ADAPTERS, type AdapterResult, type JsonFetcher } from "./adapters";
import { heuristicExtract, extractTitleGuess } from "./heuristics";
import { detectAccessProblem, extractJsonLd, extractMeta, findJobPosting, htmlToText } from "./html";
import { cand, jobPostingToCandidates, type CandidateSet } from "./jsonld";
import { decideOutcome, mergeCandidates } from "./merge";
import { companyHintFromUrl, detectPlatform } from "./platforms";
import { FetchError, safeFetch, type SafeFetchOptions, type SafeFetchResult } from "./safe-fetch";

/** Platforms whose terms prohibit automated access or that require login. We never fetch them. */
const RESTRICTED_PLATFORMS = new Set(["linkedin", "indeed"]);
const RESTRICTED_HOSTS = [/(^|\.)glassdoor\./, /(^|\.)ziprecruiter\./, /(^|\.)monster\./];

export interface PipelineDeps {
  fetchPage: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  ai: AiProvider | null;
}

export interface PipelineInput {
  inputType: "url" | "text";
  url: string | null;
  text: string | null;
}

export interface SnapshotData {
  method: "ats_api" | "html" | "pasted_text";
  requestedUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  title: string | null;
  text: string;
  structuredData: unknown;
}

export interface PipelineOutput {
  status: Exclude<ExtractionStatus, "none" | "queued" | "fetching" | "extracting">;
  adapter: string | null;
  result: ExtractionResult | null;
  snapshot: SnapshotData | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Transient failure: the queue should retry. */
  retryable: boolean;
}

export const defaultDeps = (ai: AiProvider | null): PipelineDeps => ({ fetchPage: (u, o) => safeFetch(u, o), ai });

function fail(status: PipelineOutput["status"], code: string, message: string, retryable = false): PipelineOutput {
  return { status, adapter: null, result: null, snapshot: null, errorCode: code, errorMessage: message, retryable };
}

function jsonFetcher(deps: PipelineDeps): JsonFetcher {
  return async (url) => {
    try {
      const res = await deps.fetchPage(url, { accept: "application/json" });
      return JSON.parse(res.text);
    } catch (e) {
      if (e instanceof FetchError && e.code === "http_error" && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  };
}

/**
 * Turns a URL or pasted text into reviewed-later candidate fields.
 * Order: public ATS API → JSON-LD → HTML meta + text → heuristics → AI (if configured).
 */
export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineOutput> {
  const sets: CandidateSet[] = [];
  const warnings: string[] = [];
  let descriptionText: string | null = null;
  let sourceTitle: string | null = null;
  let adapterName: string | null = null;
  let snapshot: SnapshotData | null = null;
  let closed = false;

  if (input.inputType === "text") {
    const text = (input.text ?? "").trim();
    if (text.length < 40) return fail("failed", "insufficient_content", "Pasted text is too short");
    descriptionText = text;
    snapshot = { method: "pasted_text", requestedUrl: input.url, finalUrl: input.url, httpStatus: null, contentType: "text/plain", title: null, text, structuredData: null };
    adapterName = "pasted_text";
    sets.push(extractTitleGuess(text));
  } else {
    const url = input.url!;
    let info;
    try {
      info = detectPlatform(url);
    } catch {
      return fail("failed", "invalid_url", "Invalid URL");
    }
    const host = new URL(url).hostname.toLowerCase();
    if (RESTRICTED_PLATFORMS.has(info.platform) || RESTRICTED_HOSTS.some((r) => r.test(host))) {
      return fail(
        "access_restricted",
        "platform_restricted",
        "This site requires sign-in or does not allow automated access. The link is saved — paste the job description to extract details.",
      );
    }

    // 1. Public ATS posting APIs
    const adapter = ADAPTERS.find((a) => a.matches(info));
    let adapterResult: AdapterResult | null = null;
    if (adapter) {
      try {
        adapterResult = await adapter.fetch(info, jsonFetcher(deps));
      } catch (e) {
        if (e instanceof FetchError && e.retryable) return fail("failed", e.code, e.message, true);
        warnings.push(`adapter_failed:${adapter.name}`);
      }
    }
    if (adapterResult) {
      adapterName = adapterResult.adapter;
      closed = !!adapterResult.closed;
      sets.push(adapterResult.fields);
      descriptionText = adapterResult.descriptionText;
      sourceTitle = adapterResult.sourceTitle;
      if (descriptionText) {
        snapshot = { method: "ats_api", requestedUrl: url, finalUrl: adapterResult.apiUrl, httpStatus: 200, contentType: "application/json", title: sourceTitle, text: descriptionText, structuredData: adapterResult.structured };
      }
    }

    // 2–4. Fetch the page itself when the API gave no description.
    if (!descriptionText && !closed) {
      let page: SafeFetchResult;
      try {
        page = await deps.fetchPage(url);
      } catch (e) {
        if (e instanceof FetchError) {
          if (e.code === "blocked_destination" || e.code === "invalid_url") return fail("failed", e.code, "This address is not allowed (private or invalid destination).");
          if (e.code === "http_error" && (e.status === 401 || e.status === 403 || e.status === 407 || e.status === 999)) {
            return fail("access_restricted", "http_forbidden", `The site refused access (HTTP ${e.status}). Paste the job description instead.`);
          }
          if (e.code === "http_error" && (e.status === 404 || e.status === 410)) {
            return {
              ...fail("failed", "not_found", "The page was not found. The posting may have been removed."),
              result: { fields: { posting_status: cand("closed", "html_meta", `HTTP ${e.status}`, "medium") }, description_text: null, source_title: null, warnings, ai_used: false },
            };
          }
          return fail("failed", e.code, e.message, e.retryable);
        }
        return fail("failed", "network_error", "Could not fetch the page", true);
      }
      const isJson = page.contentType.includes("json");
      const html = isJson ? "" : page.text;
      const jsonLdNodes = isJson ? [] : extractJsonLd(html);
      const jp = findJobPosting(jsonLdNodes);
      const meta = isJson ? {} : extractMeta(html);
      const pageText = isJson ? "" : htmlToText(html, { mainOnly: true });
      if (jp) {
        const mapped = jobPostingToCandidates(jp);
        sets.push(mapped.fields);
        descriptionText = mapped.descriptionText;
      }
      if (!descriptionText) {
        const problem = detectAccessProblem(html, pageText);
        if (problem === "bot_protection" || problem === "login_required") {
          return fail("access_restricted", problem, problem === "bot_protection" ? "The site uses bot protection. Paste the job description instead." : "The site requires sign-in. Paste the job description instead.");
        }
        if (problem === "dynamic_content" || pageText.length < 200) {
          return fail("failed", "dynamic_content", "The page content is loaded by JavaScript and could not be read. Paste the job description instead.");
        }
        descriptionText = pageText;
      }
      sourceTitle = meta["og:title"] ?? meta["html:title"] ?? null;
      const metaSet: CandidateSet = {};
      if (sourceTitle) metaSet.title = cand(sourceTitle.split(/\s[|–-]\s/)[0].trim(), "html_meta", `<title>: ${sourceTitle}`, "low");
      if (meta["og:site_name"]) metaSet.company_name = cand(meta["og:site_name"], "html_meta", `og:site_name: ${meta["og:site_name"]}`, "low");
      sets.push(metaSet);
      if (!adapterName) adapterName = jp ? "json_ld" : "html";
      snapshot = {
        method: "html",
        requestedUrl: url,
        finalUrl: page.finalUrl,
        httpStatus: page.status,
        contentType: page.contentType,
        title: sourceTitle,
        text: descriptionText,
        structuredData: jp ?? null,
      };
    }
    const hint = companyHintFromUrl(url);
    if (hint) sets.push({ company_name: cand(hint, "html_meta", `URL: ${new URL(url).hostname}${new URL(url).pathname.split("/").slice(0, 2).join("/")}`, "low") });
  }

  // 5. Heuristics over the description text (always available, no AI needed)
  if (descriptionText) sets.push(heuristicExtract(descriptionText));

  // 6. AI over the reliable text (optional). Its output is verified against the source.
  let aiUsed = false;
  if (deps.ai && descriptionText && descriptionText.length >= 200) {
    try {
      const ai = await aiExtract(deps.ai, descriptionText, input.url);
      sets.push(ai.fields);
      warnings.push(...ai.warnings);
      aiUsed = true;
    } catch {
      warnings.push("ai_failed");
    }
  }

  const fields = mergeCandidates(sets);
  if (closed && !fields.posting_status) fields.posting_status = { ...cand("closed", "ats_api", "Posting no longer listed", "medium") };
  const result: ExtractionResult = { fields, description_text: descriptionText, source_title: sourceTitle, warnings, ai_used: aiUsed };
  if (closed && !descriptionText) {
    return { status: "partial", adapter: adapterName, result, snapshot, errorCode: "posting_closed", errorMessage: "The job board reports this posting is no longer available.", retryable: false };
  }
  if (!descriptionText && Object.keys(fields).length === 0) return fail("failed", "no_content", "No job information could be extracted.");
  return { status: decideOutcome(result), adapter: adapterName, result, snapshot, errorCode: null, errorMessage: null, retryable: false };
}
