import type { MotionDocument, MotionLayer, MotionTrack } from "./types";
import { MOTION_GROUP_LIMITS } from "./motion-group-structural-types";

export interface MotionGroupGraph {
  byId: Map<string, MotionLayer>;
  layerIndexById: Map<string, number>;
  parentByChildId: Map<string, string>;
  childrenByGroupId: Map<string, string[]>;
}

/** Refuse corrupt ownership before a structural operation can compound it. */
export function readMotionGroupGraph(motion: MotionDocument): MotionGroupGraph {
  const byId = new Map<string, MotionLayer>();
  const layerIndexById = new Map<string, number>();
  for (const [index, layer] of motion.layers.entries()) {
    if (!isNonEmptyString(layer.id)) throw new Error(`Motion layer at index ${index} has an invalid id.`);
    if (!isNonNegativeFinite(layer.startMs) || !isPositiveFinite(layer.durationMs)) {
      throw new Error(`Motion layer ${layer.id} has invalid timing.`);
    }
    if (byId.has(layer.id)) throw new Error(`Motion layer id is duplicated: ${layer.id}.`);
    byId.set(layer.id, layer);
    layerIndexById.set(layer.id, index);
  }
  for (const track of motion.tracks ?? []) {
    for (const layerId of track.layerIds ?? []) {
      if (!byId.has(layerId)) throw new Error(`Motion track ${track.id} references missing layer ${layerId}.`);
    }
  }

  const parentByChildId = new Map<string, string>();
  const childrenByGroupId = new Map<string, string[]>();
  const groups = motion.layers.filter((layer) => layer.type === "group");
  if (groups.length > MOTION_GROUP_LIMITS.maxGroups) {
    throw new Error(`Motion document exceeds the ${MOTION_GROUP_LIMITS.maxGroups} group limit.`);
  }
  for (const group of groups) {
    const children = group.childLayerIds;
    if (!Array.isArray(children) || children.length < 1 || children.length > MOTION_GROUP_LIMITS.maxChildren) {
      throw new Error(`Group ${group.id} must own 1..${MOTION_GROUP_LIMITS.maxChildren} child layers.`);
    }
    const uniqueChildren = new Set<string>();
    for (const childId of children) {
      if (!isNonEmptyString(childId)) throw new Error(`Group ${group.id} has an invalid child layer id.`);
      if (uniqueChildren.has(childId)) throw new Error(`Group ${group.id} owns child ${childId} more than once.`);
      uniqueChildren.add(childId);
      if (childId === group.id) throw new Error(`Group ${group.id} cannot own itself.`);
      const child = byId.get(childId);
      if (!child) throw new Error(`Group ${group.id} references missing child layer ${childId}.`);
      const existingParent = parentByChildId.get(childId);
      if (existingParent) throw new Error(`Child layer ${childId} already has group owner ${existingParent}.`);
      assertChildFitsGroup(group, child);
      parentByChildId.set(childId, group.id);
    }
    childrenByGroupId.set(group.id, [...children]);
  }

  const graph = { byId, layerIndexById, parentByChildId, childrenByGroupId };
  for (const groupId of childrenByGroupId.keys()) assertGroupDepthAndAcyclic(graph, groupId, 1, new Set());
  return graph;
}

export function requireGroup(graph: MotionGroupGraph, groupId: string): MotionLayer {
  const group = graph.byId.get(groupId);
  if (!group) throw new Error(`Motion group not found: ${groupId}.`);
  if (group.type !== "group") throw new Error(`Layer ${groupId} is not a group.`);
  return group;
}

export function requireLayer(graph: MotionGroupGraph, layerId: string): MotionLayer {
  const layer = graph.byId.get(layerId);
  if (!layer) throw new Error(`Motion layer not found: ${layerId}.`);
  return layer;
}

