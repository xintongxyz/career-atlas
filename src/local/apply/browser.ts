// Browser for application automation: Playwright driving Chromium, in its OWN profile folder
// (<data>/automation/browser-profile, owner-only). The user's everyday Chrome profile is never
// opened. Prefers Playwright's Chromium when installed, else the installed Google Chrome binary.
import { existsSync } from "node:fs";
import type { BrowserContext } from "playwright-core";

export interface BrowserChoice {
  available: boolean;
  /** "chromium" (Playwright build) or "chrome" (installed Google Chrome, separate profile). */
  browser: "chromium" | "chrome" | null;
  reason: string | null;
}

type Pw = typeof import("playwright-core");
let pw: Pw | null | undefined;

export async function loadPlaywright(): Promise<Pw | null> {
  if (pw !== undefined) return pw;
  try {
    pw = await import("playwright-core");
  } catch {
    pw = null;
  }
  return pw;
}

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
};

export async function chooseBrowser(): Promise<BrowserChoice> {
  const p = await loadPlaywright();
  if (!p) return { available: false, browser: null, reason: "playwright_missing" };
  try {
    if (existsSync(p.chromium.executablePath())) return { available: true, browser: "chromium", reason: null };
  } catch {
    /* no bundled Chromium */
  }
  if ((CHROME_PATHS[process.platform] ?? []).some((x) => existsSync(x))) return { available: true, browser: "chrome", reason: null };
  return { available: false, browser: null, reason: "no_browser" };
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$/i;

export async function launchBrowser(opts: { profileDir: string; headless: boolean; choice: BrowserChoice; allowLoopback: boolean }): Promise<BrowserContext> {
  const p = await loadPlaywright();
  if (!p || !opts.choice.browser) throw new Error("no_browser");
  const ctx = await p.chromium.launchPersistentContext(opts.profileDir, {
    headless: opts.headless,
    channel: opts.choice.browser === "chrome" ? "chrome" : undefined,
    acceptDownloads: false,
    serviceWorkers: "block",
    viewport: opts.headless ? { width: 1280, height: 1000 } : null,
    locale: "en-US",
    args: ["--no-first-run", "--no-default-browser-check", "--disable-sync"],
  });
  // The automation browser never talks to this computer's own services (e.g. the Career Atlas
  // API) or the local network — except synthetic test forms on a test instance.
  await ctx.route("**/*", (route) => {
    let host = "";
    try {
      host = new URL(route.request().url()).hostname;
    } catch {
      return route.abort();
    }
    if (PRIVATE_HOST.test(host) && !opts.allowLoopback) return route.abort("blockedbyclient");
    return route.continue();
  });
  return ctx;
}
