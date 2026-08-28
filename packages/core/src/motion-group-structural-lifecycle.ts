import type { MotionDocument, MotionLayer } from "./types";
import { assertMotionLayerCloneBoundary } from "./motion-layer-clone-boundary";
import {
  assertChildFitsGroup,
  assertEditableLayers,
  cloneLayer,
  expandedDocumentDuration,
  firstAvailableCloneId,
  groupSubtreeLayerIds,
  readMotionGroupGraph,
  requireGroup,
  withDuplicatedTrackReferences,
  withRemovedTrackReferences
} from "./motion-group-structural-support";
import type {
  MotionGroupDeleteDispatchInput,
  MotionGroupDeleteInput,
  MotionGroupDeleteResult,
  MotionGroupDuplicateInput,
  MotionGroupDuplicateResult,
  MotionGroupUnwrapInput,
  MotionGroupUnwrapResult
} from "./motion-group-structural-types";

/**
 * Removes only a visual-neutral container. A transform/effect/matte/keyframe on a group cannot be
 * flattened into its children without a composition implementation, so this refuses before write.
 */
export function unwrapMotionGroup(motion: MotionDocument, input: MotionGroupUnwrapInput): MotionGroupUnwrapResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  assertUnwrappableGroup(group);
  const childLayerIds = [...(group.childLayerIds ?? [])];
  const parentGroupId = graph.parentByChildId.get(group.id) ?? null;
  const parent = parentGroupId ? requireGroup(graph, parentGroupId) : null;
  assertNoExternalReferencesToRemovedLayers(motion, new Set([group.id]), "unwrap");
  assertEditableLayers(motion, graph, [group.id, ...childLayerIds, ...(parent ? [parent.id] : [])]);

  const childSet = new Set(childLayerIds);
  const groupIndex = graph.layerIndexById.get(group.id);
  if (groupIndex === undefined) throw new Error(`Motion group ${group.id} has no layer-store position.`);
  const newChildLayers = childLayerIds.map((childLayerId) => {
    const child = graph.byId.get(childLayerId);
    if (!child) throw new Error(`Motion group ${group.id} references missing child ${childLayerId}.`);
    return { ...cloneLayer(child), startMs: group.startMs + child.startMs };
  });
  const layersBeforeGroup = motion.layers.slice(0, groupIndex).filter((layer) => !childSet.has(layer.id));
  const layersAfterGroup = motion.layers.slice(groupIndex + 1).filter((layer) => !childSet.has(layer.id));
  let layers = [...layersBeforeGroup, ...newChildLayers, ...layersAfterGroup];
  const changedPaths = [`/layers/${group.id}`];
  for (const childLayerId of childLayerIds) changedPaths.push(`/layers/${childLayerId}/startMs`);

  if (parent) {
    const parentChildren = [...(parent.childLayerIds ?? [])];
    const groupChildIndex = parentChildren.indexOf(group.id);
    if (groupChildIndex === -1) throw new Error(`Owning group ${parent.id} lost child ${group.id}.`);
    const nextChildLayerIds = [...parentChildren.slice(0, groupChildIndex), ...childLayerIds, ...parentChildren.slice(groupChildIndex + 1)];
    layers = layers.map((layer) => layer.id === parent.id ? { ...parent, childLayerIds: nextChildLayerIds } : layer);
    changedPaths.push(`/layers/${parent.id}/childLayerIds`);
  }
  const tracks = withRemovedTrackReferences(motion, new Set([group.id]));
  changedPaths.push(...tracks.changedPaths);
  const nextMotion: MotionDocument = {
    ...motion,
    layers,
    ...(tracks.tracks ? { tracks: tracks.tracks } : {})
  };
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths, action: "unwrapped", groupId: group.id, parentGroupId, childLayerIds };
}

/** Cascades through the explicitly targeted ownership subtree; it never turns children into roots. */
export function deleteMotionGroupSubtree(motion: MotionDocument, input: MotionGroupDeleteInput): MotionGroupDeleteResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  const deletedLayerIds = groupSubtreeLayerIds(graph, group.id);
  const deletedIds = new Set(deletedLayerIds);
  const parentGroupId = graph.parentByChildId.get(group.id) ?? null;
  const parent = parentGroupId ? requireGroup(graph, parentGroupId) : null;
  if (parent && (parent.childLayerIds?.length ?? 0) === 1) {
    throw new Error(`Cannot cascade-delete the final child of group ${parent.id}; delete that parent or unwrap its child explicitly.`);
  }
  assertNoExternalReferencesToRemovedLayers(motion, deletedIds, "cascade-delete");
  assertEditableLayers(motion, graph, [...deletedLayerIds, ...(parent ? [parent.id] : [])]);
  let layers = motion.layers.filter((layer) => !deletedIds.has(layer.id));
  const changedPaths = deletedLayerIds.map((layerId) => `/layers/${layerId}`);
  if (parent) {
    layers = layers.map((layer) => layer.id === parent.id
      ? { ...parent, childLayerIds: (parent.childLayerIds ?? []).filter((childLayerId) => childLayerId !== group.id) }
      : layer);
    changedPaths.push(`/layers/${parent.id}/childLayerIds`);
  }
  const tracks = withRemovedTrackReferences(motion, deletedIds);
  changedPaths.push(...tracks.changedPaths);
  const nextMotion: MotionDocument = {
    ...motion,
    layers,
    ...(tracks.tracks ? { tracks: tracks.tracks } : {})
  };
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths, action: "deleted-subtree", groupId: group.id, deletedLayerIds, removedTrackRefs: tracks.removedTrackRefs };
}

