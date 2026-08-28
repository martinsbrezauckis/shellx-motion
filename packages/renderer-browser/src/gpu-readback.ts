import { InternalGpuFrameError, type GpuReadbackFrameMetrics } from "./gpu-runtime-types";

/** Decodes the page readback without accepting non-canonical or oversized base64. */
export function decodeGpuReadbackBase64(input: { paddedBase64: unknown; expectedBytes: number }): Buffer {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1) throw new InternalGpuFrameError("GPU readback expected byte length must be a positive safe integer.");
  const expectedBase64Length = Math.ceil(input.expectedBytes / 3) * 4;
  if (typeof input.paddedBase64 !== "string" || input.paddedBase64.length !== expectedBase64Length) {
    throw new InternalGpuFrameError("GPU readback is not canonical bounded base64.");
  }
  const decoded = Buffer.from(input.paddedBase64, "base64");
  if (decoded.byteLength !== input.expectedBytes || decoded.toString("base64") !== input.paddedBase64) throw new InternalGpuFrameError("GPU readback base64 does not match its declared byte length.");
  return decoded;
}

/** Removes WebGPU's mandatory 256-byte row padding after a texture readback. */
export function compactGpuReadback(input: { padded: Uint8Array; width: number; height: number; bytesPerRow: number }): Buffer {
  const compactBytesPerRow = input.width * 4;
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new InternalGpuFrameError("GPU readback dimensions must be positive integers.");
  }
  if (!Number.isInteger(input.bytesPerRow) || input.bytesPerRow < compactBytesPerRow || input.bytesPerRow % 256 !== 0) {
    throw new InternalGpuFrameError("GPU readback row stride must be 256-byte aligned and contain a full RGBA row.");
  }
  if (input.padded.byteLength !== input.bytesPerRow * input.height) throw new InternalGpuFrameError("GPU readback byte length does not match its declared padded dimensions.");
  const compact = Buffer.allocUnsafe(compactBytesPerRow * input.height);
  for (let row = 0; row < input.height; row += 1) compact.set(input.padded.subarray(row * input.bytesPerRow, row * input.bytesPerRow + compactBytesPerRow), row * compactBytesPerRow);
  return compact;
}

/**
 * Return a tightly packed, exclusively owned Buffer and exact transport facts.
 * A tight mapped row is already an FFmpeg-sized row, so it reuses the fresh
 * canonical base64 decode. Padded rows allocate and copy exactly once.
 */
export function normalizeGpuReadback(input: {
  paddedBase64: unknown;
  width: number;
  height: number;
  bytesPerRow: number;
}): { rgba: Buffer; metrics: GpuReadbackFrameMetrics } {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new InternalGpuFrameError("GPU readback dimensions must be positive integers.");
  }
  const tightBytesPerRow = input.width * 4;
  if (!Number.isSafeInteger(tightBytesPerRow) || tightBytesPerRow < 4) {
    throw new InternalGpuFrameError("GPU readback dimensions exceed the tight RGBA transport budget.");
  }
  if (!Number.isInteger(input.bytesPerRow) || input.bytesPerRow < tightBytesPerRow || input.bytesPerRow % 256 !== 0) {
    throw new InternalGpuFrameError("GPU readback row stride must be 256-byte aligned and contain a full RGBA row.");
  }
  const mappedBytes = input.bytesPerRow * input.height;
  const compactBytes = tightBytesPerRow * input.height;
  if (!Number.isSafeInteger(mappedBytes) || mappedBytes < 1 || !Number.isSafeInteger(compactBytes) || compactBytes < 1) {
    throw new InternalGpuFrameError("GPU readback mapped byte length is outside the safe transport budget.");
  }
  const padded = decodeGpuReadbackBase64({ paddedBase64: input.paddedBase64, expectedBytes: mappedBytes });
  const isTight = input.bytesPerRow === tightBytesPerRow;
  const rgba = isTight
    ? padded
    : compactGpuReadback({ padded, width: input.width, height: input.height, bytesPerRow: input.bytesPerRow });
  return {
    rgba,
    metrics: {
      schema: "shellx-motion/gpu-readback-frame@1",
      width: input.width,
      height: input.height,
      tightBytesPerRow,
      mappedBytesPerRow: input.bytesPerRow,
      gpuTextureToMappedReadbackBytes: mappedBytes,
      cdpBase64PayloadBytes: Math.ceil(mappedBytes / 3) * 4,
      hostBase64DecodedBytes: mappedBytes,
      allocations: { hostBase64Decode: 1, rowCompaction: isTight ? 0 : 1, straightAlpha: 0 },
      copiedBytes: { rowCompaction: isTight ? 0 : compactBytes, straightAlpha: 0 },
      rowCompaction: isTight ? "bypassed-tight-stride" : "copied-padded-rows",
      straightAlpha: "in-place-owned-buffer"
    }
  };
}
