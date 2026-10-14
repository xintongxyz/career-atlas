// Real-site, NON-SUBMITTING Workday compatibility check (opt-in: LIVE=1 npx vitest run tests/local/workday-live.test.ts).
//
// Opens public Workday career sites in a throwaway headless profile, opens a posting, clicks
// Apply → Apply Manually, and checks what Career Atlas recognises. It never types, never signs in,
// never creates an account and never submits anything. Optional: LIVE_WORKDAY_URLS=<comma-separated
// career-site or job URLs> to check other sites.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseBrowser, launchBrowser } from "../../src/local/apply/browser";
import { PAGE_SIGNALS, SCAN_FIELDS } from "../../src/local/apply/dom";
import { atsFromSignals } from "../../src/local/apply/outcome";
import { declineCookies, enterApplyFlow, wdSettle } from "../../src/local/apply/workday";

const DEFAULT_SITES = ["https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite", "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers", "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site"];
const SITES = (process.env.LIVE_WORKDAY_URLS ?? DEFAULT_SITES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

describe.skipIf(!process.env.LIVE)("Workday live, non-submitting", () => {
  for (const site of SITES) {
    it(`recognises the application flow on ${new URL(site).hostname}`, async () => {
      const choice = await chooseBrowser();
      const dir = mkdtempSync(join(tmpdir(), "ca-live-wd-"));
      const ctx = await launchBrowser({ profileDir: dir, headless: true, choice, allowLoopback: false });
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const posts: string[] = [];
      page.on("request", (r) => {
        if (["POST", "PUT"].includes(r.method()) && /\/apply|signin|account/i.test(r.url())) posts.push(r.url());
      });
      try {
        await page.goto(site, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(5000);
        if (!/\/job\/|\/details\//.test(page.url())) {
          await page.locator('a[data-automation-id="jobTitle"]').first().click();
          await page.waitForTimeout(4000);
        }
        const s = (await page.evaluate(PAGE_SIGNALS)) as Parameters<typeof atsFromSignals>[0];
        const ats = atsFromSignals(s);
        await declineCookies(page);
        const entered = await enterApplyFlow(page);
        const state = await wdSettle(page, 20_000);
        const fields = (await page.evaluate(SCAN_FIELDS)) as { wdField?: string; control: string }[];
        console.log(JSON.stringify({ site: new URL(site).hostname, ats, entered, state: { kind: state.kind, step: state.step, index: state.index, total: state.total }, fillable: fields.length, url: new URL(page.url()).pathname.replace(/\/[^/]*_R?[\w-]+\//, "/…/") }));
        expect(ats).toBe("workday");
        expect(["entered", "already"]).toContain(entered.result);
        // The sign-in / account step must be recognised, and nothing on it is fillable by Career Atlas.
        if (state.kind === "auth") expect(fields).toEqual([]);
        else expect(["step", "review"]).toContain(state.kind);
        expect(posts).toEqual([]); // nothing was sent to the employer
      } finally {
        await ctx.close().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
