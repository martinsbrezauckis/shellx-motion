import { canonicalJson, compareCodeUnits } from "./canonical-json";
import { COLOR_KEYFRAME_TARGETS } from "./keyframe-targets";
import { getTransitionPreset, type TransitionPresetId } from "./transition-presets";
import {
  MAX_MOTION_RELATION_ACTION_DEFINITIONS,
  MAX_MOTION_RELATION_ACTION_LOCAL_US,
  MAX_MOTION_RELATION_ACTION_PARAMETERS,
  MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES,
  MAX_MOTION_RELATION_ACTION_ROLES,
  MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS,
  MAX_MOTION_RELATION_ACTION_STORE_BYTES,
  MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS,
  MOTION_RELATION_ACTIONS_SCHEMA,
  type MotionRelationActionDefinition,
  type MotionRelationActionLayerRef,
  type MotionRelationActionMaterializationContext,
  type MotionRelationActionMaterializationInput,
  type MotionRelationActionNumberValue,
  type MotionRelationActionRelationTemplate,
  type MotionRelationActionRole,
  type MotionRelationActionSequenceStep,
  type MotionRelationActionStore,
} from "./motion-relation-actions-types";
import {
  MOTION_RELATION_ACTION_ROLE_LAYER_TYPES,
  MOTION_RELATION_ACTION_ROLE_LAYER_TYPE_SET,
} from "./motion-relation-action-layer-types";
import type { MotionKeyframeTarget, MotionLayerType } from "./types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const NUMBER_PROPERTIES = new Set<MotionKeyframeTarget>(["transform.x", "transform.y", "transform.width", "transform.height", "transform.originX", "transform.originY", "transform.scale", "transform.rotation", "opacity", "pathReveal.start", "pathReveal.end", "gradient.angle"]);
const MAX_RECORD_KEYS = 16, MAX_ARRAY_ITEMS = 256, MAX_TOTAL_KEYS = 16_384, MAX_NODES = 4_096, MAX_DEPTH = 10;

/** Bounded descriptor-first snapshot; getters, prototypes, symbols, sparse arrays, and cycles refuse. */
export function snapshotMotionRelationActionData(value: unknown): unknown {
  return clone(value, { active: new WeakSet<object>(), nodes: 0, keys: 0, bytes: 0 }, 0);
}

/** Reads an immutable private action-definition store, never a Motion document extension. */
export function readMotionRelationActionStore(value: unknown): MotionRelationActionStore {
  const record = exact(snapshotMotionRelationActionData(value), ["schema", "definitions"], [], "Relation actions");
  if (record.schema !== MOTION_RELATION_ACTIONS_SCHEMA) throw new Error(`Relation actions schema must equal ${MOTION_RELATION_ACTIONS_SCHEMA}.`);
  const definitions = array(record.definitions, "Relation actions definitions", MAX_MOTION_RELATION_ACTION_DEFINITIONS).map(readDefinition);
  sorted(definitions, "Relation actions definitions");
  const store = { schema: MOTION_RELATION_ACTIONS_SCHEMA, definitions } as MotionRelationActionStore;
  if (Buffer.byteLength(canonicalJson(store), "utf8") > MAX_MOTION_RELATION_ACTION_STORE_BYTES) throw new Error(`Relation actions exceed the ${MAX_MOTION_RELATION_ACTION_STORE_BYTES}-byte store limit.`);
  return freeze(store);
}

/** Parses the exact instance request before any definition lookup or context access. */
export function readMotionRelationActionMaterializationInput(value: unknown): MotionRelationActionMaterializationInput {
  const record = exact(snapshotMotionRelationActionData(value), ["definitionId", "expectedDefinitionSha256", "instanceId", "startAtUs", "roleBindings"], ["parameterValues"], "Relation action materialization");
  if (!SHA256.test(string(record.expectedDefinitionSha256, "Relation action materialization.expectedDefinitionSha256"))) throw new Error("Relation action materialization.expectedDefinitionSha256 must be lowercase SHA-256.");
  return {
    definitionId: id(record.definitionId, "Relation action materialization.definitionId"), instanceId: id(record.instanceId, "Relation action materialization.instanceId"),
    expectedDefinitionSha256: record.expectedDefinitionSha256 as string, startAtUs: atUs(record.startAtUs, "Relation action materialization.startAtUs"),
    roleBindings: idMap(record.roleBindings, "Relation action materialization.roleBindings", false),
    parameterValues: parameterMap(record.parameterValues ?? {}, "Relation action materialization.parameterValues"),
  };
}

