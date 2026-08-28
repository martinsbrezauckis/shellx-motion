import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveGeneric = vi.hoisted(() => vi.fn());
const marker = vi.hoisted(() => vi.fn());

vi.mock("@shellx-motion/renderer-browser", () => ({
  gpuEffectModuleFinalReceiptEvidence: vi.fn(),
  resolveGpuEffectModuleStaticPlanForUse: resolveGeneric,
}));
vi.mock("@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final", () => ({
  hasGpuScene3dGltfPbrFinalRouteMarker: marker,
  resolveGpuScene3dGltfPbrFinalRoute: vi.fn(),
}));

import { renderSegmentedFinal } from "./segmented-final.js";
import { renderStreamingFinal } from "./streaming-final-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  resolveGeneric.mockReset();
  marker.mockReset();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("GPU final shape geometry-keyframe preview-only boundary", () => {
  it("refuses direct and segmented GPU final before static resolution, resources, or output publication", async () => {
    marker.mockReturnValue(false);
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-geometry-final-refusal-"));
    roots.push(root);
    const pkg = geometryPackage(root);
    const directOutput = join(root, "direct.mp4");
    const segmentedOutput = join(root, "segmented.mp4");

    await expect(renderStreamingFinal({
      pkg, frameLane: "gpu", outputPath: directOutput, inputRoots: [root], outputRoots: [root]
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "gpu_unsupported_feature", message: expect.stringContaining("strict Browser GPU preview") }
    });
    expect(resolveGeneric).not.toHaveBeenCalled();
    expect(existsSync(directOutput)).toBe(false);

    await expect(renderSegmentedFinal({
      pkg, frameLane: "gpu", outputPath: segmentedOutput, segmented: { segmentFrames: 1 }, inputRoots: [root], outputRoots: [root]
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "segmented_final_unsupported", message: expect.stringContaining("strict Browser GPU preview"), evidence: { phase: "preflight" } }
    });
    expect(resolveGeneric).not.toHaveBeenCalled();
    expect(existsSync(segmentedOutput)).toBe(false);
  });
});

function geometryPackage(root: string): MotionPackage {
  const polygon = (offset: number) => ({
    schema: "shellx-motion/shape-geometry@1" as const,
    kind: "polygon" as const,
    viewBox: { x: 0, y: 0, width: 64, height: 64 },
    points: [{ x: offset, y: 0 }, { x: offset + 24, y: 0 }, { x: offset + 12, y: 24 }],
  });
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "geometry-final-refusal", name: "Geometry final refusal", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "geometry-final-refusal", name: "Geometry final refusal", durationMs: 1_000, fps: 30, width: 64, height: 64,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{
        id: "contour", type: "shape", startMs: 0, durationMs: 1_000, transform: { width: 64, height: 64 }, fill: "#ff8040", geometry: polygon(0),
        geometryKeyframes: { schema: "shellx-motion/shape-geometry-keyframes@1", keyframes: [{ atUs: 0, geometry: polygon(0) }, { atUs: 1_000_000, geometry: polygon(20) }] },
      }],
    },
  };
}
