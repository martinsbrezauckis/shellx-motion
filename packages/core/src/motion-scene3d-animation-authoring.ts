/** Closed COW authoring for the persisted scene3d animation descriptor. */
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { readMotionScene3DAnimationDescriptor } from "./motion-scene3d-animation-read";
import {
  MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK,
  MOTION_SCENE3D_ANIMATION_SCHEMA,
  type MotionScene3DAnimationDescriptor,
  type MotionScene3DAnimationKeyframe,
  type MotionScene3DAnimationLocator,
  type MotionScene3DAnimationTrack,
} from "./motion-scene3d-animation-types";
import {
  assertEditableSceneLayer, cloneLocator, copyKeyframe, copyTrack, operationRecord,
  readDescriptor, readId, readKeyframe, readStore, readUs, replaceTrack,
  requireTrackIndex, sameLocator, withStore,
} from "./motion-scene3d-animation-authoring-support";
import type { MotionDocument } from "./types";

export type MotionScene3DAnimationInspection = Readonly<{
  store: MotionScene3DAnimationDescriptor | null;
  storeSha256: string | null;
  tracks: readonly Readonly<{
    id: string;
    locator: MotionScene3DAnimationLocator;
    sha256: string;
    keyframes: readonly Readonly<{ atUs: number; sha256: string }> [];
  }> [];
}>;

export type MotionScene3DAnimationMutationAction =
  | "track_inserted"
  | "track_replaced"
  | "track_removed"
  | "keyframe_inserted"
  | "keyframe_replaced"
  | "keyframe_deleted"
  | "keyframe_moved";

export type MotionScene3DAnimationMutation = Readonly<{
  action: MotionScene3DAnimationMutationAction;
  motion: MotionDocument;
  request: Readonly<Record<string, unknown>>;
  requestSha256: string;
  changedPaths: readonly string[];
  trackId: string;
  locator: MotionScene3DAnimationLocator;
  beforeStoreSha256: string | null;
  afterStoreSha256: string | null;
  beforeTrackSha256: string | null;
  afterTrackSha256: string | null;
  beforeKeyframeSha256: string | null;
  afterKeyframeSha256: string | null;
  index: number;
  previousIndex?: number;
}>;

/**
 * Reads one complete track through the accepted C5C1A descriptor reader.  This is a deliberately
 * narrow Debug-host boundary, not a generic JSON/property-path writer.
 */
export function readMotionScene3DAnimationTrackForAuthoring(value: unknown): MotionScene3DAnimationTrack {
  return readMotionScene3DAnimationDescriptor({ schema: MOTION_SCENE3D_ANIMATION_SCHEMA, tracks: [value] }).tracks[0]!;
}

/** Inspection is read-only and returns detached canonical descriptor identities. */
export function inspectMotionScene3DAnimation(motion: MotionDocument): MotionScene3DAnimationInspection {
  const store = readStore(motion);
  return freeze({
    store,
    storeSha256: store ? canonicalJsonSha256(store) : null,
    tracks: (store?.tracks ?? []).map((track) => freeze({
      id: track.id,
      locator: cloneLocator(track.locator),
      sha256: canonicalJsonSha256(track),
      keyframes: track.keyframes.map((keyframe) => freeze({ atUs: keyframe.atUs, sha256: canonicalJsonSha256(keyframe) })),
    })),
  });
}

