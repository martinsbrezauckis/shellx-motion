import { describe, expect, it } from "vitest";
import { compileGpuFramePlan } from "./gpu-frame-intent";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneParticles } from "./gpu-scene-points";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { evaluateMotionParticles, particleFieldDeflection } from "./particle-evaluator";
import { createMotionParticleEvaluatorReference, evaluateMotionParticlesReference, particleFieldDeflectionReference } from "./particle-evaluator-reference";
import { setTimelineLayerRichControl } from "./rich-controls";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionParticleEmitter } from "./types";

describe("particle-field@2 fixed high-density contract", () => {
  it("admits the closed mechanics, multi-origins, analytic trail, and fixed shading only on high-density circles", async () => {
    const schema = await loadSchema("motion");
    expect(await validateDocument(schema, document())).toEqual({ ok: true });

    const lowDensity = document();
    lowDensity.layers[0].emitter!.count = 1_000;
    expect(await validateDocument(schema, lowDensity)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([{ path: "/layers/0/emitter/field", message: expect.stringContaining("100000..131072 circular high-density route") }])
    });

    const nonCircle = document();
    nonCircle.layers[0].emitter!.shape = "square";
    expect(await validateDocument(schema, nonCircle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([{ path: "/layers/0/emitter/field", message: expect.stringContaining("100000..131072 circular high-density route") }])
    });
  });

  it("lowers an exact closed v2 descriptor with explicit 16 MiB retained memory and pass evidence", () => {
    const motion = document(), layer = motion.layers[0]!;
    const lowered = compileGpuSceneParticles(layer, 600, motion);
    expect(lowered).toMatchObject({ ok: true, particleCount: 131_072 });
    if (!lowered.ok) return;
    const frame = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: motion.width, height: motion.height, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: lowered.draws });
    expect(frame.draws[0]).toMatchObject({
      kind: "particleCompute", schema: "shellx-motion/gpu-compute-particle-field@2", origins: [{ x: 0.2, y: 0.7, directionOffsetDeg: -25, speedScale: 0.8 }, { x: 0.8, y: 0.3, directionOffsetDeg: 45, speedScale: 1.2 }],
      trail: { durationMs: 480, samples: 4, opacity: 0.7 }, shading: { mode: "glow", sizeJitter: 0.25, opacityJitter: 0.15, glow: 0.8 }, computeDispatchCount: 1, rasterPassCount: 2, instanceBytes: 64, retainedBufferCount: 2, retainedInstanceBytes: 16 * 1024 * 1024
    });
    expect(frame.budget).toMatchObject({ computeParticleFieldCount: 1, computeParticleCount: 131_072, computeParticleBufferBytes: 16 * 1024 * 1024, computeParticleComputeDispatchCount: 1, computeParticleRasterPassCount: 2 });
  });

  it("lowers one authored rounded-rect mask against the exact scaled v2 canvas bounds", () => {
    const motion = document();
    const layer = motion.layers[0]!;
    layer.transform = { x: 10, y: 20, width: 320, height: 180, originX: 160, originY: 90, scale: 1.25, rotation: 15 };
    layer.mask = { type: "rounded-rect", inset: { top: 6, right: 8, bottom: 10, left: 4 }, radius: 24, opacity: 0.8, featherPx: 3 };
    const result = compileGpuScene2dPlan(motion, 600);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      maskCount: 1,
      matteCount: 0,
      frame: {
        draws: [expect.objectContaining({
          kind: "particleCompute", schema: "shellx-motion/gpu-compute-particle-field@2",
          mask: { shape: "rect", x: -26, y: 3.5, width: 388, height: 209, radius: 24, rotationDeg: 15, pivotX: 170, pivotY: 110, inverted: false, opacity: 0.8, featherPx: 3 }
        })],
        budget: { computeParticleFieldCount: 1, computeParticleBufferBytes: 16 * 1024 * 1024, maskCount: 1, maskUniformBytes: 48, compositeCount: 1, compositeUniformBytes: 64, compositeIntermediateTextureBytes: 691_200, estimatedPlanBytes: 448 }
      }
    });
  });

  it("keeps masks and mattes refused for v1 or low-density particles and refuses prohibited v2 composites", () => {
    const v1 = document();
    v1.layers[0]!.emitter!.field = { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.2, softening: 0.2 }] };
    v1.layers[0]!.mask = { type: "rect" };
    const lowDensity = document();
    lowDensity.layers[0]!.emitter!.count = 1_000;
    lowDensity.layers[0]!.mask = { type: "rect" };
    for (const motion of [v1, lowDensity]) {
      expect(compileGpuScene2dPlan(motion, 600)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("point and particle layers do not yet support masks or mattes") } });
    }
    const combined = document();
    combined.layers[0]!.mask = { type: "rect" };
    combined.layers[0]!.matte = { type: "alpha", sourceLayerId: "unused-source" };
    expect(compileGpuSceneStaticPlan(combined)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("cannot combine a mask and track matte") } });
    for (const mutate of [
      (layer: MotionDocument["layers"][number]) => { layer.effects = { blur: 1 }; },
      (layer: MotionDocument["layers"][number]) => { layer.depth = 0; },
      (layer: MotionDocument["layers"][number]) => { layer.transitions = { in: { type: "wipe", durationMs: 100, direction: "left" } }; }
    ]) {
      const motion = document();
      mutate(motion.layers[0]!);
      expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("requires normal blend with no effects, depth, or wipe transition") } });
    }
  });

  it("refuses unknown v2 descriptor and nested-record keys rather than stripping them", () => {
    const motion = document(), lowered = compileGpuSceneParticles(motion.layers[0]!, 600, motion);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    const cases: Array<(draw: Record<string, unknown>) => void> = [
      (draw) => { draw.kernel = "unbounded"; },
      (draw) => { ((draw.sources as Array<Record<string, unknown>>)[0]!).formula = "arbitrary"; },
      (draw) => { ((draw.origins as Array<Record<string, unknown>>)[0]!).selector = "random"; },
      (draw) => { (draw.shading as Record<string, unknown>).shader = "custom"; }
    ];
    for (const mutate of cases) {
      const draws = structuredClone(lowered.draws), draw = draws[0] as unknown as Record<string, unknown>;
      mutate(draw);
      expect(() => compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: motion.width, height: motion.height, clear: { r: 0, g: 0, b: 0, a: 1 }, draws })).toThrow(/not supported by the fixed v2 particle ABI/);
    }
  });

  it("admits the v2 renderer join with its fixed retained static budget", () => {
    expect(compileGpuSceneStaticPlan(document())).toMatchObject({
      ok: true,
      plan: { maxima: { maxComputeParticleFieldCount: 1, maxComputeParticleCount: 131_072, maxComputeParticleInstanceBytes: 64, maxComputeParticleRetainedMemoryBytes: 16 * 1024 * 1024, maxComputeParticleComputeDispatchCount: 1, maxComputeParticleRasterPassCount: 2 } }
    });
  });

  it("is deterministic in the private reference evaluator without treating it as public-lane support", () => {
    const emitter = { ...document().layers[0]!.emitter!, count: 4 } as MotionParticleEmitter;
    const input = { emitter, atMs: 600, startMs: 0, width: 320, height: 180 };
    expect(() => evaluateMotionParticles(input)).toThrow(/requires the fixed high-density GPU renderer ABI/);
    expect(() => particleFieldDeflection(emitter, 0.75, 0.25, 0.5)).toThrow(/requires the fixed high-density GPU renderer ABI/);
    expect(evaluateMotionParticlesReference(input)).toEqual(evaluateMotionParticlesReference(input));
    expect(evaluateMotionParticlesReference(input)).not.toEqual(evaluateMotionParticlesReference({ ...input, atMs: 150 }));
    const lowMotion = document(); lowMotion.layers[0]!.emitter!.count = 4;
    expect(compileGpuSceneParticles(lowMotion.layers[0]!, 600, lowMotion)).toMatchObject({
      ok: false,
      failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("cannot lower shellx-motion/particle-field@2 through the low-count CPU path") }
    });
  });

  it("keeps collision deliberately limited to a deterministic axis-aligned plane", () => {
    const emitter: MotionParticleEmitter = {
      seed: 7, count: 1, lifetimeMs: 1_000, shape: "circle", color: "#ffffff",
      field: { schema: "shellx-motion/particle-field@2", sources: [{ kind: "collision", axis: "x", position: 0.5, restitution: 0.5 }] }
    };
    expect(particleFieldDeflectionReference(emitter, 0.75, 0.25, 0.5)).toEqual({ x: -0.375, y: 0 });
  });

  it("fires impact pulses for every particle on the same canonical layer timeline", () => {
    const emitter: MotionParticleEmitter = {
      seed: 7, count: 4, lifetimeMs: 1_000, shape: "circle", color: "#ffffff", secondaryColor: "#ffffff", minSize: 2, maxSize: 2, minSpeed: 0, maxSpeed: 0, gravity: 0, fadeOut: false,
      field: { schema: "shellx-motion/particle-field@2", sources: [{ kind: "impact", centerX: 0.5, centerY: 0.25, radius: 0.5, strength: 0.4, startProgress: 0.25, durationProgress: 0.5 }] }
    };
    const evaluator = createMotionParticleEvaluatorReference({ emitter, atMs: 0, startMs: 0, width: 100, height: 100 });
    const positionsAt = (atMs: number) => Array.from({ length: 4 }, (_, index) => {
      const sample = evaluator.sampleAt(index, atMs); return [sample.x, sample.y];
    });
    const beginning = positionsAt(250), peak = positionsAt(500), ending = positionsAt(750);
    expect(new Set(beginning.map((position) => position.join(","))).size).toBe(1);
    expect(new Set(ending.map((position) => position.join(","))).size).toBe(1);
    expect(beginning).toEqual(ending);
    expect(peak).not.toEqual(beginning);
  });

  it("keeps an impact timing edit atomic when the paired progress values would exceed one", () => {
    expect(() => setTimelineLayerRichControl(document(), {
      layerId: "field", path: "emitter.field.sources.3.startProgress", value: 0.7
    })).toThrow(/must keep impact startProgress \+ durationProgress within 1/);
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "particle_v2", name: "Particle v2", durationMs: 2_000, fps: 30, width: 320, height: 180, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "field", type: "particles", startMs: 0, durationMs: 2_000, transform: { width: 320, height: 180, originX: 160, originY: 90 },
      emitter: {
        seed: 20260815, count: 131_072, lifetimeMs: 1_200, shape: "circle", color: "#8be9fd", secondaryColor: "#ff79c6", minSize: 2, maxSize: 8, minSpeed: 40, maxSpeed: 180, direction: -90, spread: 80, gravity: 30, fadeOut: true,
        field: { schema: "shellx-motion/particle-field@2", sources: [
          { kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.35, softening: 0.2 },
          { kind: "flow", angleDeg: 15, strength: 0.18 },
          { kind: "turbulence", scale: 1.4, strength: 0.22 },
          { kind: "impact", centerX: 0.55, centerY: 0.45, radius: 0.3, strength: 0.7, startProgress: 0.2, durationProgress: 0.4 }
        ] },
        origins: [{ x: 0.2, y: 0.7, weight: 0.6, directionOffsetDeg: -25, speedScale: 0.8 }, { x: 0.8, y: 0.3, weight: 0.4, directionOffsetDeg: 45, speedScale: 1.2 }],
        trail: { durationMs: 480, samples: 4, opacity: 0.7 }, shading: { mode: "glow", sizeJitter: 0.25, opacityJitter: 0.15, glow: 0.8 }
      }
    }]
  };
}
