import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { hasLottiePrecompLayers, lowerLottieGpuPrecomps, type LottieGpuPrecompLeafContext } from "./lottie-precomp-gpu-lowering";
import type { MotionDocument, MotionLayer } from "./types";

describe("Lottie GPU precomposition lowering", () => {
  it("does not take the dedicated branch for an ordinary Lottie document", () => {
    const source = document({ layers: [solid(1)] });
    expect(hasLottiePrecompLayers(JSON.parse(source))).toBe(false);
    expect(lowerLottieGpuPrecomps({ sourceText: source, baseMotion: baseMotion(), lowerLeaf: () => { throw new Error("must not lower a no-precomp source"); } })).toBeNull();
  });

  it("emits nested local groups with origin-zero clips, source z-order, and hold affine trajectories", () => {
    const source = document({
      layers: [precomp("scene", 1, { ks: {
        a: property([10, 5]),
        p: { a: 1, k: [{ t: 0, s: [50, 30], h: 1 }, { t: 5, s: [70, 30] }] },
        s: property([200, 200]), r: property(90), o: property(80)
      } })],
      assets: [
        asset("scene", 40, 20, [precomp("tile", 2), solid(3, "back")]),
        asset("tile", 12, 8, [solid(4, "front")])
      ]
    });
    const lowered = required(lowerLottieGpuPrecomps({ sourceText: source, baseMotion: baseMotion(), lowerLeaf }));
    const scene = lowered.motion.layers.find((layer) => layer.name === "scene");
    const tile = lowered.motion.layers.find((layer) => layer.name === "tile");
    expect(scene).toMatchObject({ type: "group", startMs: 0, durationMs: 1_000, childLayerIds: expect.any(Array), transform: { x: 40, y: 25, originX: 10, originY: 5, scale: 2, rotation: 90, opacity: 0.8 }, mask: { type: "rect", inset: { right: 60, bottom: 60 } } });
    expect(tile).toMatchObject({ type: "group", childLayerIds: expect.any(Array), mask: { type: "rect", inset: { right: 88, bottom: 72 } } });
    expect(scene?.childLayerIds).toHaveLength(2);
    expect(lowered.motion.layers.find((layer) => layer.id === scene?.childLayerIds?.[0])?.name).toBe("back");
    expect(scene?.childLayerIds?.[1]).toBe(tile?.id);
    expect(scene?.keyframes).toMatchObject({
      "transform.x": [{ atMs: 0, value: 40, easing: "hold" }, { atMs: 500, value: 60, easing: "hold" }],
      "transform.scale": [{ atMs: 0, value: 2, easing: "hold" }, { atMs: 500, value: 2, easing: "hold" }]
    });
    expect(lowered).toMatchObject({
      schema: "shellx-motion/lottie-gpu-precomp-lowering@1",
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      loweringFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputMotionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      budget: { limits: { groups: 64, leaves: 512, keyframes: 5120, drawBatches: 2048 }, usage: { groups: 2, leaves: 2, keyframes: 10, drawBatches: 4 } }
    });
    expect(lowered.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: "exact", code: "lottie.precomp.gpu.hold_affine_clip", message: expect.stringContaining("persistent GPU group compositor") })]));

    const beforeHold = requiredPlan(lowered.motion, 499);
    const afterHold = requiredPlan(lowered.motion, 500);
    expect(beforeHold.frame.draws.map((draw) => draw.kind)).toEqual(["groupStart", "rect", "groupStart", "rect", "groupEnd", "groupEnd"]);
    expect(beforeHold.frame.draws[0]).toMatchObject({ kind: "groupStart", x: 40, y: 25, scale: 2, rotationDeg: 90, opacity: 0.8, mask: { shape: "rect", x: 0, y: 0, width: 40, height: 20 } });
    expect(afterHold.frame.draws[0]).toMatchObject({ kind: "groupStart", x: 60, y: 25, scale: 2, rotationDeg: 90, opacity: 0.8, mask: { shape: "rect", x: 0, y: 0, width: 40, height: 20 } });
    // The group opener's local rect mask is emitted ahead of its transform
    // marker; the persistent GPU compositor applies it before group compositing.
    expect(beforeHold.frame.draws[0]).toMatchObject({ drawCount: 4 });
  });

  it("refuses unsupported leaves, oversize local clips, nonuniform affine data, and ambiguous frame clocks without changing source bytes", () => {
    const cases = [
      { mutate: (value: any) => { value.assets[0].layers = [{ ind: 2, ty: 3, ip: 0, op: 10 }]; }, text: "unsupported layer type" },
      { mutate: (value: any) => { value.assets[0].w = 101; }, text: "clip exceeds the root GPU surface" },
      { mutate: (value: any) => { value.layers[0].ks = { s: property([100, 80]) }; }, text: "positive uniform scale" },
      { mutate: (value: any) => { value.assets[0].layers = Array.from({ length: 129 }, (_, index) => solid(index + 2)); }, text: "at most 128 entries" },
      { mutate: (value: any) => { value.fr = 30; value.layers[0].ks = { p: { a: 1, k: [{ t: 0, s: [0, 0], h: 1 }, { t: 1, s: [1, 0] }] } }; }, text: "cannot map losslessly" }
    ];
    for (const entry of cases) {
      const value = JSON.parse(document()) as Record<string, unknown>;
      entry.mutate(value);
      const source = JSON.stringify(value);
      expect(() => lowerLottieGpuPrecomps({ sourceText: source, baseMotion: baseMotion(), lowerLeaf })).toThrow(entry.text);
      expect(source).toBe(JSON.stringify(value));
    }
  });

  it("intersects nested local precomposition windows before rebasing child Motion time", () => {
    const source = document({
      op: 30,
      layers: [precomp("parent", 1, { ip: 10, op: 20 })],
      assets: [
        asset("parent", 40, 20, [precomp("child", 2, { ip: 0, op: 30 })]),
        asset("child", 12, 8, [solid(3, "inside", { ip: 0, op: 30 })])
      ]
    });
    const lowered = required(lowerLottieGpuPrecomps({ sourceText: source, baseMotion: { ...baseMotion(), durationMs: 3_000 }, lowerLeaf }));
    const parent = lowered.motion.layers.find((layer) => layer.name === "parent");
    const child = lowered.motion.layers.find((layer) => layer.name === "child");
    const inside = lowered.motion.layers.find((layer) => layer.name === "inside");

    expect(parent).toMatchObject({ type: "group", startMs: 1_000, durationMs: 1_000, childLayerIds: [child?.id] });
    expect(child).toMatchObject({ type: "group", startMs: 0, durationMs: 1_000, childLayerIds: [inside?.id] });
    expect(inside).toMatchObject({ startMs: 0, durationMs: 1_000 });
    expect(lowered.motion.layers.filter((layer) => layer.type === "group")).toHaveLength(2);
    expect(source).toContain('"ip":10');
  });

  it("binds the admitted group count and derived draw usage into the lowering budget", () => {
    const source = document({
      layers: Array.from({ length: 64 }, (_, index) => precomp("scene", index + 1)),
      assets: [asset("scene", 4, 3, [solid(2, "one")])]
    });
    const lowered = required(lowerLottieGpuPrecomps({ sourceText: source, baseMotion: baseMotion(), lowerLeaf }));
    expect(lowered.budget).toMatchObject({
      limits: { groups: 64, drawBatches: 2_048 },
      usage: { groups: 64, leaves: 64, drawBatches: 128 }
    });
    expect(lowered.motion.layers).toHaveLength(128);
  });
});

