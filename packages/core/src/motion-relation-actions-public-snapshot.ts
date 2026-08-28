import {
  MAX_MOTION_RELATION_ACTION_DEFINITIONS,
  MAX_MOTION_RELATION_ACTION_PARAMETERS,
  MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES,
  MAX_MOTION_RELATION_ACTION_ROLES,
  MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS,
  MAX_MOTION_RELATION_ACTION_STORE_BYTES,
  MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS,
} from "./motion-relation-actions-public-types";

type State = { active: WeakSet<object>; nodes: number; keys: number; bytes: number };

/**
 * Snapshots the public @2 envelope without letting the generic @1 snapshot spend work above the
 * public caps. Every bounded array reads its length descriptor before ownKeys or element fields.
 */
export function snapshotPublicMotionRelationActionStore(value: unknown): Record<string, unknown> {
  const state = freshState();
  const root = exactRecord(value, ["schema", "definitions"], [], "Relation actions", state);
  return {
    schema: snapshotScalar(root.schema, state, "Relation actions.schema"),
    definitions: snapshotDefinitions(root.definitions, state),
  };
}

/** Descriptor-safe one-definition envelope used by public upsert before its template cap is read. */
export function snapshotPublicMotionRelationActionDefinitionUpsert(value: unknown): Record<string, unknown> {
  const state = freshState();
  const root = exactRecord(value, ["definition"], [], "Relation action definition upsert", state);
  return { definition: snapshotDefinition(root.definition, state) };
}

/** Exact transient apply envelope; maps are capped before their own field descriptors are read. */
export function snapshotPublicMotionRelationActionApply(value: unknown): Record<string, unknown> {
  const state = freshState();
  const root = exactRecord(value, [
    "definitionId", "expectedMotionSha256", "expectedStoreSha256", "expectedDefinitionSha256",
    "instanceId", "startAtUs", "roleBindings",
  ], ["parameterValues"], "Relation action apply", state);
  return {
    definitionId: snapshotScalar(root.definitionId, state, "Relation action apply.definitionId"),
    expectedMotionSha256: snapshotScalar(root.expectedMotionSha256, state, "Relation action apply.expectedMotionSha256"),
    expectedStoreSha256: snapshotScalar(root.expectedStoreSha256, state, "Relation action apply.expectedStoreSha256"),
    expectedDefinitionSha256: snapshotScalar(root.expectedDefinitionSha256, state, "Relation action apply.expectedDefinitionSha256"),
    instanceId: snapshotScalar(root.instanceId, state, "Relation action apply.instanceId"),
    startAtUs: snapshotScalar(root.startAtUs, state, "Relation action apply.startAtUs"),
    roleBindings: snapshotMap(root.roleBindings, 16, "Relation action apply.roleBindings", state),
    ...(root.parameterValues === undefined ? {} : { parameterValues: snapshotMap(root.parameterValues, 16, "Relation action apply.parameterValues", state) }),
  };
}

/** Exact transient remove envelope. It avoids generic snapshot work for one required id. */
export function snapshotPublicMotionRelationActionDefinitionRemove(value: unknown): Record<string, unknown> {
  const state = freshState(), root = exactRecord(value, ["id"], [], "Relation action definition remove", state);
  return { id: snapshotScalar(root.id, state, "Relation action definition remove.id") };
}

