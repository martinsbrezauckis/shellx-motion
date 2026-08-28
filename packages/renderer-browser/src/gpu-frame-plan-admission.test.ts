import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BROWSER_CAPABILITY, canonicalJson, matchRendererCapability } from "@shellx-motion/core";
import { admitInternalGpuFramePlan } from "./gpu-frame-plan-admission";
import { admitGpuTemporalGrammar } from "./gpu-frame-temporal-admission";
import type { InternalGpuFramePlan } from "./gpu-runtime-types";
import { createGpuPageAfterimageStackFixture } from "./unadopted/gpu-page-afterimage-stack.test-support";

interface CoreGpuFrameModule {
  GPU_FRAME_INTENT_SCHEMA: string;
  compileGpuFramePlan(input: unknown): InternalGpuFramePlan;
}

async function compileCoreComputePlan(): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-scene-2d-plan.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as { compileGpuScene2dPlan(motion: unknown, atMs: number): { ok: boolean; plan?: { frame: InternalGpuFramePlan } } };
  const atMs = 0;
  const result = core.compileGpuScene2dPlan({
    schema: "shellx-motion/motion@1", id: "compute_field", name: "Compute field", durationMs: 2_000, fps: 30, width: 80, height: 40, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "dust", type: "particles", startMs: 0, durationMs: 2_000, transform: { width: 80, height: 40, originX: 40, originY: 20 }, emitter: { seed: 71, count: 100_000, lifetimeMs: 0.000001, shape: "circle", color: "#ff8040", secondaryColor: "#40a0ff", minSize: 4, maxSize: 8, minSpeed: 0, maxSpeed: 0, direction: -70, spread: 0, gravity: -5_000, fadeOut: true, field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.25, centerY: 0.75, strength: -1, softening: 0.01 }] } } }]
  }, atMs);
  if (!result.ok || !result.plan) throw new Error("Core compute fixture did not compile.");
  return result.plan.frame;
}

