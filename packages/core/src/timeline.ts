import { compareCodeUnits } from "./canonical-json";
import { isSupportedMotionColorString } from "./color";
// The evaluator's readability gate lives in core/keyframe-readability so validate, the panels and
// this file cannot drift about which keyframes animate. See that module's header for the history.
import { assertReadableLayerKeyframes, readNumericKeyframes, readStringKeyframes, type NumericMotionKeyframe } from "./keyframe-readability";
import { parseMotionPathViewBox, validateMotionPathData } from "./path-contract";
import { cloneMotionKeyframe, interpolateSpatialPosition } from "./spatial-path";
import {
  isSpringEasing,
  resolveSpringEasing,
  springPresetEasing,
  validateSpringEasing
} from "./spring";
import type { MotionAudioDucking, MotionAudioDuckingMode, MotionDocument, MotionEasing, MotionKeyframe, MotionKeyframeTarget, MotionKeyframeValue, MotionLayer, MotionMarker, MotionScene, MotionTrack, MotionTransition } from "./types";
// Animation-preset and easing catalogs live in ./timeline-presets for the module-size gate; public preset types and easing lists are re-exported so direct imports remain unchanged.
import { MOTION_ANIMATION_PRESET_BY_ID, MOTION_ANIMATION_PRESETS, MOTION_EASING_PRESETS, NAMED_EASINGS, type MotionAnimationPreset, type MotionAnimationPresetId, type MotionAnimationPresetKind, type MotionEasingPreset } from "./timeline-presets";
export { NAMED_EASINGS_LIST } from "./timeline-presets";
export type { MotionAnimationPreset, MotionAnimationPresetId, MotionAnimationPresetKind, MotionEasingPreset } from "./timeline-presets";

// The keyframe-target vocabulary (the accepted-target list and each target's value family) lives in
// ./keyframe-targets: pure data, no behaviour, and the largest block between this file and its size
// budget. SUPPORTED_KEYFRAME_TARGET_LIST is re-exported so importers of ./timeline are unchanged.
export { SUPPORTED_KEYFRAME_TARGET_LIST } from "./keyframe-targets";
import {
  BLEND_MODE_KEYFRAME_TARGETS,
  COLOR_KEYFRAME_TARGETS,
  DISCRETE_STRING_KEYFRAME_TARGETS,
  NON_NEGATIVE_KEYFRAME_TARGETS,
  PAN_KEYFRAME_TARGETS,
  POSITIVE_KEYFRAME_TARGETS,
  SUPPORTED_KEYFRAME_TARGETS,
  SUPPORTED_KEYFRAME_TARGET_LIST,
  TEXT_ALIGN_KEYFRAME_VALUES,
  VERTICAL_ALIGN_KEYFRAME_VALUES
} from "./keyframe-targets";
const STYLE_COLOR_PROPERTIES = new Set(["color", "fill", "stroke", "borderColor", "backgroundColor", "background"]);
const STYLE_STRING_PROPERTIES = new Set(["fontFamily"]);
const STYLE_POSITIVE_NUMBER_PROPERTIES = new Set(["fontSize", "fontWeight", "lineHeight"]);
const STYLE_FINITE_NUMBER_PROPERTIES = new Set(["letterSpacing"]);
const STYLE_NON_NEGATIVE_NUMBER_PROPERTIES = new Set([
  "width",
  "height",
  "radius",
  "borderRadius",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "strokeWidth",
  "borderWidth"
]);
const TRANSFORM_FINITE_NUMBER_PROPERTIES = new Set(["x", "y", "originX", "originY", "rotation"]);
const TRANSFORM_NON_NEGATIVE_NUMBER_PROPERTIES = new Set(["width", "height"]);
const TRANSFORM_POSITIVE_NUMBER_PROPERTIES = new Set(["scale"]);
const EFFECT_NON_NEGATIVE_NUMBER_PROPERTIES = new Set(["blur", "brightness", "contrast", "saturate", "grayscale"]);
const SUPPORTED_BLEND_MODES = new Set([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-lighter"
]);
const SUPPORTED_MASK_TYPES = new Set(["rect", "rounded-rect", "path"]);
const SUPPORTED_MEDIA_FITS = new Set<TimelineLayerMediaFit>(["fill", "contain", "cover", "none", "scale-down"]);
const SUPPORTED_MEDIA_SOURCE_LAYER_TYPES = new Set(["image", "video", "audio", "web"]);
const SUPPORTED_TRANSITIONS = new Set(["fade", "slide", "wipe"]);
const SUPPORTED_TRANSITION_DIRECTIONS = new Set(["left", "right", "up", "down"]);
const SUPPORTED_KEYFRAME_SNAP_MODES = new Set<LayerKeyframeSnapMode>(["nearest", "floor", "ceil"]);
const CUBIC_BEZIER_PATTERN = /^cubic-bezier\(\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*\)$/i;
const STEPS_PATTERN = /^steps\(\s*([1-9]\d*)\s*(?:,\s*(start|end|jump-start|jump-end))?\s*\)$/i;
const DURATION_POLICY_EXTENSION_KEY = "x-shellx-duration-policy";

interface TimelineDurationProtectedRegion {
  id: string;
  label?: string;
  role?: string;
  startMs: number;
  durationMs: number;
}

interface TimelineDurationPolicy {
  schema: "shellx-motion/duration-policy@1";
  minDurationMs?: number;
  maxDurationMs?: number;
  resizeMode?: "stretch-middle" | "ripple" | "fixed";
  protectedRegions: TimelineDurationProtectedRegion[];
}

export interface LayerKeyframeUpsert {
  target: MotionKeyframeTarget;
  atMs: number;
  value: MotionKeyframeValue;
  easing?: MotionEasing;
}

export interface LayerKeyframeUpsertResult {
  layer: MotionLayer;
  changedPath: string;
  action: "inserted" | "replaced";
}

export interface LayerKeyframeDelete {
  target: MotionKeyframeTarget;
  atMs: number;
}

export interface LayerKeyframeDeleteResult {
  layer: MotionLayer;
  changedPath: string;
  action: "deleted";
  removed: MotionKeyframe;
  remainingCount: number;
}

export interface LayerKeyframeRangeDelete {
  target: MotionKeyframeTarget;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeRangeDeleteResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "deleted";
  target: MotionKeyframeTarget;
  startMs?: number;
  endMs?: number;
  removedKeyframes: Array<{ target: MotionKeyframeTarget; atMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
  remainingCount: number;
}

export interface LayerKeyframeMove {
  target: MotionKeyframeTarget;
  fromMs: number;
  toMs: number;
}

export interface LayerKeyframeMoveResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "moved";
  target: MotionKeyframeTarget;
  fromMs: number;
  toMs: number;
  previousKeyframe: MotionKeyframe;
  keyframe: MotionKeyframe;
}

export interface LayerKeyframeShift {
  target: MotionKeyframeTarget;
  deltaMs: number;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeShiftResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "shifted";
  target: MotionKeyframeTarget;
  deltaMs: number;
  startMs?: number;
  endMs?: number;
  shiftedKeyframes: Array<{ target: MotionKeyframeTarget; fromMs: number; toMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
}

export interface LayerKeyframeScale {
  target: MotionKeyframeTarget;
  scale: number;
  originMs: number;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeScaleResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "scaled";
  target: MotionKeyframeTarget;
  scale: number;
  originMs: number;
  startMs?: number;
  endMs?: number;
  scaledKeyframes: Array<{ target: MotionKeyframeTarget; fromMs: number; toMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
}

export interface LayerKeyframeDuplicate {
  target: MotionKeyframeTarget;
  deltaMs: number;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeDuplicateResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "duplicated";
  target: MotionKeyframeTarget;
  deltaMs: number;
  startMs?: number;
  endMs?: number;
  duplicatedKeyframes: Array<{ target: MotionKeyframeTarget; fromMs: number; toMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
}

export interface LayerKeyframeDistribute {
  target: MotionKeyframeTarget;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeDistributeResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "distributed";
  target: MotionKeyframeTarget;
  startMs: number;
  endMs: number;
  spacingMs: number;
  distributedKeyframes: Array<{ target: MotionKeyframeTarget; fromMs: number; toMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
}

export interface LayerKeyframeReverse {
  target: MotionKeyframeTarget;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeReverseResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "reversed";
  target: MotionKeyframeTarget;
  startMs: number;
  endMs: number;
  reversedKeyframes: Array<{ target: MotionKeyframeTarget; fromMs: number; toMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
}

export type LayerKeyframeSnapMode = "nearest" | "floor" | "ceil";

export interface LayerKeyframeSnap {
  target: MotionKeyframeTarget;
  fps: number;
  mode?: LayerKeyframeSnapMode;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeSnapResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "snapped";
  target: MotionKeyframeTarget;
  fps: number;
  mode: LayerKeyframeSnapMode;
  startMs?: number;
  endMs?: number;
  snappedKeyframes: Array<{ target: MotionKeyframeTarget; fromMs: number; toMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
}

export interface LayerKeyframeEasingApply {
  target: MotionKeyframeTarget;
  easing: MotionEasing;
  atMs?: number;
  startMs?: number;
  endMs?: number;
}

export interface LayerKeyframeEasingApplyResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "updated";
  target: MotionKeyframeTarget;
  easing: MotionEasing;
  updatedKeyframes: Array<{ atMs: number; value: MotionKeyframeValue; oldEasing?: MotionEasing; newEasing: MotionEasing }>;
}

export interface LayerAnimationPresetApply {
  preset: MotionAnimationPresetId | string;
  startMs?: number;
  durationMs?: number;
  distancePx?: number;
  easing?: MotionEasing;
}

export interface LayerAnimationPresetApplyResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "applied";
  preset: MotionAnimationPresetId;
  timing: { startMs: number; endMs: number; durationMs: number };
  appliedKeyframes: Array<{ target: MotionKeyframeTarget; atMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
  /**
   * Keyframes the preset OVERWROTE, with the value each one held before.
   *
   * `upsertLayerKeyframe` already decides `inserted` vs `replaced` per keyframe; this result threw
   * that verdict away, so an author who applied a preset over their own hand-authored keyframes was
   * told only `action: "applied"` and lost the old values with no record of it. Empty on the common
   * path — a preset applied to a layer with no keyframes at that time reports nothing.
   */
  replacedKeyframes: Array<{ target: MotionKeyframeTarget; atMs: number; oldValue: MotionKeyframeValue; newValue: MotionKeyframeValue }>;
}

export interface LayerGroupAnimationPresetApply extends LayerAnimationPresetApply {
  layerIds: string[];
  staggerMs?: number;
}

export interface LayerGroupAnimationPresetApplyResult {
  layers: MotionLayer[];
  changedPaths: string[];
  action: "applied";
  preset: MotionAnimationPresetId;
  staggerMs: number;
  applications: Array<{
    layerId: string;
    changedPaths: string[];
    timing: { startMs: number; endMs: number; durationMs: number };
    appliedKeyframes: Array<{ target: MotionKeyframeTarget; atMs: number; value: MotionKeyframeValue; easing?: MotionEasing }>;
    /** See {@link LayerAnimationPresetApplyResult.replacedKeyframes}; per layer in the group. */
    replacedKeyframes: Array<{ target: MotionKeyframeTarget; atMs: number; oldValue: MotionKeyframeValue; newValue: MotionKeyframeValue }>;
  }>;
}

export interface LayerTimingTrim {
  startMs?: number;
  durationMs?: number;
  trimStartMs?: number;
  trimDurationMs?: number;
}

export interface LayerTimingSnapshot {
  startMs: number;
  durationMs: number;
  trimStartMs?: number;
  trimDurationMs?: number;
}

export interface LayerTimingTrimResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "updated";
  oldTiming: LayerTimingSnapshot;
  newTiming: LayerTimingSnapshot;
}

export interface LayerSplitAtMs {
  layerId: string;
  atMs: number;
  newLayerId?: string;
}

export interface LayerSplitAtMsResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "split";
  layerId: string;
  newLayerId: string;
  atMs: number;
  splitOffsetMs: number;
  sourceOffsetMs: number | undefined;
  originalLayer: MotionLayer;
  newLayer: MotionLayer;
  oldTiming: LayerTimingSnapshot;
  newTimings: {
    original: LayerTimingSnapshot;
    split: LayerTimingSnapshot;
  };
}

export interface TimelineLayerCreate {
  layer: MotionLayer;
  index?: number;
  trackId?: string;
  trackIndex?: number;
}

export interface TimelineLayerCreateResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "created";
  layerId: string;
  index: number;
  trackId?: string;
  trackIndex?: number;
  layer: MotionLayer;
  oldLayerCount: number;
  newLayerCount: number;
  insertedTrackRefs: string[];
}

export interface TimelineLayerDelete {
  layerId: string;
}

export interface TimelineLayerDeleteResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "deleted";
  layerId: string;
  removed: MotionLayer;
  remainingCount: number;
  removedTrackRefs: string[];
}

export interface TimelineLayerDuplicate {
  layerId: string;
  newLayerId?: string;
  offsetMs?: number;
}

export interface TimelineLayerDuplicateResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "duplicated";
  layerId: string;
  newLayerId: string;
  offsetMs: number;
  sourceLayer: MotionLayer;
  layer: MotionLayer;
  insertedTrackRefs: string[];
}

export interface TimelineLayerReorder {
  layerId: string;
  index: number;
}

export interface TimelineLayerReorderResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "reordered";
  layerId: string;
  oldIndex: number;
  newIndex: number;
  layer: MotionLayer;
  reorderedTrackRefs: string[];
}

export interface TimelineLayerTextSet {
  layerId: string;
  text: string;
}

export interface TimelineLayerNameSet {
  layerId: string;
  name: unknown;
}

export interface TimelineLayerNameSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "renamed";
  layerId: string;
  oldName: string | null;
  newName: string;
  layer: MotionLayer;
}

export interface TimelineLayerTextSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldText: string | null;
  newText: string;
  layer: MotionLayer;
}

export interface TimelineLayerStyleSet {
  layerId: string;
  property: string;
  value: unknown;
}

export interface TimelineLayerStyleSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  property: string;
  oldValue: unknown;
  newValue: string | number;
  layer: MotionLayer;
}

export interface TimelineLayerTransformSet {
  layerId: string;
  property: string;
  value: unknown;
}

export interface TimelineLayerTransformSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  property: string;
  oldValue: unknown;
  newValue: number;
  layer: MotionLayer;
}

export interface TimelineLayerEffectSet {
  layerId: string;
  property: string;
  value: unknown;
}

export interface TimelineLayerEffectSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  property: string;
  oldValue: unknown;
  newValue: number;
  layer: MotionLayer;
}

export interface TimelineLayerBlendModeSet {
  layerId: string;
  blendMode: unknown;
}

export interface TimelineLayerBlendModeSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldBlendMode: MotionLayer["blendMode"] | null;
  newBlendMode: MotionLayer["blendMode"];
  layer: MotionLayer;
}

export interface TimelineLayerCropSet {
  layerId: string;
  crop: unknown;
}

export interface TimelineLayerCropSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldCrop: NonNullable<MotionLayer["crop"]> | null;
  newCrop: NonNullable<MotionLayer["crop"]>;
  layer: MotionLayer;
}

export interface TimelineLayerMaskSet {
  layerId: string;
  mask: unknown;
}

export interface TimelineLayerMaskSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldMask: NonNullable<MotionLayer["mask"]> | null;
  newMask: NonNullable<MotionLayer["mask"]>;
  layer: MotionLayer;
}

export type TimelineLayerMediaFit = "fill" | "contain" | "cover" | "none" | "scale-down";

export interface TimelineLayerFitSet {
  layerId: string;
  fit: unknown;
}

export interface TimelineLayerFitSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldFit: string | null;
  newFit: TimelineLayerMediaFit;
  layer: MotionLayer;
}

export interface TimelineLayerMediaSourceSet {
  layerId: string;
  source: unknown;
}

export interface TimelineLayerMediaSourceSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldSource: string | null;
  newSource: string;
  layer: MotionLayer;
}

export interface TimelineLayerVisibilitySet {
  layerId: string;
  visible: unknown;
}

export interface TimelineLayerVisibilitySetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "shown" | "hidden";
  layerId: string;
  oldVisible: boolean;
  newVisible: boolean;
  layer: MotionLayer;
}

export interface TimelineLayerLockSet {
  layerId: string;
  locked: unknown;
}

export interface TimelineLayerLockSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "locked" | "unlocked";
  layerId: string;
  oldLocked: boolean;
  newLocked: boolean;
  layer: MotionLayer;
}

export type TimelineCleanupRefReason = "missing" | "duplicate";

export interface TimelineCleanupResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "cleaned";
  removedTrackLayerRefs: Array<{ trackId: string; layerId: string; reason: TimelineCleanupRefReason }>;
  removedSceneTrackRefs: Array<{ sceneId: string; trackId: string; reason: TimelineCleanupRefReason }>;
  removedSceneMarkerRefs: Array<{ sceneId: string; markerId: string; reason: TimelineCleanupRefReason }>;
  oldDurationMs: number;
  newDurationMs: number;
  durationChanged: boolean;
}

export interface LayerTransitionUpsert {
  edge: "in" | "out";
  type: "fade" | "slide" | "wipe";
  durationMs: number;
  easing?: MotionEasing;
  direction?: "left" | "right" | "up" | "down" | string;
  distance?: number;
}

export interface LayerTransitionUpsertResult {
  layer: MotionLayer;
  changedPath: string;
  action: "inserted" | "replaced";
  transition: MotionTransition;
  previousTransition: MotionTransition | undefined;
}

export interface LayerTransitionDelete {
  edge: "in" | "out";
}

export interface LayerTransitionDeleteResult {
  layer: MotionLayer;
  changedPath: string;
  action: "deleted";
  removed: MotionTransition;
  remainingEdges: Array<"in" | "out">;
}

export interface TimelineMarkerUpsert {
  id: string;
  atMs: number;
  durationMs?: number;
  label?: string;
  type?: string;
  color?: string;
  sceneId?: string;
}

export interface TimelineMarkerUpsertResult {
  motion: MotionDocument;
  changedPath: string;
  changedPaths: string[];
  action: "inserted" | "replaced";
  marker: MotionMarker;
  previousMarker: MotionMarker | undefined;
  attachedSceneId: string | undefined;
}

export interface TimelineMarkerDelete {
  id: string;
}

export interface TimelineMarkerDeleteResult {
  motion: MotionDocument;
  changedPath: string;
  changedPaths: string[];
  action: "deleted";
  removed: MotionMarker;
  remainingCount: number;
  removedSceneRefs: string[];
}

export interface TimelineSceneResize {
  sceneId: string;
  durationMs: number;
  ripple?: boolean;
}

export interface TimelineSceneResizeResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "resized";
  sceneId: string;
  oldDurationMs: number;
  newDurationMs: number;
  deltaMs: number;
  ripple: boolean;
  scene: MotionScene;
  oldScene: MotionScene;
  shiftedSceneIds: string[];
  shiftedLayerIds: string[];
  shiftedMarkerIds: string[];
}

export interface TimelineSceneCreate {
  scene: MotionScene;
  index?: number;
}

export interface TimelineSceneCreateResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "created";
  sceneId: string;
  index: number;
  scene: MotionScene;
  referencedLayerIds: string[];
  referencedTrackIds: string[];
  referencedMarkerIds: string[];
  oldSceneCount: number;
  newSceneCount: number;
  oldDurationMs: number;
  newDurationMs: number;
  durationChanged: boolean;
}

export interface TimelineSceneDelete {
  sceneId: string;
}

export interface TimelineSceneDeleteResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "deleted";
  sceneId: string;
  removed: MotionScene;
  index: number;
  oldSceneCount: number;
  newSceneCount: number;
  oldDurationMs: number;
  newDurationMs: number;
  durationChanged: boolean;
}

export interface TimelineSceneReorder {
  sceneId: string;
  index: number;
}

export interface TimelineSceneReorderResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "reordered";
  sceneId: string;
  oldIndex: number;
  newIndex: number;
  oldSceneOrder: string[];
  newSceneOrder: string[];
  scene: MotionScene;
  oldDurationMs: number;
  newDurationMs: number;
  durationChanged: boolean;
}

export interface TimelineSceneNameSet {
  sceneId: string;
  name: string;
}

export interface TimelineSceneNameSetResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "renamed";
  sceneId: string;
  oldName: string | null;
  newName: string;
  scene: MotionScene;
}

export interface LayerTrackAssign {
  layerId: string;
  trackId: string;
  index?: number;
}

export interface LayerTrackAssignResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "assigned" | "reordered";
  layer: MotionLayer;
  oldTrackId: string | undefined;
  newTrackId: string;
  oldIndex: number | undefined;
  newIndex: number;
  removedFromTrackIds: string[];
}

export interface TimelineTrackCreate {
  track: MotionTrack;
  index?: number;
}

export interface TimelineTrackCreateResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "created";
  trackId: string;
  index: number;
  track: MotionTrack;
  attachedLayerIds: string[];
  oldTrackCount: number;
  newTrackCount: number;
}

export interface TimelineTrackReorder {
  trackId: string;
  index: number;
}

export interface TimelineTrackReorderResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "reordered";
  trackId: string;
  oldIndex: number;
  newIndex: number;
  oldTrackOrder: string[];
  newTrackOrder: string[];
  track: MotionTrack;
}

export interface TimelineTrackDelete {
  trackId: string;
  detachLayers?: boolean;
}

export interface TimelineTrackDeleteResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "deleted";
  trackId: string;
  removed: MotionTrack;
  detachedLayerIds: string[];
  removedSceneRefs: string[];
  oldTrackCount: number;
  newTrackCount: number;
}

export interface TimelineTrackRename {
  trackId: string;
  name: string;
}

export interface TimelineTrackRenameResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "renamed";
  trackId: string;
  oldName: string | null;
  newName: string;
  track: MotionTrack;
}

export interface TimelineTrackLock {
  trackId: string;
  locked: boolean;
}

export interface TimelineTrackLockResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "locked" | "unlocked";
  trackId: string;
  oldLocked: boolean;
  newLocked: boolean;
  track: MotionTrack;
}

export interface TimelineTrackMute {
  trackId: string;
  muted: boolean;
}

export interface TimelineTrackMuteResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "muted" | "unmuted";
  trackId: string;
  oldMuted: boolean;
  newMuted: boolean;
  track: MotionTrack;
}

export interface TimelineTrackSolo {
  trackId: string;
  solo: boolean;
}

export interface TimelineTrackSoloResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "soloed" | "unsoloed";
  trackId: string;
  oldSolo: boolean;
  newSolo: boolean;
  track: MotionTrack;
}

export interface TimelineTrackVolume {
  trackId: string;
  volume: number;
}

export interface TimelineTrackVolumeResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  trackId: string;
  oldVolume: number;
  newVolume: number;
  track: MotionTrack;
}

export interface TimelineTrackPan {
  trackId: string;
  pan: number;
}

export interface TimelineTrackPanResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  trackId: string;
  oldPan: number;
  newPan: number;
  track: MotionTrack;
}

export interface TimelineTrackFade {
  trackId: string;
  fadeInMs?: number;
  fadeOutMs?: number;
}

export interface TimelineTrackFadeSnapshot {
  fadeInMs: number;
  fadeOutMs: number;
}

export interface TimelineTrackFadeResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  trackId: string;
  oldFade: TimelineTrackFadeSnapshot;
  newFade: TimelineTrackFadeSnapshot;
  track: MotionTrack;
}

export interface TimelineLayerDucking {
  layerId: string;
  triggerLayerIds: string[];
  /** "timed" (default) or "sidechain"; see MotionAudioDucking for semantics. */
  mode?: MotionAudioDuckingMode;
  duckToVolume?: number;
  attackMs?: number;
  releaseMs?: number;
  /** sidechain compressor threshold, linear amplitude in (0, 1]. */
  threshold?: number;
  /** sidechain compression ratio, >= 1. */
  ratio?: number;
}

export interface TimelineLayerDuckingResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "updated";
  layerId: string;
  oldDucking: MotionAudioDucking | null;
  newDucking: MotionAudioDucking;
  layer: MotionLayer;
}

export function isSupportedKeyframeTarget(target: string): boolean {
  return readSupportedKeyframeTarget(target) !== null;
}

export function readSupportedKeyframeTarget(target: string): MotionKeyframeTarget | null {
  return SUPPORTED_KEYFRAME_TARGET_LIST.find((candidate) => candidate === target) ?? null;
}

/**
 * True when `easing` is a supported string easing form (named, spring preset
 * alias, cubic-bezier, or steps). Object springs are handled by callers via
 * {@link isSupportedEasing} / {@link readEasingValidationError}.
 */
function isSupportedEasingString(easing: string): boolean {
  return (
    NAMED_EASINGS.has(easing) ||
    springPresetEasing(easing) !== null ||
    parseCubicBezierEasing(easing) !== null ||
    parseStepsEasing(easing) !== null
  );
}

/**
 * Validate any easing value (string form or spring object) and return an honest
 * per-reason error message, or null when valid. Shared by `validate.ts` so
 * document validation and command validation report identical reasons.
 * @param easing untrusted candidate; must be present (callers guard absence).
 */
