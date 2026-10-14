#!/usr/bin/env node
// Captures README screenshots from a LOCAL dev server seeded with fictional demo data.
//   npm run db:seed:demo && npm run dev   (in another terminal)
//   node scripts/capture-screenshots.mjs [http://localhost:5173]
// Never point this at a deployment that holds real personal data.
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5173";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("Refusing: screenshots may only be captured from a local dev server with demo data.");
  process.exit(1);
}
const browser = await chromium.launch({ channel: process.env.CI ? undefined : "chrome" });
const shots = [
  { lang: "en", path: "/", file: "dashboard-en.png", w: 1440, h: 900 },
  { lang: "en", path: "/applications", file: "board-en.png", w: 1440, h: 900 },
  { lang: "en", path: "/positions", file: "positions-en.png", w: 1440, h: 900 },
  { lang: "zh-CN", path: "/", file: "dashboard-zh.png", w: 1440, h: 900 },
  { lang: "zh-CN", path: "/analytics", file: "analytics-zh.png", w: 1440, h: 900 },
  { lang: "en", path: "/", file: "mobile-en.png", w: 390, h: 844 },
];
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, locale: s.lang, timezoneId: "America/Toronto" });
  await ctx.addInitScript((lang) => localStorage.setItem("career-atlas.lang", lang), s.lang);
  const page = await ctx.newPage();
  await page.goto(base + s.path);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `docs/screenshots/${s.file}` });
  await ctx.close();
  console.log("✓", s.file);
}
// Job detail of the first demo job
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "en", timezoneId: "America/Toronto" });
await ctx.addInitScript(() => localStorage.setItem("career-atlas.lang", "en"));
const page = await ctx.newPage();
const jobs = await (await page.request.get(base + "/api/jobs?q=Data%20Analyst")).json();
await page.goto(`${base}/jobs/${jobs.items[0].id}`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(800);
await page.screenshot({ path: "docs/screenshots/job-detail-en.png" });
console.log("✓ job-detail-en.png");
await browser.close();
