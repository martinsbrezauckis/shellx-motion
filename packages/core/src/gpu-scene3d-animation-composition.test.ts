import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards, renderLanesFor, unrenderablePackageRefusal } from "./capabilities";
import {
  compileGpuScene3DAnimationFramePlan,
  compileGpuScene3DAnimationStaticPlan,
  GPU_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA,
  GPU_SCENE3D_ANIMATION_STATIC_PLAN_SCHEMA,
} from "./gpu-scene3d-animation-composition";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { GPU_UNLOWERED_ROOT_AUTHORITIES } from "./gpu-root-authority-fence";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { admitStrictScene3dPreviewDocument } from "./gpu-scene3d-animation-admission";
import { motionScene3DAnimationPackageRefusal } from "./motion-scene3d-animation-lane-refusal";
import type { MotionDocument } from "./types";

describe("O6 strict GPU scene3d animation preview composition", () => {
  it("keeps the shared GPU root-authority fence closed to procedural and compositing authority", () => {
    expect(GPU_UNLOWERED_ROOT_AUTHORITIES).toEqual(["relationships", "compositing"]);
  });

  it("refuses unlowered relationships and compositing roots across generic and O6 GPU planning without evaluating them", () => {
    for (const root of GPU_UNLOWERED_ROOT_AUTHORITIES) {
      let rootReads = 0, assetsReads = 0, layersReads = 0, resourceReads = 0;
      const document = new Proxy({
        schema: "shellx-motion/motion@1",
        id: `hostile-${root}`,
        name: "Hostile root authority",
        durationMs: 1_000,
        fps: 30,
        width: 16,
        height: 8,
        provenance: { sourceApp: "test", createdBy: "test" },
        scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] },
      }, {
        get(target, key, receiver) {
          if (key === root) { rootReads += 1; throw new Error(`${root} getter must remain unread`); }
          if (key === "assets") { assetsReads += 1; throw new Error("assets must remain unread"); }
          if (key === "layers") { layersReads += 1; throw new Error("layers must remain unread"); }
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === root) return { enumerable: true, configurable: true, get() { rootReads += 1; throw new Error(`${root} accessor must remain unread`); } };
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }) as unknown as MotionDocument;
      const resources = new Proxy({}, { get() { resourceReads += 1; throw new Error("frame resources must remain unread"); } });
      for (const compile of [
        () => compileGpuSceneStaticPlan(document),
        () => compileGpuScene2dPlan(document, 0, resources),
        () => compileGpuScene3DAnimationStaticPlan(document),
      ]) {
        expect(compile()).toEqual({
          ok: false,
          failure: {
            code: "gpu_unsupported_feature",
            message: expect.stringContaining(`document ${root} authority`),
          },
        });
      }
      expect({ rootReads, assetsReads, layersReads, resourceReads }).toEqual({ rootReads: 0, assetsReads: 0, layersReads: 0, resourceReads: 0 });

      const capabilityDocument = animatedScene();
      delete capabilityDocument.scene3dAnimation;
      Object.defineProperty(capabilityDocument, root, { configurable: true, enumerable: true, value: {} });
      expect(matchRendererCapability(capabilityDocument, GPU_CAPABILITY)).toMatchObject({
        ok: false,
        unsupported: [expect.objectContaining({ reason: expect.stringContaining(`document ${root} authority`) })],
      });
    }
  });

  it("refuses GPU capability before enumerating layers when an unlowered root is hostile", () => {
    for (const root of GPU_UNLOWERED_ROOT_AUTHORITIES) {
      let rootReads = 0, layersReads = 0;
      const document = new Proxy({
        schema: "shellx-motion/motion@1",
        id: `hostile-capability-${root}`,
        name: "Hostile capability authority",
        durationMs: 1_000,
        fps: 30,
        width: 16,
        height: 8,
        provenance: { sourceApp: "test", createdBy: "test" },
      }, {
        get(target, key, receiver) {
          if (key === root) { rootReads += 1; throw new Error(`${root} getter must remain unread`); }
          if (key === "layers") { layersReads += 1; throw new Error("layers must remain unread"); }
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === root) return { enumerable: true, configurable: true, get() { rootReads += 1; throw new Error(`${root} accessor must remain unread`); } };
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }) as unknown as MotionDocument;

      expect(matchRendererCapability(document, GPU_CAPABILITY)).toMatchObject({
        ok: false,
        lane: "gpu",
        unsupported: [expect.objectContaining({
          layerId: "document",
          feature: "gpu.scene.eligibility",
          reason: expect.stringContaining(`document ${root} authority`),
        })],
      });
      expect({ rootReads, layersReads }).toEqual({ rootReads: 0, layersReads: 0 });
    }
  });

  it("refuses an accessor scene3dAnimation root before reading hostile assets or layers", () => {
    let assetsReads = 0, layersReads = 0;
    const document = new Proxy({
      schema: "shellx-motion/motion@1",
      id: "hostile_scene",
      name: "Hostile scene",
      durationMs: 1_000,
      fps: 30,
      width: 16,
      height: 8,
      provenance: { sourceApp: "test", createdBy: "test" },
    }, {
      get(target, key, receiver) {
        if (key === "assets") { assetsReads += 1; throw new Error("assets must remain unread"); }
        if (key === "layers") { layersReads += 1; throw new Error("layers must remain unread"); }
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === "scene3dAnimation") return { enumerable: true, configurable: true, get() { throw new Error("accessor must not run"); } };
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    }) as unknown as MotionDocument;

    expect(compileGpuScene3DAnimationStaticPlan(document)).toEqual({
      ok: false,
      failure: {
        code: "gpu_unsupported_feature",
        message: "GPU scene3d animation preview requires scene3dAnimation as an enumerable data field."
      }
    });
    expect({ assetsReads, layersReads }).toEqual({ assetsReads: 0, layersReads: 0 });
  });

  it("descriptor-admits O6 assets and layers before static or frame planning can read hostile roots", () => {
    for (const field of ["assets", "layers"] as const) {
      const source = animatedScene();
      const original = source[field];
      let reads = 0;
      Object.defineProperty(source, field, { configurable: true, enumerable: true, get() { reads += 1; return original; } });
      expect(compileGpuScene3DAnimationStaticPlan(source)).toMatchObject({
        ok: false,
        failure: { code: "gpu_unsupported_feature", message: expect.stringContaining(`${field} as an enumerable data field`) },
      });
      expect(reads).toBe(0);
    }

    for (const field of ["assets", "layers"] as const) {
      const source = animatedScene();
      let reads = 0;
      const hostile = new Proxy(source, {
        get(target, key, receiver) {
          if (key === field) { reads += 1; throw new Error(`${field} must remain unread`); }
          return Reflect.get(target, key, receiver);
        },
      }) as MotionDocument;
      expect(compileGpuScene3DAnimationStaticPlan(hostile)).toMatchObject({ ok: true });
      expect(reads).toBe(0);
    }

    const source = animatedScene();
    const staticPlan = compileGpuScene3DAnimationStaticPlan(source);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    let assetsReads = 0, layersReads = 0;
    const hostile = new Proxy(source, {
      get(target, key, receiver) {
        if (key === "assets") { assetsReads += 1; throw new Error("assets must remain unread"); }
        if (key === "layers") { layersReads += 1; throw new Error("layers must remain unread"); }
        return Reflect.get(target, key, receiver);
      },
    }) as MotionDocument;
    const frame = compileGpuScene3DAnimationFramePlan(hostile, staticPlan.plan, 500_000, {});
    expect(frame.ok, frame.ok ? undefined : frame.failure.message).toBe(true);
    expect({ assetsReads, layersReads }).toEqual({ assetsReads: 0, layersReads: 0 });
  });

  it("materializes the complete O6 document before static or frame compilers can touch hostile data", () => {
    const ordinary = animatedScene() as MotionDocument & Record<string, unknown>;
    ordinary.unknownO6Data = { source: ["loaded", { value: 1 }] };
    const loaded = JSON.parse(JSON.stringify(ordinary)) as MotionDocument;
    const ordinaryPlan = compileGpuScene3DAnimationStaticPlan(ordinary);
    const loadedPlan = compileGpuScene3DAnimationStaticPlan(loaded);
    expect(ordinaryPlan).toMatchObject({ ok: true });
    expect(loadedPlan).toMatchObject({ ok: true });
    if (!ordinaryPlan.ok || !loadedPlan.ok) return;
    expect(loadedPlan.plan.documentFingerprint).toBe(ordinaryPlan.plan.documentFingerprint);
    const admission = admitStrictScene3dPreviewDocument(ordinary);
    expect(admission.motion).toMatchObject({ unknownO6Data: { source: ["loaded", { value: 1 }] } });
    expect(Object.isFrozen(admission.motion)).toBe(true);
    expect(Object.isFrozen((admission.motion as unknown as Record<string, unknown>).unknownO6Data)).toBe(true);

    const cases: ReadonlyArray<readonly [string, (motion: MotionDocument, onRead: () => void) => void]> = [
      ["top-level id", (motion, onRead) => Object.defineProperty(motion, "id", { configurable: true, enumerable: true, get: onRead })],
      ["top-level name", (motion, onRead) => Object.defineProperty(motion, "name", { configurable: true, enumerable: true, get: onRead })],
      ["top-level duration", (motion, onRead) => Object.defineProperty(motion, "durationMs", { configurable: true, enumerable: true, get: onRead })],
      ["top-level fps", (motion, onRead) => Object.defineProperty(motion, "fps", { configurable: true, enumerable: true, get: onRead })],
      ["top-level dimensions", (motion, onRead) => Object.defineProperty(motion, "width", { configurable: true, enumerable: true, get: onRead })],
      ["top-level height", (motion, onRead) => Object.defineProperty(motion, "height", { configurable: true, enumerable: true, get: onRead })],
      ["top-level background", (motion, onRead) => Object.defineProperty(motion, "background", { configurable: true, enumerable: true, get: onRead })],
      ["top-level provenance", (motion, onRead) => Object.defineProperty(motion, "provenance", { configurable: true, enumerable: true, get: onRead })],
      ["top-level safe areas", (motion, onRead) => Object.defineProperty(motion, "safeAreas", { configurable: true, enumerable: true, get: onRead })],
      ["top-level design tokens", (motion, onRead) => Object.defineProperty(motion, "designTokens", { configurable: true, enumerable: true, get: onRead })],
      ["layer start", (motion, onRead) => Object.defineProperty(motion.layers[0]!, "startMs", { configurable: true, enumerable: true, get: onRead })],
      ["layer transform", (motion, onRead) => Object.defineProperty(motion.layers[0]!, "transform", { configurable: true, enumerable: true, get: onRead })],
      ["scene objects", (motion, onRead) => Object.defineProperty(motion.layers[0]!.scene3d!, "objects", { configurable: true, enumerable: true, get: onRead })],
      ["mesh", (motion, onRead) => Object.defineProperty(motion.layers[0]!.scene3d!.objects[0]!, "mesh", { configurable: true, enumerable: true, get: onRead })],
      ["mesh arrays", (motion, onRead) => {
        const object = motion.layers[0]!.scene3d!.objects[0]! as unknown as Record<string, unknown>;
        object.mesh = { vertices: [] };
        Object.defineProperty(object.mesh as object, "vertices", { configurable: true, enumerable: true, get: onRead });
      }],
      ["material arrays", (motion, onRead) => {
        const object = motion.layers[0]!.scene3d!.objects[0]! as unknown as Record<string, unknown>;
        object.mesh = { materials: [] };
        Object.defineProperty(object.mesh as object, "materials", { configurable: true, enumerable: true, get: onRead });
      }],
    ];
    for (const [label, install] of cases) {
      const hostile = animatedScene();
      let reads = 0;
      install(hostile, () => { reads += 1; throw new Error(`${label} getter must remain unread`); });
      expect(compileGpuScene3DAnimationStaticPlan(hostile)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature" } });
      expect(reads, label).toBe(0);
    }

    const proxyHostile = animatedScene();
    let proxyReads = 0;
    proxyHostile.layers[0]!.scene3d!.objects[0] = new Proxy(proxyHostile.layers[0]!.scene3d!.objects[0]!, {
      get() { proxyReads += 1; throw new Error("nested proxy must remain unread"); },
    });
    expect(compileGpuScene3DAnimationStaticPlan(proxyHostile)).toMatchObject({ ok: true });
    expect(proxyReads).toBe(0);

    const frameHostile = animatedScene();
    let frameReads = 0, resourceReads = 0;
    Object.defineProperty(frameHostile.layers[0]!, "startMs", { configurable: true, enumerable: true, get() { frameReads += 1; throw new Error("frame start must remain unread"); } });
    const resources = new Proxy({}, { get() { resourceReads += 1; throw new Error("frame resources must remain unread"); } });
    expect(compileGpuScene3DAnimationFramePlan(frameHostile, ordinaryPlan.plan, 500_000, resources)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature" } });
    expect({ frameReads, resourceReads }).toEqual({ frameReads: 0, resourceReads: 0 });
  });

  it("refuses reflection-hostile, cyclic, and over-budget O6 data before compilers or hashes run", () => {
    const reflectionHostile = animatedScene();
    let getReads = 0;
    reflectionHostile.layers[0]!.scene3d!.objects = new Proxy(reflectionHostile.layers[0]!.scene3d!.objects, {
      ownKeys() { throw new Error("reflection must be refused"); },
      get() { getReads += 1; throw new Error("proxy data must remain unread"); },
    });
    expect(compileGpuScene3DAnimationStaticPlan(reflectionHostile)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("reflection failed") } });
    expect(getReads).toBe(0);

    const cyclic = animatedScene() as MotionDocument & { unknown?: Record<string, unknown> };
    cyclic.unknown = {}; cyclic.unknown.self = cyclic.unknown;
    expect(compileGpuScene3DAnimationStaticPlan(cyclic)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("cyclic") } });

    const tooDeep = animatedScene() as MotionDocument & { unknown?: Record<string, unknown> };
    let nested: Record<string, unknown> = {};
    tooDeep.unknown = nested;
    for (let index = 0; index < 65; index += 1) { const next: Record<string, unknown> = {}; nested.next = next; nested = next; }
    expect(compileGpuScene3DAnimationStaticPlan(tooDeep)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("depth-64") } });

    const tooLarge = animatedScene() as MotionDocument & { unknown?: Record<string, unknown> };
    tooLarge.unknown = { first: "x".repeat(4 * 1024 * 1024), second: "x".repeat(4 * 1024 * 1024 + 1) };
    expect(compileGpuScene3DAnimationStaticPlan(tooLarge)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("byte limit") } });

    const tooManyEntries = animatedScene() as MotionDocument & { unknown?: unknown };
    tooManyEntries.unknown = new Array(100_001).fill(null);
    expect(compileGpuScene3DAnimationStaticPlan(tooManyEntries)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("entry array limit") } });

    const holey = animatedScene();
    holey.layers = new Array(1) as typeof holey.layers;
    expect(compileGpuScene3DAnimationStaticPlan(holey)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("dense JSON data arrays") } });

    for (const [label, value] of [["function", () => undefined], ["bigint", 1n], ["undefined", undefined]] as const) {
      const nonJson = animatedScene() as MotionDocument & { unknown?: unknown };
      nonJson.unknown = value;
      expect(compileGpuScene3DAnimationStaticPlan(nonJson), label).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("JSON data only") } });
    }
    const symbol = animatedScene();
    Object.defineProperty(symbol, Symbol("non-json"), { configurable: true, enumerable: true, value: "refuse" });
    expect(compileGpuScene3DAnimationStaticPlan(symbol)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("JSON string keys") } });

    const nonEnumerable = animatedScene();
    let hiddenReads = 0;
    Object.defineProperty(nonEnumerable, "privateGetter", { configurable: true, get() { hiddenReads += 1; throw new Error("non-enumerable getter must remain unread"); } });
    expect(compileGpuScene3DAnimationStaticPlan(nonEnumerable)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("privateGetter as an enumerable data field") } });
    expect(hiddenReads).toBe(0);

    const hiddenSymbol = animatedScene();
    let hiddenSymbolReads = 0;
    Object.defineProperty(hiddenSymbol, Symbol("hidden"), { configurable: true, get() { hiddenSymbolReads += 1; throw new Error("symbol getter must remain unread"); } });
    expect(compileGpuScene3DAnimationStaticPlan(hiddenSymbol)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("JSON string keys") } });
    expect(hiddenSymbolReads).toBe(0);

    const hiddenArrayField = animatedScene();
    let hiddenArrayReads = 0;
    Object.defineProperty(hiddenArrayField.layers, "privateGetter", { configurable: true, get() { hiddenArrayReads += 1; throw new Error("array getter must remain unread"); } });
    expect(compileGpuScene3DAnimationStaticPlan(hiddenArrayField)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("dense JSON data arrays") } });
    expect(hiddenArrayReads).toBe(0);

    const hiddenArraySymbol = animatedScene();
    let hiddenArraySymbolReads = 0;
    Object.defineProperty(hiddenArraySymbol.layers, Symbol("hidden"), { configurable: true, get() { hiddenArraySymbolReads += 1; throw new Error("array symbol getter must remain unread"); } });
    expect(compileGpuScene3DAnimationStaticPlan(hiddenArraySymbol)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("JSON string keys") } });
    expect(hiddenArraySymbolReads).toBe(0);

    for (const [label, install] of [
      ["root layers", (motion: MotionDocument, hostile: unknown[]) => { motion.layers = hostile as typeof motion.layers; }],
      ["scene objects", (motion: MotionDocument, hostile: unknown[]) => { motion.layers[0]!.scene3d!.objects = hostile as never; }],
      ["mesh materials", (motion: MotionDocument, hostile: unknown[]) => { (motion.layers[0]!.scene3d!.objects[0]! as unknown as Record<string, unknown>).mesh = { materials: hostile }; }],
    ] as const) {
      const customPrototype = animatedScene();
      let reads = 0;
      install(customPrototype, exoticArray([], () => { reads += 1; throw new Error(`${label} must remain unread`); }));
      expect(compileGpuScene3DAnimationStaticPlan(customPrototype), label).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("plain JSON arrays") } });
      expect(reads, label).toBe(0);
    }

    const nullPrototypeRecord = animatedScene() as MotionDocument & { unknown?: unknown };
    let nullRecordReads = 0;
    const record = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(record, "hidden", { configurable: true, enumerable: true, get() { nullRecordReads += 1; throw new Error("null-prototype record must remain unread"); } });
    nullPrototypeRecord.unknown = record;
    expect(compileGpuScene3DAnimationStaticPlan(nullPrototypeRecord)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("plain JSON records") } });
    expect(nullRecordReads).toBe(0);

    const nullPrototypeArray = animatedScene();
    let nullArrayReads = 0;
    nullPrototypeArray.layers = exoticArray([], () => { nullArrayReads += 1; throw new Error("null-prototype array must remain unread"); }, null) as typeof nullPrototypeArray.layers;
    expect(compileGpuScene3DAnimationStaticPlan(nullPrototypeArray)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("plain JSON arrays") } });
    expect(nullArrayReads).toBe(0);

    for (const root of ["behaviors", "relations"] as const) {
      const hiddenRootData = animatedScene();
      Object.defineProperty(hiddenRootData, root, { configurable: true, value: {} });
      expect(compileGpuScene3DAnimationStaticPlan(hiddenRootData), root).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining(`${root} as an enumerable data field`) } });

      const hiddenRootAccessor = animatedScene();
      let rootReads = 0;
      Object.defineProperty(hiddenRootAccessor, root, { configurable: true, get() { rootReads += 1; throw new Error(`${root} must remain unread`); } });
      expect(compileGpuScene3DAnimationStaticPlan(hiddenRootAccessor), root).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining(`${root} as an enumerable data field`) } });
      expect(rootReads, root).toBe(0);
    }
  });

  it("rejects inherited or non-plain GPU documents before static, frame, O6, or capability reads", () => {
    const ordinary = animatedScene(); delete ordinary.scene3dAnimation;
    const inherited = Object.assign(Object.create({ relationships: {} }), ordinary) as MotionDocument;
    const staticPlan = compileGpuScene3DAnimationStaticPlan(animatedScene());
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    let reads = 0;
    const hostile = new Proxy(inherited, {
      get(target, key, receiver) {
        if (key === "layers" || key === "assets" || key === "durationMs") { reads += 1; throw new Error("document data must remain unread"); }
        return Reflect.get(target, key, receiver);
      },
    }) as MotionDocument;
    for (const result of [
      compileGpuSceneStaticPlan(hostile),
      compileGpuScene2dPlan(hostile, 0),
      compileGpuScene3DAnimationStaticPlan(hostile),
      compileGpuScene3DAnimationFramePlan(hostile, staticPlan.plan, 500_000),
    ]) {
      expect(result).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("plain Motion document") } });
    }
    expect(matchRendererCapability(hostile, GPU_CAPABILITY)).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ reason: expect.stringContaining("plain Motion document") })],
    });
    expect(reads).toBe(0);
  });

  it("binds one accepted sampled compiler frame to the settled GPU Scene3D frame plan", () => {
    const motion = animatedScene();
    const staticPlan = compileGpuScene3DAnimationStaticPlan(motion);
    expect(staticPlan).toMatchObject({
      ok: true,
      plan: {
        schema: GPU_SCENE3D_ANIMATION_STATIC_PLAN_SCHEMA,
        targetLayerIds: ["world"],
        limits: { target: "preview", output: "png-frame", maxSceneLayers: 4, maxSceneObjects: 32, maxMeshVertices: 8192, maxMeshIndices: 49152, maxTracks: 64, maxKeyframes: 2048, maxFrameWorkUnits: 256 },
      },
    });
    if (!staticPlan.ok) return;
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { message: "GPU static planning does not yet support document scene3dAnimation@1." } });
    expect(compileGpuScene2dPlan(motion, 500)).toMatchObject({ ok: false, failure: { message: "GPU frame planning does not yet support document scene3dAnimation@1." } });

    const frame = compileGpuScene3DAnimationFramePlan(motion, staticPlan.plan, 500_000);
    expect(frame).toMatchObject({ ok: true, plan: { schema: GPU_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA, staticFingerprint: staticPlan.plan.fingerprint, atUs: 500_000, animationFramePlan: { atUs: 500_000 } } });
    if (!frame.ok) return;
    const draw = frame.plan.frame.draws.find((candidate) => candidate.id === "world");
    expect(draw).toMatchObject({ kind: "scene3d", background: { r: 0, g: 0, b: 0, a: 1 }, intensity: 1.5 });
    expect(Object.isFrozen(frame.plan)).toBe(true);
  });

  it("refuses an unlowered root added after static minting before time validation, hashing, or resources", () => {
    const motion = animatedScene();
    const staticPlan = compileGpuScene3DAnimationStaticPlan(motion);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    for (const root of GPU_UNLOWERED_ROOT_AUTHORITIES) {
      let rootReads = 0, durationReads = 0, layersReads = 0, resourceReads = 0;
      const hostile = { ...motion } as MotionDocument;
      Object.defineProperty(hostile, root, { configurable: true, enumerable: true, get() { rootReads += 1; throw new Error(`${root} must remain unread`); } });
      Object.defineProperty(hostile, "durationMs", { configurable: true, enumerable: true, get() { durationReads += 1; throw new Error("duration must remain unread"); } });
      Object.defineProperty(hostile, "layers", { configurable: true, enumerable: true, get() { layersReads += 1; throw new Error("layers must remain unread"); } });
      const resources = new Proxy({}, { get() { resourceReads += 1; throw new Error("resources must remain unread"); } });

      expect(compileGpuScene3DAnimationFramePlan(hostile, staticPlan.plan, 500_000, resources)).toEqual({
        ok: false,
        failure: {
          code: "gpu_unsupported_feature",
          message: expect.stringContaining(`document ${root} authority`),
        },
      });
      expect({ rootReads, durationReads, layersReads, resourceReads }).toEqual({ rootReads: 0, durationReads: 0, layersReads: 0, resourceReads: 0 });
    }
  });

  it("refuses forged, stale, and nonrepresentable wrappers before any caller resource is read", () => {
    const motion = animatedScene();
    const staticPlan = compileGpuScene3DAnimationStaticPlan(motion);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    let reads = 0;
    const forbiddenResources = new Proxy({}, { get() { reads += 1; throw new Error("resources must not be read"); } });
    expect(compileGpuScene3DAnimationFramePlan(motion, { ...staticPlan.plan }, 500_000, forbiddenResources)).toEqual({ ok: false, failure: { code: "gpu_resource_refused", message: "GPU scene3d animation preview requires an exact Core-issued static execution wrapper." } });
    const stale = structuredClone(motion); stale.layers[0] = { ...stale.layers[0]!, name: "stale" };
    expect(compileGpuScene3DAnimationFramePlan(stale, staticPlan.plan, 500_000, forbiddenResources)).toEqual({ ok: false, failure: { code: "gpu_resource_refused", message: "GPU scene3d animation preview static execution wrapper is stale for this Motion document." } });
    const long = structuredClone(motion); long.durationMs = 9_000_000_000_001; long.fps = 1; long.layers[0]!.durationMs = long.durationMs;
    expect(compileGpuScene3DAnimationFramePlan(long, staticPlan.plan, 9_000_000_000_000_001, forbiddenResources)).toEqual({ ok: false, failure: { code: "gpu_invalid_time", message: "GPU scene3d animation preview atUs cannot round-trip through the legacy GPU millisecond ABI." } });
    expect(reads).toBe(0);
  });

  it("refuses companion nesting, invalid locators, and scene resource ceilings during static preflight", () => {
    const nested = animatedScene();
    nested.layers.push({ id: "group", type: "group", childLayerIds: [], startMs: 0, durationMs: 1_000 });
    expect(compileGpuScene3DAnimationStaticPlan(nested)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("nested or companion layer group") } });

    const badLocator = animatedScene();
    badLocator.scene3dAnimation!.tracks = [{ id: "missing", locator: { layerId: "world", scope: "object", objectId: "missing", property: "scale" }, keyframes: [{ atUs: 0, value: 1 }] }];
    expect(compileGpuScene3DAnimationStaticPlan(badLocator)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("unknown object world/missing") } });

    const overLimit = animatedScene();
    overLimit.layers = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(overLimit.layers[0]!), id: `world-${index}` }));
    overLimit.scene3dAnimation!.tracks = [{ id: "limit", locator: { layerId: "world-0", scope: "lighting", property: "intensity" }, keyframes: [{ atUs: 0, value: 1 }] }];
    expect(compileGpuScene3DAnimationStaticPlan(overLimit)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("at most 4") } });
  });

  it("advertises only the exact strict png-frame preview route while generic and final lanes still refuse", () => {
    const motion = animatedScene();
    expect(matchRendererCapability(motion, GPU_CAPABILITY)).toMatchObject({ ok: false, unsupported: [{ feature: "motion.scene3d-animation@1" }] });
    expect(matchRendererCapabilityCards(motion, { target: "preview", output: "png-frame" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: true });
    expect(motionScene3DAnimationPackageRefusal(motion)).toMatchObject({
      code: "package_unrenderable",
      message: expect.stringContaining("direct @shellx-motion/renderer-browser renderMotionGpuPreview PNG-preview API"),
      suggestedAction: expect.stringContaining("O6 package limits"),
    });
    expect(matchRendererCapabilityCards(motion, { target: "preview", output: "raw-rgba" }).matches.find((match) => match.lane === "gpu")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "motion.scene3d-animation@1.strict-browser-gpu-preview", reason: expect.stringContaining("only png-frame output") })],
    });
    expect(matchRendererCapabilityCards(motion, { target: "final", output: "raw-rgba" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: false });
    expect(renderLanesFor(motion)).toEqual(["gpu"]);
    expect(unrenderablePackageRefusal(motion)).toBeNull();
  });
});

function animatedScene(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "o6-scene", name: "O6 Scene", durationMs: 1_000, fps: 30, width: 100, height: 60,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
      scene3d: {
        schema: "shellx-motion/scene3d@1", camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
        lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" }, backgroundColor: "#101820",
        objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }],
      },
    }],
    scene3dAnimation: {
      schema: "shellx-motion/scene3d-animation@1",
      tracks: [
        { id: "background", locator: { layerId: "world", scope: "background", property: "color" }, keyframes: [{ atUs: 0, value: "#000000" }] },
        { id: "intensity", locator: { layerId: "world", scope: "lighting", property: "intensity" }, keyframes: [{ atUs: 500_000, value: 1.5 }] },
      ],
    },
  };
}

function exoticArray<T>(values: T[], onRead: () => void, prototype: object | null = { hidden: "exotic" }): T[] {
  Object.setPrototypeOf(values, prototype);
  return new Proxy(values, { get() { onRead(); throw new Error("custom-prototype array must remain unread"); } });
}
