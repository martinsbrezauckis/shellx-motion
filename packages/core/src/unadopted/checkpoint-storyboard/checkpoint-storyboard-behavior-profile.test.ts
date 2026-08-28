import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../canonical-json";
import { createCheckpointStoryboard, createTransitionRecipe } from "./checkpoint-storyboard";
import {
  admitCheckpointStoryboardBehaviorRecordProfile,
  compileCheckpointStoryboardBehaviorProfilePlan,
  readCheckpointStoryboardBehaviorProfileRequest,
} from "./checkpoint-storyboard-behavior-profile";
import { CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA } from "./checkpoint-storyboard-behavior-profile-types";

const HASH = "a".repeat(64);
type ProfileKind = "gravity" | "bounce";

function properties(kind: ProfileKind, x: number, y: number) {
  return kind === "gravity"
    ? [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }]
    : [{ property: "transform.y" as const, value: y }];
}

function request(options: {
  readonly kind?: ProfileKind;
  readonly capabilityRequirements?: readonly string[];
  readonly baseX?: number;
  readonly baseY?: number;
  readonly endX?: number;
  readonly endY?: number;
  readonly rootShapeKind?: "rect" | "ellipse";
  readonly catalogCreation?: boolean;
} = {}): any {
  const kind = options.kind ?? "gravity", baseX = options.baseX ?? 10, baseY = options.baseY ?? (kind === "gravity" ? 20 : 0);
  const endX = options.endX ?? (kind === "gravity" ? 40 : baseX), endY = options.endY ?? (kind === "gravity" ? 40 : 5);
  const rootShapeKind = options.rootShapeKind ?? "ellipse";
  const behavior = kind === "gravity"
    ? { kind: "gravity" as const, velocityX: 30, velocityY: 10, gravityY: 20 }
    : { kind: "bounce" as const, floorY: 5, velocityY: 0, gravityY: 10, restitution: 0 };
  const recipe = createTransitionRecipe({ recipeId: "behavior", seed: 2, exactBaseRequirements: [], intent: { kind: "transform-behavior", targetObjectId: "orb", behavior } });
  const storyboard = createCheckpointStoryboard({
    seed: 1,
    capabilityRequirements: options.capabilityRequirements ?? ["renderer.gpu"],
    objectCatalog: [{ objectId: "orb", rootShapeKind, propertyMask: kind === "gravity" ? ["transform.x", "transform.y"] : ["transform.y"], ...(options.catalogCreation ? { creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } } : {}) }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: properties(kind, baseX, baseY) }] },
      { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "present", properties: properties(kind, endX, endY) }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["behavior"] }],
    recipes: [recipe],
  });
  return {
    schema: CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "Private C6B2 fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } },
      motion: {
        schema: "shellx-motion/motion@1", id: "motion-1", name: "Private C6B2 fixture", durationMs: 1_000, fps: 30, width: 1280, height: 720,
        layers: [{ id: "orb", type: "shape", shape: rootShapeKind, fill: "#4e8cff", startMs: 0, durationMs: 1_000, transform: { x: baseX, y: baseY } }],
        assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      },
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [{ objectId: "orb", layerId: "orb" }],
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe("private C6B2 checkpoint behavior-profile projection", () => {
  it("admits exactly the base-independent sealed gravity and bounce record profiles", () => {
    const gravity = request().storyboard, bounce = request({ kind: "bounce" }).storyboard;
    expect(admitCheckpointStoryboardBehaviorRecordProfile(gravity)).toEqual(gravity);
    expect(admitCheckpointStoryboardBehaviorRecordProfile(bounce)).toEqual(bounce);
    // C6C admission deliberately does not claim a package endpoint: only resolver-selected
    // exact-base materialization compares the second checkpoint with document duration.
    const nonEndpoint = createCheckpointStoryboard({
      seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "orb", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y"] }],
      checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: properties("gravity", 10, 20) }] }, { id: "finish", atUs: 777_777, objects: [{ objectId: "orb", state: "present", properties: properties("gravity", 40, 40) }] }],
      edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["behavior"] }],
      recipes: [createTransitionRecipe({ recipeId: "behavior", seed: 2, exactBaseRequirements: [], intent: { kind: "transform-behavior", targetObjectId: "orb", behavior: { kind: "gravity", velocityX: 30, velocityY: 10, gravityY: 20 } } })],
    });
    expect(admitCheckpointStoryboardBehaviorRecordProfile(nonEndpoint)).toEqual(nonEndpoint);
    const hybrid = request({ capabilityRequirements: ["renderer.gpu", "renderer.native"] }).storyboard;
    expect(() => admitCheckpointStoryboardBehaviorRecordProfile(hybrid)).toThrow("exactly the renderer.gpu");
    const lifecycleCatalog = request({ catalogCreation: true });
    expect(() => admitCheckpointStoryboardBehaviorRecordProfile(lifecycleCatalog.storyboard)).toThrow("catalog creation payloads");
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(lifecycleCatalog)).toThrow("catalog creation payloads");
  });

  it("projects one sealed gravity recipe to one exact behaviors@1 root structure, not baked keys", () => {
    const input = request();
    const plan = compileCheckpointStoryboardBehaviorProfilePlan(input);
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-behavior-profile-plan@1",
      storyboard: { id: input.storyboard.id, sha256: input.storyboard.sha256, revision: 1 },
      base: { package: { id: "package-1", motionPath: "motion.json" }, manifest: { id: "package-1" }, canonicalMotion: { id: "motion-1" }, persistedMotion: { id: "motion-1", sha256: HASH } },
      lowererProfile: { requiredCapability: "renderer.gpu", endpointRule: "direct-exact-us-equality" },
      objectLayerBinding: { objectId: "orb", layerId: "orb", layerIndex: 0, rootShapeKind: "ellipse" },
      projection: {
        edge: { id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish" },
        recipe: { id: input.storyboard.recipes[0]!.id, sha256: input.storyboard.recipes[0]!.sha256, revision: 1, recipeId: "behavior" },
        interval: { startUs: 0, durationUs: 1_000_000 }, path: "/behaviors", ownedPropertyMask: ["transform.x", "transform.y"],
        store: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "orb", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 30, velocityY: 10, gravityY: 20 } }] },
      },
      evidence: { noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true },
    });
    expect(plan.projection.storeSha256).toBe(canonicalJsonSha256(plan.projection.store));
    expect(JSON.stringify(plan.projection)).not.toContain("keyframes");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.projection.store.bindings)).toBe(true);
    expect(compileCheckpointStoryboardBehaviorProfilePlan(request({ rootShapeKind: "rect" })).objectLayerBinding.rootShapeKind).toBe("rect");
  });

  it("uses direct exact-microsecond evaluation and preserves both endpoint equalities", () => {
    const gravity = compileCheckpointStoryboardBehaviorProfilePlan(request());
    expect(gravity.endpointEvaluations.start).toMatchObject({ atUs: 0, localUs: 0, transform: { x: 10, y: 20 } });
    expect(gravity.endpointEvaluations.end).toMatchObject({ atUs: 1_000_000, localUs: 1_000_000, transform: { x: 40, y: 40 } });
    const bounce = compileCheckpointStoryboardBehaviorProfilePlan(request({ kind: "bounce" }));
    expect(bounce.projection.ownedPropertyMask).toEqual(["transform.y"]);
    expect(bounce.endpointEvaluations.start.transform.y).toBe(0);
    expect(bounce.endpointEvaluations.end.transform.y).toBe(5);

    const wrongStart = request(); wrongStart.base.motion.layers[0]!.transform.x = 11;
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(wrongStart)).toThrow("start endpoint does not exactly equal transform.x");
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(request({ endY: 41 }))).toThrow("end endpoint does not exactly equal transform.y");
  });

  it("is deterministic across detached sealed inputs and binds no evaluation authority to a renderer", () => {
    const input = request(), first = compileCheckpointStoryboardBehaviorProfilePlan(input), replay = compileCheckpointStoryboardBehaviorProfilePlan(clone(input));
    expect(replay).toEqual(first);
    expect(replay.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.endpointEvaluations.start.sourceSha256).toBe(replay.endpointEvaluations.end.sourceSha256);
    expect(replay.endpointEvaluations.end.fingerprint).toEqual(first.endpointEvaluations.end.fingerprint);
    expect(replay.evidence.noRenderer).toBe(true);
  });

  it("fails closed on capabilities, profile widening, lifecycle, and full transform-overlay conflicts", () => {
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(request({ capabilityRequirements: ["renderer.native"] }))).toThrow("exactly the renderer.gpu");
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(request({ capabilityRequirements: ["renderer.gpu", "renderer.native"] }))).toThrow("exactly the renderer.gpu");

    const withKeys = clone(request()); withKeys.base.motion.layers[0]!.keyframes = { "transform.x": [] };
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(withKeys)).toThrow("full transform-overlay");
    const withStore = clone(request()); withStore.base.motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [] };
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(withStore)).toThrow("existing behaviors authority");
    const withExtraLayer = clone(request()); withExtraLayer.base.motion.layers.push({ id: "extra", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000 });
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(withExtraLayer)).toThrow("exactly one existing base layer");

    const wrongBinding = clone(request()); wrongBinding.objectLayerBindings[0]!.layerId = "other";
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(wrongBinding)).toThrow("exact same-ID object/layer binding");
  });

  it("uses descriptor-first hostile admission before semantic reads", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA, base: {}, objectLayerBindings: [] };
    Object.defineProperty(hostile, "storyboard", { enumerable: true, get() { getterCalls += 1; return request().storyboard; } });
    expect(() => readCheckpointStoryboardBehaviorProfileRequest(hostile)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);

    let ownKeys = 0;
    const oversized = new Proxy({}, { ownKeys() { ownKeys += 1; return Array.from({ length: 10_000 }, (_item, index) => `field${index}`); } });
    expect(() => compileCheckpointStoryboardBehaviorProfilePlan(oversized)).toThrow("24-field record limit");
    expect(ownKeys).toBe(1);
  });

  it("stays private, installable, and free of package I/O or renderer imports", () => {
    const compiler = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-behavior-profile.ts", import.meta.url), "utf8");
    expect(compiler).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const publicCoreBarrel = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(publicCoreBarrel).not.toContain("checkpoint-storyboard");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-behavior-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-behavior-materializer.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-behavior-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-behavior-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-behavior-materializer.js" });
  });
});