export function readEasingValidationError(easing: unknown): string | null {
  // Spring objects report field-specific reasons; string easings keep the
  // established "unsupported easing" contract that document validation asserts.
  if (isSpringEasing(easing)) return validateSpringEasing(easing);
  if (typeof easing === "string") return isSupportedEasingString(easing) ? null : "unsupported easing";
  return "easing must be a string easing or a spring easing object";
}

/**
 * True when `easing` is a supported easing (string form or a valid spring
 * object). Accepts the full {@link MotionEasing} union.
 */
export function isSupportedEasing(easing: MotionEasing): boolean {
  return readEasingValidationError(easing) === null;
}


export function isSupportedTransitionType(type: string): boolean {
  return readSupportedTransitionType(type) !== null;
}

export function readSupportedTransitionType(type: string): "fade" | "slide" | "wipe" | null {
  switch (type) {
    case "fade":
    case "slide":
    case "wipe":
      return type;
    default:
      return null;
  }
}

export function upsertTimelineMarker(motion: MotionDocument, input: TimelineMarkerUpsert): TimelineMarkerUpsertResult {
  validateTimelineMarkerInput(motion, input);

  const marker: MotionMarker = {
    id: input.id,
    atMs: input.atMs,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.color !== undefined ? { color: input.color } : {})
  };
  const markers = [...(motion.markers ?? [])];
  const existingIndex = markers.findIndex((existing) => existing.id === input.id);
  const previousMarker = existingIndex === -1 ? undefined : markers[existingIndex];
  const action = previousMarker ? "replaced" : "inserted";
  if (existingIndex === -1) {
    markers.push(marker);
  } else {
    markers[existingIndex] = marker;
  }
  markers.sort((left, right) => left.atMs - right.atMs || compareCodeUnits(left.id, right.id)); // code-unit order: persisted into motion.json

  const markerIndex = markers.findIndex((existing) => existing.id === input.id);
  const changedPath = `/markers/${markerIndex}`;
  const changedPaths = [changedPath];
  let nextScenes = motion.scenes ? motion.scenes.map((scene) => ({ ...scene, ...(scene.markerIds ? { markerIds: [...scene.markerIds] } : {}) })) : undefined;

  if (input.sceneId) {
    const sceneIndex = nextScenes?.findIndex((scene) => scene.id === input.sceneId) ?? -1;
    if (sceneIndex === -1 || !nextScenes) throw new Error(`Motion scene not found: ${input.sceneId}.`);
    const scene = nextScenes[sceneIndex];
    if (!scene.markerIds?.includes(input.id)) {
      nextScenes[sceneIndex] = {
        ...scene,
        markerIds: [...(scene.markerIds ?? []), input.id]
      };
      changedPaths.push(`/scenes/${sceneIndex}/markerIds`);
    }
  }

  return {
    motion: {
      ...motion,
      markers,
      ...(nextScenes ? { scenes: nextScenes } : {})
    },
    changedPath,
    changedPaths,
    action,
    marker,
    previousMarker,
    attachedSceneId: input.sceneId
  };
}

export function deleteTimelineMarker(motion: MotionDocument, input: TimelineMarkerDelete): TimelineMarkerDeleteResult {
  if (!isNonEmptyString(input.id)) throw new Error("Marker id is required.");

  const markers = [...(motion.markers ?? [])];
  const existingIndex = markers.findIndex((marker) => marker.id === input.id);
  if (existingIndex === -1) throw new Error(`Motion marker not found: ${input.id}.`);

  const [removed] = markers.splice(existingIndex, 1);
  const changedPath = `/markers/${existingIndex}`;
  const changedPaths = [changedPath];
  const removedSceneRefs: string[] = [];
  const nextScenes = motion.scenes?.map((scene, sceneIndex) => {
    if (!scene.markerIds?.includes(input.id)) return { ...scene, ...(scene.markerIds ? { markerIds: [...scene.markerIds] } : {}) };
    const markerIds = scene.markerIds.filter((markerId) => markerId !== input.id);
    removedSceneRefs.push(scene.id);
    changedPaths.push(`/scenes/${sceneIndex}/markerIds`);
    const nextScene = { ...scene };
    if (markerIds.length > 0) {
      nextScene.markerIds = markerIds;
    } else {
      delete nextScene.markerIds;
    }
    return nextScene;
  });
  const nextMotion: MotionDocument = {
    ...motion,
    ...(nextScenes ? { scenes: nextScenes } : {})
  };
  if (markers.length > 0) {
    nextMotion.markers = markers;
  } else {
    delete nextMotion.markers;
  }

  return {
    motion: nextMotion,
    changedPath,
    changedPaths,
    action: "deleted",
    removed,
    remainingCount: markers.length,
    removedSceneRefs
  };
}

export function resizeTimelineScene(motion: MotionDocument, input: TimelineSceneResize): TimelineSceneResizeResult {
  if (!isNonEmptyString(input.sceneId)) throw new Error("Scene id is required.");
  if (!isPositiveFinite(input.durationMs)) throw new Error("Scene durationMs must be a positive finite number.");
  const scenes = motion.scenes ?? [];
  const sceneIndex = scenes.findIndex((scene) => scene.id === input.sceneId);
  if (sceneIndex === -1) throw new Error(`Motion scene not found: ${input.sceneId}.`);

  const oldScene = scenes[sceneIndex];
  if (oldScene.durationMs === input.durationMs) throw new Error("Scene resize did not change duration.");

  const deltaMs = input.durationMs - oldScene.durationMs;
  const ripple = input.ripple === true;
  const oldEndMs = oldScene.startMs + oldScene.durationMs;
  const durationPolicy = readTimelineDurationPolicy(motion);
  validateSceneResizeProtectedRegions(durationPolicy, oldScene, input.durationMs);
  if (ripple && deltaMs !== 0) validateRippleSceneResizeLocks(motion, oldEndMs);

  const shiftedSceneIds: string[] = [];
  const shiftedLayerIds: string[] = [];
  const shiftedMarkerIds: string[] = [];
  const changedPaths = [`/scenes/${oldScene.id}/durationMs`];
  const nextScenes = scenes.map((scene) => {
    if (scene.id === oldScene.id) return { ...scene, durationMs: input.durationMs };
    if (ripple && deltaMs !== 0 && scene.startMs >= oldEndMs) {
      shiftedSceneIds.push(scene.id);
      changedPaths.push(`/scenes/${scene.id}/startMs`);
      return { ...scene, startMs: scene.startMs + deltaMs };
    }
    return { ...scene };
  });
  const nextLayers = motion.layers.map((layer) => {
    if (ripple && deltaMs !== 0 && layer.startMs >= oldEndMs) {
      shiftedLayerIds.push(layer.id);
      changedPaths.push(`/layers/${layer.id}/startMs`);
      return { ...layer, startMs: layer.startMs + deltaMs };
    }
    return layer;
  });
  const nextMarkers = motion.markers?.map((marker) => {
    if (ripple && deltaMs !== 0 && marker.atMs >= oldEndMs) {
      shiftedMarkerIds.push(marker.id);
      changedPaths.push(`/markers/${marker.id}/atMs`);
      return { ...marker, atMs: marker.atMs + deltaMs };
    }
    return { ...marker };
  });
  const shiftedPolicy = shiftTimelineDurationPolicy(durationPolicy, {
    ripple,
    deltaMs,
    oldEndMs,
    changedPaths
  });

  const nextMotion: MotionDocument = {
    ...motion,
    scenes: nextScenes,
    layers: nextLayers,
    ...(nextMarkers ? { markers: nextMarkers } : {})
  };
  const nextDurationMs = timelineDuration(nextMotion);
  if (nextDurationMs !== motion.durationMs) {
    nextMotion.durationMs = nextDurationMs;
    changedPaths.push("/durationMs");
  }
  validateTimelineDurationPolicyBounds(shiftedPolicy.policy, nextMotion.durationMs);
  validateTimelineDurationPolicyRegions(shiftedPolicy.policy, nextMotion.durationMs);
  if (shiftedPolicy.changed) {
    nextMotion[DURATION_POLICY_EXTENSION_KEY] = shiftedPolicy.policy;
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "resized",
    sceneId: oldScene.id,
    oldDurationMs: oldScene.durationMs,
    newDurationMs: input.durationMs,
    deltaMs,
    ripple,
    scene: nextScenes[sceneIndex],
    oldScene,
    shiftedSceneIds,
    shiftedLayerIds,
    shiftedMarkerIds
  };
}

export function createTimelineScene(motion: MotionDocument, input: TimelineSceneCreate): TimelineSceneCreateResult {
  const scene: MotionScene = structuredClone(input.scene);
  if (!isNonEmptyString(scene.id)) throw new Error("Scene id is required.");
  if (!isNonNegativeFinite(scene.startMs)) throw new Error("Scene startMs must be a non-negative finite number.");
  if (!isPositiveFinite(scene.durationMs)) throw new Error("Scene durationMs must be a positive finite number.");

  scene.id = scene.id.trim();
  if (scene.name !== undefined) {
    if (typeof scene.name !== "string" || !scene.name.trim()) throw new Error("Scene name must be a non-empty string when provided.");
    scene.name = scene.name.trim();
  }

  const sourceScenes = motion.scenes ?? [];
  if (sourceScenes.some((candidate) => candidate.id === scene.id)) {
    throw new Error(`Motion scene id already exists: ${scene.id}.`);
  }

  const index = input.index ?? sourceScenes.length;
  if (!Number.isInteger(index) || index < 0 || index > sourceScenes.length) {
    throw new Error("Scene create index must be a non-negative integer within the scene list.");
  }

  if (scene.layerIds !== undefined) {
    if (!Array.isArray(scene.layerIds)) throw new Error("Scene layerIds must be non-empty strings.");
    scene.layerIds = scene.layerIds.map((layerId) => typeof layerId === "string" ? layerId.trim() : layerId);
    if (scene.layerIds.some((layerId) => !isNonEmptyString(layerId))) {
      throw new Error("Scene layerIds must be non-empty strings.");
    }
    if (new Set(scene.layerIds).size !== scene.layerIds.length) {
      throw new Error("Scene layerIds must be unique.");
    }
    const layerIds = new Set(motion.layers.map((layer) => layer.id));
    for (const layerId of scene.layerIds) {
      if (!layerIds.has(layerId)) throw new Error(`Motion layer not found: ${layerId}.`);
    }
  }

  if (scene.trackIds !== undefined) {
    if (!Array.isArray(scene.trackIds)) throw new Error("Scene trackIds must be non-empty strings.");
    scene.trackIds = scene.trackIds.map((trackId) => typeof trackId === "string" ? trackId.trim() : trackId);
    if (scene.trackIds.some((trackId) => !isNonEmptyString(trackId))) {
      throw new Error("Scene trackIds must be non-empty strings.");
    }
    if (new Set(scene.trackIds).size !== scene.trackIds.length) {
      throw new Error("Scene trackIds must be unique.");
    }
    const trackIds = new Set((motion.tracks ?? []).map((track) => track.id));
    for (const trackId of scene.trackIds) {
      if (!trackIds.has(trackId)) throw new Error(`Motion track not found: ${trackId}.`);
    }
  }

  if (scene.markerIds !== undefined) {
    if (!Array.isArray(scene.markerIds)) throw new Error("Scene markerIds must be non-empty strings.");
    scene.markerIds = scene.markerIds.map((markerId) => typeof markerId === "string" ? markerId.trim() : markerId);
    if (scene.markerIds.some((markerId) => !isNonEmptyString(markerId))) {
      throw new Error("Scene markerIds must be non-empty strings.");
    }
    if (new Set(scene.markerIds).size !== scene.markerIds.length) {
      throw new Error("Scene markerIds must be unique.");
    }
    const markerIds = new Set((motion.markers ?? []).map((marker) => marker.id));
    for (const markerId of scene.markerIds) {
      if (!markerIds.has(markerId)) throw new Error(`Motion marker not found: ${markerId}.`);
    }
  }

  const nextScenes = sourceScenes.map((candidate) => ({
    ...candidate,
    ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {}),
    ...(candidate.trackIds ? { trackIds: [...candidate.trackIds] } : {}),
    ...(candidate.markerIds ? { markerIds: [...candidate.markerIds] } : {})
  }));
  nextScenes.splice(index, 0, scene);

  const changedPaths = [`/scenes/${scene.id}`];
  const nextMotion: MotionDocument = {
    ...motion,
    scenes: nextScenes
  };
  const oldDurationMs = motion.durationMs;
  const newDurationMs = Math.max(oldDurationMs, timelineDuration(nextMotion));
  const durationChanged = newDurationMs !== oldDurationMs;
  if (durationChanged) {
    nextMotion.durationMs = newDurationMs;
    changedPaths.push("/durationMs");
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "created",
    sceneId: scene.id,
    index,
    scene,
    referencedLayerIds: scene.layerIds ?? [],
    referencedTrackIds: scene.trackIds ?? [],
    referencedMarkerIds: scene.markerIds ?? [],
    oldSceneCount: sourceScenes.length,
    newSceneCount: nextScenes.length,
    oldDurationMs,
    newDurationMs,
    durationChanged
  };
}

export function deleteTimelineScene(motion: MotionDocument, input: TimelineSceneDelete): TimelineSceneDeleteResult {
  if (!isNonEmptyString(input.sceneId)) throw new Error("Scene id is required.");
  const sourceScenes = motion.scenes ?? [];
  if (sourceScenes.length === 0) throw new Error("Motion document has no timeline scenes.");

  const sceneId = input.sceneId.trim();
  const index = sourceScenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) throw new Error(`Motion scene not found: ${sceneId}.`);

  const cloneScene = (scene: MotionScene): MotionScene => ({
    ...scene,
    ...(scene.trackIds ? { trackIds: [...scene.trackIds] } : {}),
    ...(scene.markerIds ? { markerIds: [...scene.markerIds] } : {})
  });
  const removed = cloneScene(sourceScenes[index]);
  const nextScenes = sourceScenes
    .filter((_, sceneIndex) => sceneIndex !== index)
    .map(cloneScene);
  const nextMotion: MotionDocument = { ...motion };
  if (nextScenes.length > 0) {
    nextMotion.scenes = nextScenes;
  } else {
    delete nextMotion.scenes;
  }

  return {
    motion: nextMotion,
    changedPaths: [`/scenes/${sceneId}`],
    action: "deleted",
    sceneId,
    removed,
    index,
    oldSceneCount: sourceScenes.length,
    newSceneCount: nextScenes.length,
    oldDurationMs: motion.durationMs,
    newDurationMs: motion.durationMs,
    durationChanged: false
  };
}

export function reorderTimelineScene(motion: MotionDocument, input: TimelineSceneReorder): TimelineSceneReorderResult {
  if (!isNonEmptyString(input.sceneId)) throw new Error("Scene id is required.");
  const sourceScenes = motion.scenes ?? [];
  if (sourceScenes.length === 0) throw new Error("Motion document has no timeline scenes.");
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= sourceScenes.length) {
    throw new Error("Scene reorder index must be a non-negative integer within the scene list.");
  }

  const sceneId = input.sceneId.trim();
  const oldIndex = sourceScenes.findIndex((scene) => scene.id === sceneId);
  if (oldIndex === -1) throw new Error(`Motion scene not found: ${sceneId}.`);
  if (oldIndex === input.index) throw new Error("Scene reorder did not change scene order.");

  const cloneScene = (scene: MotionScene): MotionScene => ({
    ...scene,
    ...(scene.trackIds ? { trackIds: [...scene.trackIds] } : {}),
    ...(scene.markerIds ? { markerIds: [...scene.markerIds] } : {})
  });
  const nextScenes = sourceScenes.map(cloneScene);
  const [scene] = nextScenes.splice(oldIndex, 1);
  nextScenes.splice(input.index, 0, scene);

  return {
    motion: {
      ...motion,
      scenes: nextScenes
    },
    changedPaths: ["/scenes"],
    action: "reordered",
    sceneId,
    oldIndex,
    newIndex: input.index,
    oldSceneOrder: sourceScenes.map((candidate) => candidate.id),
    newSceneOrder: nextScenes.map((candidate) => candidate.id),
    scene,
    oldDurationMs: motion.durationMs,
    newDurationMs: motion.durationMs,
    durationChanged: false
  };
}

export function setTimelineSceneName(motion: MotionDocument, input: TimelineSceneNameSet): TimelineSceneNameSetResult {
  if (!isNonEmptyString(input.sceneId)) throw new Error("Scene id is required.");
  const newName = typeof input.name === "string" ? input.name.trim() : "";
  if (!newName) throw new Error("Scene name is required.");

  const sceneId = input.sceneId.trim();
  const scenes = motion.scenes ?? [];
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex === -1) throw new Error(`Motion scene not found: ${sceneId}.`);

  const scene = scenes[sceneIndex];
  const oldName = scene.name ?? null;
  if ((oldName ?? "") === newName) throw new Error("Scene name did not change.");

  const nextScene: MotionScene = {
    ...scene,
    ...(scene.trackIds ? { trackIds: [...scene.trackIds] } : {}),
    ...(scene.markerIds ? { markerIds: [...scene.markerIds] } : {}),
    name: newName
  };
  const nextScenes = scenes.map((candidate, index) => {
    if (index === sceneIndex) return nextScene;
    return {
      ...candidate,
      ...(candidate.trackIds ? { trackIds: [...candidate.trackIds] } : {}),
      ...(candidate.markerIds ? { markerIds: [...candidate.markerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      scenes: nextScenes
    },
    changedPaths: [`/scenes/${sceneId}/name`],
    action: "renamed",
    sceneId,
    oldName,
    newName,
    scene: nextScene
  };
}

export function cleanupMotionTimeline(motion: MotionDocument): TimelineCleanupResult {
  const changedPaths: string[] = [];
  const removedTrackLayerRefs: TimelineCleanupResult["removedTrackLayerRefs"] = [];
  const removedSceneTrackRefs: TimelineCleanupResult["removedSceneTrackRefs"] = [];
  const removedSceneMarkerRefs: TimelineCleanupResult["removedSceneMarkerRefs"] = [];
  const layerIds = new Set(motion.layers.map((layer) => layer.id));
  const trackIds = new Set((motion.tracks ?? []).map((track) => track.id));
  const markerIds = new Set((motion.markers ?? []).map((marker) => marker.id));

  const tracks = motion.tracks?.map((track) => {
    if (!track.layerIds) return { ...track };
    const seen = new Set<string>();
    const cleanLayerIds: string[] = [];
    for (const layerId of track.layerIds) {
      if (!layerIds.has(layerId)) {
        removedTrackLayerRefs.push({ trackId: track.id, layerId, reason: "missing" });
        continue;
      }
      if (seen.has(layerId)) {
        removedTrackLayerRefs.push({ trackId: track.id, layerId, reason: "duplicate" });
        continue;
      }
      seen.add(layerId);
      cleanLayerIds.push(layerId);
    }
    if (stringArraysEqual(track.layerIds, cleanLayerIds)) return { ...track, layerIds: [...track.layerIds] };
    changedPaths.push(`/tracks/${track.id}/layerIds`);
    const nextTrack: MotionTrack = { ...track };
    if (cleanLayerIds.length > 0) {
      nextTrack.layerIds = cleanLayerIds;
    } else {
      delete nextTrack.layerIds;
    }
    return nextTrack;
  });

  const scenes = motion.scenes?.map((scene) => {
    let nextScene: MotionScene = { ...scene };
    if (scene.trackIds) {
      const seen = new Set<string>();
      const cleanTrackIds: string[] = [];
      for (const trackId of scene.trackIds) {
        if (!trackIds.has(trackId)) {
          removedSceneTrackRefs.push({ sceneId: scene.id, trackId, reason: "missing" });
          continue;
        }
        if (seen.has(trackId)) {
          removedSceneTrackRefs.push({ sceneId: scene.id, trackId, reason: "duplicate" });
          continue;
        }
        seen.add(trackId);
        cleanTrackIds.push(trackId);
      }
      if (stringArraysEqual(scene.trackIds, cleanTrackIds)) {
        nextScene.trackIds = [...scene.trackIds];
      } else {
        changedPaths.push(`/scenes/${scene.id}/trackIds`);
        nextScene = { ...nextScene };
        if (cleanTrackIds.length > 0) {
          nextScene.trackIds = cleanTrackIds;
        } else {
          delete nextScene.trackIds;
        }
      }
    }

    if (scene.markerIds) {
      const seen = new Set<string>();
      const cleanMarkerIds: string[] = [];
      for (const markerId of scene.markerIds) {
        if (!markerIds.has(markerId)) {
          removedSceneMarkerRefs.push({ sceneId: scene.id, markerId, reason: "missing" });
          continue;
        }
        if (seen.has(markerId)) {
          removedSceneMarkerRefs.push({ sceneId: scene.id, markerId, reason: "duplicate" });
          continue;
        }
        seen.add(markerId);
        cleanMarkerIds.push(markerId);
      }
      if (stringArraysEqual(scene.markerIds, cleanMarkerIds)) {
        nextScene.markerIds = [...scene.markerIds];
      } else {
        changedPaths.push(`/scenes/${scene.id}/markerIds`);
        nextScene = { ...nextScene };
        if (cleanMarkerIds.length > 0) {
          nextScene.markerIds = cleanMarkerIds;
        } else {
          delete nextScene.markerIds;
        }
      }
    }
    return nextScene;
  });

  const nextMotion: MotionDocument = {
    ...motion,
    ...(tracks ? { tracks } : {}),
    ...(scenes ? { scenes } : {})
  };
  const oldDurationMs = motion.durationMs;
  const computedDurationMs = timelineDuration(nextMotion);
  const newDurationMs = computedDurationMs > 0 ? computedDurationMs : oldDurationMs;
  const durationChanged = newDurationMs !== oldDurationMs;
  if (durationChanged) {
    nextMotion.durationMs = newDurationMs;
    changedPaths.push("/durationMs");
  }

  if (changedPaths.length === 0) {
    throw new Error("Timeline cleanup did not change anything.");
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "cleaned",
    removedTrackLayerRefs,
    removedSceneTrackRefs,
    removedSceneMarkerRefs,
    oldDurationMs,
    newDurationMs,
    durationChanged
  };
}

export function assignLayerTrack(motion: MotionDocument, input: LayerTrackAssign): LayerTrackAssignResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (input.index !== undefined && (!Number.isInteger(input.index) || input.index < 0)) {
    throw new Error("Track index must be a non-negative integer.");
  }

  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const tracks = motion.tracks ?? [];
  if (tracks.length === 0) throw new Error("Motion document has no timeline tracks.");
  const targetTrackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (targetTrackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const layer = motion.layers[layerIndex];
  const oldTrackId = layer.trackId;
  const sourceTrackIndex = oldTrackId ? tracks.findIndex((track) => track.id === oldTrackId) : -1;
  const referencingTrackIndexes = tracks
    .map((track, index) => track.layerIds?.includes(input.layerId) ? index : -1)
    .filter((index) => index !== -1);
  for (const trackIndex of referencingTrackIndexes) {
    if (tracks[trackIndex].locked) throw new Error(`Source track is locked: ${tracks[trackIndex].id}.`);
  }
  if (sourceTrackIndex !== -1 && tracks[sourceTrackIndex].locked) throw new Error(`Source track is locked: ${oldTrackId}.`);
  if (tracks[targetTrackIndex].locked) throw new Error(`Target track is locked: ${input.trackId}.`);
  assertLayerUnlocked(layer);

  const oldIndex = oldTrackId ? tracks.find((track) => track.id === oldTrackId)?.layerIds?.indexOf(input.layerId) : undefined;
  const normalizedOldIndex = oldIndex !== undefined && oldIndex >= 0 ? oldIndex : undefined;
  if (oldTrackId === input.trackId && input.index === undefined && referencingTrackIndexes.includes(targetTrackIndex)) {
    throw new Error("Layer track assignment did not change track order.");
  }
  const nextTracks = tracks.map((track) => cloneTrackWithLayerIds(track));
  const removedFromTrackIds: string[] = [];
  for (const track of nextTracks) {
    const before = track.layerIds ?? [];
    const after = before.filter((layerId) => layerId !== input.layerId);
    if (after.length !== before.length) {
      removedFromTrackIds.push(track.id);
      track.layerIds = after;
    }
  }

  const targetTrack = nextTracks[targetTrackIndex];
  const targetLayerIds = targetTrack.layerIds ?? [];
  const newIndex = input.index ?? targetLayerIds.length;
  if (newIndex > targetLayerIds.length) throw new Error("Track index is outside the target track layer order.");
  targetLayerIds.splice(newIndex, 0, input.layerId);
  targetTrack.layerIds = targetLayerIds;

  const nextLayer: MotionLayer = { ...layer, trackId: input.trackId };
  const changedPaths: string[] = [];
  if (oldTrackId !== input.trackId) changedPaths.push(`/layers/${input.layerId}/trackId`);
  nextTracks.forEach((track, trackIndex) => {
    const before = tracks[trackIndex].layerIds ?? [];
    const after = track.layerIds ?? [];
    if (!stringArraysEqual(before, after)) changedPaths.push(`/tracks/${trackIndex}/layerIds`);
  });
  if (changedPaths.length === 0) throw new Error("Layer track assignment did not change track order.");

  return {
    motion: {
      ...motion,
      tracks: nextTracks,
      layers: motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : candidate)
    },
    changedPaths,
    action: oldTrackId === input.trackId ? "reordered" : "assigned",
    layer: nextLayer,
    oldTrackId,
    newTrackId: input.trackId,
    oldIndex: normalizedOldIndex,
    newIndex,
    removedFromTrackIds: removedFromTrackIds.filter((trackId) => trackId !== input.trackId)
  };
}

export function createTimelineTrack(motion: MotionDocument, input: TimelineTrackCreate): TimelineTrackCreateResult {
  const track: MotionTrack = structuredClone(input.track);
  if (!isNonEmptyString(track.id)) throw new Error("Track id is required.");
  if (!isNonEmptyString(track.type)) throw new Error("Track type is required.");

  track.id = track.id.trim();
  track.type = track.type.trim();
  const sourceTracks = motion.tracks ?? [];
  if (sourceTracks.some((candidate) => candidate.id === track.id)) {
    throw new Error(`Motion track id already exists: ${track.id}.`);
  }

  const index = input.index ?? sourceTracks.length;
  if (!Number.isInteger(index) || index < 0 || index > sourceTracks.length) {
    throw new Error("Track create index must be a non-negative integer within the track stack.");
  }

  const layerIds = (track.layerIds ?? []).map((layerId) => typeof layerId === "string" ? layerId.trim() : layerId);
  if (layerIds.some((layerId) => !isNonEmptyString(layerId))) {
    throw new Error("Track layerIds must be non-empty strings.");
  }
  if (new Set(layerIds).size !== layerIds.length) {
    throw new Error("Track layerIds must be unique.");
  }

  const layerById = new Map(motion.layers.map((layer) => [layer.id, layer]));
  for (const layerId of layerIds) {
    const layer = layerById.get(layerId);
    if (!layer) throw new Error(`Motion layer not found: ${layerId}.`);
    const referencingTrack = sourceTracks.find((candidate) => candidate.layerIds?.includes(layerId));
    if (referencingTrack) throw new Error(`Motion layer already belongs to track: ${referencingTrack.id}.`);
    if (layer.trackId && layer.trackId !== track.id) throw new Error(`Motion layer already belongs to track: ${layer.trackId}.`);
  }

  const nextTrack: MotionTrack = { ...track, layerIds };
  const nextTracks = sourceTracks.map((candidate) => cloneTrackWithLayerIds(candidate));
  nextTracks.splice(index, 0, nextTrack);

  const layerIdSet = new Set(layerIds);
  const changedPaths = [`/tracks/${nextTrack.id}`];
  const nextLayers = motion.layers.map((layer) => {
    if (!layerIdSet.has(layer.id)) return layer;
    if (layer.trackId === nextTrack.id) return { ...layer };
    changedPaths.push(`/layers/${layer.id}/trackId`);
    return { ...layer, trackId: nextTrack.id };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks,
      layers: nextLayers
    },
    changedPaths,
    action: "created",
    trackId: nextTrack.id,
    index,
    track: nextTrack,
    attachedLayerIds: layerIds,
    oldTrackCount: sourceTracks.length,
    newTrackCount: nextTracks.length
  };
}

export function reorderTimelineTrack(motion: MotionDocument, input: TimelineTrackReorder): TimelineTrackReorderResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  const sourceTracks = motion.tracks ?? [];
  if (sourceTracks.length === 0) throw new Error("Motion document has no timeline tracks.");
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= sourceTracks.length) {
    throw new Error("Track reorder index must be a non-negative integer within the track stack.");
  }

  const trackId = input.trackId.trim();
  const oldIndex = sourceTracks.findIndex((track) => track.id === trackId);
  if (oldIndex === -1) throw new Error(`Motion track not found: ${trackId}.`);
  if (oldIndex === input.index) throw new Error("Track reorder did not change track order.");

  const nextTracks = sourceTracks.map((track) => cloneTrackWithLayerIds(track));
  const [track] = nextTracks.splice(oldIndex, 1);
  nextTracks.splice(input.index, 0, track);

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: ["/tracks"],
    action: "reordered",
    trackId,
    oldIndex,
    newIndex: input.index,
    oldTrackOrder: sourceTracks.map((candidate) => candidate.id),
    newTrackOrder: nextTracks.map((candidate) => candidate.id),
    track
  };
}

