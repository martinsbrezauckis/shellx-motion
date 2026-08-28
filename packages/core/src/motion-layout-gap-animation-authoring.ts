import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { layoutGapAnimationTrackBinding } from "./motion-layout-gap-animation-document";
import { readMotionLayoutGapAnimationTrackForAuthoring } from "./motion-layout-gap-animation-read";
import {
  MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK,
  type MotionLayoutGapAnimationDescriptor,
  type MotionLayoutGapAnimationKeyframe,
  type MotionLayoutGapAnimationTrack,
  type MotionLayoutGapAnimationTrackBinding,
} from "./motion-layout-gap-animation-types";
import {
  copyLayoutGapAnimationKeyframe as copyKeyframe,
  copyLayoutGapAnimationTrack as copyTrack,
  deepFreeze,
  layoutGapAnimationDescriptor as descriptor,
  readLayoutGapAnimationId as id,
  readLayoutGapAnimationKeyframe as readKeyframe,
  readLayoutGapAnimationOperationRecord as operationRecord,
  readLayoutGapAnimationStore as readStore,
  readLayoutGapAnimationUs as us,
  replaceLayoutGapAnimationTrack as replaceTrack,
  requireLayoutGapAnimationTrack as requireTrack,
  sameLayoutGapAnimationTrackBinding as sameTrackBinding,
  withLayoutGapAnimationStore as withStore,
} from "./motion-layout-gap-animation-authoring-helpers";
import type { MotionDocument } from "./types";

export interface MotionLayoutGapAnimationInspection {
  store: MotionLayoutGapAnimationDescriptor | null;
  storeSha256: string | null;
  tracks: readonly {
    id: string;
    application: MotionLayoutGapAnimationTrackBinding;
    keyframeCount: number;
  }[];
}

export type MotionLayoutGapAnimationMutationAction =
  | "track_inserted"
  | "track_replaced"
  | "track_removed"
  | "keyframe_inserted"
  | "keyframe_replaced"
  | "keyframe_deleted"
  | "keyframe_moved";

export interface MotionLayoutGapAnimationMutation {
  action: MotionLayoutGapAnimationMutationAction;
  motion: MotionDocument;
  request: Readonly<Record<string, unknown>>;
  requestSha256: string;
  changedPaths: readonly string[];
  trackId: string;
  application: MotionLayoutGapAnimationTrackBinding;
  beforeStoreSha256: string | null;
  afterStoreSha256: string | null;
  beforeTrackSha256: string | null;
  afterTrackSha256: string | null;
  beforeKeyframeSha256: string | null;
  afterKeyframeSha256: string | null;
  index: number;
  previousIndex?: number;
}

export function inspectMotionLayoutGapAnimation(
  motion: MotionDocument,
): MotionLayoutGapAnimationInspection {
  const store = readStore(motion);
  return deepFreeze({
    store,
    storeSha256: store ? canonicalJsonSha256(store) : null,
    tracks: store
      ? store.tracks.map((track) => ({
          id: track.id,
          application: layoutGapAnimationTrackBinding(motion, track),
          keyframeCount: track.keyframes.length,
        }))
      : [],
  });
}

export function upsertMotionLayoutGapAnimationTrack(
  motion: MotionDocument,
  input: unknown,
): MotionLayoutGapAnimationMutation {
  const record = operationRecord(input, ["track"], "Layout gap animation track upsert");
  const incoming = readMotionLayoutGapAnimationTrackForAuthoring(record.track);
  const before = inspectMotionLayoutGapAnimation(motion);
  const existingIndex = before.store?.tracks.findIndex((track) => track.id === incoming.id) ?? -1;
  const existing = existingIndex >= 0 ? before.store!.tracks[existingIndex]! : undefined;
  const applicationCollision = before.store?.tracks.find(
    (track) => track.id !== incoming.id && track.applicationId === incoming.applicationId,
  );
  if (applicationCollision) {
    throw new Error(
      `Layout gap animation application '${incoming.applicationId}' already belongs to track '${applicationCollision.id}'.`,
    );
  }
  if (existing && !sameTrackBinding(existing, incoming)) {
    throw new Error(
      `Layout gap animation track '${incoming.id}' has an immutable application binding mismatch.`,
    );
  }
  if (existing && canonicalJson(existing) === canonicalJson(incoming)) {
    throw new Error(`Layout gap animation track '${incoming.id}' did not change.`);
  }
  const tracks = existing
    ? before.store!.tracks.map((track, index) =>
        index === existingIndex ? copyTrack(incoming) : copyTrack(track))
    : [...(before.store?.tracks ?? []).map(copyTrack), copyTrack(incoming)];
  const store = descriptor(tracks);
  const index = store.tracks.findIndex((track) => track.id === incoming.id);
  const next = withStore(motion, store, "Layout gap animation track upsert output");
  return mutation({
    action: existing ? "track_replaced" : "track_inserted",
    motion: next,
    request: freeze({ kind: "track.upsert", track: copyTrack(incoming) }),
    track: store.tracks[index]!,
    before,
    beforeTrack: existing,
    beforeKeyframe: null,
    afterKeyframe: null,
    changedPaths: [
      existing
        ? `/layoutGapAnimation/tracks/${index}`
        : before.store ? "/layoutGapAnimation/tracks" : "/layoutGapAnimation",
    ],
    index,
  });
}