/** Captures a bounded existing-layer catalog. It does not retain a reference to a live document. */
export function readMotionRelationActionMaterializationContext(value: unknown): MotionRelationActionMaterializationContext {
  const record = exact(snapshotMotionRelationActionData(value), ["existingLayers"], [], "Relation action materialization context");
  const existingLayers = array(record.existingLayers, "Relation action materialization context.existingLayers", MAX_ARRAY_ITEMS).map((entry, index) => {
    const layer = exact(entry, ["id", "type"], [], `Relation action materialization context.existingLayers[${index}]`);
    const type = layer.type as MotionLayerType;
    if (typeof layer.type !== "string" || !MOTION_RELATION_ACTION_ROLE_LAYER_TYPE_SET.has(type)) throw new Error(`Relation action materialization context.existingLayers[${index}].type is not an action-admitted layer type.`);
    return { id: id(layer.id, `Relation action materialization context.existingLayers[${index}].id`), type };
  });
  const unique = new Set(existingLayers.map((layer) => layer.id));
  if (unique.size !== existingLayers.length) throw new Error("Relation action materialization context.existingLayers must have unique ids.");
  return freeze({ existingLayers });
}

function readDefinition(value: unknown, index: number): MotionRelationActionDefinition {
  const label = `Relation actions definitions[${index}]`, record = exact(value, ["id", "roles", "parameters", "templateLayers", "relationTemplates", "sequence"], [], label);
  const definition: MotionRelationActionDefinition = {
    id: id(record.id, `${label}.id`), roles: array(record.roles, `${label}.roles`, MAX_MOTION_RELATION_ACTION_ROLES).map((entry, i) => readRole(entry, `${label}.roles[${i}]`)),
    parameters: array(record.parameters, `${label}.parameters`, MAX_MOTION_RELATION_ACTION_PARAMETERS).map((entry, i) => readParameter(entry, `${label}.parameters[${i}]`)),
    templateLayers: array(record.templateLayers, `${label}.templateLayers`, MAX_MOTION_RELATION_ACTION_TEMPLATE_LAYERS).map((entry, i) => readTemplate(entry, `${label}.templateLayers[${i}]`)),
    relationTemplates: array(record.relationTemplates, `${label}.relationTemplates`, MAX_MOTION_RELATION_ACTION_RELATION_TEMPLATES).map((entry, i) => readRelation(entry, `${label}.relationTemplates[${i}]`)),
    sequence: array(record.sequence, `${label}.sequence`, MAX_MOTION_RELATION_ACTION_SEQUENCE_STEPS).map((entry, i) => readStep(entry, `${label}.sequence[${i}]`)),
  };
  validateDefinition(definition, label); return definition;
}
function readRole(value: unknown, label: string): MotionRelationActionRole {
  const raw = dataRecord(value, label);
  if (raw.kind === "group") return { id: id(exact(raw, ["id", "kind"], [], label).id, `${label}.id`), kind: "group" };
  const record = exact(raw, ["id", "kind", "layerTypes"], [], label);
  if (record.kind !== "layer") throw new Error(`${label}.kind must be layer or group.`);
  const layerTypes = array(record.layerTypes, `${label}.layerTypes`, MOTION_RELATION_ACTION_ROLE_LAYER_TYPES.length).map((type, index) => {
    if (typeof type !== "string" || !MOTION_RELATION_ACTION_ROLE_LAYER_TYPE_SET.has(type as MotionLayerType)) throw new Error(`${label}.layerTypes[${index}] is not action-admitted.`); return type as MotionLayerType;
  });
  if (!layerTypes.length) throw new Error(`${label}.layerTypes must contain at least one type.`); sortedStrings(layerTypes, `${label}.layerTypes`);
  return { id: id(record.id, `${label}.id`), kind: "layer", layerTypes };
}
function readParameter(value: unknown, label: string): MotionRelationActionDefinition["parameters"][number] {
  const raw = dataRecord(value, label);
  if (raw.type === "color") { const record = exact(raw, ["id", "type", "defaultValue"], [], label); return { id: id(record.id, `${label}.id`), type: "color", defaultValue: color(record.defaultValue, `${label}.defaultValue`) }; }
  const record = exact(raw, ["id", "type", "minimum", "maximum", "defaultValue"], [], label);
  if (record.type !== "number") throw new Error(`${label}.type must be number or color.`);
  const minimum = finite(record.minimum, `${label}.minimum`), maximum = finite(record.maximum, `${label}.maximum`), defaultValue = finite(record.defaultValue, `${label}.defaultValue`);
  if (minimum > maximum || defaultValue < minimum || defaultValue > maximum) throw new Error(`${label} requires minimum <= defaultValue <= maximum.`);
  return { id: id(record.id, `${label}.id`), type: "number", minimum, maximum, defaultValue };
}
function readTemplate(value: unknown, label: string) {
  const record = exact(value, ["id", "layerType"], ["parent"], label), layerType = record.layerType as MotionLayerType;
  if (typeof record.layerType !== "string" || !MOTION_RELATION_ACTION_ROLE_LAYER_TYPE_SET.has(layerType)) throw new Error(`${label}.layerType is not action-admitted.`);
  return { id: id(record.id, `${label}.id`), layerType, ...(record.parent === undefined ? {} : { parent: readLayerRef(record.parent, `${label}.parent`) }) };
}
function readRelation(value: unknown, label: string): MotionRelationActionRelationTemplate {
  const raw = dataRecord(value, label);
  if (raw.kind === "attach") {
    const record = exact(raw, ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], [], label);
    if (record.mode !== "follow" && record.mode !== "similarity") throw new Error(`${label}.mode must be follow or similarity.`);
    const offset = exact(record.offset, ["space", "x", "y", "rotationDeg", "scale"], [], `${label}.offset`);
    if (offset.space !== "source" && offset.space !== "world") throw new Error(`${label}.offset.space must be source or world.`);
    return { id: id(record.id, `${label}.id`), enabled: boolean(record.enabled, `${label}.enabled`), kind: "attach", source: readEndpoint(record.source, `${label}.source`), target: readEndpoint(record.target, `${label}.target`), startUs: atUs(record.startUs, `${label}.startUs`), durationUs: numberValue(record.durationUs, `${label}.durationUs`), mode: record.mode, offset: { space: offset.space, x: numberValue(offset.x, `${label}.offset.x`), y: numberValue(offset.y, `${label}.offset.y`), rotationDeg: numberValue(offset.rotationDeg, `${label}.offset.rotationDeg`), scale: numberValue(offset.scale, `${label}.offset.scale`) } };
  }
  const record = exact(raw, ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], [], label);
  if (record.kind !== "aim") throw new Error(`${label}.kind must be attach or aim.`);
  return { id: id(record.id, `${label}.id`), enabled: boolean(record.enabled, `${label}.enabled`), kind: "aim", source: readEndpoint(record.source, `${label}.source`), target: readEndpoint(record.target, `${label}.target`), startUs: atUs(record.startUs, `${label}.startUs`), durationUs: numberValue(record.durationUs, `${label}.durationUs`), rotationOffsetDeg: numberValue(record.rotationOffsetDeg, `${label}.rotationOffsetDeg`) };
}
function readStep(value: unknown, label: string): MotionRelationActionSequenceStep {
  const raw = dataRecord(value, label);
  if (raw.kind === "keyframe") {
    const record = exact(raw, ["id", "kind", "atUs", "target", "property", "value"], ["easing"], label), property = record.property as MotionKeyframeTarget;
    if (typeof record.property !== "string" || (!NUMBER_PROPERTIES.has(property) && !COLOR_KEYFRAME_TARGETS.has(property))) throw new Error(`${label}.property is not action-admitted.`);
    if (record.easing !== undefined && !["linear", "ease-in", "ease-out", "ease-in-out"].includes(record.easing as string)) throw new Error(`${label}.easing is not action-admitted.`);
    return { id: id(record.id, `${label}.id`), kind: "keyframe", atUs: atUs(record.atUs, `${label}.atUs`), target: readLayerRef(record.target, `${label}.target`), property, value: COLOR_KEYFRAME_TARGETS.has(property) ? colorValue(record.value, `${label}.value`) : numberValue(record.value, `${label}.value`), ...(record.easing === undefined ? {} : { easing: record.easing as "linear" | "ease-in" | "ease-out" | "ease-in-out" }) };
  }
  if (raw.kind === "transition") {
    const record = exact(raw, ["id", "kind", "atUs", "target", "presetId", "durationUs"], [], label);
    if (typeof record.presetId !== "string" || !getTransitionPreset(record.presetId)) throw new Error(`${label}.presetId must name a known transition preset.`);
    return { id: id(record.id, `${label}.id`), kind: "transition", atUs: atUs(record.atUs, `${label}.atUs`), target: readLayerRef(record.target, `${label}.target`), presetId: record.presetId as TransitionPresetId, durationUs: numberValue(record.durationUs, `${label}.durationUs`) };
  }
  const record = exact(raw, ["id", "kind", "atUs", "relationTemplateId"], [], label);
  if (record.kind !== "relation") throw new Error(`${label}.kind must be keyframe, transition, or relation.`);
  return { id: id(record.id, `${label}.id`), kind: "relation", atUs: atUs(record.atUs, `${label}.atUs`), relationTemplateId: id(record.relationTemplateId, `${label}.relationTemplateId`) };
}
function readEndpoint(value: unknown, label: string) { const record = exact(value, ["layer", "anchorX", "anchorY"], [], label); return { layer: readLayerRef(record.layer, `${label}.layer`), anchorX: numberValue(record.anchorX, `${label}.anchorX`), anchorY: numberValue(record.anchorY, `${label}.anchorY`) }; }
function readLayerRef(value: unknown, label: string): MotionRelationActionLayerRef { const raw = dataRecord(value, label); if (raw.source === "role") return { source: "role", roleId: id(exact(raw, ["source", "roleId"], [], label).roleId, `${label}.roleId`) }; if (raw.source === "template") return { source: "template", templateLayerId: id(exact(raw, ["source", "templateLayerId"], [], label).templateLayerId, `${label}.templateLayerId`) }; throw new Error(`${label}.source must be role or template.`); }
function numberValue(value: unknown, label: string): MotionRelationActionNumberValue { const raw = dataRecord(value, label); if (raw.source === "literal") return { source: "literal", value: finite(exact(raw, ["source", "value"], [], label).value, `${label}.value`) }; if (raw.source === "parameter") return { source: "parameter", parameterId: id(exact(raw, ["source", "parameterId"], [], label).parameterId, `${label}.parameterId`) }; throw new Error(`${label}.source must be literal or parameter.`); }
function colorValue(value: unknown, label: string) { const raw = dataRecord(value, label); if (raw.source === "literal") return { source: "literal" as const, value: color(exact(raw, ["source", "value"], [], label).value, `${label}.value`) }; if (raw.source === "parameter") return { source: "parameter" as const, parameterId: id(exact(raw, ["source", "parameterId"], [], label).parameterId, `${label}.parameterId`) }; throw new Error(`${label}.source must be literal or parameter.`); }

