import { canonicalJsonSha256 } from "./canonical-json";
import { assertMotionLayerCloneBoundary } from "./motion-layer-clone-boundary";
import {
  assertEditableLayers,
  cloneLayer,
  readMotionGroupGraph,
  requireGroup
} from "./motion-group-structural-support";
import { MOTION_GROUP_LIMITS } from "./motion-group-structural-types";
import type { MotionLayoutDebugCompilation, MotionLayoutDebugPatch } from "./motion-layout-debug-types";
import type {
  MotionDocument,
  MotionLayoutApplicationGeneratedLayer,
  MotionLayoutApplicationRecord,
  MotionLayoutApplicationTrackPatch,
  MotionLayer,
  MotionTrack
} from "./types";

export interface MotionLayoutMaterialization {
  motion: MotionDocument;
  materializedChildLayerIds: string[];
  generatedLayers: MotionLayoutApplicationGeneratedLayer[];
  trackPatches: MotionLayoutApplicationTrackPatch[];
  changedLayerIds: string[];
}

/**
 * Expands compiled repeaters into direct ordinary children. It plans every id,
 * clone, owner order, and track edit before producing one new document value.
 */
export function materializeMotionLayoutRepeaters(
  motion: MotionDocument,
  compilation: MotionLayoutDebugCompilation,
  patches: MotionLayoutDebugPatch[]
): MotionLayoutMaterialization {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, compilation.source.groupId);
  const sourceChildLayerIds = [...compilation.source.childLayerIds];
  if (!sameIds(group.childLayerIds ?? [], sourceChildLayerIds)) throw new Error("Direct group ownership changed before repeater materialization.");
  assertEditableLayers(motion, graph, [group.id, ...sourceChildLayerIds]);
  const instancesBySource = orderedInstances(compilation, sourceChildLayerIds);
  const patchById = new Map(patches.map((patch) => [patch.layerId, patch]));
  if ([...patchById.keys()].some((layerId) => !sourceChildLayerIds.includes(layerId))) throw new Error("Layout patch targets a layer outside the direct group children.");

  const existingIds = new Set(motion.layers.map((layer) => layer.id));
  const clonesBySource = new Map<string, MotionLayer[]>();
  const generatedLayers: MotionLayoutApplicationGeneratedLayer[] = [];
  const materializedChildLayerIds: string[] = [];
  for (const sourceId of sourceChildLayerIds) {
    const source = graph.byId.get(sourceId);
    if (!source) throw new Error(`Direct layout child is missing: ${sourceId}.`);
    materializedChildLayerIds.push(sourceId);
    const instances = instancesBySource.get(sourceId) ?? [];
    const clones: MotionLayer[] = [];
    for (const instance of instances.filter((entry) => entry.instanceIndex > 0)) {
      assertRepeatCloneSource(source);
      const id = repeatedLayerId(source.id, instance.instanceIndex);
      if (existingIds.has(id)) throw new Error(`Repeater materialization id collision: ${id}.`);
      existingIds.add(id);
      const sourceState = patchById.get(source.id)?.after;
      const clone = cloneLayer(source);
      clone.id = id;
      clone.transform = { ...structuredClone(sourceState?.transform ?? source.transform), ...instance.transform };
      clone.startMs = instance.timing.startMs;
      clone.durationMs = instance.timing.durationMs;
      clones.push(clone);
      materializedChildLayerIds.push(id);
      generatedLayers.push({ id, sourceLayerId: source.id, instanceIndex: instance.instanceIndex, layerSha256: canonicalJsonSha256(clone) });
    }
    clonesBySource.set(sourceId, clones);
  }
  if (generatedLayers.length === 0) throw new Error("Repeater materialization requires at least one generated instance.");
  if (materializedChildLayerIds.length > MOTION_GROUP_LIMITS.maxChildren) {
    throw new Error(`Repeater materialization would exceed group ${group.id}'s ${MOTION_GROUP_LIMITS.maxChildren}-child limit.`);
  }

  const tracks = materializedTracks(motion.tracks, clonesBySource);
  const layers = motion.layers.flatMap((layer) => {
    if (layer.id === group.id) return [{ ...cloneLayer(group), childLayerIds: [...materializedChildLayerIds] }];
    const patch = patchById.get(layer.id);
    const source = patch ? { ...layer, transform: structuredClone(patch.after.transform), startMs: patch.after.timing.startMs, durationMs: patch.after.timing.durationMs } : layer;
    return [...(source === layer ? [layer] : [source]), ...(clonesBySource.get(layer.id) ?? [])];
  });
  const nextMotion: MotionDocument = { ...motion, layers, ...(tracks.tracks ? { tracks: tracks.tracks } : {}) };
  readMotionGroupGraph(nextMotion);
  return {
    motion: nextMotion,
    materializedChildLayerIds,
    generatedLayers,
    trackPatches: tracks.patches,
    changedLayerIds: [group.id, ...patches.map((patch) => patch.layerId), ...generatedLayers.map((layer) => layer.id)]
  };
}

