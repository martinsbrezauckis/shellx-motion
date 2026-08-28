import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { compileMotionDocumentCompositing } from "./compositing-graph-compile";
import { readMotionGroupGraph, absoluteLayerStart, assertEditableLayers } from "./motion-group-structural-support";
import { compileMotionRelationStaticPlan } from "./motion-relation-plan";
import { readMotionRelationStore } from "./motion-relation-read";
import { validateMotionRelations } from "./motion-relation-validate";
import {
  MOTION_RELATION_ACTION_APPLY_PLAN_SCHEMA,
  MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA,
  type MotionRelationActionApplyPlan,
  type MotionRelationActionApplyRequest,
  type MotionRelationActionDefinition,
  type MotionRelationActionLayerPrototype,
  type MotionRelationActionStore,
} from "./motion-relation-actions-public-types";
import { readMotionRelationActionApplyRequest, readMotionRelationActionDefinitionRemove, readMotionRelationActionDefinitionUpsert, readMotionRelationActionStore } from "./motion-relation-actions-public-read";
import type { MotionRelationActionLayerRef } from "./motion-relation-actions-types";
import { applyTransitionPresetToLayer, compileTransitionPreset } from "./transition-presets";
import { upsertLayerKeyframe } from "./timeline";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument, MotionLayer } from "./types";
import {
  addMotionRelationActionUs as addUs,
  assertMotionRelationActionApplyCaps,
  motionRelationActionUsToMs as toMs,
  planMotionRelationActionSequence as planSequence,
  resolveMotionRelationActionParameters as resolveParameters,
  resolveMotionRelationActionRoles as resolveRoles,
  stableMotionRelationActionId as stableId,
} from "./motion-relation-actions-materialize-support";

export type MotionRelationActionInspection = Readonly<{
  store: MotionRelationActionStore | null;
  storeSha256: string | null;
  definitions: readonly { id: string; sha256: string }[];
}>;

export type MotionRelationActionDefinitionMutation = Readonly<{
  action: "upserted" | "removed";
  definitionId: string;
  motion: MotionDocument;
  changedPaths: readonly string[];
  beforeStoreSha256: string | null;
  afterStoreSha256: string | null;
  definitionSha256: string | null;
}>;

export type MotionRelationActionApplyResult = Readonly<{
  action: "applied";
  definitionId: string;
  motion: MotionDocument;
  plan: MotionRelationActionApplyPlan;
  changedPaths: readonly string[];
  createdObjectIds: readonly string[];
  relationIds: readonly string[];
  beforeRelationStaticFingerprint: string;
  afterRelationStaticFingerprint: string;
  outputMotionSha256: string;
}>;

/** Public B1 inspection. The optional root remains authoring metadata, not renderer authority. */
export function inspectMotionRelationActions(motion: MotionDocument): MotionRelationActionInspection {
  const store = motion.relationActions === undefined ? null : readMotionRelationActionStore(motion.relationActions);
  return freeze({
    store,
    storeSha256: store ? canonicalJsonSha256(store) : null,
    definitions: Object.freeze((store?.definitions ?? []).map((definition) => freeze({ id: definition.id, sha256: canonicalJsonSha256(definition) }))),
  });
}

/** Inserts or replaces one closed definition. Existing materializations remain ordinary detached data. */
export function upsertMotionRelationActionDefinition(motion: MotionDocument, input: unknown): MotionRelationActionDefinitionMutation {
  const definition = readMotionRelationActionDefinitionUpsert(input);
  assertValidRelationActionDocument(motion, "Relation action upsert source");
  const current = inspectMotionRelationActions(motion);
  const definitions = [...(current.store?.definitions ?? [])];
  const index = definitions.findIndex((candidate) => candidate.id === definition.id);
  if (index >= 0 && canonicalJson(definitions[index]) === canonicalJson(definition)) throw new Error(`Relation action '${definition.id}' did not change.`);
  if (index >= 0) definitions[index] = definition;
  else definitions.push(definition);
  definitions.sort((left, right) => compareCodeUnits(left.id, right.id));
  const store = readMotionRelationActionStore({ schema: MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA, definitions });
  const next = withStore(motion, store);
  assertValidRelationActionDocument(next, "Relation action upsert output");
  const nextIndex = store.definitions.findIndex((candidate) => candidate.id === definition.id);
  return freezeWithMutableMotion({
    action: "upserted", definitionId: definition.id, motion: next,
    changedPaths: Object.freeze([current.store ? `/relationActions/definitions/${nextIndex}` : "/relationActions"]),
    beforeStoreSha256: current.storeSha256, afterStoreSha256: canonicalJsonSha256(store), definitionSha256: canonicalJsonSha256(definition),
  });
}

