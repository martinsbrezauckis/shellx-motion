import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards } from "./capabilities";
import { CHROMA_KEY_SCHEMA } from "./keying";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument } from "./types";

const imageResources = new Map([["assets/subject.png", {
  resourceId: "subject", assetRef: "assets/subject.png", width: 100, height: 60, sha256: "a".repeat(64)
}]]);

describe("GPU capability matching", () => {
  it.each([
    ["fixed Motion-owned material", fixedMaterial(), true],
    ["fixed-mask wipe", wipe(), true],
    ["fixed chroma threshold/spill subset", fixedChroma(), true],
    ["ellipse gradient", ellipseGradient(), false],
    ["nonstatic track matte", nonstaticMatte(), false],
    ["normal-layer vignette", normalLayerVignette(), false],
    ["video temporal motion blur", videoMotionBlur(), false],
    ["text fitting", textFit(), false],
    ["bounded screen-blended point trail", trail(), true]
  ] as const)("has the same fail-closed verdict as static and current compilation for %s", (_label, motion, expected) => {
    const match = matchRendererCapability(motion, GPU_CAPABILITY);
    const staticPlan = compileGpuSceneStaticPlan(motion);
    const currentPlan = compileGpuScene2dPlan(motion, 0, { images: imageResources });

    expect(match.ok).toBe(expected);
    expect(staticPlan.ok).toBe(expected);
    expect(currentPlan.ok).toBe(expected);
    if (!expected) {
      expect(match.unsupported).toEqual([expect.objectContaining({ feature: "gpu.scene.eligibility" })]);
    }
  });

  it("does not reject static-admitted hybrid topology before the stricter final-only resource stage", () => {
    for (const candidate of [dataOnlyHtmlHybrid(), restrictedGlslHybrid()]) {
      expect(matchRendererCapability(candidate, GPU_CAPABILITY)).toMatchObject({ ok: true, lane: "gpu", unsupported: [] });
      expect(compileGpuSceneStaticPlan(candidate)).toMatchObject({ ok: true });
    }
  });

  it.each([
    ["web", dataOnlyHtmlHybrid("web")],
    ["html", dataOnlyHtmlHybrid("html")],
    ["canvas", dataOnlyHtmlHybrid("canvas")],
    ["restricted shader", restrictedGlslHybrid()]
  ] as const)("keeps %s hybrid sources out of GPU preview while preserving static and streamed-final admission", (_label, candidate) => {
    expect(matchRendererCapability(candidate, GPU_CAPABILITY)).toMatchObject({ ok: true, lane: "gpu", unsupported: [] });
    expect(compileGpuSceneStaticPlan(candidate)).toMatchObject({ ok: true });

    const preview = matchRendererCapabilityCards(candidate, { output: "png-frame", target: "preview" });
    expect(preview.matches.find((match) => match.lane === "gpu")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({
        feature: "gpu.hybrid.final-streaming-only",
        reason: "Lane gpu supports web, html, canvas, and restricted-shader hybrid layers only for governed final video rendering."
      })]
    });

    const final = matchRendererCapabilityCards(candidate, { output: "raw-rgba", target: "final" });
    expect(final.matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: true, unsupported: [] });
  });
});

function motion(layers: MotionDocument["layers"]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gpu-capability-parity", name: "GPU capability parity",
    durationMs: 1_000, fps: 30, width: 100, height: 60, background: "transparent",
    layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" }
  };
}

function fixedMaterial(): MotionDocument {
  return motion([{
    id: "material", type: "shader", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 },
    shader: {
      schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "never-executed", seed: 7, fallbackColor: "#000000",
      gpuMaterial: { preset: "plasma", colors: ["#000000", "#00ffff", "#ffffff"] }
    }
  }]);
}

function wipe(): MotionDocument {
  return motion([{
    id: "panel", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 }, transitions: { in: { type: "wipe", durationMs: 300, direction: "left" } }
  }]);
}

function fixedChroma(): MotionDocument {
  return motion([{
    id: "subject", type: "image", assetRef: "assets/subject.png", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 },
    keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00", similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5 }
  }]);
}

function ellipseGradient(): MotionDocument {
  return motion([{
    id: "gradient", type: "shape", shape: "ellipse", fill: "#ffffff", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 }, gradient: { type: "radial", stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }
  }]);
}

function nonstaticMatte(): MotionDocument {
  return motion([
    { id: "matte", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1_000, transform: { width: 50, height: 50 }, style: { fill: "#ffffff" }, keyframes: { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 10 }] } },
    { id: "content", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { width: 100, height: 60 }, matte: { type: "alpha", sourceLayerId: "matte" } }
  ]);
}

function normalLayerVignette(): MotionDocument {
  return motion([{
    id: "panel", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 }, effects: { vignette: { amount: 0.5, softness: 0.5, color: "#000000" } }
  }]);
}

function videoMotionBlur(): MotionDocument {
  return motion([{
    id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000,
    effects: { motionBlur: { samples: 2, shutterAngle: 180 } }
  }]);
}

function textFit(): MotionDocument {
  return motion([{
    id: "title", type: "text", text: "Title", startMs: 0, durationMs: 1_000,
    style: { fontFamily: "Brand", width: 100, height: 60 }, textFit: { policy: "safe", safeAreaId: "safe" }
  }]);
}

function trail(): MotionDocument {
  return motion([{
    id: "points", type: "points", startMs: 0, durationMs: 1_000,
    pointCloud: { points: [{ x: 20, y: 20, size: 4, opacity: 1 }] }, effects: { trail: { durationMs: 200, samples: 3 } }, blendMode: "screen"
  }]);
}

function dataOnlyHtmlHybrid(type: "web" | "html" | "canvas" = "html"): MotionDocument {
  return motion([{
    id: "card", type, source: "surfaces/card.html", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 }
  }]);
}

function restrictedGlslHybrid(): MotionDocument {
  const document = motion([{
    id: "legacy", type: "shader", startMs: 0, durationMs: 1_000,
    transform: { width: 100, height: 60 },
    shader: {
      schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression",
      fragmentAssetId: "legacy-glsl", seed: 7, fallbackColor: "#000000"
    }
  }]);
  document.assets = [{
    id: "legacy-glsl", type: "shader", source: { path: "assets/legacy.glsl", mimeType: "text/x-shellx-motion-glsl" }
  }];
  return document;
}
