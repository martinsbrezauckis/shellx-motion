/** Bounded, path-free success and failure evidence for the internal segmented transport. */
import type { FrameSequenceQualityPolicy } from "@shellx-motion/core";
import type { RenderSegmentStoreManifest } from "./render-segment-store-types.js";
import type { RenderSegmentFinalProducerEvidence } from "./render-segment-store-types.js";
import type { StreamingEncodeAttemptOutcome } from "../streaming-foundation-types.js";
import type { ProbeMediaResult } from "../index.js";
import type {
  SegmentedFinalFailureTransportEvidence,
  SegmentedFinalTransportEvidence
} from "./segmented-final-adapter-types.js";
import { segmentIdentity } from "./segmented-final-adapter-store.js";
import { cloneSegmentProducerEvidence } from "./render-segment-producer-evidence.js";

const MAX_WARNINGS = 64;

export function assertSegmentedPolicy(input: {
  quality?: FrameSequenceQualityPolicy;
  qualityManifest?: { exactSourceComparison?: "required" };
  preset?: string;
}): void {
  if (input.preset !== undefined && input.preset !== "mp4-h264" && input.preset !== "webm-vp9-alpha") {
    throw new Error("Segmented final delivery currently supports only mp4-h264 and webm-vp9-alpha.");
  }
  if (input.qualityManifest?.exactSourceComparison === "required") {
    throw new Error("Segmented final delivery does not yet support exact-source quality manifests.");
  }
  if (input.quality?.motion !== undefined) {
    throw new Error("Segmented final delivery refuses requested motion-density policy because resumed prefixes do not persist pixel-plane evidence.");
  }
}

export function segmentedQuality(manifest: RenderSegmentStoreManifest, quality: FrameSequenceQualityPolicy | undefined): {
  warnings: string[];
  frameCount: number;
  blankFrames: number;
  uniqueFrameHashes: number;
  uniqueFrameHashesExact: true;
  motion: { status: "unavailable"; reason: "segment-resume-does-not-persist-pixel-planes" };
} {
  const identity = segmentIdentity(manifest);
  if (identity.frameCount !== manifest.plan.frameCount) throw new Error("Segmented final checkpoints do not cover the complete canonical frame sequence.");
  if (identity.blankFrames === identity.frameCount) throw new Error("Rendered frame sequence is blank or visually empty.");
  const minimumUnique = quality?.minUniqueFrameHashes ?? 0;
  if (!Number.isSafeInteger(minimumUnique) || minimumUnique < 0 || minimumUnique > manifest.plan.frameCount) {
    throw new Error(`Segmented final minUniqueFrameHashes must be a safe integer through ${manifest.plan.frameCount}.`);
  }
  if (identity.uniqueFrameHashes < minimumUnique) {
    throw new Error(`Rendered frame sequence has ${identity.uniqueFrameHashes} unique frames; expected at least ${minimumUnique}.`);
  }
  const warnings: string[] = [];
  const minDuration = quality?.minDurationMs ?? 1_500;
  if (!Number.isFinite(minDuration) || minDuration < 0) throw new Error("Segmented final minDurationMs must be finite and non-negative.");
  if (manifest.timeline.durationMs < minDuration) {
    warnings.push(`Rendered video is ${manifest.timeline.durationMs}ms; product review clips should be at least ${minDuration}ms.`);
  }
  if (identity.uniqueFrameHashes === 1 && identity.frameCount > 1) {
    warnings.push("Rendered frame sequence is static; verify this is intentional before using it as product output.");
  }
  return {
    warnings,
    frameCount: identity.frameCount,
    blankFrames: identity.blankFrames,
    uniqueFrameHashes: identity.uniqueFrameHashes,
    uniqueFrameHashesExact: true,
    motion: { status: "unavailable", reason: "segment-resume-does-not-persist-pixel-planes" }
  };
}