export function deleteTimelineTrack(motion: MotionDocument, input: TimelineTrackDelete): TimelineTrackDeleteResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  const sourceTracks = motion.tracks ?? [];
  if (sourceTracks.length === 0) throw new Error("Motion document has no timeline tracks.");

  const trackId = input.trackId.trim();
  const trackIndex = sourceTracks.findIndex((track) => track.id === trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${trackId}.`);

  const removed = cloneTrackWithLayerIds(sourceTracks[trackIndex]);
  const directLayerIds = motion.layers.filter((layer) => layer.trackId === trackId).map((layer) => layer.id);
  const attachedLayerIds = uniqueStrings([...(removed.layerIds ?? []), ...directLayerIds])
    .filter((layerId) => motion.layers.some((layer) => layer.id === layerId));
  if (attachedLayerIds.length > 0 && input.detachLayers !== true) {
    throw new Error("Track has layer refs; set detachLayers to true to delete it.");
  }

  const changedPaths = [`/tracks/${trackId}`];
  const nextTracks = sourceTracks
    .filter((_, index) => index !== trackIndex)
    .map((track) => cloneTrackWithLayerIds(track));
  const attachedLayerIdSet = new Set(attachedLayerIds);
  const nextLayers = motion.layers.map((layer) => {
    if (!attachedLayerIdSet.has(layer.id) || layer.trackId !== trackId) return layer;
    const nextLayer = { ...layer };
    delete nextLayer.trackId;
    changedPaths.push(`/layers/${layer.id}/trackId`);
    return nextLayer;
  });

  const removedSceneRefs: string[] = [];
  const nextScenes = motion.scenes?.map((scene) => {
    if (!scene.trackIds?.includes(trackId)) return scene.trackIds ? { ...scene, trackIds: [...scene.trackIds] } : { ...scene };
    const trackIds = scene.trackIds.filter((candidate) => candidate !== trackId);
    removedSceneRefs.push(scene.id);
    changedPaths.push(`/scenes/${scene.id}/trackIds`);
    const nextScene = { ...scene };
    if (trackIds.length > 0) {
      nextScene.trackIds = trackIds;
    } else {
      delete nextScene.trackIds;
    }
    return nextScene;
  });

  const nextMotion: MotionDocument = {
    ...motion,
    layers: nextLayers,
    ...(nextScenes ? { scenes: nextScenes } : {})
  };
  if (nextTracks.length > 0) {
    nextMotion.tracks = nextTracks;
  } else {
    delete nextMotion.tracks;
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "deleted",
    trackId,
    removed,
    detachedLayerIds: attachedLayerIds,
    removedSceneRefs,
    oldTrackCount: sourceTracks.length,
    newTrackCount: nextTracks.length
  };
}

export function renameTimelineTrack(motion: MotionDocument, input: TimelineTrackRename): TimelineTrackRenameResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (!isNonEmptyString(input.name)) throw new Error("Track name is required.");

  const tracks = motion.tracks ?? [];
  const trackId = input.trackId.trim();
  const trackIndex = tracks.findIndex((track) => track.id === trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${trackId}.`);

  const newName = input.name.trim();
  const track = tracks[trackIndex];
  const oldName = track.name ?? null;
  if ((oldName ?? "") === newName) throw new Error("Track name did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    name: newName
  };
  const nextTracks = tracks.map((candidate, index) => index === trackIndex ? nextTrack : cloneTrackWithLayerIds(candidate));

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: [`/tracks/${trackId}/name`],
    action: "renamed",
    trackId,
    oldName,
    newName,
    track: nextTrack
  };
}

export function setTimelineTrackLock(motion: MotionDocument, input: TimelineTrackLock): TimelineTrackLockResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (typeof input.locked !== "boolean") throw new Error("Track locked must be a boolean.");

  const tracks = motion.tracks ?? [];
  const trackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const track = tracks[trackIndex];
  const oldLocked = track.locked === true;
  if (oldLocked === input.locked) throw new Error("Track lock state did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    locked: input.locked
  };
  const nextTracks = tracks.map((candidate, index) => {
    if (index === trackIndex) return nextTrack;
    return {
      ...candidate,
      ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: [`/tracks/${track.id}/locked`],
    action: input.locked ? "locked" : "unlocked",
    trackId: track.id,
    oldLocked,
    newLocked: input.locked,
    track: nextTrack
  };
}

export function timelineLayerLockedTrackId(motion: MotionDocument, layer: MotionLayer): string | null {
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  return lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
}

export function setTimelineTrackMute(motion: MotionDocument, input: TimelineTrackMute): TimelineTrackMuteResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (typeof input.muted !== "boolean") throw new Error("Track muted must be a boolean.");

  const tracks = motion.tracks ?? [];
  const trackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const track = tracks[trackIndex];
  const oldMuted = track.muted === true;
  if (oldMuted === input.muted) throw new Error("Track mute state did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    muted: input.muted
  };
  const nextTracks = tracks.map((candidate, index) => {
    if (index === trackIndex) return nextTrack;
    return {
      ...candidate,
      ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: [`/tracks/${track.id}/muted`],
    action: input.muted ? "muted" : "unmuted",
    trackId: track.id,
    oldMuted,
    newMuted: input.muted,
    track: nextTrack
  };
}

export function timelineLayerMutedTrackId(motion: MotionDocument, layer: MotionLayer): string | null {
  const tracks = motion.tracks ?? [];
  const mutedTrackIds = new Set(tracks.filter((track) => track.muted).map((track) => track.id));
  return mutedTrackIdForLayer(tracks, layer, mutedTrackIds);
}

export function setTimelineTrackSolo(motion: MotionDocument, input: TimelineTrackSolo): TimelineTrackSoloResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (typeof input.solo !== "boolean") throw new Error("Track solo must be a boolean.");

  const tracks = motion.tracks ?? [];
  const trackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const track = tracks[trackIndex];
  const oldSolo = track.solo === true;
  if (oldSolo === input.solo) throw new Error("Track solo state did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    solo: input.solo
  };
  const nextTracks = tracks.map((candidate, index) => {
    if (index === trackIndex) return nextTrack;
    return {
      ...candidate,
      ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: [`/tracks/${track.id}/solo`],
    action: input.solo ? "soloed" : "unsoloed",
    trackId: track.id,
    oldSolo,
    newSolo: input.solo,
    track: nextTrack
  };
}

export function timelineLayerSoloedTrackId(motion: MotionDocument, layer: MotionLayer): string | null {
  const tracks = motion.tracks ?? [];
  const soloedTrackIds = new Set(tracks.filter((track) => track.solo).map((track) => track.id));
  return soloedTrackIdForLayer(tracks, layer, soloedTrackIds);
}

export function setTimelineTrackVolume(motion: MotionDocument, input: TimelineTrackVolume): TimelineTrackVolumeResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (!isNonNegativeFinite(input.volume)) throw new Error("Track volume must be a non-negative finite number.");

  const tracks = motion.tracks ?? [];
  const trackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const track = tracks[trackIndex];
  const oldVolume = typeof track.volume === "number" ? track.volume : 1;
  if (oldVolume === input.volume) throw new Error("Track volume did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    volume: input.volume
  };
  const nextTracks = tracks.map((candidate, index) => {
    if (index === trackIndex) return nextTrack;
    return {
      ...candidate,
      ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: [`/tracks/${track.id}/volume`],
    action: "updated",
    trackId: track.id,
    oldVolume,
    newVolume: input.volume,
    track: nextTrack
  };
}

export function timelineLayerTrackVolume(motion: MotionDocument, layer: MotionLayer): number | undefined {
  return trackVolumeForLayer(motion.tracks ?? [], layer);
}

export function setTimelineTrackPan(motion: MotionDocument, input: TimelineTrackPan): TimelineTrackPanResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (!isPanValue(input.pan)) throw new Error("Track pan must be a finite number between -1 and 1.");

  const tracks = motion.tracks ?? [];
  const trackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const track = tracks[trackIndex];
  const oldPan = typeof track.pan === "number" ? track.pan : 0;
  if (oldPan === input.pan) throw new Error("Track pan did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    pan: input.pan
  };
  const nextTracks = tracks.map((candidate, index) => {
    if (index === trackIndex) return nextTrack;
    return {
      ...candidate,
      ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths: [`/tracks/${track.id}/pan`],
    action: "updated",
    trackId: track.id,
    oldPan,
    newPan: input.pan,
    track: nextTrack
  };
}

export function timelineLayerTrackPan(motion: MotionDocument, layer: MotionLayer): number | undefined {
  return trackPanForLayer(motion.tracks ?? [], layer);
}

export function setTimelineTrackFade(motion: MotionDocument, input: TimelineTrackFade): TimelineTrackFadeResult {
  if (!isNonEmptyString(input.trackId)) throw new Error("Track id is required.");
  if (input.fadeInMs === undefined && input.fadeOutMs === undefined) throw new Error("At least one track fade value is required.");
  if (
    (input.fadeInMs !== undefined && !isNonNegativeFinite(input.fadeInMs)) ||
    (input.fadeOutMs !== undefined && !isNonNegativeFinite(input.fadeOutMs))
  ) {
    throw new Error("Track fade values must be non-negative finite numbers.");
  }

  const tracks = motion.tracks ?? [];
  const trackIndex = tracks.findIndex((track) => track.id === input.trackId);
  if (trackIndex === -1) throw new Error(`Motion track not found: ${input.trackId}.`);

  const track = tracks[trackIndex];
  const oldFade = {
    fadeInMs: typeof track.fadeInMs === "number" ? track.fadeInMs : 0,
    fadeOutMs: typeof track.fadeOutMs === "number" ? track.fadeOutMs : 0
  };
  const newFade = {
    fadeInMs: input.fadeInMs ?? oldFade.fadeInMs,
    fadeOutMs: input.fadeOutMs ?? oldFade.fadeOutMs
  };
  const changedPaths: string[] = [];
  if (newFade.fadeInMs !== oldFade.fadeInMs) changedPaths.push(`/tracks/${track.id}/fadeInMs`);
  if (newFade.fadeOutMs !== oldFade.fadeOutMs) changedPaths.push(`/tracks/${track.id}/fadeOutMs`);
  if (changedPaths.length === 0) throw new Error("Track fade did not change.");

  const nextTrack: MotionTrack = {
    ...track,
    ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}),
    ...(input.fadeInMs !== undefined ? { fadeInMs: input.fadeInMs } : {}),
    ...(input.fadeOutMs !== undefined ? { fadeOutMs: input.fadeOutMs } : {})
  };
  const nextTracks = tracks.map((candidate, index) => {
    if (index === trackIndex) return nextTrack;
    return {
      ...candidate,
      ...(candidate.layerIds ? { layerIds: [...candidate.layerIds] } : {})
    };
  });

  return {
    motion: {
      ...motion,
      tracks: nextTracks
    },
    changedPaths,
    action: "updated",
    trackId: track.id,
    oldFade,
    newFade,
    track: nextTrack
  };
}

export function timelineLayerTrackFade(motion: MotionDocument, layer: MotionLayer): Partial<TimelineTrackFadeSnapshot> {
  return trackFadeForLayer(motion.tracks ?? [], layer);
}

export function setTimelineLayerDucking(motion: MotionDocument, input: TimelineLayerDucking): TimelineLayerDuckingResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (!Array.isArray(input.triggerLayerIds) || input.triggerLayerIds.length === 0) {
    throw new Error("Ducking triggerLayerIds must be a non-empty array.");
  }
  if (
    (input.duckToVolume !== undefined && !isNonNegativeFinite(input.duckToVolume)) ||
    (input.attackMs !== undefined && !isNonNegativeFinite(input.attackMs)) ||
    (input.releaseMs !== undefined && !isNonNegativeFinite(input.releaseMs))
  ) {
    throw new Error("Ducking values must be non-negative finite numbers.");
  }
  if (input.mode !== undefined && input.mode !== "timed" && input.mode !== "sidechain") {
    throw new Error('Ducking mode must be "timed" or "sidechain".');
  }
  // Sidechain compressor knobs are only meaningful for the "sidechain" mode but
  // are range-checked whenever supplied so an invalid value never reaches FFmpeg.
  if (input.threshold !== undefined && !(Number.isFinite(input.threshold) && input.threshold > 0 && input.threshold <= 1)) {
    throw new Error("Ducking threshold must be a finite number in (0, 1].");
  }
  if (input.ratio !== undefined && !(Number.isFinite(input.ratio) && input.ratio >= 1)) {
    throw new Error("Ducking ratio must be a finite number >= 1.");
  }

  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const layer = motion.layers[layerIndex];
  if (!isAudioMixLayer(layer)) throw new Error(`Layer ${layer.id} is not an audio layer.`);
  const lockedTrackId = timelineLayerLockedTrackId(motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer ducking on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const layerIds = new Set(motion.layers.map((candidate) => candidate.id));
  for (const triggerLayerId of input.triggerLayerIds) {
    if (!isNonEmptyString(triggerLayerId) || !layerIds.has(triggerLayerId)) {
      throw new Error(`Ducking trigger layer not found: ${String(triggerLayerId)}.`);
    }
  }

  const newDucking: MotionAudioDucking = {
    triggerLayerIds: [...input.triggerLayerIds],
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.duckToVolume !== undefined ? { duckToVolume: input.duckToVolume } : {}),
    ...(input.attackMs !== undefined ? { attackMs: input.attackMs } : {}),
    ...(input.releaseMs !== undefined ? { releaseMs: input.releaseMs } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.ratio !== undefined ? { ratio: input.ratio } : {})
  };
  const oldDucking = layer.ducking ? cloneDucking(layer.ducking) : null;
  if (oldDucking && duckingEqual(oldDucking, newDucking)) throw new Error("Layer ducking did not change.");

  const nextLayer: MotionLayer = { ...layer, ducking: newDucking };
  return {
    motion: {
      ...motion,
      layers: motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : candidate)
    },
    changedPaths: [`/layers/${layer.id}/ducking`],
    action: "updated",
    layerId: layer.id,
    oldDucking,
    newDucking,
    layer: nextLayer
  };
}

export function upsertLayerKeyframe(layer: MotionLayer, input: LayerKeyframeUpsert): LayerKeyframeUpsertResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (!Number.isFinite(input.atMs) || input.atMs < 0) throw new Error("Keyframe atMs must be a non-negative finite number.");
  validateKeyframeTargetValue(input.target, input.value);
  if (input.easing && !isSupportedEasing(input.easing)) throw new Error(`Unsupported keyframe easing: ${input.easing}`);
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const existingIndex = existingKeyframes.findIndex((entry) => entry.atMs === input.atMs);
  const preservedSpatial = input.target === "transform.x" && existingIndex >= 0 ? existingKeyframes[existingIndex].spatial : undefined;
  const keyframe: MotionKeyframe = {
    atMs: input.atMs,
    value: input.value,
    ...(input.easing ? { easing: input.easing } : {}),
    ...(preservedSpatial ? { spatial: preservedSpatial } : {})
  };
  const action = existingIndex === -1 ? "inserted" : "replaced";
  if (existingIndex === -1) {
    existingKeyframes.push(keyframe);
  } else {
    existingKeyframes[existingIndex] = keyframe;
  }
  existingKeyframes.sort((a, b) => a.atMs - b.atMs);

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: existingKeyframes
      }
    },
    changedPath: `/layers/${layer.id}/keyframes/${input.target}/${input.atMs}`,
    action
  };
}

export function deleteLayerKeyframe(layer: MotionLayer, input: LayerKeyframeDelete): LayerKeyframeDeleteResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (!Number.isFinite(input.atMs) || input.atMs < 0) throw new Error("Keyframe atMs must be a non-negative finite number.");
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const existingIndex = existingKeyframes.findIndex((entry) => entry.atMs === input.atMs);
  if (existingIndex === -1) {
    throw new Error(`No keyframe found for ${input.target} at ${input.atMs}ms.`);
  }

  const [removed] = existingKeyframes.splice(existingIndex, 1);
  const keyframes: Partial<Record<MotionKeyframeTarget, MotionKeyframe[]>> = { ...(layer.keyframes ?? {}) };
  if (existingKeyframes.length > 0) {
    keyframes[input.target] = existingKeyframes;
  } else {
    delete keyframes[input.target];
  }
  const nextKeyframes = Object.keys(keyframes).length > 0 ? keyframes : undefined;
  const layerWithoutKeyframes = { ...layer };
  delete layerWithoutKeyframes.keyframes;

  return {
    layer: nextKeyframes ? { ...layer, keyframes: nextKeyframes } : layerWithoutKeyframes,
    changedPath: `/layers/${layer.id}/keyframes/${input.target}/${input.atMs}`,
    action: "deleted",
    removed,
    remainingCount: existingKeyframes.length
  };
}

export function deleteLayerKeyframeRange(layer: MotionLayer, input: LayerKeyframeRangeDelete): LayerKeyframeRangeDeleteResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe range delete startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const removed = existingKeyframes.filter((keyframe) => {
    if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
    if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
    return true;
  });
  if (removed.length === 0) {
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const removedTimes = new Set(removed.map((keyframe) => keyframe.atMs));
  const remaining = existingKeyframes.filter((keyframe) => !removedTimes.has(keyframe.atMs));
  const keyframes: Partial<Record<MotionKeyframeTarget, MotionKeyframe[]>> = { ...(layer.keyframes ?? {}) };
  if (remaining.length > 0) {
    keyframes[input.target] = remaining;
  } else {
    delete keyframes[input.target];
  }
  const nextKeyframes = Object.keys(keyframes).length > 0 ? keyframes : undefined;
  const layerWithoutKeyframes = { ...layer };
  delete layerWithoutKeyframes.keyframes;

  return {
    layer: nextKeyframes ? { ...layer, keyframes: nextKeyframes } : layerWithoutKeyframes,
    changedPaths: removed.map((keyframe) => `/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}`),
    action: "deleted",
    target: input.target,
    ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
    ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
    removedKeyframes: removed.map((keyframe) => ({
      target: input.target,
      atMs: keyframe.atMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    })),
    remainingCount: remaining.length
  };
}

export function moveLayerKeyframe(layer: MotionLayer, input: LayerKeyframeMove): LayerKeyframeMoveResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (!isNonNegativeFinite(input.fromMs) || !isNonNegativeFinite(input.toMs)) {
    throw new Error("fromMs and toMs must be non-negative finite numbers.");
  }
  if (input.fromMs === input.toMs) throw new Error("Keyframe move did not change timestamp.");
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const existingIndex = existingKeyframes.findIndex((entry) => entry.atMs === input.fromMs);
  if (existingIndex === -1) {
    throw new Error(`No keyframe found for ${input.target} at ${input.fromMs}ms.`);
  }
  if (existingKeyframes.some((entry) => entry.atMs === input.toMs)) {
    throw new Error(`Keyframe already exists for ${input.target} at ${input.toMs}ms.`);
  }

  const previousKeyframe = existingKeyframes[existingIndex];
  const keyframe: MotionKeyframe = { ...previousKeyframe, atMs: input.toMs };
  existingKeyframes.splice(existingIndex, 1, keyframe);
  existingKeyframes.sort((left, right) => left.atMs - right.atMs);

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: existingKeyframes
      }
    },
    changedPaths: [
      `/layers/${layer.id}/keyframes/${input.target}/${input.fromMs}`,
      `/layers/${layer.id}/keyframes/${input.target}/${input.toMs}`
    ],
    action: "moved",
    target: input.target,
    fromMs: input.fromMs,
    toMs: input.toMs,
    previousKeyframe,
    keyframe
  };
}

export function shiftLayerKeyframes(layer: MotionLayer, input: LayerKeyframeShift): LayerKeyframeShiftResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (typeof input.deltaMs !== "number" || !Number.isFinite(input.deltaMs) || input.deltaMs === 0) {
    throw new Error("deltaMs must be a finite non-zero number.");
  }
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe shift range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selected = existingKeyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => {
      if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
      if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
      return true;
    });

  if (selected.length === 0) {
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const shifted = selected.map(({ keyframe, index }) => {
    const toMs = keyframe.atMs + input.deltaMs;
    // Shift alone lacked the finite guard its four siblings (scale/duplicate/reverse/snap) carry.
    // Without it a keyframe whose stored `atMs` is missing or non-numeric produced `toMs: NaN`
    // — `NaN < 0` is false, and the collision check below never matches NaN — so `atMs: NaN` was
    // written into motion.json (serialising as `null`) and the command reported success.
    if (!Number.isFinite(toMs)) {
      throw new Error(`Keyframe shift would move ${input.target} at ${keyframe.atMs}ms to a non-finite timestamp.`);
    }
    if (toMs < 0) {
      throw new Error(`Keyframe shift would move ${input.target} at ${keyframe.atMs}ms before 0ms.`);
    }
    return { keyframe, index, toMs };
  });

  for (const { toMs } of shifted) {
    if (existingKeyframes.some((keyframe, index) => !selectedIndexes.has(index) && keyframe.atMs === toMs)) {
      throw new Error(`Keyframe shift would collide with ${input.target} at ${toMs}ms.`);
    }
  }

  const shiftedByIndex = new Map(shifted.map((entry) => [entry.index, entry]));
  const nextKeyframes = existingKeyframes.map((keyframe, index) => {
    const shiftedEntry = shiftedByIndex.get(index);
    return shiftedEntry ? { ...keyframe, atMs: shiftedEntry.toMs } : keyframe;
  });
  nextKeyframes.sort((left, right) => left.atMs - right.atMs);

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes
      }
    },
    changedPaths: shifted.flatMap(({ keyframe, toMs }) => [
      `/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}`,
      `/layers/${layer.id}/keyframes/${input.target}/${toMs}`
    ]),
    action: "shifted",
    target: input.target,
    deltaMs: input.deltaMs,
    ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
    ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
    shiftedKeyframes: shifted.map(({ keyframe, toMs }) => ({
      target: input.target,
      fromMs: keyframe.atMs,
      toMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    }))
  };
}

