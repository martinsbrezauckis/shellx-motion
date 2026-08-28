import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGpuFrameRenderSession, DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, MAX_GPU_FRAME_OPERATION_TIMEOUT_MS, raceGpuFrameOperation, renderInternalGpuFrame } from "./gpu-frame-renderer";
import { gpuCancellationFailure, gpuDeviceLostFailure, type InternalGpuFramePlan } from "./gpu-runtime-types";

const GPU_FRAME_OPERATION_TIMEOUT_MS = DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS;
const GPU_FRAME_FIXTURE_TIMEOUT_MS = 45_000;

interface CoreGpuFrameModule {
  GPU_FRAME_INTENT_SCHEMA: string;
  compileGpuFramePlan(input: unknown): InternalGpuFramePlan;
}

async function compileCorePlan(): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-frame-intent.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as CoreGpuFrameModule;
  return core.compileGpuFramePlan({
    schema: core.GPU_FRAME_INTENT_SCHEMA,
    width: 4,
    height: 4,
    clear: { r: 0, g: 0, b: 0, a: 1 },
    draws: [
      { kind: "rect", id: "orange", x: 1, y: 1, width: 2, height: 2, color: { r: 1, g: 0.5, b: 0, a: 1 } },
      { kind: "points", id: "spark", seed: 19, points: [{ x: 2, y: 2, size: 1, color: { r: 0, g: 1, b: 1, a: 1 } }] }
    ]
  });
}

async function compileCoreEnvironmentPlan(environmentKind: "rain" | "water" | "snow" | "fog"): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-frame-intent.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as CoreGpuFrameModule;
  const fixture = {
    rain: { colors: [{ r: 0.02, g: 0.04, b: 0.08, a: 1 }, { r: 0.74, g: 0.92, b: 1, a: 1 }, { r: 0.49, g: 0.83, b: 0.99, a: 1 }, { r: 0.98, g: 0.44, b: 0.52, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }], parameters: [0.8, 0.2, 1.4, 1, 4, 0.43, 0.9, 0.24, 0.78, 0.64, 0.88, 0.44, 0.34, 0, 0, 0] },
    water: { colors: [{ r: 0.01, g: 0.04, b: 0.08, a: 1 }, { r: 0.08, g: 0.42, b: 0.72, a: 1 }, { r: 0.01, g: 0.12, b: 0.32, a: 1 }, { r: 0.94, g: 0.98, b: 1, a: 1 }, { r: 0.7, g: 0.9, b: 1, a: 1 }], parameters: [0.5, 4, 0.2, 1, 0, 0.5, 3, 0.7, 0.4, 0.6, 0.3, 0.8, 0.2, 0, 0, 0] },
    snow: { colors: [{ r: 0.04, g: 0.06, b: 0.12, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0.4, g: 0.5, b: 0.7, a: 1 }, { r: 0.8, g: 0.9, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }], parameters: [0.5, 1, 0.2, 0.3, 2, 3, 0.4, 0.5, 0.6, 0.2, 0.3, 0.4, 0.5, 0, 0, 0] },
    fog: { colors: [{ r: 0.04, g: 0.06, b: 0.12, a: 1 }, { r: 0.8, g: 0.84, b: 0.9, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }], parameters: [0.2, 0.5, 2, 0.3, 0.4, 3, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
  }[environmentKind];
  return core.compileGpuFramePlan({
    schema: core.GPU_FRAME_INTENT_SCHEMA,
    width: 64,
    height: 36,
    clear: { r: 0, g: 0, b: 0, a: 0 },
    draws: [{
      kind: "environment", id: `${environmentKind}-positive-pixels`, blendMode: "normal", effects: null,
      environmentKind, mode: "overlay", seed: 19, timeSeconds: 0.5,
      x: 0, y: 0, width: 64, height: 36, rotationDeg: 0, pivotX: 32, pivotY: 18, opacity: 1,
      colors: fixture.colors, parameters: fixture.parameters,
    }]
  });
}

async function compileCoreTemporalEnvironmentPlan(samples: 1 | 2 | 4 | 8, mode: "scene" | "overlay", sceneResourceId?: string, effectMaskResourceId?: string): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-frame-intent.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as CoreGpuFrameModule;
  const environment = (index: number, opacity: number) => ({
    kind: "environment", id: `temporal-rain-${samples}-${index}`, blendMode: "normal", effects: null,
    environmentKind: "rain", mode, seed: 19, timeSeconds: index < samples / 2 ? 0.2 : 0.8,
    x: 0, y: 0, width: 64, height: 36, rotationDeg: 0, pivotX: 32, pivotY: 18, opacity,
    ...(sceneResourceId ? { sceneResourceId } : {}),
    ...(effectMaskResourceId ? { effectMaskResourceId } : {}),
    colors: [{ r: 0.02, g: 0.04, b: 0.08, a: 1 }, { r: 0.74, g: 0.92, b: 1, a: 1 }, { r: 0.49, g: 0.83, b: 0.99, a: 1 }, { r: 0.98, g: 0.44, b: 0.52, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }],
    parameters: [1, 0.4, 1.8, 1, 4, 0.36, 1, 0.4, 0.9, 0.8, 1, 0.7, 0.5, 0, 0, 0]
  });
  const draws: unknown[] = mode === "overlay" ? [{ kind: "rect", id: "overlay-base", x: 0, y: 0, width: 64, height: 36, color: { r: 0.15, g: 0.3, b: 0.5, a: 0.8 } }] : [];
  if (samples === 1) draws.push(environment(1, 0.25));
  else {
    draws.push({ kind: "motionBlurStart", id: `temporal-rain-${samples}`, blendMode: "normal", effects: null, sampleCount: samples, drawCount: samples, shutterAngle: 180, shutterDurationMs: 16.667 });
    for (let index = 0; index < samples; index += 1) draws.push(environment(index, 0.25 / samples));
    draws.push({ kind: "motionBlurEnd", id: `temporal-rain-${samples}.end`, groupId: `temporal-rain-${samples}` });
  }
  return core.compileGpuFramePlan({ schema: core.GPU_FRAME_INTENT_SCHEMA, width: 64, height: 36, clear: { r: 0, g: 0, b: 0, a: 0 }, draws });
}

