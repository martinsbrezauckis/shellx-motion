import { describe, expect, it } from "vitest";
import { GPU_FRAME_INTENT_SCHEMA, GpuFrameIntentError, compileGpuFramePlan } from "./gpu-frame-intent";

const intent = {
  schema: GPU_FRAME_INTENT_SCHEMA,
  width: 32,
  height: 16,
  clear: { r: 0, g: 0, b: 0, a: 1 },
  draws: [
    { kind: "rect" as const, id: "plate", x: 2, y: 3, width: 10, height: 4, color: { r: 1, g: 0.5, b: 0, a: 0.75 } },
    { kind: "ellipse" as const, id: "orb", x: 20, y: 2, width: 8, height: 6, color: { r: 0, g: 0.5, b: 1, a: 0.5 }, strokeWidth: 0, stroke: { r: 0, g: 0, b: 0, a: 0 } },
    { kind: "triangles" as const, id: "triangle", vertices: [{ x: 16, y: 1 }, { x: 12, y: 8 }, { x: 20, y: 8 }], rotationDeg: 0, pivotX: 16, pivotY: 4, color: { r: 1, g: 1, b: 0, a: 1 } },
    { kind: "image" as const, id: "photo", resourceId: "image-a1", x: 1, y: 1, width: 12, height: 8, rotationDeg: 0, pivotX: 7, pivotY: 5, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 0.8 },
    { kind: "points" as const, id: "spark", seed: 19, points: [{ x: 16, y: 8, size: 3, color: { r: 0, g: 1, b: 1, a: 1 } }] }
  ]
};

