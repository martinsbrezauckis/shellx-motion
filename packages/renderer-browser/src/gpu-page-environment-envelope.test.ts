import { describe, expect, it } from "vitest";
import { deriveGpuEnvironmentSessionEnvelope } from "./gpu-page-environment-envelope";

describe("GPU environment session envelope", () => {
  it("reserves the complete static attachment union, not only environment ancestry", () => {
    const motion = {
      width: 64, height: 36,
      layers: [
        { id: "weather", type: "environment" },
        { id: "keyed", type: "image", keying: { matte: { denoiseRadiusPx: 1 } } }
      ]
    } as never;
    const staticPlan = {
      maxima: { maxEnvironmentCount: 1, maxScene3dCount: 1 },
      layers: [
        { id: "weather", type: "environment", groupDepth: 1 },
        { id: "keyed", type: "image", groupDepth: 3 }
      ]
    };
    expect(deriveGpuEnvironmentSessionEnvelope(staticPlan, motion)).toEqual({ width: 64, height: 36, groupDepth: 2, keyCleanup: true, needsDepth: true });
  });

  it("does not reserve an environment-only envelope for a static no-environment timeline", () => {
    expect(deriveGpuEnvironmentSessionEnvelope({ maxima: { maxEnvironmentCount: 0, maxScene3dCount: 1 }, layers: [{ id: "stage", type: "scene3d", groupDepth: 2 }] }, { width: 64, height: 36, layers: [] } as never)).toBeNull();
  });
});
