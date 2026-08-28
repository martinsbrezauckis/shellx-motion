import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import {
  compileMotionRelationActionMaterializationPlan,
  readMotionRelationActionStore,
  snapshotMotionRelationActionData,
} from "./motion-relation-actions";

function literal(value: number) { return { source: "literal", value }; }
function parameter(parameterId: string) { return { source: "parameter", parameterId }; }
function ref(templateLayerId: string) { return { source: "template", templateLayerId }; }
function role(roleId: string) { return { source: "role", roleId }; }

function store() {
  return {
    schema: "shellx-motion/relation-actions@1",
    definitions: [{
      id: "accent-action",
      roles: [
        { id: "anchor", kind: "layer", layerTypes: ["shape"] },
        { id: "subject", kind: "layer", layerTypes: ["shape"] },
      ],
      parameters: [
        { id: "duration", type: "number", minimum: 100, maximum: 1_000_000, defaultValue: 500 },
        { id: "tint", type: "color", defaultValue: "#123ABC" },
      ],
      templateLayers: [
        { id: "accent", layerType: "shape", parent: ref("container") },
        { id: "container", layerType: "group" },
      ],
      relationTemplates: [{
        id: "follow-anchor", enabled: true, kind: "attach", source: { layer: role("anchor"), anchorX: literal(0), anchorY: literal(0) },
        target: { layer: ref("accent"), anchorX: literal(0), anchorY: literal(0) }, startUs: 50, durationUs: parameter("duration"), mode: "follow",
        offset: { space: "source", x: literal(0), y: literal(0), rotationDeg: literal(0), scale: literal(1) },
      }],
      sequence: [
        { id: "color", kind: "keyframe", atUs: 0, target: ref("accent"), property: "style.fill", value: parameter("tint"), easing: "ease-out" },
        { id: "fade", kind: "keyframe", atUs: 100, target: role("subject"), property: "opacity", value: literal(0.5) },
        { id: "relate", kind: "relation", atUs: 200, relationTemplateId: "follow-anchor" },
        { id: "transition", kind: "transition", atUs: 300, target: ref("accent"), presetId: "soft-fade", durationUs: parameter("duration") },
      ],
    }],
  };
}
function request(source = store()) {
  const definition = readMotionRelationActionStore(source).definitions[0]!;
  return {
    definitionId: definition.id, expectedDefinitionSha256: canonicalJsonSha256(definition), instanceId: "instance-01", startAtUs: 1_000,
    roleBindings: { anchor: "anchor-layer", subject: "subject-layer" }, parameterValues: { duration: 750, tint: "#ABC123" },
  };
}
function context() { return { existingLayers: [{ id: "anchor-layer", type: "shape" }, { id: "subject-layer", type: "shape" }] }; }

