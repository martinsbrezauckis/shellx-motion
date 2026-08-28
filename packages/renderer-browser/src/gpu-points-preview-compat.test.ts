import { describe, expect, it } from "vitest";
import { renderMotionGpuPointsPreview } from "./gpu-points-preview.js";

describe("GPU points preview compatibility export", () => {
  it("retains the direct-only O6 refusal after compatibility implementation split", async () => {
    const result = await renderMotionGpuPointsPreview({
      root: "/unopened-package",
      manifest: { id: "compat_o6" },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_compat_o6",
        name: "compat",
        durationMs: 100,
        fps: 24,
        width: 32,
        height: 32,
        assets: [],
        provenance: { sourceApp: "test", createdBy: "test" },
        layers: [],
        scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] }
      }
    } as never, { outDir: "/must-not-open" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "gpu_unsupported_feature", message: expect.stringContaining("historical renderMotionGpuPointsPreview compatibility alias") }
    });
  });
});
