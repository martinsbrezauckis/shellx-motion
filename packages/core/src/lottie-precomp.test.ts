import { describe, expect, it, vi } from "vitest";
import { flattenStaticLottiePrecomps } from "./lottie-precomp";

const identity = {
  p: { a: 0, k: [50, 50] },
  a: { a: 0, k: [50, 50] },
  s: { a: 0, k: [100, 100] },
  r: { a: 0, k: 0 },
  o: { a: 0, k: 100 }
};

function source(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100,
    assets: [{
      id: "scene", w: 100, h: 100,
      layers: [{ ind: 1, ty: 1, nm: "Solid", sw: 10, sh: 10, sc: "#ffffff", ip: 5, op: 25, ks: identity }]
    }],
    layers: [{ ind: 1, ty: 0, nm: "Group", refId: "scene", ip: 10, op: 20, st: 0, sr: 1, ks: identity }],
    ...overrides
  });
}

describe("static Lottie precomposition flattening", () => {
  it("flattens a full-frame identity precomp and intersects child timing", () => {
    const flattened = flattenStaticLottiePrecomps(source());
    const output = JSON.parse(flattened.animationText) as Record<string, any>;
    expect(flattened).toMatchObject({
      flattenedPrecompCount: 1,
      flattenedLayerCount: 1,
      maxDepth: 1,
      changed: true,
      policy: "full-frame-identity-static"
    });
    expect(output.layers).toEqual([expect.objectContaining({ ind: 1, ty: 1, nm: "Group/Solid", ip: 10, op: 20 })]);
  });

  it("returns the original text when no precomp is present", () => {
    const text = JSON.stringify({ v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, assets: [], layers: [] });
    expect(flattenStaticLottiePrecomps(text)).toMatchObject({ animationText: text, changed: false, flattenedPrecompCount: 0 });
  });

  it("rejects transformed, clipped-size, time-remapped, and cyclic precomps", () => {
    const transformed = JSON.parse(source()) as Record<string, any>;
    transformed.layers[0].ks.p.k = [60, 50];
    expect(() => flattenStaticLottiePrecomps(JSON.stringify(transformed))).toThrow("identity static transform");

    const clipped = JSON.parse(source()) as Record<string, any>;
    clipped.assets[0].w = 80;
    expect(() => flattenStaticLottiePrecomps(JSON.stringify(clipped))).toThrow("must match the containing");

    const remapped = JSON.parse(source()) as Record<string, any>;
    remapped.layers[0].tm = { a: 0, k: 0 };
    expect(() => flattenStaticLottiePrecomps(JSON.stringify(remapped))).toThrow("unsupported tm semantics");

    const cyclic = JSON.parse(source()) as Record<string, any>;
    cyclic.assets[0].layers = [{ ty: 0, refId: "scene", ip: 0, op: 30, ks: identity }];
    expect(() => flattenStaticLottiePrecomps(JSON.stringify(cyclic))).toThrow("cycle detected");
  });

  it("keeps the existing 256 lightweight expanded-layer limit compatible", () => {
    const flattened = flattenStaticLottiePrecomps(repeatedPrecompSource(256));
    expect(flattened).toMatchObject({ flattenedPrecompCount: 256, flattenedLayerCount: 256, maxDepth: 1, changed: true });
    expect((JSON.parse(flattened.animationText) as { layers: unknown[] }).layers).toHaveLength(256);
  });

  it("refuses repeated large precomps before cloning retained output", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expect(() => flattenStaticLottiePrecomps(repeatedPrecompSource(256, 96 * 1024)))
        .toThrow("16 MiB expanded-byte limit");
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("refuses nested shared large precomps before cloning retained output", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expect(() => flattenStaticLottiePrecomps(nestedRepeatedPrecompSource(2, 128, 96 * 1024)))
        .toThrow("16 MiB expanded-byte limit");
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });
});

function repeatedPrecompSource(count: number, payloadBytes = 0): string {
  return JSON.stringify({
    v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100,
    assets: [{
      id: "scene", w: 100, h: 100,
      layers: [{ ind: 1, ty: 1, nm: "Solid", sw: 10, sh: 10, sc: "#ffffff", ip: 0, op: 30, ks: identity, payload: "x".repeat(payloadBytes) }]
    }],
    layers: Array.from({ length: count }, (_, index) => ({ ind: index + 1, ty: 0, nm: `Group ${index + 1}`, refId: "scene", ip: 0, op: 30, st: 0, sr: 1, ks: identity }))
  });
}

function nestedRepeatedPrecompSource(groups: number, childrenPerGroup: number, payloadBytes: number): string {
  return JSON.stringify({
    v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100,
    assets: [
      { id: "leaf", w: 100, h: 100, layers: [{ ind: 1, ty: 1, nm: "Solid", sw: 10, sh: 10, sc: "#ffffff", ip: 0, op: 30, ks: identity, payload: "x".repeat(payloadBytes) }] },
      { id: "branch", w: 100, h: 100, layers: Array.from({ length: childrenPerGroup }, (_, index) => ({ ind: index + 1, ty: 0, nm: `Leaf ${index + 1}`, refId: "leaf", ip: 0, op: 30, st: 0, sr: 1, ks: identity })) }
    ],
    layers: Array.from({ length: groups }, (_, index) => ({ ind: index + 1, ty: 0, nm: `Group ${index + 1}`, refId: "branch", ip: 0, op: 30, st: 0, sr: 1, ks: identity }))
  });
}
