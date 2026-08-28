import { describe, expect, it } from "vitest";
import { CHROMA_KEY_SCHEMA } from "./keying";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { resolveGpuSceneChromaKey } from "./gpu-scene-chroma-key";
import type { MotionDocument, MotionLayer } from "./types";

const keying = { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00", similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5 } as const;

describe("GPU chroma key scene lowering", () => {
  it("keeps CPU-keyer color space, threshold endpoints, and spill controls in the fixed draw", () => {
    const layer = imageLayer({ keying });
    const resolved = resolveGpuSceneChromaKey(layer);
    expect(resolved).toMatchObject({ ok: true, chromaKey: { keyColor: { r: 0, g: 1, b: 0, a: 1 }, similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5 } });
    if (!resolved.ok || !resolved.chromaKey) return;
    expect(foreground({ r: 0, g: 1, b: 0 }, resolved.chromaKey)).toBe(0);
    expect(foreground({ r: 1, g: 0, b: 0 }, resolved.chromaKey)).toBe(1);
    const motion = document(layer);
    const plan = compileGpuScene2dPlan(motion, 0, { images: new Map([["assets/subject.png", { resourceId: "subject", assetRef: "assets/subject.png", width: 2, height: 1, sha256: "a".repeat(64) }]]) });
    expect(plan).toMatchObject({ ok: true, plan: { frame: { draws: [{ kind: "image", id: "subject", chromaKey: resolved.chromaKey }] } } });
  });

  it("lowers bounded CPU matte cleanup in exact cleanup order and accounting", () => {
    const matte = { denoiseRadiusPx: 1, growShrinkPx: -1, chokePx: 1, featherPx: 2, blackClip: 0.04, whiteClip: 0.96 };
    const layer = imageLayer({ keying: { ...keying, matte } });
    expect(resolveGpuSceneChromaKey(layer)).toMatchObject({ ok: true, chromaKey: { matte } });
    const result = compileGpuScene2dPlan(document(layer), 0, { images: new Map([["assets/subject.png", { resourceId: "subject", assetRef: "assets/subject.png", width: 2, height: 1, sha256: "a".repeat(64) }]]) });
    expect(result).toMatchObject({ ok: true, plan: { frame: { draws: [{ kind: "image", chromaKey: { matte } }], budget: { chromaMatteCleanupCount: 1, chromaMatteCleanupPassCount: 9, chromaMatteCleanupUniformBytes: 288, chromaMatteCleanupIntermediateTextureBytes: 24, compositeCount: 1 } } } });
  });

  it("refuses unsupported cleanup radii and clip ranges before GPU allocation", () => {
    expect(resolveGpuSceneChromaKey(imageLayer({ keying: { ...keying, matte: { featherPx: 33 } } }))).toMatchObject({ ok: false, message: expect.stringContaining("featherPx") });
    expect(resolveGpuSceneChromaKey(imageLayer({ keying: { ...keying, matte: { blackClip: 0.96, whiteClip: 0.04 } } }))).toMatchObject({ ok: false, message: expect.stringContaining("blackClip") });
  });
});

function foreground(color: { r: number; g: number; b: number }, key: NonNullable<ReturnType<typeof resolvedKey>>): number {
  const cb = (value: { r: number; g: number; b: number }) => -0.168736 * value.r - 0.331264 * value.g + 0.5 * value.b;
  const cr = (value: { r: number; g: number; b: number }) => 0.5 * value.r - 0.418688 * value.g - 0.081312 * value.b;
  const distance = Math.hypot(cb(color) - cb(key.keyColor), cr(color) - cr(key.keyColor)) / 1.5;
  const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  const threshold = key.similarity * (0.75 + key.shadow * 0.25 * luminance);
  const amount = Math.max(0, Math.min(1, (distance - threshold) / Math.max(0.0001, key.smoothness)));
  return amount * amount * (3 - 2 * amount);
}
function resolvedKey() { return { keyColor: { r: 0, g: 1, b: 0, a: 1 }, similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5 }; }
function imageLayer(overrides: Partial<MotionLayer> = {}): MotionLayer { return { id: "subject", type: "image", assetRef: "assets/subject.png", startMs: 0, durationMs: 1_000, transform: { width: 2, height: 1 }, ...overrides }; }
function document(layer: MotionLayer): MotionDocument { return { schema: "shellx-motion/motion@1", id: "keyed", name: "keyed", durationMs: 1_000, fps: 24, width: 2, height: 1, layers: [layer], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }; }
