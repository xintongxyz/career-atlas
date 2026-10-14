#!/usr/bin/env node
// Creates "~/Applications/Career Atlas.app": double-click to start Career Atlas (if needed)
// and open it in your browser. Re-run after moving the repository or changing Node versions.
//   npm run launcher:install            npm run launcher:install -- --remove
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("The launcher is for macOS. Use `npm run start:local -- --open` elsewhere.");
  process.exit(1);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(homedir(), "Applications", "Career Atlas.app");
if (process.argv.includes("--remove")) {
  rmSync(app, { recursive: true, force: true });
  console.log(`✓ Removed ${app}`);
  process.exit(0);
}
const q = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// Prefer the stable `node` on PATH (e.g. a Homebrew symlink) over a version-specific install path,
// so upgrading Node does not break the launcher.
let node = process.execPath;
try {
  const onPath = execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim();
  if (onPath) node = onPath;
} catch {
  /* keep process.execPath */
}
const cmd = `cd ${sh(root)} && ${sh(node)} scripts/start-local.mjs --detach --open 2>&1`;
const script = `try
  do shell script ${q(cmd)}
on error errMsg
  display dialog "Career Atlas could not start:" & return & return & errMsg buttons {"OK"} default button "OK" with icon caution
end try
`;
mkdirSync(dirname(app), { recursive: true });
const work = mkdtempSync(join(tmpdir(), "career-atlas-launcher-"));
writeFileSync(join(work, "launcher.applescript"), script);
if (existsSync(app)) rmSync(app, { recursive: true, force: true });
execFileSync("osacompile", ["-o", app, join(work, "launcher.applescript")]);
rmSync(work, { recursive: true, force: true });
console.log(`✓ Created ${app}\n  Open it from Finder › Applications (your user folder), Spotlight or the Dock.\n  It starts Career Atlas in the background if needed and opens ${"http://127.0.0.1:4310"}.`);
