import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
  "@": fileURLToPath(new URL("./src/client", import.meta.url)),
};

// Every test uses synthetic data in temporary directories; the personal database is never opened.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        // HTTP API end to end on the real runtime (Node + SQLite + file store + task runner),
        // plus local-runtime safety tests.
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts", "tests/local/**/*.test.ts"],
          pool: "forks",
        },
      },
    ],
  },
});
