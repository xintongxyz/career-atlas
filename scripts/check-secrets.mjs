#!/usr/bin/env node
// Lightweight pre-commit / CI secret & personal-data scan over tracked files.
// CI additionally runs gitleaks over the full history (see .github/workflows/ci.yml).
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const staged = process.argv.includes("--staged");
const files = (staged ? execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" }) : execSync("git ls-files -co --exclude-standard", { encoding: "utf8" }))
  .split("\n")
  .filter(Boolean);
// Files that may only ever exist locally (personal data, backups, credentials, deploy values).
const FORBIDDEN_FILES = [
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.env$/,
  /\.env\.(?!example$)/,
  /\.sqlite3?$/,
  /\.db$/,
  /^(?!migrations\/).*\.sql$/, // SQL dumps (only migrations may be committed)
  /\.enc$/,
  /(^|\/)backups?\//,
  /CareerAtlasBackups/,
  /(^|\/)\.deploy\//,
  /wrangler\.deploy\.jsonc$/,
  /career-atlas-export-.*\.json$/,
  /career-atlas-jobs-.*\.csv$/,
  /manifest\.json$/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)\.wrangler\//,
];
const PATTERNS = [
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["Cloudflare API token assignment", /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/],
  ["secret assignment", /\b(AI_API_KEY|API_KEY|SECRET|PASSWORD)\s*=\s*["']?[A-Za-z0-9_\-]{16,}/],
];
// Emails are allowed only on reserved example domains or well-known no-reply addresses.
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const ALLOWED_EMAIL = /@(example\.(com|org|net|test)|.*\.example(\.(com|org|net|test))?|users\.noreply\.github\.com|anthropic\.com)$|^noreply@|^git@github\.com$/i;
const SKIP = [/^node_modules\//, /^package-lock\.json$/, /^migrations\/meta\//, /\.(png|jpg|jpeg|gif|ico|woff2?)$/, /^scripts\/check-secrets\.mjs$/];

let problems = 0;
for (const f of files) {
  if (FORBIDDEN_FILES.some((r) => r.test(f))) {
    console.error(`✗ forbidden file is tracked or untracked-but-not-ignored: ${f}`);
    problems++;
    continue;
  }
  if (SKIP.some((r) => r.test(f))) continue;
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) {
      console.error(`✗ possible ${name} in ${f}`);
      problems++;
    }
  }
  // Personal deployment identifiers (any real hosted instance or Zero Trust team) never belong in the repo.
  for (const m of text.matchAll(/\b([a-z0-9-]+\.)+(workers\.dev|cloudflareaccess\.com)\b/gi)) {
    if (!/(^|\.)example\./i.test(m[0])) {
      console.error(`✗ deployment hostname in ${f}: ${m[0].replace(/^([^.]{2})[^.]*/, "$1***")}`);
      problems++;
    }
  }
  for (const m of text.matchAll(EMAIL)) {
    if (!ALLOWED_EMAIL.test(m[0])) {
      console.error(`✗ non-example email address in ${f}: ${m[0].replace(/(.{2}).*(@.*)/, "$1***$2")}`);
      problems++;
    }
  }
}
if (problems) {
  console.error(`\n${problems} problem(s) found. Remove secrets/personal data, rotate anything that was exposed.`);
  process.exit(1);
}
console.log(`✓ no secrets or personal emails found in ${files.length} files`);
