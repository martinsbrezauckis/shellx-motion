import { canonicalJsonSha256, compareCodeUnits } from "../../canonical-json";
import { MOTION_RELATIONS_SCHEMA, type MotionRelationBinding } from "../../motion-relation-types";
import { readMotionRelationStore } from "../../motion-relation-read";
import {
  MOTION_RELATION_ACTION_MATERIALIZATION_PLAN_SCHEMA,
  type MotionRelationActionDefinition,
  type MotionRelationActionLayerRef,
  type MotionRelationActionMaterializationPlan,
  type MotionRelationActionNumberValue,
  type MotionRelationActionOperation,
  type MotionRelationActionRelationTemplate,
} from "../../motion-relation-actions-types";
import {
  readMotionRelationActionMaterializationContext,
  readMotionRelationActionMaterializationInput,
  readMotionRelationActionStore,
} from "../../motion-relation-actions-read";

export type MotionRelationActionMaterializationPlanResult =
  | { ok: true; plan: MotionRelationActionMaterializationPlan }
  | { ok: false; message: string };

/**
 * Resolves one immutable blueprint against a captured layer catalog. The returned operations are a
 * plan only: no Motion object, package, relation store, renderer, or transition is ever mutated.
 */
export function compileMotionRelationActionMaterializationPlan(
  storeValue: unknown,
  requestValue: unknown,
  contextValue: unknown,
): MotionRelationActionMaterializationPlanResult {
  try {
    const store = readMotionRelationActionStore(storeValue);
    const request = readMotionRelationActionMaterializationInput(requestValue);
    const context = readMotionRelationActionMaterializationContext(contextValue);
    const definition = store.definitions.find((candidate) => candidate.id === request.definitionId);
    if (!definition) return { ok: false, message: `Unknown relation action '${request.definitionId}'.` };
    const definitionSha256 = canonicalJsonSha256(definition);
    if (request.expectedDefinitionSha256 !== definitionSha256) return { ok: false, message: `Relation action '${definition.id}' has stale definition identity.` };
    const roles = resolveRoles(definition, request.roleBindings, context.existingLayers);
    const parameters = resolveParameters(definition, request.parameterValues);
    const templateIds = new Map(definition.templateLayers.map((layer) => [layer.id, stableId("layer", definitionSha256, request.instanceId, layer.id)]));
    const resolveRef = (ref: MotionRelationActionLayerRef): string => ref.source === "role" ? roles[ref.roleId]! : templateIds.get(ref.templateLayerId)!;
    const operations: MotionRelationActionOperation[] = createOperations(definition, definitionSha256, request.instanceId, resolveRef, templateIds);
    for (const step of [...definition.sequence].sort((left, right) => left.atUs - right.atUs || compareCodeUnits(left.id, right.id))) {
      const atUs = addUs(request.startAtUs, step.atUs, `Relation action step '${step.id}'`);
      if (step.kind === "keyframe") {
        const value = step.value.source === "literal" ? step.value.value : parameters[step.value.parameterId]!;
        operations.push({ operationId: stableId("keyframe", definitionSha256, request.instanceId, step.id), kind: "keyframe.upsert", atUs, layerId: resolveRef(step.target), property: step.property, value, ...(step.easing ? { easing: step.easing } : {}) });
      } else if (step.kind === "transition") {
        const durationUs = positiveUs(numberValue(step.durationUs, parameters), `Relation action transition '${step.id}' durationUs`);
        addUs(atUs, durationUs, `Relation action transition '${step.id}'`);
        operations.push({ operationId: stableId("transition", definitionSha256, request.instanceId, step.id), kind: "transition.apply", atUs, layerId: resolveRef(step.target), presetId: step.presetId, durationUs });
      } else {
        const template = definition.relationTemplates.find((candidate) => candidate.id === step.relationTemplateId)!;
        const binding = resolveRelation(template, definitionSha256, request.instanceId, atUs, resolveRef, parameters);
        operations.push({ operationId: stableId("relation", definitionSha256, request.instanceId, step.id), kind: "relation.upsert", atUs: binding.startUs, relationId: binding.id, relationTemplateId: template.id, binding });
      }
    }
    const instance = Object.freeze({ id: request.instanceId, startAtUs: request.startAtUs, roleBindings: freezeRecord(roles), parameterValues: freezeRecord(parameters) });
    const payload = { schema: MOTION_RELATION_ACTION_MATERIALIZATION_PLAN_SCHEMA, actionSourceSha256: canonicalJsonSha256(store), definition: { id: definition.id, sha256: definitionSha256 }, instance, operations: freeze(operations) };
    return { ok: true, plan: freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Relation action materialization planning refused." }; }
}

function resolveRoles(definition: MotionRelationActionDefinition, request: Record<string, string>, existing: readonly { id: string; type: string }[]): Record<string, string> {
  const catalog = new Map(existing.map((layer) => [layer.id, layer]));
  for (const key of Object.keys(request)) if (!definition.roles.some((role) => role.id === key)) throw new Error(`Relation action '${definition.id}' has unknown role binding '${key}'.`);
  const resolved: Record<string, string> = {};
  for (const role of definition.roles) {
    const layerId = request[role.id]; if (!layerId) throw new Error(`Relation action '${definition.id}' requires role binding '${role.id}'.`);
    const layer = catalog.get(layerId); if (!layer) throw new Error(`Relation action '${definition.id}' has stale role binding '${role.id}' to '${layerId}'.`);
    if (role.kind === "group" ? layer.type !== "group" : !role.layerTypes.includes(layer.type as never)) throw new Error(`Relation action '${definition.id}' role '${role.id}' rejects layer '${layerId}' type '${layer.type}'.`);
    resolved[role.id] = layerId;
  }
  return ordered(resolved);
}
function resolveParameters(definition: MotionRelationActionDefinition, request: Record<string, number | string>): Record<string, number | string> {
  for (const key of Object.keys(request)) if (!definition.parameters.some((parameter) => parameter.id === key)) throw new Error(`Relation action '${definition.id}' has unknown parameter '${key}'.`);
  const resolved: Record<string, number | string> = {};
  for (const parameter of definition.parameters) {
    const value = request[parameter.id] ?? parameter.defaultValue;
    if (parameter.type === "number") { if (typeof value !== "number" || !Number.isFinite(value) || value < parameter.minimum || value > parameter.maximum) throw new Error(`Relation action '${definition.id}' parameter '${parameter.id}' must be within ${parameter.minimum}..${parameter.maximum}.`); }
    else if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`Relation action '${definition.id}' parameter '${parameter.id}' must be a #RRGGBB color.`);
    resolved[parameter.id] = typeof value === "string" ? value.toLowerCase() : value;
  }
  return ordered(resolved);
}
function createOperations(definition: MotionRelationActionDefinition, hash: string, instanceId: string, resolveRef: (ref: MotionRelationActionLayerRef) => string, templateIds: ReadonlyMap<string, string>): MotionRelationActionOperation[] {
  const groups = orderedTemplates(definition).filter((layer) => layer.layerType === "group");
  const layers = orderedTemplates(definition).filter((layer) => layer.layerType !== "group");
  return [...groups, ...layers].map((layer) => {
    const parentLayerId = layer.parent ? resolveRef(layer.parent) : undefined, layerId = templateIds.get(layer.id)!;
    const base = { operationId: stableId(layer.layerType === "group" ? "group" : "layer", hash, instanceId, layer.id), layerId, templateLayerId: layer.id, ...(parentLayerId ? { parentLayerId } : {}) };
    return layer.layerType === "group" ? { ...base, kind: "group.create" as const } : { ...base, kind: "layer.create" as const, layerType: layer.layerType };
  });
}
function orderedTemplates(definition: MotionRelationActionDefinition) {
  const byId = new Map(definition.templateLayers.map((layer) => [layer.id, layer])), done = new Set<string>(), out: typeof definition.templateLayers = [];
  const visit = (id: string) => { if (done.has(id)) return; const layer = byId.get(id)!; if (layer.parent?.source === "template") visit(layer.parent.templateLayerId); done.add(id); out.push(layer); };
  for (const layer of definition.templateLayers) visit(layer.id); return out;
}
function resolveRelation(template: MotionRelationActionRelationTemplate, hash: string, instanceId: string, stepAtUs: number, resolveRef: (ref: MotionRelationActionLayerRef) => string, parameters: Record<string, number | string>): MotionRelationBinding {
  const base = { id: stableId("binding", hash, instanceId, template.id), enabled: template.enabled, source: { layerId: resolveRef(template.source.layer), anchor: { x: numberValue(template.source.anchorX, parameters), y: numberValue(template.source.anchorY, parameters) } }, target: { layerId: resolveRef(template.target.layer), anchor: { x: numberValue(template.target.anchorX, parameters), y: numberValue(template.target.anchorY, parameters) } }, startUs: addUs(stepAtUs, template.startUs, `Relation template '${template.id}'`), durationUs: positiveUs(numberValue(template.durationUs, parameters), `Relation template '${template.id}' durationUs`) };
  addUs(base.startUs, base.durationUs, `Relation template '${template.id}'`);
  const binding: MotionRelationBinding = template.kind === "attach"
    ? { ...base, kind: "attach", mode: template.mode, offset: { space: template.offset.space, x: numberValue(template.offset.x, parameters), y: numberValue(template.offset.y, parameters), rotationDeg: numberValue(template.offset.rotationDeg, parameters), scale: numberValue(template.offset.scale, parameters) } }
    : { ...base, kind: "aim", rotationOffsetDeg: numberValue(template.rotationOffsetDeg, parameters) };
  return readMotionRelationStore({ schema: MOTION_RELATIONS_SCHEMA, bindings: [binding] }).bindings[0]!;
}
function numberValue(value: MotionRelationActionNumberValue, parameters: Record<string, number | string>): number { const result = value.source === "literal" ? value.value : parameters[value.parameterId]; if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Relation action parameter '${value.source === "parameter" ? value.parameterId : "literal"}' did not resolve to a number.`); return result; }
function positiveUs(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must resolve to a positive safe integer microsecond.`); return value; }
function addUs(left: number, right: number, label: string): number { const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds safe integer microseconds.`); return result; }
function stableId(kind: string, definitionSha256: string, instanceId: string, localId: string): string { return `ra_${kind}_${canonicalJsonSha256({ definitionSha256, instanceId, localId }).slice(0, 32)}`; }
function ordered<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))) as T; }
function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> { return Object.freeze({ ...value }); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