export function scaleLayerKeyframes(layer: MotionLayer, input: LayerKeyframeScale): LayerKeyframeScaleResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (typeof input.scale !== "number" || !Number.isFinite(input.scale) || input.scale <= 0 || input.scale === 1) {
    throw new Error("scale must be a positive finite number other than 1.");
  }
  if (!isNonNegativeFinite(input.originMs)) {
    throw new Error("originMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe scale range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selected = existingKeyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => {
      if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
      if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
      return true;
    });

  if (selected.length === 0) {
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const scaled = selected.map(({ keyframe, index }) => {
    const toMs = input.originMs + ((keyframe.atMs - input.originMs) * input.scale);
    if (!Number.isFinite(toMs)) {
      throw new Error(`Keyframe scale would move ${input.target} at ${keyframe.atMs}ms to a non-finite timestamp.`);
    }
    if (toMs < 0) {
      throw new Error(`Keyframe scale would move ${input.target} at ${keyframe.atMs}ms before 0ms.`);
    }
    return { keyframe, index, toMs };
  });

  for (const { toMs } of scaled) {
    if (existingKeyframes.some((keyframe, index) => !selectedIndexes.has(index) && keyframe.atMs === toMs)) {
      throw new Error(`Keyframe scale would collide with ${input.target} at ${toMs}ms.`);
    }
  }

  const changed = scaled.filter(({ keyframe, toMs }) => keyframe.atMs !== toMs);
  if (changed.length === 0) {
    throw new Error("Keyframe scale did not change any timestamps.");
  }

  const scaledByIndex = new Map(scaled.map((entry) => [entry.index, entry]));
  const nextKeyframes = existingKeyframes.map((keyframe, index) => {
    const scaledEntry = scaledByIndex.get(index);
    return scaledEntry ? { ...keyframe, atMs: scaledEntry.toMs } : keyframe;
  });
  nextKeyframes.sort((left, right) => left.atMs - right.atMs);

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes
      }
    },
    changedPaths: changed.flatMap(({ keyframe, toMs }) => [
      `/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}`,
      `/layers/${layer.id}/keyframes/${input.target}/${toMs}`
    ]),
    action: "scaled",
    target: input.target,
    scale: input.scale,
    originMs: input.originMs,
    ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
    ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
    scaledKeyframes: changed.map(({ keyframe, toMs }) => ({
      target: input.target,
      fromMs: keyframe.atMs,
      toMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    }))
  };
}

export function duplicateLayerKeyframes(layer: MotionLayer, input: LayerKeyframeDuplicate): LayerKeyframeDuplicateResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (typeof input.deltaMs !== "number" || !Number.isFinite(input.deltaMs) || input.deltaMs === 0) {
    throw new Error("deltaMs must be a finite non-zero number.");
  }
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe duplicate range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selected = existingKeyframes.filter((keyframe) => {
    if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
    if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
    return true;
  });

  if (selected.length === 0) {
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const duplicated = selected.map((keyframe) => {
    const toMs = keyframe.atMs + input.deltaMs;
    if (!Number.isFinite(toMs)) {
      throw new Error(`Keyframe duplicate would place ${input.target} copied from ${keyframe.atMs}ms at a non-finite timestamp.`);
    }
    if (toMs < 0) {
      throw new Error(`Keyframe duplicate would place ${input.target} copied from ${keyframe.atMs}ms before 0ms.`);
    }
    return { keyframe, toMs };
  });

  for (const { toMs } of duplicated) {
    if (existingKeyframes.some((keyframe) => keyframe.atMs === toMs)) {
      throw new Error(`Keyframe duplicate would collide with ${input.target} at ${toMs}ms.`);
    }
  }

  const duplicateTimes = new Set<number>();
  for (const { toMs } of duplicated) {
    if (duplicateTimes.has(toMs)) throw new Error(`Keyframe duplicate would collide with ${input.target} at ${toMs}ms.`);
    duplicateTimes.add(toMs);
  }

  const nextKeyframes = [
    ...existingKeyframes,
    ...duplicated.map(({ keyframe, toMs }) => ({ ...keyframe, atMs: toMs }))
  ];
  nextKeyframes.sort((left, right) => left.atMs - right.atMs);

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes
      }
    },
    changedPaths: duplicated.map(({ toMs }) => `/layers/${layer.id}/keyframes/${input.target}/${toMs}`),
    action: "duplicated",
    target: input.target,
    deltaMs: input.deltaMs,
    ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
    ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
    duplicatedKeyframes: duplicated.map(({ keyframe, toMs }) => ({
      target: input.target,
      fromMs: keyframe.atMs,
      toMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    }))
  };
}

export function distributeLayerKeyframes(layer: MotionLayer, input: LayerKeyframeDistribute): LayerKeyframeDistributeResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe distribute range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selected = existingKeyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => {
      if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
      if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
      return true;
    })
    .sort((left, right) => left.keyframe.atMs - right.keyframe.atMs);
  if (selected.length < 3) throw new Error(`At least three ${input.target} keyframes are required to distribute a range.`);

  const startMs = selected[0].keyframe.atMs;
  const endMs = selected.at(-1)!.keyframe.atMs;
  const spacingMs = (endMs - startMs) / (selected.length - 1);
  if (!Number.isFinite(spacingMs) || spacingMs <= 0) throw new Error("Keyframe distribute requires a positive selected time span.");
  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const distributed = selected.map(({ keyframe, index }, order) => ({
    keyframe,
    index,
    toMs: order === selected.length - 1 ? endMs : startMs + (spacingMs * order),
  }));
  for (const { toMs } of distributed) {
    if (existingKeyframes.some((keyframe, index) => !selectedIndexes.has(index) && keyframe.atMs === toMs)) {
      throw new Error(`Keyframe distribute would collide with ${input.target} at ${toMs}ms.`);
    }
  }
  const changed = distributed.filter(({ keyframe, toMs }) => keyframe.atMs !== toMs);
  if (changed.length === 0) throw new Error("Keyframes are already evenly distributed.");

  const distributedByIndex = new Map(distributed.map((entry) => [entry.index, entry]));
  const nextKeyframes = existingKeyframes.map((keyframe, index) => {
    const entry = distributedByIndex.get(index);
    return entry ? { ...keyframe, atMs: entry.toMs } : keyframe;
  }).sort((left, right) => left.atMs - right.atMs);
  const changedPaths = [...new Set(changed.flatMap(({ keyframe, toMs }) => [
    `/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}`,
    `/layers/${layer.id}/keyframes/${input.target}/${toMs}`,
  ]))];

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes,
      },
    },
    changedPaths,
    action: "distributed",
    target: input.target,
    startMs,
    endMs,
    spacingMs,
    distributedKeyframes: changed.map(({ keyframe, toMs }) => ({
      target: input.target,
      fromMs: keyframe.atMs,
      toMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {}),
    })),
  };
}

export function reverseLayerKeyframes(layer: MotionLayer, input: LayerKeyframeReverse): LayerKeyframeReverseResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe reverse range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selected = existingKeyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => {
      if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
      if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
      return true;
    });

  if (selected.length === 0) {
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const selectedTimes = selected.map(({ keyframe }) => keyframe.atMs);
  const startMs = input.startMs ?? Math.min(...selectedTimes);
  const endMs = input.endMs ?? Math.max(...selectedTimes);
  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const reversed = selected.map(({ keyframe, index }) => {
    const toMs = startMs + endMs - keyframe.atMs;
    if (!Number.isFinite(toMs)) {
      throw new Error(`Keyframe reverse would move ${input.target} at ${keyframe.atMs}ms to a non-finite timestamp.`);
    }
    if (toMs < 0) {
      throw new Error(`Keyframe reverse would move ${input.target} at ${keyframe.atMs}ms before 0ms.`);
    }
    return { keyframe, index, toMs };
  });

  for (const { toMs } of reversed) {
    if (existingKeyframes.some((keyframe, index) => !selectedIndexes.has(index) && keyframe.atMs === toMs)) {
      throw new Error(`Keyframe reverse would collide with ${input.target} at ${toMs}ms.`);
    }
  }

  const reversedTimes = new Set<number>();
  for (const { toMs } of reversed) {
    if (reversedTimes.has(toMs)) throw new Error(`Keyframe reverse would collide with ${input.target} at ${toMs}ms.`);
    reversedTimes.add(toMs);
  }

  const changed = reversed.filter(({ keyframe, toMs }) => keyframe.atMs !== toMs);
  if (changed.length === 0) {
    throw new Error("Keyframe reverse did not change any timestamps.");
  }

  const reversedByIndex = new Map(reversed.map((entry) => [entry.index, entry]));
  const nextKeyframes = existingKeyframes.map((keyframe, index) => {
    const reversedEntry = reversedByIndex.get(index);
    return reversedEntry ? { ...keyframe, atMs: reversedEntry.toMs } : keyframe;
  });
  nextKeyframes.sort((left, right) => left.atMs - right.atMs);

  const changedPaths: string[] = [];
  const addChangedPath = (path: string) => {
    if (!changedPaths.includes(path)) changedPaths.push(path);
  };
  for (const { keyframe, toMs } of changed) {
    addChangedPath(`/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}`);
    addChangedPath(`/layers/${layer.id}/keyframes/${input.target}/${toMs}`);
  }

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes
      }
    },
    changedPaths,
    action: "reversed",
    target: input.target,
    startMs,
    endMs,
    reversedKeyframes: changed.map(({ keyframe, toMs }) => ({
      target: input.target,
      fromMs: keyframe.atMs,
      toMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    }))
  };
}

export function snapLayerKeyframes(layer: MotionLayer, input: LayerKeyframeSnap): LayerKeyframeSnapResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (!Number.isFinite(input.fps) || input.fps <= 0) {
    throw new Error("fps must be a positive finite number.");
  }
  const mode = input.mode ?? "nearest";
  if (!SUPPORTED_KEYFRAME_SNAP_MODES.has(mode)) throw new Error(`Unsupported keyframe snap mode: ${mode}`);
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) {
    throw new Error("startMs must be a non-negative finite number.");
  }
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) {
    throw new Error("endMs must be a non-negative finite number.");
  }
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe snap range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selected = existingKeyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => {
      if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
      if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
      return true;
    });

  if (selected.length === 0) {
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const snapped = selected.map(({ keyframe, index }) => {
    const toMs = snapTimestampToFrameGrid(keyframe.atMs, input.fps, mode);
    if (!Number.isFinite(toMs)) {
      throw new Error(`Keyframe snap would move ${input.target} at ${keyframe.atMs}ms to a non-finite timestamp.`);
    }
    if (toMs < 0) {
      throw new Error(`Keyframe snap would move ${input.target} at ${keyframe.atMs}ms before 0ms.`);
    }
    return { keyframe, index, toMs };
  });

  for (const { toMs } of snapped) {
    if (existingKeyframes.some((keyframe, index) => !selectedIndexes.has(index) && keyframe.atMs === toMs)) {
      throw new Error(`Keyframe snap would collide with ${input.target} at ${toMs}ms.`);
    }
  }

  const snappedTimes = new Set<number>();
  for (const { toMs } of snapped) {
    if (snappedTimes.has(toMs)) throw new Error(`Keyframe snap would collide with ${input.target} at ${toMs}ms.`);
    snappedTimes.add(toMs);
  }

  const changed = snapped.filter(({ keyframe, toMs }) => keyframe.atMs !== toMs);
  if (changed.length === 0) {
    throw new Error("Keyframe snap did not change any timestamps.");
  }

  const snappedByIndex = new Map(snapped.map((entry) => [entry.index, entry]));
  const nextKeyframes = existingKeyframes.map((keyframe, index) => {
    const snappedEntry = snappedByIndex.get(index);
    return snappedEntry ? { ...keyframe, atMs: snappedEntry.toMs } : keyframe;
  });
  nextKeyframes.sort((left, right) => left.atMs - right.atMs);

  const changedPaths: string[] = [];
  const addChangedPath = (path: string) => {
    if (!changedPaths.includes(path)) changedPaths.push(path);
  };
  for (const { keyframe, toMs } of changed) {
    addChangedPath(`/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}`);
    addChangedPath(`/layers/${layer.id}/keyframes/${input.target}/${toMs}`);
  }

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes
      }
    },
    changedPaths,
    action: "snapped",
    target: input.target,
    fps: input.fps,
    mode,
    ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
    ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
    snappedKeyframes: changed.map(({ keyframe, toMs }) => ({
      target: input.target,
      fromMs: keyframe.atMs,
      toMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    }))
  };
}

export function applyLayerKeyframeEasing(layer: MotionLayer, input: LayerKeyframeEasingApply): LayerKeyframeEasingApplyResult {
  if (!isSupportedKeyframeTarget(input.target)) throw new Error(`Unsupported keyframe target: ${input.target}`);
  if (!isSupportedEasing(input.easing)) throw new Error(`Unsupported keyframe easing: ${input.easing}`);
  if (input.atMs !== undefined && !isNonNegativeFinite(input.atMs)) throw new Error("atMs must be a non-negative finite number.");
  if (input.startMs !== undefined && !isNonNegativeFinite(input.startMs)) throw new Error("startMs must be a non-negative finite number.");
  if (input.endMs !== undefined && !isNonNegativeFinite(input.endMs)) throw new Error("endMs must be a non-negative finite number.");
  if (input.startMs !== undefined && input.endMs !== undefined && input.startMs > input.endMs) {
    throw new Error("Keyframe easing range startMs must be less than or equal to endMs.");
  }
  assertLayerUnlocked(layer);

  const existingKeyframes = [...(layer.keyframes?.[input.target] ?? [])];
  const selectedIndexes = existingKeyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .filter(({ keyframe }) => {
      if (input.atMs !== undefined) return keyframe.atMs === input.atMs;
      if (input.startMs !== undefined && keyframe.atMs < input.startMs) return false;
      if (input.endMs !== undefined && keyframe.atMs > input.endMs) return false;
      return true;
    })
    .map(({ index }) => index);

  if (selectedIndexes.length === 0) {
    if (input.atMs !== undefined) throw new Error(`No keyframe found for ${input.target} at ${input.atMs}ms.`);
    throw new Error(`No keyframes found for ${input.target} in requested range.`);
  }

  const nextKeyframes = existingKeyframes.map((keyframe) => ({ ...keyframe }));
  const changedPaths: string[] = [];
  const updatedKeyframes: LayerKeyframeEasingApplyResult["updatedKeyframes"] = [];
  for (const index of selectedIndexes) {
    const keyframe = nextKeyframes[index];
    if (keyframe.easing === input.easing) continue;
    const oldEasing = keyframe.easing;
    keyframe.easing = input.easing;
    changedPaths.push(`/layers/${layer.id}/keyframes/${input.target}/${keyframe.atMs}/easing`);
    updatedKeyframes.push({
      atMs: keyframe.atMs,
      value: keyframe.value,
      ...(oldEasing ? { oldEasing } : {}),
      newEasing: input.easing
    });
  }
  if (updatedKeyframes.length === 0) throw new Error("Keyframe easing did not change.");

  return {
    layer: {
      ...layer,
      keyframes: {
        ...(layer.keyframes ?? {}),
        [input.target]: nextKeyframes
      }
    },
    changedPaths,
    action: "updated",
    target: input.target,
    easing: input.easing,
    updatedKeyframes
  };
}

export function listMotionEasingPresets(): MotionEasingPreset[] {
  return MOTION_EASING_PRESETS.map((preset) => ({ ...preset }));
}

export function listMotionAnimationPresets(): MotionAnimationPreset[] {
  return MOTION_ANIMATION_PRESETS.map((preset) => ({
    ...preset,
    targets: [...preset.targets]
  }));
}

export function readMotionAnimationPreset(value: unknown): MotionAnimationPresetId | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id) return null;
  return MOTION_ANIMATION_PRESETS.find((preset) => preset.id === id)?.id ?? null;
}

export function applyLayerAnimationPreset(layer: MotionLayer, input: LayerAnimationPresetApply): LayerAnimationPresetApplyResult {
  const preset = readMotionAnimationPreset(input.preset);
  if (!preset) throw new Error(`Unsupported animation preset: ${String(input.preset)}.`);
  const descriptor = MOTION_ANIMATION_PRESET_BY_ID.get(preset);
  if (!descriptor) throw new Error(`Unsupported animation preset: ${preset}.`);
  const durationMs = input.durationMs ?? Math.min(descriptor.defaultDurationMs, layer.durationMs);
  if (!isPositiveFinite(durationMs)) throw new Error("Animation preset durationMs must be a positive finite number.");
  const startMs = input.startMs ?? defaultAnimationPresetStartMs(layer, descriptor, durationMs);
  if (!isNonNegativeFinite(startMs)) throw new Error("Animation preset startMs must be a non-negative finite number.");
  const endMs = startMs + durationMs;
  if (!Number.isFinite(endMs)) throw new Error("Animation preset timing must be finite.");
  const layerEndMs = layer.startMs + layer.durationMs;
  if (startMs < layer.startMs || endMs > layerEndMs) {
    throw new Error("Animation preset timing must fit within the layer duration.");
  }
  const distancePx = input.distancePx ?? descriptor.defaultDistancePx ?? 0;
  if (!isNonNegativeFinite(distancePx)) throw new Error("Animation preset distancePx must be a non-negative finite number.");
  const easing = input.easing ?? descriptor.easing;
  if (!isSupportedEasing(easing)) throw new Error(`Unsupported animation preset easing: ${easing}.`);
  assertLayerUnlocked(layer);

  const baseOpacity = layerBaseOpacity(layer);
  const baseY = readNumber(layer.transform?.y, 0);
  const keyframes = animationPresetKeyframes({
    preset,
    startMs,
    endMs,
    distancePx,
    easing,
    baseOpacity,
    baseY
  });

  let nextLayer = layer;
  const changedPaths: string[] = [];
  const appliedKeyframes: LayerAnimationPresetApplyResult["appliedKeyframes"] = [];
  const replacedKeyframes: LayerAnimationPresetApplyResult["replacedKeyframes"] = [];
  for (const keyframe of keyframes) {
    // Read the old value BEFORE the upsert: after it, the layer holds the preset's value and the
    // author's is unrecoverable. `upsert.action` says whether one was there; it does not say what.
    const previous = nextLayer.keyframes?.[keyframe.target]?.find((entry) => entry.atMs === keyframe.atMs);
    const upsert = upsertLayerKeyframe(nextLayer, keyframe);
    nextLayer = upsert.layer;
    changedPaths.push(upsert.changedPath);
    appliedKeyframes.push({
      target: keyframe.target,
      atMs: keyframe.atMs,
      value: keyframe.value,
      ...(keyframe.easing ? { easing: keyframe.easing } : {})
    });
    if (upsert.action === "replaced" && previous) {
      replacedKeyframes.push({
        target: keyframe.target,
        atMs: keyframe.atMs,
        oldValue: previous.value,
        newValue: keyframe.value
      });
    }
  }

  return {
    layer: nextLayer,
    changedPaths,
    action: "applied",
    preset,
    timing: { startMs, endMs, durationMs },
    appliedKeyframes,
    replacedKeyframes
  };
}

export function applyLayerGroupAnimationPreset(layers: MotionLayer[], input: LayerGroupAnimationPresetApply): LayerGroupAnimationPresetApplyResult {
  const preset = readMotionAnimationPreset(input.preset);
  if (!preset) throw new Error(`Unsupported animation preset: ${String(input.preset)}.`);
  if (!Array.isArray(input.layerIds) || input.layerIds.length === 0) {
    throw new Error("Animation preset layerIds must include at least one layer id.");
  }
  const seenLayerIds = new Set<string>();
  for (const layerId of input.layerIds) {
    if (typeof layerId !== "string" || layerId.trim().length === 0) {
      throw new Error("Animation preset layerIds must be non-empty strings.");
    }
    if (seenLayerIds.has(layerId)) {
      throw new Error(`Animation preset layerIds contains a duplicate layer id: ${layerId}.`);
    }
    seenLayerIds.add(layerId);
  }
  const staggerMs = input.staggerMs ?? 0;
  if (!isNonNegativeFinite(staggerMs)) throw new Error("Animation preset staggerMs must be a non-negative finite number.");

  const nextLayers = [...layers];
  const changedPaths: string[] = [];
  const applications: LayerGroupAnimationPresetApplyResult["applications"] = [];
  for (const [order, layerId] of input.layerIds.entries()) {
    const layerIndex = nextLayers.findIndex((layer) => layer.id === layerId);
    if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);
    const layer = nextLayers[layerIndex];
    const startMs = input.startMs === undefined ? undefined : input.startMs + (order * staggerMs);
    const applied = applyLayerAnimationPreset(layer, {
      preset,
      ...(startMs !== undefined ? { startMs } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.distancePx !== undefined ? { distancePx: input.distancePx } : {}),
      ...(input.easing !== undefined ? { easing: input.easing } : {})
    });
    nextLayers[layerIndex] = applied.layer;
    changedPaths.push(...applied.changedPaths);
    applications.push({
      layerId,
      changedPaths: applied.changedPaths,
      timing: applied.timing,
      appliedKeyframes: applied.appliedKeyframes,
      replacedKeyframes: applied.replacedKeyframes
    });
  }

  return {
    layers: nextLayers,
    changedPaths,
    action: "applied",
    preset,
    staggerMs,
    applications
  };
}

export function trimLayerTiming(layer: MotionLayer, input: LayerTimingTrim): LayerTimingTrimResult {
  const hasStartMs = hasOwn(input, "startMs");
  const hasDurationMs = hasOwn(input, "durationMs");
  const hasTrimStartMs = hasOwn(input, "trimStartMs");
  const hasTrimDurationMs = hasOwn(input, "trimDurationMs");
  if (!hasStartMs && !hasDurationMs && !hasTrimStartMs && !hasTrimDurationMs) {
    throw new Error("Layer trim requires at least one timing field.");
  }
  if (hasStartMs && !isNonNegativeFinite(input.startMs)) throw new Error("startMs must be a non-negative finite number.");
  if (hasDurationMs && !isPositiveFinite(input.durationMs)) throw new Error("durationMs must be a positive finite number.");
  if (hasTrimStartMs && !isNonNegativeFinite(input.trimStartMs)) throw new Error("trimStartMs must be a non-negative finite number.");
  if (hasTrimDurationMs && !isPositiveFinite(input.trimDurationMs)) throw new Error("trimDurationMs must be a positive finite number.");
  assertLayerUnlocked(layer);

  const nextLayer: MotionLayer = { ...layer };
  const oldTiming = layerTimingSnapshot(layer);
  const changedPaths: string[] = [];

  if (hasStartMs) {
    const startMs = input.startMs;
    if (typeof startMs === "number" && startMs !== layer.startMs) {
      nextLayer.startMs = startMs;
      changedPaths.push(`/layers/${layer.id}/startMs`);
    }
  }
  if (hasDurationMs) {
    const durationMs = input.durationMs;
    if (typeof durationMs === "number" && durationMs !== layer.durationMs) {
      nextLayer.durationMs = durationMs;
      changedPaths.push(`/layers/${layer.id}/durationMs`);
    }
  }
  if (hasTrimStartMs) {
    const trimStartMs = input.trimStartMs;
    if (typeof trimStartMs === "number" && trimStartMs !== layer.trimStartMs) {
      nextLayer.trimStartMs = trimStartMs;
      changedPaths.push(`/layers/${layer.id}/trimStartMs`);
    }
  }
  if (hasTrimDurationMs) {
    const trimDurationMs = input.trimDurationMs;
    if (typeof trimDurationMs === "number" && trimDurationMs !== layer.trimDurationMs) {
      nextLayer.trimDurationMs = trimDurationMs;
      changedPaths.push(`/layers/${layer.id}/trimDurationMs`);
    }
  }
  if (changedPaths.length === 0) {
    throw new Error("Layer trim did not change any timing field.");
  }

  return {
    layer: nextLayer,
    changedPaths,
    action: "updated",
    oldTiming,
    newTiming: layerTimingSnapshot(nextLayer)
  };
}

