/** Finalize, no-clobber publish, and post-publication cleanup inside the existing admission. */
import { LocalMotionJobError } from "@shellx-motion/core";
import { finalizeStreamingFinalEncodePolicy } from "../streaming-final-encode-policy-stages.js";
import type { PreparedStreamingFinalEncodePolicy } from "../streaming-final-encode-policy-types.js";
import { pathFreePartial, segmentedQuality, transportEvidence } from "./segmented-final-adapter-evidence.js";
import { admittedFailure } from "./segmented-final-adapter-failure.js";
import type { SegmentedConcatAttemptsResult } from "./segmented-final-adapter-concat.js";
import {
  cleanupPublishedStore,
  partialOutput,
  publishStagedFile,
  removeUnpublishedStage,
  segmentIdentity,
  stageStagedFileForPairedPublication,
  SegmentedPublicationIdentityError,
  type SegmentedFinalPaths
} from "./segmented-final-adapter-store.js";
import { SegmentedFinalStoreAuthority } from "./segmented-final-store-authority.js";
import type { RenderSegmentFinalProducerEvidence, RenderSegmentStoreManifest } from "./render-segment-store-types.js";
import type { StreamingFinalPolicyAttempt } from "../streaming-final-encode-policy-types.js";
import type {
  SegmentedFinalFailureEvidence,
  SegmentedFinalFailureTransportEvidence,
  SegmentedFinalSegmentEvidence
} from "./segmented-final-adapter-types.js";
import type { SegmentedFinalAdmittedValue } from "./segmented-final-adapter-executor.js";
import type { FfmpegProcessResult, FfmpegRunner } from "../index.js";

