import type { MotionDocument, MotionLayer, MotionTrack } from "./types";
import {
  absoluteLayerStart,
  assertChildFitsGroup,
  assertChildList,
  assertEditableLayers,
  cloneLayer,
  expandedDocumentDuration,
  isGroupDescendant,
  orderedDirectChildren,
  readMotionGroupGraph,
  replaceLayer,
  requireGroup,
  requireInsertionIndex,
  requireLayer,
  requireReorderIndex
} from "./motion-group-structural-support";
import type {
  MotionGroupChildAddInput,
  MotionGroupChildAddResult,
  MotionGroupChildMoveInput,
  MotionGroupChildMoveResult,
  MotionGroupChildRemoveInput,
  MotionGroupChildRemoveResult,
  MotionGroupChildReorderInput,
  MotionGroupChildReorderResult,
  MotionGroupCreateInput,
  MotionGroupCreateResult,
  MotionGroupWrapInput,
  MotionGroupWrapResult
} from "./motion-group-structural-types";

/** Creates a group from existing unowned local-timeline children; it never adopts an existing owner. */
export function createMotionGroup(motion: MotionDocument, input: MotionGroupCreateInput): MotionGroupCreateResult {
  const graph = readMotionGroupGraph(motion);
  const group = cloneLayer(input.group);
  if (group.type !== "group") throw new Error("Motion group create requires group.type to be 'group'.");
  if (!isNonEmptyString(group.id)) throw new Error("Motion group id is required.");
  if (!isNonNegativeFinite(group.startMs) || !isPositiveFinite(group.durationMs)) {
    throw new Error("Motion group requires non-negative startMs and positive durationMs.");
  }
  group.id = group.id.trim();
  if (graph.byId.has(group.id)) throw new Error(`Motion layer id already exists: ${group.id}.`);
  const childLayerIds = assertChildList(group.childLayerIds ?? []);
  group.childLayerIds = childLayerIds;
  for (const childLayerId of childLayerIds) {
    const child = requireLayer(graph, childLayerId);
    if (graph.parentByChildId.has(childLayerId)) throw new Error(`Child layer ${childLayerId} already has a group owner; use an explicit move.`);
    assertChildFitsGroup(group, child);
  }
  assertEditableLayers(motion, graph, childLayerIds);

  const parentGroupId = input.parentGroupId?.trim() || null;
  const parent = parentGroupId ? requireGroup(graph, parentGroupId) : null;
  if (parent) {
    assertEditableLayers(motion, graph, [parent.id]);
    assertChildFitsGroup(parent, group);
  }
  const layerIndex = requireInsertionIndex(input.layerIndex, motion.layers.length, "Group layerIndex");
  const parentChildIds = parent ? [...(parent.childLayerIds ?? [])] : null;
  const childIndex = parentChildIds ? requireInsertionIndex(input.childIndex, parentChildIds.length, "Group childIndex") : null;
  if (parentChildIds && childIndex !== null) parentChildIds.splice(childIndex, 0, group.id);

  const tracked = insertGroupTrackReference(motion, group, input.trackIndex);
  const layers = parent && parentChildIds
    ? replaceLayer(motion, parent.id, { ...parent, childLayerIds: parentChildIds })
    : [...motion.layers];
  layers.splice(layerIndex, 0, group);
  const nextMotion: MotionDocument = {
    ...motion,
    layers,
    ...(tracked.tracks ? { tracks: tracked.tracks } : {})
  };
  const expandedDurationMs = expandedDocumentDuration(nextMotion);
  const changedPaths = [`/layers/${group.id}`];
  if (parent) changedPaths.push(`/layers/${parent.id}/childLayerIds`);
  changedPaths.push(...tracked.changedPaths);
  if (expandedDurationMs !== motion.durationMs) {
    nextMotion.durationMs = expandedDurationMs;
    changedPaths.push("/durationMs");
  }
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths, action: "created", groupId: group.id, parentGroupId, childLayerIds, group };
}

