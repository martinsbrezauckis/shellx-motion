/** Static browser-lane acceptance for a bake that contains no new renderer primitive. */
import { describe, expect, it } from "vitest";
import { bakeCutoutRig, hashBuffer, matchRendererCapability, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { BROWSER_CAPABILITY, preflightBrowserPackage } from "./index.js";

describe("browser cutout rig static lowering", () => {
  it("accepts the flat image/crop/keyframe output without a rig-specific browser capability", async () => {
    const png = Buffer.from([1, 2, 3]);
    const source: MotionDocument = {
      schema: "shellx-motion/motion@1", id: "browser_cutout", name: "Browser cutout", durationMs: 100, fps: 10,
      width: 20, height: 20, assets: [],
      layers: [{
        id: "source", type: "image", assetRef: "assets/source.png", trackId: "main", startMs: 0, durationMs: 100,
        transform: { x: 0, y: 0, width: 2, height: 1, scale: 1, rotation: 0, originX: 0, originY: 0 },
      }],
      tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }], provenance: { sourceApp: "test", createdBy: "test" },
    };
    const baked = bakeCutoutRig(source, "source", {
      schema: "shellx-motion/cutout-rig@1", sampleEveryFrames: 1,
      nodes: [{
        layerId: "hand", stackIndex: 0, crop: { x: 1, y: 0, width: 1, height: 1 }, origin: { x: 0, y: 0 },
        poses: [{ atMs: 0, x: 2, y: 3, scale: 1, rotation: 0 }],
      }],
    }, { assetRef: "assets/source.png", width: 2, height: 1, sha256: hashBuffer(png) });

    expect(matchRendererCapability(baked.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const pkg: MotionPackage = {
      root: "/unused-no-browser-layer",
      manifest: {
        schema: "shellx-motion/package-manifest@1", id: "pkg_browser_cutout", name: "Browser cutout", motion: "motion.json",
        assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] },
      },
      motion: baked.motion,
    };
    await expect(preflightBrowserPackage(pkg)).resolves.toEqual({ ok: true, htmlEntries: [], blockedOrigins: [], warnings: [] });
  });
});