export function assertEditableLayers(motion: MotionDocument, graph: MotionGroupGraph, layerIds: Iterable<string>): void {
  const ids = [...new Set(layerIds)];
  const tracks = motion.tracks ?? [];
  for (const layerId of ids) {
    const layer = requireLayer(graph, layerId);
    if (layer.locked === true) throw new Error(`Cannot structurally edit locked layer: ${layerId}.`);
    const lockedTrack = tracks.find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layerId)));
    if (lockedTrack) throw new Error(`Cannot structurally edit layer ${layerId} on locked track: ${lockedTrack.id}.`);
  }
}

export function assertChildFitsGroup(group: MotionLayer, child: MotionLayer): void {
  if (!isNonNegativeFinite(child.startMs) || !isPositiveFinite(child.durationMs)) {
    throw new Error(`Child layer ${child.id} has invalid local timing.`);
  }
  if (!isPositiveFinite(group.durationMs) || child.startMs + child.durationMs > group.durationMs) {
    throw new Error(`Child layer ${child.id} does not fit group ${group.id}'s local timeline.`);
  }
}

export function assertChildList(childLayerIds: readonly string[]): string[] {
  if (!Array.isArray(childLayerIds) || childLayerIds.length < 1 || childLayerIds.length > MOTION_GROUP_LIMITS.maxChildren) {
    throw new Error(`Group childLayerIds must contain 1..${MOTION_GROUP_LIMITS.maxChildren} ids.`);
  }
  const ids = childLayerIds.map((childId) => {
    if (!isNonEmptyString(childId)) throw new Error("Group childLayerIds must contain non-empty ids.");
    return childId.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error("Group childLayerIds must be unique.");
  return ids;
}

export function requireInsertionIndex(index: number | undefined, length: number, label: string): number {
  const resolved = index ?? length;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > length) {
    throw new Error(`${label} must be a non-negative integer within its target order.`);
  }
  return resolved;
}

export function requireReorderIndex(index: number, length: number, label: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new Error(`${label} must be a non-negative integer within its target order.`);
  }
  return index;
}

/** Absolute time is the sum of local startMs values through the unique owner chain. */
export function absoluteLayerStart(graph: MotionGroupGraph, layerId: string): number {
  let current = requireLayer(graph, layerId);
  let startMs = current.startMs;
  while (true) {
    const parentId = graph.parentByChildId.get(current.id);
    if (!parentId) return startMs;
    current = requireGroup(graph, parentId);
    startMs += current.startMs;
  }
}

export function orderedDirectChildren(motion: MotionDocument, graph: MotionGroupGraph, parentGroupId: string | null): string[] {
  if (parentGroupId) return [...(graph.childrenByGroupId.get(parentGroupId) ?? [])];
  return motion.layers.filter((layer) => !graph.parentByChildId.has(layer.id)).map((layer) => layer.id);
}

export function isGroupDescendant(graph: MotionGroupGraph, ancestorGroupId: string, candidateGroupId: string): boolean {
  if (ancestorGroupId === candidateGroupId) return true;
  const pending = [...(graph.childrenByGroupId.get(ancestorGroupId) ?? [])];
  while (pending.length > 0) {
    const childId = pending.pop();
    if (!childId) continue;
    if (childId === candidateGroupId) return true;
    pending.push(...(graph.childrenByGroupId.get(childId) ?? []));
  }
  return false;
}

export function groupSubtreeLayerIds(graph: MotionGroupGraph, groupId: string): string[] {
  const result: string[] = [];
  const visit = (layerId: string): void => {
    result.push(layerId);
    for (const childId of graph.childrenByGroupId.get(layerId) ?? []) visit(childId);
  };
  visit(groupId);
  return result;
}

export function replaceLayer(motion: MotionDocument, layerId: string, nextLayer: MotionLayer): MotionLayer[] {
  return motion.layers.map((layer) => layer.id === layerId ? nextLayer : layer);
}