/** Adds an explicitly unowned child without changing its local time. Use moveMotionGroupChild to preserve absolute time. */
export function addMotionGroupChild(motion: MotionDocument, input: MotionGroupChildAddInput): MotionGroupChildAddResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  const child = requireLayer(graph, requiredId(input.childLayerId, "Child layer id"));
  if (graph.parentByChildId.has(child.id)) throw new Error(`Child layer ${child.id} already has a group owner; use an explicit move.`);
  if (child.type === "group" && isGroupDescendant(graph, child.id, group.id)) {
    throw new Error(`Adding group ${child.id} to ${group.id} would create a cycle.`);
  }
  assertEditableLayers(motion, graph, [group.id, child.id]);
  assertChildFitsGroup(group, child);
  const childLayerIds = [...(group.childLayerIds ?? [])];
  const index = requireInsertionIndex(input.index, childLayerIds.length, "Group child index");
  childLayerIds.splice(index, 0, child.id);
  const nextMotion = { ...motion, layers: replaceLayer(motion, group.id, { ...group, childLayerIds }) };
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths: [`/layers/${group.id}/childLayerIds`], action: "child-added", groupId: group.id, childLayerId: child.id, index };
}

/** Removes a child to the root and rebases it to the same absolute document time. */
export function removeMotionGroupChild(motion: MotionDocument, input: MotionGroupChildRemoveInput): MotionGroupChildRemoveResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  const child = requireLayer(graph, requiredId(input.childLayerId, "Child layer id"));
  const childLayerIds = [...(group.childLayerIds ?? [])];
  if (!childLayerIds.includes(child.id)) throw new Error(`Group ${group.id} does not own child layer ${child.id}.`);
  if (childLayerIds.length === 1) throw new Error(`Cannot remove the final child from group ${group.id}; unwrap or delete it explicitly.`);
  assertEditableLayers(motion, graph, [group.id, child.id]);
  const oldLocalStartMs = child.startMs;
  const newRootStartMs = absoluteLayerStart(graph, child.id);
  const nextGroup = { ...group, childLayerIds: childLayerIds.filter((childLayerId) => childLayerId !== child.id) };
  const nextChild = { ...cloneLayer(child), startMs: newRootStartMs };
  const layers = motion.layers.map((layer) => {
    if (layer.id === group.id) return nextGroup;
    if (layer.id === child.id) return nextChild;
    return layer;
  });
  const nextMotion = { ...motion, layers };
  const changedPaths = [`/layers/${group.id}/childLayerIds`];
  if (oldLocalStartMs !== newRootStartMs) changedPaths.push(`/layers/${child.id}/startMs`);
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths, action: "child-removed", groupId: group.id, childLayerId: child.id, oldLocalStartMs, newRootStartMs };
}

