/** Recursive, reference-safe group split composition. */
import { assertMotionLayerCloneBoundary } from "./motion-layer-clone-boundary";
import {
  assertEditableLayers,
  cloneLayer,
  readMotionGroupGraph,
  replaceLayer,
  requireGroup,
  type MotionGroupGraph
} from "./motion-group-structural-support";
import { executeLayerSplit } from "./timeline-split-executor";
import type { MotionDocument, MotionLayer } from "./types";
import type { MotionGroupSplitInput, MotionGroupSplitResult } from "./motion-group-structural-types";

/** Splits a group in its direct owner's time coordinates, recursively preserving child local time. */
export function splitMotionGroupAtMs(motion: MotionDocument, input: MotionGroupSplitInput): MotionGroupSplitResult {
  const graph = readMotionGroupGraph(motion);
  const groupId = requiredId(input.groupId, "Group id");
  const group = requireGroup(graph, groupId);
  if (!isNonNegativeFinite(input.atMs)) throw new Error("Group split atMs must be a non-negative finite number.");
  assertNoExternalReferencesToSplitSubtree(graph, groupId);
  const plan = planGroupSplit(graph, groupId, input.atMs, new Set(motion.layers.map((layer) => layer.id)), input.newGroupId);
  const parentId = graph.parentByChildId.get(groupId);
  assertTailClonesDoNotReferenceHeadOnlyLayers(graph, plan);
  assertEditableLayers(motion, graph, [...collectEditableLayerIds(plan), ...(parentId ? [parentId] : [])]);
  const applied = applyGroupSplitPlan(motion, plan);
  const rebound = rebindSplitCloneReferences(applied.motion, plan.tailIdBySource);
  const owned = parentId ? attachTailToDirectOwner(rebound, graph, groupId, plan.tailId, parentId) : { motion: rebound, changedPaths: [] };
  readMotionGroupGraph(owned.motion);
  const originalGroup = owned.motion.layers.find((layer) => layer.id === groupId);
  const newGroup = owned.motion.layers.find((layer) => layer.id === plan.tailId);
  if (!originalGroup || !newGroup) throw new Error("Group split did not retain both group halves.");
  return {
    motion: owned.motion, changedPaths: uniquePaths([...applied.changedPaths, ...owned.changedPaths]), action: "split", groupId,
    newGroupId: plan.tailId, atMs: input.atMs, splitOffsetMs: input.atMs - group.startMs,
    splitIdMap: Object.fromEntries(plan.tailIdBySource), originalGroup, newGroup
  };
}

function attachTailToDirectOwner(
  motion: MotionDocument,
  graph: MotionGroupGraph,
  groupId: string,
  tailId: string,
  parentId: string
): { motion: MotionDocument; changedPaths: string[] } {
  const parent = requireGroup(graph, parentId);
  const childLayerIds = [...(parent.childLayerIds ?? [])];
  const index = childLayerIds.indexOf(groupId);
  if (index === -1) throw new Error(`Owning group ${parentId} lost child ${groupId} before split.`);
  childLayerIds.splice(index + 1, 0, tailId);
  return {
    motion: { ...motion, layers: replaceLayer(motion, parentId, { ...cloneLayer(parent), childLayerIds }) },
    changedPaths: [`/layers/${parentId}/childLayerIds`]
  };
}

interface GroupSplitPlan {
  groupId: string;
  atMs: number;
  cutLocalMs: number;
  tailId: string;
  children: GroupSplitChildPlan[];
  headChildIds: string[];
  tailChildIds: string[];
  tailIdBySource: Map<string, string>;
}

type GroupSplitChildPlan =
  | { kind: "before"; childId: string }
  | { kind: "after"; childId: string }
  | { kind: "leaf-split"; childId: string; tailId: string; atMs: number }
  | { kind: "group-split"; childId: string; split: GroupSplitPlan };

