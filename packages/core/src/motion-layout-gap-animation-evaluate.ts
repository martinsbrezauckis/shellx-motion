import { canonicalJsonSha256 } from "./canonical-json";
import { layoutGapAnimationTrackBinding, projectMotionLayoutGapAnimationTrack, readMotionLayoutGapAnimationDocumentRoot } from "./motion-layout-gap-animation-document";
import { MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US, MOTION_LAYOUT_GAP_ANIMATION_FRAME_SCHEMA, type MotionLayoutGapAnimationFrame } from "./motion-layout-gap-animation-types";
import { resolveEasing } from "./timeline";
import type { MotionDocument } from "./types";

/** Pure exact-microsecond sampling. It computes no ordinary keyframe target and mutates no layout. */
export function evaluateMotionLayoutGapAnimation(motion: MotionDocument, atUs: number): MotionLayoutGapAnimationFrame | undefined {
  if (typeof atUs !== "number" || !Number.isSafeInteger(atUs) || atUs < 0 || atUs > MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US) throw new Error(`Layout gap animation atUs must be a safe integer in 0..${MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US} microseconds.`);
  const root = readMotionLayoutGapAnimationDocumentRoot(optionalRoot(motion), motion);
  if (!root) return undefined;
  const tracks = root.tracks.map((track) => {
    const binding = layoutGapAnimationTrackBinding(motion, track);
    const gap = sample(track.keyframes, binding.staticGap, atUs);
    return Object.freeze({ ...binding, id: track.id, gap, projection: projectMotionLayoutGapAnimationTrack(motion, track, gap) });
  });
  const payload = { schema: MOTION_LAYOUT_GAP_ANIMATION_FRAME_SCHEMA, atUs, tracks: Object.freeze(tracks) } as const;
  return deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function sample(keyframes: readonly { atUs: number; value: number; easing?: import("./motion-layout-gap-animation-types").MotionLayoutGapAnimationEasing }[], base: number, atUs: number): number {
  const first = keyframes[0]!, last = keyframes.at(-1)!;
  if (atUs < first.atUs) return base;
  if (atUs >= last.atUs) return last.value;
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const left = keyframes[index]!, right = keyframes[index + 1]!;
    if (atUs < left.atUs || atUs > right.atUs) continue;
    const progress = resolveEasing(left.easing)((atUs - left.atUs) / (right.atUs - left.atUs));
    if (!Number.isFinite(progress)) throw new Error(`Layout gap animation keyframe easing produced a non-finite value for track '${index}'.`);
    const gap = left.value + ((right.value - left.value) * progress);
    if (gap < 0) throw new Error(`Layout gap animation easing produced a negative gap for track '${index}'.`);
    return gap;
  }
  throw new Error("Layout gap animation has no active keyframe segment.");
}
function optionalRoot(motion: MotionDocument): unknown { const descriptor = Object.getOwnPropertyDescriptor(motion, "layoutGapAnimation"); if (!descriptor) return undefined; if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("Motion document.layoutGapAnimation must be an enumerable data field."); return descriptor.value; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