describe("compileGpuFramePlan", () => {
  it("normalizes bounded rect/point intent deterministically without a renderer", () => {
    const first = compileGpuFramePlan(intent);
    const second = compileGpuFramePlan(JSON.parse(JSON.stringify(intent)));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.budget).toEqual({ rectangleCount: 2, pointCount: 1, computeParticleFieldCount: 0, computeParticleCount: 0, computeParticleComputeDispatchCount: 0, computeParticleRasterPassCount: 0, triangleVertexCount: 3, imageCount: 1, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0, textUtf8Bytes: 0, textSurfacePixels: 0, scene3dCount: 0, scene3dObjectCount: 0, scene3dVertexCount: 0, scene3dIndexCount: 0, environmentCount: 0, materialCount: 0, gradientStopCount: 0, pointBufferBytes: 32, computeParticleBufferBytes: 0, triangleBufferBytes: 72, imageVertexBufferBytes: 120, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 0, scene3dVertexBufferBytes: 0, scene3dIndexBufferBytes: 0, scene3dUniformBytes: 0, environmentUniformBytes: 0, materialUniformBytes: 0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 0, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount: 0, motionBlurSampleCount: 0, groupCount: 0, groupMaxDepth: 0, compositeCount: 0, compositeUniformBytes: 0, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 0, estimatedPlanBytes: 352 });
  });

  it("normalizes only the closed chroma-key threshold and spill controls", () => {
    const chromaKey = { keyColor: { r: 0, g: 1, b: 0, a: 1 }, similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5, matte: { denoiseRadiusPx: 0, growShrinkPx: 0, chokePx: 0, featherPx: 0, blackClip: 0, whiteClip: 1 } };
    const plan = compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 2, height: 1, clear: intent.clear, draws: [{ kind: "image", id: "keyed", resourceId: "subject", x: 0, y: 0, width: 2, height: 1, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1, chromaKey }] });
    expect(plan.draws[0]).toMatchObject({ kind: "image", chromaKey });
    expect(plan.budget).toMatchObject({ imageCount: 1, chromaKeyCount: 1, chromaKeyUniformBytes: 48, estimatedPlanBytes: 184 });
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1, height: 1, clear: intent.clear, draws: [{ kind: "image", id: "bad-key", resourceId: "subject", x: 0, y: 0, width: 1, height: 1, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1, chromaKey: { ...chromaKey, keyColor: { ...chromaKey.keyColor, a: 0.5 } } }] })).toThrow("keyColor.a");
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1, height: 1, clear: intent.clear, draws: [{ kind: "image", id: "unsafe-key", resourceId: "subject", x: 0, y: 0, width: 1, height: 1, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1, chromaKey: { ...chromaKey, shader: "package.wgsl" } }] })).toThrow("only fixed Motion chroma-key controls");
  });

  it("normalizes bounded per-vertex triangle paint without accepting malformed triples", () => {
    const vertices = [{ x: 0, y: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } }, { x: 2, y: 0, color: { r: 0, g: 1, b: 0, a: 0.5 } }, { x: 0, y: 2, color: { r: 0, g: 0, b: 1, a: 0.5 } }];
    const plan = compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 2, height: 2, clear: intent.clear, draws: [{ kind: "coloredTriangles", id: "path", vertices, rotationDeg: 0, pivotX: 1, pivotY: 1 }] });
    expect(plan.draws).toMatchObject([{ kind: "coloredTriangles", id: "path", vertices }]);
    expect(plan.budget).toMatchObject({ triangleVertexCount: 3, triangleBufferBytes: 72, estimatedPlanBytes: 72 });
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 2, height: 2, clear: intent.clear, draws: [{ kind: "coloredTriangles", id: "broken", vertices: [{ x: 0, y: 0, color: intent.clear }], rotationDeg: 0, pivotX: 0, pivotY: 0 }] })).toThrow("triangle triples");
  });

  it("admits fixed environment parameters without accepting package shader code", () => {
    const draw = {
      kind: "environment", id: "storm", environmentKind: "rain", mode: "scene", seed: 7, timeSeconds: 1.5,
      x: 0, y: 0, width: 32, height: 16, rotationDeg: 0, pivotX: 16, pivotY: 8, opacity: 0.8,
      sceneResourceId: "plate", effectMaskResourceId: "weather-mask", shaderSource: "hostile package code",
      colors: [
        { r: 0, g: 0, b: 0, a: 1 }, { r: 0.7, g: 0.9, b: 1, a: 1 },
        { r: 0.2, g: 0.4, b: 0.7, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }
      ],
      parameters: [0.8, 0.2, 1.4, 1, 4, 0.45, 0.9, 0.2, 0.7, 0.6, 0.8, 0.4, 0.3, 0, 0, 0]
    };
    const plan = compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: intent.clear, draws: [draw] });
    expect(plan.draws[0]).toMatchObject({ kind: "environment", id: "storm", environmentKind: "rain", sceneResourceId: "plate" });
    expect(plan.draws[0]).toHaveProperty("parameters", expect.arrayContaining([0.8, 0.2, 1.4, 1, 4]));
    expect(plan.draws[0]).not.toHaveProperty("shaderSource");
    expect(plan.budget).toMatchObject({ environmentCount: 1, environmentUniformBytes: 208, compositeCount: 1, compositeUniformBytes: 64, estimatedPlanBytes: 352 });
    expect(compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: intent.clear, draws: [{ ...draw, timeSeconds: 2 }] }).fingerprint).not.toBe(plan.fingerprint);
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: intent.clear, draws: [{ ...draw, parameters: [2, ...draw.parameters.slice(1)] }] })).toThrow("parameters[0]");
  });

  it("refuses shader source, duplicate draw ids, and unbounded point input", () => {
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0] }, { ...intent.draws[0] }] })).toThrow(GpuFrameIntentError);
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "shader", id: "unsafe" } as never] })).toThrow("unsupported kind");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "points", id: "overflow", seed: 1, points: Array.from({ length: 65_537 }, () => ({ x: 0, y: 0, size: 1, color: { r: 1, g: 1, b: 1, a: 1 } })) }] })).toThrow("point instances");
    expect(() => compileGpuFramePlan({ ...intent, draws: Array.from({ length: 2_049 }, (_, index) => ({ kind: "points", id: `empty-${index}`, seed: index, points: [] })) })).toThrow("draw batches");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "points", id: "bad-seed", seed: 1.5, points: [] }] })).toThrow("unsigned 32-bit");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "triangles", id: "incomplete", vertices: [{ x: 0, y: 0 }], color: { r: 1, g: 1, b: 1, a: 1 } }] })).toThrow("triangle triples");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "image", id: "bad-image", resourceId: "bad image", x: 0, y: 0, width: 1, height: 1, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1 }] })).toThrow("resource identifier");
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1, height: 1, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [null] })).toThrow("must be an object");
  });

  it("separates bounded offscreen ellipse geometry from the 4096px frame-texture limit", () => {
    const ellipse = { kind: "ellipse", id: "distant-orbit", x: -65_000, y: -20_000, width: 131_072, height: 40_000, color: { r: 0, g: 0, b: 0, a: 0 }, strokeWidth: 1, stroke: { r: 0.5, g: 0.75, b: 1, a: 0.25 } };
    expect(compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1_920, height: 1_080, clear: intent.clear, draws: [ellipse] }).draws[0]).toMatchObject({ kind: "ellipse", width: 131_072, strokeWidth: 1 });
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1_920, height: 1_080, clear: intent.clear, draws: [{ ...ellipse, width: 131_073 }] })).toThrow("131072");
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1_920, height: 1_080, clear: intent.clear, draws: [{ ...ellipse, stroke: undefined }] })).toThrow("stroke must contain");
  });

  it("separates a transformed image quad from its bounded source texture", () => {
    const image = { kind: "image", id: "saturn-closeup", resourceId: "saturn-png", x: -2_800, y: -1_200, width: 7_540, height: 3_770, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1 };
    expect(compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1_920, height: 1_080, clear: intent.clear, draws: [image] }).draws[0]).toMatchObject({ kind: "image", width: 7_540, height: 3_770 });
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 1_920, height: 1_080, clear: intent.clear, draws: [{ ...image, width: 131_073 }] })).toThrow("131072");
  });

  it("normalizes every declared blend mode with bounded compositor accounting", () => {
    const modes = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"] as const;
    const plan = compileGpuFramePlan({
      schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: modes.map((blendMode, index) => ({ kind: "rect", id: `mode-${index}`, blendMode, x: index, y: 0, width: 1, height: 1, color: { r: 1, g: 1, b: 1, a: 1 } }))
    });
    expect(plan.draws.map((draw) => draw.kind === "adjustment" || draw.kind === "motionBlurEnd" || draw.kind === "groupEnd" ? draw.kind : draw.blendMode)).toEqual(modes);
    expect(plan.budget).toMatchObject({ rectangleCount: 17, blendModeCount: 16, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, blurPassCount: 0, compositeCount: 16, compositeUniformBytes: 1024, blurUniformBytes: 0, glowUniformBytes: 0, compositeIntermediateTextureBytes: 4_096 });
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], blendMode: "unsupported" }] })).toThrow("blendMode is unsupported");
  });

  it("normalizes bounded color effects and shares fixed compositor intermediates", () => {
    const plan = compileGpuFramePlan({
      schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: [{ ...intent.draws[0], effects: { blur: 8, brightness: 1.2, contrast: 1.1, saturate: 0.75, grayscale: 0.25, glow: { radius: 12, color: { r: 0, g: 0.5, b: 1, a: 0.8 } } } }]
    });
    expect(plan.draws[0]).toMatchObject({ effects: { blur: 8, brightness: 1.2, contrast: 1.1, saturate: 0.75, grayscale: 0.25, glow: { radius: 12, color: { r: 0, g: 0.5, b: 1, a: 0.8 } } } });
    expect(plan.budget).toMatchObject({ blendModeCount: 0, colorEffectCount: 1, blurEffectCount: 1, glowEffectCount: 1, blurPassCount: 4, compositeCount: 1, compositeUniformBytes: 64, blurUniformBytes: 64, glowUniformBytes: 32, compositeIntermediateTextureBytes: 6_144 });
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], effects: { brightness: 5 } }] })).toThrow("brightness must be finite");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], effects: { blur: 129 } }] })).toThrow("blur must be finite");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], effects: { glow: { radius: 4, color: "red" } } }] })).toThrow("glow.color must contain finite r, g, b and a channels");
  });

  it("normalizes deterministic full-frame adjustment inputs", () => {
    const plan = compileGpuFramePlan({
      schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: [{ kind: "adjustment", id: "finish", vignette: { amount: 0.8, softness: 0.6, color: { r: 0.1, g: 0.2, b: 0.3, a: 0.75 } }, filmGrain: { amount: 0.2, size: 3, frameSeed: 0xfedcba98 } }]
    });
    expect(plan.draws[0]).toMatchObject({ kind: "adjustment", filmGrain: { frameSeed: 0xfedcba98 } });
    expect(plan.budget).toMatchObject({ adjustmentCount: 1, adjustmentUniformBytes: 48, compositeCount: 0, compositeIntermediateTextureBytes: 2_048, estimatedPlanBytes: 64 });
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "adjustment", id: "empty", vignette: null, filmGrain: null }] })).toThrow("must declare vignette or film grain");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ kind: "adjustment", id: "bad-grain", vignette: null, filmGrain: { amount: 1, size: 9, frameSeed: 0 } }] })).toThrow("size must be an integer");
  });

  it("normalizes a bounded geometric layer mask into compositor accounting", () => {
    const mask = { shape: "rect" as const, x: 4, y: 3, width: 20, height: 10, radius: 3, rotationDeg: 15, pivotX: 14, pivotY: 8, inverted: false, opacity: 0.75, featherPx: 2 };
    const plan = compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], mask }] });
    expect(plan.draws[0]).toMatchObject({ mask });
    expect(plan.budget).toMatchObject({ maskCount: 1, maskUniformBytes: 48, compositeCount: 1, compositeUniformBytes: 64, compositeIntermediateTextureBytes: 6_144, estimatedPlanBytes: 192 });
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], mask: { ...mask, shape: "path" } }] })).toThrow("mask.shape is unsupported");
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], mask: { ...mask, featherPx: 129 } }] })).toThrow("featherPx must be in 0..128");
  });

  it("admits only a zero-radius fixed triangle mask for typed triangle track mattes", () => {
    const mask = { shape: "triangle" as const, x: 4, y: 3, width: 20, height: 10, radius: 0, rotationDeg: 0, pivotX: 14, pivotY: 8, inverted: false, opacity: 0.75, featherPx: 0 };
    const plan = compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], mask }] });
    expect(plan.draws[0]).toMatchObject({ mask });
    expect(plan.budget).toMatchObject({ maskCount: 1, compositeCount: 1, maskUniformBytes: 48 });
    expect(() => compileGpuFramePlan({ ...intent, draws: [{ ...intent.draws[0], mask: { ...mask, radius: 1 } }] })).toThrow("radius must be zero");
  });

  it("admits exact nested precomposition spans and budgets retained surfaces", () => {
    const rect=(id:string)=>({kind:"rect",id,x:0,y:0,width:4,height:4,color:{r:1,g:1,b:1,a:1}});
    const group=(id:string,drawCount:number)=>({kind:"groupStart",id,drawCount,x:4,y:2,scale:1.5,rotationDeg:15,pivotX:16,pivotY:8,opacity:0.8,blendMode:"screen",effects:null});
    const draws=[group("outer",4),rect("a"),group("inner",1),rect("b"),{kind:"groupEnd",id:"inner.end",groupId:"inner"},{kind:"groupEnd",id:"outer.end",groupId:"outer"}];
    const plan=compileGpuFramePlan({schema:GPU_FRAME_INTENT_SCHEMA,width:32,height:16,clear:intent.clear,draws});
    expect(plan.budget).toMatchObject({groupCount:2,groupMaxDepth:2,compositeCount:2,compositeUniformBytes:128,compositeIntermediateTextureBytes:24_576});
    expect(plan.draws[0]).toMatchObject({kind:"groupStart",drawCount:4,x:4,y:2,scale:1.5,opacity:0.8});
    expect(()=>compileGpuFramePlan({schema:GPU_FRAME_INTENT_SCHEMA,width:32,height:16,clear:intent.clear,draws:[group("bad",1),rect("a"),{kind:"groupEnd",id:"bad.end",groupId:"wrong"}]})).toThrow("exact opener");
  });

  it("admits exact flat temporal groups and rejects malformed or nested group grammar", () => {
    const sample = (id: string, x: number) => ({ kind: "rect", id, blendMode: "normal", effects: null, x, y: 0, width: 4, height: 4, color: { r: 1, g: 0, b: 0, a: 0.5 } });
    const draws = [
      { kind: "motionBlurStart", id: "hero.motion-blur", sampleCount: 2, drawCount: 2, shutterAngle: 180, shutterDurationMs: 16.666, blendMode: "screen", effects: null },
      sample("hero.sample-0.0", 2), sample("hero.sample-1.0", 6),
      { kind: "motionBlurEnd", id: "hero.motion-blur.end", groupId: "hero.motion-blur" }
    ];
    const plan = compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: intent.clear, draws });
    expect(plan.budget).toMatchObject({ rectangleCount: 2, blendModeCount: 1, motionBlurGroupCount: 1, motionBlurSampleCount: 2, compositeCount: 1, compositeIntermediateTextureBytes: 4_096, estimatedPlanBytes: 208 });
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: intent.clear, draws: draws.slice(0, -1) })).toThrow("exact closing marker");
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: 32, height: 16, clear: intent.clear, draws: [draws[0], { ...sample("bad", 0), blendMode: "screen" }, draws[2], draws[3]] })).toThrow("must be uncomposited");
  });
});
