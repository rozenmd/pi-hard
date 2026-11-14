import { defineConfig } from "vite-plus";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { sandboxTestConfig } from "./scripts/sandbox-config.ts";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      config: false,
      wrangler: { configPath: await sandboxTestConfig() },
      miniflare: {
        bindings: {
          ACCESS_LOCAL_DEV: "true",
          CODEX_MODEL: "gpt-6-luna",
        },
      },
    }),
  ],
  test: {
    include: ["test/container/*.test.ts"],
    testTimeout: 300_000,
    // Avoid oversized warm-module WebSocket frames (workers-sdk#16349).
    fsModuleCache: false,
  },
}));
