import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { createGpuPreviewSession, renderMotionGpuPreview } from "./gpu-points-preview.js";
import { createMotionBrowserRenderSession, preflightBrowserPackage } from "./index.js";

const strictPackage = (): MotionPackage => ({
  root: "/strict-color-pipeline",
  manifest: { schema: "shellx-motion/package-manifest@1", id: "strict-color-pipeline", name: "Strict color pipeline", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser", "gpu"], hosts: ["motion"] } },
  motion: {
    schema: "shellx-motion/motion@1", id: "strict-color-pipeline", name: "Strict color pipeline", durationMs: 1_000, fps: 1, width: 16, height: 16,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [], colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }
  }
});

describe("F0 strict color-pipeline preallocation guards", () => {
  it("refuses Browser and direct GPU preview before launch, resources, or output setup", async () => {
    const pkg = strictPackage();
    let browserLaunches = 0, runtimeOpens = 0, resourcePreparations = 0, outputPathResolutions = 0;
    await expect(preflightBrowserPackage(pkg)).resolves.toEqual({ ok: false, htmlEntries: [], blockedOrigins: [], warnings: [expect.stringContaining("linear-srgb-sdr@1")] });
    await expect(createMotionBrowserRenderSession(pkg, {
      launchBrowser: async () => { browserLaunches += 1; throw new Error("browser must not launch"); }
    })).rejects.toThrow(/linear-srgb-sdr@1/);
    const options = {
      prepareResourcesForTest: async () => { resourcePreparations += 1; throw new Error("resources must not prepare"); },
      resolveOutputPathForTest: async () => { outputPathResolutions += 1; return "/strict-color-pipeline/never.png"; },
      openRuntime: async () => { runtimeOpens += 1; throw new Error("GPU runtime must not open"); }
    };
    await expect(renderMotionGpuPreview(pkg, { atMs: 0, outDir: "/strict-color-pipeline", sessionOptions: options })).resolves.toMatchObject({ ok: false, error: { code: "color_pipeline_unsupported" } });
    const reusable = createGpuPreviewSession(pkg, options);
    await expect(reusable.renderFrame({ atMs: 0, outDir: "/strict-color-pipeline" })).resolves.toMatchObject({ ok: false, error: { code: "color_pipeline_unsupported" } });
    await reusable.close();
    expect({ browserLaunches, runtimeOpens, resourcePreparations, outputPathResolutions }).toEqual({ browserLaunches: 0, runtimeOpens: 0, resourcePreparations: 0, outputPathResolutions: 0 });
  });
});
