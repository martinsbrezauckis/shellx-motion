/** Core admission, immutable successor preparation, and C2 mutation calculation. */
import * as Core from "@shellx-motion/core";
import type {
  MotionDocument,
  MotionLayoutGapAnimationInspection,
  MotionLayoutGapAnimationMutation,
  MotionPackage,
} from "@shellx-motion/core";
import {
  prepareLayoutGapAnimationContinuation,
} from "./timeline-layout-gap-animation-authority.js";
import type { TimelineLayoutGapAnimationIntent } from "./timeline-layout-gap-animation.js";
import type {
  LayoutGapAnimationMutation,
  TimelineLayoutGapAnimationAuthoringServices,
  TimelineLayoutGapAnimationCore,
} from "./timeline-layout-gap-animation-authoring-types.js";

export async function applyTimelineLayoutGapAnimationIntent(
  pkg: MotionPackage,
  intent: Exclude<TimelineLayoutGapAnimationIntent, { kind: "inspect" }>,
  receiptsRoot: string,
  services: TimelineLayoutGapAnimationAuthoringServices,
): Promise<LayoutGapAnimationMutation> {
  const core = lifecycle(services);
  const before = core.inspectMotionLayoutGapAnimation(pkg.motion);
  const application = intent.kind === "track.upsert"
    ? intent.track
    : requireTrack(before, intent.trackId);

  // This runs before host-root/authority I/O: first attachment must prove both the caller's new
  // binding and the loaded source are safe Core data, not merely a host receipt.
  const admitted = Core.validateMotionLayoutGapAnimationDocument(
    { schema: "shellx-motion/layout-gap-animation@1", tracks: [application] },
    pkg.motion,
  );
  if (!admitted.ok) {
    throw new Error(
      `Layout gap animation application admission failed: ${admitted.issues[0]!.message}`,
    );
  }

  const continuation = await prepareLayoutGapAnimationContinuation({
    receiptsRoot,
    pkg,
    applicationId: application.applicationId,
    applicationFingerprint: application.applicationFingerprint,
  });
  const sourceMotionSha256 = Core.canonicalJsonSha256(pkg.motion);
  const mutation = mutate(core, pkg.motion, intent);
  const persisted = Core.compileMotionDocumentCompositing(mutation.motion);
  const outputMotionSha256 = Core.canonicalJsonSha256(persisted);

  if (Core.canonicalJsonSha256(Core.compileMotionDocumentCompositing(persisted))
    !== outputMotionSha256) {
    throw new Error("Layout gap animation compositing compilation is not idempotent before persistence.");
  }

  return Object.freeze({
    ...mutation,
    motion: persisted,
    sourceMotionSha256,
    outputMotionSha256,
    persistedMotionSha256: Core.hashBuffer(
      Buffer.from(`${JSON.stringify(persisted, null, 2)}\n`, "utf8"),
    ),
    compositingIdempotent: true as const,
    continuation,
  });
}

function mutate(
  core: TimelineLayoutGapAnimationCore,
  motion: MotionDocument,
  intent: Exclude<TimelineLayoutGapAnimationIntent, { kind: "inspect" }>,
): MotionLayoutGapAnimationMutation {
  switch (intent.kind) {
    case "track.upsert":
      return core.upsertMotionLayoutGapAnimationTrack(motion, { track: intent.track });
    case "track.remove":
      return core.removeMotionLayoutGapAnimationTrack(motion, { trackId: intent.trackId });
    case "keyframe.upsert":
      return core.upsertMotionLayoutGapAnimationKeyframe(motion, {
        trackId: intent.trackId,
        keyframe: intent.keyframe,
      });
    case "keyframe.delete":
      return core.deleteMotionLayoutGapAnimationKeyframe(motion, {
        trackId: intent.trackId,
        atUs: intent.atUs,
      });
    case "keyframe.move":
      return core.moveMotionLayoutGapAnimationKeyframe(motion, {
        trackId: intent.trackId,
        fromAtUs: intent.fromAtUs,
        toAtUs: intent.toAtUs,
      });
  }
}

function requireTrack(
  inspection: MotionLayoutGapAnimationInspection,
  trackId: string,
) {
  const track = inspection.store?.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`Layout gap animation track '${trackId}' is absent.`);
  return track;
}

function lifecycle(
  services: TimelineLayoutGapAnimationAuthoringServices,
): TimelineLayoutGapAnimationCore {
  const core = services.layoutGapAnimation
    ?? Core as unknown as TimelineLayoutGapAnimationCore;
  if (typeof core.inspectMotionLayoutGapAnimation !== "function"
    || typeof core.upsertMotionLayoutGapAnimationTrack !== "function"
    || typeof core.removeMotionLayoutGapAnimationTrack !== "function"
    || typeof core.upsertMotionLayoutGapAnimationKeyframe !== "function"
    || typeof core.deleteMotionLayoutGapAnimationKeyframe !== "function"
    || typeof core.moveMotionLayoutGapAnimationKeyframe !== "function") {
    throw new Error("Core layout gap animation lifecycle exports are unavailable.");
  }
  return core;
}
