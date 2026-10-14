import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// Bundles the local Node runtime (server + CLI) into dist/server. Dependencies stay in node_modules.
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
  },
  build: {
    ssr: true,
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    sourcemap: true,
    rollupOptions: {
      input: { main: "src/local/main.ts", cli: "src/local/cli.ts" },
      output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "chunks/[name]-[hash].mjs" },
      external: [/^node:/],
    },
  },
});
