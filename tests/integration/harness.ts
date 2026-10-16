// Integration-test harness: a real local runtime (Node + SQLite + file store + task runner) in a
// throwaway data directory per test file. Synthetic data only.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/local/config";
import type { Proposer } from "../../src/local/apply/browser-agent";
import { createLocalRuntime } from "../../src/local/runtime";

const dataDir = mkdtempSync(join(tmpdir(), "career-atlas-it-"));
process.env.CA_BACKUP_DIR = mkdtempSync(join(tmpdir(), "career-atlas-it-backups-"));
process.env.CA_BACKUP_KEY_FILE = join(dataDir, "..", `${dataDir.split("/").pop()}-test.key`);
const cfg = loadConfig({ kind: "test", dataDir, port: 80 });
/**
 * The runtime browser agent's proposer in tests: null (no AI — as in CI) unless a test installs a
 * scripted stand-in. Tests never call a real model; tests/integration/apply-agent-live.test.ts is opt-in.
 */
export const agentHook: { propose: Proposer | null; writer: Proposer | null } = { propose: null, writer: null };
// Short waits after Submit so "unconfirmed" outcomes are reached quickly in tests.
const rt = await createLocalRuntime(cfg, {
  serveStatic: false,
  extraHosts: ["localhost"],
  apply: { timeouts: { afterSubmit: 6000, manual: 4000, navigation: 20_000 }, forceHeadless: true, pageAgent: null, chooseOption: null, browserAgent: async () => agentHook.propose, answerWriter: async () => agentHook.writer, agentMaxSteps: 25 },
});
rt.env.MAX_UPLOAD_BYTES = "1048576";

export const env = rt.env;
export const runtime = rt;
export const SELF = {
  // Real HTTP requests always carry a Host header; a Request built in-process does not.
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.headers.has("host")) req.headers.set("host", new URL(req.url).host);
    return rt.fetch(req);
  },
};
export function createExecutionContext() {
  return { waitUntil() {}, passThroughOnException() {}, props: {} };
}
export async function applyD1Migrations() {
  /* migrations are applied by the local runtime when it opens the database */
}
