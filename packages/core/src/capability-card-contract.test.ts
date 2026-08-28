import { describe, expect, it } from "vitest";
import {
  assertRendererTypographyCapabilityRegistration,
  listRendererCapabilityCards,
  matchRendererCapabilityCards,
  rendererCapabilityForLane
} from "./capabilities";
import { SUPPORTED_KEYFRAME_TARGET_LIST } from "./keyframe-targets";
import type { MotionDocument, RendererCapabilityCard } from "./types";

describe("renderer capability card contract", () => {
  it("advertises exact browser features through the runtime resolver", () => {
    const browser = listRendererCapabilityCards().find((card) => card.lane === "browser");

    expect(browser).toMatchObject({
      role: "frame-producer",
      visualFeatureSupport: "direct",
      typography: {
        mode: "manifest-bound-fallback-attested",
        fontProvenance: "manifest-bound",
        fontLoading: "runtime-verified",
        fallbackEvidence: "metric-probe",
        conformanceFixtureIds: ["browser-generated-font-provenance"]
      },
      runtime: { readiness: { command: "motion.platform.requirements", tools: ["chromium"] } }
    });
    expect(browser?.features.some((feature) => feature.includes("*"))).toBe(false);
    expect(browser?.features).toEqual(expect.arrayContaining([
      "shape.ellipse", "keyframe.fill", "keyframe.shader.uniform", "transition.wipe",
      ...SUPPORTED_KEYFRAME_TARGET_LIST
        .filter((target) => target !== "volume" && target !== "pan")
        .map((target) => `keyframe.${target}`)
    ]));
    expect(browser?.features).not.toEqual(expect.arrayContaining(["keyframe.volume", "keyframe.pan"]));
    expect(browser?.weaknesses.join(" ")).toContain("cooperative browser-session fallback");
    expect(browser?.weaknesses.join(" ")).toContain("killTree false");
  });

  it("rejects a future GPU frame producer even if it borrows browser's narrower fallback-attestation card", () => {
    const browser = listRendererCapabilityCards().find((card) => card.lane === "browser");
    if (!browser) throw new Error("browser capability card is missing");
    const unprovenGpu: RendererCapabilityCard = {
      ...browser,
      id: "renderer.gpu",
      label: "Future GPU",
      lane: "gpu",
      typography: undefined
    };

    expect(() => assertRendererTypographyCapabilityRegistration([unprovenGpu])).toThrow(
      "cannot advertise text until manifest-font provenance, loading, fallback, and complex-shaping proof are registered"
    );
    expect(() => assertRendererTypographyCapabilityRegistration([browser])).not.toThrow();
  });

  it("registers the strict GPU scene breadth and raw-frame final transport without claiming unavailable workflows", () => {
    const gpu = listRendererCapabilityCards().find((card) => card.lane === "gpu");
    expect(gpu).toMatchObject({
      id: "renderer.gpu",
      role: "frame-producer",
      category: "preview",
      layerTypes: ["text", "shape", "image", "video", "caption", "web", "html", "canvas", "adjustment", "camera", "particles", "points", "shader", "scene3d", "environment", "group"],
      outputs: ["png-frame", "png", "raw-rgba"],
      renderTargets: ["preview", "final"],
      runtime: { readiness: { command: "motion.platform.requirements", tools: ["chromium"] } }
    });
    expect(gpu?.weaknesses.join(" ")).toContain("native multi-host qualification, release receipts, and performance characterization are not complete");
    expect(gpu?.features).toEqual(expect.arrayContaining(["group.nested-depth-4", "shader.gpuMaterial.fixed", "effect.motionBlur.static-raster-layer", "effect.motionBlur.environment.fixed", "particles.compute.fixed-analytic-field.100000-131072", "shape.path.reveal", "video.preview.exact-time-cfr.visual-only", "hybrid.html.strict-data-only.final", "hybrid.shader.restricted-glsl-isolated-webgl.final", "delivery.segmented-gpu.non-hybrid", "delivery.segmented-gpu.governed-hybrid-single"]));
    expect(gpu?.outputs).toContain("raw-rgba");
  });

  it("models FFmpeg delivery separately from compatible frame production", () => {
    const ffmpeg = listRendererCapabilityCards().find((card) => card.lane === "ffmpeg");

    expect(ffmpeg).toMatchObject({
      role: "encoder",
      visualFeatureSupport: "inherited-from-frame-lane",
      frameInputs: ["png-sequence", "raw-rgba"],
      features: expect.arrayContaining(["encode.png-sequence", "encode.raw-rgba-stream", "delivery.mp4.h264"]),
      runtime: { readiness: { command: "motion.platform.requirements", tools: ["ffmpeg", "ffprobe"] } }
    });
    expect(ffmpeg?.features).not.toContain("*");
    expect(rendererCapabilityForLane("ffmpeg").visualFeatureSupport).toBe("inherited-from-frame-lane");
  });

  it("limits Lottie unsupported diagnostics to variants outside its named fixture-backed matte/effect subset", () => {
    const lottie = listRendererCapabilityCards().find((card) => card.id === "adapter.lottie");

    expect(lottie?.features).toEqual(expect.arrayContaining([
      "lottie.trackMatte.alpha", "lottie.trackMatte.alphaInverted", "lottie.trackMatte.luma", "lottie.trackMatte.lumaInverted",
      "lottie.effect.gaussianBlur", "lottie.effect.brightnessContrast", "dotlottie.theme.static-subset"
    ]));
    expect(lottie?.adapter?.unsupportedFeatureClasses).toEqual(expect.arrayContaining([
      "track-matte modes outside alpha, alphaInverted, luma, and lumaInverted",
      "effects outside gaussian blur and brightness/contrast"
    ]));
    expect(lottie?.adapter?.unsupportedFeatureClasses).not.toEqual(expect.arrayContaining(["track mattes", "effects"]));
    expect(lottie?.weaknesses).toEqual(expect.arrayContaining([
      expect.stringMatching(/static Color, Scalar, Position, and Vector slot subset/),
      expect.stringMatching(/expressions, animated rules, unsupported types, and unmatched slots refuse/),
      expect.stringMatching(/State machines are preserved but never executed/)
    ]));
  });

  it("does not turn explicit encoder delivery features into a visual false-green", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "capability-contract",
      name: "Capability contract",
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 1000,
      background: "#000000",
      layers: [{ id: "unsupported-shape", type: "shape", shape: "hexagon", startMs: 0, durationMs: 1000 }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "capability-card-contract.test" }
    };

    const result = matchRendererCapabilityCards(motion, { output: "mp4-h264", target: "final" });

    expect(result.matches.find((match) => match.lane === "browser")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "shape.hexagon" })]
    });
    expect(result.matches.find((match) => match.lane === "ffmpeg")).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining([expect.stringContaining("requires a compatible png-sequence or raw-rgba producer")])
    });
    expect(result.recommendedLane).not.toBe("ffmpeg");
  });
});
