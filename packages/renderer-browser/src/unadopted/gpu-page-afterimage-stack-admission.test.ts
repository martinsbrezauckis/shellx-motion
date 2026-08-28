import { describe, expect, it } from "vitest";
import {
  admitGpuPageAfterimageStackDescriptor,
  GPU_PAGE_AFTERIMAGE_STACK_UNIFORM_BYTES,
  packGpuPageAfterimageStackUniform
} from "./gpu-page-afterimage-stack-admission";
import { createGpuPageAfterimageStackFixture } from "./gpu-page-afterimage-stack.test-support";

const descriptor = createGpuPageAfterimageStackFixture({
  width: 9,
  height: 7,
  echoes: [
    { dxPx: -4, dyPx: 3, rgba8: [255, 128, 0, 64], opacityQ16: 32_768 },
    { dxPx: 0, dyPx: -2, rgba8: [0, 32, 255, 255], opacityQ16: 65_535 }
  ],
  amountQ16: 16_384
});
const { drawId: _fixtureDrawId, ...withoutDrawId } = descriptor;

describe("fixed afterimage-stack page descriptor admission", () => {
  it("admits only a frozen 1..4 echo isolated-group descriptor", () => {
    const admitted = admitGpuPageAfterimageStackDescriptor(descriptor);
    expect(admitted).toEqual(descriptor);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted?.echoes)).toBe(true);
    expect(Object.isFrozen(admitted?.echoes[0].rgba8)).toBe(true);
  });

  it.each([
    [{ ...descriptor, echoes: [] }],
    [{ ...descriptor, echoes: [...descriptor.echoes, descriptor.echoes[0], descriptor.echoes[0], descriptor.echoes[0]] }],
    [createGpuPageAfterimageStackFixture({ drawId: "unbounded:draw" })],
    [{ ...descriptor, drawId: "effect-module-draw-3" }],
    [withoutDrawId],
    [{ ...descriptor, scopeGroupDrawId: "unbounded:value" }],
    [{ ...descriptor, moduleId: "motion.afterimage-stack.v1", intrinsic: "unexpected" }],
    [{ ...descriptor, bindingFingerprint: "A".repeat(64) }],
    [{ ...descriptor, amountQ16: 65_536 }],
    [{ ...descriptor, width: 0 }],
    [{ ...descriptor, echoes: [{ ...descriptor.echoes[0], dxPx: 257 }] }],
    [{ ...descriptor, echoes: [{ ...descriptor.echoes[0], rgba8: [255, 0, 0, 0.5] }] }],
    [{ ...descriptor, pipelineImplementationSha256: "e".repeat(64) }],
    [{ ...descriptor, resourceCeilingSha256: "f".repeat(64) }],
    [{ ...descriptor, moduleId: "Uppercase.Module" }],
    [{ ...descriptor, manifestByteLength: 16_385 }],
    [{ ...descriptor, timeMs: 10 }]
  ])("rejects malformed or unbounded descriptor %#", (candidate) => {
    expect(admitGpuPageAfterimageStackDescriptor(candidate)).toBeNull();
  });

  it("packs the canonical 160-byte WGSL layout without a time or seed field", () => {
    const admitted = admitGpuPageAfterimageStackDescriptor(descriptor);
    if (!admitted) throw new Error("fixture did not admit");
    const bytes = packGpuPageAfterimageStackUniform(admitted);
    expect(bytes.byteLength).toBe(GPU_PAGE_AFTERIMAGE_STACK_UNIFORM_BYTES);
    expect(Array.from(new Uint32Array(bytes, 0, 4))).toEqual([9, 7, 2, 0]);
    expect(Array.from(new Int32Array(bytes, 16, 8))).toEqual([-4, 3, 32_768, 0, 0, -2, 65_535, 0]);
    const colors = new Float32Array(bytes, 80, 8);
    expect(colors[0]).toBe(1); expect(colors[1]).toBeCloseTo(128 / 255, 7); expect(colors[2]).toBe(0); expect(colors[3]).toBeCloseTo(64 / 255, 7);
    expect(colors[4]).toBe(0); expect(colors[5]).toBeCloseTo(32 / 255, 7); expect(colors[6]).toBe(1); expect(colors[7]).toBe(1);
    const amount = new Float32Array(bytes, 144, 4);
    expect(amount[0]).toBeCloseTo(16_384 / 65_535, 7); expect(Array.from(amount.slice(1))).toEqual([0, 0, 0]);
  });
});