/** Removing a layer cannot keep typed consumers bound to it; no replacement target is pixel-exact. */
function assertNoExternalReferencesToRemovedLayers(motion: MotionDocument, removedIds: ReadonlySet<string>, operation: string): void {
  for (const layer of motion.layers) {
    if (removedIds.has(layer.id)) continue;
    // Open extension payloads can carry an untyped layer id. Since removing a
    // target gives us no exact rewrite, fail before any write rather than
    // treating a recognized top-level field as proof of safety.
    assertMotionLayerCloneBoundary(layer, `${operation} external`);
    if (layer.matte && removedIds.has(layer.matte.sourceLayerId)) {
      throw new Error(`Cannot ${operation}: external layer ${layer.id} matte.sourceLayerId references removed layer ${layer.matte.sourceLayerId}.`);
    }
    for (const triggerLayerId of layer.ducking?.triggerLayerIds ?? []) {
      if (removedIds.has(triggerLayerId)) {
        throw new Error(`Cannot ${operation}: external layer ${layer.id} ducking.triggerLayerIds references removed layer ${triggerLayerId}.`);
      }
    }
    if (layer.environment?.sceneSourceLayerId && removedIds.has(layer.environment.sceneSourceLayerId)) {
      throw new Error(`Cannot ${operation}: external layer ${layer.id} environment.sceneSourceLayerId references removed layer ${layer.environment.sceneSourceLayerId}.`);
    }
    if (layer.environment?.effectMaskLayerId && removedIds.has(layer.environment.effectMaskLayerId)) {
      throw new Error(`Cannot ${operation}: external layer ${layer.id} environment.effectMaskLayerId references removed layer ${layer.environment.effectMaskLayerId}.`);
    }
  }
}

/** Deep-clones every owned layer and rewires every cloned group to clone ids, so no second owner exists. */
export function duplicateMotionGroupSubtree(motion: MotionDocument, input: MotionGroupDuplicateInput): MotionGroupDuplicateResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  const offsetMs = input.offsetMs ?? 0;
  if (!isNonNegativeFinite(offsetMs)) throw new Error("Group duplicate offsetMs must be a non-negative finite number.");
  const sourceLayerIds = groupSubtreeLayerIds(graph, group.id);
  const parentGroupId = graph.parentByChildId.get(group.id) ?? null;
  const parent = parentGroupId ? requireGroup(graph, parentGroupId) : null;
  assertEditableLayers(motion, graph, [...sourceLayerIds, ...(parent ? [parent.id] : [])]);
  for (const sourceLayerId of sourceLayerIds) {
    const source = graph.byId.get(sourceLayerId);
    if (!source) throw new Error(`Group clone source is missing: ${sourceLayerId}.`);
    assertCloneableLayerReferences(source);
  }

  const existingIds = new Set(graph.byId.keys());
  const cloneIdMap = new Map<string, string>();
  for (const sourceLayerId of sourceLayerIds) {
    cloneIdMap.set(sourceLayerId, firstAvailableCloneId(existingIds, sourceLayerId, sourceLayerId === group.id ? input.newGroupId : undefined));
  }
  const newGroupId = cloneIdMap.get(group.id);
  if (!newGroupId) throw new Error("Group clone id was not generated.");
  const cloneLayers = sourceLayerIds.map((sourceLayerId) => {
    const source = graph.byId.get(sourceLayerId);
    const clonedId = cloneIdMap.get(sourceLayerId);
    if (!source || !clonedId) throw new Error(`Group clone source is missing: ${sourceLayerId}.`);
    const clone = cloneLayerWithReboundReferences(source, clonedId, cloneIdMap);
    if (sourceLayerId === group.id) clone.startMs = source.startMs + offsetMs;
    return clone;
  });
  const clonedRoot = cloneLayers[0];
  if (parent) assertChildFitsGroup(parent, clonedRoot);

  let layers = [...motion.layers];
  if (parent) {
    const parentChildren = [...(parent.childLayerIds ?? [])];
    const sourceIndex = parentChildren.indexOf(group.id);
    if (sourceIndex === -1) throw new Error(`Owning group ${parent.id} lost child ${group.id}.`);
    parentChildren.splice(sourceIndex + 1, 0, newGroupId);
    layers = layers.map((layer) => layer.id === parent.id ? { ...parent, childLayerIds: parentChildren } : layer);
  }
  const sourceIndex = layers.findIndex((layer) => layer.id === group.id);
  if (sourceIndex === -1) throw new Error(`Motion group ${group.id} has no layer-store position.`);
  layers.splice(sourceIndex + 1, 0, ...cloneLayers);
  const tracks = withDuplicatedTrackReferences(motion, cloneIdMap);
  const nextMotion: MotionDocument = {
    ...motion,
    layers,
    ...(tracks.tracks ? { tracks: tracks.tracks } : {})
  };
  const expandedDurationMs = expandedDocumentDuration(nextMotion);
  const changedPaths = cloneLayers.map((layer) => `/layers/${layer.id}`);
  if (parent) changedPaths.push(`/layers/${parent.id}/childLayerIds`);
  changedPaths.push(...tracks.changedPaths);
  if (expandedDurationMs !== motion.durationMs) {
    nextMotion.durationMs = expandedDurationMs;
    changedPaths.push("/durationMs");
  }
  readMotionGroupGraph(nextMotion);
  return {
    motion: nextMotion,
    changedPaths,
    action: "duplicated-subtree",
    groupId: group.id,
    newGroupId,
    offsetMs,
    cloneIdMap: Object.fromEntries(cloneIdMap),
    insertedTrackRefs: tracks.insertedTrackRefs
  };
}

