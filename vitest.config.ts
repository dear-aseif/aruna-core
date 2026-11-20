import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Tests run against the managed (remote) database; parallel files add latency per round trip.
    testTimeout: 30_000,
    globalSetup: ["tests/support/global-setup.ts"],
  },
});
