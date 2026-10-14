import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 5174;
const DATA = ".e2e-data";
// Backups for the throwaway e2e instance go to a temp dir (never inside the repo, never ~/CareerAtlasBackups).
const BACKUPS = mkdtempSync(join(tmpdir(), "career-atlas-e2e-backups-"));

// E2E runs the PRODUCTION-LIKE local server (the same build `npm run start:local` uses) against a
// throwaway SQLite database that is wiped before each run. Synthetic data only; the personal
// database in ~/Library/Application Support/CareerAtlas is never touched.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "America/Toronto",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: process.env.CI ? undefined : "chrome" } }],
  webServer: {
    command: `rm -rf ${DATA} && npx vite build >/dev/null && npx vite build -c vite.server.config.ts >/dev/null && node dist/server/main.mjs`,
    env: {
      CAREER_ATLAS_INSTANCE: "test",
      CAREER_ATLAS_DATA_DIR: DATA,
      CAREER_ATLAS_PORT: String(PORT),
      CA_BACKUP_DIR: BACKUPS,
      CA_BACKUP_KEY_FILE: join(BACKUPS, "e2e.key"),
    },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
