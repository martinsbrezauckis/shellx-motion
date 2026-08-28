import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { absoluteLayerStart, type MotionGroupGraph } from "./motion-group-structural-support";
import {
  MAX_MOTION_RELATION_ACTION_APPLY_KEYFRAME_WRITES,
  MAX_MOTION_RELATION_ACTION_APPLY_OBJECTS,
  MAX_MOTION_RELATION_ACTION_APPLY_RELATIONS,
  type MotionRelationActionApplyRequest,
  type MotionRelationActionDefinition,
} from "./motion-relation-actions-public-types";
import type { MotionRelationActionLayerRef, MotionRelationActionNumberValue, MotionRelationActionRelationTemplate } from "./motion-relation-actions-types";
import { compileTransitionPreset } from "./transition-presets";
import { upsertLayerKeyframe } from "./timeline";
import type { MotionDocument, MotionLayer } from "./types";

const US_PER_MS = 1_000;

/** Final operation-count admission for the fully resolved plan, before candidate construction. */
export function assertMotionRelationActionApplyCaps(counts: { objects: number; relations: number; keyframeWrites: number }): void {
  if (counts.objects > MAX_MOTION_RELATION_ACTION_APPLY_OBJECTS) throw new Error(`Relation action apply exceeds ${MAX_MOTION_RELATION_ACTION_APPLY_OBJECTS} created objects.`);
  if (counts.relations > MAX_MOTION_RELATION_ACTION_APPLY_RELATIONS) throw new Error(`Relation action apply exceeds ${MAX_MOTION_RELATION_ACTION_APPLY_RELATIONS} concrete relations.`);
  if (counts.keyframeWrites > MAX_MOTION_RELATION_ACTION_APPLY_KEYFRAME_WRITES) throw new Error(`Relation action apply exceeds ${MAX_MOTION_RELATION_ACTION_APPLY_KEYFRAME_WRITES} generated keyframe writes.`);
}

export function resolveMotionRelationActionRoles(definition: MotionRelationActionDefinition, requested: Record<string, string>, layers: readonly MotionLayer[]): Record<string, string> {
  const catalog = new Map(layers.map((layer) => [layer.id, layer]));
  for (const roleId of Object.keys(requested)) if (!definition.roles.some((role) => role.id === roleId)) throw new Error(`Relation action '${definition.id}' has unknown role binding '${roleId}'.`);
  const result: Record<string, string> = {};
  for (const role of definition.roles) {
    const layerId = requested[role.id]; if (!layerId) throw new Error(`Relation action '${definition.id}' requires role binding '${role.id}'.`);
    const layer = catalog.get(layerId); if (!layer) throw new Error(`Relation action '${definition.id}' has stale role binding '${role.id}' to '${layerId}'.`);
    if (role.kind === "group" ? layer.type !== "group" : !role.layerTypes.includes(layer.type as never)) throw new Error(`Relation action '${definition.id}' role '${role.id}' rejects layer '${layerId}' type '${layer.type}'.`);
    result[role.id] = layerId;
  }
  return ordered(result);
}

export function resolveMotionRelationActionParameters(definition: MotionRelationActionDefinition, requested: Record<string, number | string>): Record<string, number | string> {
  for (const id of Object.keys(requested)) if (!definition.parameters.some((parameter) => parameter.id === id)) throw new Error(`Relation action '${definition.id}' has unknown parameter '${id}'.`);
  const result: Record<string, number | string> = {};
  for (const parameter of definition.parameters) {
    const value = requested[parameter.id] ?? parameter.defaultValue;
    if (parameter.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < parameter.minimum || value > parameter.maximum) throw new Error(`Relation action '${definition.id}' parameter '${parameter.id}' must be within ${parameter.minimum}..${parameter.maximum}.`);
    } else if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`Relation action '${definition.id}' parameter '${parameter.id}' must be a #RRGGBB color.`);
    result[parameter.id] = typeof value === "string" ? value.toLowerCase() : value;
  }
  return ordered(result);
}