function planGroupSplit(graph: MotionGroupGraph, groupId: string, atMs: number, existingIds: Set<string>, requestedTailId?: string): GroupSplitPlan {
  const group = requireGroup(graph, groupId);
  if (atMs <= group.startMs || atMs >= group.startMs + group.durationMs) {
    throw new Error(`Group split point must be inside group ${group.id}'s duration.`);
  }
  assertSplitCloneReferencesSafe(group);
  const tailId = allocateSplitId(existingIds, group.id, atMs, requestedTailId);
  const tailIdBySource = new Map<string, string>([[group.id, tailId]]);
  const cutLocalMs = atMs - group.startMs;
  const children: GroupSplitChildPlan[] = [];
  const headChildIds: string[] = [];
  const tailChildIds: string[] = [];
  for (const childId of group.childLayerIds ?? []) {
    const child = graph.byId.get(childId);
    if (!child) throw new Error(`Motion group ${group.id} references missing child ${childId}.`);
    const childEndMs = child.startMs + child.durationMs;
    if (childEndMs <= cutLocalMs) {
      children.push({ kind: "before", childId }); headChildIds.push(childId); continue;
    }
    if (child.startMs >= cutLocalMs) {
      children.push({ kind: "after", childId }); tailChildIds.push(childId); continue;
    }
    if (child.type === "group") {
      const split = planGroupSplit(graph, child.id, cutLocalMs, existingIds);
      for (const [sourceId, splitId] of split.tailIdBySource) tailIdBySource.set(sourceId, splitId);
      children.push({ kind: "group-split", childId, split }); headChildIds.push(childId); tailChildIds.push(split.tailId); continue;
    }
    assertSplitCloneReferencesSafe(child);
    const childTailId = allocateSplitId(existingIds, child.id, cutLocalMs);
    tailIdBySource.set(child.id, childTailId);
    children.push({ kind: "leaf-split", childId, tailId: childTailId, atMs: cutLocalMs });
    headChildIds.push(childId); tailChildIds.push(childTailId);
  }
  if (headChildIds.length === 0 || tailChildIds.length === 0) {
    throw new Error(`Cannot split group ${group.id} at ${atMs}: each resulting group must retain at least one direct child.`);
  }
  return { groupId, atMs, cutLocalMs, tailId, children, headChildIds, tailChildIds, tailIdBySource };
}

function applyGroupSplitPlan(motion: MotionDocument, plan: GroupSplitPlan): { motion: MotionDocument; changedPaths: string[] } {
  const groupSplit = executeLayerSplit(motion, { layerId: plan.groupId, atMs: plan.atMs, newLayerId: plan.tailId });
  let nextMotion = groupSplit.motion;
  const changedPaths = [...groupSplit.changedPaths];
  for (const child of plan.children) {
    if (child.kind === "before") continue;
    if (child.kind === "after") {
      const layer = nextMotion.layers.find((candidate) => candidate.id === child.childId);
      if (!layer) throw new Error(`Trailing group child ${child.childId} disappeared during split.`);
      nextMotion = { ...nextMotion, layers: replaceLayer(nextMotion, child.childId, { ...cloneLayer(layer), startMs: layer.startMs - plan.cutLocalMs }) };
      changedPaths.push(`/layers/${child.childId}/startMs`);
      continue;
    }
    if (child.kind === "leaf-split") {
      const split = executeLayerSplit(nextMotion, { layerId: child.childId, atMs: child.atMs, newLayerId: child.tailId });
      const tail = split.motion.layers.find((layer) => layer.id === child.tailId);
      if (!tail) throw new Error(`Split group child ${child.tailId} disappeared during split.`);
      nextMotion = {
        ...split.motion,
        layers: replaceLayer(split.motion, child.tailId, { ...cloneLayer(tail), startMs: tail.startMs - plan.cutLocalMs })
      };
      changedPaths.push(...split.changedPaths, `/layers/${child.tailId}/startMs`); continue;
    }
    const split = applyGroupSplitPlan(nextMotion, child.split);
    const tail = split.motion.layers.find((layer) => layer.id === child.split.tailId);
    if (!tail) throw new Error(`Split group child ${child.split.tailId} disappeared during split.`);
    nextMotion = {
      ...split.motion,
      layers: replaceLayer(split.motion, child.split.tailId, { ...cloneLayer(tail), startMs: tail.startMs - plan.cutLocalMs })
    };
    changedPaths.push(...split.changedPaths, `/layers/${child.split.tailId}/startMs`);
  }
  const currentGroup = nextMotion.layers.find((layer) => layer.id === plan.groupId);
  const tailGroup = nextMotion.layers.find((layer) => layer.id === plan.tailId);
  if (!currentGroup || !tailGroup) throw new Error(`Group ${plan.groupId} did not retain both halves during split.`);
  nextMotion = {
    ...nextMotion,
    layers: nextMotion.layers.map((layer) => {
      if (layer.id === plan.groupId) return { ...cloneLayer(currentGroup), childLayerIds: [...plan.headChildIds] };
      return layer.id === plan.tailId ? { ...cloneLayer(tailGroup), childLayerIds: [...plan.tailChildIds] } : layer;
    })
  };
  changedPaths.push(`/layers/${plan.groupId}/childLayerIds`);
  return { motion: nextMotion, changedPaths };
}

function rebindSplitCloneReferences(motion: MotionDocument, tailIdBySource: ReadonlyMap<string, string>): MotionDocument {
  const tailIds = new Set(tailIdBySource.values());
  return { ...motion, layers: motion.layers.map((layer) => tailIds.has(layer.id) ? rebindInternalReferences(layer, tailIdBySource) : layer) };
}