export function removeMotionLayoutGapAnimationTrack(
  motion: MotionDocument,
  input: unknown,
): MotionLayoutGapAnimationMutation {
  const record = operationRecord(input, ["trackId"], "Layout gap animation track remove");
  const trackId = id(record.trackId, "Layout gap animation track remove.trackId");
  const before = inspectMotionLayoutGapAnimation(motion);
  if (!before.store) throw new Error(`Layout gap animation track '${trackId}' is absent.`);
  const index = before.store.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new Error(`Layout gap animation track '${trackId}' is absent.`);
  const existing = before.store.tracks[index]!;
  const tracks = before.store.tracks
    .filter((_track, candidate) => candidate !== index)
    .map(copyTrack);
  const nextStore = tracks.length ? descriptor(tracks) : undefined;
  const next = withStore(motion, nextStore, "Layout gap animation track remove output");
  return mutation({
    action: "track_removed",
    motion: next,
    request: freeze({ kind: "track.remove", trackId }),
    track: existing,
    before,
    beforeTrack: existing,
    beforeKeyframe: null,
    afterKeyframe: null,
    changedPaths: tracks.length
      ? [`/layoutGapAnimation/tracks/${index}`]
      : ["/layoutGapAnimation"],
    index,
    afterStore: nextStore,
  });
}

export function upsertMotionLayoutGapAnimationKeyframe(
  motion: MotionDocument,
  input: unknown,
): MotionLayoutGapAnimationMutation {
  const record = operationRecord(input, ["trackId", "keyframe"], "Layout gap animation keyframe upsert");
  const trackId = id(record.trackId, "Layout gap animation keyframe upsert.trackId");
  const before = inspectMotionLayoutGapAnimation(motion);
  const trackIndex = requireTrack(before.store, trackId);
  const existing = before.store!.tracks[trackIndex]!;
  const keyframe = readKeyframe(existing, record.keyframe, "Layout gap animation keyframe upsert.keyframe");
  const previousIndex = existing.keyframes.findIndex(
    (candidate) => candidate.atUs === keyframe.atUs,
  );
  const beforeKeyframe = previousIndex >= 0 ? existing.keyframes[previousIndex]! : null;
  if (beforeKeyframe && canonicalJson(beforeKeyframe) === canonicalJson(keyframe)) {
    throw new Error(`Layout gap animation keyframe atUs ${keyframe.atUs} did not change.`);
  }
  if (previousIndex < 0
    && existing.keyframes.length >= MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK) {
    throw new Error(
      `Layout gap animation track '${trackId}' cannot exceed ${MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK} keyframes.`,
    );
  }
  const keyframes = previousIndex >= 0
    ? existing.keyframes.map((candidate, index) =>
        index === previousIndex ? copyKeyframe(keyframe) : copyKeyframe(candidate))
    : [...existing.keyframes.map(copyKeyframe), copyKeyframe(keyframe)];
  keyframes.sort((left, right) => left.atUs - right.atUs);
  const store = replaceTrack(before.store!, trackIndex, { ...existing, keyframes });
  const track = store.tracks[trackIndex]!;
  const index = track.keyframes.findIndex((candidate) => candidate.atUs === keyframe.atUs);
  return mutation({
    action: beforeKeyframe ? "keyframe_replaced" : "keyframe_inserted",
    motion: withStore(motion, store, "Layout gap animation keyframe upsert output"),
    request: freeze({ kind: "keyframe.upsert", trackId, keyframe: copyKeyframe(keyframe) }),
    track,
    before,
    beforeTrack: existing,
    beforeKeyframe,
    afterKeyframe: track.keyframes[index]!,
    changedPaths: [
      beforeKeyframe
        ? `/layoutGapAnimation/tracks/${trackIndex}/keyframes/${index}`
        : `/layoutGapAnimation/tracks/${trackIndex}/keyframes`,
    ],
    index,
    ...(beforeKeyframe ? { previousIndex } : {}),
  });
}

