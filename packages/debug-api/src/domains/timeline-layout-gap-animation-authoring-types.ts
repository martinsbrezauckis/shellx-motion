import type {
  MotionDocument,
  MotionLayoutGapAnimationInspection,
  MotionLayoutGapAnimationMutation,
} from "@shellx-motion/core";
import type { ImmutableJsonPairCommitHooks } from "./timeline-layout-application-authority-store.js";
import type { LayoutGapAnimationContinuation } from "./timeline-layout-gap-animation-authority.js";
import type { TimelinePackageEditServices } from "./timeline-package-edit.js";

export type LayoutGapAnimationMutation = MotionLayoutGapAnimationMutation & {
  sourceMotionSha256: string;
  outputMotionSha256: string;
  persistedMotionSha256: string;
  compositingIdempotent: true;
  continuation: LayoutGapAnimationContinuation;
};

export interface TimelineLayoutGapAnimationCore {
  inspectMotionLayoutGapAnimation(
    motion: MotionDocument,
  ): MotionLayoutGapAnimationInspection;
  upsertMotionLayoutGapAnimationTrack(
    motion: MotionDocument,
    input: unknown,
  ): MotionLayoutGapAnimationMutation;
  removeMotionLayoutGapAnimationTrack(
    motion: MotionDocument,
    input: unknown,
  ): MotionLayoutGapAnimationMutation;
  upsertMotionLayoutGapAnimationKeyframe(
    motion: MotionDocument,
    input: unknown,
  ): MotionLayoutGapAnimationMutation;
  deleteMotionLayoutGapAnimationKeyframe(
    motion: MotionDocument,
    input: unknown,
  ): MotionLayoutGapAnimationMutation;
  moveMotionLayoutGapAnimationKeyframe(
    motion: MotionDocument,
    input: unknown,
  ): MotionLayoutGapAnimationMutation;
}

export interface TimelineLayoutGapAnimationAuthoringServices
  extends TimelinePackageEditServices {
  layoutGapAnimation?: TimelineLayoutGapAnimationCore;
  /** Test-only deterministic host-pair fault injection; never read from command arguments. */
  layoutGapAuthorityPairHooks?: ImmutableJsonPairCommitHooks;
}