/** Removes exactly one definition and never searches for or mutates already materialized output. */
export function removeMotionRelationActionDefinition(motion: MotionDocument, input: unknown): MotionRelationActionDefinitionMutation {
  const definitionId = readMotionRelationActionDefinitionRemove(input);
  assertValidRelationActionDocument(motion, "Relation action remove source");
  const current = inspectMotionRelationActions(motion);
  if (!current.store) throw new Error(`Relation action '${definitionId}' is absent.`);
  const index = current.store.definitions.findIndex((definition) => definition.id === definitionId);
  if (index < 0) throw new Error(`Relation action '${definitionId}' is absent.`);
  const definitions = current.store.definitions.filter((_, candidate) => candidate !== index);
  const next = definitions.length ? withStore(motion, readMotionRelationActionStore({ schema: MOTION_RELATION_ACTIONS_PUBLIC_SCHEMA, definitions })) : withoutStore(motion);
  assertValidRelationActionDocument(next, "Relation action remove output");
  return freezeWithMutableMotion({
    action: "removed", definitionId, motion: next,
    changedPaths: Object.freeze(definitions.length ? [`/relationActions/definitions/${index}`] : ["/relationActions"]),
    beforeStoreSha256: current.storeSha256,
    afterStoreSha256: definitions.length ? canonicalJsonSha256(next.relationActions) : null,
    definitionSha256: null,
  });
}

/**
 * Compiles and applies exactly one public definition. The request is ephemeral; the output contains
 * only ordinary Motion layers/tracks/transitions and concrete relations@1 bindings.
 */
