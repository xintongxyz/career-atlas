import { defineConfig } from "drizzle-kit";

// Generates SQL migrations only (npm run db:generate). The app applies them itself at startup,
// after a verified backup (src/local/database.ts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./migrations",
});
