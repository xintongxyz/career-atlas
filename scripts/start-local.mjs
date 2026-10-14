#!/usr/bin/env node
// Starts Career Atlas for everyday use (production build, PERSONAL database).
//
//   npm run start:local                 run in this terminal (Ctrl+C to stop)
//   npm run start:local -- --open       … and open the browser
//   npm run start:local -- --detach --open   run in the background (used by the Mac launcher)
//   npm run stop:local                  stop a background instance
//
// Checks prerequisites, rebuilds only when the source changed, never starts a second instance.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const dataDir = process.env.CAREER_ATLAS_DATA_DIR || join(homedir(), "Library", "Application Support", "CareerAtlas");
const port = Number(process.env.CAREER_ATLAS_PORT) || 4310;
const url = `http://127.0.0.1:${port}`;
const lockFile = join(dataDir, "server.lock");
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

const health = async (p = port) => {
  try {
    return (await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};
const readLock = () => {
  try {
    return JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
};
const openBrowser = (u) => execFileSync("open", [u]);

if (has("--stop")) {
  const lock = readLock();
  if (!lock) {
    console.log("Career Atlas is not running.");
    process.exit(0);
  }
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    console.log("Career Atlas is not running (stale lock).");
    process.exit(0);
  }
  for (let i = 0; i < 50 && (await health(lock.port)); i++) await new Promise((r) => setTimeout(r, 200));
  console.log("✓ Career Atlas stopped. Your data is saved.");
  process.exit(0);
}

// 1. Prerequisites.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 16)) fail(`Node.js 22.16+ is required (found ${process.versions.node}). Install the current LTS from https://nodejs.org`);
if (!existsSync(join(root, "node_modules", "hono"))) fail("Dependencies are missing. Run: npm install");

// 2. Already running? Just open it.
const lock = readLock();
if (!has("--build-only") && lock && (await health(lock.port))) {
  console.log(`Career Atlas is already running: http://127.0.0.1:${lock.port}`);
  if (has("--open")) openBrowser(`http://127.0.0.1:${lock.port}`);
  process.exit(0);
}
if (!has("--build-only") && (await health())) fail(`Port ${port} is used by another program. Set CAREER_ATLAS_PORT to another port.`);

// 3. Build when the source is newer than the last build.
const stampFile = join(root, "dist", ".build-stamp");
const newest = (p) => {
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const e of readdirSync(p)) m = Math.max(m, newest(join(p, e)));
  return m;
};
const sourceTime = Math.max(...["src", "migrations", "index.html", "package-lock.json", "public", "vite.config.ts", "vite.server.config.ts"].filter((p) => existsSync(p)).map(newest));
const built = existsSync(stampFile) && existsSync("dist/server/main.mjs") && existsSync("dist/client/index.html") ? Number(readFileSync(stampFile, "utf8")) : 0;
if (sourceTime > built) {
  console.error("→ Building Career Atlas (first start or source changed)…");
  try {
    // Run Vite through this Node binary: launchers (double-clicked apps) have no npm/npx on PATH.
    const vite = join(root, "node_modules", "vite", "bin", "vite.js");
    execFileSync(process.execPath, [vite, "build"], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync(process.execPath, [vite, "build", "-c", "vite.server.config.ts"], { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    fail("Build failed (see the messages above). Your data was not touched.");
  }
  writeFileSync(stampFile, String(sourceTime));
}

if (has("--build-only")) process.exit(0);

// 4. Start.
const env = { ...process.env, CAREER_ATLAS_INSTANCE: "personal", CAREER_ATLAS_PORT: String(port) };
if (!has("--detach")) {
  const child = spawn(process.execPath, ["dist/server/main.mjs"], { stdio: "inherit", env });
  if (has("--open")) {
    for (let i = 0; i < 100 && !(await health()); i++) await new Promise((r) => setTimeout(r, 150));
    if (await health()) openBrowser(url);
  }
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  mkdirSync(join(dataDir, "logs"), { recursive: true, mode: 0o700 });
  const logFile = join(dataDir, "logs", "server.log");
  const out = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, ["dist/server/main.mjs"], { detached: true, stdio: ["ignore", out, out], env });
  child.unref();
  closeSync(out);
  for (let i = 0; i < 100 && !(await health()); i++) await new Promise((r) => setTimeout(r, 150));
  if (!(await health())) {
    const tail = readFileSync(logFile, "utf8").split("\n").slice(-12).join("\n");
    fail(`Career Atlas did not start. Last log lines:\n${tail}`);
  }
  console.log(`✓ Career Atlas is running: ${url}  (stop with: npm run stop:local)`);
  if (has("--open")) openBrowser(url);
}
