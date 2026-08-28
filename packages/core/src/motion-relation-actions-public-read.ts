import { canonicalJson, compareCodeUnits } from "./canonical-json";
import {
  readMotionRelationActionStore as readPrivateStore,
} from "./motion-relation-actions-read";
import {
  snapshotPublicMotionRelationActionApply,
  snapshotPublicMotionRelationActionDefinitionRemove,
  snapshotPublicMotionRelationActionDefinitionUpsert,
  snapshotPublicMotionRelationActionStore,
} from "./motion-relation-actions-public-snapshot";
import {
  MAX_MOTION_RELATION_ACTION_LOCAL_US,
  MAX_MOTION_RELATION_ACTION_STORE_BYTES,
  MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA,
  MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA,
  type MotionRelationActionApplyRequest,
  type MotionRelationActionClosedTransform,
  type MotionRelationActionDefinition,
  type MotionRelationActionLayerPrototype,
  type MotionRelationActionStore,
} from "./motion-relation-actions-public-types";
import type { MotionRelationActionLayerRef } from "./motion-relation-actions-types";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_COORDINATE = 1_000_000;

/** Exact, descriptor-first reader for the persisted @2 store. */
export function readMotionRelationActionStore(value: unknown): MotionRelationActionStore {
  const snapshot = snapshotPublicMotionRelationActionStore(value);
  const root = exact(snapshot, ["schema", "definitions"], [], "Relation actions");
  if (root.schema !== MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA) {
    throw new Error(`Relation actions schema must equal ${MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA}.`);
  }
  if (!Array.isArray(root.definitions) || root.definitions.length > 16) {
    throw new Error("Relation actions definitions must be a dense array with at most 16 entries.");
  }
  const rawDefinitions = root.definitions.map((value, index) => readRawDefinition(value, index));
  const privateStore = readPrivateStore({
    schema: "shellx-motion/relation-actions@1",
    definitions: rawDefinitions.map(({ definition }) => definition),
  });
  const definitions = privateStore.definitions.map((definition, index) => {
    const prototypes = rawDefinitions[index]!.prototypes;
    return freeze({
      ...definition,
      templateLayers: definition.templateLayers.map((template) => freeze({
        id: template.id,
        layer: prototypes.get(template.id)!,
        ...(template.parent ? { parent: template.parent } : {}),
      })),
    }) as MotionRelationActionDefinition;
  });
  if (Buffer.byteLength(canonicalJson({ schema: MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA, definitions }), "utf8") > MAX_MOTION_RELATION_ACTION_STORE_BYTES) {
    throw new Error(`Relation actions exceed the ${MAX_MOTION_RELATION_ACTION_STORE_BYTES}-byte store limit.`);
  }
  return freeze({ schema: MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA, definitions });
}

/** Exact, public descriptor-first upsert envelope; it admits no generic pre-cap traversal. */
export function readMotionRelationActionDefinitionUpsert(value: unknown): MotionRelationActionDefinition {
  const input = snapshotPublicMotionRelationActionDefinitionUpsert(value);
  return readMotionRelationActionStore({ schema: MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA, definitions: [input.definition] }).definitions[0]!;
}

/** Exact public remove envelope, read before Motion source observation. */
export function readMotionRelationActionDefinitionRemove(value: unknown): string {
  return id(snapshotPublicMotionRelationActionDefinitionRemove(value).id, "Relation action definition remove.id");
}

/** Validation-only leaf used by Motion document validation; it has no dependency on authoring. */
export function validateMotionRelationActions(value: unknown): { ok: true; store: MotionRelationActionStore } | { ok: false; message: string } {
  try { return { ok: true, store: readMotionRelationActionStore(value) }; }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Relation actions are invalid." }; }
}