/**
 * Copies the complete layer record, then changes only references whose targets are also cloned.
 * References outside the selected subtree deliberately keep their original target.
 */
function cloneLayerWithReboundReferences(source: MotionLayer, clonedId: string, cloneIdMap: ReadonlyMap<string, string>): MotionLayer {
  const clone = cloneLayer(source);
  clone.id = clonedId;
  if (clone.type === "group") {
    clone.childLayerIds = (clone.childLayerIds ?? []).map((childLayerId) => rebindInternalLayerId(childLayerId, cloneIdMap));
  }
  if (clone.matte) {
    clone.matte = { ...clone.matte, sourceLayerId: rebindInternalLayerId(clone.matte.sourceLayerId, cloneIdMap) };
  }
  if (clone.ducking) {
    clone.ducking = { ...clone.ducking, triggerLayerIds: clone.ducking.triggerLayerIds.map((layerId) => rebindInternalLayerId(layerId, cloneIdMap)) };
  }
  if (clone.environment) {
    clone.environment = {
      ...clone.environment,
      ...(clone.environment.sceneSourceLayerId === undefined ? {} : { sceneSourceLayerId: rebindInternalLayerId(clone.environment.sceneSourceLayerId, cloneIdMap) }),
      ...(clone.environment.effectMaskLayerId === undefined ? {} : { effectMaskLayerId: rebindInternalLayerId(clone.environment.effectMaskLayerId, cloneIdMap) })
    };
  }
  return clone;
}

function rebindInternalLayerId(layerId: string, cloneIdMap: ReadonlyMap<string, string>): string {
  return cloneIdMap.get(layerId) ?? layerId;
}

/** Unknown extension payloads may contain layer references outside this typed contract. */
function assertCloneableLayerReferences(layer: MotionLayer): void {
  assertMotionLayerCloneBoundary(layer, "deep-clone");
}

/** Explicitly selects cascade deletion or visual-neutral unwrap; no child disposition is inferred. */
export function deleteMotionGroup(motion: MotionDocument, input: MotionGroupDeleteDispatchInput): MotionGroupDeleteResult | MotionGroupUnwrapResult {
  if (input.disposition === "cascade") return deleteMotionGroupSubtree(motion, input);
  if (input.disposition === "unwrap") return unwrapMotionGroup(motion, input);
  throw new Error("Group delete disposition must be 'cascade' or 'unwrap'.");
}

function assertUnwrappableGroup(group: MotionLayer): void {
  const allowed = new Set([
    "id", "name", "type", "childLayerIds", "trackId", "startMs", "durationMs", "locked",
    "visible", "opacity", "blendMode", "transform", "effects", "mask", "matte", "keyframes", "transitions"
  ]);
  for (const [key, value] of Object.entries(group as unknown as Record<string, unknown>)) {
    if (!allowed.has(key) && value !== undefined) throw new Error(`Cannot unwrap group ${group.id} with group-level ${key}; exact composition is unavailable.`);
  }
  if (group.visible === false || (group.opacity !== undefined && group.opacity !== 1)) {
    throw new Error(`Cannot unwrap group ${group.id} with non-neutral visibility or opacity.`);
  }
  if (group.blendMode !== undefined && group.blendMode !== "normal") {
    throw new Error(`Cannot unwrap group ${group.id} with non-normal blend mode.`);
  }
  if (!isIdentityTransform(group.transform) || !isEmptyRecord(group.effects) || !isEmptyRecord(group.mask) || !isEmptyRecord(group.matte)
    || !isEmptyRecord(group.keyframes) || !isEmptyRecord(group.transitions)) {
    throw new Error(`Cannot unwrap group ${group.id} with group-level visual or animated state.`);
  }
}

function isIdentityTransform(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const neutral: Record<string, number> = {
    x: 0, y: 0, z: 0, rotation: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
    skew: 0, skewX: 0, skewY: 0, scale: 1, scaleX: 1, scaleY: 1, scaleZ: 1, opacity: 1
  };
  return Object.entries(value).every(([key, current]) => key in neutral && current === neutral[key]);
}

function isEmptyRecord(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
