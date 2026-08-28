import { describe, expect, it } from "vitest";
import { bakeCutoutRig, parseCutoutRig } from "./cutout-rig";
import { matchRendererCapability, rendererCapabilityForLane } from "./capabilities";
import type { MotionDocument } from "./types";

const IDENTITY = {
  assetRef: "assets/source.png",
  width: 100,
  height: 100,
  sha256: "a".repeat(64),
};

function document(durationMs = 400): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion",
    name: "Cutout rig test",
    durationMs,
    fps: 10,
    width: 100,
    height: 100,
    assets: [],
    layers: [{
      id: "source",
      type: "image",
      assetRef: IDENTITY.assetRef,
      trackId: "main",
      startMs: 100,
      durationMs: Math.min(200, durationMs - 100),
      transform: { x: 0, y: 0, width: 100, height: 100, scale: 1, rotation: 0, originX: 0, originY: 0 },
    }],
    tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }],
    provenance: { sourceApp: "test", createdBy: "test" },
  };
}

function rig(sampleEveryFrames = 1) {
  return {
    schema: "shellx-motion/cutout-rig@1",
    sampleEveryFrames,
    nodes: [{
      layerId: "hand",
      stackIndex: 0,
      crop: { x: 0, y: 0, width: 10, height: 10 },
      origin: { x: 0, y: 0 },
      // Sampling at 100ms occurs before this pose and sampling at 200ms occurs after it.
      poses: [{ atMs: 150, x: 12, y: 4, scale: 1, rotation: 0 }],
    }],
  } as const;
}

describe("cutout rig bake", () => {
  it("clamps poses outside their keys and samples only renderer-observable half-open frames", () => {
    const baked = bakeCutoutRig(document(), "source", rig(), IDENTITY);
    const layer = baked.motion.layers[0];
    expect(baked.cadence).toMatchObject({ observedFrameCount: 2, bakedSampleCount: 2, firstSampleMs: 100, lastSampleMs: 200 });
    expect(layer.keyframes?.["transform.x"]).toEqual([{ atMs: 100, value: 12 }, { atMs: 200, value: 12 }]);
    expect(layer.keyframes?.["transform.y"]).toEqual([{ atMs: 100, value: 4 }, { atMs: 200, value: 4 }]);
  });

  it("requires stackIndex to be the exact output permutation", () => {
    const invalid = structuredClone(rig()) as unknown as { nodes: Array<{ stackIndex: number }> };
    invalid.nodes[0].stackIndex = 1;
    expect(() => parseCutoutRig(invalid)).toThrow("stackIndex");
  });

  it("refuses sample/keyframe excess before materializing a large history", () => {
    const long = document(30_000);
    long.layers[0].startMs = 0;
    long.layers[0].durationMs = 30_000;
    expect(() => bakeCutoutRig(long, "source", rig(1), IDENTITY)).toThrow("sample");
  });

  it("lowers to ordinary image/crop/transform data accepted by both frame lanes", () => {
    const baked = bakeCutoutRig(document(), "source", rig(), IDENTITY);

    for (const lane of ["native", "browser"] as const) {
      expect(matchRendererCapability(baked.motion, rendererCapabilityForLane(lane)))
        .toMatchObject({ ok: true, lane, unsupported: [] });
    }
  });
});
