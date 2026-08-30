/**
 * Named argument-value enumerations published alongside the debug command contracts.
 *
 * Role: one dictionary of allowed values that argument schemas reference by name
 * (`enumRef`) instead of inlining. Large sets (113 keyframe targets, every export
 * preset) would otherwise be copied into a dozen command schemas and drift.
 *
 * Dependencies: `@shellx-motion/core` is the single source of truth for every entry.
 * Where core exports a list, it is used directly. Where core only exports a *type*
 * (blend modes, media fits, transition types), the list is derived from an exhaustive
 * `Record<Union, true>` so the TypeScript compiler fails the build if the union gains
 * or loses a member — a hand list that cannot silently drift.
 *
 * Primary callers: `command-metadata*.ts` (via `enumRef`), `scripts/generate-public-contracts.ts`
 * (publishes `argEnums` into `schemas/debug.json`), and `scripts/generate-debug-api-reference.mjs`
 * (renders the enum tables into `docs/public/DEBUG_API_COMMANDS.md`).
 */
import type { MotionPermissionTier } from "@shellx-motion/actions";
import {
  listMotionAnimationPresets,
  listMotionEasingPresets,
  listTransitionPresets,
  MOTION_EXPORT_PRESETS,
  NAMED_EASINGS_LIST,
  readSupportedTransitionType,
  SPRING_PRESET_IDS,
  SUPPORTED_KEYFRAME_TARGET_LIST,
  type MotionBlendMode,
  type MotionSpatialTangentMode,
  type TimelineLayerMediaFit
} from "@shellx-motion/core";

/**
 * Build a value list from an exhaustive keyed record.
 *
 * @param record - one key per union member, each set to `true`.
 * @returns the union members in declaration order.
 *
 * Edge case this guards: a union member added in core without a matching key here is a
 * compile error at the call site, so the published enum can never fall behind the type.
 */
function exhaustive<Key extends string>(record: Record<Key, true>): Key[] {
  return Object.keys(record) as Key[];
}

const BLEND_MODE_VALUES = exhaustive<MotionBlendMode>({
  normal: true, multiply: true, screen: true, overlay: true, darken: true, lighten: true,
  "color-dodge": true, "color-burn": true, "hard-light": true, "soft-light": true,
  difference: true, exclusion: true, hue: true, saturation: true, color: true,
  luminosity: true, "plus-lighter": true
});

const MEDIA_FIT_VALUES = exhaustive<TimelineLayerMediaFit>({
  fill: true, contain: true, cover: true, none: true, "scale-down": true
});

const TRANSITION_TYPE_VALUES = exhaustive<NonNullable<ReturnType<typeof readSupportedTransitionType>>>({
  fade: true, slide: true, wipe: true
});

const SPATIAL_TANGENT_MODE_VALUES = exhaustive<MotionSpatialTangentMode>({
  linear: true, smooth: true, broken: true, auto: true
});

const PERMISSION_TIER_VALUES = exhaustive<MotionPermissionTier>({
  read_motion: true, draft_motion: true, render_motion: true, edit_motion: true,
  write_local: true, push_remote: true
});

/** A published enumeration: the allowed values plus the sentence an agent needs to use them. */
export interface MotionDebugArgEnum {
  values: string[];
  description: string;
}

/**
 * The published enum dictionary. Keys are the `enumRef` values used by argument schemas.
 *
 * Frozen so a consumer cannot mutate the contract after import; the arrays are copies of the
 * core lists so mutating a published array cannot corrupt core state either.
 */
export const MOTION_DEBUG_ARG_ENUMS: Readonly<Record<string, MotionDebugArgEnum>> = Object.freeze({
  keyframeTarget: {
    values: [...SUPPORTED_KEYFRAME_TARGET_LIST],
    description: "Animatable keyframe target paths accepted by every motion.timeline.keyframe.* command."
  },
  easing: {
    values: [...NAMED_EASINGS_LIST, ...SPRING_PRESET_IDS],
    description:
      "Named easings and spring preset aliases. Easing argument schemas also publish bounded cubic-bezier(x1,y1,x2,y2) and steps(count,start|end) grammar, "
      + "plus the closed spring object { type: \"spring\", stiffness, damping, mass?, initialVelocity? }."
  },
  easingPreset: {
    values: listMotionEasingPresets().map((preset) => preset.id),
    description: "Easing preset ids returned by motion.timeline.easing.presets."
  },
  animationPreset: {
    values: listMotionAnimationPresets().map((preset) => preset.id),
    description: "Animation preset ids accepted by motion.timeline.animation.preset.apply."
  },
  transitionPreset: {
    values: listTransitionPresets().map((preset) => preset.id),
    description: "Transition preset ids accepted by motion.timeline.transition.preset.apply."
  },
  exportPreset: {
    values: [...MOTION_EXPORT_PRESETS],
    description: "Export preset ids accepted by render, batch, and export planning commands."
  },
  blendMode: {
    values: BLEND_MODE_VALUES,
    description: "Layer blend modes accepted by motion.timeline.layer.blend.set and layer.blendMode."
  },
  mediaFit: {
    values: MEDIA_FIT_VALUES,
    description: "Media fit modes accepted by motion.timeline.layer.fit.set for image and video layers."
  },
  transitionType: {
    values: TRANSITION_TYPE_VALUES,
    description: "Layer transition types accepted by motion.timeline.transition.upsert."
  },
  transitionDirection: {
    values: ["left", "right", "up", "down"],
    description: "Directional hint for slide and wipe transitions."
  },
  transitionEdge: {
    values: ["in", "out"],
    description: "Which end of a layer a transition applies to."
  },
  captionFormat: {
    values: ["srt", "vtt", "plain"],
    description: "Caption source formats accepted by motion.timeline.caption.import."
  },
  keyframeSnapMode: {
    values: ["nearest", "floor", "ceil"],
    description: "Rounding mode used by motion.timeline.keyframe.snap."
  },
  duckingMode: {
    values: ["timed", "sidechain"],
    description: "Audio ducking mode; sidechain enables the threshold and ratio knobs."
  },
  durationResizeMode: {
    values: ["stretch-middle", "ripple", "fixed"],
    description: "How motion.timeline.duration.policy.set reflows content when the duration changes."
  },
  deliveryLane: {
    values: ["native", "ffmpeg"],
    description:
      "CLI delivery lanes (shellx-motion render --lane). These are NOT frame rasterizer lanes: --lane does not accept "
      + "browser. To rasterize frames in the browser, keep --lane ffmpeg and pass --frame-lane browser. The Debug API "
      + "has no delivery-lane argument; it takes frameLane on motion.render.final."
  },
  spatialTangentMode: {
    values: SPATIAL_TANGENT_MODE_VALUES,
    description: "Spatial path tangent modes accepted in the spatial object of motion.timeline.spatial.position.upsert."
  },
  permissionTier: {
    values: PERMISSION_TIER_VALUES,
    description: "Motion permission tiers, ordered from least to most privileged."
  }
});

/** Resolve an `enumRef` to its published values, or null when the reference is unknown. */
export function debugArgEnum(reference: string): MotionDebugArgEnum | null {
  return Object.hasOwn(MOTION_DEBUG_ARG_ENUMS, reference) ? MOTION_DEBUG_ARG_ENUMS[reference] : null;
}