function baseMotion(): Omit<MotionDocument, "layers"> {
  return { schema: "shellx-motion/motion@1", id: "lottie-gpu", name: "Lottie GPU", durationMs: 1_000, fps: 10, width: 100, height: 80, assets: [], provenance: { sourceApp: "lottie", createdBy: "test" } };
}
function lowerLeaf(context: LottieGpuPrecompLeafContext): MotionLayer[] {
  const name = typeof context.layer.nm === "string" ? context.layer.nm : `layer-${context.index}`;
  return [{ id: name, name, type: "shape", shape: "rect", startMs: 0, durationMs: context.compositionDurationMs, transform: { x: 0, y: 0, width: 4, height: 3 }, style: { fill: "#ff0000" } }];
}
function document(overrides: Record<string, unknown> = {}): string { return JSON.stringify({ v: "5.12.2", fr: 10, ip: 0, op: 10, w: 100, h: 80, layers: [precomp("scene", 1)], assets: [asset("scene", 40, 20, [solid(2)])], ...overrides }); }
function precomp(refId: string, ind: number, overrides: Record<string, unknown> = {}) { return { ind, ty: 0, nm: refId, refId, ip: 0, op: 10, st: 0, sr: 1, bm: 0, ...overrides }; }
function asset(id: string, w: number, h: number, layers: unknown[]) { return { id, w, h, layers }; }
function solid(ind: number, nm = `solid-${ind}`, overrides: Record<string, unknown> = {}) { return { ind, ty: 1, nm, ip: 0, op: 10, ...overrides }; }
function property(value: number | number[]) { return { a: 0, k: value }; }
function required<T>(value: T | null): T { if (value === null) throw new Error("expected the precomposition lowering branch"); return value; }
function requiredPlan(motion: MotionDocument, atMs: number) { const plan = compileGpuScene2dPlan(motion, atMs); if (!plan.ok) throw new Error(plan.failure.message); return plan.plan; }
