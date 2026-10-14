#!/usr/bin/env node
// `npm run dev`: local API (tsx watch, DEV database in .dev-data/, synthetic data) + Vite with HMR.
// Never touches the personal database in ~/Library/Application Support/CareerAtlas.
//   npm run dev -- --port 5173 --strictPort     (extra args go to Vite)
import { spawn } from "node:child_process";

const viteArgs = process.argv.slice(2);
const pi = viteArgs.indexOf("--port");
const vitePort = pi >= 0 ? viteArgs[pi + 1] : "5173";
const apiPort = process.env.CAREER_ATLAS_API_PORT || "8788";
const env = {
  ...process.env,
  CAREER_ATLAS_INSTANCE: "dev",
  CAREER_ATLAS_PORT: apiPort,
  CAREER_ATLAS_API_PORT: apiPort,
  CAREER_ATLAS_EXTRA_HOSTS: `127.0.0.1:${vitePort},localhost:${vitePort}`,
};
const procs = [
  spawn("npx", ["tsx", "watch", "--clear-screen=false", "src/local/main.ts"], { stdio: "inherit", env }),
  spawn("npx", ["vite", ...(pi >= 0 ? [] : ["--port", vitePort]), ...viteArgs], { stdio: "inherit", env }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => { stop(); process.exitCode = code ?? 0; });