describe("private reusable relation-action blueprints", () => {
  it("reads bounded descriptor data before admission", () => {
    let ownKeys = 0, descriptors = 0, gets = 0;
    const hostile = new Proxy({}, {
      ownKeys: () => { ownKeys += 1; return Array.from({ length: 10_000 }, (_, index) => `bad${index}`); },
      getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; }, get: () => { gets += 1; return undefined; },
    });
    expect(() => snapshotMotionRelationActionData(hostile)).toThrow("16-field record limit");
    expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 1, descriptors: 0, gets: 0 });
    const accessor: Record<string, unknown> = { schema: "shellx-motion/relation-actions@1", definitions: [] };
    let reads = 0; Object.defineProperty(accessor, "definitions", { enumerable: true, get() { reads += 1; return []; } });
    expect(() => readMotionRelationActionStore(accessor)).toThrow("enumerable data field");
    expect(reads).toBe(0);
    let keyDescriptors = 0, keyGets = 0;
    const keyHeavy = new Proxy({}, {
      ownKeys: () => Array.from({ length: 16 }, (_, index) => `${"field".repeat(2_000)}${index}`),
      getOwnPropertyDescriptor: () => { keyDescriptors += 1; return undefined; }, get: () => { keyGets += 1; return undefined; },
    });
    expect(() => snapshotMotionRelationActionData(keyHeavy)).toThrow("store limit");
    expect({ keyDescriptors, keyGets }).toEqual({ keyDescriptors: 0, keyGets: 0 });
  });

  it("enforces the definition and nested authoring caps", () => {
    const capped = store(); capped.definitions = Array.from({ length: 17 }, (_, index) => ({ id: `action-${String(index).padStart(2, "0")}`, roles: [], parameters: [], templateLayers: [], relationTemplates: [], sequence: [] }));
    expect(() => readMotionRelationActionStore(capped)).toThrow("at most 16");
    const layers = { schema: "shellx-motion/relation-actions@1", definitions: [{ id: "layer-cap", roles: [], parameters: [], templateLayers: Array.from({ length: 33 }, (_, index) => ({ id: `layer-${String(index).padStart(2, "0")}`, layerType: "shape" })), relationTemplates: [], sequence: [] }] };
    expect(() => readMotionRelationActionStore(layers)).toThrow("at most 32");
    const tooLarge = store(); tooLarge.definitions[0]!.parameters[1]!.defaultValue = `#${"a".repeat(131_072)}`;
    expect(() => readMotionRelationActionStore(tooLarge)).toThrow("store limit");
  });

  it("rejects template-parent cycles, unknown substitutions, and non-data escape hatches", () => {
    const cyclic = store(); cyclic.definitions[0]!.templateLayers[1]!.parent = ref("container");
    expect(() => readMotionRelationActionStore(cyclic)).toThrow("acyclic");
    const unknown = store(); (unknown.definitions[0]!.sequence as { value?: unknown }[])[0]!.value = parameter("missing");
    expect(() => readMotionRelationActionStore(unknown)).toThrow("known color parameter");
    const escaped = store(); (escaped.definitions[0]!.templateLayers[0] as Record<string, unknown>).expression = "fetch('https://example.invalid')";
    expect(() => readMotionRelationActionStore(escaped)).toThrow("unknown field 'expression'");
  });

  it("produces stable ordinary operation plans without mutating a definition or Motion", () => {
    const source = store(), before = canonicalJson(source), result = compileMotionRelationActionMaterializationPlan(source, request(source), context());
    expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    expect(canonicalJson(source)).toBe(before);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(result.plan.operations.map((operation) => operation.kind)).toEqual(["group.create", "layer.create", "keyframe.upsert", "keyframe.upsert", "relation.upsert", "transition.apply"]);
    expect(result.plan.operations.filter((operation) => operation.kind === "keyframe.upsert")).toEqual(expect.arrayContaining([expect.objectContaining({ atUs: 1_000, value: "#abc123" }), expect.objectContaining({ atUs: 1_100, value: 0.5 })]));
    const relation = result.plan.operations.find((operation) => operation.kind === "relation.upsert");
    expect(relation).toMatchObject({ atUs: 1_250, binding: { kind: "attach", source: { layerId: "anchor-layer" }, durationUs: 750 } });
    expect(JSON.stringify(result.plan.operations)).not.toMatch(/package\.write|renderer\.execute/);
    const replay = compileMotionRelationActionMaterializationPlan(structuredClone(source), request(source), context());
    expect(replay).toEqual(result);
  });

  it("refuses unknown actions, stale action identities, stale role bindings, and wrong typed parameters", () => {
    const source = store(), input = request(source);
    expect(compileMotionRelationActionMaterializationPlan(source, { ...input, definitionId: "missing" }, context())).toMatchObject({ ok: false, message: expect.stringContaining("Unknown relation action") });
    expect(compileMotionRelationActionMaterializationPlan(source, { ...input, expectedDefinitionSha256: "0".repeat(64) }, context())).toMatchObject({ ok: false, message: expect.stringContaining("stale definition identity") });
    expect(compileMotionRelationActionMaterializationPlan(source, { ...input, roleBindings: { ...input.roleBindings, subject: "deleted-layer" } }, context())).toMatchObject({ ok: false, message: expect.stringContaining("stale role binding") });
    expect(compileMotionRelationActionMaterializationPlan(source, { ...input, parameterValues: { ...input.parameterValues, tint: 5 } }, context())).toMatchObject({ ok: false, message: expect.stringContaining("#RRGGBB") });
  });

  it("keeps previously materialized instances detached when definitions are revised", () => {
    const original = store(), oldRequest = request(original), first = compileMotionRelationActionMaterializationPlan(original, oldRequest, context());
    expect(first).toMatchObject({ ok: true }); if (!first.ok) return;
    const revised = structuredClone(original); revised.definitions[0]!.parameters[1]!.defaultValue = "#ABCDEF";
    expect(compileMotionRelationActionMaterializationPlan(revised, oldRequest, context())).toMatchObject({ ok: false, message: expect.stringContaining("stale definition identity") });
    expect(first.plan.operations.find((operation) => operation.kind === "keyframe.upsert")).toMatchObject({ value: "#abc123" });
  });
});