function temporalSceneFixture(alpha: number): Buffer {
  const rgba = Buffer.alloc(64 * 36 * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set([30, 90, 160, alpha], index);
  return rgba;
}

function temporalEffectMaskFixture(): Buffer {
  const rgba = Buffer.alloc(64 * 36 * 4, 255);
  for (let y = 0; y < 36; y += 1) for (let x = 0; x < 32; x += 1) rgba[(y * 64 + x) * 4 + 3] = 0;
  return rgba;
}

function meanAlphaHalf(rgba: Buffer, startX: 0 | 32): number {
  let total = 0;
  for (let y = 0; y < 36; y += 1) for (let x = startX; x < startX + 32; x += 1) total += rgba[(y * 64 + x) * 4 + 3]!;
  return total / (32 * 36);
}

function meanAbsolutePixelDelta(left: Buffer, right: Buffer): number {
  if (left.length !== right.length) throw new Error("pixel comparison requires matching frames");
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index]! - right[index]!);
  return total / left.length;
}

async function compileCoreChromaCleanupPlan(): Promise<InternalGpuFramePlan> {
  const corePath = new URL("../../core/src/gpu-frame-intent.ts", import.meta.url).href;
  const core = await import(corePath) as unknown as CoreGpuFrameModule;
  return core.compileGpuFramePlan({
    schema: core.GPU_FRAME_INTENT_SCHEMA,
    width: 16,
    height: 16,
    clear: { r: 0, g: 0, b: 0, a: 0 },
    draws: [{
      kind: "image", id: "keyed-subject", resourceId: "keyed-source",
      x: 0, y: 0, width: 16, height: 16, rotationDeg: 0, pivotX: 8, pivotY: 8,
      u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1,
      chromaKey: {
        keyColor: { r: 0, g: 1, b: 0, a: 1 }, similarity: 0.12, smoothness: 0.08,
        shadow: 0, spillSuppression: 0, spillBalance: 0, edgeColorCorrection: 0,
        matte: { denoiseRadiusPx: 0, growShrinkPx: 0, chokePx: 0, featherPx: 0, blackClip: 0.6, whiteClip: 0.8 }
      }
    }]
  });
}