export function stableMotionRelationActionId(kind: string, definitionSha256: string, instanceId: string, localId: string): string {
  return `ra_${kind}_${canonicalJsonSha256({ definitionSha256, instanceId, localId }).slice(0, 32)}`;
}
export function addMotionRelationActionUs(left: number, right: number, label: string): number {
  const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds safe integer microseconds.`); return result;
}
export function motionRelationActionUsToMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value % US_PER_MS !== 0) throw new Error(`${label} must be exactly whole-millisecond representable.`); return value / US_PER_MS;
}

export function planMotionRelationActionSequence(
  motion: MotionDocument,
  definition: MotionRelationActionDefinition,
  request: MotionRelationActionApplyRequest,
  definitionSha256: string,
  parameters: Record<string, number | string>,
  resolveRef: (ref: MotionRelationActionLayerRef) => string,
  templateAbsoluteStartMs: ReadonlyMap<string, number>,
  createdLayers: ReadonlyMap<string, MotionLayer>,
  graph: MotionGroupGraph,
) {
  const allLayers = new Map([...motion.layers, ...createdLayers.values()].map((layer) => [layer.id, layer]));
  const absolute = (layerId: string): number => {
    if (createdLayers.has(layerId)) {
      const template = definition.templateLayers.find((candidate) => stableMotionRelationActionId("layer", definitionSha256, request.instanceId, candidate.id) === layerId)!;
      return templateAbsoluteStartMs.get(template.id)!;
    }
    return absoluteLayerStart(graph, layerId);
  };
  const keyframes: Array<{ layerId: string; input: Parameters<typeof upsertLayerKeyframe>[1] }> = [];
  const transitions: Array<{ layerId: string; stepId: string; presetId: string; durationMs: number; keyframeTargets: readonly string[] }> = [];
  const relations: Array<{ binding: ReturnType<typeof relationBinding> }> = [];
  const existingEditable = new Set<string>(); let keyframeWrites = 0;
  for (const step of [...definition.sequence].sort((left, right) => left.atUs - right.atUs || compareCodeUnits(left.id, right.id))) {
    const atUs = addMotionRelationActionUs(request.startAtUs, step.atUs, `Relation action step '${step.id}'`);
    if (step.kind === "keyframe") {
      const layerId = resolveRef(step.target); const layer = allLayers.get(layerId);
      if (!layer) throw new Error(`Relation action step '${step.id}' targets missing layer '${layerId}'.`);
      const atMs = motionRelationActionUsToMs(atUs, `Relation action step '${step.id}' atUs`) - absolute(layerId);
      if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > layer.durationMs) throw new Error(`Relation action step '${step.id}' falls outside target layer '${layerId}' local timeline.`);
      const value = step.value.source === "literal" ? step.value.value : parameters[step.value.parameterId];
      if (value === undefined) throw new Error(`Relation action step '${step.id}' has unresolved parameter value.`);
      keyframes.push({ layerId, input: { target: step.property, atMs, value, ...(step.easing ? { easing: step.easing } : {}) } });
      if (!createdLayers.has(layerId)) existingEditable.add(layerId); keyframeWrites += 1;
    } else if (step.kind === "transition") {
      const layerId = resolveRef(step.target); const layer = allLayers.get(layerId);
      if (!layer) throw new Error(`Relation action transition '${step.id}' targets missing layer '${layerId}'.`);
      if (atUs !== absolute(layerId) * US_PER_MS) throw new Error(`Relation action transition '${step.id}' must begin at target layer '${layerId}' local start.`);
      const durationUs = positiveUs(numberValue(step.durationUs, parameters), `Relation action transition '${step.id}' durationUs`);
      const durationMs = motionRelationActionUsToMs(durationUs, `Relation action transition '${step.id}' durationUs`);
      if (durationMs > layer.durationMs) throw new Error(`Relation action transition '${step.id}' exceeds target layer '${layerId}' duration.`);
      const compiled = compileTransitionPreset(step.presetId, { durationMs, totalDurationMs: layer.durationMs });
      if (!compiled.ok) throw new Error(`Relation action transition '${step.id}' refused: ${compiled.error}`);
      keyframeWrites += Object.values(compiled.keyframes).reduce((total, entries) => total + (entries?.length ?? 0), 0);
      transitions.push({ layerId, stepId: step.id, presetId: step.presetId, durationMs, keyframeTargets: Object.keys(compiled.keyframes) });
      if (!createdLayers.has(layerId)) existingEditable.add(layerId);
    } else {
      const relation = definition.relationTemplates.find((candidate) => candidate.id === step.relationTemplateId)!;
      const binding = relationBinding(relation, definitionSha256, request.instanceId, atUs, resolveRef, parameters);
      relations.push({ binding });
      for (const layerId of [binding.source.layerId, binding.target.layerId]) if (!createdLayers.has(layerId)) existingEditable.add(layerId);
    }
  }
  return { keyframes, transitions, relations, keyframeWrites, existingEditableLayerIds: Object.freeze([...existingEditable].sort(compareCodeUnits)) };
}

function relationBinding(template: MotionRelationActionRelationTemplate, definitionSha256: string, instanceId: string, stepAtUs: number, resolveRef: (ref: MotionRelationActionLayerRef) => string, parameters: Record<string, number | string>) {
  const base = {
    id: stableMotionRelationActionId("binding", definitionSha256, instanceId, template.id), enabled: template.enabled,
    source: { layerId: resolveRef(template.source.layer), anchor: { x: numberValue(template.source.anchorX, parameters), y: numberValue(template.source.anchorY, parameters) } },
    target: { layerId: resolveRef(template.target.layer), anchor: { x: numberValue(template.target.anchorX, parameters), y: numberValue(template.target.anchorY, parameters) } },
    startUs: addMotionRelationActionUs(stepAtUs, template.startUs, `Relation action relation '${template.id}' startUs`),
    durationUs: positiveUs(numberValue(template.durationUs, parameters), `Relation action relation '${template.id}' durationUs`),
  };
  addMotionRelationActionUs(base.startUs, base.durationUs, `Relation action relation '${template.id}'`);
  return template.kind === "attach"
    ? { ...base, kind: "attach" as const, mode: template.mode, offset: { space: template.offset.space, x: numberValue(template.offset.x, parameters), y: numberValue(template.offset.y, parameters), rotationDeg: numberValue(template.offset.rotationDeg, parameters), scale: numberValue(template.offset.scale, parameters) } }
    : { ...base, kind: "aim" as const, rotationOffsetDeg: numberValue(template.rotationOffsetDeg, parameters) };
}
function numberValue(value: MotionRelationActionNumberValue, parameters: Record<string, number | string>): number { const result = value.source === "literal" ? value.value : parameters[value.parameterId]; if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Relation action parameter '${value.source === "parameter" ? value.parameterId : "literal"}' did not resolve to a number.`); return result; }
function positiveUs(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must resolve to a positive safe integer microsecond.`); return value; }
function ordered<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))) as T; }
