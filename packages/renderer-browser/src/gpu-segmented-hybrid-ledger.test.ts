import { describe, expect, it } from "vitest";
import { createGpuHybridCaptureLedger } from "./gpu-segmented-hybrid-ledger";

const hash = "a".repeat(64);

describe("GPU segmented hybrid range ledger", () => {
  it("binds global range bounds, exact timing, texture geometry, and ordered capture identities", () => {
    const ledger = createGpuHybridCaptureLedger({
      range: { index: 4, startFrameIndex: 120, endFrameIndexExclusive: 122 },
      expectedCaptureCount: 2,
    });
    ledger.observe(entry(120, 4_000));
    ledger.observe(entry(121, 4_033.333));
    expect(ledger.finish()).toMatchObject({
      rangeIndex: 4,
      startFrameIndex: 120,
      endFrameIndexExclusive: 122,
      captureCount: 2,
      entries: [
        { index: 120, atUs: 4_000_000, resourceId: "hybrid-slot", width: 1600, height: 900 },
        { index: 121, atUs: 4_033_333, resourceId: "hybrid-slot", width: 1600, height: 900 },
      ],
    });
  });

  it("refuses shifted ordering, malformed pixels, and incomplete ranges", () => {
    const shifted = createGpuHybridCaptureLedger({ range: { index: 0, startFrameIndex: 8, endFrameIndexExclusive: 10 }, expectedCaptureCount: 2 });
    shifted.observe(entry(9, 300));
    expect(() => shifted.observe(entry(8, 266.667))).toThrow(/exact ordered texture observation/);

    const malformed = createGpuHybridCaptureLedger({ range: { index: 0, startFrameIndex: 0, endFrameIndexExclusive: 1 }, expectedCaptureCount: 1 });
    expect(() => malformed.observe({ ...entry(0, 0), width: 0 })).toThrow(/exact ordered texture observation/);

    const incomplete = createGpuHybridCaptureLedger({ range: { index: 0, startFrameIndex: 0, endFrameIndexExclusive: 2 }, expectedCaptureCount: 1 });
    expect(() => incomplete.finish()).toThrow(/did not complete/);
  });
});

function entry(index: number, atMs: number) {
  return {
    index,
    atMs,
    atUs: Math.round(atMs * 1_000),
    requestFingerprint: hash,
    resourceId: "hybrid-slot",
    width: 1600,
    height: 900,
    pngSha256: hash,
    decodedRgbaSha256: hash,
  };
}
