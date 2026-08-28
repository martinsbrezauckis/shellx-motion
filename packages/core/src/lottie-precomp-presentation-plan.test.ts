import { describe, expect, it } from "vitest";
import { flattenStaticLottiePrecomps } from "./lottie-precomp";
import { planLottiePrecompPresentations } from "./lottie-precomp-presentation-plan";

describe("Lottie transformed precomposition presentation plans", () => {
  it("extracts static and hold affine wrapper trajectories with their local clip rectangles", () => {
    const text = source({
      layers: [precomp("scene", 1, {
        ks: {
          a: property([10, 5]),
          p: { a: 1, k: [{ t: 0, s: [50, 30], h: 1 }, { t: 12, s: [70, 30] }] },
          s: property([200, 200]), r: property(90), o: property(80)
        }
      })],
      assets: [
        asset("scene", 80, 40, [precomp("tile", 2)]),
        asset("tile", 12, 8, [solid()])
      ]
    });
    const result = ok(planLottiePrecompPresentations(text));
    expect(result.plan).toMatchObject({
      schema: "shellx-motion/lottie-precomp-presentation-plan@2",
      source: { width: 100, height: 100, frameRate: 30, inFrame: 0, outFrame: 30 },
      limits: { maxAssets: 64, maxDepth: 4, maxPresentations: 64, maxTransformKeyframes: 16, maxInputWork: 4096 },
      presentations: [
        {
          id: "root/scene:1", assetId: "scene", layerIndex: 0, inFrame: 0, outFrame: 30,
          clipRect: { x: 0, y: 0, width: 80, height: 40 },
          transforms: [
            { frame: 0, atUs: 0, x: 40, y: 25, originX: 10, originY: 5, scale: 2, rotationDeg: 90, matrix: [0, 2, -2, 0, 60, 10], opacity: 0.8 },
            { frame: 12, atUs: 400000, x: 60, y: 25, originX: 10, originY: 5, scale: 2, rotationDeg: 90, matrix: [0, 2, -2, 0, 80, 10], opacity: 0.8 }
          ]
        },
        {
          id: "root/scene:1/tile:2", parentId: "root/scene:1", assetId: "tile",
          clipRect: { x: 0, y: 0, width: 12, height: 8 }, transforms: [{ frame: 0, matrix: [1, 0, 0, 1, 0, 0], opacity: 1 }]
        }
      ]
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "exact", code: "lottie.precomp.presentation.hold_affine_clip" })
    ]));
    expect(text).toEqual(source({
      layers: [precomp("scene", 1, {
        ks: { a: property([10, 5]), p: { a: 1, k: [{ t: 0, s: [50, 30], h: 1 }, { t: 12, s: [70, 30] }] }, s: property([200, 200]), r: property(90), o: property(80) }
      })],
      assets: [asset("scene", 80, 40, [precomp("tile", 2)]), asset("tile", 12, 8, [solid()])]
    }));
  });

  it("is independent from the live static precomp flattener", () => {
    const text = source({ layers: [precomp("scene", 1, { ks: { p: property([10, 0]) } })], assets: [asset("scene", 80, 40, [solid()])] });
    expect(ok(planLottiePrecompPresentations(text)).plan.presentations).toHaveLength(1);
    expect(() => flattenStaticLottiePrecomps(text)).toThrow("identity static transform");
  });

  it("accepts passive 2D root metadata plus sibling image and font data while indexing only layers assets", () => {
    const text = source({
      nm: "Standard named source",
      ddd: 0,
      slots: { accent: { p: { a: 0, k: [1, 0, 0, 1] } } },
      fonts: { list: [{ fName: "Brand-Regular", fFamily: "Brand", fStyle: "Regular", ascent: 75 }] },
      assets: [
        asset("scene", 80, 40, [solid()]),
        { id: "logo", w: 16, h: 12, u: "images/", p: "logo.png", e: 0 },
      ],
      layers: [precomp("scene", 1)]
    });
    const result = ok(planLottiePrecompPresentations(text));
    expect(result.plan.source).toMatchObject({ width: 100, height: 100, frameRate: 30 });
    expect(result.plan.presentations).toHaveLength(1);
    expect(text).toBe(source({
      nm: "Standard named source",
      ddd: 0,
      slots: { accent: { p: { a: 0, k: [1, 0, 0, 1] } } },
      fonts: { list: [{ fName: "Brand-Regular", fFamily: "Brand", fStyle: "Regular", ascent: 75 }] },
      assets: [
        asset("scene", 80, 40, [solid()]),
        { id: "logo", w: 16, h: 12, u: "images/", p: "logo.png", e: 0 },
      ],
      layers: [precomp("scene", 1)]
    }));
  });

  it("refuses executable, extension, interpolation, matte, and time-remap semantics without source mutation", () => {
    const cases = [
      { mutate: (value: any) => { value.layers[0].tm = { a: 0, k: 0 }; }, message: "unsupported tm semantics" },
      { mutate: (value: any) => { value.layers[0].tt = 1; }, message: "unsupported tt semantics" },
      { mutate: (value: any) => { value.layers[0].pluginData = { target: "a" }; }, message: "unknown extension field pluginData" },
      { mutate: (value: any) => { value.layers[0].ks = { p: { a: 1, k: [{ t: 0, s: [0, 0] }, { t: 10, s: [10, 0] }] } }; }, message: "supports hold keyframes only" },
      { mutate: (value: any) => { value.layers[0].ks = { p: { a: 0, k: [0, 0], x: "time*10" } }; }, message: "executable or unknown extension field x" },
      { mutate: (value: any) => { value.assets[0].layers[0]["x-vendor"] = { source: "plugin" }; }, message: "executable or unknown extension field x-vendor" },
      { mutate: (value: any) => { value.layers[0].ks = { sk: { a: 1, k: [{ t: 0, s: 0, h: 1 }, { t: 10, s: 10 }] } }; }, message: "transform sk is unsupported" }
    ];
    for (const { mutate, message } of cases) {
      const value = JSON.parse(source()) as Record<string, unknown>;
      mutate(value);
      const text = JSON.stringify(value);
      const result = planLottiePrecompPresentations(text);
      expect(result).toMatchObject({ status: "refused", diagnostics: [expect.objectContaining({ status: "refused", message: expect.stringContaining(message) })] });
      expect(text).toBe(JSON.stringify(value));
    }

    const non2d = JSON.parse(source()) as Record<string, unknown>;
    non2d.ddd = 1;
    const non2dText = JSON.stringify(non2d);
    expect(refusal(non2dText)).toContain("ddd must be 0");
    expect(non2dText).toBe(JSON.stringify(non2d));
  });

  it("enforces cycle, depth, presentation, keyframe, and source-work ceilings before returning a plan", () => {
    const animated = JSON.parse(source()) as Record<string, any>;
    animated.layers[0].ks = { p: { a: 1, k: Array.from({ length: 17 }, (_, index) => ({ t: index, s: [index, 0], h: 1 })) } };
    expect(refusal(JSON.stringify(animated))).toContain("at most 16 entries");

    const nonUniform = JSON.parse(source()) as Record<string, any>;
    nonUniform.layers[0].ks = { s: property([100, 80]) };
    expect(refusal(JSON.stringify(nonUniform))).toContain("positive uniform scale");

    const ambiguousTime = JSON.parse(source()) as Record<string, any>;
    ambiguousTime.layers[0].ks = { p: { a: 1, k: [{ t: 0, s: [0, 0], h: 1 }, { t: 1, s: [10, 0] }] } };
    expect(refusal(JSON.stringify(ambiguousTime))).toContain("cannot map losslessly");

    const nestedAssets = Array.from({ length: 5 }, (_, index) => asset(`asset-${index}`, 10, 10, index === 4 ? [solid()] : [precomp(`asset-${index + 1}`, index + 2)]));
    expect(refusal(source({ layers: [precomp("asset-0", 1)], assets: nestedAssets }))).toContain("depth-4 limit");

    const cyclic = source({ layers: [precomp("scene", 1)], assets: [asset("scene", 100, 100, [precomp("scene", 2)])] });
    expect(refusal(cyclic)).toContain("cycle detected");

    const presentations = source({
      layers: Array.from({ length: 65 }, (_, index) => precomp("scene", index + 1)),
      assets: [asset("scene", 1, 1, [solid()])]
    });
    expect(refusal(presentations)).toContain("64-presentation limit");

    const costly = source({
      layers: [],
      assets: Array.from({ length: 64 }, (_, index) => asset(`asset-${index}`, 1, 1, Array.from({ length: 64 }, () => solid())))
    });
    expect(refusal(costly)).toContain("4096-work limit");
  });
});

function source(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [precomp("scene", 1)], assets: [asset("scene", 100, 100, [solid()])], ...overrides });
}
function precomp(refId: string, ind: number, overrides: Record<string, unknown> = {}) { return { ind, ty: 0, nm: refId, refId, ip: 0, op: 30, st: 0, sr: 1, bm: 0, ...overrides }; }
function asset(id: string, w: number, h: number, layers: unknown[]) { return { id, w, h, layers }; }
function solid() { return { ind: 1, ty: 1, ip: 0, op: 30 }; }
function property(value: number | number[]) { return { a: 0, k: value }; }
function ok(result: ReturnType<typeof planLottiePrecompPresentations>) { if (result.status !== "ok") throw new Error(result.diagnostics[0]?.message); return result; }
function refusal(text: string): string { const result = planLottiePrecompPresentations(text); if (result.status !== "refused") throw new Error("expected refusal"); return result.diagnostics[0]?.message ?? ""; }
