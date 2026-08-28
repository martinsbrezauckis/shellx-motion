import { describe, expect, it, vi } from "vitest";

const marker = vi.hoisted(() => vi.fn());
const resolveGeneric = vi.hoisted(() => vi.fn());

vi.mock("@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final", () => ({
  hasGpuScene3dGltfPbrFinalRouteMarker: marker,
}));
vi.mock("@shellx-motion/renderer-browser", () => ({
  resolveGpuEffectModuleStaticPlanForUse: resolveGeneric,
}));

import { renderSegmentedFinal } from "./segmented-final.js";

const pkg = {
  root: "/unreachable-pbr-package",
  manifest: { id: "pkg-pbr", motion: "motion.json" },
  motion: { width: 1280, height: 720, fps: 30, durationMs: 1_000, layers: [] },
} as never;

describe("fixed glTF PBR segmented final boundary", () => {
  it.each(["browser", "native", "gpu"] as const)("refuses direct-only PBR markers before any %s segmented resources", async (frameLane) => {
    marker.mockReturnValue(true);
    resolveGeneric.mockReset();
    const result = await renderSegmentedFinal({
      pkg,
      frameLane,
      outputPath: "/tmp/pbr-segmented-never-created.mp4",
      segmented: { segmentFrames: 1, resume: true },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "segmented_final_unsupported", evidence: { phase: "preflight" } }),
    });
    expect(resolveGeneric).not.toHaveBeenCalled();
  });
});