async function compileCoreAuthoredShapeGeometryPlan(): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-scene-2d-plan.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as { compileGpuScene2dPlan(motion: unknown, atMs: number): { ok: boolean; plan?: { frame: InternalGpuFramePlan } } };
  const atMs = 0;
  const viewBox = { x: 0, y: 0, width: 100, height: 100 }, base = { schema: "shellx-motion/shape-geometry@1", viewBox };
  const layer = (id: string, x: number, y: number, geometry: Record<string, unknown>, style: Record<string, unknown>) => ({ id, type: "shape", startMs: 0, durationMs: 1_000, transform: { x, y, width: 40, height: 30 }, geometry: { ...base, ...geometry }, style });
  const result = core.compileGpuScene2dPlan({
    schema: "shellx-motion/motion@1", id: "geometry", name: "Geometry", durationMs: 1_000, fps: 30, width: 120, height: 80, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      layer("line", 0, 0, { kind: "line", points: [{ x: 5, y: 50 }, { x: 95, y: 50 }] }, { stroke: "#ff0000", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter", strokeDasharray: [4, 2, 1], strokeDashoffset: 1 }),
      layer("polyline", 40, 0, { kind: "polyline", points: [{ x: 5, y: 80 }, { x: 50, y: 20 }, { x: 95, y: 80 }] }, { stroke: "#00ff00", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter" }),
      layer("polygon", 80, 0, { kind: "polygon", points: [{ x: 5, y: 5 }, { x: 95, y: 5 }, { x: 50, y: 95 }] }, { fill: "#0000ff" }),
      layer("arc", 0, 35, { kind: "arc", center: { x: 50, y: 50 }, radius: 40, startAngleDeg: 0, sweepAngleDeg: 120 }, { stroke: "#ffff00", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter" }),
      layer("sector", 40, 35, { kind: "sector", center: { x: 50, y: 50 }, radius: 40, startAngleDeg: 0, sweepAngleDeg: 120, innerRadius: 10 }, { fill: "#00ffff" }),
      layer("path", 80, 35, { kind: "path", data: "M 5 5 L 95 5 L 95 95 L 5 95 Z" }, { fill: "#ff00ff" })
    ]
  }, atMs);
  if (!result.ok || !result.plan) throw new Error("Core v1 geometry fixture did not compile.");
  return result.plan.frame;
}

async function compileCorePlan(): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-frame-intent.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as CoreGpuFrameModule;
  return core.compileGpuFramePlan({
    schema: core.GPU_FRAME_INTENT_SCHEMA,
    width: 32,
    height: 16,
    clear: { r: 0, g: 0, b: 0, a: 1 },
    draws: [
      { kind: "rect", id: "plate", x: 2, y: 3, width: 10, height: 4, color: { r: 1, g: 0.5, b: 0, a: 0.75 }, mask: { shape: "rect", x: 3, y: 3, width: 8, height: 4, radius: 1, rotationDeg: 0, pivotX: 7, pivotY: 5, inverted: false, opacity: 1, featherPx: 1 } },
      { kind: "motionBlurStart", id: "sweep.motion-blur", sampleCount: 2, drawCount: 2, shutterAngle: 180, shutterDurationMs: 16.667, blendMode: "normal", effects: null },
      { kind: "rect", id: "sweep.sample-0.0", blendMode: "normal", effects: null, x: 1, y: 1, width: 2, height: 2, color: { r: 1, g: 0, b: 0, a: 0.5 } },
      { kind: "rect", id: "sweep.sample-1.0", blendMode: "normal", effects: null, x: 3, y: 1, width: 2, height: 2, color: { r: 1, g: 0, b: 0, a: 0.5 } },
      { kind: "motionBlurEnd", id: "sweep.motion-blur.end", groupId: "sweep.motion-blur" },
      { kind: "groupStart", id: "cluster", drawCount: 3, x: 2, y: 1, scale: 1.25, rotationDeg: 10, pivotX: 16, pivotY: 8, opacity: 0.9, blendMode: "normal", effects: null },
      { kind: "ellipse", id: "orb", x: -65_000, y: -20_000, width: 131_072, height: 40_000, color: { r: 0, g: 0.5, b: 1, a: 0.5 }, strokeWidth: 1, stroke: { r: 1, g: 1, b: 1, a: 0.25 } },
      { kind: "triangles", id: "triangle", vertices: [{ x: 16, y: 1 }, { x: 12, y: 8 }, { x: 20, y: 8 }], rotationDeg: 0, pivotX: 16, pivotY: 4, color: { r: 1, g: 1, b: 0, a: 1 } },
      { kind: "coloredTriangles", id: "path", vertices: [{ x: 2, y: 2, color: { r: 1, g: 0, b: 0, a: 0.5 } }, { x: 6, y: 2, color: { r: 0, g: 1, b: 0, a: 0.5 } }, { x: 2, y: 6, color: { r: 0, g: 0, b: 1, a: 0.5 } }], rotationDeg: 0, pivotX: 4, pivotY: 4 },
      { kind: "groupEnd", id: "cluster.end", groupId: "cluster" },
      { kind: "image", id: "saturn-closeup", resourceId: "saturn-png", x: -2_800, y: -1_200, width: 7_540, height: 3_770, rotationDeg: 0, pivotX: 970, pivotY: 685, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1 },
      { kind: "gradientRect", id: "gradient", blendMode: "screen", effects: { blur: 6, brightness: 1.2, contrast: 1.1, saturate: 0.75, grayscale: 0.25 }, x: 0, y: 0, width: 32, height: 16, rotationDeg: 0, pivotX: 16, pivotY: 8, gradientType: "radial", angleDeg: 180, centerX: 0.5, centerY: 0.5, stops: [{ offset: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { offset: 1, color: { r: 0, g: 0, b: 0, a: 0 } }] },
      { kind: "styledRect", id: "panel", x: 1, y: 1, width: 20, height: 10, rotationDeg: 5, pivotX: 11, pivotY: 6, radius: 3, fill: { r: 0.1, g: 0.2, b: 0.3, a: 1 }, strokeWidth: 1, stroke: { r: 1, g: 1, b: 1, a: 1 }, shadow: { offsetX: 2, offsetY: 2, blur: 4, spread: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } } },
      { kind: "points", id: "spark", seed: 19, points: [{ x: 16, y: 8, size: 3, color: { r: 0, g: 1, b: 1, a: 1 } }] },
      { kind: "scene3d", id: "world", background: {r:0,g:0,b:0,a:1}, opacity:1, viewProjection:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], lightDirection:[0,-1,-1], lightColor:{r:1,g:1,b:1,a:1}, ambient:0.2, intensity:1, objects:[{id:"mesh",vertices:[0,0,0,0,0,1,1,0,0,0,0,1,0,1,0,0,0,1],indices:[0,1,2],model:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],color:{r:1,g:0,b:0,a:1},emissive:0}] },
      { kind: "environment", id: "storm", environmentKind: "rain", mode: "overlay", seed: 17, timeSeconds: 1.5, x: 0, y: 0, width: 32, height: 16, rotationDeg: 0, pivotX: 16, pivotY: 8, opacity: 0.8, colors: [{r:0,g:0,b:0,a:1},{r:.7,g:.9,b:1,a:1},{r:.2,g:.4,b:.7,a:1},{r:1,g:1,b:1,a:1},{r:0,g:0,b:0,a:0}], parameters: [.8,.2,1.4,1,4,.45,.9,.2,.7,.6,.8,.4,.3,0,0,0] },
      { kind: "material", id: "neon", blendMode: "screen", effects: { blur: 2, brightness: 1, contrast: 1, saturate: 1, grayscale: 0, glow: null }, mask: { shape: "rect", x: 0, y: 0, width: 32, height: 16, radius: 0, rotationDeg: 0, pivotX: 16, pivotY: 8, inverted: false, opacity: 1, featherPx: 0 }, preset: "energy", seed: 29, timeSeconds: 2.5, x: 0, y: 0, width: 32, height: 16, rotationDeg: 0, pivotX: 16, pivotY: 8, opacity: 0.7, colors: [{r:1,g:0,b:.2,a:1},{r:0,g:.8,b:1,a:1},{r:1,g:1,b:1,a:1}], parameters: [1.5,4,1,3,.5,.7,.2,.1] },
      { kind: "adjustment", id: "finish", vignette: { amount: 0.75, softness: 0.5, color: { r: 0, g: 0, b: 0, a: 1 } }, filmGrain: { amount: 0.2, size: 2, frameSeed: 123 } }
    ]
  });
}

async function compileCoreAfterimagePlan(): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-frame-intent.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as CoreGpuFrameModule;
  const descriptor = createGpuPageAfterimageStackFixture({ width: 32, height: 16 });
  const { schema: _schema, width: _width, height: _height, ...binding } = descriptor;
  return core.compileGpuFramePlan({
    schema: core.GPU_FRAME_INTENT_SCHEMA,
    width: 32,
    height: 16,
    clear: { r: 0, g: 0, b: 0, a: 0 },
    draws: [
      { kind: "groupStart", id: binding.scopeGroupDrawId, drawCount: 2, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 16, pivotY: 8, opacity: 1, blendMode: "normal", effects: null },
      { kind: "rect", id: "subject", x: 4, y: 3, width: 16, height: 10, color: { r: 1, g: 0.4, b: 0.2, a: 1 } },
      { kind: "effectModule", id: binding.drawId, blendMode: "normal", effects: null, ...binding },
      { kind: "groupEnd", id: `${binding.scopeGroupDrawId}.end`, groupId: binding.scopeGroupDrawId }
    ]
  });
}