export function deleteMotionLayoutGapAnimationKeyframe(
  motion: MotionDocument,
  input: unknown,
): MotionLayoutGapAnimationMutation {
  const record = operationRecord(input, ["trackId", "atUs"], "Layout gap animation keyframe delete");
  const trackId = id(record.trackId, "Layout gap animation keyframe delete.trackId");
  const atUs = us(record.atUs, "Layout gap animation keyframe delete.atUs");
  const before = inspectMotionLayoutGapAnimation(motion);
  const trackIndex = requireTrack(before.store, trackId);
  const existing = before.store!.tracks[trackIndex]!;
  const index = existing.keyframes.findIndex((keyframe) => keyframe.atUs === atUs);
  if (index < 0) throw new Error(`Layout gap animation keyframe atUs ${atUs} is absent.`);
  if (existing.keyframes.length <= 1) {
    throw new Error("Layout gap animation keyframe delete must retain one keyframe; remove the track explicitly instead.");
  }
  const beforeKeyframe = existing.keyframes[index]!;
  const keyframes = existing.keyframes
    .filter((_keyframe, candidate) => candidate !== index)
    .map(copyKeyframe);
  const store = replaceTrack(before.store!, trackIndex, { ...existing, keyframes });
  const track = store.tracks[trackIndex]!;
  return mutation({
    action: "keyframe_deleted",
    motion: withStore(motion, store, "Layout gap animation keyframe delete output"),
    request: freeze({ kind: "keyframe.delete", trackId, atUs }),
    track,
    before,
    beforeTrack: existing,
    beforeKeyframe,
    afterKeyframe: null,
    changedPaths: [`/layoutGapAnimation/tracks/${trackIndex}/keyframes/${index}`],
    index,
  });
}

export function moveMotionLayoutGapAnimationKeyframe(
  motion: MotionDocument,
  input: unknown,
): MotionLayoutGapAnimationMutation {
  const record = operationRecord(
    input,
    ["trackId", "fromAtUs", "toAtUs"],
    "Layout gap animation keyframe move",
  );
  const trackId = id(record.trackId, "Layout gap animation keyframe move.trackId");
  const fromAtUs = us(record.fromAtUs, "Layout gap animation keyframe move.fromAtUs");
  const toAtUs = us(record.toAtUs, "Layout gap animation keyframe move.toAtUs");
  if (fromAtUs === toAtUs) {
    throw new Error("Layout gap animation keyframe move has an old/new timestamp identity mismatch.");
  }
  const before = inspectMotionLayoutGapAnimation(motion);
  const trackIndex = requireTrack(before.store, trackId);
  const existing = before.store!.tracks[trackIndex]!;
  const previousIndex = existing.keyframes.findIndex((keyframe) => keyframe.atUs === fromAtUs);
  if (previousIndex < 0) {
    throw new Error(`Layout gap animation keyframe atUs ${fromAtUs} is absent.`);
  }
  if (existing.keyframes.some((keyframe) => keyframe.atUs === toAtUs)) {
    throw new Error(`Layout gap animation keyframe atUs ${toAtUs} already exists.`);
  }
  const beforeKeyframe = existing.keyframes[previousIndex]!;
  const keyframes = existing.keyframes.map((keyframe, index) =>
    copyKeyframe(index === previousIndex ? { ...keyframe, atUs: toAtUs } : keyframe));
  keyframes.sort((left, right) => left.atUs - right.atUs);
  const store = replaceTrack(before.store!, trackIndex, { ...existing, keyframes });
  const track = store.tracks[trackIndex]!;
  const index = track.keyframes.findIndex((keyframe) => keyframe.atUs === toAtUs);
  return mutation({
    action: "keyframe_moved",
    motion: withStore(motion, store, "Layout gap animation keyframe move output"),
    request: freeze({ kind: "keyframe.move", trackId, fromAtUs, toAtUs }),
    track,
    before,
    beforeTrack: existing,
    beforeKeyframe,
    afterKeyframe: track.keyframes[index]!,
    changedPaths: [`/layoutGapAnimation/tracks/${trackIndex}/keyframes`],
    index,
    previousIndex,
  });
}

function mutation(input: {
  action: MotionLayoutGapAnimationMutationAction;
  motion: MotionDocument;
  request: Readonly<Record<string, unknown>>;
  track: MotionLayoutGapAnimationTrack;
  before: MotionLayoutGapAnimationInspection;
  beforeTrack: MotionLayoutGapAnimationTrack | undefined;
  beforeKeyframe: MotionLayoutGapAnimationKeyframe | null;
  afterKeyframe: MotionLayoutGapAnimationKeyframe | null;
  changedPaths: string[];
  index: number;
  previousIndex?: number;
  afterStore?: MotionLayoutGapAnimationDescriptor;
}): MotionLayoutGapAnimationMutation {
  const after = input.afterStore === undefined
    ? inspectMotionLayoutGapAnimation(input.motion)
    : inspectionFor(input.afterStore);
  const afterTrack = after.store?.tracks.find((track) => track.id === input.track.id) ?? null;
  return deepFreeze({
    action: input.action,
    motion: input.motion,
    request: input.request,
    requestSha256: canonicalJsonSha256(input.request),
    changedPaths: input.changedPaths,
    trackId: input.track.id,
    application: layoutGapAnimationTrackBinding(input.motion, input.track),
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

function inspectionFor(
  store: MotionLayoutGapAnimationDescriptor | undefined,
): MotionLayoutGapAnimationInspection {
  return store
    ? deepFreeze({ store, storeSha256: canonicalJsonSha256(store), tracks: [] })
    : deepFreeze({ store: null, storeSha256: null, tracks: [] });
}

function freeze<T>(value: T): T {
  return deepFreeze(value);
}