function rebindInternalReferences(layer: MotionLayer, tailIdBySource: ReadonlyMap<string, string>): MotionLayer {
  const rebound = cloneLayer(layer);
  if (rebound.type === "group") rebound.childLayerIds = (rebound.childLayerIds ?? []).map((id) => tailIdBySource.get(id) ?? id);
  if (rebound.matte) rebound.matte = { ...rebound.matte, sourceLayerId: tailIdBySource.get(rebound.matte.sourceLayerId) ?? rebound.matte.sourceLayerId };
  if (rebound.ducking) rebound.ducking = { ...rebound.ducking, triggerLayerIds: rebound.ducking.triggerLayerIds.map((id) => tailIdBySource.get(id) ?? id) };
  if (rebound.environment) {
    rebound.environment = {
      ...rebound.environment,
      ...(rebound.environment.sceneSourceLayerId === undefined ? {} : { sceneSourceLayerId: tailIdBySource.get(rebound.environment.sceneSourceLayerId) ?? rebound.environment.sceneSourceLayerId }),
      ...(rebound.environment.effectMaskLayerId === undefined ? {} : { effectMaskLayerId: tailIdBySource.get(rebound.environment.effectMaskLayerId) ?? rebound.environment.effectMaskLayerId })
    };
  }
  return rebound;
}

function collectEditableLayerIds(plan: GroupSplitPlan): string[] {
  const ids = [plan.groupId];
  for (const child of plan.children) {
    if (child.kind === "after" || child.kind === "leaf-split") ids.push(child.childId);
    if (child.kind === "group-split") ids.push(...collectEditableLayerIds(child.split));
  }
  return ids;
}

function assertTailClonesDoNotReferenceHeadOnlyLayers(graph: MotionGroupGraph, plan: GroupSplitPlan): void {
  const headOnlyLayerIds = collectHeadOnlyLayerIds(graph, plan);
  if (headOnlyLayerIds.size === 0) return;
  for (const sourceId of plan.tailIdBySource.keys()) {
    const source = graph.byId.get(sourceId);
    if (!source) throw new Error(`Split source layer ${sourceId} disappeared during preflight.`);
    for (const targetId of referencedLayerIds(source)) {
      if (headOnlyLayerIds.has(targetId)) {
        throw new Error(`Cannot split group: tail clone ${sourceId} would reference head-only layer ${targetId}.`);
      }
    }
  }
}

/** External consumers cannot be rewritten without an explicit cross-group composition contract. */
function assertNoExternalReferencesToSplitSubtree(graph: MotionGroupGraph, groupId: string): void {
  const subtree = new Set(subtreeIds(graph, groupId));
  for (const layer of graph.byId.values()) {
    if (subtree.has(layer.id)) continue;
    // An external opaque payload might name either half of the split. There is
    // no portable way to choose head vs tail, so reject it before planning.
    assertMotionLayerCloneBoundary(layer, "split external");
    for (const targetId of referencedLayerIds(layer)) {
      if (subtree.has(targetId)) {
        throw new Error(`Cannot split group ${groupId}: external layer ${layer.id} references split-subtree layer ${targetId}.`);
      }
    }
  }
}

function collectHeadOnlyLayerIds(graph: MotionGroupGraph, plan: GroupSplitPlan): Set<string> {
  const ids = new Set<string>();
  for (const child of plan.children) {
    if (child.kind === "before") {
      for (const id of subtreeIds(graph, child.childId)) ids.add(id);
    } else if (child.kind === "group-split") {
      for (const id of collectHeadOnlyLayerIds(graph, child.split)) ids.add(id);
    }
  }
  return ids;
}

function subtreeIds(graph: MotionGroupGraph, layerId: string): string[] {
  const ids = [layerId];
  for (const childId of graph.childrenByGroupId.get(layerId) ?? []) ids.push(...subtreeIds(graph, childId));
  return ids;
}

function referencedLayerIds(layer: MotionLayer): string[] {
  return [
    ...(layer.matte ? [layer.matte.sourceLayerId] : []),
    ...(layer.ducking?.triggerLayerIds ?? []),
    ...(layer.environment?.sceneSourceLayerId ? [layer.environment.sceneSourceLayerId] : []),
    ...(layer.environment?.effectMaskLayerId ? [layer.environment.effectMaskLayerId] : [])
  ];
}

function allocateSplitId(existingIds: Set<string>, sourceId: string, atMs: number, requestedId?: string): string {
  if (requestedId !== undefined) {
    const requested = requestedId.trim();
    if (!requested) throw new Error("New group id must be a non-empty string.");
    if (existingIds.has(requested)) throw new Error(`Motion layer id already exists: ${requested}.`);
    existingIds.add(requested); return requested;
  }
  const base = `${sourceId}_split_${Math.round(atMs)}`.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "layer_split";
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}_${suffix}`;
    if (!existingIds.has(candidate)) { existingIds.add(candidate); return candidate; }
  }
  throw new Error(`Unable to generate a unique split layer id for ${sourceId}.`);
}

function assertSplitCloneReferencesSafe(layer: MotionLayer): void {
  assertMotionLayerCloneBoundary(layer, "split");
}

function uniquePaths(paths: string[]): string[] { return [...new Set(paths)]; }
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
function isNonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