describe("admitInternalGpuFramePlan", () => {
  it("accepts the exact normalized plan compiled by Core without a GPU package export", async () => {
    const corePlan = await compileCorePlan();
    expect(admitInternalGpuFramePlan(corePlan)).toEqual(corePlan);
  });

  it("accepts Core's fixed compute field at canonical time zero and a zero layer start", async () => {
    const corePlan = await compileCoreComputePlan();
    expect(corePlan.draws).toEqual([expect.objectContaining({ kind: "particleCompute", atMs: 0, startMs: 0, count: 100_000 })]);
    expect(admitInternalGpuFramePlan(corePlan)).toEqual(corePlan);
  });

  it("admits all six Core-lowered v1 geometry kinds as bounded colored triangles without renderer translation", async () => {
    const corePlan = await compileCoreAuthoredShapeGeometryPlan();
    const draws = corePlan.draws.filter((draw) => draw.kind === "coloredTriangles");
    expect(draws).toHaveLength(6);
    expect(draws.map((draw) => draw.id)).toEqual(["line", "polyline", "polygon", "arc", "sector", "path"]);
    expect(draws.every((draw) => draw.vertices.length > 0 && draw.vertices.length <= 768)).toBe(true);
    expect(draws.find((draw) => draw.id === "line")?.vertices.length).toBeGreaterThan(6);
    expect(corePlan.budget.triangleVertexCount).toBe(draws.reduce((total, draw) => total + draw.vertices.length, 0));
    expect(admitInternalGpuFramePlan(corePlan)).toEqual(corePlan);
  });

  it("refuses v1 geometry at the direct Browser capability gate before any legacy path fallback", () => {
    const motion = {
      schema: "shellx-motion/motion@1", id: "browser-v1-refusal", name: "Browser v1 refusal", durationMs: 1_000, fps: 30, width: 32, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "v1-path", type: "shape", startMs: 0, durationMs: 1_000, geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 100, height: 100 }, data: "M 0 0 L 100 0 L 100 100 L 0 100 Z" }, style: { fill: "#ffffff" } }]
    } as never;
    expect(matchRendererCapability(motion, BROWSER_CAPABILITY)).toMatchObject({ ok: false, lane: "browser", unsupported: [{ layerId: "v1-path", feature: "shape.geometry.v1" }] });
  });

  it("re-admits one canonical fixed module and refuses forged binding, alias, scope, budget, nested, and no-module compatibility drift", async () => {
    const plan = await compileCoreAfterimagePlan();
    expect(admitInternalGpuFramePlan(plan)).toEqual(plan);
    const effectIndex = plan.draws.findIndex((draw) => draw.kind === "effectModule");
    const effect = plan.draws[effectIndex];
    if (!effect || effect.kind !== "effectModule") throw new Error("afterimage fixture did not compile an effect draw");
    const replace = (draws: unknown[], budget: unknown = plan.budget) => ({ ...plan, draws, budget, fingerprint: fingerprint(plan.width, plan.height, plan.clear, draws) });
    const replaceEffect = (replacement: Record<string, unknown>, budget: unknown = plan.budget) => replace(plan.draws.map((draw, index) => index === effectIndex ? replacement : draw), budget);
    expect(admitInternalGpuFramePlan(replaceEffect({ ...effect, id: "aliased-effect" }))).toBeNull();
    expect(admitInternalGpuFramePlan(replaceEffect({ ...effect, bindingFingerprint: "0".repeat(64) }))).toBeNull();
    expect(admitInternalGpuFramePlan(replaceEffect({ ...effect, descriptorFingerprint: "0".repeat(64) }))).toBeNull();
    expect(admitInternalGpuFramePlan(replaceEffect({ ...effect, scopeGroupDrawId: "wrong.group" }))).toBeNull();
    expect(admitInternalGpuFramePlan(replaceEffect({ ...effect, extra: true }))).toBeNull();
    expect(admitInternalGpuFramePlan(replace(plan.draws, { ...plan.budget, effectModuleUniformBytes: 0 }))).toBeNull();
    const [start, subject, module, end] = plan.draws;
    const nested = [
      { kind: "groupStart", id: "outer.group", drawCount: 4, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 16, pivotY: 8, opacity: 1, blendMode: "normal", effects: null },
      start, subject, module, end,
      { kind: "groupEnd", id: "outer.group.end", groupId: "outer.group" }
    ];
    expect(admitInternalGpuFramePlan(replace(nested))).toBeNull();
    const noModule = await compileCorePlan();
    expect("effectModuleCount" in noModule.budget).toBe(false);
    expect("effectModuleUniformBytes" in noModule.budget).toBe(false);
    expect(admitInternalGpuFramePlan(noModule)).toEqual(noModule);
  });

  it("re-admits fixed environment shutter groups at 2, 4, and 8 samples, including all environment kinds", () => {
    for (const samples of [2, 4, 8]) {
      const plan = environmentTemporalPlan(["rain", "water", "snow", "fog"], samples);
      expect(plan.budget).toMatchObject({ environmentCount: 4 * samples, environmentUniformBytes: 4 * samples * 208, motionBlurGroupCount: 4, motionBlurSampleCount: 4 * samples, compositeCount: 4 });
      expect(admitInternalGpuFramePlan(plan)).toEqual(plan);
    }
  });

  it("fails closed for forged temporal environment spans, mixed child kinds, and over-cap environment work", () => {
    const plan = environmentTemporalPlan(["rain"], 2);
    const replace = (draws: unknown[]) => ({ ...plan, draws, fingerprint: fingerprint(plan.width, plan.height, plan.clear, draws) });
    const children = plan.draws.slice(1, 3);
    expect(admitGpuTemporalGrammar([plan.draws[3]!])).toBeNull();
    expect(admitInternalGpuFramePlan(replace([{ ...plan.draws[0], drawCount: 3 }, ...children, plan.draws[3]]))).toBeNull();
    expect(admitInternalGpuFramePlan(replace([{ ...plan.draws[0], sampleCount: 3 }, ...children, plan.draws[3]]))).toBeNull();
    expect(admitInternalGpuFramePlan(replace([plan.draws[0], { ...children[0], kind: "material" }, children[1], plan.draws[3]]))).toBeNull();
    expect(admitInternalGpuFramePlan(replace([plan.draws[0], { ...children[0], effects: { blur: 1, brightness: 1, contrast: 1, saturate: 1, grayscale: 0, glow: null } }, children[1], plan.draws[3]]))).toBeNull();
    expect(admitInternalGpuFramePlan(replace([plan.draws[0], { ...children[0], kind: "motionBlurStart" }, children[1], plan.draws[3]]))).toBeNull();
    expect(admitInternalGpuFramePlan(environmentTemporalPlan(["rain", "water", "snow", "fog", "rain"], 8))).toBeNull();
    expect(admitInternalGpuFramePlan(environmentMixedPlan(["rain", "water", "snow", "fog", "rain"], [], 2))).toBeNull();
    expect(admitInternalGpuFramePlan(environmentMixedPlan(["rain", "water", "snow", "fog"], ["rain"], 2))).toBeNull();
    expect(admitInternalGpuFramePlan(environmentMixedPlan(["rain", "water", "snow"], ["fog", "rain"], 2))).toBeNull();
  });

  it("fails closed for unknown v2 particle descriptor fields before browser allocation", async () => {
    const plan = v2ComputePlan(await compileCoreComputePlan());
    expect(admitInternalGpuFramePlan(plan)).toEqual(plan);
    const particle = plan.draws[0] as Record<string, unknown>;
    const source = (particle.sources as Record<string, unknown>[])[0]; const origin = (particle.origins as Record<string, unknown>[])[0];
    const trail = particle.trail as Record<string, unknown>; const shading = particle.shading as Record<string, unknown>;
    for (const draw of [{ ...particle, shader: "untrusted" }, { ...particle, sources: [{ ...source, shader: "untrusted" }] }, { ...particle, origins: [{ ...origin, extra: 1 }] }, { ...particle, trail: { ...trail, extra: 1 } }, { ...particle, shading: { ...shading, extra: 1 } }]) expect(admitInternalGpuFramePlan({ ...plan, draws: [draw] })).toBeNull();
  });

  it("rejects a forged particle-compute shutter child before runtime admission", async () => {
    const compute = (await compileCoreComputePlan()).draws[0]!;
    const draws = [
      { kind: "motionBlurStart", id: "forged-temporal", blendMode: "normal", effects: null, sampleCount: 1, drawCount: 1, shutterAngle: 180, shutterDurationMs: 16.667 },
      { ...compute, blendMode: "normal", effects: null },
      { kind: "motionBlurEnd", id: "forged-temporal.end", groupId: "forged-temporal" }
    ] as unknown as InternalGpuFramePlan["draws"];
    expect(admitGpuTemporalGrammar(draws)).toBeNull();
  });

  it("admits one strict v2 mask with its fixed source/composite budget but never a v1 or malformed mask", async () => {
    const mask = { shape: "rect", x: 4, y: 2, width: 72, height: 36, radius: 6, rotationDeg: 0, pivotX: 40, pivotY: 20, inverted: false, opacity: 1, featherPx: 0 };
    const plan = v2ComputePlan(await compileCoreComputePlan(), mask);
    expect(plan.budget).toMatchObject({ computeParticleFieldCount: 1, computeParticleBufferBytes: 12_800_000, maskCount: 1, maskUniformBytes: 48, compositeCount: 1, compositeUniformBytes: 64, compositeIntermediateTextureBytes: 38_400, estimatedPlanBytes: 448 });
    expect(admitInternalGpuFramePlan(plan)).toEqual(plan);
    const draw = plan.draws[0] as Record<string, unknown>;
    expect(admitInternalGpuFramePlan(withSingleDraw(plan, { ...draw, schema: "shellx-motion/gpu-compute-particle-field@1" }))).toBeNull();
    for (const invalidMask of [{ ...mask, shape: "path" }, { ...mask, radius: 19 }, { ...mask, featherPx: 129 }, { ...mask, extra: true }]) {
      expect(admitInternalGpuFramePlan(withSingleDraw(plan, { ...draw, mask: invalidMask }))).toBeNull();
    }
  });

  it("refuses malformed intent, accounting, and canonical-fingerprint drift before browser allocation", async () => {
    const plan = await compileCorePlan();
    const pointBatch = plan.draws.find((draw) => draw.kind === "points");
    const environment = plan.draws.find((draw) => draw.kind === "environment");
    const material = plan.draws.find((draw) => draw.kind === "material");
    const image = plan.draws.find((draw) => draw.kind === "image");
    if (!pointBatch || pointBatch.kind !== "points") throw new Error("test fixture requires points");
    if (!environment || environment.kind !== "environment") throw new Error("test fixture requires environment");
    if (!material || material.kind !== "material") throw new Error("test fixture requires material");
    if (!image || image.kind !== "image") throw new Error("test fixture requires image");
    const invalidPlans: unknown[] = [
      { ...plan, fingerprint: "0".repeat(64) },
      { ...plan, budget: { ...plan.budget, pointCount: 0 } },
      { ...plan, budget: { ...plan.budget, triangleVertexCount: 0 } },
      { ...plan, budget: { ...plan.budget, scene3dVertexCount: 0 } },
      { ...plan, budget: { ...plan.budget, scene3dUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, environmentCount: 0 } },
      { ...plan, budget: { ...plan.budget, environmentUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, materialCount: 0 } },
      { ...plan, budget: { ...plan.budget, materialUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, gradientStopCount: 0 } },
      { ...plan, budget: { ...plan.budget, styledRectangleUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, blendModeCount: 0 } },
      { ...plan, budget: { ...plan.budget, colorEffectCount: 0 } },
      { ...plan, budget: { ...plan.budget, blurEffectCount: 0 } },
      { ...plan, budget: { ...plan.budget, glowEffectCount: 1 } },
      { ...plan, budget: { ...plan.budget, maskCount: 0 } },
      { ...plan, budget: { ...plan.budget, blurPassCount: 0 } },
      { ...plan, budget: { ...plan.budget, adjustmentCount: 0 } },
      { ...plan, budget: { ...plan.budget, groupCount: 0 } },
      { ...plan, budget: { ...plan.budget, compositeCount: 0 } },
      { ...plan, budget: { ...plan.budget, compositeUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, blurUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, glowUniformBytes: 1 } },
      { ...plan, budget: { ...plan.budget, maskUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, adjustmentUniformBytes: 0 } },
      { ...plan, budget: { ...plan.budget, compositeIntermediateTextureBytes: 0 } },
      { ...plan, budget: { ...plan.budget, estimatedPlanBytes: 4 * 1024 * 1024 + 1 } },
      { ...plan, clear: { ...plan.clear, a: Number.NaN } },
      { ...plan, draws: [{ ...plan.draws[0], id: "not valid" }] },
      { ...plan, draws: [{ ...plan.draws[0], kind: "shader" }] },
      { ...plan, draws: [{ ...plan.draws[0], x: Number.POSITIVE_INFINITY }] },
      { ...plan, draws: [{ ...plan.draws[0], color: { ...plan.clear, r: 2 } }] },
      { ...plan, draws: [{ ...plan.draws[0], mask: { ...(plan.draws[0].kind === "adjustment" || plan.draws[0].kind === "motionBlurEnd" || plan.draws[0].kind === "groupEnd" ? {} : plan.draws[0].mask), shape: "path" } }] },
      { ...plan, draws: [{ ...plan.draws[0], effects: { blur: 0, brightness: 5, contrast: 1, saturate: 1, grayscale: 0 } }] },
      { ...plan, draws: [{ ...plan.draws[0], effects: { blur: 129, brightness: 1, contrast: 1, saturate: 1, grayscale: 0 } }] },
      { ...plan, draws: [{ ...pointBatch, seed: 1.5 }] },
      { ...plan, draws: [{ ...pointBatch, points: {} }] },
      { ...plan, draws: plan.draws.map((draw) => draw.kind === "image" ? { ...image, width: 131_073 } : draw) },
      { ...plan, draws: plan.draws.map((draw) => draw.kind === "environment" ? { ...draw, parameters: [2, ...environment.parameters.slice(1)] } : draw) },
      { ...plan, draws: plan.draws.map((draw) => draw.kind === "material" ? { ...draw, preset: "arbitrary" } : draw) },
      { ...plan, draws: plan.draws.map((draw) => draw.kind === "material" ? { ...draw, parameters: [1, 4, 1, 3, 0.5, 0.7, 0.2, Number.POSITIVE_INFINITY] } : draw) },
      { ...plan, draws: [{ kind: "triangles", id: "broken", vertices: [{ x: 0, y: 0 }], rotationDeg: 0, pivotX: 0, pivotY: 0, color: plan.clear }] },
      { ...plan, draws: [{ kind: "coloredTriangles", id: "broken-colored", vertices: [{ x: 0, y: 0, color: plan.clear }], rotationDeg: 0, pivotX: 0, pivotY: 0 }] },
      { ...plan, draws: [{ kind: "gradientRect", id: "broken-gradient", x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, gradientType: "linear", angleDeg: 90, centerX: 0.5, centerY: 0.5, stops: [{ offset: 1, color: plan.clear }, { offset: 0, color: plan.clear }] }] },
      { ...plan, draws: [{ kind: "adjustment", id: "broken-adjustment", vignette: null, filmGrain: null }] },
      { ...plan, draws: plan.draws.map((draw) => draw.kind === "motionBlurEnd" ? { ...draw, groupId: "wrong" } : draw) },
      { ...plan, draws: plan.draws.map((draw) => draw.kind === "groupEnd" ? { ...draw, groupId: "wrong" } : draw) },
      { ...plan, draws: Array.from({ length: 2_049 }, () => pointBatch) }
    ];
    for (const invalid of invalidPlans) expect(admitInternalGpuFramePlan(invalid)).toBeNull();
  });
});