/** Moves an explicitly named direct child between parents while preserving its absolute time. */
export function moveMotionGroupChild(motion: MotionDocument, input: MotionGroupChildMoveInput): MotionGroupChildMoveResult {
  const graph = readMotionGroupGraph(motion);
  const child = requireLayer(graph, requiredId(input.childLayerId, "Child layer id"));
  const sourceGroupId = input.sourceGroupId === null ? null : requiredId(input.sourceGroupId, "Source group id");
  const destination = requireGroup(graph, requiredId(input.destinationGroupId, "Destination group id"));
  if (sourceGroupId === destination.id) throw new Error("Source and destination groups must be distinct.");
  const actualParentId = graph.parentByChildId.get(child.id) ?? null;
  if (actualParentId !== sourceGroupId) throw new Error(`Child layer ${child.id} is not directly owned by the declared source.`);
  const source = sourceGroupId ? requireGroup(graph, sourceGroupId) : null;
  if (source && (source.childLayerIds?.length ?? 0) === 1) throw new Error(`Cannot move the final child from group ${source.id}; unwrap or delete it explicitly.`);
  if (child.type === "group" && isGroupDescendant(graph, child.id, destination.id)) {
    throw new Error(`Moving group ${child.id} to ${destination.id} would create a cycle.`);
  }
  assertEditableLayers(motion, graph, [child.id, destination.id, ...(source ? [source.id] : [])]);
  const oldLocalStartMs = child.startMs;
  const newLocalStartMs = absoluteLayerStart(graph, child.id) - absoluteLayerStart(graph, destination.id);
  const rebasedChild = { ...cloneLayer(child), startMs: newLocalStartMs };
  assertChildFitsGroup(destination, rebasedChild);
  const destinationChildIds = [...(destination.childLayerIds ?? [])];
  const index = requireInsertionIndex(input.index, destinationChildIds.length, "Destination child index");
  destinationChildIds.splice(index, 0, child.id);
  let layers = replaceLayer(motion, destination.id, { ...destination, childLayerIds: destinationChildIds });
  if (source) layers = replaceLayer({ ...motion, layers }, source.id, { ...source, childLayerIds: (source.childLayerIds ?? []).filter((id) => id !== child.id) });
  layers = replaceLayer({ ...motion, layers }, child.id, rebasedChild);
  const nextMotion = { ...motion, layers };
  const changedPaths = [
    ...(source ? [`/layers/${source.id}/childLayerIds`] : []),
    `/layers/${destination.id}/childLayerIds`,
    ...(oldLocalStartMs !== newLocalStartMs ? [`/layers/${child.id}/startMs`] : [])
  ];
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths, action: "child-moved", childLayerId: child.id, sourceGroupId, destinationGroupId: destination.id, oldLocalStartMs, newLocalStartMs, index };
}

export function reorderMotionGroupChild(motion: MotionDocument, input: MotionGroupChildReorderInput): MotionGroupChildReorderResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  const child = requireLayer(graph, requiredId(input.childLayerId, "Child layer id"));
  const childLayerIds = [...(group.childLayerIds ?? [])];
  const oldIndex = childLayerIds.indexOf(child.id);
  if (oldIndex === -1) throw new Error(`Group ${group.id} does not own child layer ${child.id}.`);
  const newIndex = requireReorderIndex(input.index, childLayerIds.length, "Group child index");
  if (oldIndex === newIndex) throw new Error("Group child order did not change.");
  assertEditableLayers(motion, graph, [group.id, child.id]);
  childLayerIds.splice(oldIndex, 1);
  childLayerIds.splice(newIndex, 0, child.id);
  const nextMotion = { ...motion, layers: replaceLayer(motion, group.id, { ...group, childLayerIds }) };
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths: [`/layers/${group.id}/childLayerIds`], action: "child-reordered", groupId: group.id, childLayerId: child.id, oldIndex, newIndex };
}

