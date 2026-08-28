import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("motion.render.final materialized resource preflight", () => {
  it("does not apply a materialized allocation ceiling to the streamed default", async () => {
    const context = {
      tier: "render_motion" as const,
      materializedFrameSequencePreflight: { jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 } }
    };
    const args = {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: resolve(".scratch/host-tests/wsl/render-preflight/debug-preflight.mp4")
    };
    const result = await dispatchDebugCommand("motion.render.final", { ...args, dryRun: true }, context);

    expect(result).toMatchObject({ ok: true, result: { frameTransport: { delivery: "streamed" } } });
  });

  it("refuses exact-quality materialization before allocation on dry-run and execution", async () => {
    const context = {
      tier: "render_motion" as const,
      scratchRoot: resolve(".scratch/host-tests/wsl/render-preflight"),
      materializedFrameSequencePreflight: { jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 } }
    };
    const args = {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: resolve(".scratch/host-tests/wsl/render-preflight/debug-preflight.mp4"),
      qualityManifestPath: resolve(".scratch/host-tests/wsl/render-preflight/quality.json")
    };
    const [dryRun, execution] = await Promise.all([
      dispatchDebugCommand("motion.render.final", { ...args, dryRun: true }, context),
      dispatchDebugCommand("motion.render.final", args, context)
    ]);

    for (const result of [dryRun, execution]) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "render_resource_preflight_exceeded",
          detail: { resourcePreflight: { status: "refused", budget: { source: "trusted-host" } } }
        }
      });
    }
  });
});