function v2ComputePlan(plan: InternalGpuFramePlan, mask?: Record<string, unknown>): InternalGpuFramePlan {
  const base = plan.draws[0] as unknown as Record<string, unknown>;
  const draw = { ...base, ...(mask ? { mask } : {}), schema: "shellx-motion/gpu-compute-particle-field@2", sources: [{ kind: "radial", centerX: .25, centerY: .75, strength: -1, softening: .01 }, { kind: "flow", angleDeg: 90, strength: .25 }, { kind: "turbulence", scale: 1, strength: .2 }, { kind: "collision", axis: "x", position: .9, restitution: .4 }], origins: [{x:.1,y:.2,weight:.1,directionOffsetDeg:0,speedScale:1},{x:.3,y:.4,weight:.2,directionOffsetDeg:0,speedScale:1},{x:.5,y:.6,weight:.3,directionOffsetDeg:0,speedScale:1},{x:.7,y:.8,weight:.4,directionOffsetDeg:0,speedScale:1}], trail: { durationMs: 100, samples: 4, opacity: .7 }, shading: { mode: "soft", sizeJitter: .1, opacityJitter: .2, glow: .3 }, computeDispatchCount: 1, rasterPassCount: 2, instanceBytes: 64, retainedBufferCount: 2, retainedInstanceBytes: 12_800_000 };
  const budget = { ...plan.budget, computeParticleBufferBytes: 12_800_000, computeParticleComputeDispatchCount: 1, computeParticleRasterPassCount: 2, ...(mask ? { maskCount: 1, compositeCount: 1, compositeUniformBytes: 64, maskUniformBytes: 48, compositeIntermediateTextureBytes: plan.width * plan.height * 4 * 3, estimatedPlanBytes: plan.budget.estimatedPlanBytes + 128 } : {}) };
  const normalized = { schema: "shellx-motion/gpu-frame-intent@1", width: plan.width, height: plan.height, clear: plan.clear, draws: [draw] };
  return { ...normalized, fingerprint: createHash("sha256").update(canonicalJson(normalized)).digest("hex"), budget } as unknown as InternalGpuFramePlan;
}

