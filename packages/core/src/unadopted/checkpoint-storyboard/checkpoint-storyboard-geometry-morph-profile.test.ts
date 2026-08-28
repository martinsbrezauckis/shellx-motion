import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../canonical-json";
import { createCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records";
import { createTransitionRecipe } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-recipes";
import { admitCheckpointStoryboardC6CRecordProfile } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-materializer";
import {
  admitCheckpointStoryboardGeometryMorphRecordProfile,
  compileCheckpointStoryboardGeometryMorphProfilePlan,
  readCheckpointStoryboardGeometryMorphProfileRequest,
} from "../../internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-profile";
import { CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-profile-types";

const HASH = "a".repeat(64);
const VIEW_BOX = { x: -100, y: -100, width: 400, height: 400 };

function polygon(points: readonly { readonly x: number; readonly y: number }[]) {
  return {
    schema: "shellx-motion/shape-geometry@1" as const,
    kind: "polygon" as const,
    viewBox: { ...VIEW_BOX },
    points: points.map((point) => ({ ...point })),
  };
}

const START = polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);
const END = polygon([{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 20, y: 120 }]);

function request(options: {
  readonly capabilityRequirements?: readonly string[];
  readonly startAtUs?: number;
  readonly endAtUs?: number;
  readonly durationMs?: number;
  readonly startGeometry?: unknown;
  readonly endGeometry?: unknown;
  readonly baseGeometry?: unknown;
  readonly binding?: { readonly objectId: string; readonly layerId: string };
  readonly extraObject?: boolean;
} = {}): any {
  const startAtUs = options.startAtUs ?? 0;
  const endAtUs = options.endAtUs ?? 1_000_000;
  const durationMs = options.durationMs ?? 1_000;
  const startGeometry = options.startGeometry ?? START;
  const endGeometry = options.endGeometry ?? END;
  const recipe = createTransitionRecipe({
    recipeId: "triangle-morph",
    seed: 2,
    exactBaseRequirements: [],
    intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "triangle", easing: "linear" }] },
  });
  const catalog = [{ objectId: "triangle", rootShapeKind: "geometry", propertyMask: [] as const }];
  const startObjects = [{ objectId: "triangle", state: "present" as const, properties: [] as const, geometry: startGeometry }];
  const endObjects = [{ objectId: "triangle", state: "present" as const, properties: [] as const, geometry: endGeometry }];
  if (options.extraObject) {
    catalog.push({ objectId: "extra", rootShapeKind: "geometry", propertyMask: [] as const });
    startObjects.push({ objectId: "extra", state: "present" as const, properties: [] as const, geometry: startGeometry });
    endObjects.push({ objectId: "extra", state: "present" as const, properties: [] as const, geometry: endGeometry });
  }
  const storyboard = createCheckpointStoryboard({
    seed: 1,
    capabilityRequirements: options.capabilityRequirements ?? ["renderer.gpu"],
    objectCatalog: catalog,
    checkpoints: [
      { id: "start", atUs: startAtUs, objects: startObjects },
      { id: "finish", atUs: endAtUs, objects: endObjects },
    ],
    edges: [{
      id: "start-finish",
      fromCheckpointId: "start",
      toCheckpointId: "finish",
      lifecycle: catalog.map((entry) => ({ kind: "preserve" as const, objectId: entry.objectId })),
      recipeIds: ["triangle-morph"],
    }],
    recipes: [recipe],
  });
  return {
    schema: CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "package-1",
        name: "Private C6B6a triangle fixture",
        motion: "motion.json",
        assets: [],
        sourceApp: "test",
        compatibility: { lanes: ["gpu"], hosts: [] },
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion-1",
        name: "Private C6B6a triangle fixture",
        durationMs,
        fps: 30,
        width: 1280,
        height: 720,
        assets: [],
        provenance: { sourceApp: "test", createdBy: "test" },
        layers: [{
          id: "triangle",
          type: "shape",
          fill: "#4e8cff",
          startMs: 0,
          durationMs,
          geometry: options.baseGeometry ?? startGeometry,
        }],
      },
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [options.binding ?? { objectId: "triangle", layerId: "triangle" }],
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function expectRefusal(mutate: (candidate: any) => void): void {
  const candidate = clone(request());
  mutate(candidate);
  expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(candidate)).toThrow();
}