export function splitLayerAtMs(motion: MotionDocument, input: LayerSplitAtMs): LayerSplitAtMsResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (!isNonNegativeFinite(input.atMs)) throw new Error("Layer split atMs must be a non-negative finite number.");

  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const layer = motion.layers[layerIndex];
  const layerEndMs = layer.startMs + layer.durationMs;
  if (input.atMs <= layer.startMs || input.atMs >= layerEndMs) {
    throw new Error("Layer split point must be inside the layer duration.");
  }

  const newLayerId = input.newLayerId?.trim() || uniqueSplitLayerId(motion, layer.id, input.atMs);
  if (!isNonEmptyString(newLayerId)) throw new Error("New layer id is required.");
  if (motion.layers.some((candidate) => candidate.id === newLayerId)) {
    throw new Error(`Motion layer id already exists: ${newLayerId}.`);
  }

  const tracks = motion.tracks ?? [];
  const sourceTrackIndexes = tracks
    .map((track, index) => (track.id === layer.trackId || track.layerIds?.includes(layer.id) ? index : -1))
    .filter((index) => index !== -1);
  for (const trackIndex of sourceTrackIndexes) {
    if (tracks[trackIndex].locked) throw new Error(`Source track is locked: ${tracks[trackIndex].id}.`);
  }
  assertLayerUnlocked(layer);
  // Before rewriting a single track. A split assigns each keyframe to a half by comparing `atMs`
  // against the split point, and a non-numeric `atMs` satisfies none of `<`, `>` or `===` — so an
  // unreadable keyframe silently lands in neither half, and the patched document then validates
  // clean because the command deleted the very errors validate exists to report. See
  // assertReadableLayerKeyframes for the measurement.
  assertReadableLayerKeyframes(layer, layerIndex, "Layer split");
  assertArrayKeyframeTracks(layer, layerIndex, "Layer split");

  const splitOffsetMs = input.atMs - layer.startMs;
  const tailDurationMs = layerEndMs - input.atMs;
  const oldTiming = layerTimingSnapshot(layer);
  const sourceOffsetMs = sourceOffsetForLayerSplit(layer, splitOffsetMs);
  const splitKeyframes = splitLayerKeyframes(layer.keyframes, input.atMs);
  const splitTransitions = splitLayerTransitions(layer);

  const originalLayer: MotionLayer = {
    ...layer,
    durationMs: splitOffsetMs,
    ...(splitKeyframes.original ? { keyframes: splitKeyframes.original } : {})
  };
  if (!splitKeyframes.original) delete originalLayer.keyframes;
  applyOriginalSourceTrim(originalLayer, layer, sourceOffsetMs);
  if (splitTransitions.original) {
    originalLayer.transitions = splitTransitions.original;
  } else {
    delete originalLayer.transitions;
  }

  const newLayer: MotionLayer = {
    ...layer,
    id: newLayerId,
    startMs: input.atMs,
    durationMs: tailDurationMs,
    ...(splitKeyframes.split ? { keyframes: splitKeyframes.split } : {})
  };
  if (!splitKeyframes.split) delete newLayer.keyframes;
  applySplitSourceTrim(newLayer, layer, sourceOffsetMs);
  if (splitTransitions.split) {
    newLayer.transitions = splitTransitions.split;
  } else {
    delete newLayer.transitions;
  }

  const nextLayers = [
    ...motion.layers.slice(0, layerIndex),
    originalLayer,
    newLayer,
    ...motion.layers.slice(layerIndex + 1)
  ];
  const changedPaths = [`/layers/${layer.id}/durationMs`];
  if (originalLayer.trimDurationMs !== layer.trimDurationMs) changedPaths.push(`/layers/${layer.id}/trimDurationMs`);
  changedPaths.push(`/layers/${newLayerId}`);

  const nextTracks = motion.tracks?.map((track, trackIndex) => {
    const layerIds = track.layerIds ? [...track.layerIds] : undefined;
    if (!layerIds) return track;
    const existingIndex = layerIds.indexOf(layer.id);
    if (existingIndex === -1) return { ...track, layerIds };
    layerIds.splice(existingIndex + 1, 0, newLayerId);
    changedPaths.push(`/tracks/${trackIndex}/layerIds`);
    return { ...track, layerIds };
  });

  return {
    motion: {
      ...motion,
      layers: nextLayers,
      ...(nextTracks ? { tracks: nextTracks } : {})
    },
    changedPaths,
    action: "split",
    layerId: layer.id,
    newLayerId,
    atMs: input.atMs,
    splitOffsetMs,
    sourceOffsetMs,
    originalLayer,
    newLayer,
    oldTiming,
    newTimings: {
      original: layerTimingSnapshot(originalLayer),
      split: layerTimingSnapshot(newLayer)
    }
  };
}

export function createTimelineLayer(motion: MotionDocument, input: TimelineLayerCreate): TimelineLayerCreateResult {
  const layer = cloneMotionLayer(input.layer);
  if (!isNonEmptyString(layer.id)) throw new Error("Layer id is required.");
  if (!isNonEmptyString(layer.type)) throw new Error("Layer type is required.");
  if (!isNonNegativeFinite(layer.startMs)) throw new Error("Layer startMs must be a non-negative finite number.");
  if (!isPositiveFinite(layer.durationMs)) throw new Error("Layer durationMs must be a positive finite number.");

  layer.id = layer.id.trim();
  layer.type = layer.type.trim();
  if (motion.layers.some((candidate) => candidate.id === layer.id)) {
    throw new Error(`Motion layer id already exists: ${layer.id}.`);
  }
  if ((motion.tracks ?? []).some((track) => track.layerIds?.includes(layer.id))) {
    throw new Error(`Motion track already references layer id: ${layer.id}.`);
  }

  const index = input.index ?? motion.layers.length;
  if (!Number.isInteger(index) || index < 0 || index > motion.layers.length) {
    throw new Error("Layer create index must be a non-negative integer within the layer stack.");
  }

  const requestedTrackId = input.trackId?.trim() || layer.trackId?.trim();
  let trackId: string | undefined;
  let trackIndex: number | undefined;
  const insertedTrackRefs: string[] = [];
  let nextTracks: MotionTrack[] | undefined;

  if (requestedTrackId) {
    const sourceTracks = motion.tracks ?? [];
    const targetTrackIndex = sourceTracks.findIndex((track) => track.id === requestedTrackId);
    if (targetTrackIndex === -1) throw new Error(`Motion track not found: ${requestedTrackId}.`);
    const targetTrack = sourceTracks[targetTrackIndex];
    const targetLayerIds = targetTrack.layerIds ? [...targetTrack.layerIds] : [];
    trackIndex = input.trackIndex ?? targetLayerIds.length;
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > targetLayerIds.length) {
      throw new Error("Layer track index must be a non-negative integer within the track layer refs.");
    }
    if (targetTrack.locked) throw new Error(`Cannot create layer on locked track: ${targetTrack.id}.`);

    trackId = targetTrack.id;
    layer.trackId = trackId;
    targetLayerIds.splice(trackIndex, 0, layer.id);
    insertedTrackRefs.push(trackId);
    nextTracks = sourceTracks.map((track, currentIndex) =>
      currentIndex === targetTrackIndex
        ? { ...track, layerIds: targetLayerIds }
        : track.layerIds ? { ...track, layerIds: [...track.layerIds] } : { ...track }
    );
  } else if (layer.trackId !== undefined) {
    delete layer.trackId;
  }

  const nextLayers = [
    ...motion.layers.slice(0, index),
    layer,
    ...motion.layers.slice(index)
  ];
  const changedPaths = [`/layers/${layer.id}`];
  if (trackId) changedPaths.push(`/tracks/${(motion.tracks ?? []).findIndex((track) => track.id === trackId)}/layerIds`);

  const nextMotion: MotionDocument = {
    ...motion,
    layers: nextLayers,
    ...(nextTracks ? { tracks: nextTracks } : {})
  };
  const nextDurationMs = Math.max(motion.durationMs, timelineDuration(nextMotion));
  if (nextDurationMs !== motion.durationMs) {
    nextMotion.durationMs = nextDurationMs;
    changedPaths.push("/durationMs");
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "created",
    layerId: layer.id,
    index,
    ...(trackId ? { trackId } : {}),
    ...(trackIndex !== undefined ? { trackIndex } : {}),
    layer,
    oldLayerCount: motion.layers.length,
    newLayerCount: nextLayers.length,
    insertedTrackRefs
  };
}

export function deleteTimelineLayer(motion: MotionDocument, input: TimelineLayerDelete): TimelineLayerDeleteResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const removed = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, removed, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot delete layer on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(removed, `Cannot delete locked layer: ${removed.id}.`);

  const changedPaths = [`/layers/${removed.id}`];
  const removedTrackRefs: string[] = [];
  const nextTracks = motion.tracks?.map((track, trackIndex) => {
    const layerIds = track.layerIds ? track.layerIds.filter((layerId) => layerId !== removed.id) : undefined;
    if (!track.layerIds || layerIds?.length === track.layerIds.length) {
      return track.layerIds ? { ...track, layerIds: [...track.layerIds] } : { ...track };
    }
    removedTrackRefs.push(track.id);
    changedPaths.push(`/tracks/${trackIndex}/layerIds`);
    return { ...track, layerIds };
  });
  const nextMotion: MotionDocument = {
    ...motion,
    layers: motion.layers.filter((layer) => layer.id !== removed.id),
    ...(nextTracks ? { tracks: nextTracks } : {})
  };
  const nextDurationMs = timelineDuration(nextMotion);
  if (nextDurationMs > 0 && nextDurationMs !== motion.durationMs) {
    nextMotion.durationMs = nextDurationMs;
    changedPaths.push("/durationMs");
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "deleted",
    layerId: removed.id,
    removed,
    remainingCount: nextMotion.layers.length,
    removedTrackRefs
  };
}

export function duplicateTimelineLayer(motion: MotionDocument, input: TimelineLayerDuplicate): TimelineLayerDuplicateResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  const offsetMs = input.offsetMs ?? 0;
  if (!isNonNegativeFinite(offsetMs)) throw new Error("Layer duplicate offsetMs must be a non-negative finite number.");

  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const sourceLayer = motion.layers[layerIndex];
  const newLayerId = input.newLayerId?.trim() || uniqueDuplicateLayerId(motion, sourceLayer.id);
  if (!isNonEmptyString(newLayerId)) throw new Error("New layer id is required.");
  if (motion.layers.some((layer) => layer.id === newLayerId)) {
    throw new Error(`Motion layer id already exists: ${newLayerId}.`);
  }

  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, sourceLayer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot duplicate layer on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(sourceLayer);

  const duplicatedLayer: MotionLayer = {
    ...cloneMotionLayer(sourceLayer),
    id: newLayerId,
    startMs: sourceLayer.startMs + offsetMs
  };
  const changedPaths = [`/layers/${newLayerId}`];
  const insertedTrackRefs: string[] = [];
  const nextTracks = motion.tracks?.map((track, trackIndex) => {
    const layerIds = track.layerIds ? [...track.layerIds] : undefined;
    if (!layerIds) return { ...track };
    const existingIndex = layerIds.indexOf(sourceLayer.id);
    if (existingIndex === -1) return { ...track, layerIds };
    layerIds.splice(existingIndex + 1, 0, newLayerId);
    insertedTrackRefs.push(track.id);
    changedPaths.push(`/tracks/${trackIndex}/layerIds`);
    return { ...track, layerIds };
  });

  const nextMotion: MotionDocument = {
    ...motion,
    layers: [
      ...motion.layers.slice(0, layerIndex + 1),
      duplicatedLayer,
      ...motion.layers.slice(layerIndex + 1)
    ],
    ...(nextTracks ? { tracks: nextTracks } : {})
  };
  const nextDurationMs = timelineDuration(nextMotion);
  if (nextDurationMs !== motion.durationMs) {
    nextMotion.durationMs = nextDurationMs;
    changedPaths.push("/durationMs");
  }

  return {
    motion: nextMotion,
    changedPaths,
    action: "duplicated",
    layerId: sourceLayer.id,
    newLayerId,
    offsetMs,
    sourceLayer,
    layer: duplicatedLayer,
    insertedTrackRefs
  };
}

export function reorderTimelineLayer(motion: MotionDocument, input: TimelineLayerReorder): TimelineLayerReorderResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const oldIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (oldIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= motion.layers.length) {
    throw new Error("Layer reorder index must be a non-negative integer within the layer stack.");
  }

  const layer = motion.layers[oldIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot reorder layer on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);
  if (oldIndex === input.index) throw new Error("Layer stack order did not change.");

  const nextLayers = [...motion.layers];
  const [movedLayer] = nextLayers.splice(oldIndex, 1);
  nextLayers.splice(input.index, 0, movedLayer);

  const layerOrder = new Map(nextLayers.map((candidate, index) => [candidate.id, index]));
  const changedPaths = ["/layers"];
  const reorderedTrackRefs: string[] = [];
  const nextTracks = motion.tracks?.map((track, trackIndex) => {
    if (!track.layerIds) return { ...track };
    const layerIds = [...track.layerIds];
    if (!layerIds.includes(layer.id)) return { ...track, layerIds };
    const orderedLayerIds = [...layerIds].sort((left, right) => {
      const leftOrder = layerOrder.get(left);
      const rightOrder = layerOrder.get(right);
      if (leftOrder === undefined && rightOrder === undefined) return 0;
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    });
    if (!stringArraysEqual(layerIds, orderedLayerIds)) {
      changedPaths.push(`/tracks/${trackIndex}/layerIds`);
      reorderedTrackRefs.push(track.id);
    }
    return { ...track, layerIds: orderedLayerIds };
  });

  return {
    motion: {
      ...motion,
      layers: nextLayers,
      ...(nextTracks ? { tracks: nextTracks } : {})
    },
    changedPaths,
    action: "reordered",
    layerId: layer.id,
    oldIndex,
    newIndex: input.index,
    layer,
    reorderedTrackRefs
  };
}

export function setTimelineLayerText(motion: MotionDocument, input: TimelineLayerTextSet): TimelineLayerTextSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (typeof input.text !== "string") throw new Error("Layer text must be a string.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  if (layer.type !== "text" && layer.type !== "caption") {
    throw new Error(`Layer type does not support text: ${layer.type}.`);
  }

  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer text on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldText = layer.text ?? null;
  const newText = input.text;
  if ((oldText ?? "") === newText) throw new Error("Layer text did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    text: newText
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/text`],
    action: "updated",
    layerId,
    oldText,
    newText,
    layer: nextLayer
  };
}

export function setTimelineLayerName(motion: MotionDocument, input: TimelineLayerNameSet): TimelineLayerNameSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  const newName = typeof input.name === "string" ? input.name.trim() : "";
  if (!newName) throw new Error("Layer name is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer name on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldName = layer.name ?? null;
  if ((oldName ?? "") === newName) throw new Error("Layer name did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    name: newName
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/name`],
    action: "renamed",
    layerId,
    oldName,
    newName,
    layer: nextLayer
  };
}

export function setTimelineLayerStyle(motion: MotionDocument, input: TimelineLayerStyleSet): TimelineLayerStyleSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const property = normalizeTimelineLayerStyleProperty(input.property);
  const newValue = validateTimelineLayerStyleValue(property, input.value);
  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer style on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldValue = readTimelineLayerStyleValue(layer.style, property);
  if (Object.is(oldValue, newValue)) throw new Error(`Layer style ${property} did not change.`);

  const nextStyle: Record<string, unknown> = structuredClone(layer.style ?? {});
  nextStyle[property] = newValue;
  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    style: nextStyle
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/style/${property}`],
    action: "updated",
    layerId,
    property,
    oldValue,
    newValue,
    layer: nextLayer
  };
}

export function setTimelineLayerTransform(motion: MotionDocument, input: TimelineLayerTransformSet): TimelineLayerTransformSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const property = normalizeTimelineLayerTransformProperty(input.property);
  const newValue = validateTimelineLayerTransformValue(property, input.value);
  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer transform on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldValue = readTimelineLayerTransformValue(layer, property);
  const nextLayer: MotionLayer = cloneMotionLayer(layer);
  const changedPaths: string[] = [];
  if (property === "opacity") {
    const hadRootOpacity = Object.prototype.hasOwnProperty.call(layer, "opacity");
    const rootOldValue = hadRootOpacity ? layer.opacity : null;
    const hadLegacyTransformOpacity = !!layer.transform && Object.prototype.hasOwnProperty.call(layer.transform, "opacity");
    if (!hadRootOpacity || !Object.is(rootOldValue, newValue)) changedPaths.push(`/layers/${layerId}/opacity`);
    if (hadLegacyTransformOpacity) changedPaths.push(`/layers/${layerId}/transform/opacity`);
    if (changedPaths.length === 0) throw new Error(`Layer transform ${property} did not change.`);
    nextLayer.opacity = newValue;
    if (hadLegacyTransformOpacity) {
      const nextTransform = structuredClone((layer.transform ?? {}) as unknown as Record<string, unknown>);
      delete nextTransform.opacity;
      if (Object.keys(nextTransform).length > 0) {
        nextLayer.transform = nextTransform as MotionLayer["transform"];
      } else {
        delete nextLayer.transform;
      }
    }
  } else {
    if (Object.is(oldValue, newValue)) throw new Error(`Layer transform ${property} did not change.`);
    const nextTransform: Record<string, unknown> = structuredClone((layer.transform ?? {}) as unknown as Record<string, unknown>);
    nextTransform[property] = newValue;
    nextLayer.transform = nextTransform as MotionLayer["transform"];
    changedPaths.push(`/layers/${layerId}/transform/${property}`);
  }
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths,
    action: "updated",
    layerId,
    property,
    oldValue,
    newValue,
    layer: nextLayer
  };
}

export function setTimelineLayerEffect(motion: MotionDocument, input: TimelineLayerEffectSet): TimelineLayerEffectSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const property = normalizeTimelineLayerEffectProperty(input.property);
  const newValue = validateTimelineLayerEffectValue(property, input.value);
  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer effect on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldValue = readTimelineLayerEffectValue(layer.effects, property);
  if (Object.is(oldValue, newValue)) throw new Error(`Layer effect ${property} did not change.`);

  const nextEffects: Record<string, unknown> = structuredClone((layer.effects ?? {}) as unknown as Record<string, unknown>);
  nextEffects[property] = newValue;
  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    effects: nextEffects as MotionLayer["effects"]
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/effects/${property}`],
    action: "updated",
    layerId,
    property,
    oldValue,
    newValue,
    layer: nextLayer
  };
}

