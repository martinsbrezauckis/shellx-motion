import {
  MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACKS,
  MOTION_LAYOUT_GAP_ANIMATION_EASINGS,
  MOTION_LAYOUT_GAP_ANIMATION_SCHEMA,
} from "./motion-layout-gap-animation-types";
import { MAX_MOTION_LAYOUT_DIMENSION, MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH } from "./motion-layout-types";

/** Portable document shape; Core separately validates application authority and aggregate work. */
export function buildMotionLayoutGapAnimationDefinitions(): Record<string, unknown> {
  const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" };
  const layoutIdentifier = { type: "string", minLength: 1, maxLength: MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH };
  const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
  return {
    motionLayoutGapAnimation: {
      type: "object", required: ["schema", "tracks"], additionalProperties: false,
      properties: { schema: { const: MOTION_LAYOUT_GAP_ANIMATION_SCHEMA }, tracks: { type: "array", minItems: 1, maxItems: MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACKS, items: { $ref: "#/$defs/motionLayoutGapAnimationTrack" } } },
      $comment: "Runtime binds each track to an existing exact row/column static layout application with fixed ordered direct children, start distribution, no repeater, stale-output checks, transform-authority refusal, and aggregate byte/work caps.",
    },
    motionLayoutGapAnimationTrack: {
      type: "object", required: ["id", "applicationId", "applicationFingerprint", "childLayerIds", "keyframes"], additionalProperties: false,
      properties: { id, applicationId: layoutIdentifier, applicationFingerprint: sha256, childLayerIds: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: layoutIdentifier }, keyframes: { type: "array", minItems: 1, maxItems: MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK, items: { $ref: "#/$defs/motionLayoutGapAnimationKeyframe" } } },
    },
    motionLayoutGapAnimationKeyframe: {
      type: "object", required: ["atUs", "value"], additionalProperties: false,
      properties: { atUs: { type: "integer", minimum: 0, maximum: MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US }, value: { type: "number", minimum: 0, maximum: MAX_MOTION_LAYOUT_DIMENSION }, easing: { enum: [...MOTION_LAYOUT_GAP_ANIMATION_EASINGS] } },
      $comment: "Exact safe-integer microseconds and one non-overshooting C2 easing; endpoint gaps remain non-negative at every sample, the terminal key holds, and the track never becomes an ordinary keyframe target.",
    },
  };
}