/** Inserts or replaces one complete typed track without allowing its stable locator identity to move. */
export function upsertMotionScene3DAnimationTrack(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation {
  const record = operationRecord(input, ["track"], "Scene3d animation track upsert");
  const incoming = readMotionScene3DAnimationTrackForAuthoring(record.track);
  const current = inspectMotionScene3DAnimation(motion);
  const existingIndex = current.store?.tracks.findIndex((track) => track.id === incoming.id) ?? -1;
  const existing = existingIndex >= 0 ? current.store!.tracks[existingIndex]! : undefined;
  const locatorCollision = current.store?.tracks.find((track) => track.id !== incoming.id && sameLocator(track.locator, incoming.locator));
  if (locatorCollision) throw new Error(`Scene3d animation locator already belongs to track '${locatorCollision.id}'.`);
  if (existing && !sameLocator(existing.locator, incoming.locator)) {
    throw new Error(`Scene3d animation track '${incoming.id}' has an old/new locator identity mismatch.`);
  }
  assertEditableSceneLayer(motion, incoming.locator.layerId);
  if (existing && canonicalJson(existing) === canonicalJson(incoming)) throw new Error(`Scene3d animation track '${incoming.id}' did not change.`);
  const tracks = existing
    ? current.store!.tracks.map((track, index) => index === existingIndex ? copyTrack(incoming) : copyTrack(track))
    : [...(current.store?.tracks ?? []).map(copyTrack), copyTrack(incoming)];
  const store = readDescriptor(tracks);
  const index = store.tracks.findIndex((track) => track.id === incoming.id);
  const next = withStore(motion, store, "Scene3d animation track upsert output");
  return mutation({
    action: existing ? "track_replaced" : "track_inserted",
    motion: next,
    request: freeze({ kind: "track.upsert", track: copyTrack(incoming) }),
    track: store.tracks[index]!,
    before: current,
    beforeTrack: existing,
    beforeKeyframe: null,
    afterKeyframe: null,
    changedPaths: [existing ? `/scene3dAnimation/tracks/${index}` : current.store ? "/scene3dAnimation/tracks" : "/scene3dAnimation"],
    index,
  });
}

/** Removes exactly one typed track; deleting the final track removes the optional public root. */
export function removeMotionScene3DAnimationTrack(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation {
  const record = operationRecord(input, ["trackId"], "Scene3d animation track remove");
  const trackId = readId(record.trackId, "Scene3d animation track remove.trackId");
  const current = inspectMotionScene3DAnimation(motion);
  if (!current.store) throw new Error(`Scene3d animation track '${trackId}' is absent.`);
  const index = current.store.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new Error(`Scene3d animation track '${trackId}' is absent.`);
  const existing = current.store.tracks[index]!;
  assertEditableSceneLayer(motion, existing.locator.layerId);
  const tracks = current.store.tracks.filter((_track, candidate) => candidate !== index).map(copyTrack);
  const nextStore = tracks.length ? readDescriptor(tracks) : undefined;
  const next = withStore(motion, nextStore, "Scene3d animation track remove output");
  return mutation({
    action: "track_removed",
    motion: next,
    request: freeze({ kind: "track.remove", trackId }),
    track: existing,
    before: current,
    beforeTrack: existing,
    beforeKeyframe: null,
    afterKeyframe: null,
    changedPaths: tracks.length ? [`/scene3dAnimation/tracks/${index}`] : ["/scene3dAnimation"],
    index,
    afterStore: nextStore,
  });
}

/** Inserts or replaces one locator-typed exact-microsecond keyframe. */
export function upsertMotionScene3DAnimationKeyframe(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation {
  const record = operationRecord(input, ["trackId", "keyframe"], "Scene3d animation keyframe upsert");
  const trackId = readId(record.trackId, "Scene3d animation keyframe upsert.trackId");
  const current = inspectMotionScene3DAnimation(motion);
  const index = requireTrackIndex(current.store, trackId);
  const existing = current.store!.tracks[index]!;
  const keyframe = readKeyframe(existing, record.keyframe, "Scene3d animation keyframe upsert.keyframe");
  assertEditableSceneLayer(motion, existing.locator.layerId);
  const previousIndex = existing.keyframes.findIndex((candidate) => candidate.atUs === keyframe.atUs);
  const beforeKeyframe = previousIndex >= 0 ? existing.keyframes[previousIndex]! : null;
  if (beforeKeyframe && canonicalJson(beforeKeyframe) === canonicalJson(keyframe)) {
    throw new Error(`Scene3d animation keyframe atUs ${keyframe.atUs} did not change.`);
  }
  if (previousIndex < 0 && existing.keyframes.length >= MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK) {
    throw new Error(`Scene3d animation track '${trackId}' cannot exceed ${MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK} keyframes.`);
  }
  const keyframes = previousIndex >= 0
    ? existing.keyframes.map((candidate, candidateIndex) => candidateIndex === previousIndex ? copyKeyframe(keyframe) : copyKeyframe(candidate))
    : [...existing.keyframes.map(copyKeyframe), copyKeyframe(keyframe)];
  keyframes.sort((left, right) => left.atUs - right.atUs);
  const store = replaceTrack(current.store!, index, { ...existing, keyframes });
  const track = store.tracks[index]!;
  const nextIndex = track.keyframes.findIndex((candidate) => candidate.atUs === keyframe.atUs);
  const next = withStore(motion, store, "Scene3d animation keyframe upsert output");
  return mutation({
    action: beforeKeyframe ? "keyframe_replaced" : "keyframe_inserted",
    motion: next,
    request: freeze({ kind: "keyframe.upsert", trackId, keyframe: copyKeyframe(keyframe) }),
    track,
    before: current,
    beforeTrack: existing,
    beforeKeyframe,
    afterKeyframe: track.keyframes[nextIndex]!,
    changedPaths: [beforeKeyframe ? `/scene3dAnimation/tracks/${index}/keyframes/${nextIndex}` : `/scene3dAnimation/tracks/${index}/keyframes`],
    index: nextIndex,
    previousIndex: beforeKeyframe ? previousIndex : undefined,
  });
}

/** Deletes one existing keyframe while retaining the descriptor's non-empty track invariant. */
export function deleteMotionScene3DAnimationKeyframe(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation {
  const record = operationRecord(input, ["trackId", "atUs"], "Scene3d animation keyframe delete");
  const trackId = readId(record.trackId, "Scene3d animation keyframe delete.trackId");
  const atUs = readUs(record.atUs, "Scene3d animation keyframe delete.atUs");
  const current = inspectMotionScene3DAnimation(motion);
  const trackIndex = requireTrackIndex(current.store, trackId);
  const existing = current.store!.tracks[trackIndex]!;
  assertEditableSceneLayer(motion, existing.locator.layerId);
  const index = existing.keyframes.findIndex((keyframe) => keyframe.atUs === atUs);
  if (index < 0) throw new Error(`Scene3d animation keyframe atUs ${atUs} is absent.`);
  if (existing.keyframes.length <= 1) throw new Error("Scene3d animation keyframe delete must retain one keyframe; remove the track explicitly instead.");
  const beforeKeyframe = existing.keyframes[index]!;
  const store = replaceTrack(current.store!, trackIndex, { ...existing, keyframes: existing.keyframes.filter((_keyframe, candidate) => candidate !== index).map(copyKeyframe) });
  const track = store.tracks[trackIndex]!;
  const next = withStore(motion, store, "Scene3d animation keyframe delete output");
  return mutation({
    action: "keyframe_deleted",
    motion: next,
    request: freeze({ kind: "keyframe.delete", trackId, atUs }),
    track,
    before: current,
    beforeTrack: existing,
    beforeKeyframe,
    afterKeyframe: null,
    changedPaths: [`/scene3dAnimation/tracks/${trackIndex}/keyframes/${index}`],
    index,
  });
}

/** Moves one keyframe to a distinct unoccupied exact microsecond without changing its typed value/easing. */
export function moveMotionScene3DAnimationKeyframe(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation {
  const record = operationRecord(input, ["trackId", "fromAtUs", "toAtUs"], "Scene3d animation keyframe move");
  const trackId = readId(record.trackId, "Scene3d animation keyframe move.trackId");
  const fromAtUs = readUs(record.fromAtUs, "Scene3d animation keyframe move.fromAtUs");
  const toAtUs = readUs(record.toAtUs, "Scene3d animation keyframe move.toAtUs");
  if (fromAtUs === toAtUs) throw new Error("Scene3d animation keyframe move has an old/new timestamp identity mismatch.");
  const current = inspectMotionScene3DAnimation(motion);
  const trackIndex = requireTrackIndex(current.store, trackId);
  const existing = current.store!.tracks[trackIndex]!;
  assertEditableSceneLayer(motion, existing.locator.layerId);
  const previousIndex = existing.keyframes.findIndex((keyframe) => keyframe.atUs === fromAtUs);
  if (previousIndex < 0) throw new Error(`Scene3d animation keyframe atUs ${fromAtUs} is absent.`);
  if (existing.keyframes.some((keyframe) => keyframe.atUs === toAtUs)) throw new Error(`Scene3d animation keyframe atUs ${toAtUs} already exists.`);
  const beforeKeyframe = existing.keyframes[previousIndex]!;
  const keyframes = existing.keyframes.map((keyframe, candidate) => copyKeyframe(candidate === previousIndex ? { ...keyframe, atUs: toAtUs } : keyframe));
  keyframes.sort((left, right) => left.atUs - right.atUs);
  const store = replaceTrack(current.store!, trackIndex, { ...existing, keyframes });
  const track = store.tracks[trackIndex]!;
  const index = track.keyframes.findIndex((keyframe) => keyframe.atUs === toAtUs);
  const next = withStore(motion, store, "Scene3d animation keyframe move output");
  return mutation({
    action: "keyframe_moved",
    motion: next,
    request: freeze({ kind: "keyframe.move", trackId, fromAtUs, toAtUs }),
    track,
    before: current,
    beforeTrack: existing,
    beforeKeyframe,
    afterKeyframe: track.keyframes[index]!,
    changedPaths: [`/scene3dAnimation/tracks/${trackIndex}/keyframes`],
    index,
    previousIndex,
  });
}

function mutation(input: {
  action: MotionScene3DAnimationMutationAction;
  motion: MotionDocument;
  request: Readonly<Record<string, unknown>>;
  track: MotionScene3DAnimationTrack;
  before: MotionScene3DAnimationInspection;
  beforeTrack: MotionScene3DAnimationTrack | undefined;
  beforeKeyframe: MotionScene3DAnimationKeyframe | null;
  afterKeyframe: MotionScene3DAnimationKeyframe | null;
  changedPaths: string[];
  index: number;
  previousIndex?: number;
  afterStore?: MotionScene3DAnimationDescriptor | undefined;
}): MotionScene3DAnimationMutation {
  const after = input.afterStore === undefined ? inspectMotionScene3DAnimation(input.motion) : inspectionForStore(input.afterStore);
  const afterTrack = after.store?.tracks.find((candidate) => candidate.id === input.track.id) ?? null;
  return freezeMutation({
    action: input.action,
    motion: input.motion,
    request: input.request,
    requestSha256: canonicalJsonSha256(input.request),
    changedPaths: input.changedPaths,
    trackId: input.track.id,
    locator: cloneLocator(input.track.locator),
    beforeStoreSha256: input.before.storeSha256,
    afterStoreSha256: after.storeSha256,
    beforeTrackSha256: input.beforeTrack ? canonicalJsonSha256(input.beforeTrack) : null,
    afterTrackSha256: afterTrack ? canonicalJsonSha256(afterTrack) : null,
    beforeKeyframeSha256: input.beforeKeyframe ? canonicalJsonSha256(input.beforeKeyframe) : null,
    afterKeyframeSha256: input.afterKeyframe ? canonicalJsonSha256(input.afterKeyframe) : null,
    index: input.index,
    ...(input.previousIndex === undefined ? {} : { previousIndex: input.previousIndex }),
  });
}

function inspectionForStore(store: MotionScene3DAnimationDescriptor | undefined): MotionScene3DAnimationInspection {
  return store
    ? freeze({ store, storeSha256: canonicalJsonSha256(store), tracks: [] })
    : freeze({ store: null, storeSha256: null, tracks: [] });
}

function freezeMutation(value: MotionScene3DAnimationMutation): MotionScene3DAnimationMutation {
  const { motion, ...facts } = value;
  freeze(facts);
  return Object.freeze({ ...facts, motion });
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
