/** Exact local-timeline mutations for group/precomposition layers. */
import {
  assertChildFitsGroup,
  assertEditableLayers,
  cloneLayer,
  expandedDocumentDuration,
  groupSubtreeLayerIds,
  orderedDirectChildren,
  readMotionGroupGraph,
  replaceLayer,
  requireGroup,
  requireReorderIndex
} from "./motion-group-structural-support";
import type { MotionDocument, MotionLayer } from "./types";
import type {
  MotionGroupRootReorderInput,
  MotionGroupRootReorderResult,
  MotionGroupTrimInput,
  MotionGroupTrimResult
} from "./motion-group-structural-types";
export { splitMotionGroupAtMs } from "./motion-group-timeline-split";

/**
 * Changes only a group container's local position or duration. Groups have no source-time trim:
 * shortening is accepted only when every direct child still fits the resulting local interval.
 */
export function trimMotionGroup(motion: MotionDocument, input: MotionGroupTrimInput): MotionGroupTrimResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  const hasStartMs = Object.hasOwn(input, "startMs");
  const hasDurationMs = Object.hasOwn(input, "durationMs");
  if (!hasStartMs && !hasDurationMs) throw new Error("Group trim requires startMs or durationMs.");
  if (hasStartMs && !isNonNegativeFinite(input.startMs)) throw new Error("Group startMs must be a non-negative finite number.");
  if (hasDurationMs && !isPositiveFinite(input.durationMs)) throw new Error("Group durationMs must be a positive finite number.");

  const parentId = graph.parentByChildId.get(group.id);
  const parent = parentId ? requireGroup(graph, parentId) : undefined;
  const subtreeIds = groupSubtreeLayerIds(graph, group.id);
  assertEditableLayers(motion, graph, [...subtreeIds, ...(parent ? [parent.id] : [])]);

  const nextGroup: MotionLayer = {
    ...cloneLayer(group),
    ...(hasStartMs ? { startMs: input.startMs as number } : {}),
    ...(hasDurationMs ? { durationMs: input.durationMs as number } : {})
  };
  for (const childId of group.childLayerIds ?? []) {
    const child = graph.byId.get(childId);
    if (!child) throw new Error(`Motion group ${group.id} references missing child ${childId}.`);
    assertChildFitsGroup(nextGroup, child);
  }
  if (parent) assertChildFitsGroup(parent, nextGroup);
  if (nextGroup.startMs === group.startMs && nextGroup.durationMs === group.durationMs) {
    throw new Error("Group trim did not change any timing field.");
  }

  const changedPaths: string[] = [];
  if (nextGroup.startMs !== group.startMs) changedPaths.push(`/layers/${group.id}/startMs`);
  if (nextGroup.durationMs !== group.durationMs) changedPaths.push(`/layers/${group.id}/durationMs`);
  const nextMotion: MotionDocument = { ...motion, layers: replaceLayer(motion, group.id, nextGroup) };
  const durationMs = expandedDocumentDuration(nextMotion);
  if (durationMs !== motion.durationMs) {
    nextMotion.durationMs = durationMs;
    changedPaths.push("/durationMs");
  }
  readMotionGroupGraph(nextMotion);
  return {
    motion: nextMotion,
    changedPaths,
    action: "trimmed",
    groupId: group.id,
    oldTiming: { startMs: group.startMs, durationMs: group.durationMs },
    newTiming: { startMs: nextGroup.startMs, durationMs: nextGroup.durationMs },
    group: nextGroup
  };
}

/** Reorders one root group among root siblings; group-local child ordering remains a separate operation. */
export function reorderMotionGroupRoot(motion: MotionDocument, input: MotionGroupRootReorderInput): MotionGroupRootReorderResult {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, requiredId(input.groupId, "Group id"));
  if (graph.parentByChildId.has(group.id)) {
    throw new Error(`Cannot root-reorder group ${group.id}: it is owned by group ${graph.parentByChildId.get(group.id)}. Use reorderMotionGroupChild.`);
  }
  const rootLayerIds = orderedDirectChildren(motion, graph, null);
  const oldIndex = rootLayerIds.indexOf(group.id);
  const newIndex = requireReorderIndex(input.index, rootLayerIds.length, "Root group index");
  if (oldIndex === newIndex) throw new Error("Root group order did not change.");
  assertEditableLayers(motion, graph, [group.id]);

  rootLayerIds.splice(oldIndex, 1);
  rootLayerIds.splice(newIndex, 0, group.id);
  let rootCursor = 0;
  const layers = motion.layers.map((layer) => {
    if (graph.parentByChildId.has(layer.id)) return cloneLayer(layer);
    const rootId = rootLayerIds[rootCursor++];
    const replacement = graph.byId.get(rootId);
    if (!replacement) throw new Error(`Root layer ${rootId} disappeared while reordering.`);
    return cloneLayer(replacement);
  });
  const nextMotion: MotionDocument = { ...motion, layers };
  readMotionGroupGraph(nextMotion);
  return {
    motion: nextMotion,
    changedPaths: ["/layers"],
    action: "root-reordered",
    groupId: group.id,
    oldIndex,
    newIndex,
    rootLayerIds
  };
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
