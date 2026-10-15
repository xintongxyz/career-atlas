// OPT-IN live probe of page intent on a REAL job posting — any site, nothing site-specific:
//   CA_LIVE_CODEX=1 CA_LIVE_POSTING_URL=<posting url> CA_AGENT_EVIDENCE=/tmp/trace.jsonl \
//     npx vitest run tests/integration/apply-posting-probe-live.test.ts
// Career Atlas's page model reads the posting (widgets marked), the real GPT provider proposes the next
// step, Career Atlas validates and executes it, then reads the page it led to. Navigation only: any
// proposal other than click / dismiss / wait / finish ends the probe, so nothing is typed, uploaded or
// submitted, and no profile is involved (empty profile, no resume). Never runs in CI.
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../src/local/apply/browser-agent";
import { chooseBrowser, launchBrowser } from "../../src/local/apply/browser";
import { PAGE_MAP, pageState, type PageMap } from "../../src/local/apply/page-intent";
import { codexProvider } from "../../src/local/codex";
import { profileSchema } from "../../src/shared/profile";

const url = process.env.CA_LIVE_POSTING_URL;
const live = process.env.CA_LIVE_CODEX === "1" && !!url;
const evidence = (line: Record<string, unknown>) => {
  if (process.env.CA_AGENT_EVIDENCE) appendFileSync(process.env.CA_AGENT_EVIDENCE, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
};
const NAVIGATION = new Set(["click", "dismiss_dialog", "wait", "scroll", "finish"]);

describe.skipIf(!live)("live posting probe (opt-in, navigation only)", () => {
  it("reads the posting, lets GPT choose the step that starts the application, verifies where it led", async () => {
    const provider = await codexProvider().ready();
    expect(provider).toBeTruthy();
    const choice = await chooseBrowser();
    const ctx = await launchBrowser({ profileDir: mkdtempSync(join(tmpdir(), "ca-probe-")), headless: true, choice, allowLoopback: false });
    try {
      let page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url!, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      let inWorkflow = false;
      const agent = createAgent({
        goal: `Apply for the job on this page`,
        inWorkflow: () => inWorkflow,
        planCtx: { profile: profileSchema.parse({}), jobCountry: null, answers: {}, resume: { fileName: "" } },
        resume: { name: "none.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) },
        propose: async (system, user, schema) => {
          const p = (await provider!.completeJson({ system, user, jsonSchema: schema })) as Record<string, unknown>;
          // Navigation only in this probe: anything else ends it (nothing typed, uploaded or submitted).
          return NAVIGATION.has(String(p.action)) ? p : { ...p, action: "finish", status: "needs_user", ref: null };
        },
        autofill: async () => ({ verified: 0, open: [] }),
        guard: async () => {},
        event: async () => {},
        record: () => {},
        trace: (e) => evidence({ kind: "agent", ...e }),
      });
      const before = (await page.evaluate(PAGE_MAP)) as PageMap;
      evidence({ kind: "posting", url: before.url, state: pageState(before, { inWorkflow: false, login: false }), headings: before.headings, widgets: before.widgets, apply_candidates: before.names.filter((n) => /apply|start|interested/i.test(n)) });
      let after: PageMap | null = null;
      for (let i = 0; i < 4; i++) {
        const r = await agent.step(page);
        if (r.kind === "acted") {
          page = r.page;
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
          await new Promise((res) => setTimeout(res, 2500));
          after = (await page.evaluate(PAGE_MAP)) as PageMap;
          const st = pageState(after, { inWorkflow: true, login: false });
          evidence({ kind: "after_action", action: r.action.action, target: r.target, verified: r.note, url: after.url, state: st, headings: after.headings, semantics: after.semantics, fields: after.applicationFields, widgets: after.widgets.map((w) => w.kind) });
          if (st === "application" || st === "questions" || st === "login") {
            inWorkflow = true;
            break;
          }
        } else if (r.kind !== "refused") break;
      }
      expect(after).not.toBeNull();
      expect(["application", "questions", "login"]).toContain(pageState(after!, { inWorkflow: true, login: false }));
    } finally {
      await ctx.close().catch(() => {});
    }
  }, 600_000);
});
