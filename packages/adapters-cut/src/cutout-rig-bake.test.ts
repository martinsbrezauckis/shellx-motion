/** Cut must not promise editable import for a sampled crop/origin bake it cannot receive. */
import { describe, expect, it } from "vitest";
import { bakeCutoutRig, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { CUT_EDITABLE_RECEIVER_SLICE } from "./editable-receiver-allowlist.js";
import { planCutImport, type CutTargetCapabilities } from "./index.js";

const sourceIdentity = { assetRef: "assets/source.png", width: 10, height: 10, sha256: "a".repeat(64) };

describe("Cut cutout-rig bake handoff", () => {
  it("falls back to rendered media rather than claiming Cut can edit a crop/origin transform bake", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1", id: "cutout_source", name: "Cutout source",
      durationMs: 100, fps: 10, width: 20, height: 20, assets: [],
      layers: [{
        id: "source", type: "image", assetRef: "assets/source.png", trackId: "main", startMs: 0, durationMs: 100,
        transform: { x: 0, y: 0, width: 10, height: 10, scale: 1, rotation: 0, originX: 5, originY: 5 },
      }],
      tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }], provenance: { sourceApp: "test", createdBy: "test" },
    };
    const baked = bakeCutoutRig(motion, "source", {
      schema: "shellx-motion/cutout-rig@1", sampleEveryFrames: 1,
      nodes: [{
        layerId: "hand", stackIndex: 0, crop: { x: 0, y: 0, width: 5, height: 5 }, origin: { x: 1, y: 1 },
        poses: [{ atMs: 0, x: 2, y: 2, scale: 1, rotation: 0 }],
      }],
    }, sourceIdentity);
    const pkg = {
      root: "/packages/cutout-baked",
      manifest: { id: "pkg_cutout_baked", assets: ["assets/source.png"] },
      motion: baked.motion,
    } as MotionPackage;
    const target: CutTargetCapabilities = {
      targetId: "shellx-cut", modes: ["editable_lowering", "rendered_media"], lowerableLayerTypes: ["image"],
      editableReceiver: CUT_EDITABLE_RECEIVER_SLICE,
    };

    const plan = planCutImport(pkg, target);

    expect(plan).toMatchObject({ ok: true, mode: "rendered_media" });
    expect(plan.operations).toEqual([expect.objectContaining({ verb: "cut.media.import_rendered" })]);
    expect(plan.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ layerId: "hand", feature: "cut.payload.crop" }),
    ]));
  });
});