export function setTimelineLayerBlendMode(motion: MotionDocument, input: TimelineLayerBlendModeSet): TimelineLayerBlendModeSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const newBlendMode = validateTimelineLayerBlendMode(input.blendMode);
  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer blend mode on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldBlendMode = layer.blendMode ?? null;
  if (Object.is(oldBlendMode, newBlendMode)) throw new Error("Layer blend mode did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    blendMode: newBlendMode
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/blendMode`],
    action: "updated",
    layerId,
    oldBlendMode,
    newBlendMode,
    layer: nextLayer
  };
}

export function setTimelineLayerCrop(motion: MotionDocument, input: TimelineLayerCropSet): TimelineLayerCropSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  if (layer.type !== "image" && layer.type !== "video") {
    throw new Error(`Layer type does not support crop: ${layer.type}.`);
  }
  const newCrop = validateTimelineLayerCrop(input.crop);
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer crop on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldCrop = layer.crop ? { ...layer.crop } : null;
  const fields = ["x", "y", "width", "height"] as const;
  const changedPaths = fields
    .filter((field) => !oldCrop || !Object.is(oldCrop[field], newCrop[field]))
    .map((field) => `/layers/${layerId}/crop/${field}`);
  if (changedPaths.length === 0) throw new Error("Layer crop did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    crop: newCrop
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths,
    action: "updated",
    layerId,
    oldCrop,
    newCrop,
    layer: nextLayer
  };
}

export function setTimelineLayerMask(motion: MotionDocument, input: TimelineLayerMaskSet): TimelineLayerMaskSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  if (layer.type === "audio") {
    throw new Error(`Layer type does not support mask: ${layer.type}.`);
  }
  const newMask = validateTimelineLayerMask(input.mask);
  if (newMask.type === "path" && (layer.transitions?.in?.type === "wipe" || layer.transitions?.out?.type === "wipe")) {
    throw new Error("Path masks cannot yet be combined with wipe transitions.");
  }
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer mask on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldMask = layer.mask ? structuredClone(layer.mask) : null;
  const changedPaths = timelineLayerMaskChangedPaths(layerId, oldMask, newMask);
  if (changedPaths.length === 0) throw new Error("Layer mask did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    mask: newMask
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths,
    action: "updated",
    layerId,
    oldMask,
    newMask,
    layer: nextLayer
  };
}

export function setTimelineLayerFit(motion: MotionDocument, input: TimelineLayerFitSet): TimelineLayerFitSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  if (layer.type !== "image" && layer.type !== "video") {
    throw new Error(`Layer type does not support fit: ${layer.type}.`);
  }
  const newFit = validateTimelineLayerFit(input.fit);
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer fit on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const style = layer.style && typeof layer.style === "object" && !Array.isArray(layer.style) ? layer.style : undefined;
  const hasObjectFitAlias = !!style && hasOwn(style, "objectFit");
  const hasFitAlias = !!style && hasOwn(style, "fit");
  const oldFit = readTimelineLayerFitValue(layer);
  const changedPaths: string[] = [];
  if (!Object.is(layer.fit, newFit)) changedPaths.push(`/layers/${layerId}/fit`);
  if (hasObjectFitAlias) changedPaths.push(`/layers/${layerId}/style/objectFit`);
  if (hasFitAlias) changedPaths.push(`/layers/${layerId}/style/fit`);
  if (changedPaths.length === 0) throw new Error("Layer fit did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    fit: newFit
  };
  if (hasObjectFitAlias || hasFitAlias) {
    const nextStyle = nextLayer.style && typeof nextLayer.style === "object" && !Array.isArray(nextLayer.style) ? { ...nextLayer.style } : {};
    delete nextStyle.objectFit;
    delete nextStyle.fit;
    if (Object.keys(nextStyle).length > 0) {
      nextLayer.style = nextStyle;
    } else {
      delete nextLayer.style;
    }
  }
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths,
    action: "updated",
    layerId,
    oldFit,
    newFit,
    layer: nextLayer
  };
}

export function setTimelineLayerMediaSource(motion: MotionDocument, input: TimelineLayerMediaSourceSet): TimelineLayerMediaSourceSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  if (!SUPPORTED_MEDIA_SOURCE_LAYER_TYPES.has(layer.type)) {
    throw new Error(`Layer type does not support media source: ${layer.type}.`);
  }
  const newSource = validateTimelineLayerMediaSource(input.source);
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer media source on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldSource = readTimelineLayerMediaSourceValue(layer);
  const hasAssetRef = hasOwn(layer, "assetRef");
  const hasSrc = hasOwn(layer, "src");
  const hasAssetId = hasOwn(layer, "assetId");
  const changedPaths: string[] = [];
  if (!Object.is(layer.source, newSource)) changedPaths.push(`/layers/${layerId}/source`);
  if (hasAssetRef) changedPaths.push(`/layers/${layerId}/assetRef`);
  if (hasSrc) changedPaths.push(`/layers/${layerId}/src`);
  if (hasAssetId) changedPaths.push(`/layers/${layerId}/assetId`);
  if (changedPaths.length === 0) throw new Error("Layer media source did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    source: newSource
  };
  delete nextLayer.assetRef;
  delete nextLayer.src;
  delete nextLayer.assetId;
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths,
    action: "updated",
    layerId,
    oldSource,
    newSource,
    layer: nextLayer
  };
}

export function setTimelineLayerVisibility(motion: MotionDocument, input: TimelineLayerVisibilitySet): TimelineLayerVisibilitySetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (typeof input.visible !== "boolean") throw new Error("Layer visibility must be a boolean.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer visibility on locked track: ${lockedTrackId}.`);
  assertLayerUnlocked(layer);

  const oldVisible = layer.visible ?? true;
  const newVisible = input.visible;
  if (Object.is(oldVisible, newVisible)) throw new Error("Layer visibility did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    visible: newVisible
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/visible`],
    action: newVisible ? "shown" : "hidden",
    layerId,
    oldVisible,
    newVisible,
    layer: nextLayer
  };
}

export function setTimelineLayerLock(motion: MotionDocument, input: TimelineLayerLockSet): TimelineLayerLockSetResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (typeof input.locked !== "boolean") throw new Error("Layer locked must be a boolean.");

  const layerId = input.layerId.trim();
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);

  const layer = motion.layers[layerIndex];
  const tracks = motion.tracks ?? [];
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id));
  const lockedTrackId = lockedTrackIdForLayer(tracks, layer, lockedTrackIds);
  if (lockedTrackId) throw new Error(`Cannot edit layer lock on locked track: ${lockedTrackId}.`);

  const oldLocked = layer.locked ?? false;
  const newLocked = input.locked;
  if (Object.is(oldLocked, newLocked)) throw new Error("Layer lock state did not change.");

  const nextLayer: MotionLayer = {
    ...cloneMotionLayer(layer),
    locked: newLocked
  };
  const nextLayers = motion.layers.map((candidate, index) => index === layerIndex ? nextLayer : cloneMotionLayer(candidate));

  return {
    motion: {
      ...motion,
      layers: nextLayers
    },
    changedPaths: [`/layers/${layerId}/locked`],
    action: newLocked ? "locked" : "unlocked",
    layerId,
    oldLocked,
    newLocked,
    layer: nextLayer
  };
}

export function upsertLayerTransition(layer: MotionLayer, input: LayerTransitionUpsert): LayerTransitionUpsertResult {
  if (input.edge !== "in" && input.edge !== "out") throw new Error("Transition edge must be in or out.");
  if (!isSupportedTransitionType(input.type)) throw new Error(`Unsupported transition type: ${input.type}`);
  if (!isPositiveFinite(input.durationMs)) throw new Error("Transition durationMs must be a positive finite number.");
  if (input.easing && !isSupportedEasing(input.easing)) throw new Error(`Unsupported transition easing: ${input.easing}`);
  if ((input.type === "slide" || input.type === "wipe") && input.direction && !SUPPORTED_TRANSITION_DIRECTIONS.has(input.direction)) {
    throw new Error(`Unsupported ${input.type} direction: ${input.direction}`);
  }
  if (input.type === "slide" && input.distance !== undefined && !isNonNegativeFinite(input.distance)) {
    throw new Error("Transition distance must be a non-negative finite number.");
  }
  if (input.type !== "slide" && input.distance !== undefined) {
    throw new Error("Transition distance is only supported for slide transitions.");
  }
  assertLayerUnlocked(layer);

  const transition: MotionTransition = {
    type: input.type,
    durationMs: input.durationMs,
    ...(input.easing ? { easing: input.easing } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
    ...(input.distance !== undefined ? { distance: input.distance } : {})
  };
  const previousTransition = layer.transitions?.[input.edge];
  const action = previousTransition ? "replaced" : "inserted";

  return {
    layer: {
      ...layer,
      transitions: {
        ...(layer.transitions ?? {}),
        [input.edge]: transition
      }
    },
    changedPath: `/layers/${layer.id}/transitions/${input.edge}`,
    action,
    transition,
    previousTransition
  };
}

export function deleteLayerTransition(layer: MotionLayer, input: LayerTransitionDelete): LayerTransitionDeleteResult {
  if (input.edge !== "in" && input.edge !== "out") throw new Error("Transition edge must be in or out.");
  assertLayerUnlocked(layer);

  const removed = layer.transitions?.[input.edge];
  if (!removed) throw new Error(`No transition found for ${input.edge} edge.`);

  const transitions = { ...(layer.transitions ?? {}) };
  delete transitions[input.edge];
  const remainingEdges = (["in", "out"] as const).filter((edge) => transitions[edge]);
  const nextTransitions = remainingEdges.length > 0 ? transitions : undefined;
  const layerWithoutTransitions = { ...layer };
  delete layerWithoutTransitions.transitions;

  return {
    layer: nextTransitions ? { ...layer, transitions: nextTransitions } : layerWithoutTransitions,
    changedPath: `/layers/${layer.id}/transitions/${input.edge}`,
    action: "deleted",
    removed,
    remainingEdges: [...remainingEdges]
  };
}

export function resolveEasing(easing: MotionEasing | undefined): (t: number) => number {
  // Spring objects and spring preset aliases both resolve to the closed-form
  // damped spring in `spring.ts`. This is the single evaluation site inherited
  // by both render lanes through `effectiveLayerAtMs` — no lane duplicates it.
  if (isSpringEasing(easing)) return resolveSpringEasing(easing);
  if (typeof easing === "string") {
    const springPreset = springPresetEasing(easing);
    if (springPreset) return resolveSpringEasing(springPreset);
    if (easing === "hold") return () => 0;
    if (easing === "step-start") return createStepsEasing(1, "start");
    if (easing === "step-end") return createStepsEasing(1, "end");
    if (easing === "ease-in") return (t) => t * t;
    if (easing === "ease-out") return (t) => 1 - (1 - t) * (1 - t);
    if (easing === "ease-in-out") {
      return (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    }
    if (easing === "back-out") return easeBackOut;
    if (easing === "bounce-out") return easeBounceOut;
    const cubicBezier = parseCubicBezierEasing(easing);
    if (cubicBezier) return createCubicBezierEasing(...cubicBezier);
    const steps = parseStepsEasing(easing);
    if (steps) return createStepsEasing(steps.steps, steps.position);
  }
  return (t) => t;
}

function easeBackOut(t: number): number {
  const clamped = clamp(t, 0, 1);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * ((clamped - 1) ** 3) + c1 * ((clamped - 1) ** 2);
}

function easeBounceOut(t: number): number {
  let clamped = clamp(t, 0, 1);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (clamped < 1 / d1) return n1 * clamped * clamped;
  if (clamped < 2 / d1) {
    clamped -= 1.5 / d1;
    return n1 * clamped * clamped + 0.75;
  }
  if (clamped < 2.5 / d1) {
    clamped -= 2.25 / d1;
    return n1 * clamped * clamped + 0.9375;
  }
  clamped -= 2.625 / d1;
  return n1 * clamped * clamped + 0.984375;
}

export function parseCubicBezierEasing(easing: string | undefined): [number, number, number, number] | null {
  if (!easing) return null;
  const match = CUBIC_BEZIER_PATTERN.exec(easing);
  if (!match) return null;
  const values = match.slice(1, 5).map((value) => Number(value));
  if (!values.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = values;
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
  return [x1, y1, x2, y2];
}

function parseStepsEasing(easing: string | undefined): { steps: number; position: "start" | "end" } | null {
  if (!easing) return null;
  const match = STEPS_PATTERN.exec(easing);
  if (!match) return null;
  const steps = Number(match[1]);
  if (!Number.isInteger(steps) || steps < 1) return null;
  const position = (match[2] ?? "end").toLowerCase();
  if (position === "start" || position === "jump-start") return { steps, position: "start" };
  return { steps, position: "end" };
}

function createStepsEasing(steps: number, position: "start" | "end"): (t: number) => number {
  return (t) => {
    const clamped = clamp(t, 0, 1);
    if (position === "start") return Math.min(1, (Math.floor(clamped * steps) + 1) / steps);
    if (clamped === 1) return 1;
    return Math.floor(clamped * steps) / steps;
  };
}

function createCubicBezierEasing(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return (t) => {
    const x = clamp(t, 0, 1);
    if (x === 0 || x === 1) return x;
    return sampleBezier(solveBezierX(x, x1, x2), y1, y2);
  };
}

function solveBezierX(x: number, x1: number, x2: number): number {
  let t = x;
  for (let index = 0; index < 8; index += 1) {
    const estimate = sampleBezier(t, x1, x2) - x;
    if (Math.abs(estimate) < 1e-7) return t;
    const derivative = sampleBezierDerivative(t, x1, x2);
    if (Math.abs(derivative) < 1e-7) break;
    t -= estimate / derivative;
    if (t < 0 || t > 1) break;
  }

  let lower = 0;
  let upper = 1;
  t = x;
  for (let index = 0; index < 24; index += 1) {
    const estimate = sampleBezier(t, x1, x2);
    if (Math.abs(estimate - x) < 1e-7) return t;
    if (estimate < x) {
      lower = t;
    } else {
      upper = t;
    }
    t = (lower + upper) / 2;
  }
  return t;
}

function sampleBezier(t: number, point1: number, point2: number): number {
  return ((1 - 3 * point2 + 3 * point1) * t + (3 * point2 - 6 * point1)) * t * t + (3 * point1) * t;
}

function sampleBezierDerivative(t: number, point1: number, point2: number): number {
  return (3 * (1 - 3 * point2 + 3 * point1) * t + 2 * (3 * point2 - 6 * point1)) * t + (3 * point1);
}

/**
 * Sorted-numeric-keyframe cache. `interpolateNumber` is called dozens of times per layer per frame (once
 * per animatable property) and a final render evaluates thousands of frames, so re-reading and re-sorting
 * the same immutable keyframe arrays on every call is pure waste.
 *
 * Keyed by the keyframe array's identity: motion documents are loaded once and their keyframe arrays are
 * not mutated in place, so the same array reference recurs across every frame's evaluation and the sorted,
 * numeric-validated result can be reused. This is the least invasive hoist point — both render lanes reach
 * `interpolateNumber` through core, so both share the cache without touching document load/validation.
 * A WeakMap keeps entries collectable with their documents (no leak). Correctness does not depend on cache
 * hits: the value is a pure function of the array's contents, so a fresh array (e.g. a re-materialised
 * procedural track) simply misses and is sorted once, exactly as before.
 *
 * A cached `null` means "not an all-numeric track"; a WeakMap miss (`undefined`) means "not yet computed".
 */
const sortedNumericKeyframeCache = new WeakMap<MotionKeyframe[], NumericMotionKeyframe[] | null>();

function sortedNumericKeyframes(keyframes: MotionKeyframe[]): NumericMotionKeyframe[] | null {
  const cached = sortedNumericKeyframeCache.get(keyframes);
  if (cached !== undefined) return cached;
  const numericKeyframes = readNumericKeyframes(keyframes);
  const sorted = numericKeyframes ? [...numericKeyframes].sort((a, b) => a.atMs - b.atMs) : null;
  sortedNumericKeyframeCache.set(keyframes, sorted);
  return sorted;
}

export function interpolateNumber(keyframes: MotionKeyframe[] | undefined, atMs: number): number | null {
  if (!keyframes || keyframes.length === 0) return null;
  // Sorted once per keyframe track and cached (see sortedNumericKeyframeCache); read-only here, so the
  // shared array is safe. Returns null for non-numeric tracks, matching the previous inline behaviour.
  const sorted = sortedNumericKeyframes(keyframes);
  if (!sorted) return null;
  if (atMs <= sorted[0].atMs) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (atMs >= last.atMs) return last.value;
  const exact = sorted.find((keyframe) => keyframe.atMs === atMs);
  if (exact) return exact.value;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (atMs < current.atMs || atMs > next.atMs) continue;
    const span = next.atMs - current.atMs;
    const rawT = span <= 0 ? 1 : (atMs - current.atMs) / span;
    const easedT = resolveEasing(current.easing)(clamp(rawT, 0, 1));
    return current.value + (next.value - current.value) * easedT;
  }

  return last.value;
}

export function interpolateColor(keyframes: MotionKeyframe[] | undefined, atMs: number): string | null {
  if (!keyframes || keyframes.length === 0) return null;
  // Colour tracks previously had no reader at all: an unreadable `atMs` made this comparator return
  // NaN, which leaves Array.sort's order unspecified, and the interpolation then ran over whatever
  // order fell out. Reading first makes an unreadable colour track refuse like a numeric one rather
  // than produce a plausible-looking wrong colour.
  const readable = readStringKeyframes(keyframes);
  if (!readable) return null;
  const sorted = [...readable].sort((a, b) => a.atMs - b.atMs);
  if (atMs <= sorted[0].atMs) return normalizeColorKeyframeValue(sorted[0].value);
  const last = sorted[sorted.length - 1];
  if (atMs >= last.atMs) return normalizeColorKeyframeValue(last.value);
  const exact = sorted.find((keyframe) => keyframe.atMs === atMs);
  if (exact) return normalizeColorKeyframeValue(exact.value);

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (atMs < current.atMs || atMs > next.atMs) continue;
    const currentColor = parseInterpolableColor(current.value);
    const nextColor = parseInterpolableColor(next.value);
    if (!currentColor || !nextColor) return normalizeColorKeyframeValue(current.value);
    const span = next.atMs - current.atMs;
    const rawT = span <= 0 ? 1 : (atMs - current.atMs) / span;
    const easedT = resolveEasing(current.easing)(clamp(rawT, 0, 1));
    return formatInterpolatedColor({
      r: interpolateChannel(currentColor.r, nextColor.r, easedT),
      g: interpolateChannel(currentColor.g, nextColor.g, easedT),
      b: interpolateChannel(currentColor.b, nextColor.b, easedT),
      a: interpolateChannel(currentColor.a, nextColor.a, easedT)
    });
  }

  return normalizeColorKeyframeValue(last.value);
}

export function interpolateString(keyframes: MotionKeyframe[] | undefined, atMs: number): string | null {
  if (!keyframes || keyframes.length === 0) return null;
  const stringKeyframes = readStringKeyframes(keyframes);
  if (!stringKeyframes) return null;
  const sorted = [...stringKeyframes].sort((a, b) => a.atMs - b.atMs);
  if (atMs <= sorted[0].atMs) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (atMs >= last.atMs) return last.value;
  const exact = sorted.find((keyframe) => keyframe.atMs === atMs);
  if (exact) return exact.value;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (atMs < current.atMs || atMs > next.atMs) continue;
    return current.value;
  }

  return last.value;
}

interface InterpolableColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function normalizeColorKeyframeValue(value: MotionKeyframeValue): string | null {
  const color = parseInterpolableColor(value);
  return color ? formatInterpolatedColor(color) : (typeof value === "string" && value.trim() ? value.trim() : null);
}

function parseInterpolableColor(value: MotionKeyframeValue): InterpolableColor | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const named = NAMED_COLOR_HEX[trimmed.toLowerCase()];
  if (named) return parseInterpolableColor(named);
  if (trimmed.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return {
      r: parseInt(trimmed[1] + trimmed[1], 16),
      g: parseInt(trimmed[2] + trimmed[2], 16),
      b: parseInt(trimmed[3] + trimmed[3], 16),
      a: 255
    };
  }
  if (/^#[0-9a-f]{4}$/i.test(trimmed)) {
    return {
      r: parseInt(trimmed[1] + trimmed[1], 16),
      g: parseInt(trimmed[2] + trimmed[2], 16),
      b: parseInt(trimmed[3] + trimmed[3], 16),
      a: parseInt(trimmed[4] + trimmed[4], 16)
    };
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return {
      r: parseInt(trimmed.slice(1, 3), 16),
      g: parseInt(trimmed.slice(3, 5), 16),
      b: parseInt(trimmed.slice(5, 7), 16),
      a: 255
    };
  }
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) {
    return {
      r: parseInt(trimmed.slice(1, 3), 16),
      g: parseInt(trimmed.slice(3, 5), 16),
      b: parseInt(trimmed.slice(5, 7), 16),
      a: parseInt(trimmed.slice(7, 9), 16)
    };
  }
  return parseRgbColor(trimmed);
}

function parseRgbColor(value: string): InterpolableColor | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const parts = match[1].replace(/\//g, " ").split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channels = parts.slice(0, 3).map(parseRgbChannel);
  if (channels.some((channel) => channel === null)) return null;
  const alpha = parts[3] === undefined ? 255 : parseAlphaChannel(parts[3]);
  if (alpha === null) return null;
  return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0, a: alpha };
}

function parseRgbChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? clamp(Math.round((percent / 100) * 255), 0, 255) : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(Math.round(parsed), 0, 255) : null;
}

function parseAlphaChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? clamp(Math.round((percent / 100) * 255), 0, 255) : null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.round((parsed <= 1 ? parsed * 255 : parsed)), 0, 255);
}

function interpolateChannel(left: number, right: number, t: number): number {
  return Math.round(left + ((right - left) * t));
}

function formatInterpolatedColor(color: InterpolableColor): string {
  const r = clamp(Math.round(color.r), 0, 255);
  const g = clamp(Math.round(color.g), 0, 255);
  const b = clamp(Math.round(color.b), 0, 255);
  const a = clamp(Math.round(color.a), 0, 255);
  if (a === 255) return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(4))})`;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

const NAMED_COLOR_HEX: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  navy: "#000080",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  purple: "#800080",
  olive: "#808000",
  lime: "#00ff00",
  teal: "#008080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  brown: "#a52a2a"
};

export function effectiveLayerAtMs(layer: MotionLayer, atMs: number): MotionLayer {
  const keyframes = layer.keyframes ?? {};
  const transform = { ...(layer.transform ?? {}) };
  const style = { ...(layer.style ?? {}) };
  const spatialPosition = interpolateSpatialPosition(layer, atMs, (easing, t) => resolveEasing(easing)(t));
  const x = spatialPosition?.x ?? interpolateNumber(keyframes["transform.x"], atMs);
  const y = spatialPosition?.y ?? interpolateNumber(keyframes["transform.y"], atMs);
  const width = interpolateNumber(keyframes["transform.width"], atMs);
  const height = interpolateNumber(keyframes["transform.height"], atMs);
  const originX = interpolateNumber(keyframes["transform.originX"], atMs);
  const originY = interpolateNumber(keyframes["transform.originY"], atMs);
  const scale = interpolateNumber(keyframes["transform.scale"], atMs);
  const rotation = interpolateNumber(keyframes["transform.rotation"], atMs);
  const opacity = interpolateNumber(keyframes.opacity, atMs);
  const volume = interpolateNumber(keyframes.volume, atMs);
  const pan = interpolateNumber(keyframes.pan, atMs);
  const blendMode = interpolateString(keyframes.blendMode, atMs);
  const playbackRate = interpolateNumber(keyframes.playbackRate, atMs);
  const fill = interpolateColor(keyframes.fill, atMs);
  const styleFill = interpolateColor(keyframes["style.fill"], atMs);
  const styleColor = interpolateColor(keyframes["style.color"], atMs);
  const styleStroke = interpolateColor(keyframes["style.stroke"], atMs);
  const styleBorderColor = interpolateColor(keyframes["style.borderColor"], atMs);
  const styleBackgroundColor = interpolateColor(keyframes["style.backgroundColor"], atMs);
  const styleBackground = interpolateColor(keyframes["style.background"], atMs);
  const styleStrokeWidth = interpolateNumber(keyframes["style.strokeWidth"], atMs);
  const styleBorderWidth = interpolateNumber(keyframes["style.borderWidth"], atMs);
  const styleFontSize = interpolateNumber(keyframes["style.fontSize"], atMs);
  const styleFontWeight = interpolateNumber(keyframes["style.fontWeight"], atMs);
  const styleLetterSpacing = interpolateNumber(keyframes["style.letterSpacing"], atMs);
  const styleTextAlign = interpolateString(keyframes["style.textAlign"], atMs);
  const styleVerticalAlign = interpolateString(keyframes["style.verticalAlign"], atMs);
  const styleAlignY = interpolateString(keyframes["style.alignY"], atMs);
  const styleLineHeight = interpolateNumber(keyframes["style.lineHeight"], atMs);
  const styleWidth = interpolateNumber(keyframes["style.width"], atMs);
  const styleHeight = interpolateNumber(keyframes["style.height"], atMs);
  const styleRadius = interpolateNumber(keyframes["style.radius"], atMs);
  const styleBorderRadius = interpolateNumber(keyframes["style.borderRadius"], atMs);
  const stylePadding = interpolateNumber(keyframes["style.padding"], atMs);
  const stylePaddingX = interpolateNumber(keyframes["style.paddingX"], atMs);
  const stylePaddingY = interpolateNumber(keyframes["style.paddingY"], atMs);
  const stylePaddingTop = interpolateNumber(keyframes["style.paddingTop"], atMs);
  const stylePaddingRight = interpolateNumber(keyframes["style.paddingRight"], atMs);
  const stylePaddingBottom = interpolateNumber(keyframes["style.paddingBottom"], atMs);
  const stylePaddingLeft = interpolateNumber(keyframes["style.paddingLeft"], atMs);
  const maskInsetTop = interpolateNumber(keyframes["mask.inset.top"], atMs);
  const maskInsetRight = interpolateNumber(keyframes["mask.inset.right"], atMs);
  const maskInsetBottom = interpolateNumber(keyframes["mask.inset.bottom"], atMs);
  const maskInsetLeft = interpolateNumber(keyframes["mask.inset.left"], atMs);
  const cropX = interpolateNumber(keyframes["crop.x"], atMs);
  const cropY = interpolateNumber(keyframes["crop.y"], atMs);
  const cropWidth = interpolateNumber(keyframes["crop.width"], atMs);
  const cropHeight = interpolateNumber(keyframes["crop.height"], atMs);
  const styleShadowX = interpolateNumber(keyframes["style.shadow.x"], atMs);
  const styleShadowY = interpolateNumber(keyframes["style.shadow.y"], atMs);
  const styleShadowOffsetX = interpolateNumber(keyframes["style.shadow.offsetX"], atMs);
  const styleShadowOffsetY = interpolateNumber(keyframes["style.shadow.offsetY"], atMs);
  const styleShadowBlur = interpolateNumber(keyframes["style.shadow.blur"], atMs);
  const styleShadowSpread = interpolateNumber(keyframes["style.shadow.spread"], atMs);
  const styleShadowBlurRadius = interpolateNumber(keyframes["style.shadow.blurRadius"], atMs);
  const styleShadowSpreadRadius = interpolateNumber(keyframes["style.shadow.spreadRadius"], atMs);
  const styleShadowColor = interpolateColor(keyframes["style.shadow.color"], atMs);
  const styleTextShadowX = interpolateNumber(keyframes["style.textShadow.x"], atMs);
  const styleTextShadowY = interpolateNumber(keyframes["style.textShadow.y"], atMs);
  const styleTextShadowOffsetX = interpolateNumber(keyframes["style.textShadow.offsetX"], atMs);
  const styleTextShadowOffsetY = interpolateNumber(keyframes["style.textShadow.offsetY"], atMs);
  const styleTextShadowBlur = interpolateNumber(keyframes["style.textShadow.blur"], atMs);
  const styleTextShadowBlurRadius = interpolateNumber(keyframes["style.textShadow.blurRadius"], atMs);
  const styleTextShadowColor = interpolateColor(keyframes["style.textShadow.color"], atMs);
  const effectBlur = interpolateNumber(keyframes["effects.blur"], atMs);
  const effectBrightness = interpolateNumber(keyframes["effects.brightness"], atMs);
  const effectContrast = interpolateNumber(keyframes["effects.contrast"], atMs);
  const effectSaturate = interpolateNumber(keyframes["effects.saturate"], atMs);
  const effectGrayscale = interpolateNumber(keyframes["effects.grayscale"], atMs);
  const effectGlowRadius = interpolateNumber(keyframes["effects.glow.radius"], atMs);
  const effectGlowColor = interpolateColor(keyframes["effects.glow.color"], atMs);
  const gradientAngle = interpolateNumber(keyframes["gradient.angle"], atMs);
  const transitionOpacity = transitionOpacityMultiplier(layer, atMs);
  const transformOpacity = typeof transform.opacity === "number" ? transform.opacity : undefined;
  const baseOpacity = opacity ?? (typeof layer.opacity === "number" ? layer.opacity : transformOpacity ?? 1);
  const effectiveOpacity = baseOpacity * transitionOpacity;
  const slideOffset = transitionSlideOffset(layer, atMs);
  const effects = { ...(layer.effects ?? {}) };
  const glow = layer.effects?.glow ? { ...layer.effects.glow } : undefined;
  const gradient = layer.gradient ? { ...layer.gradient, stops: layer.gradient.stops.map((stop) => ({ ...stop })) } : undefined;
  const shader = layer.shader ? { ...layer.shader, uniforms: { ...(layer.shader.uniforms ?? {}) } } : undefined;
  if (shader?.uniforms) {
    for (const [target, frames] of Object.entries(keyframes)) {
      if (!target.startsWith("shader.uniforms.")) continue;
      const uniformName = target.slice("shader.uniforms.".length);
      const value = interpolateNumber(frames, atMs);
      if (value !== null && uniformName in shader.uniforms) shader.uniforms[uniformName] = value;
    }
  }
  const environment = layer.environment
    ? layer.environment.kind === "rain"
      ? { ...layer.environment, ground: { ...layer.environment.ground }, atmosphere: { ...layer.environment.atmosphere } }
      : layer.environment.kind === "water"
        ? { ...layer.environment, surface: { ...layer.environment.surface }, optics: { ...layer.environment.optics } }
        : layer.environment.kind === "snow"
          ? { ...layer.environment, fall: { ...layer.environment.fall }, ground: { ...layer.environment.ground }, atmosphere: { ...layer.environment.atmosphere } }
          : { ...layer.environment, fog: { ...layer.environment.fog } }
    : undefined;
  if (environment) {
    for (const [target, frames] of Object.entries(keyframes)) {
      if (!target.startsWith("environment.")) continue;
      const value = interpolateNumber(frames, atMs);
      if (value === null) continue;
      if (environment.kind === "rain") {
        if (target === "environment.intensity") environment.intensity = value;
        else if (target === "environment.wind") environment.wind = value;
        else if (target === "environment.dropSpeed") environment.dropSpeed = value;
        else if (target === "environment.dropLength") environment.dropLength = value;
        else if (target === "environment.ground.horizon") environment.ground.horizon = value;
        else if (target === "environment.ground.wetness") environment.ground.wetness = value;
        else if (target === "environment.ground.roughness") environment.ground.roughness = value;
        else if (target === "environment.ground.rippleAmount") environment.ground.rippleAmount = value;
        else if (target === "environment.ground.splashAmount") environment.ground.splashAmount = value;
        else if (target === "environment.ground.reflectionStrength") environment.ground.reflectionStrength = value;
        else if (target === "environment.atmosphere.mist") environment.atmosphere.mist = value;
        else if (target === "environment.atmosphere.lensDroplets") environment.atmosphere.lensDroplets = value;
      } else if (environment.kind === "water") {
        if (target === "environment.surface.horizon") environment.surface.horizon = value;
        else if (target === "environment.surface.waveScale") environment.surface.waveScale = value;
        else if (target === "environment.surface.waveHeight") environment.surface.waveHeight = value;
        else if (target === "environment.surface.waveSpeed") environment.surface.waveSpeed = value;
        else if (target === "environment.surface.direction") environment.surface.direction = value;
        else if (target === "environment.surface.choppiness") environment.surface.choppiness = value;
        else if (target === "environment.optics.reflectionStrength") environment.optics.reflectionStrength = value;
        else if (target === "environment.optics.refractionStrength") environment.optics.refractionStrength = value;
        else if (target === "environment.optics.fresnel") environment.optics.fresnel = value;
        else if (target === "environment.optics.caustics") environment.optics.caustics = value;
        else if (target === "environment.optics.clarity") environment.optics.clarity = value;
        else if (target === "environment.optics.foam") environment.optics.foam = value;
      } else if (environment.kind === "snow") {
        if (target === "environment.fall.intensity") environment.fall.intensity = value;
        else if (target === "environment.fall.speed") environment.fall.speed = value;
        else if (target === "environment.fall.wind") environment.fall.wind = value;
        else if (target === "environment.fall.turbulence") environment.fall.turbulence = value;
        else if (target === "environment.fall.flakeSize") environment.fall.flakeSize = value;
        else if (target === "environment.fall.focusFalloff") environment.fall.focusFalloff = value;
        else if (target === "environment.ground.horizon") environment.ground.horizon = value;
        else if (target === "environment.ground.accumulation") environment.ground.accumulation = value;
        else if (target === "environment.ground.drift") environment.ground.drift = value;
        else if (target === "environment.ground.contactAmount") environment.ground.contactAmount = value;
        else if (target === "environment.atmosphere.haze") environment.atmosphere.haze = value;
        else if (target === "environment.atmosphere.depthFade") environment.atmosphere.depthFade = value;
      } else {
        if (target === "environment.fog.density") environment.fog.density = value;
        else if (target === "environment.fog.speed") environment.fog.speed = value;
        else if (target === "environment.fog.scale") environment.fog.scale = value;
        else if (target === "environment.fog.turbulence") environment.fog.turbulence = value;
        else if (target === "environment.fog.height") environment.fog.height = value;
        else if (target === "environment.fog.lightStrength") environment.fog.lightStrength = value;
      }
    }
  }

  if (x !== null) transform.x = x;
  if (y !== null) transform.y = y;
  if (width !== null) transform.width = width;
  if (height !== null) transform.height = height;
  if (originX !== null) transform.originX = originX;
  if (originY !== null) transform.originY = originY;
  if (slideOffset.x !== 0) transform.x = readNumber(transform.x, 0) + slideOffset.x;
  if (slideOffset.y !== 0) transform.y = readNumber(transform.y, 0) + slideOffset.y;
  if (scale !== null) transform.scale = scale;
  if (rotation !== null) transform.rotation = rotation;
  if (opacity !== null || layer.opacity !== undefined || transformOpacity !== undefined || transitionOpacity !== 1) {
    transform.opacity = effectiveOpacity;
  }
  if (styleFill !== null) style.fill = styleFill;
  if (styleColor !== null) style.color = styleColor;
  if (styleStroke !== null) style.stroke = styleStroke;
  if (styleBorderColor !== null) style.borderColor = styleBorderColor;
  if (styleBackgroundColor !== null) style.backgroundColor = styleBackgroundColor;
  if (styleBackground !== null) style.background = styleBackground;
  if (styleStrokeWidth !== null) style.strokeWidth = styleStrokeWidth;
  if (styleBorderWidth !== null) style.borderWidth = styleBorderWidth;
  if (styleFontSize !== null) style.fontSize = styleFontSize;
  if (styleFontWeight !== null) style.fontWeight = styleFontWeight;
  if (styleLetterSpacing !== null) style.letterSpacing = styleLetterSpacing;
  if (styleTextAlign !== null) style.textAlign = styleTextAlign;
  if (styleVerticalAlign !== null) style.verticalAlign = styleVerticalAlign;
  if (styleAlignY !== null) style.alignY = styleAlignY;
  if (styleLineHeight !== null) style.lineHeight = styleLineHeight;
  if (styleWidth !== null) style.width = styleWidth;
  if (styleHeight !== null) style.height = styleHeight;
  if (styleRadius !== null) style.radius = styleRadius;
  if (styleBorderRadius !== null) style.borderRadius = styleBorderRadius;
  if (stylePadding !== null) style.padding = stylePadding;
  if (stylePaddingX !== null) style.paddingX = stylePaddingX;
  if (stylePaddingY !== null) style.paddingY = stylePaddingY;
  if (stylePaddingTop !== null) style.paddingTop = stylePaddingTop;
  if (stylePaddingRight !== null) style.paddingRight = stylePaddingRight;
  if (stylePaddingBottom !== null) style.paddingBottom = stylePaddingBottom;
  if (stylePaddingLeft !== null) style.paddingLeft = stylePaddingLeft;
  const maskInsetChanged = maskInsetTop !== null || maskInsetRight !== null || maskInsetBottom !== null || maskInsetLeft !== null;
  const mask = maskInsetChanged && layer.mask !== undefined
    ? {
        ...layer.mask,
        inset: { ...(layer.mask?.inset ?? {}) }
      }
    : undefined;
  if (mask && maskInsetChanged) {
    if (maskInsetTop !== null) mask.inset.top = maskInsetTop;
    if (maskInsetRight !== null) mask.inset.right = maskInsetRight;
    if (maskInsetBottom !== null) mask.inset.bottom = maskInsetBottom;
    if (maskInsetLeft !== null) mask.inset.left = maskInsetLeft;
  }
  const cropChanged = cropX !== null || cropY !== null || cropWidth !== null || cropHeight !== null;
  const crop = cropChanged && layer.crop !== undefined
    ? { ...layer.crop }
    : undefined;
  if (crop && cropChanged) {
    if (cropX !== null) crop.x = cropX;
    if (cropY !== null) crop.y = cropY;
    if (cropWidth !== null) crop.width = cropWidth;
    if (cropHeight !== null) crop.height = cropHeight;
  }
  const shadowChanged = styleShadowX !== null || styleShadowY !== null || styleShadowOffsetX !== null || styleShadowOffsetY !== null || styleShadowBlur !== null || styleShadowSpread !== null || styleShadowBlurRadius !== null || styleShadowSpreadRadius !== null || styleShadowColor !== null;
  if (shadowChanged) {
    const shadow = readObject(style.shadow);
    if (styleShadowX !== null) shadow.x = styleShadowX;
    if (styleShadowY !== null) shadow.y = styleShadowY;
    if (styleShadowOffsetX !== null) shadow.offsetX = styleShadowOffsetX;
    if (styleShadowOffsetY !== null) shadow.offsetY = styleShadowOffsetY;
    if (styleShadowBlur !== null) shadow.blur = styleShadowBlur;
    if (styleShadowSpread !== null) shadow.spread = styleShadowSpread;
    if (styleShadowBlurRadius !== null) shadow.blurRadius = styleShadowBlurRadius;
    if (styleShadowSpreadRadius !== null) shadow.spreadRadius = styleShadowSpreadRadius;
    if (styleShadowColor !== null) shadow.color = styleShadowColor;
    style.shadow = shadow;
  }
  const textShadowChanged = styleTextShadowX !== null || styleTextShadowY !== null || styleTextShadowOffsetX !== null || styleTextShadowOffsetY !== null || styleTextShadowBlur !== null || styleTextShadowBlurRadius !== null || styleTextShadowColor !== null;
  if (textShadowChanged) {
    const textShadow = readObject(style.textShadow);
    if (styleTextShadowX !== null) textShadow.x = styleTextShadowX;
    if (styleTextShadowY !== null) textShadow.y = styleTextShadowY;
    if (styleTextShadowOffsetX !== null) textShadow.offsetX = styleTextShadowOffsetX;
    if (styleTextShadowOffsetY !== null) textShadow.offsetY = styleTextShadowOffsetY;
    if (styleTextShadowBlur !== null) textShadow.blur = styleTextShadowBlur;
    if (styleTextShadowBlurRadius !== null) textShadow.blurRadius = styleTextShadowBlurRadius;
    if (styleTextShadowColor !== null) textShadow.color = styleTextShadowColor;
    style.textShadow = textShadow;
  }
  if (effectBlur !== null) effects.blur = effectBlur;
  if (effectBrightness !== null) effects.brightness = effectBrightness;
  if (effectContrast !== null) effects.contrast = effectContrast;
  if (effectSaturate !== null) effects.saturate = effectSaturate;
  if (effectGrayscale !== null) effects.grayscale = effectGrayscale;
  if (glow && effectGlowRadius !== null) glow.radius = effectGlowRadius;
  if (glow && effectGlowColor !== null) glow.color = effectGlowColor;
  if (glow) effects.glow = glow;
  if (gradient && gradientAngle !== null) gradient.angle = gradientAngle;

  return {
    ...layer,
    transform,
    ...(opacity !== null || layer.opacity !== undefined || transformOpacity !== undefined || transitionOpacity !== 1 ? { opacity: effectiveOpacity } : {}),
    ...(volume !== null ? { volume } : {}),
    ...(pan !== null ? { pan } : {}),
    ...(blendMode !== null ? { blendMode: blendMode as MotionLayer["blendMode"] } : {}),
    ...(playbackRate !== null ? { playbackRate } : {}),
    ...(fill !== null ? { fill } : {}),
    ...(layer.style !== undefined || styleFill !== null || styleColor !== null || styleStroke !== null || styleBorderColor !== null || styleBackgroundColor !== null || styleBackground !== null || styleStrokeWidth !== null || styleBorderWidth !== null || styleFontSize !== null || styleFontWeight !== null || styleLetterSpacing !== null || styleTextAlign !== null || styleVerticalAlign !== null || styleAlignY !== null || styleLineHeight !== null || styleWidth !== null || styleHeight !== null || styleRadius !== null || styleBorderRadius !== null || stylePadding !== null || stylePaddingX !== null || stylePaddingY !== null || stylePaddingTop !== null || stylePaddingRight !== null || stylePaddingBottom !== null || stylePaddingLeft !== null || shadowChanged || textShadowChanged ? { style } : {}),
    ...(mask ? { mask } : {}),
    ...(crop ? { crop } : {}),
    ...(gradient ? { gradient } : {}),
    ...(shader ? { shader } : {}),
    ...(environment ? { environment } : {}),
    ...((layer.effects !== undefined || effectBlur !== null || effectBrightness !== null || effectContrast !== null || effectSaturate !== null || effectGrayscale !== null || effectGlowRadius !== null || effectGlowColor !== null) ? { effects } : {})
  };
}