function chromaCleanupFixture(): Buffer {
  const rgba = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const offset = (y * 16 + x) * 4;
    const core = x >= 6 && x <= 9 && y >= 6 && y <= 9;
    const halo = x >= 4 && x <= 11 && y >= 4 && y <= 11 && !core;
    const pixel = core ? [255, 255, 255, 255] : halo ? [51, 217, 51, 255] : [0, 255, 0, 255];
    rgba.set(pixel, offset);
  }
  return rgba;
}

function alphaAt(rgba: Buffer, x: number, y: number): number { return rgba[(y * 16 + x) * 4 + 3]!; }

describe("renderInternalGpuFrame", () => {
  it("keeps its hardware fixture runner budget above the bounded frame operation", () => {
    expect(GPU_FRAME_OPERATION_TIMEOUT_MS).toBe(30_000);
    expect(MAX_GPU_FRAME_OPERATION_TIMEOUT_MS).toBe(60_000);
    expect(GPU_FRAME_FIXTURE_TIMEOUT_MS).toBeGreaterThan(GPU_FRAME_OPERATION_TIMEOUT_MS);
  });

  it("exposes explicit device-loss and cancellation failure contracts", async () => {
    expect(gpuDeviceLostFailure()).toEqual({ code: "gpu_device_lost", message: "WebGPU device was lost during frame rendering." });
    expect(gpuCancellationFailure()).toMatchObject({ code: "gpu_cancelled" });
    const controller = new AbortController();
    const pending = raceGpuFrameOperation(new Promise<never>(() => undefined), 1_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("refuses a plan with inconsistent resource accounting before opening a browser", async () => {
    const plan = await compileCorePlan();
    const result = await renderInternalGpuFrame({ ...plan, budget: { ...plan.budget, pointCount: 0 } });
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded" } });
  });

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("verifies rectangle and instanced-point readback on an admitted hardware adapter", async () => {
    const plan = await compileCorePlan();
    const result = await renderInternalGpuFrame(plan, GPU_FRAME_OPERATION_TIMEOUT_MS);
    expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true);
    if (!result.ok) return;
    expect(result.frame.rgba).toHaveLength(4 * 4 * 4);
    expect(result.frame.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.frame.evidence.backend).toBe("webgpu-browser");
  }, GPU_FRAME_FIXTURE_TIMEOUT_MS);

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("verifies every fixed environment writes positive pixels through the persistent WebGPU path", async () => {
    for (const environmentKind of ["rain", "water", "snow", "fog"] as const) {
      const result = await renderInternalGpuFrame(await compileCoreEnvironmentPlan(environmentKind), GPU_FRAME_OPERATION_TIMEOUT_MS);
      expect(result.ok, result.ok ? undefined : `${environmentKind}: ${result.failure.message}`).toBe(true);
      if (!result.ok) return;
      expect(result.frame.rgba).toHaveLength(64 * 36 * 4);
      expect(result.frame.rgba.some((value) => value !== 0)).toBe(true);
      expect(result.frame.rgba.some((_value, index) => index % 4 === 3 && result.frame.rgba[index] !== 0)).toBe(true);
      expect(result.frame.evidence.backend).toBe("webgpu-browser");
    }
  }, GPU_FRAME_FIXTURE_TIMEOUT_MS);

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("accumulates temporal scene and overlay environments in native pixels without sample-count drift", async () => {
    const scenarios: Array<{ name: string; mode: "scene" | "overlay"; alpha?: number; effectMask?: true }> = [
      { name: "scene without source", mode: "scene" },
      { name: "opaque scene source", mode: "scene", alpha: 255 },
      { name: "translucent scene source", mode: "scene", alpha: 112 },
      { name: "overlay", mode: "overlay" },
      { name: "effect-mask overlay", mode: "overlay", effectMask: true }
    ];
    for (const scenario of scenarios) {
      const scene = scenario.alpha === undefined ? undefined : temporalSceneFixture(scenario.alpha);
      const sha256 = scene ? createHash("sha256").update(scene).digest("hex") : undefined;
      const effectMask = scenario.effectMask ? temporalEffectMaskFixture() : undefined;
      const effectMaskSha256 = effectMask ? createHash("sha256").update(effectMask).digest("hex") : undefined;
      const images = [
        ...(scene && sha256 ? [{ id: "temporal-scene", width: 64, height: 36, rgba: scene, sha256, decodedSha256: sha256 }] : []),
        ...(effectMask && effectMaskSha256 ? [{ id: "temporal-mask", width: 64, height: 36, rgba: effectMask, sha256: effectMaskSha256, decodedSha256: effectMaskSha256 }] : [])
      ];
      const opened = await createGpuFrameRenderSession(images, [], {
        environmentEnvelope: { width: 64, height: 36, groupDepth: 0, keyCleanup: false, needsDepth: false }
      });
      expect(opened.ok, opened.ok ? undefined : `${scenario.name}: ${opened.failure.message}`).toBe(true);
      if (!opened.ok) return;
      try {
        const frames = new Map<number, Buffer>();
        for (const samples of [2, 4, 8] as const) {
          const result = await opened.session.render(await compileCoreTemporalEnvironmentPlan(samples, scenario.mode, scene ? "temporal-scene" : undefined, effectMask ? "temporal-mask" : undefined), { timeoutMs: GPU_FRAME_OPERATION_TIMEOUT_MS });
          expect(result.ok, result.ok ? undefined : `${scenario.name}/${samples}: ${result.failure.message}`).toBe(true);
          if (!result.ok) return;
          frames.set(samples, result.frame.rgba);
        }
        const two = frames.get(2)!;
        expect(meanAbsolutePixelDelta(two, frames.get(4)!)).toBeLessThanOrEqual(1.25);
        expect(meanAbsolutePixelDelta(two, frames.get(8)!)).toBeLessThanOrEqual(1.25);
        if (scenario.name === "scene without source") {
          const lastOnly = await opened.session.render(await compileCoreTemporalEnvironmentPlan(1, scenario.mode), { timeoutMs: GPU_FRAME_OPERATION_TIMEOUT_MS });
          expect(lastOnly.ok, lastOnly.ok ? undefined : lastOnly.failure.message).toBe(true);
          if (!lastOnly.ok) return;
          expect(meanAbsolutePixelDelta(two, lastOnly.frame.rgba)).toBeGreaterThan(0.25);
        }
        if (scenario.effectMask) expect(meanAlphaHalf(two, 32) - meanAlphaHalf(two, 0)).toBeGreaterThan(1);
        await expect(opened.session.resourceMetrics?.()).resolves.toMatchObject({ framesRendered: scenario.name === "scene without source" ? 4 : 3, frameArenaLateAllocationRefusals: 0, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216, environmentEnvelopeReservations: 1 });
      } finally {
        await opened.session.close();
      }
    }
  }, 120_000);

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("executes chroma matte cleanup on an admitted hardware adapter", async () => {
    const rgba = chromaCleanupFixture();
    const sha256 = createHash("sha256").update(rgba).digest("hex");
    const plan = await compileCoreChromaCleanupPlan();
    expect(plan.budget).toMatchObject({ chromaKeyCount: 1, chromaMatteCleanupCount: 1, chromaMatteCleanupPassCount: 1 });
    const opened = await createGpuFrameRenderSession([{ id: "keyed-source", width: 16, height: 16, rgba, sha256, decodedSha256: sha256 }]);
    expect(opened.ok, opened.ok ? undefined : opened.failure.message).toBe(true);
    if (!opened.ok) return;
    try {
      const result = await opened.session.render(plan, { timeoutMs: GPU_FRAME_OPERATION_TIMEOUT_MS });
      expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(result.frame.rgba).toHaveLength(16 * 16 * 4);
      expect(result.frame.evidence.backend).toBe("webgpu-browser");
      expect(alphaAt(result.frame.rgba, 7, 7)).toBeGreaterThan(240);
      expect(alphaAt(result.frame.rgba, 4, 7)).toBeLessThan(8);
      expect(alphaAt(result.frame.rgba, 0, 0)).toBeLessThan(8);
      expect(result.frame.rgba.some((_value, index) => index % 4 === 3 && result.frame.rgba[index]! > 0)).toBe(true);
    } finally {
      await opened.session.close();
    }
  }, GPU_FRAME_FIXTURE_TIMEOUT_MS);
});