function freshState(): State { return { active: new WeakSet<object>(), nodes: 0, keys: 0, bytes: 0 }; }
function snapshotDefinitions(value: unknown, state: State): unknown[] {
  return snapshotArray(value, MAX_MOTION_RELATION_ACTION_DEFINITIONS, "Relation actions definitions", state, (entry) => snapshotDefinition(entry, state));
}
function snapshotDefinition(value: unknown, state: State): Record<string, unknown> {
  const label = "Relation action definition";
  const record = exactRecord(value, ["id", "roles", "parameters", "templateLayers", "relationTemplates", "sequence"], [], label, state);
  return {
    id: snapshotScalar(record.id, state, `${label}.id`),
    roles: snapshotArray(record.roles, MAX_MOTION_RELATION_ACTION_ROLES, `${label}.roles`, state, (entry) => snapshotRole(entry, state)),
    parameters: snapshotArray(record.parameters, MAX_MOTION_RELATION_ACTION_PARAMETERS, `${label}.parameters`, state, (entry) => snapshotParameter(entry, state)),
    templateLayers: snapshotArray(record.templateLayers, MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS, `${label}.templateLayers`, state, (entry) => snapshotTemplateLayer(entry, state)),
    relationTemplates: snapshotArray(record.relationTemplates, MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES, `${label}.relationTemplates`, state, (entry) => snapshotRelation(entry, state)),
    sequence: snapshotArray(record.sequence, MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS, `${label}.sequence`, state, (entry) => snapshotStep(entry, state)),
  };
}
function snapshotRole(value: unknown, state: State): Record<string, unknown> {
  const kind = branchTag(value, "Relation action role", "kind");
  if (kind === "group") {
    const exact = exactRecord(value, ["id", "kind"], [], "Relation action role", state);
    return { id: snapshotScalar(exact.id, state, "Relation action role.id"), kind: snapshotScalar(exact.kind, state, "Relation action role.kind") };
  }
  if (kind !== "layer") throw new Error("Relation action role.kind must equal layer or group.");
  const exact = exactRecord(value, ["id", "kind", "layerTypes"], [], "Relation action role", state);
  return {
    id: snapshotScalar(exact.id, state, "Relation action role.id"), kind: snapshotScalar(exact.kind, state, "Relation action role.kind"),
    layerTypes: snapshotArray(exact.layerTypes, 8, "Relation action role.layerTypes", state, (entry) => snapshotScalar(entry, state, "Relation action role.layerTypes entry")),
  };
}
function snapshotParameter(value: unknown, state: State): Record<string, unknown> {
  const type = branchTag(value, "Relation action parameter", "type");
  if (type === "color") {
    const exact = exactRecord(value, ["id", "type", "defaultValue"], [], "Relation action parameter", state);
    return { id: snapshotScalar(exact.id, state, "Relation action parameter.id"), type: snapshotScalar(exact.type, state, "Relation action parameter.type"), defaultValue: snapshotScalar(exact.defaultValue, state, "Relation action parameter.defaultValue") };
  }
  if (type !== "number") throw new Error("Relation action parameter.type must equal number or color.");
  const exact = exactRecord(value, ["id", "type", "minimum", "maximum", "defaultValue"], [], "Relation action parameter", state);
  return { id: snapshotScalar(exact.id, state, "Relation action parameter.id"), type: snapshotScalar(exact.type, state, "Relation action parameter.type"), minimum: snapshotScalar(exact.minimum, state, "Relation action parameter.minimum"), maximum: snapshotScalar(exact.maximum, state, "Relation action parameter.maximum"), defaultValue: snapshotScalar(exact.defaultValue, state, "Relation action parameter.defaultValue") };
}
function snapshotTemplateLayer(value: unknown, state: State): Record<string, unknown> {
  const record = exactRecord(value, ["id", "layer"], ["parent"], "Relation action template layer", state);
  return {
    id: snapshotScalar(record.id, state, "Relation action template layer.id"),
    layer: snapshotLayerPrototype(record.layer, state),
    ...(record.parent === undefined ? {} : { parent: snapshotLayerRef(record.parent, state) }),
  };
}
function snapshotLayerPrototype(value: unknown, state: State): Record<string, unknown> {
  const type = branchTag(value, "Relation action layer", "type");
  if (type === "shape") {
    const exact = exactRecord(value, ["schema", "type", "startUs", "durationUs", "shape", "fill"], ["name", "visible", "transform", "stroke", "strokeWidth"], "Relation action layer", state);
    return layerBase(exact, state, { shape: snapshotScalar(exact.shape, state, "Relation action layer.shape"), fill: snapshotScalar(exact.fill, state, "Relation action layer.fill"), ...(exact.stroke === undefined ? {} : { stroke: snapshotScalar(exact.stroke, state, "Relation action layer.stroke") }), ...(exact.strokeWidth === undefined ? {} : { strokeWidth: snapshotScalar(exact.strokeWidth, state, "Relation action layer.strokeWidth") }) });
  }
  if (type !== "group") throw new Error("Relation action layer.type must equal shape or group.");
  const exact = exactRecord(value, ["schema", "type", "startUs", "durationUs"], ["name", "visible", "transform"], "Relation action layer", state);
  return layerBase(exact, state, {});
}
function layerBase(record: Record<string, unknown>, state: State, extra: Record<string, unknown>): Record<string, unknown> {
  return { schema: snapshotScalar(record.schema, state, "Relation action layer.schema"), type: snapshotScalar(record.type, state, "Relation action layer.type"), startUs: snapshotScalar(record.startUs, state, "Relation action layer.startUs"), durationUs: snapshotScalar(record.durationUs, state, "Relation action layer.durationUs"), ...(record.name === undefined ? {} : { name: snapshotScalar(record.name, state, "Relation action layer.name") }), ...(record.visible === undefined ? {} : { visible: snapshotScalar(record.visible, state, "Relation action layer.visible") }), ...(record.transform === undefined ? {} : { transform: snapshotTransform(record.transform, state) }), ...extra };
}
function snapshotTransform(value: unknown, state: State): Record<string, unknown> {
  const allowed = ["x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"], record = exactRecord(value, [], allowed, "Relation action layer.transform", state);
  if (Object.keys(record).length === 0) throw new Error("Relation action layer.transform must contain at least one closed transform field.");
  const result: Record<string, unknown> = {};
  for (const key of allowed) if (record[key] !== undefined) result[key] = snapshotScalar(record[key], state, `Relation action layer.transform.${key}`);
  return result;
}
function snapshotRelation(value: unknown, state: State): Record<string, unknown> {
  const kind = branchTag(value, "Relation action relation", "kind");
  if (kind === "attach") {
    const exact = exactRecord(value, ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], [], "Relation action relation", state);
    return { id: snapshotScalar(exact.id, state, "Relation action relation.id"), enabled: snapshotScalar(exact.enabled, state, "Relation action relation.enabled"), kind: snapshotScalar(exact.kind, state, "Relation action relation.kind"), source: snapshotEndpoint(exact.source, state), target: snapshotEndpoint(exact.target, state), startUs: snapshotScalar(exact.startUs, state, "Relation action relation.startUs"), durationUs: snapshotNumberValue(exact.durationUs, state), mode: snapshotScalar(exact.mode, state, "Relation action relation.mode"), offset: snapshotOffset(exact.offset, state) };
  }
  if (kind !== "aim") throw new Error("Relation action relation.kind must equal attach or aim.");
  const exact = exactRecord(value, ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], [], "Relation action relation", state);
  return { id: snapshotScalar(exact.id, state, "Relation action relation.id"), enabled: snapshotScalar(exact.enabled, state, "Relation action relation.enabled"), kind: snapshotScalar(exact.kind, state, "Relation action relation.kind"), source: snapshotEndpoint(exact.source, state), target: snapshotEndpoint(exact.target, state), startUs: snapshotScalar(exact.startUs, state, "Relation action relation.startUs"), durationUs: snapshotNumberValue(exact.durationUs, state), rotationOffsetDeg: snapshotNumberValue(exact.rotationOffsetDeg, state) };
}
function snapshotEndpoint(value: unknown, state: State): Record<string, unknown> {
  const record = exactRecord(value, ["layer", "anchorX", "anchorY"], [], "Relation action endpoint", state);
  return { layer: snapshotLayerRef(record.layer, state), anchorX: snapshotNumberValue(record.anchorX, state), anchorY: snapshotNumberValue(record.anchorY, state) };
}
function snapshotOffset(value: unknown, state: State): Record<string, unknown> {
  const record = exactRecord(value, ["space", "x", "y", "rotationDeg", "scale"], [], "Relation action offset", state);
  return { space: snapshotScalar(record.space, state, "Relation action offset.space"), x: snapshotNumberValue(record.x, state), y: snapshotNumberValue(record.y, state), rotationDeg: snapshotNumberValue(record.rotationDeg, state), scale: snapshotNumberValue(record.scale, state) };
}
function snapshotLayerRef(value: unknown, state: State): Record<string, unknown> {
  const source = branchTag(value, "Relation action layer ref", "source");
  if (source === "role") { const exact = exactRecord(value, ["source", "roleId"], [], "Relation action layer ref", state); return { source: snapshotScalar(exact.source, state, "Relation action layer ref.source"), roleId: snapshotScalar(exact.roleId, state, "Relation action layer ref.roleId") }; }
  if (source !== "template") throw new Error("Relation action layer ref.source must equal role or template.");
  const exact = exactRecord(value, ["source", "templateLayerId"], [], "Relation action layer ref", state);
  return { source: snapshotScalar(exact.source, state, "Relation action layer ref.source"), templateLayerId: snapshotScalar(exact.templateLayerId, state, "Relation action layer ref.templateLayerId") };
}
function snapshotNumberValue(value: unknown, state: State): Record<string, unknown> {
  const source = branchTag(value, "Relation action number value", "source");
  if (source === "literal") { const exact = exactRecord(value, ["source", "value"], [], "Relation action number value", state); return { source: snapshotScalar(exact.source, state, "Relation action number value.source"), value: snapshotScalar(exact.value, state, "Relation action number value.value") }; }
  if (source !== "parameter") throw new Error("Relation action number value.source must equal literal or parameter.");
  const exact = exactRecord(value, ["source", "parameterId"], [], "Relation action number value", state);
  return { source: snapshotScalar(exact.source, state, "Relation action number value.source"), parameterId: snapshotScalar(exact.parameterId, state, "Relation action number value.parameterId") };
}
function snapshotColorValue(value: unknown, state: State): Record<string, unknown> { return snapshotNumberValue(value, state); }
function snapshotStep(value: unknown, state: State): Record<string, unknown> {
  const kind = branchTag(value, "Relation action sequence step", "kind");
  if (kind === "keyframe") {
    const exact = exactRecord(value, ["id", "kind", "atUs", "target", "property", "value"], ["easing"], "Relation action sequence step", state);
    return { id: snapshotScalar(exact.id, state, "Relation action sequence step.id"), kind: snapshotScalar(exact.kind, state, "Relation action sequence step.kind"), atUs: snapshotScalar(exact.atUs, state, "Relation action sequence step.atUs"), target: snapshotLayerRef(exact.target, state), property: snapshotScalar(exact.property, state, "Relation action sequence step.property"), value: snapshotColorValue(exact.value, state), ...(exact.easing === undefined ? {} : { easing: snapshotScalar(exact.easing, state, "Relation action sequence step.easing") }) };
  }
  if (kind === "transition") {
    const exact = exactRecord(value, ["id", "kind", "atUs", "target", "presetId", "durationUs"], [], "Relation action sequence step", state);
    return { id: snapshotScalar(exact.id, state, "Relation action sequence step.id"), kind: snapshotScalar(exact.kind, state, "Relation action sequence step.kind"), atUs: snapshotScalar(exact.atUs, state, "Relation action sequence step.atUs"), target: snapshotLayerRef(exact.target, state), presetId: snapshotScalar(exact.presetId, state, "Relation action sequence step.presetId"), durationUs: snapshotNumberValue(exact.durationUs, state) };
  }
  if (kind !== "relation") throw new Error("Relation action sequence step.kind must equal keyframe, transition, or relation.");
  const exact = exactRecord(value, ["id", "kind", "atUs", "relationTemplateId"], [], "Relation action sequence step", state);
  return { id: snapshotScalar(exact.id, state, "Relation action sequence step.id"), kind: snapshotScalar(exact.kind, state, "Relation action sequence step.kind"), atUs: snapshotScalar(exact.atUs, state, "Relation action sequence step.atUs"), relationTemplateId: snapshotScalar(exact.relationTemplateId, state, "Relation action sequence step.relationTemplateId") };
}
function snapshotMap(value: unknown, maximum: number, label: string, state: State): Record<string, unknown> {
  const record = readRecord(value, label, maximum, state), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) result[key] = snapshotScalar(entry, state, `${label}.${key}`);
  return result;
}
function snapshotArray(value: unknown, maximum: number, label: string, state: State, entry: (value: unknown) => unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a dense array with at most ${maximum} entries.`);
  const length = descriptor(value, "length", label);
  if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum) {
    throw new Error(`${label} must be a dense array with at most ${maximum} entries.`);
  }
  const keys = ownKeys(value, label);
  if (keys.length !== length.value + 1 || !keys.includes("length") || keys.some((key) => typeof key !== "string")) throw new Error(`${label} must be a dense array with at most ${maximum} entries.`);
  if (state.keys + keys.length > 16_384) throw new Error("Relation actions exceed aggregate limits.");
  state.keys += keys.length;
  reserve(state, 2 + Math.max(0, length.value - 1));
  enter(value, state, label);
  try {
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const key = String(index), field = descriptor(value, key, label);
      if (!keys.includes(key) || !("value" in field) || !field.enumerable) throw new Error(`${label} must be a dense array with at most ${maximum} entries.`);
      result.push(entry(field.value));
    }
    return result;
  } finally { state.active.delete(value); }
}
function snapshotScalar(value: unknown, state: State, label: string): unknown {
  if (value === null) { reserve(state, 4); return null; }
  if (typeof value === "boolean") { reserve(state, 5); return value; }
  if (typeof value === "number") { reserve(state, 32); return value; }
  if (typeof value === "string") { reserve(state, quotedBytes(value)); return value; }
  throw new Error(`${label} must be a JSON scalar.`);
}
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string, state: State): Record<string, unknown> {
  const allowed = new Set([...required, ...optional]);
  return readRecord(value, label, allowed.size, state, allowed, required);
}
/**
 * Read a closed-union discriminator before enumerating the branch object. This is deliberately
 * narrower than readRecord: branch-specific field limits are selected before any ownKeys or
 * non-discriminator descriptor work can be induced by hostile input.
 */
function branchTag(value: unknown, label: string, fieldName: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype = objectPrototype(value, label);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a bounded plain object.`);
  const field = descriptor(value, fieldName, label);
  if (!("value" in field) || !field.enumerable) throw new Error(`${label}.${fieldName} must be an enumerable data field.`);
  return field.value;
}
function readRecord(value: unknown, label: string, maximum: number, state: State, allowed?: ReadonlySet<string>, required?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype = objectPrototype(value, label), keys = ownKeys(value, label);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length > maximum || keys.some((key) => typeof key !== "string")) throw new Error(`${label} must be a bounded plain object.`);
  if (allowed) {
    const names = keys as string[];
    const unknown = names.find((key) => !allowed.has(key));
    if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
    for (const key of required ?? []) if (!names.includes(key)) throw new Error(`${label} requires ${key}.`);
  }
  if (state.keys + keys.length > 16_384) throw new Error("Relation actions exceed aggregate limits.");
  state.keys += keys.length;
  reserve(state, 2 + Math.max(0, keys.length - 1)); enter(value, state, label);
  try {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      reserve(state, quotedBytes(key) + 1);
      const field = descriptor(value, key, label);
      if (!("value" in field) || !field.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
      result[key] = field.value;
    }
    return result;
  } finally { state.active.delete(value); }
}
function enter(value: object, state: State, label: string): void {
  if (state.active.has(value)) throw new Error(`${label} must not contain cycles.`);
  if (state.nodes >= 4_096 || state.keys >= 16_384) throw new Error("Relation actions exceed aggregate limits.");
  state.active.add(value); state.nodes += 1;
}
function ownKeys(value: object, label: string): readonly PropertyKey[] { try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} reflection failed.`); } }
function objectPrototype(value: object, label: string): object | null { try { return Object.getPrototypeOf(value); } catch { throw new Error(`${label} reflection failed.`); } }
function descriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor { try { const result = Object.getOwnPropertyDescriptor(value, key); if (!result) throw new Error("missing"); return result; } catch { throw new Error(`${label} reflection failed.`); } }
function quotedBytes(value: string): number { return 2 + value.length * 6; }
function reserve(state: State, bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes > MAX_MOTION_RELATION_ACTION_STORE_BYTES - bytes) throw new Error(`Relation actions exceed the ${MAX_MOTION_RELATION_ACTION_STORE_BYTES}-byte store limit.`); state.bytes += bytes; }