export function transitionOpacityMultiplier(layer: MotionLayer, atMs: number): number {
  const localMs = atMs - layer.startMs;
  const layerDurationMs = Math.max(0, layer.durationMs);
  const fadeIn = fadeTransitionMultiplier(layer.transitions?.in, localMs, "in");
  const fadeOut = fadeTransitionMultiplier(layer.transitions?.out, layerDurationMs - localMs, "out");
  return clamp(fadeIn * fadeOut, 0, 1);
}

function fadeTransitionMultiplier(transition: MotionTransition | undefined, elapsedMs: number, edge: "in" | "out"): number {
  if (!transition || transition.type !== "fade" || transition.durationMs <= 0) return 1;
  if (elapsedMs >= transition.durationMs) return 1;
  if (elapsedMs <= 0) return 0;
  const progress = clamp(elapsedMs / transition.durationMs, 0, 1);
  if (edge === "out") {
    return 1 - resolveEasing(transition.easing)(1 - progress);
  }
  return resolveEasing(transition.easing)(progress);
}

function transitionSlideOffset(layer: MotionLayer, atMs: number): { x: number; y: number } {
  const localMs = atMs - layer.startMs;
  const layerDurationMs = Math.max(0, layer.durationMs);
  const inOffset = slideTransitionOffset(layer.transitions?.in, localMs, "in");
  const outOffset = slideTransitionOffset(layer.transitions?.out, layerDurationMs - localMs, "out");
  return {
    x: inOffset.x + outOffset.x,
    y: inOffset.y + outOffset.y
  };
}

function slideTransitionOffset(transition: MotionTransition | undefined, elapsedMs: number, edge: "in" | "out"): { x: number; y: number } {
  if (!transition || transition.type !== "slide" || transition.durationMs <= 0) return { x: 0, y: 0 };
  const distance = typeof transition.distance === "number" ? transition.distance : 100;
  const progress = edge === "in"
    ? slideInProgress(transition, elapsedMs)
    : slideOutProgress(transition, elapsedMs);
  const amount = distance * progress;
  const direction = transition.direction ?? "left";
  if (direction === "right") return { x: amount, y: 0 };
  if (direction === "up") return { x: 0, y: -amount };
  if (direction === "down") return { x: 0, y: amount };
  return { x: -amount, y: 0 };
}

function slideInProgress(transition: MotionTransition, elapsedMs: number): number {
  if (elapsedMs >= transition.durationMs) return 0;
  if (elapsedMs <= 0) return 1;
  return 1 - resolveEasing(transition.easing)(clamp(elapsedMs / transition.durationMs, 0, 1));
}

