import { describe, expect, it, vi } from "vitest";
import { diagnoseAdapterImport } from "./adapter-diagnostics";

describe("adapter diagnostic gradient work", () => {
  it("summarizes Lottie shape siblings once before classifying repeated gradient fills", () => {
    const gradientCount = 512;
    const filterSpy = vi.spyOn(Array.prototype, "filter");
    let diagnostics;
    try {
      diagnostics = diagnoseAdapterImport({
        adapterId: "adapter.lottie",
        sourcePath: "many-gradients.json",
        sourceText: JSON.stringify({
          w: 32,
          h: 32,
          fr: 30,
          ip: 0,
          op: 30,
          layers: [{ ty: 4, nm: "Many gradients", shapes: Array.from({ length: gradientCount }, () => ({ ty: "gf" })) }]
        }),
        normalizedPackagePath: "packages/many-gradients",
        createdAt: "2026-08-28T12:00:00.000Z"
      });
      // The three calls are the final per-status feature deduplications. A
      // per-gradient trio of sibling-array filters would add 1,536 calls.
      expect(filterSpy.mock.calls.length).toBe(3);
    } finally {
      filterSpy.mockRestore();
    }

    expect(diagnostics!.unsupportedFeatures).toHaveLength(gradientCount);
    expect(diagnostics!.unsupportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "lottie.layers[0]#Many gradients.shapes[0]",
        feature: "lottie.shape.gradient.linear",
        status: "unsupported",
        reason: "Editable gradient lowering requires exactly one static zero-radius rectangle, one gradient fill, and no solid fill in the same group."
      })
    ]));
  });
});