describe("private C6B6a checkpoint geometry-morph profile compiler", () => {
  it("projects one sealed pair of ordinal triangle snapshots to ordinary geometryKeyframes", () => {
    const input = request();
    const plan = compileCheckpointStoryboardGeometryMorphProfilePlan(input);

    expect(admitCheckpointStoryboardGeometryMorphRecordProfile(input.storyboard)).toEqual(input.storyboard);
    expect(admitCheckpointStoryboardC6CRecordProfile(input.storyboard)).toEqual({ storyboard: input.storyboard, profile: "c6b6-geometry-morph@1" });
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-plan@1",
      storyboard: { id: input.storyboard.id, sha256: input.storyboard.sha256, revision: 1 },
      base: {
        package: { id: "package-1", motionPath: "motion.json" },
        manifest: { id: "package-1" },
        canonicalMotion: { id: "motion-1" },
        persistedMotion: { id: "motion-1", sha256: HASH },
      },
      lowererProfile: {
        requiredCapability: "renderer.gpu",
        rootShapeKind: "geometry",
        geometryKind: "polygon",
        pointCount: 3,
        correspondence: "ordinal",
        easing: "linear",
        lifecycle: "preserve",
        ownedWriteMask: ["geometry"],
      },
      objectLayerBinding: { objectId: "triangle", layerId: "triangle", layerIndex: 0, rootShapeKind: "geometry" },
      projection: {
        path: "/layers/0/geometryKeyframes",
        staticGeometry: { sha256: canonicalJsonSha256(START), geometry: START },
        endpoints: [
          { atUs: 0, sha256: canonicalJsonSha256(START), geometry: START },
          { atUs: 1_000_000, sha256: canonicalJsonSha256(END), geometry: END },
        ],
        geometryKeyframes: {
          schema: "shellx-motion/shape-geometry-keyframes@1",
          keyframes: [
            { atUs: 0, geometry: START, easing: "linear" },
            { atUs: 1_000_000, geometry: END },
          ],
        },
        topology: { kind: "polygon", viewBoxSha256: canonicalJsonSha256(VIEW_BOX), pointCount: 3, correspondence: "ordinal" },
      },
      intendedChanges: { paths: ["/layers/0/geometryKeyframes"], geometryKeyframes: { operation: "replace-absent", keyframeCount: 2 } },
      budget: { objects: 1, checkpoints: 2, edges: 1, recipes: 1, snapshots: 2, interpolationScalars: 6, changedPaths: 1 },
      evidence: { noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true },
    });
    expect(plan.projection).not.toHaveProperty("gpuPreflight");
    const trianglePoints: readonly [
      { readonly x: number; readonly y: number },
      { readonly x: number; readonly y: number },
      { readonly x: number; readonly y: number },
    ] = plan.projection.staticGeometry.geometry.points;
    const exactKeyframes: readonly [
      { readonly geometry: { readonly kind: "polygon"; readonly points: typeof trianglePoints }; readonly easing: "linear" },
      { readonly geometry: { readonly kind: "polygon"; readonly points: typeof trianglePoints } },
    ] = plan.projection.geometryKeyframes.keyframes;
    expect(trianglePoints).toHaveLength(3);
    expect(exactKeyframes).toHaveLength(2);
  });

  it("is deterministic, detached, deep-frozen, and binds the actual static base geometry", () => {
    const input = request();
    const before = JSON.stringify(input);
    const first = compileCheckpointStoryboardGeometryMorphProfilePlan(input);
    const replay = compileCheckpointStoryboardGeometryMorphProfilePlan(clone(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(replay).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.storyboard.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.lowererProfile.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.projection.geometryKeyframes.keyframes)).toBe(true);
    const firstGeometry = first.projection.geometryKeyframes.keyframes[0]!.geometry;
    expect(firstGeometry.kind).toBe("polygon");
    if (firstGeometry.kind !== "polygon") throw new Error("test fixture must retain polygon geometry");
    expect(Object.isFrozen(firstGeometry.points)).toBe(true);
    expect(Object.isFrozen(first.projection.areaProof.witnessTimes)).toBe(true);

    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ baseGeometry: END }))).toThrow("static base geometry");
    expectRefusal((candidate) => { candidate.base.packageId = "other-package"; });
    expectRefusal((candidate) => { candidate.base.persistedMotionSha256 = "not-a-hash"; });
    expectRefusal((candidate) => { candidate.base.manifest.motion = "../motion.json"; });
  });

  it("refuses widened record profiles, malformed requests, and legacy/B1-B5 authority residue", () => {
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ capabilityRequirements: ["renderer.native"] }))).toThrow("renderer.gpu");
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ capabilityRequirements: ["renderer.gpu", "renderer.native"] }))).toThrow("renderer.gpu");
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ extraObject: true }))).toThrow();
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ binding: { objectId: "triangle", layerId: "other" } }))).toThrow("same-ID");

    const legacy = clone(request());
    legacy.base.motion.layers[0].shape = "path";
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(legacy)).toThrow();
    expectRefusal((candidate) => { candidate.base.motion.layers[0].keyframes = { "transform.x": [] }; }); // B1 scalar/spatial
    expectRefusal((candidate) => { candidate.base.motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [] }; }); // B2
    expectRefusal((candidate) => { candidate.base.motion.relations = { schema: "shellx-motion/relations@1", bindings: [] }; }); // B3
    expectRefusal((candidate) => { candidate.base.motion.relationActions = { schema: "shellx-motion/relation-actions@2", definitions: [] }; }); // B4
    expectRefusal((candidate) => { candidate.base.motion.layers[0].childLayerIds = ["triangle"]; }); // group/lifecycle boundary
    expectRefusal((candidate) => { candidate.base.motion.tracks = []; });
    expectRefusal((candidate) => { candidate.base.motion.traces = []; });
    expectRefusal((candidate) => { candidate.base.motion.layers[0].geometryKeyframes = { schema: "shellx-motion/shape-geometry-keyframes@1", keyframes: [{ atUs: 0, geometry: START }] }; });

    const hostile: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA, base: {}, objectLayerBindings: [] };
    let getterCalls = 0;
    Object.defineProperty(hostile, "storyboard", { enumerable: true, get() { getterCalls += 1; return request().storyboard; } });
    expect(() => readCheckpointStoryboardGeometryMorphProfileRequest(hostile)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);
    expectRefusal((candidate) => { candidate.unexpected = true; });
  });

  it("refuses incorrect timing, lifecycle/recipe shape, non-triangles, topology loss, and unsafe intermediate areas", () => {
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ startAtUs: 1_000 }))).toThrow("preserved from zero");
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endAtUs: 999_000 }))).toThrow("document end");
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endAtUs: 999_999 }))).toThrow();
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endGeometry: polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]) }))).toThrow();
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endGeometry: { schema: "shellx-motion/shape-geometry@1", kind: "line", viewBox: { ...VIEW_BOX }, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] } }))).toThrow();
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endGeometry: { ...END, viewBox: { ...VIEW_BOX, width: 401 } } }))).toThrow();

    // Reversing ordinal correspondence flips the signed area even though the vertex set is unchanged.
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endGeometry: polygon([{ x: 20, y: 20 }, { x: 20, y: 120 }, { x: 120, y: 20 }]) }))).toThrow("orientation");
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({ endGeometry: polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]) }))).toThrow();
    // Both endpoints have the same orientation, but the linearly interpolated triangle collapses at t=1/2.
    expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request({
      startGeometry: polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]),
      endGeometry: polygon([{ x: 0, y: 0 }, { x: -100, y: 0 }, { x: 0, y: -100 }]),
    }))).toThrow("area can reach zero");

    expectRefusal((candidate) => { candidate.storyboard.edges[0].lifecycle[0].kind = "remove"; });
    expectRefusal((candidate) => { candidate.storyboard.recipes[0].intent.targets[0].easing = "ease-in"; });
    expectRefusal((candidate) => { candidate.storyboard.recipes.push(candidate.storyboard.recipes[0]); });
  });

  it("refuses every source-side package authority outside the one geometry-keyframe write", () => {
    const mutations: ReadonlyArray<readonly [string, (candidate: any) => void]> = [
      ["asset", (candidate) => { candidate.base.motion.assets = [{ id: "asset-1", path: "asset.png", type: "image" }]; }],
      ["visibility", (candidate) => { candidate.base.motion.layers[0].visible = false; }],
      ["lock", (candidate) => { candidate.base.motion.layers[0].locked = true; }],
      ["timing", (candidate) => { candidate.base.motion.layers[0].durationMs = 999; }],
      ["track", (candidate) => { candidate.base.motion.layers[0].trackId = "track-1"; }],
      ["effect", (candidate) => { candidate.base.motion.layers[0].effects = { motionBlur: { samples: 2, shutterAngle: 180 } }; }],
      ["matte", (candidate) => { candidate.base.motion.layers[0].matte = { sourceLayerId: "triangle", mode: "alpha" }; }],
      ["relation", (candidate) => { candidate.base.motion.relations = { schema: "shellx-motion/relations@1", bindings: [] }; }],
      ["behavior", (candidate) => { candidate.base.motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [] }; }],
      ["trace", (candidate) => { candidate.base.motion.parametricTrace = {}; }],
    ];
    for (const [label, mutate] of mutations) expect(() => {
      const candidate = clone(request());
      mutate(candidate);
      compileCheckpointStoryboardGeometryMorphProfilePlan(candidate);
    }, label).toThrow();
  });

  it("retains pure C6B6a compilation with one private installed handoff and source-only compatibility facades", () => {
    const source = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-profile.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    expect(source).not.toMatch(/\b(?:renderMotion|renderFinal|renderPreview|launch(?:Browser|Chromium)|compileGpuSceneGeometryKeyframes(?:Static|Frame)Plan)\b/);
    const compatibility = readFileSync(new URL("./checkpoint-storyboard-geometry-morph-profile.ts", import.meta.url), "utf8");
    expect(compatibility.trim()).toBe("/** Compatibility facade for source-only callers; this is not a package entry. */\nexport * from \"../../internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-profile.js\";");
    const compatibilityTypes = readFileSync(new URL("./checkpoint-storyboard-geometry-morph-profile-types.ts", import.meta.url), "utf8");
    expect(compatibilityTypes.trim()).toBe("/** Compatibility facade for source-only callers; this is not a package entry. */\nexport * from \"../../internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-profile-types.js\";");
    const handoff = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.ts", import.meta.url), "utf8");
    expect(handoff).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const coreIndex = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(coreIndex).not.toContain("checkpoint-storyboard-geometry-morph");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-geometry-morph-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-geometry-morph-profile"]).toEqual({
      types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.d.ts",
      default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.js",
    });
    const plan = compileCheckpointStoryboardGeometryMorphProfilePlan(request());
    expect(plan.evidence).toEqual({ noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true });
  });
});
