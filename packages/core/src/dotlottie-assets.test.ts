import { describe, expect, it } from "vitest";
import { readSelectedDotLottieAssets } from "./dotlottie-assets";
import { DEFAULT_DOTLOTTIE_LIMITS } from "./dotlottie-types";

describe("selected dotLottie asset discovery", () => {
  it("keeps ordinary data-only dotLottie selections compatible", () => {
    expect(readAssets({
      v: "5.12.2",
      w: 100,
      h: 100,
      fr: 30,
      ip: 0,
      op: 30,
      assets: [],
      layers: [{ ind: 1, ty: 1, nm: "Background" }]
    })).toEqual({ images: [], fonts: [] });
  });

  it("refuses asset indexing and aggregate selected-layer work before expansion", () => {
    expect(() => readAssets({
      w: 100,
      h: 100,
      fr: 30,
      ip: 0,
      op: 30,
      assets: Array.from({ length: 257 }, (_, index) => ({ id: `asset-${index}` })),
      layers: []
    })).toThrow("at most 256 assets");

    const assets = Array.from({ length: 64 }, (_, index) => ({
      id: `scene-${index}`,
      layers: Array.from({ length: 128 }, () => ({ ty: 1 }))
    }));
    expect(() => readAssets({
      w: 100,
      h: 100,
      fr: 30,
      ip: 0,
      op: 30,
      assets,
      layers: assets.map((asset) => ({ ty: 0, refId: asset.id }))
    })).toThrow("4096-work limit");
  });
});

function readAssets(animation: Record<string, unknown>) {
  return readSelectedDotLottieAssets({
    animationText: JSON.stringify(animation),
    version: "2",
    entries: [],
    archive: Buffer.alloc(0),
    limits: DEFAULT_DOTLOTTIE_LIMITS
  });
}