export function applyMotionRelationAction(motion: MotionDocument, requestValue: unknown): MotionRelationActionApplyResult {
  const request = readMotionRelationActionApplyRequest(requestValue);
  toMs(request.startAtUs, "Relation action apply.startAtUs");
  const sourceMotionSha256 = canonicalJsonSha256(motion);
  if (sourceMotionSha256 !== request.expectedMotionSha256) throw new Error("Relation action apply has stale expectedMotionSha256.");
  const inspection = inspectMotionRelationActions(motion);
  if (!inspection.store || !inspection.storeSha256) throw new Error("Motion document has no persisted relation-actions@2 store.");
  if (inspection.storeSha256 !== request.expectedStoreSha256) throw new Error("Relation action apply has stale expectedStoreSha256.");
  const definition = inspection.store.definitions.find((candidate) => candidate.id === request.definitionId);
  if (!definition) throw new Error(`Unknown relation action '${request.definitionId}'.`);
  const definitionSha256 = canonicalJsonSha256(definition);
  if (definitionSha256 !== request.expectedDefinitionSha256) throw new Error(`Relation action '${definition.id}' has stale expectedDefinitionSha256.`);
  assertValidRelationActionDocument(motion, "Relation action apply source");

  const sourceGroupGraph = readMotionGroupGraph(motion);
  const roles = resolveRoles(definition, request.roleBindings, motion.layers);
  const parameters = resolveParameters(definition, request.parameterValues);
  const templateIds = new Map(definition.templateLayers.map((template) => [template.id, stableId("layer", definitionSha256, request.instanceId, template.id)]));
  const resolveRef = (ref: MotionRelationActionLayerRef): string => ref.source === "role" ? roles[ref.roleId]! : templateIds.get(ref.templateLayerId)!;

  const prototypePlan = planTemplateObjects(motion, definition, request, templateIds, resolveRef, sourceGroupGraph);
  const sequence = planSequence(motion, definition, request, definitionSha256, parameters, resolveRef, prototypePlan.absoluteStartMs, prototypePlan.layersById, sourceGroupGraph);
  assertMotionRelationActionApplyCaps({ objects: prototypePlan.layers.length, relations: sequence.relations.length, keyframeWrites: sequence.keyframeWrites });
  if (prototypePlan.layers.length === 0 && sequence.relations.length === 0 && sequence.keyframeWrites === 0) throw new Error("Relation action apply must materialize at least one ordinary change.");
  const existingRelationIds = new Set((motion.relations?.bindings ?? []).map((binding) => binding.id));
  const collidingRelation = sequence.relations.find((entry) => existingRelationIds.has(entry.binding.id));
  if (collidingRelation) throw new Error(`Relation action instance '${request.instanceId}' collides with existing relation '${collidingRelation.binding.id}'.`);
  if (existingRelationIds.size + sequence.relations.length > 32) throw new Error("Relation action apply exceeds the document relation-binding limit.");
  assertNoExistingTransformAuthorities(motion, sequence.keyframes, sequence.transitions);

  const editableExisting = new Set<string>([...prototypePlan.parentRoleGroupIds, ...sequence.existingEditableLayerIds]);
  assertEditableLayers(motion, sourceGroupGraph, editableExisting);

  // Typed operations return detached records. This candidate is validated before any package COW.
  let next: MotionDocument = { ...motion, layers: applyTemplateObjects(motion.layers, prototypePlan.layers, prototypePlan.parentRoleChildren) };
  for (const operation of sequence.keyframes) next = replaceLayer(next, operation.layerId, upsertLayerKeyframe(requireLayer(next, operation.layerId), operation.input).layer);
  for (const operation of sequence.transitions) {
    const applied = applyTransitionPresetToLayer(requireLayer(next, operation.layerId), operation.presetId, { durationMs: operation.durationMs });
    if (!applied.ok) throw new Error(`Relation action transition '${operation.stepId}' refused: ${applied.error}`);
    next = replaceLayer(next, operation.layerId, applied.layer);
  }
  if (sequence.relations.length) {
    const bindings = [...(next.relations?.bindings ?? []), ...sequence.relations.map((entry) => entry.binding)].sort((left, right) => compareCodeUnits(left.id, right.id));
    next.relations = readMotionRelationStore({ schema: "shellx-motion/relations@1", bindings });
  }

  // Group, behavior, procedural, relation and schema authority all run before compositing output.
  readMotionGroupGraph(next);
  const relationValidation = validateMotionRelations(next.relations, next);
  if (!relationValidation.ok) throw new Error(`Relation action apply relations invalid at ${relationValidation.issues[0]!.path}: ${relationValidation.issues[0]!.message}`);
  const beforeStatic = compileMotionRelationStaticPlan(motion);
  if (!beforeStatic.ok) throw new Error(beforeStatic.message);
  assertValidRelationActionDocument(next, "Relation action apply candidate");
  // This is intentionally before generic compositing lowering: an uncompiled compositing graph
  // may add deterministic compiler metadata even when the requested ordinary edit is identical.
  if (canonicalJsonSha256(next) === sourceMotionSha256) throw new Error("Relation action apply did not materialize an ordinary change.");
  const compiled = compileMotionDocumentCompositing(next);
  assertValidRelationActionDocument(compiled, "Relation action apply output");
  const afterStatic = compileMotionRelationStaticPlan(compiled);
  if (!afterStatic.ok) throw new Error(afterStatic.message);
  const outputMotionSha256 = canonicalJsonSha256(compiled);
  if (outputMotionSha256 === sourceMotionSha256) throw new Error("Relation action apply did not materialize an ordinary change.");

  const requestSha256 = canonicalJsonSha256(request);
  const counts = freeze({ objects: prototypePlan.layers.length, relations: sequence.relations.length, keyframeWrites: sequence.keyframeWrites });
  const planPayload = {
    schema: MOTION_RELATION_ACTION_APPLY_PLAN_SCHEMA,
    sourceMotionSha256,
    storeSha256: inspection.storeSha256,
    definition: { id: definition.id, sha256: definitionSha256 },
    requestSha256,
    instance: { id: request.instanceId, startAtUs: request.startAtUs, roleBindings: freezeRecord(roles), parameterValues: freezeRecord(parameters) },
    counts,
  };
  const plan = freeze({ ...planPayload, fingerprint: canonicalJsonSha256(planPayload) }) as MotionRelationActionApplyPlan;
  const changedPaths = Object.freeze([
    ...prototypePlan.layers.map((layer) => `/layers/${layer.id}`),
    ...prototypePlan.parentRoleGroupIds.map((id) => `/layers/${id}/childLayerIds`),
    ...sequence.keyframes.map((entry) => `/layers/${entry.layerId}/keyframes/${entry.input.target}/${entry.input.atMs}`),
    ...sequence.transitions.map((entry) => `/layers/${entry.layerId}/transitions`),
    ...sequence.relations.map((entry) => `/relations/bindings/${entry.binding.id}`),
  ]);
  return freezeWithMutableMotion({
    action: "applied", definitionId: definition.id, motion: compiled, plan, changedPaths,
    createdObjectIds: Object.freeze(prototypePlan.layers.map((layer) => layer.id)),
    relationIds: Object.freeze(sequence.relations.map((entry) => entry.binding.id)),
    beforeRelationStaticFingerprint: beforeStatic.plan.fingerprint,
    afterRelationStaticFingerprint: afterStatic.plan.fingerprint,
    outputMotionSha256,
  });
}