function withSingleDraw(plan: InternalGpuFramePlan, draw: Record<string, unknown>): InternalGpuFramePlan {
  const normalized = { schema: plan.schema, width: plan.width, height: plan.height, clear: plan.clear, draws: [draw] };
  return { ...normalized, fingerprint: createHash("sha256").update(canonicalJson(normalized)).digest("hex"), budget: plan.budget } as unknown as InternalGpuFramePlan;
}

function environmentTemporalPlan(kinds: Array<"rain" | "water" | "snow" | "fog">, samples: number): InternalGpuFramePlan {
  return environmentMixedPlan([], kinds, samples);
}

function environmentMixedPlan(staticKinds: Array<"rain" | "water" | "snow" | "fog">, temporalKinds: Array<"rain" | "water" | "snow" | "fog">, samples: number): InternalGpuFramePlan {
  const width = 8, height = 4, clear = { r: 0, g: 0, b: 0, a: 1 };
  const draws: Array<Record<string, unknown>> = [];
  for (const kind of staticKinds) draws.push(environmentDraw(kind, `${kind}-static-${draws.length}`, 0, 0.25));
  for (const kind of temporalKinds) {
    const id = `${kind}-${draws.length}.motion-blur`;
    draws.push({ kind: "motionBlurStart", id, blendMode: "normal", effects: null, sampleCount: samples, drawCount: samples, shutterAngle: 180, shutterDurationMs: 16.667 });
    for (let sample = 0; sample < samples; sample += 1) draws.push(environmentDraw(kind, `${id}.sample-${sample}.0`, sample / 10, 0.25 / samples));
    draws.push({ kind: "motionBlurEnd", id: `${id}.end`, groupId: id });
  }
  const environmentCount = staticKinds.length + temporalKinds.length * samples;
  const motionBlurGroupCount = temporalKinds.length;
  const motionBlurSampleCount = environmentCount;
  const temporalSampleCount = temporalKinds.length * samples;
  const compositeCount = staticKinds.length + motionBlurGroupCount;
  const budget = {
    rectangleCount: 0, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 0, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0, textUtf8Bytes: 0, textSurfacePixels: 0,
    scene3dCount: 0, scene3dObjectCount: 0, scene3dVertexCount: 0, scene3dIndexCount: 0, environmentCount, materialCount: 0, gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 0, computeParticleComputeDispatchCount: 0, computeParticleRasterPassCount: 0, triangleBufferBytes: 0, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 0, scene3dVertexBufferBytes: 0, scene3dIndexBufferBytes: 0, scene3dUniformBytes: 0, environmentUniformBytes: environmentCount * 208, materialUniformBytes: 0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0,
    blendModeCount: 0, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount, motionBlurSampleCount: temporalSampleCount, groupCount: 0, groupMaxDepth: 0, compositeCount, compositeUniformBytes: compositeCount * 64, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: width * height * 4 * 2,
    estimatedPlanBytes: environmentCount * 320 + compositeCount * 32 + motionBlurGroupCount * 48
  };
  return { schema: "shellx-motion/gpu-frame-intent@1", width, height, clear, draws: draws as never, fingerprint: fingerprint(width, height, clear, draws), budget } as unknown as InternalGpuFramePlan;
}

