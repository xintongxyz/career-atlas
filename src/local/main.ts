// Career Atlas local server entry point.
//
//   node dist/server/main.mjs            (npm run start:local; the Mac launcher)
//   CAREER_ATLAS_INSTANCE=dev tsx src/local/main.ts   (npm run dev)
//
// Listens on 127.0.0.1 only. One instance per data directory (server.lock).
import { serve } from "@hono/node-server";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBackups, createLocalRuntime } from "./runtime";
import { loadConfig } from "./config";

const MIN_NODE = [22, 16];

function checkNode() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    console.error(`✗ Career Atlas needs Node.js ${MIN_NODE.join(".")} or newer (found ${process.versions.node}).`);
    process.exit(1);
  }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Everything Career Atlas writes (database, documents, config, logs, backups) is owner-only.
process.umask(0o077);

async function main() {
  checkNode();
  const cfg = loadConfig();
  const url = `http://127.0.0.1:${cfg.port}`;
  const lockFile = join(cfg.dataDir, "server.lock");

  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number; port: number };
      if (lock.pid !== process.pid && pidAlive(lock.pid)) {
        const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`).catch(() => null);
        if (res?.ok) {
          console.log(`Career Atlas is already running: http://127.0.0.1:${lock.port}`);
          process.exit(0);
        }
      }
    } catch {
      /* stale or unreadable lock: replaced below */
    }
  }

  const rt = await createLocalRuntime(cfg, { extraHosts: (process.env.CAREER_ATLAS_EXTRA_HOSTS ?? "").split(",").filter(Boolean), serveStatic: cfg.kind !== "dev" });

  const server = serve({ fetch: rt.fetch, hostname: cfg.host, port: cfg.port }, () => {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: cfg.port, started_at: new Date().toISOString() }), { mode: 0o600 });
    console.log(`Career Atlas (${cfg.kind}) → ${url}`);
    console.log(`  data: ${cfg.dataDir}`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `✗ Port ${cfg.port} is already in use by another program. Set CAREER_ATLAS_PORT to use a different port.` : `✗ Server error: ${e.code ?? e.name}`);
    rt.close();
    process.exit(1);
  });

  const stopBackups = cfg.kind === "test" ? () => {} : scheduleBackups(rt);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal}: finishing pending work…`);
    stopBackups();
    server.close();
    await Promise.race([rt.runner.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    rt.close(); // closes SQLite cleanly (checkpoints the WAL)
    try {
      const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number };
      if (lock.pid === process.pid) rmSync(lockFile, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`✗ Career Atlas could not start:\n${(e as Error).message}`);
  process.exit(1);
});
