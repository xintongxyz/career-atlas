// The Claude Desktop extension (integrations/claude-desktop) spoken to over stdio exactly like
// Claude Desktop does, against a throwaway Career Atlas instance on a real local port.
import { serve } from "@hono/node-server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAppRoot, loadConfig } from "../../src/local/config";
import { createLocalRuntime, type LocalRuntime } from "../../src/local/runtime";

let work: string;
let rt: LocalRuntime;
let server: ReturnType<typeof serve>;
let port: number;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "career-atlas-mcp-test-"));
  process.env.CA_BACKUP_DIR = join(work, "backups");
  process.env.CA_BACKUP_KEY_FILE = join(work, "backup.key");
  rt = await createLocalRuntime(loadConfig({ kind: "test", dataDir: join(work, "data"), port: 0 }), { serveStatic: false });
  server = serve({ fetch: (req) => rt.fetch(req), hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as { port: number }).port;
  rt.allowedHosts.add(`127.0.0.1:${port}`);
});
afterAll(() => {
  server.close();
  rt.close();
  rmSync(work, { recursive: true, force: true });
});

function startMcp(url: string) {
  const child = spawn(process.execPath, [join(findAppRoot(), "integrations/claude-desktop/server/index.mjs")], {
    env: { PATH: process.env.PATH ?? "", CAREER_ATLAS_URL: url, CAREER_ATLAS_OPEN_REVIEW: "false" },
  }) as ChildProcessWithoutNullStreams;
  let buf = "";
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as { id: number };
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg as unknown as Record<string, unknown>);
    }
  });
  let next = 1;
  const request = (method: string, params?: unknown) =>
    new Promise<Record<string, any>>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { child, request, notify };
}

const JD = `Product Analyst — Contoso Mobility (fictional)
Location: Montréal, QC, Canada. Fully remote within Canada.
Pay: CAD $80,000 – $95,000 per year.
You will analyse trip data and run A/B tests with product managers.
Requirements: 3+ years in analytics; strong SQL.`;

describe("Claude Desktop extension (MCP over stdio)", () => {
  it("handshakes, lists only the two narrow tools, and creates a reviewable draft", async () => {
    const mcp = startMcp(`http://127.0.0.1:${port}`);
    try {
      const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "test" } });
      expect(init.result.protocolVersion).toBe("2025-06-18");
      expect(init.result.serverInfo.name).toBe("career-atlas");
      mcp.notify("notifications/initialized");

      const list = await mcp.request("tools/list");
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["create_job_draft", "check_job_url"]);
      expect(list.result.tools[0].annotations).toMatchObject({ destructiveHint: false });
      expect(list.result.tools[0].inputSchema.properties).toHaveProperty("translations");

      const before = await mcp.request("tools/call", { name: "check_job_url", arguments: { url: "https://jobs.example.com/contoso/77" } });
      expect(before.result.content[0].text).toMatch(/Already saved in Career Atlas: no/);

      const created = await mcp.request("tools/call", {
        name: "create_job_draft",
        arguments: {
          source_url: "https://jobs.example.com/contoso/77",
          job_description: JD,
          notes: "Department not stated in the posting.",
          original_language: "en",
          translations: { "zh-CN": { title: "产品分析师", category: "数据分析" }, en: { title: "Product Analyst", category: "Analytics" } },
          fields: {
            company_name: { value: "Contoso Mobility", basis: "posting", evidence: "Product Analyst — Contoso Mobility" },
            title: { value: "Product Analyst", basis: "posting", evidence: "Product Analyst" },
            company_website: { value: "https://contoso-mobility.example.com", basis: "web", source_url: "https://contoso-mobility.example.com" },
            category: { value: "Analytics", basis: "inferred" },
            work_mode: { value: "remote", basis: "posting", evidence: "Fully remote within Canada." },
            salary: { value: { min: 80000, max: 95000, currency: "CAD", period: "annually" }, basis: "posting", evidence: "Pay: CAD $80,000 – $95,000 per year." },
            years_experience_min: { value: 3, basis: "posting", evidence: "3+ years in analytics" },
          },
        },
      });
      const text = created.result.content[0].text as string;
      expect(created.result.isError).toBe(false);
      expect(text).toMatch(new RegExp(`http://127.0.0.1:${port}/drafts/[0-9a-f-]{36}`));
      expect(text).toMatch(/Accepted as stated in the posting: .*salary/);
      expect(text).toMatch(/Marked for the user's review .*company_website.*category/);
      expect(text).toMatch(/Translations saved for review: (en, zh-CN|zh-CN, en)/);

      // A draft exists; no job was created.
      const drafts = (await (await rt.fetch(new Request(`http://127.0.0.1:${port}/api/drafts`, { headers: { host: `127.0.0.1:${port}` } }))).json()) as { items: { origin: string; title: string }[] };
      expect(drafts.items[0]).toMatchObject({ origin: "claude_desktop", title: "Product Analyst" });
      const jobs = (await (await rt.fetch(new Request(`http://127.0.0.1:${port}/api/jobs`, { headers: { host: `127.0.0.1:${port}` } }))).json()) as { total: number };
      expect(jobs.total).toBe(0);

      const unknown = await mcp.request("tools/call", { name: "delete_job", arguments: {} });
      expect(unknown.result.isError).toBe(true);
    } finally {
      mcp.child.kill();
    }
  });

  it("refuses non-local addresses and explains when Career Atlas is not running", async () => {
    const remote = startMcp("https://example.com");
    const down = startMcp("http://127.0.0.1:9");
    try {
      await remote.request("initialize", { protocolVersion: "2025-06-18" });
      const r1 = await remote.request("tools/call", { name: "check_job_url", arguments: { url: "https://jobs.example.com/1" } });
      expect(r1.result.content[0].text).toMatch(/must be http:\/\/127\.0\.0\.1/);
      await down.request("initialize", { protocolVersion: "2025-06-18" });
      const r2 = await down.request("tools/call", { name: "check_job_url", arguments: { url: "https://jobs.example.com/1" } });
      expect(r2.result.content[0].text).toMatch(/Career Atlas is not running/);
    } finally {
      remote.child.kill();
      down.child.kill();
    }
  });
});
