import { describe, expect, it } from "vitest";
import { evaluateMotionParticles, particleFieldDeflection } from "./particle-evaluator";
import type { MotionParticleEmitter } from "./types";
import type { MotionParticleFieldSource } from "./particle-field-types";

const radial = (strength: number = 1) => ({
  kind: "radial" as const, centerX: 1, centerY: 0.5, strength, softening: 0.5
});

describe("analytic particle field evaluator", () => {
  it("has exact p=0, midpoint, end, centre, order, sign, and clamp vectors", () => {
    const emitter = emitterWith([radial()]);
    expect(particleFieldDeflection(emitter, 0, 0.5, 0)).toEqual({ x: 0, y: 0 });
    expect(particleFieldDeflection(emitter, 0, 0.5, 0.5)).toEqual({ x: 0.05, y: 0 });
    expect(particleFieldDeflection(emitter, 0, 0.5, 1)).toEqual({ x: 0.2, y: 0 });
    expect(particleFieldDeflection(emitter, 1, 0.5, 1)).toEqual({ x: 0, y: 0 });

    const ordered = emitterWith([
      { kind: "radial", centerX: 1, centerY: 0, strength: 1, softening: 1 },
      { kind: "vortex", centerX: 1, centerY: 0, strength: 1, softening: 1 }
    ]);
    expect(particleFieldDeflection(ordered, 0, 0, 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(particleFieldDeflection(emitterWith([...(ordered.field!.sources as MotionParticleFieldSource[])].reverse()), 0, 0, 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(particleFieldDeflection(emitterWith([radial(-1)]), 0, 0.5, 1)).toEqual({ x: -0.2, y: 0 });
    expect(particleFieldDeflection(emitterWith([
      { ...radial(), softening: 1 }, { ...radial(), softening: 1 }, { ...radial(), softening: 1 }
    ]), 0.5, 0.5, 1)).toEqual({ x: 2, y: 0 });
  });

  it("is capture-order independent, seeded, and six-decimal quantized", () => {
    const emitter = emitterWith([{ kind: "vortex", centerX: 0.55, centerY: 0.4, strength: 0.75, softening: 0.2 }]);
    const input = { emitter, atMs: 850, startMs: 100, width: 320, height: 180 };
    const first = evaluateMotionParticles(input);
    const second = evaluateMotionParticles(input);
    const earlier = evaluateMotionParticles({ ...input, atMs: 500 });
    expect(first).toEqual(second);
    expect(first).not.toEqual(earlier);
    expect(first).toHaveLength(3);
    for (const sample of first) {
      expect(sample.x).toBe(Number(sample.x.toFixed(6)));
      expect(sample.y).toBe(Number(sample.y.toFixed(6)));
      expect(sample.progress).toBe(Number(sample.progress.toFixed(6)));
    }
  });

  it("refuses hostile direct fields before unbounded sampling or non-finite output", () => {
    const oversized = [radial(), radial(), radial()];
    Object.defineProperty(oversized, 3, { enumerable: true, get: () => { throw new Error("must not read a fourth source"); } });
    expect(() => evaluateMotionParticles({
      emitter: emitterWith(oversized), atMs: 0, startMs: 0, width: 100, height: 100
    })).toThrow("between 1 and 3 sources");

    const nonFinite = emitterWith([{ ...radial(), strength: Number.NaN }]);
    expect(() => particleFieldDeflection(nonFinite, 0, 0.5, 1)).toThrow("strength must be a finite number");
    const executable = emitterWith([radial()]);
    let formulaRead = false;
    Object.defineProperty(executable.field!.sources[0]!, "formula", {
      enumerable: true,
      get: () => { formulaRead = true; throw new Error("formula getter must not run"); }
    });
    expect(() => particleFieldDeflection(executable, 0, 0.5, 1)).toThrow("does not support formula");
    expect(formulaRead).toBe(false);

    let strengthReads = 0;
    const validateOnce = emitterWith([{
      kind: "radial", centerX: 1, centerY: 0.5,
      get strength() { strengthReads += 1; return 0.5; },
      softening: 0.5
    }]);
    expect(evaluateMotionParticles({ emitter: validateOnce, atMs: 0, startMs: 0, width: 100, height: 100 })).toHaveLength(3);
    expect(strengthReads).toBe(1);

    const baseline = evaluateMotionParticles({ emitter: emitterWith([radial(0.5)]), atMs: 300, startMs: 0, width: 100, height: 100 });
    const legacyExtension = { ...emitterWith([radial(0.5)]), origins: [{ x: 0.1, y: 0.1, weight: 1 }] } as MotionParticleEmitter;
    expect(evaluateMotionParticles({ emitter: legacyExtension, atMs: 300, startMs: 0, width: 100, height: 100 })).toEqual(baseline);
  });
});

function emitterWith(sources: MotionParticleFieldSource[]): MotionParticleEmitter {
  return {
    seed: 19,
    count: 3,
    lifetimeMs: 1000,
    color: "#ffffff",
    field: { schema: "shellx-motion/particle-field@1", sources }
  };
}