export function transportEvidence(input: {
  manifest: RenderSegmentStoreManifest;
  segments: SegmentedFinalTransportEvidence["segments"];
  verifiedPrefixSegments: number;
  observedMaxConcurrentPngHandoffs: number;
  producer: RenderSegmentFinalProducerEvidence;
  concatListSha256: string;
  attempts: readonly StreamingEncodeAttemptOutcome[];
  quality: ReturnType<typeof segmentedQuality>;
  cleanup?: {
    outcome: "complete" | "retained";
    removedSegmentCount: number;
    missingSegmentCount: number;
    retainedSegmentCount: number;
  };
}): SegmentedFinalTransportEvidence {
  const identity = segmentIdentity(input.manifest);
  const cleanup = input.cleanup ?? {
    outcome: "retained" as const,
    removedSegmentCount: 0,
    missingSegmentCount: 0,
    retainedSegmentCount: input.manifest.completed.length
  };
  return {
    delivery: "resumable-ffv1-segments",
    planFingerprint: input.manifest.planFingerprint,
    frameSequence: identity.frameSequence,
    segments: input.segments.slice(0, 512).map((segment) => ({
      ...segment,
      range: { ...segment.range },
      readback: { ...segment.readback }
    })),
    resume: {
      verifiedPrefixSegments: input.verifiedPrefixSegments,
      newlyCompletedSegments: input.manifest.completed.length - input.verifiedPrefixSegments
    },
    concatListSha256: input.concatListSha256,
    attempts: input.attempts.map(copyAttempt),
  sequential: true,
    ...(input.manifest.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
    maxConcurrentPngHandoffs: 1,
    observedMaxConcurrentPngHandoffs: input.observedMaxConcurrentPngHandoffs,
    producer: cloneSegmentProducerEvidence(input.producer),
    quality: {
      ...input.quality,
      warnings: boundedWarnings(input.quality.warnings),
      motion: { ...input.quality.motion }
    },
    producerWarnings: { coverage: "complete" },
    retention: {
      verifiedSegments: cleanup.retainedSegmentCount === 0
        ? "cleaned"
        : cleanup.removedSegmentCount === 0 ? "retained" : "partially_cleaned",
      cleanup: cleanup.outcome,
      removedSegmentCount: cleanup.removedSegmentCount,
      missingSegmentCount: cleanup.missingSegmentCount,
      retainedSegmentCount: cleanup.retainedSegmentCount
    }
  };
}

/** Records only proven durable checkpoints when final concat delivery does not complete. */
export function failureTransportEvidence(input: {
  manifest: RenderSegmentStoreManifest;
  segments: SegmentedFinalFailureTransportEvidence["segments"];
  verifiedPrefixSegments: number;
  observedMaxConcurrentPngHandoffs: number;
  concat: SegmentedFinalFailureTransportEvidence["concat"];
  attempts: readonly StreamingEncodeAttemptOutcome[];
  stagingCleanup?: SegmentedFinalFailureTransportEvidence["retention"]["stagingCleanup"];
  publication?: SegmentedFinalFailureTransportEvidence["publication"];
}): SegmentedFinalFailureTransportEvidence {
  const identity = segmentIdentity(input.manifest);
  return {
    delivery: "resumable-ffv1-segments",
    planFingerprint: input.manifest.planFingerprint,
    frameSequence: identity.frameSequence,
    segments: input.segments.slice(0, 512).map((segment) => ({
      ...segment,
      range: { ...segment.range },
      readback: { ...segment.readback }
    })),
    resume: {
      verifiedPrefixSegments: input.verifiedPrefixSegments,
      newlyCompletedSegments: input.manifest.completed.length - input.verifiedPrefixSegments
    },
    concat: {
      state: input.concat.state,
      ...(input.concat.sha256 ? { sha256: input.concat.sha256 } : {})
    },
    attempts: input.attempts.map(copyAttempt),
    sequential: true,
    ...(input.manifest.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
    maxConcurrentPngHandoffs: 1,
    observedMaxConcurrentPngHandoffs: input.observedMaxConcurrentPngHandoffs,
    retention: {
      verifiedPrefixSegments: input.verifiedPrefixSegments,
      verifiedSegments: "preserved",
      stagingCleanup: input.stagingCleanup ?? "not_started"
    },
    publication: input.publication ?? "not_published"
  };
}

export function pathFreePartial(value: {
  status: "missing" | "unverified" | "nonconforming" | "available";
  sha256?: string;
  observedMedia?: ProbeMediaResult;
  validationFailure?: string;
}) {
  const { observedMedia, ...rest } = value;
  if (!observedMedia) return rest;
  const { path: _path, ...safeMedia } = observedMedia;
  return { ...rest, observedMedia: safeMedia };
}

function copyAttempt(attempt: StreamingEncodeAttemptOutcome): StreamingEncodeAttemptOutcome {
  return {
    ...attempt,
    ...(attempt.failure
      ? { failure: { ...attempt.failure, ...(attempt.failure.process ? { process: { ...attempt.failure.process } } : {}) } }
      : {})
  };
}

function boundedWarnings(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_WARNINGS).map((value) => value.slice(0, 400));
}
