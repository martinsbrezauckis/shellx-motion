import { describe, expect, it } from "vitest";
import { createGpuReadbackTransportAccumulator } from "./gpu-streaming-producer-readback-evidence";
import type { GpuReadbackFrameObservation } from "./gpu-runtime-types";

function frame(overrides: Partial<GpuReadbackFrameObservation> = {}): GpuReadbackFrameObservation {
  return {
    schema: "shellx-motion/gpu-readback-frame@1", width: 1920, height: 2, tightBytesPerRow: 7680, mappedBytesPerRow: 7680,
    gpuTextureToMappedReadbackBytes: 15_360, cdpBase64PayloadBytes: 20_480, hostBase64DecodedBytes: 15_360,
    allocations: { hostBase64Decode: 1, rowCompaction: 0, straightAlpha: 0 }, copiedBytes: { rowCompaction: 0, straightAlpha: 0 },
    rowCompaction: "bypassed-tight-stride", straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 17,
    hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback", ...overrides
  };
}

describe("GPU readback transport evidence", () => {
  it("reports exact tight-row bytes, zero compaction/straight-alpha copies, and observational timing", () => {
    const accumulator = createGpuReadbackTransportAccumulator();
    expect(accumulator.observe(frame())).toEqual({ ok: true });
    expect(accumulator.observe(frame({ hostFrameElapsedNanoseconds: 23 }))).toEqual({ ok: true });
    const result = accumulator.finish(2);
    expect(result).toMatchObject({ ok: true, evidence: {
      schema: "shellx-motion/gpu-readback-transport@1",
      transport: {
        path: "webgpu-texture-map-read-cdp-base64-owned-rgba", framesObserved: 2,
        bytes: { gpuTextureToMappedReadback: 30_720, cdpBase64Payload: 40_960, hostBase64Decoded: 30_720 },
        allocations: { hostBase64Decode: 2, rowCompaction: 0, straightAlpha: 0 },
        rowCompaction: { tightRowFrames: 2, paddedRowFrames: 0, copiedBytes: 0, allocationCount: 0 },
        straightAlpha: { inPlaceOwnedBufferFrames: 2, copiedBytes: 0, allocationCount: 0 },
        output: { format: "rgba", colorSpace: "srgb", alphaMode: "straight", strideBytes: 7680, hashing: "sha256-tight-straight-rgba" }
      },
      timing: { observational: true, framesObserved: 2, totalNanoseconds: 40, minNanoseconds: 17, maxNanoseconds: 23 }
    } });
  });

  it("fails closed when a frame's claimed compaction facts do not match its stride", () => {
    const accumulator = createGpuReadbackTransportAccumulator();
    expect(accumulator.observe(frame({ allocations: { hostBase64Decode: 1, rowCompaction: 1, straightAlpha: 0 } }))).toMatchObject({ ok: false, message: expect.stringMatching(/row-compaction/) });
    expect(accumulator.finish(1)).toMatchObject({ ok: false });
  });
});
