import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    environmentMatchGlobs: [
      // `test/**` builds real `Keypair`s at module scope, which breaks under
      // jsdom's separate `Uint8Array` realm (see test/support/client.ts) and
      // needs no DOM anyway — plain `node` matches how it already ran under
      // `node:test` before this suite moved to vitest.
      ["test/**", "node"],
    ],
    // Only used by `npm run test:coverage` (plain `npm test` stays fast). No
    // thresholds on purpose: CI reports the numbers, it does not gate on them.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