/** Restores owner order and track lists only after exact generated-layer hashes match. */
export function removeMaterializedMotionLayoutRepeaters(motion: MotionDocument, application: MotionLayoutApplicationRecord): MotionDocument {
  const graph = readMotionGroupGraph(motion);
  const group = requireGroup(graph, application.groupId);
  if (!sameIds(group.childLayerIds ?? [], application.materializedChildLayerIds)) {
    throw new Error("Current direct group ownership differs from the recorded materialized order.");
  }
  const generatedBySource = new Map<string, MotionLayoutApplicationGeneratedLayer[]>();
  const generatedIds = new Set<string>();
  for (const generated of application.generatedLayers) {
    if (generatedIds.has(generated.id)) throw new Error(`Recorded generated layer id is duplicated: ${generated.id}.`);
    generatedIds.add(generated.id);
    const current = graph.byId.get(generated.id);
    if (!current || canonicalJsonSha256(current) !== generated.layerSha256) {
      throw new Error(`Generated layer ${generated.id} no longer matches the exact recorded materialization.`);
    }
    if (repeatedLayerId(generated.sourceLayerId, generated.instanceIndex) !== generated.id) {
      throw new Error(`Generated layer ${generated.id} does not have the deterministic repeated-layer identity.`);
    }
    generatedBySource.set(generated.sourceLayerId, [...(generatedBySource.get(generated.sourceLayerId) ?? []), generated]);
  }
  assertNoExternalReferencesToGeneratedLayers(motion, generatedIds);
  const expectedOrder = application.childLayerIds.flatMap((sourceId) => [sourceId, ...(generatedBySource.get(sourceId) ?? []).sort((left, right) => left.instanceIndex - right.instanceIndex).map((generated) => generated.id)]);
  if (!sameIds(expectedOrder, application.materializedChildLayerIds)) throw new Error("Recorded materialized child order is not an exact source-plus-generated expansion.");
  const tracks = restoreMaterializedTracks(motion.tracks, application.trackPatches);
  const layers = motion.layers
    .filter((layer) => !generatedIds.has(layer.id))
    .map((layer) => layer.id === group.id ? { ...cloneLayer(group), childLayerIds: [...application.childLayerIds] } : layer);
  const nextMotion: MotionDocument = { ...motion, layers, ...(tracks ? { tracks } : {}) };
  readMotionGroupGraph(nextMotion);
  return nextMotion;
}

function orderedInstances(compilation: MotionLayoutDebugCompilation, sourceChildLayerIds: string[]): Map<string, MotionLayoutDebugCompilation["instances"]> {
  const bySource = new Map<string, MotionLayoutDebugCompilation["instances"]>();
  for (const instance of compilation.instances) {
    if (!sourceChildLayerIds.includes(instance.sourceId)) throw new Error(`Compiled repeater instance has non-child source ${instance.sourceId}.`);
    bySource.set(instance.sourceId, [...(bySource.get(instance.sourceId) ?? []), instance]);
  }
  for (const sourceId of sourceChildLayerIds) {
    const instances = (bySource.get(sourceId) ?? []).sort((left, right) => left.instanceIndex - right.instanceIndex);
    if (instances.length < 1 || instances.some((entry, index) => entry.instanceIndex !== index)) {
      throw new Error(`Compiled repeater instances for ${sourceId} are not a complete deterministic 0..n sequence.`);
    }
    bySource.set(sourceId, instances);
  }
  return bySource;
}

