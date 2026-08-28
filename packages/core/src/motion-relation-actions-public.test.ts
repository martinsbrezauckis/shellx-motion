import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { MOTION_RELATION_ACTION_ROLE_LAYER_TYPES } from "./motion-relation-action-layer-types";
import {
  applyMotionRelationAction,
  inspectMotionRelationActions,
  removeMotionRelationActionDefinition,
  upsertMotionRelationActionDefinition,
} from "./motion-relation-actions-public";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { assertMotionRelationActionApplyCaps } from "./motion-relation-actions-materialize-support";
import { readMotionRelationActionApplyRequest, readMotionRelationActionDefinitionRemove, readMotionRelationActionStore } from "./motion-relation-actions-public-read";
import { upsertMotionBehavior } from "./motion-behavior-authoring";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument } from "./types";

const literal = (value: number) => ({ source: "literal" as const, value });
const color = (value: string) => ({ source: "literal" as const, value });
const role = (roleId: string) => ({ source: "role" as const, roleId });
const template = (templateLayerId: string) => ({ source: "template" as const, templateLayerId });

function definition() {
  return {
    id: "accent-action",
    roles: [{ id: "anchor", kind: "layer", layerTypes: ["shape"] }],
    parameters: [
      { id: "duration", type: "number", minimum: 100_000, maximum: 1_000_000, defaultValue: 1_000_000 },
      { id: "tint", type: "color", defaultValue: "#123ABC" },
    ],
    templateLayers: [{
      id: "accent",
      layer: {
        schema: "shellx-motion/relation-action-layer-prototype@1",
        type: "shape",
        startUs: 0,
        durationUs: 1_000_000,
        shape: "rect",
        fill: "#ABC123",
        stroke: "#001122",
        strokeWidth: 2,
        transform: { x: 20, y: 10, width: 20, height: 10 },
      },
    }],
    relationTemplates: [{
      id: "follow-anchor", enabled: true, kind: "attach", source: { layer: role("anchor"), anchorX: literal(0), anchorY: literal(0) },
      target: { layer: template("accent"), anchorX: literal(0), anchorY: literal(0) }, startUs: 0, durationUs: { source: "parameter" as const, parameterId: "duration" }, mode: "follow",
      offset: { space: "world", x: literal(0), y: literal(0), rotationDeg: literal(0), scale: literal(1) },
    }],
    sequence: [
      { id: "color", kind: "keyframe", atUs: 0, target: template("accent"), property: "style.fill", value: { source: "parameter" as const, parameterId: "tint" }, easing: "ease-out" },
      { id: "relate", kind: "relation", atUs: 0, relationTemplateId: "follow-anchor" },
      { id: "transition", kind: "transition", atUs: 0, target: template("accent"), presetId: "soft-fade", durationUs: { source: "parameter" as const, parameterId: "duration" } },
    ],
  };
}

function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "action-motion", name: "Action Motion", durationMs: 2_000, fps: 30, width: 100, height: 60,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "anchor", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000, transform: { x: 10, y: 5, width: 10, height: 10 } }],
  };
}

function applyRequest(source: MotionDocument) {
  const inspection = inspectMotionRelationActions(source);
  const action = inspection.store!.definitions[0]!;
  return {
    definitionId: action.id,
    expectedMotionSha256: canonicalJsonSha256(source),
    expectedStoreSha256: inspection.storeSha256,
    expectedDefinitionSha256: canonicalJsonSha256(action),
    instanceId: "accent-01",
    startAtUs: 1_000_000,
    roleBindings: { anchor: "anchor" },
    parameterValues: { duration: 1_000_000, tint: "#44AAFF" },
  };
}