export async function finishSegmentedFinalDelivery(input: {
  prepared: PreparedStreamingFinalEncodePolicy;
  transformed: { attempts: StreamingFinalPolicyAttempt[] };
  concat: SegmentedConcatAttemptsResult & { output: FfmpegProcessResult };
  paths: SegmentedFinalPaths;
  authority: SegmentedFinalStoreAuthority;
  manifest: RenderSegmentStoreManifest;
  segments: SegmentedFinalSegmentEvidence[];
  verifiedPrefixSegments: number;
  observedMaxConcurrentPngHandoffs: number;
  producer: RenderSegmentFinalProducerEvidence;
  concatListSha256: string;
  quality: ReturnType<typeof segmentedQuality>;
  runner: FfmpegRunner;
  updatePhase: (phase: SegmentedFinalFailureEvidence["phase"]) => void;
  provisionalFailure: () => SegmentedFinalFailureTransportEvidence | undefined;
  setStagingCleanup: (
    value: SegmentedFinalFailureTransportEvidence["retention"]["stagingCleanup"]
  ) => void;
  setPublication: (value: SegmentedFinalFailureTransportEvidence["publication"]) => void;
  recordLocalFailure: (details: {
    phase: "finalize" | "publish";
    partialOutput: SegmentedFinalFailureEvidence["partialOutput"];
    cleanupCauses: readonly unknown[];
  }) => void;
  privateOutputPublication?: import("@shellx-motion/core").DerivedOutputPublication;
}): Promise<SegmentedFinalAdmittedValue> {
  input.updatePhase("finalize");
  let finalized: Awaited<ReturnType<typeof finalizeStreamingFinalEncodePolicy>>;
  try {
    await input.authority.assertCurrent();
    finalized = await finalizeStreamingFinalEncodePolicy({
      prepared: { ...input.prepared, plannedAttempts: input.transformed.attempts },
      runner: input.runner,
      execution: {
        command: input.transformed.attempts[input.concat.attempts.length - 1].command,
        output: input.concat.output,
        attempts: input.concat.attempts
      },
      frameSequence: {
        sha256: segmentIdentity(input.manifest).frameSequence.sha256,
        quality: {
          warnings: input.quality.warnings,
          frameCount: input.quality.frameCount,
          blankFrames: input.quality.blankFrames,
          uniqueFrameHashes: input.quality.uniqueFrameHashes,
          uniqueFrameHashesExact: true
        }
      }
    });
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      const partial = await partialOutput(input.paths.stagingPath);
      const cleanup = await removeUnpublishedStage(input.paths.stagingPath);
      input.setStagingCleanup(cleanup.outcome);
      input.recordLocalFailure({
        phase: "finalize",
        partialOutput: partial,
        cleanupCauses: cleanup.cause === undefined ? [] : [cleanup.cause]
      });
    }
    throw error;
  }
  if (!finalized.ok) {
    const partial = finalized.error.partialOutput
      ? pathFreePartial(finalized.error.partialOutput)
      : await partialOutput(input.paths.stagingPath);
    const cleanup = await removeUnpublishedStage(input.paths.stagingPath);
    input.setStagingCleanup(cleanup.outcome);
    return {
      ok: false,
      failure: admittedFailure(
        finalized.error.code,
        "finalize",
        finalized.error,
        cleanup.cause === undefined ? [] : [cleanup.cause],
        input.provisionalFailure(),
        partial
      )
    };
  }

  input.updatePhase("publish");
  try {
    if (input.privateOutputPublication) {
      await stageStagedFileForPairedPublication(input.paths, input.authority, input.privateOutputPublication, finalized.receiptEvidence.output.sha256);
    } else {
      await publishStagedFile(input.paths, input.authority, finalized.receiptEvidence.output.sha256);
    }
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      const partial = await partialOutput(input.paths.stagingPath);
      const cleanup = await removeUnpublishedStage(input.paths.stagingPath);
      input.setStagingCleanup(cleanup.outcome);
      input.recordLocalFailure({
        phase: "publish",
        partialOutput: partial,
        cleanupCauses: cleanup.cause === undefined ? [] : [cleanup.cause]
      });
      throw error;
    }
    if (error instanceof SegmentedPublicationIdentityError) {
      input.setPublication("destination_created_identity_unverified");
      return {
        ok: false,
        failure: admittedFailure(
          "segmented_final_publication_identity_unverified",
          "publish",
          error,
          [],
          input.provisionalFailure(),
          { status: "unverified" },
          "destination_created_identity_unverified"
        )
      };
    }
    const partial = await partialOutput(input.paths.stagingPath);
    const cleanup = await removeUnpublishedStage(input.paths.stagingPath);
    input.setStagingCleanup(cleanup.outcome);
    return {
      ok: false,
      failure: admittedFailure(
        "segmented_final_publish_failed",
        "publish",
        error,
        cleanup.cause === undefined ? [] : [cleanup.cause],
        input.provisionalFailure(),
        partial
      )
    };
  }

  const cleanup = await cleanupPublishedStore(input.paths, input.manifest);
  const transport = transportEvidence({
    manifest: input.manifest,
    segments: input.segments,
    verifiedPrefixSegments: input.verifiedPrefixSegments,
    observedMaxConcurrentPngHandoffs: input.observedMaxConcurrentPngHandoffs,
    producer: input.producer,
    concatListSha256: input.concatListSha256,
    attempts: input.concat.attempts,
    quality: input.quality,
    cleanup
  });
  return {
    ok: true,
    transport,
    receiptEvidence: {
      ...finalized.receiptEvidence,
      output: { ...finalized.receiptEvidence.output, path: input.paths.outputPath },
      artifacts: [{ ...finalized.receiptEvidence.artifacts[0], path: input.paths.outputPath }],
      warnings: [
        ...finalized.receiptEvidence.warnings,
        ...(cleanup.outcome === "retained" && !input.privateOutputPublication
          ? ["Verified final was published; internal segment cleanup was retained."]
          : cleanup.outcome === "retained"
            ? ["Verified final was staged for receipt-first CLI publication; internal segment cleanup was retained."]
          : [])
      ]
    }
  };
}
