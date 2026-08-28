import type { GpuReadbackFrameObservation } from "./gpu-runtime-types";
import type { GpuReadbackTransportEvidence } from "./gpu-streaming-producer-types";

/** Aggregate only exact scalar readback observations; no frame buffers or lists are retained. */
export function createGpuReadbackTransportAccumulator(): {
  observe(frame: GpuReadbackFrameObservation): { ok: true } | { ok: false; message: string };
  finish(expectedFrames: number): { ok: true; evidence: GpuReadbackTransportEvidence } | { ok: false; message: string };
} {
  let first: GpuReadbackFrameObservation | null = null;
  let framesObserved = 0;
  let gpuTextureToMappedReadbackBytes = 0;
  let cdpBase64PayloadBytes = 0;
  let hostBase64DecodedBytes = 0;
  let hostBase64DecodeAllocations = 0;
  let rowCompactionAllocations = 0;
  let rowCompactionCopiedBytes = 0;
  let tightRowFrames = 0;
  let paddedRowFrames = 0;
  let timingTotalNanoseconds = 0;
  let timingMinNanoseconds: number | null = null;
  let timingMaxNanoseconds = 0;

  return {
    observe(frame) {
      const valid = validateFrame(frame);
      if (!valid.ok) return valid;
      if (first && !sameLayout(first, frame)) return { ok: false, message: "GPU readback transport changed its admitted frame layout." };
      const totals = [
        gpuTextureToMappedReadbackBytes + frame.gpuTextureToMappedReadbackBytes,
        cdpBase64PayloadBytes + frame.cdpBase64PayloadBytes,
        hostBase64DecodedBytes + frame.hostBase64DecodedBytes,
        hostBase64DecodeAllocations + frame.allocations.hostBase64Decode,
        rowCompactionAllocations + frame.allocations.rowCompaction,
        rowCompactionCopiedBytes + frame.copiedBytes.rowCompaction,
        tightRowFrames + (frame.rowCompaction === "bypassed-tight-stride" ? 1 : 0),
        paddedRowFrames + (frame.rowCompaction === "copied-padded-rows" ? 1 : 0),
        timingTotalNanoseconds + frame.hostFrameElapsedNanoseconds
      ];
      if (!totals.every(isSafeNonNegativeInteger)) return { ok: false, message: "GPU readback transport counters exceed the bounded safe-integer range." };
      first ??= frame;
      framesObserved += 1;
      gpuTextureToMappedReadbackBytes = totals[0]!;
      cdpBase64PayloadBytes = totals[1]!;
      hostBase64DecodedBytes = totals[2]!;
      hostBase64DecodeAllocations = totals[3]!;
      rowCompactionAllocations = totals[4]!;
      rowCompactionCopiedBytes = totals[5]!;
      tightRowFrames = totals[6]!;
      paddedRowFrames = totals[7]!;
      timingTotalNanoseconds = totals[8]!;
      timingMinNanoseconds = timingMinNanoseconds === null ? frame.hostFrameElapsedNanoseconds : Math.min(timingMinNanoseconds, frame.hostFrameElapsedNanoseconds);
      timingMaxNanoseconds = Math.max(timingMaxNanoseconds, frame.hostFrameElapsedNanoseconds);
      return { ok: true };
    },
    finish(expectedFrames) {
      if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || framesObserved !== expectedFrames || !first || timingMinNanoseconds === null) {
        return { ok: false, message: "GPU readback transport evidence does not cover every emitted canonical frame." };
      }
      const evidence: GpuReadbackTransportEvidence = {
        schema: "shellx-motion/gpu-readback-transport@1",
        transport: {
          path: "webgpu-texture-map-read-cdp-base64-owned-rgba",
          framesObserved,
          width: first.width,
          height: first.height,
          tightBytesPerRow: first.tightBytesPerRow,
          mappedBytesPerRow: first.mappedBytesPerRow,
          bytes: {
            gpuTextureToMappedReadback: gpuTextureToMappedReadbackBytes,
            cdpBase64Payload: cdpBase64PayloadBytes,
            hostBase64Decoded: hostBase64DecodedBytes
          },
          allocations: { hostBase64Decode: hostBase64DecodeAllocations, rowCompaction: rowCompactionAllocations, straightAlpha: 0 },
          rowCompaction: { tightRowFrames, paddedRowFrames, copiedBytes: rowCompactionCopiedBytes, allocationCount: rowCompactionAllocations },
          straightAlpha: { inPlaceOwnedBufferFrames: framesObserved, copiedBytes: 0, allocationCount: 0 },
          output: { format: "rgba", colorSpace: "srgb", alphaMode: "straight", strideBytes: first.tightBytesPerRow, hashing: "sha256-tight-straight-rgba" }
        },
        timing: {
          observational: true,
          clock: "node-process-hrtime",
          scope: "admitted-frame-render-and-readback",
          framesObserved,
          totalNanoseconds: timingTotalNanoseconds,
          minNanoseconds: timingMinNanoseconds,
          maxNanoseconds: timingMaxNanoseconds
        }
      };
      return { ok: true, evidence: freezeEvidence(evidence) };
    }
  };
}

