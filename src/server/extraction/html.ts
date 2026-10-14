// Dependency-free HTML helpers that run in Workers and in Node tests.
// They never execute or render markup; output is plain text only.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ocirc: "ô",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  laquo: "«",
  raquo: "»",
  shy: "",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return "";
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    const v = NAMED_ENTITIES[code.toLowerCase()];
    return v ?? m;
  });
}

const BLOCK_TAGS = "p|div|section|article|header|footer|main|aside|table|tr|ul|ol|dl|dt|dd|blockquote|pre|form|fieldset|figure|figcaption|address|details|summary";

/** Removes elements (with content) whose content is never job text. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|object|canvas|select|button|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|link|meta|input|img|source|track|embed)\b[^>]*\/?>/gi, " ");
}

function pickMainRegion(html: string): string {
  for (const tag of ["main", "article"]) {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>`, "i"));
    if (m && m[1].replace(/<[^>]+>/g, "").trim().length > 400) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  let region = body ? body[1] : html;
  // Page chrome rarely contains job content.
  region = region.replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi, " ");
  return region;
}

/**
 * Converts HTML to readable plain text while keeping structure:
 * headings and paragraphs become separate blocks, list items become "• " lines.
 */
export function htmlToText(html: string, opts: { mainOnly?: boolean } = {}): string {
  let s = stripNonContent(html);
  if (opts.mainOnly) s = pickMainRegion(s);
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]\s*>/gi, "\n")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return normalizeText(s);
}

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n• *\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parses every <script type="application/ld+json"> block, flattening @graph and arrays. */
export function extractJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        // Common breakage: raw control characters inside strings.
        parsed = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " "));
      } catch {
        continue;
      }
    }
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (Array.isArray(o["@graph"])) (o["@graph"] as unknown[]).forEach(visit);
        out.push(o);
      }
    };
    visit(parsed);
  }
  return out;
}

export function findJobPosting(nodes: Record<string, unknown>[]): Record<string, unknown> | null {
  return (
    nodes.find((n) => {
      const t = n["@type"];
      return t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"));
    }) ?? null
  );
}

export function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const re = /<meta\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const key = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = attrs.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content != null && !(key in meta)) meta[key] = decodeEntities(content).trim();
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) meta["html:title"] = decodeEntities(title.replace(/\s+/g, " ")).trim();
  const canonical = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0]?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
  if (canonical) meta["link:canonical"] = canonical;
  const lang = html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i)?.[1];
  if (lang) meta["html:lang"] = lang;
  return meta;
}

/** Signals that a page is a login wall, bot challenge, or JS-only shell. */
export function detectAccessProblem(html: string, text: string): "bot_protection" | "login_required" | "dynamic_content" | null {
  const h = html.slice(0, 200_000).toLowerCase();
  if (
    /cf-chl-|challenge-platform|g-recaptcha|h-captcha|hcaptcha\.com|px-captcha|captcha-delivery|are you a robot|verify you are (a )?human|access denied|request unsuccessful\. incapsula/.test(h) &&
    text.length < 3000
  ) {
    return "bot_protection";
  }
  if (/(sign in|log in|login) to (view|continue|see)|authwall|please log in/.test(h) && text.length < 2500) return "login_required";
  if (text.length < 250 && /<div id=["'](root|app|__next)["']|enable javascript|you need to enable javascript/.test(h)) return "dynamic_content";
  return null;
}
