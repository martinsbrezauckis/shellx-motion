import { describe, expect, it } from "vitest";
import { compileGpuSceneText, type GpuScene2dFontResources } from "./gpu-scene-text";
import type { MotionDocument, MotionLayer } from "./types";

const motion: MotionDocument = {
  schema: "shellx-motion/motion@1", id: "text_color", name: "Text color", durationMs: 1_000,
  fps: 30, width: 100, height: 60, assets: [], layers: [],
  provenance: { sourceApp: "test", createdBy: "test" }
};
const fonts: GpuScene2dFontResources = new Map([["brand", [{
  resourceId: "font-brand", assetRef: "assets/brand.woff2", family: "Brand", weight: 400,
  style: "normal", mimeType: "font/woff2", sha256: "a".repeat(64)
}]]]);

function textLayer(color: string): MotionLayer {
  return {
    id: "title", type: "text", text: "GPU", startMs: 0, durationMs: 1_000,
    transform: { width: 80, height: 30 }, style: { fontFamily: "Brand", color }
  };
}

describe("GPU text color lowering", () => {
  it("refuses an over-bound color before numeric lowering", () => {
    expect(compileGpuSceneText(motion, textLayer(`rgb(0,0,0)${" ".repeat(128)}`), fonts)).toMatchObject({
      ok: false, failure: { code: "gpu_unsupported_color", layerId: "title" }
    });
  });

  it("preserves legacy four-component rgb text colors", () => {
    for (const color of ["rgb(255,0,0,0.5)", "rgb(255/0/0/50%)"]) {
      expect(compileGpuSceneText(motion, textLayer(color), fonts)).toMatchObject({
        ok: true, draw: { color: { r: 1, g: 0, b: 0, a: 0.5 } }
      });
    }
  });
});