/** Exact ephemeral apply request parser. It has no Motion-document side effects. */
export function readMotionRelationActionApplyRequest(value: unknown): MotionRelationActionApplyRequest {
  const record = exact(snapshotPublicMotionRelationActionApply(value), [
    "definitionId", "expectedMotionSha256", "expectedStoreSha256", "expectedDefinitionSha256",
    "instanceId", "startAtUs", "roleBindings",
  ], ["parameterValues"], "Relation action apply");
  for (const field of ["expectedMotionSha256", "expectedStoreSha256", "expectedDefinitionSha256"] as const) {
    if (typeof record[field] !== "string" || !SHA256.test(record[field])) {
      throw new Error(`Relation action apply.${field} must be lowercase SHA-256.`);
    }
  }
  return freeze({
    definitionId: id(record.definitionId, "Relation action apply.definitionId"),
    expectedMotionSha256: record.expectedMotionSha256 as string,
    expectedStoreSha256: record.expectedStoreSha256 as string,
    expectedDefinitionSha256: record.expectedDefinitionSha256 as string,
    instanceId: id(record.instanceId, "Relation action apply.instanceId"),
    startAtUs: us(record.startAtUs, "Relation action apply.startAtUs"),
    roleBindings: idMap(record.roleBindings, "Relation action apply.roleBindings", 16),
    parameterValues: parameterMap(record.parameterValues ?? {}, "Relation action apply.parameterValues"),
  });
}

function readRawDefinition(value: unknown, index: number): {
  definition: Record<string, unknown>;
  prototypes: ReadonlyMap<string, MotionRelationActionLayerPrototype>;
} {
  const label = `Relation actions definitions[${index}]`;
  const record = exact(value, ["id", "roles", "parameters", "templateLayers", "relationTemplates", "sequence"], [], label);
  if (!Array.isArray(record.templateLayers) || record.templateLayers.length > 32) {
    throw new Error(`${label}.templateLayers must be a dense array with at most 32 entries.`);
  }
  const prototypes = new Map<string, MotionRelationActionLayerPrototype>();
  const templateLayers = record.templateLayers.map((template, templateIndex) => {
    const templateLabel = `${label}.templateLayers[${templateIndex}]`;
    const parsed = exact(template, ["id", "layer"], ["parent"], templateLabel);
    const templateId = id(parsed.id, `${templateLabel}.id`);
    if (prototypes.has(templateId)) throw new Error(`${label}.templateLayers must use unique ids.`);
    const prototype = readPrototype(parsed.layer, `${templateLabel}.layer`);
    prototypes.set(templateId, prototype);
    return {
      id: templateId,
      layerType: prototype.type,
      ...(parsed.parent === undefined ? {} : { parent: readLayerRef(parsed.parent, `${templateLabel}.parent`) }),
    };
  });
  return {
    definition: {
      id: record.id,
      roles: record.roles,
      parameters: record.parameters,
      templateLayers,
      relationTemplates: record.relationTemplates,
      sequence: record.sequence,
    },
    prototypes,
  };
}

function readPrototype(input: unknown, label: string): MotionRelationActionLayerPrototype {
  const raw = record(input, label);
  if (raw.type === "shape") {
    const shapeRecord = exact(raw, ["schema", "type", "startUs", "durationUs", "shape", "fill"], ["name", "visible", "transform", "stroke", "strokeWidth"], label);
    commonPrototype(shapeRecord, label);
    if (!isShape(shapeRecord.shape)) throw new Error(`${label}.shape is not action-admitted.`);
    const fill = color(shapeRecord.fill, `${label}.fill`);
    const stroke = shapeRecord.stroke === undefined ? undefined : color(shapeRecord.stroke, `${label}.stroke`);
    const strokeWidth = shapeRecord.strokeWidth === undefined ? undefined : bounded(shapeRecord.strokeWidth, 0, 4_096, `${label}.strokeWidth`);
    if (strokeWidth !== undefined && stroke === undefined) throw new Error(`${label}.strokeWidth requires stroke.`);
    return freeze({
      schema: MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA, type: "shape", startUs: us(shapeRecord.startUs, `${label}.startUs`), durationUs: duration(shapeRecord.durationUs, `${label}.durationUs`),
      shape: shapeRecord.shape, fill,
      ...(shapeRecord.name === undefined ? {} : { name: name(shapeRecord.name, `${label}.name`) }),
      ...(shapeRecord.visible === undefined ? {} : { visible: boolean(shapeRecord.visible, `${label}.visible`) }),
      ...(shapeRecord.transform === undefined ? {} : { transform: transform(shapeRecord.transform, `${label}.transform`) }),
      ...(stroke === undefined ? {} : { stroke }), ...(strokeWidth === undefined ? {} : { strokeWidth }),
    });
  }
  const groupRecord = exact(raw, ["schema", "type", "startUs", "durationUs"], ["name", "visible", "transform"], label);
  commonPrototype(groupRecord, label);
  if (groupRecord.type !== "group") throw new Error(`${label}.type must be shape or group.`);
  return freeze({
    schema: MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA, type: "group", startUs: us(groupRecord.startUs, `${label}.startUs`), durationUs: duration(groupRecord.durationUs, `${label}.durationUs`),
    ...(groupRecord.name === undefined ? {} : { name: name(groupRecord.name, `${label}.name`) }),
    ...(groupRecord.visible === undefined ? {} : { visible: boolean(groupRecord.visible, `${label}.visible`) }),
    ...(groupRecord.transform === undefined ? {} : { transform: transform(groupRecord.transform, `${label}.transform`) }),
  });
}

