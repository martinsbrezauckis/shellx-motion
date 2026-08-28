/**
 * Current colour/alpha conformance gate.
 *
 * This is intentionally a narrow, serial evidence check. It proves the present SDR boundary,
 * validator refusals and capability propagation; it does not claim browser/native pixel parity or
 * ADR-0204's proposed linear-sRGB target.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/core/src/color-alpha-contract.test.ts",
      "packages/renderer-native/src/color-alpha-contract.test.ts",
      "packages/renderer-ffmpeg/src/color-alpha-contract.test.ts",
      "packages/debug-api/src/color-alpha-contract.test.ts",
      "packages/debug-server/src/color-alpha-contract.test.ts",
      "packages/cli/src/color-alpha-contract.test.ts",
      "packages/sdk/src/color-alpha-contract.test.ts"
    ],
    setupFiles: ["./scripts/vitest-setup-job-stores.ts"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 45_000,
    hookTimeout: 45_000
  }
});
