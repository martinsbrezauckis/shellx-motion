/** Pure/internal assembly helpers for the admitted segmented-final executor. */
import { canonicalJsonSha256, hashFile, type LocalMotionJobContext } from "@shellx-motion/core";
import { basename } from "node:path";
import { buildSegmentConcatFinalCommand } from "./lossless-segment-concat-command.js";
import {
  RENDER_SEGMENT_DELIVERY_SCHEMA,
  type RenderSegmentStoreDeliveryFacts,
  type RenderSegmentStoreManifest
} from "./render-segment-store-types.js";
import type {
  PreparedStreamingFinalEncodePolicy,
  StreamingFinalPolicyAttempt
} from "../streaming-final-encode-policy-types.js";
import type { StreamingEvidenceReporter } from "../streaming-foundation-helpers.js";
import type { StreamingFfmpegProcessFactory } from "../streaming-process.js";
import { failureTransportEvidence } from "./segmented-final-adapter-evidence.js";
import type { SegmentedFinalPaths } from "./segmented-final-adapter-store.js";
import type {
  RenderSegmentedFinalInput,
  SegmentedFinalFailureTransportEvidence,
  SegmentedFinalSegmentEvidence
} from "./segmented-final-adapter-types.js";
import type { FfmpegCommand, FfmpegRunner } from "../index.js";
import type { PreparedSegmentedGpuHost } from "../segmented-final-gpu-host-types.js";

export interface VerifiedTransportState {
  manifest: RenderSegmentStoreManifest;
  segments: SegmentedFinalSegmentEvidence[];
  verifiedPrefixSegments: number;
  observedMaxConcurrentPngHandoffs: number;
}

export function segmentedPolicyInput(
  input: RenderSegmentedFinalInput,
  paths: SegmentedFinalPaths,
  gpuHost?: PreparedSegmentedGpuHost
) {
  return {
    fps: input.timeline.fps,
    width: input.timeline.width,
    height: input.timeline.height,
    ...(input.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
    durationMs: input.timeline.durationMs,
    outputPath: paths.stagingPath,
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.audioPath ? { audioPath: input.audioPath } : {}),
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
    ...(input.audioMaster ? { audioMaster: input.audioMaster } : {}),
    inputRoots: [paths.storeRoot, ...(input.inputRoots ?? [])],
    outputRoots: [paths.storeRoot, ...(input.outputRoots ?? [])],
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
    ...(input.forceSoftwareEncode !== undefined
      ? { forceSoftwareEncode: input.forceSoftwareEncode }
      : {}),
    ...(input.verifyDeliveredColor !== undefined
      ? { verifyDeliveredColor: input.verifyDeliveredColor }
      : {}),
    ...(input.cache ? { cache: input.cache } : {}),
    ...(input.ffmpegVersion !== undefined ? { ffmpegVersion: input.ffmpegVersion } : {}),
    ...(input.ffprobeVersion !== undefined ? { ffprobeVersion: input.ffprobeVersion } : {}),
    ...(gpuHost?.finalAudioSnapshotStaging ? { finalAudioSnapshotStaging: gpuHost.finalAudioSnapshotStaging } : {}),
    // Only the durable checkpoint transport supplies the full bounded plan hash capacity.
    qualityCapability: { uniqueFrameHashCapacity: input.plan.frameCount }
  };
}

export async function segmentedDeliveryFacts(
  input: RenderSegmentedFinalInput,
  outputPath: string,
  prepared: PreparedStreamingFinalEncodePolicy
): Promise<RenderSegmentStoreDeliveryFacts> {
  const minDurationMs = input.quality?.minDurationMs ?? 1_500;
  const minUniqueFrameHashes = input.quality?.minUniqueFrameHashes ?? 0;
  if (
    !Number.isFinite(minDurationMs)
    || minDurationMs < 0
    || !Number.isSafeInteger(minUniqueFrameHashes)
    || minUniqueFrameHashes < 0
    || minUniqueFrameHashes > input.plan.frameCount
  ) {
    throw new Error("Segmented final quality request is outside the complete segment-hash budget.");
  }
  const audio = await Promise.all(prepared.audioInputs.map(async ({ path, ...controls }) => ({
    contentSha256: await hashFile(path),
    controlsSha256: canonicalJsonSha256(controls)
  })));
  return {
    schema: RENDER_SEGMENT_DELIVERY_SCHEMA,
    outputPathSha256: canonicalJsonSha256({ outputPath }),
    preset: prepared.preset.preset as "mp4-h264" | "webm-vp9-alpha",
    audio,
    quality: { minDurationMs, minUniqueFrameHashes },
    forceSoftwareEncode: prepared.forceSoftwareEncode,
    verifyDeliveredColor: input.verifyDeliveredColor !== false
  };
}

export function transformSegmentedAttempts(
  prepared: PreparedStreamingFinalEncodePolicy,
  preset: "mp4-h264" | "webm-vp9-alpha",
  paths: SegmentedFinalPaths,
  manifest: RenderSegmentStoreManifest,
  frameCount: number
): { attempts: StreamingFinalPolicyAttempt[]; contents: string } {
  let contents = "";
  const segmentFilenames = manifest.completed.map((entry) => entry.artifact.path.replace(/^segments\//, ""));
  const attempts = prepared.plannedAttempts.map((attempt) => {
    const plan = buildSegmentConcatFinalCommand({
      canonicalCommand: attempt.command,
      preset,
      segmentDirectory: paths.segmentsDirectory,
      concatListPath: paths.concatListPath,
      segmentFilenames,
      frameCount
    });
    if (contents && contents !== plan.concatList.contents) {
      throw new Error("Prepared concat attempts disagree about their canonical segment list.");
    }
    contents = plan.concatList.contents;
    return { ...attempt, command: plan.command };
  });
  if (!contents || attempts.length === 0) {
    throw new Error("Segmented final policy produced no concat attempt.");
  }
  return { attempts, contents };
}

export function preAdmittedRunner(
  job: LocalMotionJobContext,
  factory: StreamingFfmpegProcessFactory,
  reporter: StreamingEvidenceReporter
): FfmpegRunner {
  return async (command: FfmpegCommand) => {
    const process = await factory({
      command,
      signal: job.signal,
      watchProcess: job.watchProcess,
      reportProcessContainment: reporter.reportProcessContainment
    });
    return await process.end();
  };
}

export function segmentedFailureTransport(
  verified: VerifiedTransportState | undefined,
  details: {
    concat: SegmentedFinalFailureTransportEvidence["concat"];
    attempts: SegmentedFinalFailureTransportEvidence["attempts"];
    stagingCleanup: SegmentedFinalFailureTransportEvidence["retention"]["stagingCleanup"];
    publication: SegmentedFinalFailureTransportEvidence["publication"];
  }
): SegmentedFinalFailureTransportEvidence | undefined {
  if (!verified) return undefined;
  return failureTransportEvidence({
    manifest: verified.manifest,
    segments: verified.segments,
    verifiedPrefixSegments: verified.verifiedPrefixSegments,
    observedMaxConcurrentPngHandoffs: verified.observedMaxConcurrentPngHandoffs,
    concat: details.concat,
    attempts: details.attempts,
    stagingCleanup: details.stagingCleanup,
    publication: details.publication
  });
}

export function segmentedResumeRecovery(paths: SegmentedFinalPaths) {
  return {
    stagingBasename: basename(paths.stagingPath),
    concatListBasename: "segments.ffconcat" as const,
    concatTempBasename: ".segments.ffconcat.partial" as const
  };
}

export type { SegmentedFinalPaths } from "./segmented-final-adapter-store.js";