function assertRepeatCloneSource(layer: MotionLayer): void {
  if (layer.type === "group" || layer.childLayerIds !== undefined) throw new Error(`Cannot materialize repeated layer ${layer.id}: nested or owning group semantics are unsupported.`);
  assertMotionLayerCloneBoundary(layer, "materialize repeater");
  if (layer.matte || (layer.ducking?.triggerLayerIds.length ?? 0) > 0 || layer.environment?.sceneSourceLayerId || layer.environment?.effectMaskLayerId) {
    throw new Error(`Cannot materialize repeated layer ${layer.id}: typed layer-reference source semantics require an explicit repeated-reference contract.`);
  }
}

function repeatedLayerId(sourceId: string, instanceIndex: number): string {
  const id = `${sourceId}__layout_repeat_${instanceIndex}`;
  if (id.length > 128) throw new Error(`Repeater materialization id exceeds 128 code units for source ${sourceId}.`);
  return id;
}

function materializedTracks(tracks: MotionTrack[] | undefined, clonesBySource: ReadonlyMap<string, readonly MotionLayer[]>): { tracks: MotionTrack[] | undefined; patches: MotionLayoutApplicationTrackPatch[] } {
  if (!tracks) return { tracks: undefined, patches: [] };
  const patches: MotionLayoutApplicationTrackPatch[] = [];
  const nextTracks = tracks.map((track) => {
    if (!track.layerIds) return { ...track };
    const layerIds = track.layerIds.flatMap((layerId) => [layerId, ...(clonesBySource.get(layerId) ?? []).map((layer) => layer.id)]);
    if (sameIds(layerIds, track.layerIds)) return { ...track, layerIds: [...track.layerIds] };
    patches.push({ trackId: track.id, beforeLayerIds: [...track.layerIds], afterLayerIds: layerIds });
    return { ...track, layerIds };
  });
  return { tracks: nextTracks, patches };
}

function restoreMaterializedTracks(tracks: MotionTrack[] | undefined, patches: MotionLayoutApplicationTrackPatch[]): MotionTrack[] | undefined {
  if (patches.length === 0) return tracks ? tracks.map((track) => ({ ...track, ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}) })) : undefined;
  if (!tracks) throw new Error("Recorded materialized track changes are missing from the current document.");
  const patchesByTrack = new Map(patches.map((patch) => [patch.trackId, patch]));
  const seen = new Set<string>();
  const nextTracks = tracks.map((track) => {
    const patch = patchesByTrack.get(track.id);
    if (!patch) return { ...track, ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}) };
    seen.add(track.id);
    if (!sameIds(track.layerIds ?? [], patch.afterLayerIds)) throw new Error(`Track ${track.id} no longer matches the exact recorded materialized references.`);
    return { ...track, layerIds: [...patch.beforeLayerIds] };
  });
  if (seen.size !== patches.length) throw new Error("A recorded materialized track is missing from the current document.");
  return nextTracks;
}

/** Deleting a generated clone cannot silently strand an external typed or opaque consumer. */
function assertNoExternalReferencesToGeneratedLayers(motion: MotionDocument, generatedIds: ReadonlySet<string>): void {
  for (const layer of motion.layers) {
    if (generatedIds.has(layer.id)) continue;
    assertMotionLayerCloneBoundary(layer, "remove materialized repeater external");
    if (layer.matte && generatedIds.has(layer.matte.sourceLayerId)) {
      throw new Error(`External layer ${layer.id} matte.sourceLayerId references generated layer ${layer.matte.sourceLayerId}.`);
    }
    for (const triggerLayerId of layer.ducking?.triggerLayerIds ?? []) {
      if (generatedIds.has(triggerLayerId)) throw new Error(`External layer ${layer.id} ducking.triggerLayerIds references generated layer ${triggerLayerId}.`);
    }
    if (layer.environment?.sceneSourceLayerId && generatedIds.has(layer.environment.sceneSourceLayerId)) {
      throw new Error(`External layer ${layer.id} environment.sceneSourceLayerId references generated layer ${layer.environment.sceneSourceLayerId}.`);
    }
    if (layer.environment?.effectMaskLayerId && generatedIds.has(layer.environment.effectMaskLayerId)) {
      throw new Error(`External layer ${layer.id} environment.effectMaskLayerId references generated layer ${layer.environment.effectMaskLayerId}.`);
    }
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
