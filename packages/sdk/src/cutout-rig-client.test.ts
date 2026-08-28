import { describe, expect, it } from "vitest";
import { validateCutoutRigOutput } from "./cutout-rig-client.js";

const SHA = "a".repeat(64);
const request = {
  packageRoot: "/packages/source",
  outDir: "/packages/baked",
  sourceLayerId: "source",
  rig: {
    schema: "shellx-motion/cutout-rig@1",
    sampleEveryFrames: 1,
    nodes: [{
      layerId: "hand",
      stackIndex: 0,
      crop: { x: 0, y: 0, width: 10, height: 10 },
      origin: { x: 0, y: 0 },
      poses: [{ atMs: 0, x: 0, y: 0, scale: 1, rotation: 0 }],
    }],
  },
};

function output(): Record<string, unknown> {
  return {
    packageRoot: request.outDir,
    package: { packageId: "pkg_baked" },
    source: {
      layerId: "source", assetRef: "assets/source.png", width: 10, height: 10, sha256: SHA,
      staticTransform: { x: 0, y: 0, width: 10, height: 10, scale: 1, rotation: 0, originX: 5, originY: 5 },
    },
    outputLayerIds: ["hand"],
    changedPaths: ["/layers"],
    cadence: {
      sampleEveryFrames: 1, observedFrameCount: 1, bakedSampleCount: 1, firstSampleMs: 0, lastSampleMs: 0,
      activeWindow: { startMs: 0, endMsExclusive: 100 },
      approximation: "ordinary linear transform tracks between sampled renderer frames",
    },
    receipt: {
      schema: "shellx-motion/receipt@1", id: "cutout-rig", packageId: "pkg_baked",
      operation: "timeline.cutout.rig.bake", status: "passed", path: "/packages/baked/receipts/cutout-rig-bake.receipt.json", sha256: SHA,
    },
    receiptPath: "/packages/baked/receipts/cutout-rig-bake.receipt.json",
  };
}

describe("typed cutout rig client response validation", () => {
  it("requires the baked output stack, cadence, source proof, and receipt to match the request", () => {
    expect(validateCutoutRigOutput("cutoutRigBake", output(), request)).toBeNull();
    expect(validateCutoutRigOutput("cutoutRigBake", { ...output(), outputLayerIds: ["other"] }, request))
      .toMatchObject({ code: "invalid_transport_response" });
  });
});
