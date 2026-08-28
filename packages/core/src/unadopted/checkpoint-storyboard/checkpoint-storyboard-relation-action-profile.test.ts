import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../canonical-json";
import { createCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records";
import { createTransitionRecipe } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-recipes";
import { admitCheckpointStoryboardC6CRecordProfile } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-materializer";
import { admitCheckpointStoryboardRelationActionRecordProfile } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-record-profile";
import {
  compileCheckpointStoryboardRelationActionProfilePlan,
  readCheckpointStoryboardRelationActionProfileRequest,
} from "../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-profile";
import { CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-profile-types";

const HASH = "a".repeat(64);
const SOURCE = { x: 100, y: 50 };
const TARGET = { x: 125, y: 50 };
const literal = (value: number) => ({ source: "literal" as const, value });
const role = (roleId: string) => ({ source: "role" as const, roleId });

function actionDefinition(options: { readonly mode?: "follow" | "similarity"; readonly durationUs?: number; readonly parameters?: readonly unknown[]; readonly templates?: readonly unknown[]; readonly atUs?: number; readonly rotationDeg?: number; readonly scale?: number } = {}) {
  return {
    id: "follow-action",
    roles: [
      { id: "guide", kind: "layer" as const, layerTypes: ["shape"] },
      { id: "orb", kind: "layer" as const, layerTypes: ["shape"] },
    ],
    parameters: options.parameters ?? [],
    templateLayers: options.templates ?? [],
    relationTemplates: [{
      id: "follow-template", enabled: true, kind: "attach" as const,
      source: { layer: role("guide"), anchorX: literal(10), anchorY: literal(10) },
      target: { layer: role("orb"), anchorX: literal(5), anchorY: literal(5) },
      startUs: 0, durationUs: literal(options.durationUs ?? 1_000_000), mode: options.mode ?? "follow",
      offset: { space: "world" as const, x: literal(20), y: literal(-5), rotationDeg: literal(options.rotationDeg ?? 0), scale: literal(options.scale ?? 1) },
    }],
    sequence: [{ id: "relate", kind: "relation" as const, atUs: options.atUs ?? 0, relationTemplateId: "follow-template" }],
  };
}

function state(objectId: "guide" | "orb", value: { readonly x: number; readonly y: number }) {
  return {
    objectId, state: "present" as const,
    properties: [
      { property: "transform.x" as const, value: value.x },
      { property: "transform.y" as const, value: value.y },
    ],
  };
}

function request(options: {
  readonly capabilityRequirements?: readonly string[];
  readonly action?: ReturnType<typeof actionDefinition>;
  readonly endAtUs?: number;
  readonly declaredWrites?: readonly { readonly objectId: string; readonly propertyMask: readonly ("transform.x" | "transform.y" | "opacity")[] }[];
  readonly parameterValues?: readonly { readonly parameterId: string; readonly value: string | number }[];
  readonly lifecycle?: "preserve" | "create";
  readonly target?: { readonly x: number; readonly y: number };
  readonly catalogCreation?: boolean;
} = {}): any {
  const action = options.action ?? actionDefinition();
  const definitionSha256 = canonicalJsonSha256(action);
  const recipe = createTransitionRecipe({
    recipeId: "follow-action-recipe", seed: 2,
    exactBaseRequirements: [{ resolution: "deferred-exact-base", definitionId: action.id, definitionSha256 }],
    intent: {
      kind: "relation-action",
      roleBindings: [{ roleId: "guide", objectId: "guide" }, { roleId: "orb", objectId: "orb" }],
      parameterValues: options.parameterValues ?? [],
      declaredWrites: options.declaredWrites ?? [{ objectId: "orb", propertyMask: ["transform.x", "transform.y"] }],
    },
  });
  const endAtUs = options.endAtUs ?? 1_000_000;
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: options.capabilityRequirements ?? ["renderer.gpu"],
    objectCatalog: [
      { objectId: "guide", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y"], ...(options.catalogCreation ? { creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } } : {}) },
      { objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y"], ...(options.catalogCreation ? { creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#f3c547", width: 60, height: 40 } } : {}) },
    ],
    checkpoints: [
      { id: "start", atUs: 0, objects: [state("guide", SOURCE), state("orb", options.target ?? TARGET)] },
      { id: "finish", atUs: endAtUs, objects: [state("guide", SOURCE), state("orb", options.target ?? TARGET)] },
    ],
    edges: [{
      id: "follow-action-edge", fromCheckpointId: "start", toCheckpointId: "finish",
      lifecycle: [{ kind: options.lifecycle ?? "preserve", objectId: "guide" }, { kind: "preserve", objectId: "orb" }],
      recipeIds: ["follow-action-recipe"],
    }],
    recipes: [recipe],
  });
  return {
    schema: CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "Private C6B4a fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } },
      motion: {
        schema: "shellx-motion/motion@1", id: "motion-1", name: "Private C6B4a fixture", durationMs: 1_000, fps: 30, width: 1280, height: 720,
        layers: [
          { id: "guide", type: "shape", shape: "rect", fill: "#4e8cff", startMs: 0, durationMs: 1_000, transform: { x: SOURCE.x, y: SOURCE.y } },
          { id: "orb", type: "shape", shape: "ellipse", fill: "#f3c547", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0 } },
        ],
        assets: [], provenance: { sourceApp: "test", createdBy: "test" },
        relationActions: { schema: "shellx-motion/relation-actions@2", definitions: [action] },
      },
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [{ objectId: "guide", layerId: "guide" }, { objectId: "orb", layerId: "orb" }],
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe("private C6B4a checkpoint relation-action compiler", () => {
  it("admits the base-independent C6B4 record into the sealed C6C lifecycle union only", () => {
    const accepted = request({ endAtUs: 500_000 }).storyboard;
    expect(admitCheckpointStoryboardRelationActionRecordProfile(accepted)).toEqual(accepted);
    expect(admitCheckpointStoryboardC6CRecordProfile(accepted)).toEqual({ storyboard: accepted, profile: "c6b4-relation-action@1" });
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ endAtUs: 500_000 }))).toThrow("exact package duration D");
    expect(() => admitCheckpointStoryboardRelationActionRecordProfile(request({ declaredWrites: [{ objectId: "orb", propertyMask: ["opacity"] }] }).storyboard)).toThrow(/declared property mask|target transform.x\/transform.y declared write/);
    expect(() => admitCheckpointStoryboardRelationActionRecordProfile(request({ parameterValues: [{ parameterId: "smuggled", value: 1 }] }).storyboard)).toThrow("no parameters");
    const lifecycleCatalog = request({ catalogCreation: true });
    expect(() => admitCheckpointStoryboardRelationActionRecordProfile(lifecycleCatalog.storyboard)).toThrow("catalog creation payloads");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(lifecycleCatalog)).toThrow("catalog creation payloads");
  });

  it("lowers exactly one sealed public C4B follow action into an ordinary relation-only detached plan", () => {
    const input = request();
    const plan = compileCheckpointStoryboardRelationActionProfilePlan(input);
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-relation-action-profile-plan@1",
      storyboard: { id: input.storyboard.id, sha256: input.storyboard.sha256, revision: 1 },
      base: { package: { id: "package-1", motionPath: "motion.json" }, manifest: { id: "package-1" }, canonicalMotion: { id: "motion-1" }, persistedMotion: { id: "motion-1", sha256: HASH } },
      lowererProfile: {
        requiredCapability: "renderer.gpu", actionStoreSchema: "shellx-motion/relation-actions@2", relationKinds: ["follow"], offsetSpaces: ["world"],
        roles: 2, parameters: 0, templateLayers: 0, sequenceSteps: 1, relationTemplates: 1, ownedPropertyMask: ["transform.x", "transform.y"],
      },
      objectLayerBindings: { source: { objectId: "guide", layerId: "guide", layerIndex: 0, rootShapeKind: "rect" }, target: { objectId: "orb", layerId: "orb", layerIndex: 1, rootShapeKind: "ellipse" } },
      projection: {
        edge: { id: "follow-action-edge", fromCheckpointId: "start", toCheckpointId: "finish" },
        recipe: { id: input.storyboard.recipes[0].id, sha256: input.storyboard.recipes[0].sha256, revision: 1, recipeId: "follow-action-recipe" },
        action: { store: { schema: "shellx-motion/relation-actions@2" }, definition: { id: "follow-action" }, applyPlan: { counts: { objects: 0, relations: 1, keyframeWrites: 0 } }, changedPaths: [expect.stringMatching(/^\/relations\/bindings\/ra_binding_/)] },
        path: "/relations", store: { schema: "shellx-motion/relations@1" },
      },
      evidence: { noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true },
    });
    expect(plan.projection.store.bindings[0]).toMatchObject({ kind: "attach", mode: "follow", source: { layerId: "guide" }, target: { layerId: "orb" }, startUs: 0, durationUs: 1_000_000 });
    expect(plan.projection.action.relationIds).toEqual([plan.projection.store.bindings[0].id]);
    expect(plan.projection.storeSha256).toBe(canonicalJsonSha256(plan.projection.store));
    expect(plan.projection.staticFingerprint).toBe(plan.projection.staticPlan.fingerprint);
    expect(plan.projection.gpuPreviewStaticPlan.relationStaticFingerprint).toBe(plan.projection.staticFingerprint);
    expect(plan.endpointEvaluations.start.samples).toEqual([expect.objectContaining({ targetLayerId: "orb", writeMask: ["transform.x", "transform.y"] })]);
    expect(plan.endpointEvaluations.end.samples).toEqual([expect.objectContaining({ targetLayerId: "orb", writeMask: ["transform.x", "transform.y"] })]);
    expect(plan.endpointEvaluations.start.layers.find((layer) => layer.id === "guide")?.transform).toMatchObject(SOURCE);
    expect(plan.endpointEvaluations.start.layers.find((layer) => layer.id === "orb")?.transform).toMatchObject(TARGET);
    expect(plan.endpointFramePlans.start.staticFingerprint).toBe(plan.projection.staticFingerprint);
    expect(plan.endpointFramePlans.end.staticFingerprint).toBe(plan.projection.staticFingerprint);
  });

  it("is deterministic, derives the C4B instance identity from sealed inputs, and deep-freezes all returned facts", () => {
    const input = request(), before = JSON.stringify(input);
    const first = compileCheckpointStoryboardRelationActionProfilePlan(input);
    const replay = compileCheckpointStoryboardRelationActionProfilePlan(clone(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(replay).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.projection.action.request.instanceId).toMatch(/^c6ra_[a-f0-9]{32}$/);
    expect(first.projection.action.request.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.projection.action.outputCanonicalMotionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.projection.store.bindings)).toBe(true);
    expect(Object.isFrozen(first.projection.action.applyPlan)).toBe(true);
    expect(Object.isFrozen(first.endpointEvaluations.end.layers[0]?.transform)).toBe(true);
    expect(Object.isFrozen(first.endpointFramePlans.end.samples)).toBe(true);
  });

  it("refuses every action widening, lifecycle escape, identity mismatch, and declared-write drift before action application", () => {
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ capabilityRequirements: ["renderer.browser"] }))).toThrow("exactly the renderer.gpu");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ lifecycle: "create" }))).toThrow(/lifecycle.*preserve|explicitly.*preserve/);
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ endAtUs: 999_999 }))).toThrow(/time_resolution_unavailable|whole-millisecond|spanning \[0, D\]/);
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: actionDefinition({ mode: "similarity" }) }))).toThrow("world-space follow");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: actionDefinition({ rotationDeg: 1 }) }))).toThrow("translation-only");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: actionDefinition({ scale: 2 }) }))).toThrow("translation-only");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: actionDefinition({ durationUs: 999_000 }) }))).toThrow("spanning the exact edge");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: actionDefinition({ atUs: 1 }) }))).toThrow("zero-local-time");
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ declaredWrites: [{ objectId: "guide", propertyMask: ["transform.x", "transform.y"] }] }))).toThrow("declaredWrites");

    const parameters = actionDefinition({ parameters: [{ id: "speed", type: "number", minimum: 0, maximum: 1, defaultValue: 1 }] });
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: parameters }))).toThrow("no parameters/templates");
    const templated = actionDefinition({ templates: [{ id: "extra", layer: { schema: "shellx-motion/relation-action-layer-prototype@1", type: "shape", startUs: 0, durationUs: 1_000_000, shape: "rect", fill: "#ffffff" } }] });
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(request({ action: templated }))).toThrow("no parameters/templates");

    const stale = request();
    const staleDescriptor = stale.storyboard;
    stale.storyboard = createCheckpointStoryboard({
      seed: staleDescriptor.seed,
      capabilityRequirements: staleDescriptor.capabilityRequirements,
      objectCatalog: staleDescriptor.objectCatalog,
      checkpoints: staleDescriptor.checkpoints,
      edges: staleDescriptor.edges,
      recipes: [createTransitionRecipe({
      recipeId: "follow-action-recipe", seed: 2, exactBaseRequirements: [{ resolution: "deferred-exact-base", definitionId: "follow-action", definitionSha256: "0".repeat(64) }],
      intent: stale.storyboard.recipes[0].intent,
      })],
    });
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(stale)).toThrow("does not match the persisted action definition");
  });

  it("refuses competing Motion authority, topology, base-store widening, and endpoint disagreement", () => {
    const withKeys = clone(request()); withKeys.base.motion.layers[1].keyframes = { "transform.x": [] };
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(withKeys)).toThrow("transform/timing authority");
    const withBehaviors = clone(request()); withBehaviors.base.motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "guide", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 0, velocityY: 0, gravityY: 1 } }] };
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(withBehaviors)).toThrow("existing behaviors authority");
    const withRelations = clone(request()); withRelations.base.motion.relations = { schema: "shellx-motion/relations@1", bindings: [{ id: "prior-follow", enabled: true, kind: "attach", source: { layerId: "guide", anchor: { x: 0, y: 0 } }, target: { layerId: "orb", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 1_000_000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } }] };
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(withRelations)).toThrow("existing relations authority");
    const groups = clone(request()); groups.base.motion.layers[0].childLayerIds = ["orb"];
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(groups)).toThrow(/root-owned|Motion document is invalid/);
    const hidden = clone(request()); hidden.base.motion.layers[0].visible = false;
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(hidden)).toThrow(/unlocked root-owned|visible/);
    const morph = clone(request()); morph.base.motion.layers[0].morph = {};
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(morph)).toThrow(/Motion document is invalid|depth, geometry, or morph/);
    const effectModule = clone(request()); effectModule.base.motion.layers[0].effectModule = {};
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(effectModule)).toThrow(/Motion document is invalid|non-T3 GPU-preview effect/);
    const motionBlur = clone(request()); motionBlur.base.motion.layers[0].effects = { motionBlur: { samples: 2, shutterAngle: 180 } };
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(motionBlur)).toThrow("non-T3 GPU-preview effect");
    const manyDefinitions = clone(request()); const secondDefinition = actionDefinition(); secondDefinition.id = "follow-action-2"; manyDefinitions.base.motion.relationActions.definitions.push(secondDefinition as any);
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(manyDefinitions)).toThrow("exactly one persisted");
    const badEndpoint = request({ target: { x: 126, y: 50 } });
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(badEndpoint)).toThrow("endpoint does not exactly equal target.transform.x");
  });

  it("uses descriptor-first hostile-data admission before observing storyboard descendants", () => {
    let reads = 0;
    const accessor: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA, base: {}, objectLayerBindings: [] };
    Object.defineProperty(accessor, "storyboard", { enumerable: true, get() { reads += 1; return request().storyboard; } });
    expect(() => readCheckpointStoryboardRelationActionProfileRequest(accessor)).toThrow("enumerable data field");
    expect(reads).toBe(0);

    let ownKeys = 0;
    const oversized = new Proxy({}, { ownKeys() { ownKeys += 1; return Array.from({ length: 10_000 }, (_value, index) => `field${index}`); } });
    expect(() => compileCheckpointStoryboardRelationActionProfilePlan(oversized)).toThrow("24-field record limit");
    expect(ownKeys).toBe(1);
  });

  it("publishes one private Core internal handoff while retaining no root, Debug, or raw-action surface", () => {
    const compiler = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-profile.ts", import.meta.url), "utf8");
    expect(compiler).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const compatibility = readFileSync(new URL("./checkpoint-storyboard-relation-action-profile.ts", import.meta.url), "utf8");
    expect(compatibility.trim()).toBe("/** Compatibility facade for source-only callers; this is not a package entry. */\nexport * from \"../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-profile.js\";");
    const compatibilityTypes = readFileSync(new URL("./checkpoint-storyboard-relation-action-profile-types.ts", import.meta.url), "utf8");
    expect(compatibilityTypes.trim()).toBe("/** Compatibility facade for source-only callers; this is not a package entry. */\nexport * from \"../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-profile-types.js\";");
    const handoff = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.ts", import.meta.url), "utf8");
    expect(handoff).not.toMatch(/applyMotionRelationAction|motion-relation-actions-public/);
    const coreIndex = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(coreIndex).not.toContain("checkpoint-storyboard-relation-action");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-relation-action-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-relation-action-profile"]).toEqual({
      types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.d.ts",
      default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-action-materializer.js",
    });
  });
});
