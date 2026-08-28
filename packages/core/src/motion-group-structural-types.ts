import type { MotionDocument, MotionLayer } from "./types";

/** These limits deliberately mirror the document validator's group contract. */
export const MOTION_GROUP_LIMITS = {
  maxChildren: 256,
  maxGroups: 64,
  maxDepth: 4
} as const;

export interface MotionGroupCreateInput {
  /** A complete group layer with ordered local-timeline childLayerIds. */
  group: MotionLayer;
  /** Position in the flat layer store; append when omitted. */
  layerIndex?: number;
  /** Optional direct parent. Omit to create a root group. */
  parentGroupId?: string;
  /** Position in the parent's child order; append when omitted. */
  childIndex?: number;
  /** Position in the group's declared track, when group.trackId is set. */
  trackIndex?: number;
}

export interface MotionGroupChildAddInput {
  groupId: string;
  childLayerId: string;
  index?: number;
}

export interface MotionGroupChildRemoveInput {
  groupId: string;
  childLayerId: string;
}

export interface MotionGroupChildMoveInput {
  /** Use null to explicitly move a root layer. */
  sourceGroupId: string | null;
  destinationGroupId: string;
  childLayerId: string;
  index?: number;
}

export interface MotionGroupChildReorderInput {
  groupId: string;
  childLayerId: string;
  index: number;
}

export interface MotionGroupWrapInput {
  /** New group identity and non-timing fields. Timing and ownership are derived from the selection. */
  group: Omit<MotionLayer, "type" | "startMs" | "durationMs" | "childLayerIds">;
  childLayerIds: string[];
}

export interface MotionGroupUnwrapInput {
  groupId: string;
}

export interface MotionGroupDeleteInput {
  groupId: string;
}

export interface MotionGroupDeleteDispatchInput extends MotionGroupDeleteInput {
  /** Cascade removes the owned subtree; unwrap exposes children only when visual composition is exactly neutral. */
  disposition: "cascade" | "unwrap";
}

export interface MotionGroupDuplicateInput {
  groupId: string;
  /** A deterministic first-available <groupId>_copy id is used when omitted. */
  newGroupId?: string;
  /** Local-time shift applied to the cloned root group. */
  offsetMs?: number;
}

/** Group timing is local to its direct owner. Media trim fields are deliberately not admitted. */
export interface MotionGroupTrimInput {
  groupId: string;
  startMs?: number;
  durationMs?: number;
}

export interface MotionGroupRootReorderInput {
  /** Must identify an unowned root group; child order uses reorderMotionGroupChild instead. */
  groupId: string;
  index: number;
}

/** `atMs` is in the direct owner's timeline (document time for a root group). */
export interface MotionGroupSplitInput {
  groupId: string;
  atMs: number;
  newGroupId?: string;
}

export interface MotionGroupStructuralResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: string;
}

export interface MotionGroupCreateResult extends MotionGroupStructuralResult {
  action: "created";
  groupId: string;
  parentGroupId: string | null;
  childLayerIds: string[];
  group: MotionLayer;
}

export interface MotionGroupChildAddResult extends MotionGroupStructuralResult {
  action: "child-added";
  groupId: string;
  childLayerId: string;
  index: number;
}

export interface MotionGroupChildRemoveResult extends MotionGroupStructuralResult {
  action: "child-removed";
  groupId: string;
  childLayerId: string;
  oldLocalStartMs: number;
  newRootStartMs: number;
}

export interface MotionGroupChildMoveResult extends MotionGroupStructuralResult {
  action: "child-moved";
  childLayerId: string;
  sourceGroupId: string | null;
  destinationGroupId: string;
  oldLocalStartMs: number;
  newLocalStartMs: number;
  index: number;
}

export interface MotionGroupChildReorderResult extends MotionGroupStructuralResult {
  action: "child-reordered";
  groupId: string;
  childLayerId: string;
  oldIndex: number;
  newIndex: number;
}

export interface MotionGroupWrapResult extends MotionGroupStructuralResult {
  action: "wrapped";
  groupId: string;
  parentGroupId: string | null;
  childLayerIds: string[];
  group: MotionLayer;
}

export interface MotionGroupUnwrapResult extends MotionGroupStructuralResult {
  action: "unwrapped";
  groupId: string;
  parentGroupId: string | null;
  childLayerIds: string[];
}

export interface MotionGroupDeleteResult extends MotionGroupStructuralResult {
  action: "deleted-subtree";
  groupId: string;
  deletedLayerIds: string[];
  removedTrackRefs: string[];
}

export interface MotionGroupDuplicateResult extends MotionGroupStructuralResult {
  action: "duplicated-subtree";
  groupId: string;
  newGroupId: string;
  offsetMs: number;
  cloneIdMap: Record<string, string>;
  insertedTrackRefs: string[];
}

export interface MotionGroupTrimResult extends MotionGroupStructuralResult {
  action: "trimmed";
  groupId: string;
  oldTiming: { startMs: number; durationMs: number };
  newTiming: { startMs: number; durationMs: number };
  group: MotionLayer;
}

export interface MotionGroupRootReorderResult extends MotionGroupStructuralResult {
  action: "root-reordered";
  groupId: string;
  oldIndex: number;
  newIndex: number;
  rootLayerIds: string[];
}

export interface MotionGroupSplitResult extends MotionGroupStructuralResult {
  action: "split";
  groupId: string;
  newGroupId: string;
  atMs: number;
  splitOffsetMs: number;
  /** Each source that was split, including nested groups and intersecting leaves. */
  splitIdMap: Record<string, string>;
  originalGroup: MotionLayer;
  newGroup: MotionLayer;
}

/**
 * The ordinary layer split mutator owns keyframe and media-source trimming. Group splitting must
 * compose that operation recursively before it can be dispatched through the central timeline
 * command surface; a structure-only clone would silently lose time semantics.
 */
export const MOTION_GROUP_OWNED_LAYER_TIMELINE_INTEGRATION = {
  delete: "deleteMotionGroupSubtree",
  duplicate: "duplicateMotionGroupSubtree",
  split: "splitMotionGroupAtMs recursively composes splitLayerAtMs for intersecting owned layers and rewires each half to a distinct group subtree",
  trim: "trimMotionGroup",
  rootReorder: "reorderMotionGroupRoot"
} as const;