function planTemplateObjects(
  motion: MotionDocument,
  definition: MotionRelationActionDefinition,
  request: MotionRelationActionApplyRequest,
  templateIds: ReadonlyMap<string, string>,
  resolveRef: (ref: MotionRelationActionLayerRef) => string,
  graph: ReturnType<typeof readMotionGroupGraph>,
): {
  layers: MotionLayer[];
  layersById: ReadonlyMap<string, MotionLayer>;
  absoluteStartMs: ReadonlyMap<string, number>;
  parentRoleChildren: ReadonlyMap<string, string[]>;
  parentRoleGroupIds: readonly string[];
} {
  const existingIds = new Set(motion.layers.map((layer) => layer.id));
  const templateById = new Map(definition.templateLayers.map((template) => [template.id, template]));
  const childIdsByTemplateGroup = new Map<string, string[]>();
  const parentRoleChildren = new Map<string, string[]>();
  for (const template of definition.templateLayers) {
    if (!template.parent) continue;
    const childId = templateIds.get(template.id)!;
    if (template.parent.source === "template") {
      const parent = templateById.get(template.parent.templateLayerId)!;
      if (parent.layer.type !== "group") throw new Error(`Relation action template '${template.id}' parent must be a group.`);
      childIdsByTemplateGroup.set(parent.id, [...(childIdsByTemplateGroup.get(parent.id) ?? []), childId]);
    } else {
      const parentId = resolveRef(template.parent);
      const parent = graph.byId.get(parentId);
      if (!parent || parent.type !== "group") throw new Error(`Relation action template '${template.id}' parent role must bind an existing group.`);
      parentRoleChildren.set(parentId, [...(parentRoleChildren.get(parentId) ?? []), childId]);
    }
  }
  const absoluteStartMs = new Map<string, number>();
  const resolveAbsoluteStart = (templateId: string): number => {
    const cached = absoluteStartMs.get(templateId); if (cached !== undefined) return cached;
    const template = templateById.get(templateId)!;
    const startUs = template.layer.startUs;
    let value: number;
    if (!template.parent) value = toMs(addUs(request.startAtUs, startUs, `Relation action template '${template.id}' start`), `Relation action template '${template.id}' startUs`);
    else if (template.parent.source === "template") value = resolveAbsoluteStart(template.parent.templateLayerId) + toMs(startUs, `Relation action template '${template.id}' startUs`);
    else value = toMs(addUs(request.startAtUs, startUs, `Relation action template '${template.id}' start`), `Relation action template '${template.id}' startUs`);
    absoluteStartMs.set(templateId, value); return value;
  };
  const layers: MotionLayer[] = [];
  for (const template of definition.templateLayers) {
    const id = templateIds.get(template.id)!;
    if (existingIds.has(id)) throw new Error(`Relation action instance '${request.instanceId}' collides with existing layer '${id}'.`);
    existingIds.add(id);
    const prototype = template.layer;
    const durationMs = toMs(prototype.durationUs, `Relation action template '${template.id}' durationUs`);
    const absolute = resolveAbsoluteStart(template.id);
    const localStartMs = !template.parent
      ? absolute
      : template.parent.source === "template"
        ? toMs(prototype.startUs, `Relation action template '${template.id}' startUs`)
        : absolute - absoluteLayerStart(graph, resolveRef(template.parent));
    if (!Number.isSafeInteger(localStartMs) || localStartMs < 0) throw new Error(`Relation action template '${template.id}' starts outside its role-group local timeline.`);
    const layer = prototypeLayer(id, prototype, localStartMs, durationMs, childIdsByTemplateGroup.get(template.id));
    if (!template.parent && absolute + durationMs > motion.durationMs) throw new Error(`Relation action template '${template.id}' exceeds document duration.`);
    if (template.parent?.source === "role") {
      const parent = graph.byId.get(resolveRef(template.parent))!;
      if (localStartMs + durationMs > parent.durationMs) throw new Error(`Relation action template '${template.id}' does not fit parent group '${parent.id}'.`);
    }
    layers.push(layer);
  }
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  for (const template of definition.templateLayers) {
    if (template.parent?.source !== "template") continue;
    const parent = layerById.get(templateIds.get(template.parent.templateLayerId)!);
    const child = layerById.get(templateIds.get(template.id)!);
    if (!parent || !child || parent.type !== "group") throw new Error(`Relation action template '${template.id}' has an invalid template-group parent.`);
    if (child.startMs + child.durationMs > parent.durationMs) throw new Error(`Relation action template '${template.id}' does not fit template group '${template.parent.templateLayerId}'.`);
  }
  for (const template of definition.templateLayers) {
    if (template.layer.type === "group" && (childIdsByTemplateGroup.get(template.id)?.length ?? 0) === 0) {
      throw new Error(`Relation action group template '${template.id}' must own at least one template child.`);
    }
  }
  return {
    layers, layersById: new Map(layers.map((layer) => [layer.id, layer])), absoluteStartMs,
    parentRoleChildren, parentRoleGroupIds: Object.freeze([...parentRoleChildren.keys()].sort(compareCodeUnits)),
  };
}