function validateFrame(frame: GpuReadbackFrameObservation): { ok: true } | { ok: false; message: string } {
  const scalarFields = [
    frame.width, frame.height, frame.tightBytesPerRow, frame.mappedBytesPerRow,
    frame.gpuTextureToMappedReadbackBytes, frame.cdpBase64PayloadBytes, frame.hostBase64DecodedBytes,
    frame.copiedBytes.rowCompaction, frame.hostFrameElapsedNanoseconds
  ];
  if (frame.schema !== "shellx-motion/gpu-readback-frame@1" || !scalarFields.every(isSafeNonNegativeInteger) || frame.width < 1 || frame.height < 1) {
    return { ok: false, message: "GPU readback transport received malformed scalar frame evidence." };
  }
  const tightBytesPerRow = frame.width * 4;
  const mappedBytes = frame.mappedBytesPerRow * frame.height;
  if (!isSafeNonNegativeInteger(tightBytesPerRow) || !isSafeNonNegativeInteger(mappedBytes)
    || frame.tightBytesPerRow !== tightBytesPerRow || frame.mappedBytesPerRow < tightBytesPerRow || frame.mappedBytesPerRow % 256 !== 0
    || frame.gpuTextureToMappedReadbackBytes !== mappedBytes || frame.hostBase64DecodedBytes !== mappedBytes
    || frame.cdpBase64PayloadBytes !== Math.ceil(mappedBytes / 3) * 4 || frame.allocations.hostBase64Decode !== 1
    || frame.allocations.straightAlpha !== 0 || frame.copiedBytes.straightAlpha !== 0
    || frame.straightAlpha !== "in-place-owned-buffer" || frame.hostClock !== "node-process-hrtime" || frame.hostTimingScope !== "admitted-frame-render-and-readback") {
    return { ok: false, message: "GPU readback transport frame evidence is internally inconsistent." };
  }
  const tight = frame.mappedBytesPerRow === tightBytesPerRow;
  if ((tight && (frame.rowCompaction !== "bypassed-tight-stride" || frame.allocations.rowCompaction !== 0 || frame.copiedBytes.rowCompaction !== 0))
    || (!tight && (frame.rowCompaction !== "copied-padded-rows" || frame.allocations.rowCompaction !== 1 || frame.copiedBytes.rowCompaction !== tightBytesPerRow * frame.height))) {
    return { ok: false, message: "GPU readback row-compaction evidence does not match its mapped stride." };
  }
  return { ok: true };
}

function sameLayout(left: GpuReadbackFrameObservation, right: GpuReadbackFrameObservation): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.tightBytesPerRow === right.tightBytesPerRow
    && left.mappedBytesPerRow === right.mappedBytesPerRow;
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function freezeEvidence(evidence: GpuReadbackTransportEvidence): GpuReadbackTransportEvidence {
  return Object.freeze({
    ...evidence,
    transport: Object.freeze({
      ...evidence.transport,
      bytes: Object.freeze({ ...evidence.transport.bytes }),
      allocations: Object.freeze({ ...evidence.transport.allocations }),
      rowCompaction: Object.freeze({ ...evidence.transport.rowCompaction }),
      straightAlpha: Object.freeze({ ...evidence.transport.straightAlpha }),
      output: Object.freeze({ ...evidence.transport.output })
    }),
    timing: Object.freeze({ ...evidence.timing })
  });
}