function environmentDraw(kind: "rain" | "water" | "snow" | "fog", id: string, timeSeconds: number, opacity: number): Record<string, unknown> {
  const colors = kind === "rain" ? [{ r: 0, g: 0, b: 0, a: 1 }, { r: .7, g: .9, b: 1, a: 1 }, { r: .2, g: .4, b: .7, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }]
    : kind === "water" ? [{ r: 0, g: .1, b: .2, a: 1 }, { r: 0, g: .4, b: .7, a: 1 }, { r: 0, g: .1, b: .3, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: .8, g: .9, b: 1, a: 1 }]
      : kind === "snow" ? [{ r: .1, g: .1, b: .2, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: .4, g: .5, b: .7, a: 1 }, { r: .8, g: .9, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }]
        : [{ r: .1, g: .1, b: .2, a: 1 }, { r: .8, g: .8, b: .9, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }];
  const parameters = kind === "rain" ? [.8, .2, 1.4, 1, 4, .45, .9, .2, .7, .6, .8, .4, .3, 0, 0, 0]
    : kind === "water" ? [.5, 4, .2, 1, 0, .5, 3, .7, .4, .6, .3, .8, .2, 0, 0, 0]
      : kind === "snow" ? [.5, 1, .2, .3, 2, 3, .4, .5, .6, .2, .3, .4, .5, 0, 0, 0]
        : [.2, .5, 2, .3, .4, 3, .5, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return { kind: "environment", id, blendMode: "normal", effects: null, environmentKind: kind, mode: "scene", seed: 17, timeSeconds, x: 0, y: 0, width: 8, height: 4, rotationDeg: 0, pivotX: 4, pivotY: 2, opacity, colors, parameters };
}

function fingerprint(width: number, height: number, clear: { r: number; g: number; b: number; a: number }, draws: unknown[]): string {
  return createHash("sha256").update(canonicalJson({ schema: "shellx-motion/gpu-frame-intent@1", width, height, clear, draws })).digest("hex");
}