/** Wraps root siblings or siblings in one group, deriving local timing rather than guessing a reparent. */
export function wrapMotionGroupSelection(motion: MotionDocument, input: MotionGroupWrapInput): MotionGroupWrapResult {
  const graph = readMotionGroupGraph(motion);
  const seed = cloneLayer(input.group as MotionLayer);
  rejectDerivedGroupFields(seed);
  if (!isNonEmptyString(seed.id)) throw new Error("Wrapped group id is required.");
  seed.id = seed.id.trim();
  if (graph.byId.has(seed.id)) throw new Error(`Motion layer id already exists: ${seed.id}.`);
  const selectedIds = assertChildList(input.childLayerIds);
  const parents = new Set(selectedIds.map((childLayerId) => graph.parentByChildId.get(childLayerId) ?? null));
  if (parents.size !== 1) throw new Error("Wrapped layers must share one direct group owner or all be root layers.");
  const parentGroupId = [...parents][0] ?? null;
  const parent = parentGroupId ? requireGroup(graph, parentGroupId) : null;
  const order = orderedDirectChildren(motion, graph, parentGroupId);
  const selected = order.filter((layerId) => selectedIds.includes(layerId));
  if (selected.length !== selectedIds.length) throw new Error("Wrapped layers must be direct siblings in their declared owner order.");
  const firstSelectedIndex = order.indexOf(selected[0]);
  const lastSelectedIndex = order.indexOf(selected[selected.length - 1]);
  if (lastSelectedIndex - firstSelectedIndex + 1 !== selected.length) {
    throw new Error("Wrapped layers must be one contiguous range of direct siblings.");
  }
  assertEditableLayers(motion, graph, [...selected, ...(parent ? [parent.id] : [])]);
  const children = selected.map((childLayerId) => requireLayer(graph, childLayerId));
  const startMs = Math.min(...children.map((child) => child.startMs));
  const durationMs = Math.max(...children.map((child) => child.startMs + child.durationMs)) - startMs;
  const group: MotionLayer = { ...seed, type: "group", startMs, durationMs, childLayerIds: selected };
  if (parent) assertChildFitsGroup(parent, group);
  const selectedSet = new Set(selected);
  let layers = motion.layers.map((layer) => selectedSet.has(layer.id) ? { ...cloneLayer(layer), startMs: layer.startMs - startMs } : layer);
  if (parent) {
    const childLayerIds = [...(parent.childLayerIds ?? [])];
    const firstIndex = childLayerIds.indexOf(selected[0]);
    const nextChildIds = childLayerIds.filter((childLayerId) => !selectedSet.has(childLayerId));
    nextChildIds.splice(firstIndex, 0, group.id);
    layers = replaceLayer({ ...motion, layers }, parent.id, { ...parent, childLayerIds: nextChildIds });
  }
  const firstLayerIndex = graph.layerIndexById.get(selected[0]);
  if (firstLayerIndex === undefined) throw new Error("Wrapped selection has no layer-store position.");
  layers.splice(firstLayerIndex, 0, group);
  const nextMotion = { ...motion, layers };
  const changedPaths = [`/layers/${group.id}`, ...(parent ? [`/layers/${parent.id}/childLayerIds`] : [])];
  for (const child of children) if (child.startMs !== child.startMs - startMs) changedPaths.push(`/layers/${child.id}/startMs`);
  readMotionGroupGraph(nextMotion);
  return { motion: nextMotion, changedPaths, action: "wrapped", groupId: group.id, parentGroupId, childLayerIds: selected, group };
}

function insertGroupTrackReference(motion: MotionDocument, group: MotionLayer, requestedIndex: number | undefined): {
  tracks: MotionTrack[] | undefined;
  changedPaths: string[];
} {
  if (group.trackId === undefined) return { tracks: undefined, changedPaths: [] };
  if (!isNonEmptyString(group.trackId)) throw new Error("Motion group trackId must be a non-empty string when provided.");
  const trackIndex = (motion.tracks ?? []).findIndex((track) => track.id === group.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${group.trackId}.`);
  const track = (motion.tracks ?? [])[trackIndex];
  if (track.locked) throw new Error(`Cannot create group on locked track: ${track.id}.`);
  const layerIds = [...(track.layerIds ?? [])];
  const insertionIndex = requireInsertionIndex(requestedIndex, layerIds.length, "Group trackIndex");
  layerIds.splice(insertionIndex, 0, group.id);
  return {
    tracks: (motion.tracks ?? []).map((candidate, index) => index === trackIndex ? { ...candidate, layerIds } : cloneTrack(candidate)),
    changedPaths: [`/tracks/${trackIndex}/layerIds`]
  };
}

function rejectDerivedGroupFields(seed: MotionLayer): void {
  for (const field of ["type", "startMs", "durationMs", "childLayerIds"] as const) {
    if (Object.prototype.hasOwnProperty.call(seed, field)) throw new Error(`Wrapped group must not provide derived ${field}.`);
  }
  if (seed.trackId !== undefined) throw new Error("Wrapped group trackId is not supported before the timeline-track join.");
}

function cloneTrack(track: MotionTrack): MotionTrack {
  return { ...track, ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}) };
}

function requiredId(value: unknown, label: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${label} is required.`);
  return value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