export function cloneLayer(layer: MotionLayer): MotionLayer {
  return structuredClone(layer);
}

export function withRemovedTrackReferences(motion: MotionDocument, removedIds: Set<string>): {
  tracks: MotionTrack[] | undefined;
  changedPaths: string[];
  removedTrackRefs: string[];
} {
  if (!motion.tracks) return { tracks: undefined, changedPaths: [], removedTrackRefs: [] };
  const changedPaths: string[] = [];
  const removedTrackRefs: string[] = [];
  const tracks = motion.tracks.map((track, index) => {
    if (!track.layerIds) return { ...track };
    const layerIds = track.layerIds.filter((layerId) => !removedIds.has(layerId));
    if (layerIds.length === track.layerIds.length) return { ...track, layerIds: [...track.layerIds] };
    changedPaths.push(`/tracks/${index}/layerIds`);
    removedTrackRefs.push(track.id);
    return { ...track, layerIds };
  });
  return { tracks, changedPaths, removedTrackRefs };
}

export function withDuplicatedTrackReferences(motion: MotionDocument, cloneIdMap: ReadonlyMap<string, string>): {
  tracks: MotionTrack[] | undefined;
  changedPaths: string[];
  insertedTrackRefs: string[];
} {
  if (!motion.tracks) return { tracks: undefined, changedPaths: [], insertedTrackRefs: [] };
  const changedPaths: string[] = [];
  const insertedTrackRefs: string[] = [];
  const tracks = motion.tracks.map((track, index) => {
    if (!track.layerIds) return { ...track };
    const layerIds = track.layerIds.flatMap((layerId) => {
      const cloneId = cloneIdMap.get(layerId);
      return cloneId ? [layerId, cloneId] : [layerId];
    });
    if (layerIds.length === track.layerIds.length) return { ...track, layerIds: [...track.layerIds] };
    changedPaths.push(`/tracks/${index}/layerIds`);
    insertedTrackRefs.push(track.id);
    return { ...track, layerIds };
  });
  return { tracks, changedPaths, insertedTrackRefs };
}

export function firstAvailableCloneId(existingIds: Set<string>, sourceId: string, requestedId?: string): string {
  if (requestedId !== undefined) {
    const requested = requestedId.trim();
    if (!requested) throw new Error("Requested clone id must be a non-empty string.");
    if (existingIds.has(requested)) throw new Error(`Motion layer id already exists: ${requested}.`);
    existingIds.add(requested);
    return requested;
  }
  const base = `${sourceId}_copy`.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "group_copy";
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}_${suffix}`;
    if (!existingIds.has(candidate)) {
      existingIds.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Unable to generate a unique clone id for ${sourceId}.`);
}

export function expandedDocumentDuration(motion: MotionDocument): number {
  const roots = motion.layers.filter((layer) => !hasOwner(motion.layers, layer.id));
  const rootEnd = Math.max(0, ...roots.map((layer) => layer.startMs + layer.durationMs));
  return Math.max(motion.durationMs, rootEnd);
}

function assertGroupDepthAndAcyclic(graph: MotionGroupGraph, groupId: string, depth: number, visiting: Set<string>): void {
  if (depth > MOTION_GROUP_LIMITS.maxDepth) {
    throw new Error(`Group nesting must not exceed depth ${MOTION_GROUP_LIMITS.maxDepth}.`);
  }
  if (visiting.has(groupId)) throw new Error(`Group ownership contains a cycle at ${groupId}.`);
  visiting.add(groupId);
  for (const childId of graph.childrenByGroupId.get(groupId) ?? []) {
    if (graph.childrenByGroupId.has(childId)) assertGroupDepthAndAcyclic(graph, childId, depth + 1, visiting);
  }
  visiting.delete(groupId);
}

function hasOwner(layers: MotionLayer[], layerId: string): boolean {
  return layers.some((layer) => layer.type === "group" && layer.childLayerIds?.includes(layerId));
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
