/**
 * Bounded analytic particle-field evidence gate.
 *
 * This serial suite proves the v0.2 data contract, Core evaluator, renderer
 * consumption, and the existing Debug/MCP/CLI/local-SDK control plane. It does
 * not claim browser/native pixel equivalence, physics, or GPU execution.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/core/src/particle-evaluator.test.ts",
      "packages/core/src/particle-field-capability.test.ts",
      "packages/core/src/particle-field-schema.test.ts",
      "packages/core/src/rich-controls.test.ts",
      "packages/renderer-browser/src/index.test.ts",
      "packages/renderer-native/src/particle-field-render.test.ts",
      "packages/debug-api/src/domains/timeline-layer-create-args.test.ts",
      "packages/debug-server/src/mcp-tool-surface.test.ts",
      "packages/cli/src/particle-field-cli.test.ts",
      "packages/sdk/src/local.test.ts"
    ],
    testNamePattern: /analytic particle|bounded particles|particle payloads|particle fields|particle field/i,
    setupFiles: ["./scripts/vitest-setup-job-stores.ts"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 45_000,
    hookTimeout: 45_000
  }
});
