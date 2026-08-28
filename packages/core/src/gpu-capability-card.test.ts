import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY_CARD } from "./gpu-capability-card";

describe("GPU capability card", () => {
  it("records implemented bounded scene support without promoting unwired or unsafe paths", () => {
    const card = GPU_CAPABILITY_CARD;

    expect(card.category).toBe("preview");
    expect(card.outputs).toEqual(["png-frame", "png", "raw-rgba"]);
    expect(card.renderTargets).toEqual(["preview", "final"]);
    expect(card.layerTypes).toHaveLength(16);
    for (const layerTypes of [
      ["text", "caption", "shape", "image", "video"],
      ["web", "html", "canvas"],
      ["adjustment", "camera", "particles", "points", "shader"],
      ["scene3d", "environment", "group"]
    ]) {
      expect(card.layerTypes).toEqual(expect.arrayContaining(layerTypes));
    }

    for (const features of [
      ["text.font.family", "text.direction", "text.shaping.complex", "text.charset.non-ascii", "camera.2d"],
      ["camera.depth", "scene3d.fixed-primitives", "scene3d.gltf-mesh", "environment.rain.fixed-simulation", "environment.water.fixed-simulation"],
      ["environment.snow.fixed-simulation", "environment.fog.fixed-simulation", "shader.gpuMaterial.fixed", "mask.rect", "mask.rounded-rect"],
      ["matte.static-shape.alpha", "matte.static-shape.alpha-inverted", "matte.static-shape.luma", "matte.static-shape.luma-inverted", "effect.motionBlur.static-raster-layer", "effect.motionBlur.environment.fixed"],
      ["adjustment.effect.vignette", "adjustment.effect.filmGrain", "transition.wipe", "keying.chroma.fixed-threshold-spill", "keying.chroma.matte-cleanup.fixed-passes", "effect.trail", "effect.module.afterimage-stack.governed-local", "group.isolated", "group.nested-depth-4"],
      ["particles.fixed-field-v2", "particles.compute.fixed-analytic-field.100000-131072", "shape.path", "shape.path.reveal", "motion.behaviors@1", "video.preview.exact-time-cfr.visual-only", "hybrid.html.strict-data-only.final", "hybrid.shader.restricted-glsl-isolated-webgl.final", "delivery.raw-rgba.ffmpeg-stream", "delivery.segmented-gpu.non-hybrid", "delivery.segmented-gpu.governed-hybrid-single", "scene3d.animation.sampled.strict-browser-gpu-preview", "motion.scene3d-animation@1.strict-browser-gpu-preview"]
    ]) {
      expect(card.features).toEqual(expect.arrayContaining(features));
    }

    expect(card.features).toContain("shape.path.reveal");
    expect(card.features).toContain("hybrid.shader.restricted-glsl-isolated-webgl.final");
    expect(card.layerTypes).not.toContain("audio");
    expect(card.weaknesses.join(" ")).toContain("Source contracts are implemented");
    expect(card.strengths.join(" ")).toContain("Core maps each request once in microseconds");
    expect(card.weaknesses.join(" ")).toContain("host-owned exact-time CFR provider");
    expect(card.weaknesses.join(" ")).toContain("visual-only");
    expect(card.weaknesses.join(" ")).toContain("32 entries and 128 MiB");
    expect(card.weaknesses.join(" ")).toContain("64 MiB of in-flight RGBA");
    expect(card.weaknesses.join(" ")).toContain("Native Linux RTX 5080 rig scrub");
    expect(card.weaknesses.join(" ")).toContain("GPU post-render identity");
    expect(card.weaknesses.join(" ")).toContain("fixed image/video threshold, spill, and bounded matte-cleanup passes");
    expect(card.weaknesses.join(" ")).toContain("roto masks are refused");
    expect(card.weaknesses.join(" ")).toContain("100,000..131,072 particles");
    expect(card.weaknesses.join(" ")).toContain("trail ribbon/caps inherit declared GPU compositor blend modes");
    expect(card.weaknesses.join(" ")).toContain("non-trail spatial effects remain refused");
    expect(card.weaknesses.join(" ")).toContain("axis-plane collision");
    expect(card.weaknesses.join(" ")).toContain("not arbitrary compute");
    expect(card.weaknesses.join(" ")).toContain("arbitrary WGSL");
    expect(card.weaknesses.join(" ")).toContain("host-owned segmented delivery");
    expect(card.weaknesses.join(" ")).toContain("V25-B2 restricted-GLSL interrupted-resume and cold replay on the qualified Linux RTX 5080 rig");
    expect(card.strengths.join(" ")).toContain("human-installed governed local afterimage modules");
    expect(card.weaknesses.join(" ")).toContain("Native module-on/off and byte-identical cold final passed on the qualified Linux RTX 5080 rig");
    expect(card.weaknesses.join(" ")).toContain("not package WGSL, JavaScript, native code");
    expect(card.weaknesses.join(" ")).toContain("target preview, output png-frame");
    expect(card.weaknesses.join(" ")).toContain("4 scene layers, 32 objects, 8192 mesh vertices, 49152 mesh indices, 64 tracks, 2048 keys, and 256 frame work units");
    expect(card.weaknesses.join(" ")).toContain("not installed WebGPU or pixel proof");
    expect(card.runtime.setupHint).toContain("not hardware-qualification evidence");
  });
});
