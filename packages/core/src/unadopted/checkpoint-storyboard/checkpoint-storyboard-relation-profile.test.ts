import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../canonical-json";
import { createCheckpointStoryboard, createTransitionRecipe } from "./checkpoint-storyboard";
import {
  admitCheckpointStoryboardRelationRecordProfile,
  compileCheckpointStoryboardRelationProfilePlan,
  readCheckpointStoryboardRelationProfileRequest,
} from "./checkpoint-storyboard-relation-profile";
import { CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA } from "./checkpoint-storyboard-relation-profile-types";

const HASH = "a".repeat(64);
const SOURCE = { x: 100, y: 50 }, TARGET = { x: 125, y: 50 };

function state(objectId: "guide" | "orb", value: { readonly x: number; readonly y: number }) {
  return {
    objectId,
    state: "present" as const,
    properties: [{ property: "transform.x" as const, value: value.x }, { property: "transform.y" as const, value: value.y }],
  };
}

function request(options: {
  readonly capabilityRequirements?: readonly string[];
  readonly sourceShape?: "rect" | "ellipse";
  readonly targetShape?: "rect" | "ellipse";
  readonly target?: { readonly x: number; readonly y: number };
  readonly startAtUs?: number;
  readonly endAtUs?: number;
  readonly relationKind?: "follow" | "similarity";
  readonly catalogCreation?: boolean;
} = {}): any {
  const relationKind = options.relationKind ?? "follow";
  const recipe = createTransitionRecipe({
    recipeId: "follow-guide", seed: 2, exactBaseRequirements: [],
    intent: {
      kind: "relation", relationKind, sourceObjectId: "guide", targetObjectId: "orb",
      sourceAnchor: { x: 10, y: 10 }, targetAnchor: { x: 5, y: 5 },
      offset: { space: "world", x: 20, y: -5, rotationDeg: relationKind === "follow" ? 0 : 15, scale: relationKind === "follow" ? 1 : 2 },
    },
  });
  const startAtUs = options.startAtUs ?? 0, endAtUs = options.endAtUs ?? 1_000_000;
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: options.capabilityRequirements ?? ["renderer.gpu"],
    objectCatalog: [
      { objectId: "guide", rootShapeKind: options.sourceShape ?? "rect", propertyMask: ["transform.x", "transform.y"], ...(options.catalogCreation ? { creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } } : {}) },
      { objectId: "orb", rootShapeKind: options.targetShape ?? "ellipse", propertyMask: ["transform.x", "transform.y"], ...(options.catalogCreation ? { creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#f3c547", width: 60, height: 40 } } : {}) },
    ],
    checkpoints: [
      { id: "start", atUs: startAtUs, objects: [state("guide", SOURCE), state("orb", options.target ?? TARGET)] },
      { id: "finish", atUs: endAtUs, objects: [state("guide", SOURCE), state("orb", options.target ?? TARGET)] },
    ],
    edges: [{ id: "follow-edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "guide" }, { kind: "preserve", objectId: "orb" }], recipeIds: ["follow-guide"] }],
    recipes: [recipe],
  });
  return {
    schema: CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "Private C6B3a fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } },
      motion: {
        schema: "shellx-motion/motion@1", id: "motion-1", name: "Private C6B3a fixture", durationMs: 1_000, fps: 30, width: 1280, height: 720,
        layers: [
          { id: "guide", type: "shape", shape: options.sourceShape ?? "rect", fill: "#4e8cff", startMs: 0, durationMs: 1_000, transform: { x: SOURCE.x, y: SOURCE.y } },
          { id: "orb", type: "shape", shape: options.targetShape ?? "ellipse", fill: "#f3c547", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0 } },
        ],
        assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      },
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [{ objectId: "guide", layerId: "guide" }, { objectId: "orb", layerId: "orb" }],
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Valid sealed C6A relation alternatives which C6B3a must reject before any base evaluation. */
function nonFollowRequest(relationKind: "similarity" | "aim"): any {
  const input = request();
  const targetMask = relationKind === "similarity"
    ? ["transform.x", "transform.y", "transform.rotation", "transform.scale"] as const
    : ["transform.rotation"] as const;
  const targetState = {
    objectId: "orb", state: "present" as const,
    properties: targetMask.map((property) => ({
      property,
      value: property === "transform.scale" ? 1 : 0,
    })),
  };
  const intent = relationKind === "similarity"
    ? { kind: "relation" as const, relationKind, sourceObjectId: "guide", targetObjectId: "orb", sourceAnchor: { x: 10, y: 10 }, targetAnchor: { x: 5, y: 5 }, offset: { space: "world" as const, x: 20, y: -5, rotationDeg: 15, scale: 2 } }
    : { kind: "relation" as const, relationKind, sourceObjectId: "guide", targetObjectId: "orb", sourceAnchor: { x: 10, y: 10 }, targetAnchor: { x: 5, y: 5 }, rotationOffsetDeg: 0 };
  const recipe = createTransitionRecipe({ recipeId: "other-relation", seed: 2, exactBaseRequirements: [], intent });
  input.storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [
      { objectId: "guide", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y"] },
      { objectId: "orb", rootShapeKind: "ellipse", propertyMask: targetMask },
    ],
    checkpoints: [
      { id: "start", atUs: 0, objects: [state("guide", SOURCE), targetState] },
      { id: "finish", atUs: 1_000_000, objects: [state("guide", SOURCE), targetState] },
    ],
    edges: [{ id: "other-edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "guide" }, { kind: "preserve", objectId: "orb" }], recipeIds: ["other-relation"] }],
    recipes: [recipe],
  });
  return input;
}

describe("private C6B3a checkpoint relation-profile compiler", () => {
  it("projects exactly one sealed follow recipe through existing T3 relation read, validate, evaluate, and static/frame plans", () => {
    const input = request();
    const plan = compileCheckpointStoryboardRelationProfilePlan(input);
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-relation-profile-plan@1",
      storyboard: { id: input.storyboard.id, sha256: input.storyboard.sha256, revision: 1 },
      base: { package: { id: "package-1", motionPath: "motion.json" }, manifest: { id: "package-1" }, canonicalMotion: { id: "motion-1" }, persistedMotion: { id: "motion-1", sha256: HASH } },
      lowererProfile: { requiredCapability: "renderer.gpu", relationKinds: ["follow"], offsetSpaces: ["world"], ownedPropertyMask: ["transform.x", "transform.y"], endpointRule: "closed-whole-millisecond-legacy-bridge" },
      objectLayerBindings: { source: { objectId: "guide", layerId: "guide", layerIndex: 0, rootShapeKind: "rect" }, target: { objectId: "orb", layerId: "orb", layerIndex: 1, rootShapeKind: "ellipse" } },
      projection: {
        edge: { id: "follow-edge", fromCheckpointId: "start", toCheckpointId: "finish" },
        recipe: { id: input.storyboard.recipes[0]!.id, sha256: input.storyboard.recipes[0]!.sha256, revision: 1, recipeId: "follow-guide" },
        interval: { startUs: 0, durationUs: 1_000_000 }, path: "/relations", ownedPropertyMask: ["transform.x", "transform.y"],
        store: {
          schema: "shellx-motion/relations@1",
          bindings: [{ id: "follow-guide", enabled: true, kind: "attach", mode: "follow", source: { layerId: "guide", anchor: { x: 10, y: 10 } }, target: { layerId: "orb", anchor: { x: 5, y: 5 } }, startUs: 0, durationUs: 1_000_000, offset: { space: "world", x: 20, y: -5, rotationDeg: 0, scale: 1 } }],
        },
        staticPlan: { schema: "shellx-motion/relation-static-plan@1", bindings: [{ id: "follow-guide", kind: "attach", sourceLayerId: "guide", targetLayerId: "orb", writeMask: ["transform.x", "transform.y"] }] },
        gpuPreviewStaticPlan: { schema: "shellx-motion/gpu-scene-relations-static@1" },
      },
      evidence: { noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true },
    });
    expect(plan.projection.storeSha256).toBe(canonicalJsonSha256(plan.projection.store));
    expect(plan.projection.staticFingerprint).toBe(plan.projection.staticPlan.fingerprint);
    expect(plan.projection.gpuPreviewStaticPlan.relationStaticFingerprint).toBe(plan.projection.staticFingerprint);
    expect(plan.projection.gpuPreviewStaticPlan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.endpointFramePlans.start.staticFingerprint).toBe(plan.projection.staticFingerprint);
    expect(plan.endpointFramePlans.end.staticFingerprint).toBe(plan.projection.staticFingerprint);
  });

  it("uses the exact whole-millisecond authoring bridge and preserves endpoint anchors, offset, and target-only x/y authority", () => {
    const plan = compileCheckpointStoryboardRelationProfilePlan(request());
    expect(plan.endpointEvaluations.start).toMatchObject({ atUs: 0, samples: [{ id: "follow-guide", targetLayerId: "orb", writeMask: ["transform.x", "transform.y"], transform: TARGET }] });
    expect(plan.endpointEvaluations.end).toMatchObject({ atUs: 1_000_000, samples: [{ id: "follow-guide", targetLayerId: "orb", writeMask: ["transform.x", "transform.y"], transform: TARGET }] });
    expect(plan.endpointFramePlans.start.atUs).toBe(0);
    expect(plan.endpointFramePlans.end.atUs).toBe(1_000_000);
    expect(plan.endpointEvaluations.start.layers.find((layer) => layer.id === "guide")!.transform).toMatchObject(SOURCE);
    expect(plan.endpointEvaluations.start.layers.find((layer) => layer.id === "orb")!.transform).toMatchObject(TARGET);

    expect(() => compileCheckpointStoryboardRelationProfilePlan(request({ target: { x: 126, y: TARGET.y } }))).toThrow("start endpoint does not exactly equal target.transform.x");
  });

  it("is deterministic, fingerprints every sealed identity rail, and deep-freezes the complete detached plan", () => {
    const input = request(), before = JSON.stringify(input);
    const first = compileCheckpointStoryboardRelationProfilePlan(input), replay = compileCheckpointStoryboardRelationProfilePlan(clone(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(replay).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.storyboard.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.lowererProfile.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.projection.staticFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.endpointFramePlans.start.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.projection.store.bindings)).toBe(true);
    expect(Object.isFrozen(first.projection.store.bindings[0]!.source.anchor)).toBe(true);
    expect(Object.isFrozen(first.endpointEvaluations.start.layers[0]!.transform)).toBe(true);
    expect(Object.isFrozen(first.endpointFramePlans.end.samples)).toBe(true);
  });

  it("fails closed on profile widening, second authority, cycles, groups/depth, geometry, timing, and non-whole-ms endpoints", () => {
    const lifecycleCatalog = request({ catalogCreation: true });
    expect(() => admitCheckpointStoryboardRelationRecordProfile(lifecycleCatalog.storyboard)).toThrow("catalog creation payloads");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(lifecycleCatalog)).toThrow("catalog creation payloads");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(request({ capabilityRequirements: ["renderer.native"] }))).toThrow("exactly the renderer.gpu");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(request({ capabilityRequirements: ["renderer.gpu", "renderer.native"] }))).toThrow("exactly the renderer.gpu");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(nonFollowRequest("similarity"))).toThrow("semantic follow recipe");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(nonFollowRequest("aim"))).toThrow("semantic follow recipe");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(request({ startAtUs: 1_000, endAtUs: 1_000_000 }))).toThrow("beginning at zero");
    expect(() => compileCheckpointStoryboardRelationProfilePlan(request({ endAtUs: 999_999 }))).toThrow(/time_resolution_unavailable|whole-millisecond|spanning \[0, D\]/);

    const withKeys = clone(request()); withKeys.base.motion.layers[1]!.keyframes = { "transform.x": [] };
    expect(() => compileCheckpointStoryboardRelationProfilePlan(withKeys)).toThrow("transform/timing authority");
    const withBehaviors = clone(request()); withBehaviors.base.motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "guide", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 0, velocityY: 0, gravityY: 1 } }] };
    expect(() => compileCheckpointStoryboardRelationProfilePlan(withBehaviors)).toThrow("existing behaviors authority");
    const withTrack = clone(request()); withTrack.base.motion.tracks = [];
    expect(() => compileCheckpointStoryboardRelationProfilePlan(withTrack)).toThrow("existing tracks authority");
    const existingRelation = clone(request()); existingRelation.base.motion.relations = { schema: "shellx-motion/relations@1", bindings: [{ id: "prior-follow", enabled: true, kind: "attach", source: { layerId: "guide", anchor: { x: 0, y: 0 } }, target: { layerId: "orb", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 1_000_000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } }] };
    expect(() => compileCheckpointStoryboardRelationProfilePlan(existingRelation)).toThrow("existing relations authority");
    const withCycle = clone(request()); withCycle.base.motion.relations = { schema: "shellx-motion/relations@1", bindings: [
      { id: "guide-orb", enabled: true, kind: "attach", source: { layerId: "guide", anchor: { x: 0, y: 0 } }, target: { layerId: "orb", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 1_000_000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } },
      { id: "orb-guide", enabled: true, kind: "attach", source: { layerId: "orb", anchor: { x: 0, y: 0 } }, target: { layerId: "guide", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 1_000_000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } },
    ] };
    expect(() => compileCheckpointStoryboardRelationProfilePlan(withCycle)).toThrow(/invalid at \/relations|acyclic/);
    const grouped = clone(request()); grouped.base.motion.layers[0]!.childLayerIds = ["orb"];
    expect(() => compileCheckpointStoryboardRelationProfilePlan(grouped)).toThrow(/invalid at \/layers\/0\/childLayerIds|root-owned/);
    const depth = clone(request()); depth.base.motion.layers[0]!.depth = 0;
    expect(() => compileCheckpointStoryboardRelationProfilePlan(depth)).toThrow(/invalid at \/layers\/0\/depth|non-depth/);
    const geometry = clone(request()); geometry.base.motion.layers[0]!.geometry = { viewBox: { width: 1, height: 1 }, points: [] };
    expect(() => compileCheckpointStoryboardRelationProfilePlan(geometry)).toThrow(/invalid at \/layers\/0\/geometry|geometry or morph/);
  });

  it("uses descriptor-first hostile-data admission and refuses excess objects, edges, recipes, and bindings", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA, base: {}, objectLayerBindings: [] };
    Object.defineProperty(hostile, "storyboard", { enumerable: true, get() { getterCalls += 1; return request().storyboard; } });
    expect(() => readCheckpointStoryboardRelationProfileRequest(hostile)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);

    let ownKeys = 0;
    const oversized = new Proxy({}, { ownKeys() { ownKeys += 1; return Array.from({ length: 10_000 }, (_item, index) => `field${index}`); } });
    expect(() => compileCheckpointStoryboardRelationProfilePlan(oversized)).toThrow("24-field record limit");
    expect(ownKeys).toBe(1);

    const extraLayer = clone(request()); extraLayer.base.motion.layers.push({ id: "extra", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000 });
    expect(() => compileCheckpointStoryboardRelationProfilePlan(extraLayer)).toThrow("exactly two existing base layers");
    const extraBinding = clone(request()); extraBinding.objectLayerBindings.push({ objectId: "extra", layerId: "extra" });
    expect(() => compileCheckpointStoryboardRelationProfilePlan(extraBinding)).toThrow("must contain 2..2 entries");
  });

  it("requires complete authoritative manifest and Motion validation before relation planning", () => {
    const cases: ReadonlyArray<readonly [string, (candidate: any) => void, RegExp]> = [
      ["manifest assets", (candidate) => { candidate.base.manifest.assets = [42]; }, /manifest is invalid at \/assets\/0/],
      ["manifest compatibility lanes", (candidate) => { candidate.base.manifest.compatibility.lanes = "gpu"; }, /manifest is invalid at \/compatibility\/lanes/],
      ["manifest compatibility hosts", (candidate) => { candidate.base.manifest.compatibility.hosts = [false]; }, /manifest is invalid at \/compatibility\/hosts\/0/],
      ["Motion name", (candidate) => { candidate.base.motion.name = ""; }, /Motion document is invalid at \/name/],
      ["Motion fps", (candidate) => { candidate.base.motion.fps = 0; }, /Motion document is invalid at \/fps/],
      ["Motion width", (candidate) => { candidate.base.motion.width = 1.5; }, /Motion document is invalid at \/width/],
      ["Motion height", (candidate) => { candidate.base.motion.height = 0; }, /Motion document is invalid at \/height/],
      ["Motion provenance sourceApp", (candidate) => { candidate.base.motion.provenance.sourceApp = ""; }, /motion\.provenance\.sourceApp/],
      ["Motion provenance createdBy", (candidate) => { candidate.base.motion.provenance.createdBy = 7; }, /motion\.provenance\.createdBy/],
      ["Motion assets", (candidate) => { candidate.base.motion.assets = ["not-an-asset"]; }, /asset-free T3 GPU relation-preview base/],
      ["Motion layer timing", (candidate) => { candidate.base.motion.layers[0].startMs = -1; }, /Motion document is invalid at \/layers\/0\/startMs/],
    ];
    for (const [label, mutate, pattern] of cases) {
      const candidate = clone(request()); mutate(candidate);
      expect(() => compileCheckpointStoryboardRelationProfilePlan(candidate), label).toThrow(pattern);
    }

    const exceedsGpuRelationPreview = clone(request()); exceedsGpuRelationPreview.base.motion.width = 9_000;
    expect(() => compileCheckpointStoryboardRelationProfilePlan(exceedsGpuRelationPreview)).toThrow("GPU relation-preview capability admission refused");
  });

  it("is private-installable, free of package I/O, and without any COW, renderer, Debug, or connector route", () => {
    const compiler = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-profile.ts", import.meta.url), "utf8");
    expect(compiler).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const publicCoreBarrel = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(publicCoreBarrel).not.toContain("checkpoint-storyboard");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-relation-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-relation-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.js" });
    expect(Object.keys(manifest.publishConfig.exports).filter((key) => key.includes("checkpoint-storyboard"))).toEqual(["./internal/checkpoint-storyboard-scalar-spatial-materializer", "./internal/checkpoint-storyboard-behavior-profile", "./internal/checkpoint-storyboard-relation-profile", "./internal/checkpoint-storyboard-relation-action-profile", "./internal/checkpoint-storyboard-lifecycle-profile", "./internal/checkpoint-storyboard-geometry-morph-profile", "./internal/checkpoint-storyboard-retained-trace-profile", "./internal/checkpoint-storyboard-retained-trace-preview", "./internal/checkpoint-storyboard-data-recipe"]);
    const handoff = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.ts", import.meta.url), "utf8");
    expect(handoff).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
  });
});