function validateDefinition(definition: MotionRelationActionDefinition, label: string): void {
  for (const [name, values] of [["roles", definition.roles], ["parameters", definition.parameters], ["templateLayers", definition.templateLayers], ["relationTemplates", definition.relationTemplates], ["sequence", definition.sequence]] as const) sorted(values, `${label}.${name}`);
  const roles = new Map(definition.roles.map((role) => [role.id, role])), parameters = new Map(definition.parameters.map((parameter) => [parameter.id, parameter])), templates = new Map(definition.templateLayers.map((layer) => [layer.id, layer])), relations = new Map(definition.relationTemplates.map((relation) => [relation.id, relation]));
  const roleRef = (ref: MotionRelationActionLayerRef, target: "layer" | "group" | "shape", path: string) => {
    if (ref.source === "role") { const role = roles.get(ref.roleId); if (!role) throw new Error(`${path} references unknown role '${ref.roleId}'.`); if (target === "group" ? role.kind !== "group" : role.kind !== "layer" || (target === "shape" && (role.layerTypes.length !== 1 || role.layerTypes[0] !== "shape"))) throw new Error(`${path} has incompatible role '${ref.roleId}'.`); return; }
    const layer = templates.get(ref.templateLayerId); if (!layer) throw new Error(`${path} references unknown template layer '${ref.templateLayerId}'.`); if (target === "group" ? layer.layerType !== "group" : target === "shape" && layer.layerType !== "shape") throw new Error(`${path} has incompatible template layer '${ref.templateLayerId}'.`);
  };
  const numeric = (value: MotionRelationActionNumberValue, path: string) => { if (value.source === "parameter" && parameters.get(value.parameterId)?.type !== "number") throw new Error(`${path} requires a known number parameter.`); };
  const colored = (value: ReturnType<typeof colorValue>, path: string) => { if (value.source === "parameter" && parameters.get(value.parameterId)?.type !== "color") throw new Error(`${path} requires a known color parameter.`); };
  for (const layer of definition.templateLayers) if (layer.parent) roleRef(layer.parent, "group", `${label}.templateLayers.${layer.id}.parent`);
  for (const relation of definition.relationTemplates) {
    roleRef(relation.source.layer, "shape", `${label}.relationTemplates.${relation.id}.source.layer`); roleRef(relation.target.layer, "shape", `${label}.relationTemplates.${relation.id}.target.layer`);
    numeric(relation.source.anchorX, `${label}.relationTemplates.${relation.id}.source.anchorX`); numeric(relation.source.anchorY, `${label}.relationTemplates.${relation.id}.source.anchorY`); numeric(relation.target.anchorX, `${label}.relationTemplates.${relation.id}.target.anchorX`); numeric(relation.target.anchorY, `${label}.relationTemplates.${relation.id}.target.anchorY`); numeric(relation.durationUs, `${label}.relationTemplates.${relation.id}.durationUs`);
    if (relation.kind === "attach") {
      numeric(relation.offset.x, `${label}.relationTemplates.${relation.id}.offset.x`); numeric(relation.offset.y, `${label}.relationTemplates.${relation.id}.offset.y`);
      numeric(relation.offset.rotationDeg, `${label}.relationTemplates.${relation.id}.offset.rotationDeg`); numeric(relation.offset.scale, `${label}.relationTemplates.${relation.id}.offset.scale`);
    } else numeric(relation.rotationOffsetDeg, `${label}.relationTemplates.${relation.id}.rotationOffsetDeg`);
  }
  const usedRelations = new Set<string>();
  for (const step of definition.sequence) { if (step.kind === "keyframe") { roleRef(step.target, "layer", `${label}.sequence.${step.id}.target`); if (NUMBER_PROPERTIES.has(step.property)) numeric(step.value as MotionRelationActionNumberValue, `${label}.sequence.${step.id}.value`); else colored(step.value as ReturnType<typeof colorValue>, `${label}.sequence.${step.id}.value`); } else if (step.kind === "transition") { roleRef(step.target, "layer", `${label}.sequence.${step.id}.target`); numeric(step.durationUs, `${label}.sequence.${step.id}.durationUs`); } else { if (!relations.has(step.relationTemplateId)) throw new Error(`${label}.sequence.${step.id} references unknown relation template '${step.relationTemplateId}'.`); if (usedRelations.has(step.relationTemplateId)) throw new Error(`${label}.sequence may invoke relation template '${step.relationTemplateId}' only once.`); usedRelations.add(step.relationTemplateId); } }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (layerId: string) => { if (done.has(layerId)) return; if (visiting.has(layerId)) throw new Error(`${label}.templateLayers parent links must be acyclic.`); visiting.add(layerId); const parent = templates.get(layerId)?.parent; if (parent?.source === "template") visit(parent.templateLayerId); visiting.delete(layerId); done.add(layerId); };
  for (const layer of definition.templateLayers) visit(layer.id);
}