function commonPrototype(value: Record<string, unknown>, label: string): void {
  if (value.schema !== MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA) {
    throw new Error(`${label}.schema must equal ${MOTION_RELATION_ACTION_LAYER_PROTOTYPE_SCHEMA}.`);
  }
}
function transform(value: unknown, label: string): MotionRelationActionClosedTransform {
  const raw = exact(value, [], ["x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"], label);
  if (Object.keys(raw).length === 0) throw new Error(`${label} must contain at least one closed transform field.`);
  const result: MotionRelationActionClosedTransform = {};
  for (const field of ["x", "y", "rotation", "originX", "originY"] as const) {
    if (raw[field] !== undefined) result[field] = bounded(raw[field], -MAX_COORDINATE, MAX_COORDINATE, `${label}.${field}`);
  }
  for (const field of ["width", "height"] as const) {
    if (raw[field] !== undefined) result[field] = bounded(raw[field], 0, MAX_COORDINATE, `${label}.${field}`);
  }
  if (raw.opacity !== undefined) result.opacity = bounded(raw.opacity, 0, 1, `${label}.opacity`);
  if (raw.scale !== undefined) result.scale = bounded(raw.scale, 0.001, 64, `${label}.scale`);
  return freeze(result);
}
function exact(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const out = record(value, label), allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(out).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of required) if (!Object.hasOwn(out, key)) throw new Error(`${label} requires ${key}.`);
  return out;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function readLayerRef(value: unknown, label: string): MotionRelationActionLayerRef {
  const raw = record(value, label);
  if (raw.source === "role") return { source: "role", roleId: id(exact(raw, ["source", "roleId"], [], label).roleId, `${label}.roleId`) };
  if (raw.source === "template") return { source: "template", templateLayerId: id(exact(raw, ["source", "templateLayerId"], [], label).templateLayerId, `${label}.templateLayerId`) };
  throw new Error(`${label}.source must be role or template.`);
}
function id(value: unknown, label: string): string { if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a safe stable id.`); return value; }
function us(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > MAX_MOTION_RELATION_ACTION_LOCAL_US) throw new Error(`${label} must be a bounded non-negative safe integer microsecond.`); return value; }
function duration(value: unknown, label: string): number { const out = us(value, label); if (out === 0) throw new Error(`${label} must be a positive safe integer microsecond.`); return out; }
function bounded(value: unknown, min: number, max: number, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in ${min}..${max}.`); return value; }
function color(value: unknown, label: string): string { if (typeof value !== "string" || !COLOR.test(value)) throw new Error(`${label} must be a #RRGGBB color.`); return value.toLowerCase(); }
function name(value: unknown, label: string): string { if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${label} must be a 1..256 character string.`); return value; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`); return value; }
function isShape(value: unknown): value is "rect" | "rounded-rect" | "ellipse" | "triangle" | "star" { return value === "rect" || value === "rounded-rect" || value === "ellipse" || value === "triangle" || value === "star"; }
function idMap(value: unknown, label: string, max: number): Record<string, string> {
  const input = record(value, label), out: Record<string, string> = {};
  const entries = Object.entries(input); if (entries.length > max) throw new Error(`${label} exceeds ${max} entries.`);
  for (const [key, item] of entries) out[id(key, `${label} key`)] = id(item, `${label}.${key}`);
  return ordered(out);
}
function parameterMap(value: unknown, label: string): Record<string, number | string> {
  const input = record(value, label), out: Record<string, number | string> = {};
  const entries = Object.entries(input); if (entries.length > 16) throw new Error(`${label} exceeds 16 entries.`);
  for (const [key, item] of entries) {
    id(key, `${label} key`);
    if ((typeof item !== "number" || !Number.isFinite(item)) && typeof item !== "string") throw new Error(`${label}.${key} must be a finite number or string.`);
    out[key] = item;
  }
  return ordered(out);
}
function ordered<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))) as T; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