function slideOutProgress(transition: MotionTransition, remainingMs: number): number {
  if (remainingMs >= transition.durationMs) return 0;
  if (remainingMs <= 0) return 1;
  return resolveEasing(transition.easing)(clamp(1 - (remainingMs / transition.durationMs), 0, 1));
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function validateRippleSceneResizeLocks(motion: MotionDocument, oldEndMs: number): void {
  const lockedTrackIds = new Set((motion.tracks ?? []).filter((track) => track.locked).map((track) => track.id));
  for (const layer of motion.layers) {
    if (layer.startMs < oldEndMs) continue;
    if (layer.locked === true) throw new Error(`Ripple would move locked layer: ${layer.id}.`);
    const lockedTrackId = lockedTrackIdForLayer(motion.tracks ?? [], layer, lockedTrackIds);
    if (lockedTrackId) throw new Error(`Ripple would move layer on locked track: ${lockedTrackId}.`);
  }
}

function readTimelineDurationPolicy(motion: MotionDocument): TimelineDurationPolicy | null {
  const record = objectRecord(motion[DURATION_POLICY_EXTENSION_KEY]);
  if (!record || record.schema !== "shellx-motion/duration-policy@1") return null;
  const protectedRegions = Array.isArray(record.protectedRegions)
    ? record.protectedRegions.flatMap((value) => {
      const region = objectRecord(value);
      const id = typeof region?.id === "string" ? region.id.trim() : "";
      const startMs = region?.startMs;
      const durationMs = region?.durationMs;
      if (
        !region ||
        !id ||
        typeof startMs !== "number" ||
        !Number.isFinite(startMs) ||
        startMs < 0 ||
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs <= 0
      ) {
        return [];
      }
      return [{
        id,
        ...(typeof region.label === "string" && region.label.length > 0 ? { label: region.label } : {}),
        ...(typeof region.role === "string" && region.role.length > 0 ? { role: region.role } : {}),
        startMs,
        durationMs
      }];
    })
    : [];
  const minDurationMs = typeof record.minDurationMs === "number" && Number.isFinite(record.minDurationMs) && record.minDurationMs >= 0
    ? record.minDurationMs
    : undefined;
  const maxDurationMs = typeof record.maxDurationMs === "number" && Number.isFinite(record.maxDurationMs) && record.maxDurationMs >= 0
    ? record.maxDurationMs
    : undefined;
  return {
    schema: "shellx-motion/duration-policy@1",
    ...(minDurationMs !== undefined ? { minDurationMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(isTimelineDurationResizeMode(record.resizeMode) ? { resizeMode: record.resizeMode } : {}),
    protectedRegions
  };
}

function validateSceneResizeProtectedRegions(
  policy: TimelineDurationPolicy | null,
  oldScene: MotionScene,
  newDurationMs: number
): void {
  if (!policy) return;
  const oldStartMs = oldScene.startMs;
  const oldEndMs = oldScene.startMs + oldScene.durationMs;
  const newEndMs = oldScene.startMs + newDurationMs;
  for (const region of policy.protectedRegions) {
    const regionEndMs = region.startMs + region.durationMs;
    const overlappedOldScene = region.startMs < oldEndMs && regionEndMs > oldStartMs;
    if (!overlappedOldScene) continue;
    if (region.startMs < oldStartMs || regionEndMs > newEndMs) {
      throw new Error(`Scene resize would truncate protected region: ${region.id}.`);
    }
  }
}

function shiftTimelineDurationPolicy(
  policy: TimelineDurationPolicy | null,
  input: {
    ripple: boolean;
    deltaMs: number;
    oldEndMs: number;
    changedPaths: string[];
  }
): { policy: TimelineDurationPolicy | null; changed: boolean } {
  if (!policy || !input.ripple || input.deltaMs === 0) return { policy, changed: false };
  let changed = false;
  const protectedRegions = policy.protectedRegions.map((region) => {
    if (region.startMs < input.oldEndMs) return { ...region };
    changed = true;
    input.changedPaths.push(`/${DURATION_POLICY_EXTENSION_KEY}/protectedRegions/${region.id}/startMs`);
    return { ...region, startMs: region.startMs + input.deltaMs };
  });
  return {
    policy: { ...policy, protectedRegions },
    changed
  };
}

function validateTimelineDurationPolicyBounds(policy: TimelineDurationPolicy | null, durationMs: number): void {
  if (!policy) return;
  if (policy.minDurationMs !== undefined && durationMs < policy.minDurationMs) {
    throw new Error(`Scene resize would go below duration policy minDurationMs: ${policy.minDurationMs}.`);
  }
  if (policy.maxDurationMs !== undefined && durationMs > policy.maxDurationMs) {
    throw new Error(`Scene resize would exceed duration policy maxDurationMs: ${policy.maxDurationMs}.`);
  }
}

function validateTimelineDurationPolicyRegions(policy: TimelineDurationPolicy | null, durationMs: number): void {
  if (!policy) return;
  for (const region of policy.protectedRegions) {
    if (region.startMs < 0 || region.startMs + region.durationMs > durationMs) {
      throw new Error(`Scene resize would move protected region outside duration: ${region.id}.`);
    }
  }
}

function isTimelineDurationResizeMode(value: unknown): value is TimelineDurationPolicy["resizeMode"] {
  return value === "stretch-middle" || value === "ripple" || value === "fixed";
}

function assertLayerUnlocked(layer: MotionLayer, message = `Cannot edit locked layer: ${layer.id}.`): void {
  if (layer.locked === true) throw new Error(message);
}

function lockedTrackIdForLayer(tracks: MotionTrack[], layer: MotionLayer, lockedTrackIds: Set<string>): string | null {
  if (layer.trackId && lockedTrackIds.has(layer.trackId)) return layer.trackId;
  const lockedTrack = tracks.find((track) => track.locked && track.layerIds?.includes(layer.id));
  return lockedTrack?.id ?? null;
}

function mutedTrackIdForLayer(tracks: MotionTrack[], layer: MotionLayer, mutedTrackIds: Set<string>): string | null {
  if (layer.trackId && mutedTrackIds.has(layer.trackId)) return layer.trackId;
  const mutedTrack = tracks.find((track) => track.muted && track.layerIds?.includes(layer.id));
  return mutedTrack?.id ?? null;
}

function soloedTrackIdForLayer(tracks: MotionTrack[], layer: MotionLayer, soloedTrackIds: Set<string>): string | null {
  if (layer.trackId && soloedTrackIds.has(layer.trackId)) return layer.trackId;
  const soloedTrack = tracks.find((track) => track.solo && track.layerIds?.includes(layer.id));
  return soloedTrack?.id ?? null;
}

function trackVolumeForLayer(tracks: MotionTrack[], layer: MotionLayer): number | undefined {
  const directTrack = layer.trackId ? tracks.find((track) => track.id === layer.trackId) : undefined;
  if (typeof directTrack?.volume === "number") return directTrack.volume;
  const referencedTrack = tracks.find((track) => typeof track.volume === "number" && track.layerIds?.includes(layer.id));
  return referencedTrack?.volume;
}

function trackPanForLayer(tracks: MotionTrack[], layer: MotionLayer): number | undefined {
  const directTrack = layer.trackId ? tracks.find((track) => track.id === layer.trackId) : undefined;
  if (typeof directTrack?.pan === "number") return directTrack.pan;
  const referencedTrack = tracks.find((track) => typeof track.pan === "number" && track.layerIds?.includes(layer.id));
  return referencedTrack?.pan;
}

function trackFadeForLayer(tracks: MotionTrack[], layer: MotionLayer): Partial<TimelineTrackFadeSnapshot> {
  const directTrack = layer.trackId ? tracks.find((track) => track.id === layer.trackId) : undefined;
  const referencedTrack = tracks.find((track) =>
    (typeof track.fadeInMs === "number" || typeof track.fadeOutMs === "number") &&
    track.layerIds?.includes(layer.id)
  );
  const track = (typeof directTrack?.fadeInMs === "number" || typeof directTrack?.fadeOutMs === "number")
    ? directTrack
    : referencedTrack;
  return {
    ...(typeof track?.fadeInMs === "number" ? { fadeInMs: track.fadeInMs } : {}),
    ...(typeof track?.fadeOutMs === "number" ? { fadeOutMs: track.fadeOutMs } : {})
  };
}

function timelineDuration(motion: MotionDocument): number {
  const sceneEnd = Math.max(0, ...(motion.scenes ?? []).map((scene) => scene.startMs + scene.durationMs));
  const layerEnd = Math.max(0, ...motion.layers.map((layer) => layer.startMs + layer.durationMs));
  const markerEnd = Math.max(0, ...(motion.markers ?? []).map((marker) => marker.atMs + (marker.durationMs ?? 0)));
  return Math.max(sceneEnd, layerEnd, markerEnd);
}

function uniqueSplitLayerId(motion: MotionDocument, layerId: string, atMs: number): string {
  const base = `${layerId}_split_${Math.round(atMs)}`.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "layer_split";
  const existing = new Set(motion.layers.map((layer) => layer.id));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Unable to generate a unique split layer id for ${layerId}.`);
}

function uniqueDuplicateLayerId(motion: MotionDocument, layerId: string): string {
  const base = `${layerId}_copy`.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "layer_copy";
  const existing = new Set(motion.layers.map((layer) => layer.id));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Unable to generate a unique duplicate layer id for ${layerId}.`);
}

function cloneMotionLayer(layer: MotionLayer): MotionLayer {
  return structuredClone(layer);
}

function sourceOffsetForLayerSplit(layer: MotionLayer, splitOffsetMs: number): number | undefined {
  if (!isMediaTrimLayer(layer)) return undefined;
  return splitOffsetMs * readPositiveNumber(layer.playbackRate, 1);
}

function isMediaTrimLayer(layer: MotionLayer): boolean {
  return layer.type === "video"
    || layer.type === "audio"
    || typeof layer.trimStartMs === "number"
    || typeof layer.trimDurationMs === "number";
}

function applyOriginalSourceTrim(target: MotionLayer, source: MotionLayer, sourceOffsetMs: number | undefined): void {
  if (sourceOffsetMs === undefined) return;
  if (typeof source.trimDurationMs === "number") {
    target.trimDurationMs = Math.min(source.trimDurationMs, sourceOffsetMs);
  }
}

function applySplitSourceTrim(target: MotionLayer, source: MotionLayer, sourceOffsetMs: number | undefined): void {
  if (sourceOffsetMs === undefined) return;
  const trimStartMs = readNumber(source.trimStartMs, 0) + sourceOffsetMs;
  target.trimStartMs = trimStartMs;
  if (typeof source.trimDurationMs === "number") {
    target.trimDurationMs = Math.max(0, source.trimDurationMs - sourceOffsetMs);
  }
}

function defaultAnimationPresetStartMs(layer: MotionLayer, preset: MotionAnimationPreset, durationMs: number): number {
  if (preset.kind === "exit") return layer.startMs + layer.durationMs - durationMs;
  return layer.startMs;
}

function layerBaseOpacity(layer: MotionLayer): number {
  if (typeof layer.opacity === "number" && Number.isFinite(layer.opacity)) return layer.opacity;
  if (typeof layer.transform?.opacity === "number" && Number.isFinite(layer.transform.opacity)) return layer.transform.opacity;
  return 1;
}

interface AnimationPresetKeyframeInput {
  preset: MotionAnimationPresetId;
  startMs: number;
  endMs: number;
  distancePx: number;
  easing: MotionEasing;
  baseOpacity: number;
  baseY: number;
}

function animationPresetKeyframes(input: AnimationPresetKeyframeInput): LayerKeyframeUpsert[] {
  const fadeIn: LayerKeyframeUpsert[] = [
    { target: "opacity", atMs: input.startMs, value: 0, easing: input.easing },
    { target: "opacity", atMs: input.endMs, value: input.baseOpacity }
  ];
  const fadeOut: LayerKeyframeUpsert[] = [
    { target: "opacity", atMs: input.startMs, value: input.baseOpacity, easing: input.easing },
    { target: "opacity", atMs: input.endMs, value: 0 }
  ];
  const slideUpIn: LayerKeyframeUpsert[] = [
    { target: "transform.y", atMs: input.startMs, value: input.baseY + input.distancePx, easing: input.easing },
    { target: "transform.y", atMs: input.endMs, value: input.baseY }
  ];
  const slideDownOut: LayerKeyframeUpsert[] = [
    { target: "transform.y", atMs: input.startMs, value: input.baseY, easing: input.easing },
    { target: "transform.y", atMs: input.endMs, value: input.baseY + input.distancePx }
  ];

  if (input.preset === "fade-in") return fadeIn;
  if (input.preset === "fade-out") return fadeOut;
  if (input.preset === "slide-up-in") return slideUpIn;
  if (input.preset === "slide-down-out") return slideDownOut;
  if (input.preset === "lower-third-in") return [...fadeIn, ...slideUpIn];
  return [...fadeOut, ...slideDownOut];
}

function splitLayerTransitions(layer: MotionLayer): {
  original: MotionLayer["transitions"] | undefined;
  split: MotionLayer["transitions"] | undefined;
} {
  const original = layer.transitions?.in ? { in: { ...layer.transitions.in } } : undefined;
  const split = layer.transitions?.out ? { out: { ...layer.transitions.out } } : undefined;
  return { original, split };
}

/**
 * Refuse a rewriting mutation when a keyframe track is not an array.
 *
 * `MotionLayer["keyframes"]` is typed as `Partial<Record<target, MotionKeyframe[]>>`, and that type
 * is a promise the loader does not keep: `loadMotionPackage` is a shallow reader that spreads
 * `keyframes` through untouched, so a hand-written `motion.json` can hold `"opacity": { "0": 0 }`
 * and reach here. `unreadableLayerKeyframes` deliberately skips such a track — "must be an array" is
 * the validator's own structural error and reporting it as unreadable keyframes would double-count
 * it under a misleading name — which leaves the split free to drop the track entirely. Measured
 * before this guard existed: validate reported `/layers/0/keyframes/opacity: must be an array`, the
 * split answered ok with `keyframes: undefined` on both halves, and the patched document then
 * validated CLEAN. The command deleted the error by deleting the author's data, which is the exact
 * laundering the readability gate above exists to stop.
 *
 * @param layer the layer about to be rewritten.
 * @param layerIndex the layer's index in `motion.layers`, so the path matches the validator's.
 * @param operation author-facing name of the mutation.
 * @throws Error naming the offending track's JSON path and the shape the engine reads.
 */
function assertArrayKeyframeTracks(layer: MotionLayer, layerIndex: number, operation: string): void {
  for (const [target, entries] of Object.entries(layer.keyframes ?? {})) {
    if (Array.isArray(entries)) continue;
    throw new Error(
      `${operation} would rewrite this layer's keyframes, and /layers/${layerIndex}/keyframes/${target}`
      + ` is not an array. A keyframe track is a list of { "atMs": <milliseconds>, "value": <number or`
      + ` string> } objects. Rewriting it now would drop the whole track without a trace, so this`
      + ` refuses instead.`
    );
  }
}

/**
 * Cut every keyframe track on a layer at `atMs`, into the head half and the tail half.
 *
 * ITERATES THE LAYER'S OWN TARGETS, NOT A STATIC LIST
 *
 * This walked `SUPPORTED_KEYFRAME_TARGET_LIST`, which cannot contain the DYNAMIC targets the schema
 * accepts: `shader.uniforms.<name>` is a legal, engine-readable keyframe target whenever the layer
 * declares that uniform (see `validateLayerKeyframes`), and `effectiveLayerAtMs` interpolates it. A
 * target the static list does not name appeared in neither half, so splitting the layer deleted the
 * track outright. Measured on the shipped `fixtures/packages/restricted-shader`, whose
 * `signal-bloom` layer animates `shader.uniforms.u_speed`: `motion.timeline.layer.split` answered
 * `ok: true` with `warnings: []` and both halves came back with no `keyframes` at all.
 *
 * Reading the layer's own keys makes the set of tracks that survive a split equal to the set of
 * tracks the author wrote, which is the only definition that cannot go stale as targets are added.
 * A target this engine does not support survives too — the post-mutation validator then reports
 * `unsupported keyframe target` at its path, which is a true answer the author can act on, where
 * silently deleting it was not.
 *
 * @param keyframes the layer's stored keyframe map, already proven readable by the caller's gate.
 * @param atMs split point, in document milliseconds.
 * @returns the two halves, each `undefined` when the layer had no tracks at all.
 */
function splitLayerKeyframes(
  keyframes: MotionLayer["keyframes"],
  atMs: number
): { original: MotionLayer["keyframes"] | undefined; split: MotionLayer["keyframes"] | undefined } {
  if (!keyframes) return { original: undefined, split: undefined };
  const original: Record<string, MotionKeyframe[]> = {};
  const split: Record<string, MotionKeyframe[]> = {};

  for (const [target, frames] of Object.entries(keyframes)) {
    if (!Array.isArray(frames) || frames.length === 0) continue;
    const sorted = [...frames].sort((left, right) => left.atMs - right.atMs);
    const boundary = boundaryKeyframe(target, sorted, atMs);
    const before = sorted.filter((frame) => frame.atMs < atMs).map(cloneMotionKeyframe);
    const after = sorted.filter((frame) => frame.atMs > atMs).map(cloneMotionKeyframe);
    const exact = sorted.find((frame) => frame.atMs === atMs);
    const boundaryFrame = cloneMotionKeyframe(exact ?? boundary);
    original[target] = [...before, boundaryFrame];
    split[target] = [cloneMotionKeyframe(exact ?? boundary), ...after];
  }

  return {
    original: Object.keys(original).length > 0 ? original as MotionLayer["keyframes"] : undefined,
    split: Object.keys(split).length > 0 ? split as MotionLayer["keyframes"] : undefined
  };
}

/**
 * The keyframe both halves share at the split point: the track's value at `atMs`.
 *
 * WHY THERE IS NO LONGER A DEFAULT VALUE
 *
 * This used to end `value: value ?? keyframes[0]?.value ?? 0`. Both fallbacks fire in exactly one
 * situation — the interpolator refused the track — and in that situation neither is an answer. The
 * middle term hands back the FIRST keyframe's value regardless of where the split lands, which is
 * not the value at `atMs` and is not even the right type when the track's values do not match its
 * target. The final `?? 0` writes a literal zero, and on the ca8ee4c `{ t, v }` document that is
 * precisely what shipped: both halves came back as a single `{ atMs, value: 0 }`, replacing every
 * authored keyframe, and the result validated clean because the offenders had been deleted.
 *
 * `splitLayerAtMs` now proves the whole layer readable before calling this, so the interpolators can
 * only refuse for the one remaining reason: the track's values are the wrong TYPE for its target —
 * strings on `opacity`, numbers on `fill`. That is a nameable authoring mistake, so it is named.
 *
 * @param target the keyframe target, which selects the interpolation family.
 * @param keyframes the track's keyframes, sorted, non-empty and readable.
 * @param atMs split point, in document milliseconds.
 * @returns the boundary keyframe, carrying the easing of the segment it lands in.
 * @throws Error when the track's values do not fit its target and no boundary value exists.
 */
function boundaryKeyframe(target: string, keyframes: MotionKeyframe[], atMs: number): MotionKeyframe {
  const isColor = COLOR_KEYFRAME_TARGETS.has(target as MotionKeyframeTarget);
  const isDiscreteString = DISCRETE_STRING_KEYFRAME_TARGETS.has(target as MotionKeyframeTarget);
  const value = isColor
    ? interpolateColor(keyframes, atMs)
    : isDiscreteString
      ? interpolateString(keyframes, atMs)
    : interpolateNumber(keyframes, atMs);
  if (value === null) {
    const expected = isColor ? "a colour string" : isDiscreteString ? "a string" : "a finite number";
    throw new Error(
      `Layer split cannot compute a boundary value for ${target} at ${atMs}ms:`
      + ` every keyframe on this target must hold ${expected}, and at least one does not.`
      + ` Fix the values on ${target} and split again; inventing a boundary value here would write`
      + ` animation the author never authored.`
    );
  }
  const activeFrame = [...keyframes].reverse().find((frame) => frame.atMs < atMs);
  return {
    atMs,
    value,
    ...(activeFrame?.easing ? { easing: activeFrame.easing } : {})
  };
}

function layerTimingSnapshot(layer: MotionLayer): LayerTimingSnapshot {
  return {
    startMs: layer.startMs,
    durationMs: layer.durationMs,
    ...(typeof layer.trimStartMs === "number" ? { trimStartMs: layer.trimStartMs } : {}),
    ...(typeof layer.trimDurationMs === "number" ? { trimDurationMs: layer.trimDurationMs } : {})
  };
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function snapTimestampToFrameGrid(atMs: number, fps: number, mode: LayerKeyframeSnapMode): number {
  const frame = (atMs / 1000) * fps;
  const snappedFrame = mode === "floor" ? Math.floor(frame) : mode === "ceil" ? Math.ceil(frame) : Math.round(frame);
  const snappedMs = (snappedFrame * 1000) / fps;
  const normalized = Number(snappedMs.toFixed(6));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function isPanValue(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function isAudioMixLayer(layer: MotionLayer): boolean {
  return layer.type === "audio" || (layer.type === "video" && layer.includeAudio === true);
}

function cloneDucking(ducking: MotionAudioDucking): MotionAudioDucking {
  return {
    triggerLayerIds: [...ducking.triggerLayerIds],
    ...(ducking.mode !== undefined ? { mode: ducking.mode } : {}),
    ...(ducking.duckToVolume !== undefined ? { duckToVolume: ducking.duckToVolume } : {}),
    ...(ducking.attackMs !== undefined ? { attackMs: ducking.attackMs } : {}),
    ...(ducking.releaseMs !== undefined ? { releaseMs: ducking.releaseMs } : {}),
    ...(ducking.threshold !== undefined ? { threshold: ducking.threshold } : {}),
    ...(ducking.ratio !== undefined ? { ratio: ducking.ratio } : {})
  };
}

function duckingEqual(left: MotionAudioDucking, right: MotionAudioDucking): boolean {
  return stringArraysEqual(left.triggerLayerIds, right.triggerLayerIds) &&
    left.mode === right.mode &&
    left.duckToVolume === right.duckToVolume &&
    left.attackMs === right.attackMs &&
    left.releaseMs === right.releaseMs &&
    left.threshold === right.threshold &&
    left.ratio === right.ratio;
}

function isPositiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateKeyframeTargetValue(target: MotionKeyframeTarget, value: MotionKeyframeValue): void {
  if (COLOR_KEYFRAME_TARGETS.has(target)) {
    if (!isSupportedColorKeyframeValue(value)) {
      throw new Error(`${target} keyframe value must be a supported color string.`);
    }
    return;
  }
  const allowedStringValues = alignmentKeyframeValues(target);
  if (allowedStringValues) {
    if (typeof value !== "string" || !allowedStringValues.includes(value.trim().toLowerCase())) {
      throw new Error(`${target} keyframe value must be one of: ${allowedStringValues.join(", ")}.`);
    }
    return;
  }
  if (BLEND_MODE_KEYFRAME_TARGETS.has(target)) {
    if (typeof value !== "string" || !SUPPORTED_BLEND_MODES.has(value)) {
      throw new Error(`${target} keyframe value must be a supported blend mode.`);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Keyframe value must be a finite number.");
  }
  if (PAN_KEYFRAME_TARGETS.has(target) && !isPanValue(value)) {
    throw new Error(`${target} keyframe value must be a finite number between -1 and 1.`);
  }
  if (NON_NEGATIVE_KEYFRAME_TARGETS.has(target) && value < 0) {
    throw new Error(`${target} keyframe value must be a non-negative finite number.`);
  }
  if (POSITIVE_KEYFRAME_TARGETS.has(target) && value <= 0) {
    throw new Error(`${target} keyframe value must be a positive finite number.`);
  }
}

function normalizeTimelineLayerStyleProperty(property: unknown): string {
  if (!isNonEmptyString(property)) throw new Error("Style property is required.");
  const raw = String(property).trim();
  const normalized = raw.replace(/^style\./, "");
  if (!normalized || normalized.includes(".")) throw new Error(`Unsupported layer style property: ${normalized || raw}.`);
  if (
    STYLE_COLOR_PROPERTIES.has(normalized) ||
    STYLE_STRING_PROPERTIES.has(normalized) ||
    STYLE_POSITIVE_NUMBER_PROPERTIES.has(normalized) ||
    STYLE_FINITE_NUMBER_PROPERTIES.has(normalized) ||
    STYLE_NON_NEGATIVE_NUMBER_PROPERTIES.has(normalized) ||
    normalized === "textAlign" ||
    normalized === "verticalAlign" ||
    normalized === "alignY"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported layer style property: ${normalized}.`);
}

function validateTimelineLayerStyleValue(property: string, value: unknown): string | number {
  const tokenReference = readMotionTokenReference(value);
  if (tokenReference) return tokenReference;
  if (STYLE_COLOR_PROPERTIES.has(property)) {
    if (typeof value !== "string" || !isSupportedColorKeyframeValue(value)) {
      throw new Error(`Layer style ${property} must be a supported color string.`);
    }
    return value.trim();
  }
  if (STYLE_STRING_PROPERTIES.has(property)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Layer style ${property} must be a non-empty string.`);
    }
    return value.trim();
  }
  if (STYLE_POSITIVE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Layer style ${property} must be a positive finite number.`);
    }
    return value;
  }
  if (STYLE_NON_NEGATIVE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Layer style ${property} must be a non-negative finite number.`);
    }
    return value;
  }
  if (STYLE_FINITE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Layer style ${property} must be a finite number.`);
    }
    return value;
  }
  const allowedValues = styleAlignmentValues(property);
  if (allowedValues) {
    if (typeof value !== "string" || !allowedValues.includes(value.trim().toLowerCase())) {
      throw new Error(`Layer style ${property} must be one of: ${allowedValues.join(", ")}.`);
    }
    return value.trim().toLowerCase();
  }
  throw new Error(`Unsupported layer style property: ${property}.`);
}

function normalizeTimelineLayerTransformProperty(property: unknown): string {
  if (!isNonEmptyString(property)) throw new Error("Transform property is required.");
  const raw = String(property).trim();
  const normalized = raw.replace(/^transform\./, "");
  if (!normalized || normalized.includes(".")) throw new Error(`Unsupported layer transform property: ${normalized || raw}.`);
  if (
    normalized === "opacity" ||
    TRANSFORM_FINITE_NUMBER_PROPERTIES.has(normalized) ||
    TRANSFORM_NON_NEGATIVE_NUMBER_PROPERTIES.has(normalized) ||
    TRANSFORM_POSITIVE_NUMBER_PROPERTIES.has(normalized)
  ) {
    return normalized;
  }
  throw new Error(`Unsupported layer transform property: ${normalized}.`);
}

function validateTimelineLayerTransformValue(property: string, value: unknown): number {
  if (property === "opacity") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("Layer transform opacity must be a finite number between 0 and 1.");
    }
    return value;
  }
  if (TRANSFORM_NON_NEGATIVE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Layer transform ${property} must be a non-negative finite number.`);
    }
    return value;
  }
  if (TRANSFORM_POSITIVE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Layer transform ${property} must be a positive finite number.`);
    }
    return value;
  }
  if (TRANSFORM_FINITE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Layer transform ${property} must be a finite number.`);
    }
    return value;
  }
  throw new Error(`Unsupported layer transform property: ${property}.`);
}

function normalizeTimelineLayerEffectProperty(property: unknown): string {
  if (!isNonEmptyString(property)) throw new Error("Effect property is required.");
  const raw = String(property).trim();
  const normalized = raw.replace(/^effects?\./, "");
  if (!normalized || normalized.includes(".")) throw new Error(`Unsupported layer effect property: ${normalized || raw}.`);
  if (EFFECT_NON_NEGATIVE_NUMBER_PROPERTIES.has(normalized)) return normalized;
  throw new Error(`Unsupported layer effect property: ${normalized}.`);
}

function validateTimelineLayerEffectValue(property: string, value: unknown): number {
  if (EFFECT_NON_NEGATIVE_NUMBER_PROPERTIES.has(property)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Layer effect ${property} must be a non-negative finite number.`);
    }
    return value;
  }
  throw new Error(`Unsupported layer effect property: ${property}.`);
}

function validateTimelineLayerBlendMode(value: unknown): MotionLayer["blendMode"] {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Layer blend mode is required.");
  const normalized = value.trim().toLowerCase();
  if (!SUPPORTED_BLEND_MODES.has(normalized)) {
    throw new Error("Layer blend mode must be a supported blend mode.");
  }
  return normalized as MotionLayer["blendMode"];
}

function validateTimelineLayerCrop(value: unknown): NonNullable<MotionLayer["crop"]> {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
  if (!record) throw new Error("Layer crop must be an object.");
  return {
    x: readNonNegativeCropNumber(record.x, "x"),
    y: readNonNegativeCropNumber(record.y, "y"),
    width: readPositiveCropNumber(record.width, "width"),
    height: readPositiveCropNumber(record.height, "height")
  };
}

function readNonNegativeCropNumber(value: unknown, field: "x" | "y"): number {
  const number = readNonNegativeFiniteNumber(value);
  if (number === null) throw new Error(`Layer crop ${field} must be a non-negative finite number.`);
  return number;
}

function readPositiveCropNumber(value: unknown, field: "width" | "height"): number {
  const number = readPositiveFiniteNumber(value);
  if (number === null) throw new Error(`Layer crop ${field} must be a positive finite number.`);
  return number;
}

function validateTimelineLayerMask(value: unknown): NonNullable<MotionLayer["mask"]> {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
  if (!record) throw new Error("Layer mask must be an object.");
  const type = readTimelineLayerMaskType(record.type);
  if (type === "path") {
    if (hasOwn(record, "inset") || hasOwn(record, "radius")) throw new Error("Path masks do not support inset or radius.");
    const path = validateMotionPathData(record.path, "Layer path mask");
    const viewBox = parseMotionPathViewBox(record.viewBox, "Layer path mask viewBox").normalized;
    const fillRule = readTimelinePathMaskFillRule(record.fillRule);
    return { type, path, viewBox, ...(fillRule ? { fillRule } : {}) };
  }
  if (hasOwn(record, "path") || hasOwn(record, "viewBox") || hasOwn(record, "fillRule")) {
    throw new Error("Path, viewBox, and fillRule are supported only on path masks.");
  }
  const inset = readTimelineLayerMaskInset(record.inset);
  const mask: NonNullable<MotionLayer["mask"]> = {
    type,
    ...(inset ? { inset } : {})
  };
  if (hasOwn(record, "radius")) {
    mask.radius = readTimelineLayerMaskRadius(record.radius);
  }
  return mask;
}

function readTimelineLayerMaskType(value: unknown): "rect" | "rounded-rect" | "path" {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Layer mask type is required.");
  const normalized = value.trim().toLowerCase();
  if (!SUPPORTED_MASK_TYPES.has(normalized)) throw new Error("Layer mask type must be rect, rounded-rect, or path.");
  if (normalized === "path") return "path";
  return normalized === "rounded-rect" ? "rounded-rect" : "rect";
}

function readTimelinePathMaskFillRule(value: unknown): "nonzero" | "evenodd" | undefined {
  if (value === undefined) return undefined;
  if (value !== "nonzero" && value !== "evenodd") throw new Error("Layer path mask fillRule must be nonzero or evenodd.");
  return value;
}

function readTimelineLayerMaskInset(value: unknown): NonNullable<MotionLayer["mask"]>["inset"] | undefined {
  if (value === undefined) return undefined;
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
  if (!record) throw new Error("Layer mask inset must be an object.");
  const inset: NonNullable<MotionLayer["mask"]>["inset"] = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (hasOwn(record, side)) {
      inset[side] = readTimelineLayerMaskInsetNumber(record[side], side);
    }
  }
  return Object.keys(inset).length > 0 ? inset : undefined;
}

function readTimelineLayerMaskInsetNumber(value: unknown, side: "top" | "right" | "bottom" | "left"): number {
  const number = readNonNegativeFiniteNumber(value);
  if (number === null) throw new Error(`Layer mask inset ${side} must be a non-negative finite number.`);
  return number;
}

function readTimelineLayerMaskRadius(value: unknown): number {
  const number = readNonNegativeFiniteNumber(value);
  if (number === null) throw new Error("Layer mask radius must be a non-negative finite number.");
  return number;
}

function validateTimelineLayerFit(value: unknown): TimelineLayerMediaFit {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Layer fit is required.");
  const normalized = value.trim().toLowerCase();
  for (const fit of SUPPORTED_MEDIA_FITS) {
    if (fit === normalized) return fit;
  }
  throw new Error("Layer fit must be a supported media fit.");
}

function readTimelineLayerFitValue(layer: MotionLayer): string | null {
  const rootFit = readTimelineLayerFitSourceValue(layer.fit);
  if (rootFit) return rootFit;
  const style = layer.style && typeof layer.style === "object" && !Array.isArray(layer.style) ? layer.style : undefined;
  const objectFit = readTimelineLayerFitSourceValue(style?.objectFit);
  if (objectFit) return objectFit;
  return readTimelineLayerFitSourceValue(style?.fit);
}

function readTimelineLayerFitSourceValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function validateTimelineLayerMediaSource(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Layer media source is required.");
  return value.trim();
}

function readTimelineLayerMediaSourceValue(layer: MotionLayer): string | null {
  return readTimelineLayerMediaSourceRef(layer.assetRef)
    ?? readTimelineLayerMediaSourceRef(layer.source)
    ?? readTimelineLayerMediaSourceRef(layer.src)
    ?? readTimelineLayerMediaSourceRef(layer.assetId);
}

function readTimelineLayerMediaSourceRef(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function timelineLayerMaskChangedPaths(layerId: string, oldMask: NonNullable<MotionLayer["mask"]> | null, newMask: NonNullable<MotionLayer["mask"]>): string[] {
  const changedPaths: string[] = [];
  if (!oldMask || !Object.is(oldMask.type, newMask.type)) changedPaths.push(`/layers/${layerId}/mask/type`);
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const oldHas = !!oldMask?.inset && hasOwn(oldMask.inset, side);
    const newHas = !!newMask.inset && hasOwn(newMask.inset, side);
    const oldValue = oldHas ? oldMask.inset?.[side] : undefined;
    const newValue = newHas ? newMask.inset?.[side] : undefined;
    if (oldHas !== newHas || !Object.is(oldValue, newValue)) changedPaths.push(`/layers/${layerId}/mask/inset/${side}`);
  }
  const oldHasRadius = !!oldMask && hasOwn(oldMask, "radius");
  const newHasRadius = hasOwn(newMask, "radius");
  if (oldHasRadius !== newHasRadius || !Object.is(oldMask?.radius, newMask.radius)) changedPaths.push(`/layers/${layerId}/mask/radius`);
  for (const field of ["path", "viewBox", "fillRule"] as const) {
    const oldHas = !!oldMask && hasOwn(oldMask, field);
    const newHas = hasOwn(newMask, field);
    if (oldHas !== newHas || !Object.is(oldMask?.[field], newMask[field])) changedPaths.push(`/layers/${layerId}/mask/${field}`);
  }
  return changedPaths;
}

function readMotionTokenReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\{[A-Za-z0-9_.-]+\}$/.test(trimmed) || /^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}$/.test(trimmed)
    ? trimmed
    : null;
}

function readTimelineLayerStyleValue(style: MotionLayer["style"], property: string): unknown {
  return style && Object.prototype.hasOwnProperty.call(style, property) ? style[property] : null;
}

function readTimelineLayerTransformValue(layer: MotionLayer, property: string): unknown {
  if (property === "opacity") {
    if (Object.prototype.hasOwnProperty.call(layer, "opacity")) return layer.opacity;
    return layer.transform && Object.prototype.hasOwnProperty.call(layer.transform, "opacity") ? layer.transform.opacity : null;
  }
  return layer.transform && Object.prototype.hasOwnProperty.call(layer.transform, property)
    ? readObject(layer.transform)[property]
    : null;
}

function readTimelineLayerEffectValue(effects: MotionLayer["effects"], property: string): unknown {
  return effects && Object.prototype.hasOwnProperty.call(effects, property) ? readObject(effects)[property] : null;
}

function readNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function styleAlignmentValues(property: string): readonly string[] | undefined {
  if (property === "textAlign") return TEXT_ALIGN_KEYFRAME_VALUES;
  if (property === "verticalAlign" || property === "alignY") return VERTICAL_ALIGN_KEYFRAME_VALUES;
  return undefined;
}

function alignmentKeyframeValues(target: MotionKeyframeTarget): readonly string[] | undefined {
  if (target === "style.textAlign") return TEXT_ALIGN_KEYFRAME_VALUES;
  if (target === "style.verticalAlign" || target === "style.alignY") return VERTICAL_ALIGN_KEYFRAME_VALUES;
  return undefined;
}

function isSupportedColorKeyframeValue(value: MotionKeyframeValue): boolean {
  return isSupportedMotionColorString(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneTrackWithLayerIds(track: MotionTrack): MotionTrack {
  return { ...track, ...(track.layerIds ? { layerIds: [...track.layerIds] } : { layerIds: [] }) };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateTimelineMarkerInput(motion: MotionDocument, input: TimelineMarkerUpsert): void {
  if (!isNonEmptyString(input.id)) throw new Error("Marker id is required.");
  if (!isNonNegativeFinite(input.atMs)) throw new Error("Marker atMs must be a non-negative finite number.");
  if (input.atMs > motion.durationMs) throw new Error("Marker atMs must fit within document durationMs.");
  if (input.durationMs !== undefined && !isNonNegativeFinite(input.durationMs)) {
    throw new Error("Marker durationMs must be a non-negative finite number.");
  }
  if (input.label !== undefined && typeof input.label !== "string") throw new Error("Marker label must be a string.");
  if (input.type !== undefined && typeof input.type !== "string") throw new Error("Marker type must be a string.");
  if (input.color !== undefined && typeof input.color !== "string") throw new Error("Marker color must be a string.");
  if (input.sceneId !== undefined && !isNonEmptyString(input.sceneId)) throw new Error("Marker sceneId must be a non-empty string.");
  if (input.sceneId && !motion.scenes?.some((scene) => scene.id === input.sceneId)) {
    throw new Error(`Motion scene not found: ${input.sceneId}.`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