function clone(value: unknown, state: { active: WeakSet<object>; nodes: number; keys: number; bytes: number }, depth: number): unknown {
  if (value === null) { reserve(state, 4); return value; }
  if (typeof value === "boolean") { reserve(state, 5); return value; }
  if (typeof value === "number") { reserve(state, 32); return value; }
  if (typeof value === "string") { reserve(state, quotedBytes(value)); return value; }
  if (typeof value !== "object") throw new Error("Relation actions must contain only JSON data."); if (depth > MAX_DEPTH) throw new Error("Relation actions exceed their nesting limit."); if (state.active.has(value)) throw new Error("Relation actions must not contain cycles.");
  let isArray: boolean, keys: readonly PropertyKey[], prototype: object | null; try { isArray = Array.isArray(value); keys = Reflect.ownKeys(value); prototype = Object.getPrototypeOf(value); } catch { throw new Error("Relation actions data reflection failed."); }
  if (keys.length > (isArray ? MAX_ARRAY_ITEMS + 1 : MAX_RECORD_KEYS)) throw new Error(`Relation actions data exceeds the ${isArray ? MAX_ARRAY_ITEMS : MAX_RECORD_KEYS}-field ${isArray ? "array" : "record"} limit.`); if (state.keys + keys.length > MAX_TOTAL_KEYS || state.nodes >= MAX_NODES) throw new Error("Relation actions data exceeds aggregate limits."); if (prototype !== (isArray ? Array.prototype : Object.prototype) && prototype !== null || keys.some((key) => typeof key !== "string")) throw new Error("Relation actions must contain only plain data objects and arrays.");
  reserve(state, 2 + Math.max(0, keys.length - 1));
  for (const key of keys) reserve(state, quotedBytes(key as string) + 1);
  state.active.add(value); state.nodes += 1; state.keys += keys.length; try { if (isArray) { const length = descriptor(value, "length"); if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ARRAY_ITEMS || keys.length !== length.value + 1 || !keys.includes("length")) throw new Error("Relation actions arrays must be dense and bounded."); return Array.from({ length: length.value }, (_, index) => { const key = String(index), field = descriptor(value, key); if (!keys.includes(key) || !("value" in field) || !field.enumerable) throw new Error("Relation actions arrays must be dense data fields."); return clone(field.value, state, depth + 1); }); } const out: Record<string, unknown> = {}; for (const key of keys) { const field = descriptor(value, key); if (!("value" in field) || !field.enumerable) throw new Error(`Relation actions data.${String(key)} must be an enumerable data field.`); out[key as string] = clone(field.value, state, depth + 1); } return out; } finally { state.active.delete(value); }
}
function descriptor(value: object, key: PropertyKey): PropertyDescriptor { try { const result = Object.getOwnPropertyDescriptor(value, key); if (!result) throw new Error("missing"); return result; } catch { throw new Error("Relation actions data reflection failed."); } }
function quotedBytes(value: string): number { return 2 + value.length * 6; }
function reserve(state: { bytes: number }, bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes > MAX_MOTION_RELATION_ACTION_STORE_BYTES - bytes) throw new Error(`Relation actions exceed the ${MAX_MOTION_RELATION_ACTION_STORE_BYTES}-byte store limit.`); state.bytes += bytes; }
function dataRecord(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`); return value as Record<string, unknown>; }
function exact(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> { const record = dataRecord(value, label), allowed = new Set([...required, ...optional]); const unknown = Object.keys(record).find((key) => !allowed.has(key)); if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`); for (const key of required) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`); return record; }
function array(value: unknown, label: string, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a dense array with at most ${maximum} entries.`); return value; }
function string(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`${label} must be a string.`); return value; }
function id(value: unknown, label: string): string { const result = string(value, label); if (!SAFE_ID.test(result)) throw new Error(`${label} must be a safe stable id.`); return result; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_MOTION_RELATION_ACTION_LOCAL_US) throw new Error(`${label} must be a bounded finite number.`); return value; }
function atUs(value: unknown, label: string): number { const result = finite(value, label); if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`); return result; }
function color(value: unknown, label: string): string { const result = string(value, label); if (!COLOR.test(result)) throw new Error(`${label} must be a #RRGGBB color.`); return result.toLowerCase(); }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`); return value; }
function sorted(values: readonly { id: string }[], label: string): void { for (let index = 1; index < values.length; index += 1) if (compareCodeUnits(values[index - 1]!.id, values[index]!.id) >= 0) throw new Error(`${label} must be strict UTF-16/code-unit ascending unique id order.`); }
function sortedStrings(values: readonly string[], label: string): void { for (let index = 1; index < values.length; index += 1) if (compareCodeUnits(values[index - 1]!, values[index]!) >= 0) throw new Error(`${label} must be strict UTF-16/code-unit ascending unique order.`); }
function idMap(value: unknown, label: string, allowNumbers: boolean): Record<string, string> { const record = dataRecord(value, label), keys = Object.keys(record); if (keys.length > MAX_MOTION_RELATION_ACTION_ROLES) throw new Error(`${label} exceeds ${MAX_MOTION_RELATION_ACTION_ROLES} entries.`); const out: Record<string, string> = {}; for (const key of keys) { id(key, `${label} key`); if (typeof record[key] !== "string") { if (!allowNumbers) throw new Error(`${label}.${key} must be a stable id.`); } else out[key] = id(record[key], `${label}.${key}`); } return out; }
function parameterMap(value: unknown, label: string): Record<string, number | string> { const record = dataRecord(value, label), keys = Object.keys(record); if (keys.length > MAX_MOTION_RELATION_ACTION_PARAMETERS) throw new Error(`${label} exceeds ${MAX_MOTION_RELATION_ACTION_PARAMETERS} entries.`); const out: Record<string, number | string> = {}; for (const key of keys) { id(key, `${label} key`); const item = record[key]; if (typeof item !== "number" && typeof item !== "string") throw new Error(`${label}.${key} must be number or string.`); out[key] = item; } return out; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