describe("public relation-actions@2 materialization", () => {
  it("projects the closed role vocabulary through the runtime reader and public schema", () => {
    const candidate = definition();
    candidate.roles[0]!.layerTypes = [...MOTION_RELATION_ACTION_ROLE_LAYER_TYPES].sort();
    candidate.parameters = [];
    candidate.relationTemplates = [];
    candidate.sequence = [];
    expect(() => readMotionRelationActionStore({ schema: "shellx-motion/relation-actions@2", definitions: [candidate] })).not.toThrow();

    const schema = buildMotionPublicSchema() as { $defs: Record<string, { oneOf: Array<{ properties: Record<string, { maxItems: number; items: { enum: readonly string[] } }> }> }> };
    const roleLayerTypes = schema.$defs.motionRelationActionRole!.oneOf[1]!.properties.layerTypes!;
    expect(roleLayerTypes.maxItems).toBe(MOTION_RELATION_ACTION_ROLE_LAYER_TYPES.length);
    expect(roleLayerTypes.items.enum).toEqual(MOTION_RELATION_ACTION_ROLE_LAYER_TYPES);

    candidate.roles[0]!.layerTypes = ["environment"];
    expect(() => readMotionRelationActionStore({ schema: "shellx-motion/relation-actions@2", definitions: [candidate] })).toThrow("not action-admitted");
  });

  it("persists a closed definition without making it a renderer authority", () => {
    const source = motion();
    const upserted = upsertMotionRelationActionDefinition(source, { definition: definition() });
    expect(source).not.toHaveProperty("relationActions");
    expect(upserted).toMatchObject({ action: "upserted", changedPaths: ["/relationActions"] });
    expect(upserted.motion.relationActions).toMatchObject({ schema: "shellx-motion/relation-actions@2", definitions: [{ id: "accent-action" }] });
    const plainPlan = compileGpuSceneStaticPlan(source);
    const metadataPlan = compileGpuSceneStaticPlan(upserted.motion);
    expect(plainPlan).toMatchObject({ ok: true });
    expect(metadataPlan).toMatchObject({ ok: true });
    if (!plainPlan.ok || !metadataPlan.ok) return;
    expect(metadataPlan.plan.documentFingerprint).not.toBe(plainPlan.plan.documentFingerprint);
    expect(metadataPlan.plan.layers).toEqual(plainPlan.plan.layers);
    const plainFrame = compileGpuScene2dPlan(source, 500), metadataFrame = compileGpuScene2dPlan(upserted.motion, 500);
    expect(plainFrame).toMatchObject({ ok: true }); expect(metadataFrame).toMatchObject({ ok: true });
    if (plainFrame.ok && metadataFrame.ok) expect(metadataFrame.plan.frame.draws).toEqual(plainFrame.plan.frame.draws);
  });

  it("lowers one exact-base action into ordinary data and preserves source bytes", () => {
    const source = motion();
    const stored = upsertMotionRelationActionDefinition(source, { definition: definition() }).motion;
    const before = canonicalJson(stored);
    const result = applyMotionRelationAction(stored, applyRequest(stored));
    expect(canonicalJson(stored)).toBe(before);
    expect(result).toMatchObject({
      action: "applied", definitionId: "accent-action",
      plan: { schema: "shellx-motion/relation-action-apply-plan@1", counts: { objects: 1, relations: 1, keyframeWrites: expect.any(Number) } },
      relationIds: [expect.stringMatching(/^ra_binding_/)],
      createdObjectIds: [expect.stringMatching(/^ra_layer_/)],
    });
    const accent = result.motion.layers.find((layer) => layer.id === result.createdObjectIds[0]);
    expect(accent).toMatchObject({ type: "shape", startMs: 1_000, durationMs: 1_000, fill: "#abc123", style: { stroke: "#001122", strokeWidth: 2 } });
    expect(accent?.keyframes?.["style.fill"]).toEqual([{ atMs: 0, value: "#44aaff", easing: "ease-out" }]);
    expect(result.motion.relations?.bindings[0]).toMatchObject({ source: { layerId: "anchor" }, target: { layerId: accent?.id }, startUs: 1_000_000, durationUs: 1_000_000 });
    expect(result.motion.relationActions).toEqual(stored.relationActions);
  });

  it("does not retroactively mutate materialized output when a definition changes or is removed", () => {
    const stored = upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const materialized = applyMotionRelationAction(stored, applyRequest(stored)).motion;
    const revised = structuredClone(definition()); revised.parameters[1]!.defaultValue = "#FEDCBA";
    const updated = upsertMotionRelationActionDefinition(materialized, { definition: revised }).motion;
    const removed = removeMotionRelationActionDefinition(updated, { id: "accent-action" }).motion;
    expect(removed).not.toHaveProperty("relationActions");
    expect(removed.layers.some((layer) => layer.id.startsWith("ra_layer_"))).toBe(true);
    expect(removed.relations?.bindings.some((binding) => binding.id.startsWith("ra_binding_"))).toBe(true);
  });

  it("refuses stale bases, non-millisecond legacy writes, locked relation sources, and group-child relation endpoints", () => {
    const stored = upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const request = applyRequest(stored);
    expect(() => applyMotionRelationAction(stored, { ...request, expectedMotionSha256: "0".repeat(64) })).toThrow("stale expectedMotionSha256");
    const nonMs = structuredClone(definition()); nonMs.templateLayers[0]!.layer.startUs = 1;
    const nonMsStored = upsertMotionRelationActionDefinition(motion(), { definition: nonMs }).motion;
    expect(() => applyMotionRelationAction(nonMsStored, applyRequest(nonMsStored))).toThrow("whole-millisecond");
    const locked = structuredClone(stored); locked.layers[0]!.locked = true;
    const lockedRequest = applyRequest(locked);
    expect(() => applyMotionRelationAction(locked, lockedRequest)).toThrow("locked layer: anchor");

    const grouped = structuredClone(definition()) as any;
    grouped.templateLayers = [
      { ...grouped.templateLayers[0]!, layer: { ...grouped.templateLayers[0]!.layer, startUs: 0 }, parent: template("container") },
      { id: "container", layer: { schema: "shellx-motion/relation-action-layer-prototype@1", type: "group", startUs: 0, durationUs: 1_000_000 } },
    ];
    const groupedStored = upsertMotionRelationActionDefinition(motion(), { definition: grouped }).motion;
    expect(() => applyMotionRelationAction(groupedStored, applyRequest(groupedStored))).toThrow("root-owned shape");
  });

  it("snapshots public authoring caps before hostile array traversal or accessors", () => {
    const before = canonicalJson({ schema: "shellx-motion/relation-actions@2", definitions: [definition()] });
    const run = (length: number, maximum: number) => {
      let ownKeys = 0, descriptors = 0, gets = 0;
      const array = new Proxy(new Array(length), {
        ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
        get(target, key, receiver) { gets += 1; return Reflect.get(target, key, receiver); },
      });
      expect(() => readMotionRelationActionStore({ schema: "shellx-motion/relation-actions@2", definitions: array })).toThrow(`at most ${maximum}`);
      expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 0, descriptors: 1, gets: 0 });
    };
    run(17, 16); run(100_000, 16);
    let templateOwnKeys = 0, templateDescriptors = 0;
    const templates = new Proxy(new Array(33), {
      ownKeys(target) { templateOwnKeys += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { templateDescriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const templateCap = definition(); templateCap.templateLayers = templates as unknown as typeof templateCap.templateLayers;
    expect(() => readMotionRelationActionStore({ schema: "shellx-motion/relation-actions@2", definitions: [templateCap] })).toThrow("at most 32");
    expect({ templateOwnKeys, templateDescriptors }).toEqual({ templateOwnKeys: 0, templateDescriptors: 1 });
    for (const length of [9, 100_000]) {
      let ownKeys = 0, descriptors = 0, gets = 0;
      const layerTypes = new Proxy(new Array(length), {
        ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
        get(target, key, receiver) { gets += 1; return Reflect.get(target, key, receiver); },
      });
      const roleCap = definition(); roleCap.roles[0] = { id: "anchor", kind: "layer", layerTypes: layerTypes as unknown as string[] };
      expect(() => readMotionRelationActionStore({ schema: "shellx-motion/relation-actions@2", definitions: [roleCap] })).toThrow("at most 8");
      expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 0, descriptors: 1, gets: 0 });
    }
    const accessor: Record<string, unknown> = { schema: "shellx-motion/relation-actions@2" }; let reads = 0;
    Object.defineProperty(accessor, "definitions", { enumerable: true, get() { reads += 1; return []; } });
    expect(() => readMotionRelationActionStore(accessor)).toThrow("enumerable data field"); expect(reads).toBe(0);
    const throwing = new Proxy([], { getOwnPropertyDescriptor() { throw new Error("trap"); } });
    expect(() => readMotionRelationActionStore({ schema: "shellx-motion/relation-actions@2", definitions: throwing })).toThrow("reflection failed");
    const source = { schema: "shellx-motion/relation-actions@2", definitions: [definition()] };
    expect(canonicalJson(source)).toBe(before); readMotionRelationActionStore(source); expect(canonicalJson(source)).toBe(before);
  });

  it("caps every exact transient envelope before source observation or map traversal", () => {
    const envelope = (roleBindings: unknown, parameterValues: unknown = {}) => ({
      definitionId: "accent-action", expectedMotionSha256: "a".repeat(64), expectedStoreSha256: "b".repeat(64), expectedDefinitionSha256: "c".repeat(64), instanceId: "instance-01", startAtUs: 0, roleBindings, parameterValues,
    });
    const runMap = (length: number, field: "roleBindings" | "parameterValues") => {
      let ownKeys = 0, descriptors = 0, gets = 0;
      const map = new Proxy(Object.fromEntries(Array.from({ length }, (_, index) => [`role-${index}`, "anchor"])), {
        ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); }, get(target, key, receiver) { gets += 1; return Reflect.get(target, key, receiver); },
      });
      const input = envelope(field === "roleBindings" ? map : {}, field === "parameterValues" ? map : {});
      expect(() => readMotionRelationActionApplyRequest(input)).toThrow("bounded plain object");
      expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 1, descriptors: 0, gets: 0 });
    };
    runMap(17, "roleBindings"); runMap(100_000, "roleBindings"); runMap(17, "parameterValues"); runMap(100_000, "parameterValues");
    let rootOwnKeys = 0, rootDescriptors = 0, rootGets = 0;
    const extraRoot = new Proxy({ ...envelope({ anchor: "anchor" }), extra: true }, {
      ownKeys(target) { rootOwnKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { rootDescriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); }, get(target, key, receiver) { rootGets += 1; return Reflect.get(target, key, receiver); },
    });
    expect(() => readMotionRelationActionApplyRequest(extraRoot)).toThrow("bounded plain object"); expect({ rootOwnKeys, rootDescriptors, rootGets }).toEqual({ rootOwnKeys: 1, rootDescriptors: 0, rootGets: 0 });
    let unknownApplyOwnKeys = 0, unknownApplyDescriptors = 0;
    const unknownApply = { ...envelope({ anchor: "anchor" }) } as Record<string, unknown>; delete unknownApply.parameterValues; unknownApply.extra = true;
    const unknownApplyProxy = new Proxy(unknownApply, { ownKeys(target) { unknownApplyOwnKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { unknownApplyDescriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    expect(() => readMotionRelationActionApplyRequest(unknownApplyProxy)).toThrow("unknown field"); expect({ unknownApplyOwnKeys, unknownApplyDescriptors }).toEqual({ unknownApplyOwnKeys: 1, unknownApplyDescriptors: 0 });
    const accessor = envelope({}); let reads = 0; Object.defineProperty(accessor, "roleBindings", { enumerable: true, get() { reads += 1; return {}; } });
    expect(() => readMotionRelationActionApplyRequest(accessor)).toThrow("enumerable data field"); expect(reads).toBe(0);
    expect(() => readMotionRelationActionApplyRequest(new Proxy({}, { ownKeys() { throw new Error("trap"); } }))).toThrow("reflection failed");
    let removeOwnKeys = 0, removeDescriptors = 0;
    const oversizedRemove = new Proxy({ id: "accent-action", extra: true }, { ownKeys(target) { removeOwnKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { removeDescriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    expect(() => readMotionRelationActionDefinitionRemove(oversizedRemove)).toThrow("bounded plain object"); expect({ removeOwnKeys, removeDescriptors }).toEqual({ removeOwnKeys: 1, removeDescriptors: 0 });
    let unknownRemoveOwnKeys = 0, unknownRemoveDescriptors = 0;
    const unknownRemove = new Proxy({ unknown: "accent-action" }, { ownKeys(target) { unknownRemoveOwnKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { unknownRemoveDescriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    expect(() => readMotionRelationActionDefinitionRemove(unknownRemove)).toThrow("unknown field"); expect({ unknownRemoveOwnKeys, unknownRemoveDescriptors }).toEqual({ unknownRemoveOwnKeys: 1, unknownRemoveDescriptors: 0 });
    const removeAccessor: Record<string, unknown> = {}; let removeReads = 0; Object.defineProperty(removeAccessor, "id", { enumerable: true, get() { removeReads += 1; return "accent-action"; } });
    expect(() => readMotionRelationActionDefinitionRemove(removeAccessor)).toThrow("enumerable data field"); expect(removeReads).toBe(0);
    expect(() => readMotionRelationActionDefinitionRemove(new Proxy({}, { ownKeys() { throw new Error("trap"); } }))).toThrow("reflection failed");
    const stable = envelope({ anchor: "anchor" }), before = canonicalJson(stable); readMotionRelationActionApplyRequest(stable); expect(canonicalJson(stable)).toBe(before);
    let sourceReads = 0; const unobservedSource = new Proxy(motion(), { get() { sourceReads += 1; throw new Error("source observed"); } }) as MotionDocument;
    expect(() => applyMotionRelationAction(unobservedSource, envelope(new Proxy({}, { ownKeys() { throw new Error("input trap"); } })))).toThrow("reflection failed");
    expect(() => removeMotionRelationActionDefinition(unobservedSource, { id: "accent-action", extra: true })).toThrow("bounded plain object");
    expect(sourceReads).toBe(0);
    expect(() => applyMotionRelationAction(unobservedSource, { ...envelope({ anchor: "anchor" }, {}), startAtUs: 1 })).toThrow("whole-millisecond");
    expect(sourceReads).toBe(0);
    expect(() => applyMotionRelationAction(unobservedSource, envelope({ anchor: "anchor" }, {}))).toThrow("source observed");
    expect(sourceReads).toBeGreaterThan(0);
  });

  it("does not freeze or alias caller-owned Motion descendants and rejects semantic materialization no-ops", () => {
    const source = motion(), sourceBefore = canonicalJson(source);
    const upserted = upsertMotionRelationActionDefinition(source, { definition: definition() });
    expect(canonicalJson(source)).toBe(sourceBefore);
    for (const value of [source.layers, source.layers[0], source.assets, source.provenance, upserted.motion.layers, upserted.motion.layers[0], upserted.motion.assets, upserted.motion.provenance]) expect(Object.isFrozen(value)).toBe(false);
    source.layers[0]!.name = "owner-edit"; source.assets.push({ id: "owner-asset", type: "image", path: "owner.png" } as any); source.provenance.createdBy = "owner";
    expect(upserted.motion.layers[0]!.name).toBeUndefined(); expect(upserted.motion.assets).toHaveLength(0); expect(upserted.motion.provenance.createdBy).toBe("test");
    upserted.motion.layers[0]!.name = "revision-edit"; upserted.motion.assets.push({ id: "revision-asset", type: "image", path: "revision.png" } as any); upserted.motion.provenance.createdBy = "revision";
    expect(source.layers[0]!.name).toBe("owner-edit"); expect(source.assets).toHaveLength(1); expect(source.provenance.createdBy).toBe("owner");
    const removed = removeMotionRelationActionDefinition(upserted.motion, { id: "accent-action" });
    for (const value of [source.layers, source.layers[0], source.assets, source.provenance, removed.motion.layers, removed.motion.layers[0], removed.motion.assets, removed.motion.provenance]) expect(Object.isFrozen(value)).toBe(false);
    removed.motion.layers[0]!.name = "removed-edit"; removed.motion.assets.push({ id: "removed-asset", type: "image", path: "removed.png" } as any); removed.motion.provenance.createdBy = "removed";
    expect(upserted.motion.layers[0]!.name).toBe("revision-edit"); expect(upserted.motion.assets).toHaveLength(1); expect(upserted.motion.provenance.createdBy).toBe("revision");
    const applySource = upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const applied = applyMotionRelationAction(applySource, applyRequest(applySource));
    for (const value of [applySource.layers, applySource.layers[0], applySource.assets, applySource.provenance]) expect(Object.isFrozen(value)).toBe(false);
    applied.motion.layers.find((layer) => layer.id === "anchor")!.name = "applied-edit"; applied.motion.assets.push({ id: "applied-asset", type: "image", path: "applied.png" } as any); applied.motion.provenance.createdBy = "applied";
    expect(applySource.layers[0]!.name).toBeUndefined(); expect(applySource.assets).toHaveLength(0); expect(applySource.provenance.createdBy).toBe("test");
    const noOp = structuredClone(definition()) as any; noOp.templateLayers = []; noOp.relationTemplates = []; noOp.sequence = [{ id: "same", kind: "keyframe", atUs: 0, target: role("anchor"), property: "opacity", value: literal(1) }];
    const noOpSource = motion(); noOpSource.layers[0]!.keyframes = { opacity: [{ atMs: 1_000, value: 1 }] };
    const noOpStored = upsertMotionRelationActionDefinition(noOpSource, { definition: noOp }).motion, noOpBefore = canonicalJson(noOpStored);
    expect(() => applyMotionRelationAction(noOpStored, applyRequest(noOpStored))).toThrow("did not materialize"); expect(canonicalJson(noOpStored)).toBe(noOpBefore);
    const compositingNoOpSource = motion(); compositingNoOpSource.layers[0]!.keyframes = { opacity: [{ atMs: 1_000, value: 1 }] };
    compositingNoOpSource.compositing = {
      schema: "shellx-motion/compositing-graph@1", id: "no-op-graph",
      nodes: [{ id: "source", type: "source", layerId: "anchor" }, { id: "output", type: "output" }],
      edges: [{ id: "out", from: { nodeId: "source", port: "output" }, to: { nodeId: "output", port: "input" } }],
    };
    const compositingNoOpStored = upsertMotionRelationActionDefinition(compositingNoOpSource, { definition: noOp }).motion, compositingNoOpBefore = canonicalJson(compositingNoOpStored);
    expect(() => applyMotionRelationAction(compositingNoOpStored, applyRequest(compositingNoOpStored))).toThrow("did not materialize");
    expect(canonicalJson(compositingNoOpStored)).toBe(compositingNoOpBefore);
  });

  it("validates persisted/output documents and keeps numeric public-schema bounds in parity", () => {
    const stored = upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    expect(validateDocumentSync(loadSchemaSync("motion"), stored)).toEqual({ ok: true });
    const before = canonicalJson(stored);
    expect(() => upsertMotionRelationActionDefinition(stored, { definition: definition() })).toThrow("did not change");
    expect(canonicalJson(stored)).toBe(before);
    const invalid = structuredClone(motion()); const broad = definition(); broad.parameters[0]!.maximum = 3_600_000_001;
    invalid.relationActions = { schema: "shellx-motion/relation-actions@2", definitions: [broad] } as any;
    expect(validateDocumentSync(loadSchemaSync("motion"), invalid)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ path: "/relationActions", message: expect.stringContaining("bounded finite") })]) });
    const schema = buildMotionPublicSchema() as any;
    expect(schema.$defs.motionRelationActionParameter.oneOf[0].properties.maximum).toMatchObject({ minimum: -3_600_000_000, maximum: 3_600_000_000 });
  });

  it("enforces caps and deterministic layer/relation collision refusal before a source changes", () => {
    expect(() => assertMotionRelationActionApplyCaps({ objects: 32, relations: 16, keyframeWrites: 128 })).not.toThrow();
    expect(() => assertMotionRelationActionApplyCaps({ objects: 33, relations: 16, keyframeWrites: 128 })).toThrow("32 created");
    expect(() => assertMotionRelationActionApplyCaps({ objects: 32, relations: 17, keyframeWrites: 128 })).toThrow("16 concrete");
    expect(() => assertMotionRelationActionApplyCaps({ objects: 32, relations: 16, keyframeWrites: 129 })).toThrow("128 generated");
    const source = motion(), before = canonicalJson(source);
    const objects = definition(); objects.templateLayers = Array.from({ length: 33 }, (_, index) => ({ ...objects.templateLayers[0]!, id: `layer-${String(index).padStart(2, "0")}` }));
    expect(() => upsertMotionRelationActionDefinition(source, { definition: objects })).toThrow("at most 32");
    const relations = definition(); relations.relationTemplates = Array.from({ length: 17 }, (_, index) => ({ ...relations.relationTemplates[0]!, id: `relation-${String(index).padStart(2, "0")}` }));
    expect(() => upsertMotionRelationActionDefinition(source, { definition: relations })).toThrow("at most 16");
    expect(canonicalJson(source)).toBe(before);
    const atCap = structuredClone(definition()) as any;
    atCap.templateLayers = Array.from({ length: 32 }, (_, index) => ({ id: `layer-${String(index).padStart(2, "0")}`, layer: { ...atCap.templateLayers[0]!.layer } }));
    atCap.relationTemplates = Array.from({ length: 16 }, (_, index) => ({ ...atCap.relationTemplates[0]!, id: `relation-${String(index).padStart(2, "0")}`, target: { ...atCap.relationTemplates[0]!.target, layer: template(`layer-${String(index).padStart(2, "0")}`) } }));
    atCap.sequence = [
      ...Array.from({ length: 16 }, (_, index) => ({ id: `key-${String(index).padStart(2, "0")}`, kind: "keyframe", atUs: 0, target: template(`layer-${String(index).padStart(2, "0")}`), property: "style.fill", value: color("#44AAFF") })),
      ...Array.from({ length: 16 }, (_, index) => ({ id: `relation-${String(index).padStart(2, "0")}`, kind: "relation", atUs: 0, relationTemplateId: `relation-${String(index).padStart(2, "0")}` })),
    ];
    const capStored = upsertMotionRelationActionDefinition(motion(), { definition: atCap }).motion, capBefore = canonicalJson(capStored);
    const capResult = applyMotionRelationAction(capStored, applyRequest(capStored));
    expect(capResult.plan.counts).toEqual({ objects: 32, relations: 16, keyframeWrites: 16 }); expect(canonicalJson(capStored)).toBe(capBefore);
    const stored = upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const applied = applyMotionRelationAction(stored, applyRequest(stored));
    const layerCollision = structuredClone(stored); layerCollision.layers.push({ id: applied.createdObjectIds[0]!, type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000 });
    const layerBefore = canonicalJson(layerCollision);
    expect(() => applyMotionRelationAction(layerCollision, applyRequest(layerCollision))).toThrow("collides with existing layer"); expect(canonicalJson(layerCollision)).toBe(layerBefore);
    const relationCollision = structuredClone(stored);
    relationCollision.layers.push({ id: "other", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000 });
    relationCollision.relations = { schema: "shellx-motion/relations@1", bindings: [binding(applied.relationIds[0]!, "anchor", "other")] };
    const relationBefore = canonicalJson(relationCollision);
    expect(() => applyMotionRelationAction(relationCollision, applyRequest(relationCollision))).toThrow("collides with existing relation"); expect(canonicalJson(relationCollision)).toBe(relationBefore);
  });

  it("refuses empty/non-ms instances, locked tracks, and graph authority conflicts without mutation", () => {
    const empty = definition(); empty.templateLayers = []; empty.relationTemplates = []; empty.sequence = [];
    const emptyStored = upsertMotionRelationActionDefinition(motion(), { definition: empty }).motion, emptyBefore = canonicalJson(emptyStored);
    expect(() => applyMotionRelationAction(emptyStored, { ...applyRequest(emptyStored), startAtUs: 1 })).toThrow("apply.startAtUs");
    expect(() => applyMotionRelationAction(emptyStored, applyRequest(emptyStored))).toThrow("at least one ordinary change"); expect(canonicalJson(emptyStored)).toBe(emptyBefore);
    const stored = upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const ownerLocked = structuredClone(stored); ownerLocked.layers[0]!.trackId = "owner"; ownerLocked.tracks = [{ id: "owner", type: "overlay", locked: true }];
    expect(() => applyMotionRelationAction(ownerLocked, applyRequest(ownerLocked))).toThrow("locked track: owner");
    const referenceLocked = structuredClone(stored); referenceLocked.tracks = [{ id: "reference", type: "overlay", locked: true, layerIds: ["anchor"] }];
    expect(() => applyMotionRelationAction(referenceLocked, applyRequest(referenceLocked))).toThrow("locked track: reference");
    const transformAction = structuredClone(definition()) as any; transformAction.relationTemplates = []; transformAction.sequence = [{ id: "move", kind: "keyframe", atUs: 0, target: role("anchor"), property: "transform.x", value: literal(10) }];
    const behaviorSource = upsertMotionBehavior(motion(), { binding: { targetLayerId: "anchor", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } } }).motion;
    const behaviorStored = upsertMotionRelationActionDefinition(behaviorSource, { definition: transformAction }).motion, behaviorBefore = canonicalJson(behaviorStored);
    expect(() => applyMotionRelationAction(behaviorStored, applyRequest(behaviorStored))).toThrow("behavior"); expect(canonicalJson(behaviorStored)).toBe(behaviorBefore);
    const proceduralSource = structuredClone(motion());
    proceduralSource.relationships = { schema: "shellx-motion/procedural-relationships@1", relationships: [{ id: "drive", enabled: true, target: { layerId: "anchor", property: "transform.x" }, nodes: [{ id: "constant", type: "constant", value: 1 }], outputNodeId: "constant" }] } as any;
    expect(validateDocumentSync(loadSchemaSync("motion"), proceduralSource)).toEqual({ ok: true });
    const proceduralStored = upsertMotionRelationActionDefinition(proceduralSource, { definition: transformAction }).motion, proceduralBefore = canonicalJson(proceduralStored);
    expect(() => applyMotionRelationAction(proceduralStored, applyRequest(proceduralStored))).toThrow("procedural"); expect(canonicalJson(proceduralStored)).toBe(proceduralBefore);
    const relationAction = structuredClone(definition()) as any;
    relationAction.roles = [{ id: "anchor", kind: "layer", layerTypes: ["shape"] }, { id: "subject", kind: "layer", layerTypes: ["shape"] }];
    relationAction.relationTemplates[0].target.layer = role("subject");
    const relationSource = () => {
      const value = motion();
      value.layers.push({ id: "subject", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000 });
      value.layers.push({ id: "other", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000 });
      return value;
    };
    const targetConflict = relationSource(); targetConflict.relations = { schema: "shellx-motion/relations@1", bindings: [binding("existing", "other", "subject")] };
    const targetStored = upsertMotionRelationActionDefinition(targetConflict, { definition: relationAction }).motion, targetBefore = canonicalJson(targetStored);
    expect(() => applyMotionRelationAction(targetStored, { ...applyRequest(targetStored), roleBindings: { anchor: "anchor", subject: "subject" } })).toThrow("transform authority"); expect(canonicalJson(targetStored)).toBe(targetBefore);
    const dagConflict = relationSource(); dagConflict.relations = { schema: "shellx-motion/relations@1", bindings: [binding("existing", "subject", "anchor")] };
    const dagStored = upsertMotionRelationActionDefinition(dagConflict, { definition: relationAction }).motion, dagBefore = canonicalJson(dagStored);
    expect(() => applyMotionRelationAction(dagStored, { ...applyRequest(dagStored), roleBindings: { anchor: "anchor", subject: "subject" } })).toThrow("acyclic"); expect(canonicalJson(dagStored)).toBe(dagBefore);
  });
});

function binding(id: string, source: string, target: string) {
  return { id, enabled: true, kind: "attach" as const, source: { layerId: source, anchor: { x: 0, y: 0 } }, target: { layerId: target, anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 1_000_000, mode: "follow" as const, offset: { space: "world" as const, x: 0, y: 0, rotationDeg: 0, scale: 1 } };
}