function prototypeLayer(id: string, prototype: MotionRelationActionLayerPrototype, startMs: number, durationMs: number, childLayerIds?: readonly string[]): MotionLayer {
  const common = { id, type: prototype.type, startMs, durationMs, ...(prototype.name ? { name: prototype.name } : {}), ...(prototype.visible === undefined ? {} : { visible: prototype.visible }), ...(prototype.transform ? { transform: { ...prototype.transform } } : {}) };
  if (prototype.type === "group") return { ...common, type: "group", childLayerIds: [...(childLayerIds ?? [])] };
  return { ...common, type: "shape", shape: prototype.shape, fill: prototype.fill, ...(prototype.stroke ? { style: { stroke: prototype.stroke, ...(prototype.strokeWidth === undefined ? {} : { strokeWidth: prototype.strokeWidth }) } } : {}) };
}

function applyTemplateObjects(source: readonly MotionLayer[], created: readonly MotionLayer[], parentRoleChildren: ReadonlyMap<string, string[]>): MotionLayer[] {
  const parentChildren = new Map([...parentRoleChildren.entries()].map(([id, children]) => [id, [...children]]));
  const next = source.map((layer) => {
    const children = parentChildren.get(layer.id);
    return children ? { ...layer, childLayerIds: [...(layer.childLayerIds ?? []), ...children] } : layer;
  });
  return [...next, ...created];
}
function replaceLayer(motion: MotionDocument, layerId: string, layer: MotionLayer): MotionDocument { return { ...motion, layers: motion.layers.map((candidate) => candidate.id === layerId ? layer : candidate) }; }
function requireLayer(motion: MotionDocument, layerId: string): MotionLayer { const layer = motion.layers.find((candidate) => candidate.id === layerId); if (!layer) throw new Error(`Motion layer '${layerId}' is absent.`); return layer; }

/** Lifecycle revisions are detached from their source before authoring metadata is changed. */
function withStore(motion: MotionDocument, relationActions: MotionRelationActionStore): MotionDocument {
  const next = structuredClone(motion);
  next.relationActions = relationActions;
  return next;
}
function withoutStore(motion: MotionDocument): MotionDocument {
  const next = structuredClone(motion);
  delete next.relationActions;
  return next;
}
function assertValidRelationActionDocument(motion: MotionDocument, label: string): void {
  const validation = validateDocumentSync(loadSchemaSync("motion"), motion);
  if (validation.ok) return;
  const first = validation.errors[0];
  throw new Error(`${label} is not a valid Motion document: ${first?.path ?? "/motion"} ${first?.message ?? "unknown validation error"}.`);
}
function assertNoExistingTransformAuthorities(motion: MotionDocument, keyframes: readonly { layerId: string; input: { target: string } }[], transitions: readonly { layerId: string; keyframeTargets: readonly string[] }[]): void {
  const writes = [
    ...keyframes.map((operation) => ({ layerId: operation.layerId, target: operation.input.target })),
    ...transitions.flatMap((operation) => operation.keyframeTargets.map((target) => ({ layerId: operation.layerId, target }))),
  ];
  for (const operation of writes) {
    if (!operation.target.startsWith("transform.")) continue;
    const behavior = motion.behaviors?.bindings.find((binding) => binding.targetLayerId === operation.layerId);
    if (behavior) throw new Error(`Relation action keyframe '${operation.target}' conflicts with behavior authority on '${operation.layerId}'.`);
    const procedural = motion.relationships?.relationships.find((relationship) => relationship.target.layerId === operation.layerId && relationship.target.property === operation.target);
    if (procedural) throw new Error(`Relation action keyframe '${operation.target}' conflicts with procedural authority on '${operation.layerId}'.`);
  }
}
function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> { return Object.freeze({ ...value }); }
function freezeWithMutableMotion<T extends { motion: MotionDocument }>(value: T): T {
  const { motion, ...facts } = value; freeze(facts); return Object.freeze({ ...facts, motion }) as T;
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
