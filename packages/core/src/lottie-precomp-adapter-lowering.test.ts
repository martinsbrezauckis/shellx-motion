import { describe, expect, it } from "vitest";
import { lowerStaticLottieToMotion } from "./adapter-diagnostics";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { loadSchemaSync, validateDocumentSync } from "./validate";

describe("Lottie GPU precomposition adapter branch", () => {
  it("selects only ty:0 sources and binds exact GPU lowering facts into diagnostics and receipts", () => {
    const sourceText = precompSource();
    const lowered = lowerStaticLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "scene.json", sourceText, normalizedPackagePath: "packages/precomp", createdAt: "2026-08-16T00:00:00.000Z" });
    expect(validateDocumentSync(loadSchemaSync("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.motion.layers).toHaveLength(2);
    expect(lowered.motion.layers.find((layer) => layer.type === "group")).toMatchObject({ name: "scene", childLayerIds: [expect.any(String)], mask: { type: "rect", inset: { right: 60, bottom: 60 } } });
    expect(lowered.diagnostics).toMatchObject({ recommendedFallbackLane: "none", lossiness: { level: "none" }, supportedFeatures: [expect.objectContaining({ feature: "lottie.composition" }), expect.objectContaining({ feature: "lottie.precomp.gpu.hold_affine_clip" })], suggestedNextAction: expect.stringContaining("persistent GPU group compositor") });
    expect(lowered.receipt).toMatchObject({
      operation: "adapter.lower", status: "passed", inputHashes: { source: expect.stringMatching(/^[0-9a-f]{64}$/) },
      output: { motionSha256: expect.stringMatching(/^[0-9a-f]{64}$/), lottieGpuPrecomposition: { sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/), loweringFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), outputMotionSha256: expect.stringMatching(/^[0-9a-f]{64}$/), budget: { usage: { groups: 1, leaves: 1, keyframes: 0, drawBatches: 2 } }, execution: expect.stringContaining("no direct Browser or Native claim") } }
    });
    expect(lowered.diagnostics.receipt.output).toMatchObject({ lottieGpuPrecomposition: { sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/), loweringFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), outputMotionSha256: expect.stringMatching(/^[0-9a-f]{64}$/), budget: { usage: { groups: 1, leaves: 1 } } } });
    const plan = compileGpuScene2dPlan(lowered.motion, 0);
    expect(plan).toMatchObject({ ok: true, plan: { groupCount: 1 } });
    if (!plan.ok) throw new Error(plan.failure.message);
    expect(plan.plan.frame.draws).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "groupStart", mask: expect.objectContaining({ x: 0, y: 0, width: 40, height: 20 }) }), expect.objectContaining({ kind: "rect" }), expect.objectContaining({ kind: "groupEnd" })]));
    expect(sourceText).toBe(precompSource());
  });

  it("keeps no-precomp imports on the legacy result shape and refuses hostile precomp semantics before output", () => {
    const ordinary = JSON.stringify({ v: "5.12.2", fr: 10, ip: 0, op: 10, w: 100, h: 80, layers: [{ ind: 1, ty: 1, nm: "Solid", ip: 0, op: 10, sw: 4, sh: 3, sc: "#ffffff" }], assets: [] });
    const ordinaryLowered = lowerStaticLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "solid.json", sourceText: ordinary, normalizedPackagePath: "packages/ordinary", createdAt: "2026-08-16T00:00:00.000Z" });
    expect(ordinaryLowered.receipt.output).not.toHaveProperty("lottieGpuPrecomposition");
    expect(ordinaryLowered.diagnostics.supportedFeatures.some((feature) => feature.feature === "lottie.precomp.gpu.hold_affine_clip")).toBe(false);

    const hostile = JSON.parse(precompSource()) as { layers: Array<Record<string, unknown>> };
    hostile.layers[0].masksProperties = [];
    const text = JSON.stringify(hostile);
    expect(() => lowerStaticLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "hostile.json", sourceText: text, normalizedPackagePath: "packages/hostile" })).toThrow("unsupported masksProperties semantics");
    expect(text).toBe(JSON.stringify(hostile));

    const invalidOpacity = JSON.parse(precompSource()) as { assets: Array<{ layers: Array<Record<string, unknown>> }> };
    invalidOpacity.assets[0].layers[0].ks = { o: { a: 0, k: 200 } };
    const opacityText = JSON.stringify(invalidOpacity);
    expect(() => lowerStaticLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "opacity.json", sourceText: opacityText, normalizedPackagePath: "packages/opacity" })).toThrow("opacity from 0 through 100");
    expect(opacityText).toBe(JSON.stringify(invalidOpacity));

    const invalidScale = JSON.parse(precompSource()) as { assets: Array<{ layers: Array<Record<string, unknown>> }> };
    invalidScale.assets[0].layers[0].ks = { s: { a: 0, k: [0, 0] } };
    const scaleText = JSON.stringify(invalidScale);
    expect(() => lowerStaticLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "scale.json", sourceText: scaleText, normalizedPackagePath: "packages/scale" })).toThrow("positive static transform scale");
    expect(scaleText).toBe(JSON.stringify(invalidScale));
  });
});

function precompSource(): string {
  return JSON.stringify({
    v: "5.12.2", nm: "GPU precomp", ddd: 0, fr: 10, ip: 0, op: 10, w: 100, h: 80,
    layers: [{ ind: 1, ty: 0, nm: "scene", refId: "scene", ip: 0, op: 10, st: 0, sr: 1, bm: 0 }],
    assets: [{ id: "scene", w: 40, h: 20, layers: [{ ind: 2, ty: 1, nm: "solid", ip: 0, op: 10, sw: 4, sh: 3, sc: "#ff0000" }] }]
  });
}
