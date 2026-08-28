import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA,
  admitCheckpointStoryboardScalarSpatialRecordProfile,
  compileCheckpointStoryboardPlan,
  compileCheckpointStoryboardScalarSpatialPlan,
  createCheckpointStoryboard,
  createTransitionRecipe,
} from "./checkpoint-storyboard";
import { loadSchemaSync, validateDocumentSync } from "../../validate";

const HASH = "a".repeat(64);
const MASK = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] as const;
const CATALOG = [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: MASK }] as const;

function state(x: number, y: number, rotation = 0, scale = 1, opacity = 1) {
  return {
    objectId: "orb", state: "present" as const,
    properties: [
      { property: "transform.x", value: x }, { property: "transform.y", value: y },
      { property: "transform.rotation", value: rotation }, { property: "transform.scale", value: scale }, { property: "opacity", value: opacity },
    ],
  };
}
function checkpoint(id: string, atUs: number, values = state(0, 0)) { return { id, atUs, objects: [values] }; }

function request(options: {
  readonly capability?: string;
  readonly capabilities?: readonly string[];
  readonly firstAtUs?: number;
  readonly finalAtUs?: number;
  readonly spatialMode?: "linear" | "smooth" | "broken" | "auto";
  readonly scalar?: boolean;
  readonly rootShapeKind?: "rect" | "ellipse";
  readonly dimensions?: "layer" | "transform";
  readonly catalogCreation?: boolean;
} = {}): any {
  const rootShapeKind = options.rootShapeKind ?? "ellipse";
  const dimensions = options.dimensions ?? "layer";
  const scalar = options.scalar === false ? undefined : createTransitionRecipe({
    recipeId: "scalar", seed: 2, exactBaseRequirements: [],
    intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] },
  });
  const spatial = createTransitionRecipe({
    recipeId: "spatial", seed: 3, exactBaseRequirements: [],
    intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: options.spatialMode ?? "auto" }] },
  });
  const recipes = scalar ? [scalar, spatial] : [spatial];
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: options.capabilities ?? [options.capability ?? "renderer.native"], objectCatalog: [{ ...CATALOG[0], rootShapeKind, ...(options.catalogCreation ? { creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } } : {}) }],
    checkpoints: [checkpoint("start", options.firstAtUs ?? 0), checkpoint("finish", options.finalAtUs ?? 1_000_000, state(100, 50, scalar ? 90 : 0, scalar ? 2 : 1, scalar ? 0.5 : 1))],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: recipes.map((recipe) => recipe.recipeId) }],
    recipes,
  });
  return {
    schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "Private C6B fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } },
      motion: {
        schema: "shellx-motion/motion@1", id: "motion-1", name: "Private C6B fixture", durationMs: 1_000, fps: 30, width: 1280, height: 720,
        layers: [{
          id: "orb", type: "shape", shape: rootShapeKind, fill: "#4e8cff", style: { stroke: "#102040", strokeWidth: 2 },
          ...(dimensions === "layer" ? { width: 120, height: 80 } : {}),
          startMs: 0, durationMs: 1_000,
          transform: { x: 0, y: 0, ...(dimensions === "transform" ? { width: 120, height: 80 } : {}) },
        }],
        assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      },
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [{ objectId: "orb", layerId: "orb" }],
  };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe("private C6B1a scalar/spatial checkpoint lowering", () => {
  it("shares one base-independent B1 record-profile admission with later exact-base lowering", () => {
    const input = request();
    expect(admitCheckpointStoryboardScalarSpatialRecordProfile(input.storyboard)).toEqual(input.storyboard);

    const absent = createCheckpointStoryboard({
      seed: 1, capabilityRequirements: ["renderer.native"], objectCatalog: CATALOG,
      checkpoints: [checkpoint("start", 0), { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "absent", properties: [] }] }],
      edges: [{ id: "remove", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "remove", objectId: "orb" }], recipeIds: [] }], recipes: [],
    });
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(absent)).toThrow("absent/create/remove lifecycle states");
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(request({ spatialMode: "smooth", scalar: false }).storyboard)).toThrow("only linear or auto checkpoint-spatial-path");
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(request({ firstAtUs: 1 }).storyboard)).toThrow(/time_resolution_unavailable|whole-millisecond checkpoint endpoints/);
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(request({ finalAtUs: 999_999 }).storyboard)).toThrow(/time_resolution_unavailable|whole-millisecond checkpoint endpoints/);
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(request({ rootShapeKind: "path" } as any).storyboard)).toThrow("geometry/morph or unsupported");
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(request({ rootShapeKind: "rect" }).storyboard)).not.toThrow();
    const lifecycleCatalog = request({ catalogCreation: true });
    expect(() => admitCheckpointStoryboardScalarSpatialRecordProfile(lifecycleCatalog.storyboard)).toThrow("catalog creation payloads");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(lifecycleCatalog)).toThrow("catalog creation payloads");
  });

  it("binds only sealed C6A facts to one exact base and emits frozen canonical scalar/spatial intents", () => {
    const input = request();
    const plan = compileCheckpointStoryboardScalarSpatialPlan(input);
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-scalar-spatial-plan@1",
      storyboard: { id: input.storyboard.id, sha256: input.storyboard.sha256, revision: 1, fingerprint: compileCheckpointStoryboardPlan(input.storyboard).fingerprint },
      base: { package: { id: "package-1", motionPath: "motion.json" }, manifest: { id: "package-1" }, canonicalMotion: { id: "motion-1" }, persistedMotion: { id: "motion-1", sha256: HASH } },
      objectLayerBindings: [{ objectId: "orb", layerId: "orb", layerIndex: 0, rootShapeKind: "ellipse" }],
      intendedChanges: { paths: [
        "/layers/0/keyframes/transform.rotation", "/layers/0/keyframes/transform.scale", "/layers/0/keyframes/opacity",
        "/layers/0/keyframes/transform.x", "/layers/0/keyframes/transform.y",
      ] },
      evidence: { noPackageIO: true, noPackageWrites: true, noReceipt: true, noPublicSurface: true, noRenderer: true },
    });
    expect(plan.lowerings).toHaveLength(2);
    expect(plan.lowerings[0]).toMatchObject({ kind: "checkpoint-keyframe" });
    expect((plan.lowerings[0] as Extract<typeof plan.lowerings[number], { kind: "checkpoint-keyframe" }>).properties[0]).toEqual({ property: "transform.rotation", keyframes: [{ atMs: 0, value: 0, easing: "ease-in-out" }, { atMs: 1_000, value: 90 }] });
    expect(plan.lowerings[1]).toMatchObject({ kind: "checkpoint-spatial-path", tangentMode: "auto", keyframes: { x: [{ atMs: 0, value: 0, spatial: { mode: "auto", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } } }, { atMs: 1_000, value: 100 }], y: [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 1_000, value: 50 }] } });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.lowerings)).toBe(true);
    expect(Object.isFrozen(plan.intendedChanges.keys)).toBe(true);
    expect(compileCheckpointStoryboardScalarSpatialPlan(clone(input))).toEqual(plan);
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on non-C6A identity, endpoint, capability, lifecycle, and recipe broadening", () => {
    const unsealed = clone(request());
    delete (unsealed.storyboard as { sha256?: string }).sha256;
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(unsealed)).toThrow("CheckpointStoryboard requires sha256");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(request({ firstAtUs: 1_000 }))).toThrow("first checkpoint at document zero");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(request({ finalAtUs: 999_000 }))).toThrow("final checkpoint at the exact document end");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(request({ capability: "renderer.ffmpeg" }))).toThrow("canonical renderer.browser or renderer.native");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(request({ capabilities: ["renderer.ffmpeg", "renderer.native"] }))).toThrow("canonical renderer.browser or renderer.native");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(request({ capabilities: [] }))).toThrow("one or more canonical renderer.browser or renderer.native");
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(request({ spatialMode: "smooth", scalar: false }))).toThrow("only linear or auto checkpoint-spatial-path");

    const absent = createCheckpointStoryboard({
      seed: 1, capabilityRequirements: ["renderer.native"], objectCatalog: CATALOG,
      checkpoints: [checkpoint("start", 0), { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "absent", properties: [] }] }],
      edges: [{ id: "remove", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "remove", objectId: "orb" }], recipeIds: [] }], recipes: [],
    });
    const absentRequest = request({ scalar: false }); absentRequest.storyboard = absent;
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(absentRequest)).toThrow("absent/create/remove lifecycle states");
  });

  it("accepts ordinary static rect and ellipse base facts while intending only C6B1a-owned channels", () => {
    const expectedPaths = [
      "/layers/0/keyframes/transform.rotation", "/layers/0/keyframes/transform.scale", "/layers/0/keyframes/opacity",
      "/layers/0/keyframes/transform.x", "/layers/0/keyframes/transform.y",
    ];
    for (const [rootShapeKind, dimensions] of [["ellipse", "layer"], ["rect", "transform"]] as const) {
      const input = request({ rootShapeKind, dimensions });
      const layer = input.base.motion.layers[0]!;
      const plan = compileCheckpointStoryboardScalarSpatialPlan(input);
      expect(validateDocumentSync(loadSchemaSync("motion"), input.base.motion)).toEqual({ ok: true });
      expect(layer).toMatchObject({ shape: rootShapeKind, fill: "#4e8cff", style: { stroke: "#102040", strokeWidth: 2 } });
      if (dimensions === "layer") expect(layer).toMatchObject({ width: 120, height: 80 });
      else expect(layer.transform).toMatchObject({ width: 120, height: 80 });
      expect(plan.intendedChanges.paths).toEqual(expectedPaths);
      expect(plan.intendedChanges.paths.every((path) => /\/(?:transform\.(?:rotation|scale|x|y)|opacity)$/.test(path))).toBe(true);
    }
  });

  it("refuses root, layer, lock, geometry, and existing-authority conflicts before lowering", () => {
    const cases: Array<[string, (candidate: ReturnType<typeof request>) => void]> = [
      ["existing keyframe authority", (candidate) => { candidate.base.motion.layers[0]!.keyframes = {}; }],
      ["layer transition authority", (candidate) => { candidate.base.motion.layers[0]!.transitions = { in: { type: "fade" } }; }],
      ["tracking stabilization attachment", (candidate) => { candidate.base.motion.layers[0]!["x-tracking-stabilization"] = { schema: "shellx-motion/tracking-stabilization-attachment@1" }; }],
      ["track timing authority", (candidate) => { candidate.base.motion.tracks = [{ id: "overlay", type: "overlay", layerIds: ["orb"], fadeInMs: 10 }]; }],
      ["locked layers", (candidate) => { candidate.base.motion.layers[0]!.locked = true; }],
      ["depth", (candidate) => { candidate.base.motion.layers[0]!.depth = 0; }],
      ["geometry authority", (candidate) => { candidate.base.motion.layers[0]!.geometry = { kind: "path" } as never; }],
      ["geometry keyframes", (candidate) => { candidate.base.motion.layers[0]!.geometryKeyframes = []; }],
      ["existing relationships authority", (candidate) => { candidate.base.motion.relationships = {} as never; }],
      ["layout application authority", (candidate) => { candidate.base.motion.layoutApplications = {} as never; }],
    ];
    for (const [label, mutate] of cases) {
      const candidate = clone(request()); mutate(candidate);
      expect(() => compileCheckpointStoryboardScalarSpatialPlan(candidate), label).toThrow();
    }
    const grouped = clone(request());
    grouped.base.motion.layers.push({ id: "group", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["orb"] });
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(grouped)).toThrow("refuses groups");
  });

  it("requires same-ID exact-base object bindings and package-relative manifest motion locators", () => {
    const mismatched = clone(request());
    mismatched.base.motion.layers.push({ id: "other", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1_000 });
    mismatched.objectLayerBindings[0]!.layerId = "other";
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(mismatched)).toThrow("exact same-ID base layer");

    for (const motion of [
      "/motion.json", "./motion.json", "assets/../motion.json", "assets\\motion.json", "C:/motion.json", "\\\\server\\share\\motion.json",
      "motion\u0000.json", "data:application/json,{}", "file:motion.json", "http:motion.json", "motion%2Fmain.json", "mo\u0301tion.json",
    ] as const) {
      const candidate = clone(request());
      candidate.base.manifest.motion = motion;
      expect(() => compileCheckpointStoryboardScalarSpatialPlan(candidate), motion).toThrow("package-relative POSIX locator");
    }
    const nested = clone(request());
    nested.base.manifest.motion = "motion/main.json";
    expect(compileCheckpointStoryboardScalarSpatialPlan(nested).base.package.motionPath).toBe("motion/main.json");
  });

  it("uses descriptor-first bounded input admission without executing hostile getters", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA, base: {}, objectLayerBindings: [] };
    Object.defineProperty(hostile, "storyboard", { enumerable: true, get() { getterCalls += 1; return request().storyboard; } });
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(hostile)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);

    let ownKeys = 0;
    const oversized = new Proxy({}, { ownKeys() { ownKeys += 1; return Array.from({ length: 10_000 }, (_item, index) => `field${index}`); } });
    expect(() => compileCheckpointStoryboardScalarSpatialPlan(oversized)).toThrow("24-field record limit");
    expect(ownKeys).toBe(1);
  });

  it("contains an explicit no-I/O/no-public-surface proof in both its evidence and source placement", () => {
    const plan = compileCheckpointStoryboardScalarSpatialPlan(request());
    expect(plan.evidence).toEqual({ noPackageIO: true, noPackageWrites: true, noReceipt: true, noPublicSurface: true, noRenderer: true });
    const privateCompiler = readFileSync(new URL("./checkpoint-storyboard-scalar-spatial.ts", import.meta.url), "utf8");
    expect(privateCompiler).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const publicCoreBarrel = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(publicCoreBarrel).not.toContain("checkpoint-storyboard");
    const packageManifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    const checkpointExports = Object.keys(packageManifest.exports).filter((key) => key.includes("checkpoint-storyboard"));
    expect(checkpointExports).toEqual(["./internal/checkpoint-storyboard-scalar-spatial-materializer", "./internal/checkpoint-storyboard-behavior-profile", "./internal/checkpoint-storyboard-relation-profile", "./internal/checkpoint-storyboard-relation-action-profile", "./internal/checkpoint-storyboard-lifecycle-profile", "./internal/checkpoint-storyboard-geometry-morph-profile", "./internal/checkpoint-storyboard-retained-trace-profile", "./internal/checkpoint-storyboard-retained-trace-preview", "./internal/checkpoint-storyboard-data-recipe", "./internal/checkpoint-storyboard-frame-manifest"]);
    expect(packageManifest.exports["./internal/checkpoint-storyboard-scalar-spatial-materializer"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-materializer.ts");
    expect(packageManifest.exports["./internal/checkpoint-storyboard-behavior-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-behavior-materializer.ts");
    expect(packageManifest.exports["./internal/checkpoint-storyboard-relation-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.ts");
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-scalar-spatial-materializer"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-materializer.js" });
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-behavior-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-behavior-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-behavior-materializer.js" });
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-relation-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.js" });
    expect(packageManifest.exports["./internal/checkpoint-storyboard-relation-action-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.ts");
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-relation-action-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.js" });
    expect(packageManifest.exports["./internal/checkpoint-storyboard-lifecycle-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.ts");
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-lifecycle-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.js" });
    expect(packageManifest.exports["./internal/checkpoint-storyboard-geometry-morph-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.ts");
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-geometry-morph-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.js" });
    expect(packageManifest.exports["./internal/checkpoint-storyboard-retained-trace-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-profile.ts");
    expect(packageManifest.publishConfig.exports["./internal/checkpoint-storyboard-retained-trace-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-profile.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-profile.js" });
  });
});
