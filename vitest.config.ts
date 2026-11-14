import { defineConfig } from "vite-plus";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_LOCAL_DEV: "true",
          CODEX_MODEL: "gpt-6-luna",
          PR_SCREENSHOTS_URL: "https://public-test.r2.dev",
        },
        r2Buckets: ["SCREENSHOTS", "PR_SCREENSHOTS", "DEPENDENCY_CACHE"],
        durableObjects: {
          AGENT: { className: "Agent", useSQLite: true },
          SANDBOX: { className: "Sandbox", useSQLite: true },
        },
      },
      config: false,
    }),
  ],
  test: {
    include: ["test/*.test.ts"],
    // Avoid oversized warm-module WebSocket frames (workers-sdk#16349).
    fsModuleCache: false,
  },
});
