import { describe, expect, it } from "vitest";
import { compactGpuReadback, decodeGpuReadbackBase64, normalizeGpuReadback } from "./gpu-readback";

describe("compactGpuReadback", () => {
  it("decodes only canonical base64 with the exact declared byte length", () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    expect(decodeGpuReadbackBase64({ paddedBase64: bytes.toString("base64"), expectedBytes: bytes.length })).toEqual(bytes);
    expect(() => decodeGpuReadbackBase64({ paddedBase64: `${bytes.toString("base64")}A`, expectedBytes: bytes.length })).toThrow(/canonical bounded base64/);
    expect(() => decodeGpuReadbackBase64({ paddedBase64: "AA*A", expectedBytes: 3 })).toThrow(/declared byte length/);
    expect(() => decodeGpuReadbackBase64({ paddedBase64: bytes.toString("base64"), expectedBytes: bytes.length + 1 })).toThrow(/canonical bounded base64/);
  });

  it("decodes a full-HD padded frame without recursive regular-expression limits", () => {
    const frame = Buffer.alloc(1_920 * 1_080 * 4, 0x7f);
    const decoded = decodeGpuReadbackBase64({ paddedBase64: frame.toString("base64"), expectedBytes: frame.length });
    expect(decoded.byteLength).toBe(frame.length);
    expect([decoded[0], decoded[decoded.length - 1]]).toEqual([0x7f, 0x7f]);
  });

  it("removes 256-byte GPU row padding without reordering pixels", () => {
    const padded = new Uint8Array(512);
    padded.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    padded.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
    expect([...compactGpuReadback({ padded, width: 2, height: 2, bytesPerRow: 256 })]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("keeps a tight canonical base64 decode as the owned raw-RGBA buffer", () => {
    const source = Buffer.alloc(256);
    source.set([64, 32, 0, 128, 0, 0, 0, 0]);
    const normalized = normalizeGpuReadback({ paddedBase64: source.toString("base64"), width: 64, height: 1, bytesPerRow: 256 });
    expect(normalized.rgba).toEqual(source);
    expect(normalized.metrics).toEqual({
      schema: "shellx-motion/gpu-readback-frame@1", width: 64, height: 1, tightBytesPerRow: 256, mappedBytesPerRow: 256,
      gpuTextureToMappedReadbackBytes: 256, cdpBase64PayloadBytes: 344, hostBase64DecodedBytes: 256,
      allocations: { hostBase64Decode: 1, rowCompaction: 0, straightAlpha: 0 },
      copiedBytes: { rowCompaction: 0, straightAlpha: 0 },
      rowCompaction: "bypassed-tight-stride", straightAlpha: "in-place-owned-buffer"
    });
  });

  it("compacts padded rows exactly once before the owned in-place alpha normalization", () => {
    const padded = Buffer.alloc(512);
    padded.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    padded.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
    const normalized = normalizeGpuReadback({ paddedBase64: padded.toString("base64"), width: 2, height: 2, bytesPerRow: 256 });
    expect([...normalized.rgba]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(normalized.metrics).toMatchObject({
      gpuTextureToMappedReadbackBytes: 512, cdpBase64PayloadBytes: 684, hostBase64DecodedBytes: 512,
      allocations: { hostBase64Decode: 1, rowCompaction: 1, straightAlpha: 0 },
      copiedBytes: { rowCompaction: 16, straightAlpha: 0 }, rowCompaction: "copied-padded-rows"
    });
  });

  it("fails closed before a tight-row bypass when page output forges dimensions or stride", () => {
    const source = Buffer.alloc(256).toString("base64");
    expect(() => normalizeGpuReadback({ paddedBase64: source, width: 2, height: 1, bytesPerRow: 8 })).toThrow(/row stride/);
    expect(() => normalizeGpuReadback({ paddedBase64: source, width: 64.5, height: 1, bytesPerRow: 256 })).toThrow(/positive integers/);
    expect(() => normalizeGpuReadback({ paddedBase64: source, width: 64, height: 1, bytesPerRow: 257 })).toThrow(/row stride/);
  });
});
