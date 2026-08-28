import { describe, expect, it } from "vitest";
import { compileGpuSceneAdjustment } from "./gpu-scene-adjustment";
import type { MotionDocument, MotionLayer } from "./types";

const motion = { fps: 30 } as MotionDocument;

describe("GPU scene adjustment lowering", () => {
  it("binds authored vignette and per-frame deterministic film grain", () => {
    const layer = { id: "finish", type: "adjustment", startMs: 100, durationMs: 1_000, effects: { vignette: { amount: 0.8, softness: 0.6, color: "#10203080" }, filmGrain: { amount: 0.25, size: 3, seed: 42 } } } as MotionLayer;
    const first = compileGpuSceneAdjustment(layer, motion, 600);
    const repeat = compileGpuSceneAdjustment(layer, motion, 600);
    const next = compileGpuSceneAdjustment(layer, motion, 634);
    expect(first).toEqual(repeat);
    expect(first).toMatchObject({ ok: true, draw: { kind: "adjustment", vignette: { amount: 0.8, softness: 0.6, color: { r: 16 / 255, g: 32 / 255, b: 48 / 255, a: 128 / 255 } }, filmGrain: { amount: 0.25, size: 3 } } });
    expect(next.ok && first.ok ? next.draw.filmGrain?.frameSeed : null).not.toBe(first.ok ? first.draw.filmGrain?.frameSeed : null);
  });

  it("refuses missing and malformed adjustment controls", () => {
    expect(compileGpuSceneAdjustment({ id: "empty", type: "adjustment", startMs: 0, durationMs: 1_000 } as MotionLayer, motion, 0)).toMatchObject({ ok: false });
    expect(compileGpuSceneAdjustment({ id: "bad", type: "adjustment", startMs: 0, durationMs: 1_000, effects: { filmGrain: { amount: 1, size: 9, seed: 0 } } } as MotionLayer, motion, 0)).toMatchObject({ ok: false });
  });
});
