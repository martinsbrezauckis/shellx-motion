import type { DerivedOutputPublication, MotionPackage } from "@shellx-motion/core";
import type {
  RenderSegmentedFinalInput,
  SegmentedFinalOptions,
  SegmentedFinalToolPolicy
} from "./segmented-final.js";
import { resolveSegmentedFinalCliPublication } from "./segmented-final-internal/segmented-final-cli-publication.js";

type SegmentedFinalRequestFields = Pick<RenderSegmentedFinalInput,
  "outputPath" | "preset" | "audioPath" | "audio" | "audioTracks" | "audioMaster"
  | "inputRoots" | "outputRoots" | "quality" | "qualityManifest" | "signal" | "governor"
  | "scratchRoot" | "operation" | "callerId" | "jobId" | "now"> & {
    privateOutputPublication?: DerivedOutputPublication;
  };

export type SegmentedFinalRequestRead =
  | {
      ok: true;
      pkg: MotionPackage;
      frameLane: RenderSegmentedFinalInput["frameLane"];
      segmented: SegmentedFinalOptions;
      toolPolicy: SegmentedFinalToolPolicy | undefined;
      request: SegmentedFinalRequestFields;
    }
  | {
      ok: false;
      code: "segment_checkpoint_invalid" | "segmented_final_unsupported";
      message: string;
    };

/** Read the hostile public request through own data descriptors before any lane preflight. */
export function readSegmentedFinalRequest(input: unknown): SegmentedFinalRequestRead {
  try {
    const requestedSegmented = ownDataField(input, "segmented");
    const segmentFrames = ownDataField(requestedSegmented, "segmentFrames");
    if (!isPositiveSafeInteger(segmentFrames)) {
      return failure("segment_checkpoint_invalid", "segmented.segmentFrames must be a positive safe integer.");
    }
    const segmented = { segmentFrames, ...(ownDataField(requestedSegmented, "resume") === true ? { resume: true } : {}) };
    const requestedPkg = ownDataField(input, "pkg");
    if (malformedLoadedPackage(requestedPkg)) {
      return failure("segment_checkpoint_invalid", "Segmented final delivery requires a complete loaded package and canonical timeline.");
    }
    const requestedFrameLane = ownDataField(input, "frameLane");
    if (requestedFrameLane !== "browser" && requestedFrameLane !== "native" && requestedFrameLane !== "gpu") {
      return failure("segmented_final_unsupported", "Segmented final delivery requires a supported frame lane.");
    }
    const outputPath = ownDataField(input, "outputPath");
    const audioPath = ownDataField(input, "audioPath");
    const scratchRoot = ownDataField(input, "scratchRoot");
    const operation = ownDataField(input, "operation");
    const callerId = ownDataField(input, "callerId");
    const jobId = ownDataField(input, "jobId");
    const now = ownDataField(input, "now");
    const privateOutputPublication = ownDataField(input, "privateOutputPublication");
    const resolvedPrivateOutputPublication = resolveSegmentedFinalCliPublication(privateOutputPublication);
    if (typeof outputPath !== "string" || !outputPath
      || !isOptionalString(audioPath) || !isOptionalString(scratchRoot) || !isOptionalString(operation)
      || !isOptionalString(callerId) || !isOptionalString(jobId)
      || (privateOutputPublication !== undefined && !resolvedPrivateOutputPublication)
      || (now !== undefined && typeof now !== "function")) {
      return failure("segment_checkpoint_invalid", "Segmented final delivery requires a complete typed request.");
    }
    return {
      ok: true,
      pkg: requestedPkg as MotionPackage,
      frameLane: requestedFrameLane,
      segmented,
      toolPolicy: ownDataField(input, "toolPolicy") as SegmentedFinalToolPolicy | undefined,
      request: {
        outputPath,
        preset: ownDataField(input, "preset") as SegmentedFinalRequestFields["preset"],
        audioPath,
        audio: ownDataField(input, "audio") as SegmentedFinalRequestFields["audio"],
        audioTracks: ownDataField(input, "audioTracks") as SegmentedFinalRequestFields["audioTracks"],
        audioMaster: ownDataField(input, "audioMaster") as SegmentedFinalRequestFields["audioMaster"],
        inputRoots: ownDataField(input, "inputRoots") as SegmentedFinalRequestFields["inputRoots"],
        outputRoots: ownDataField(input, "outputRoots") as SegmentedFinalRequestFields["outputRoots"],
        quality: ownDataField(input, "quality") as SegmentedFinalRequestFields["quality"],
        qualityManifest: ownDataField(input, "qualityManifest") as SegmentedFinalRequestFields["qualityManifest"],
        signal: ownDataField(input, "signal") as SegmentedFinalRequestFields["signal"],
        governor: ownDataField(input, "governor") as SegmentedFinalRequestFields["governor"],
        scratchRoot,
        operation,
        callerId,
        jobId,
        now: now as SegmentedFinalRequestFields["now"],
        ...(resolvedPrivateOutputPublication ? { privateOutputPublication: resolvedPrivateOutputPublication } : {})
      }
    };
  } catch {
    return failure("segment_checkpoint_invalid", "Segmented final delivery requires a complete loaded package and canonical timeline.");
  }
}

function failure(
  code: Extract<SegmentedFinalRequestRead, { ok: false }> ["code"],
  message: string
): Extract<SegmentedFinalRequestRead, { ok: false }> {
  return { ok: false, code, message };
}

/** Defend the public runtime boundary before any lane preflight dereferences a nominal package. */
function malformedLoadedPackage(value: unknown): boolean {
  const root = ownDataField(value, "root");
  const manifest = ownDataField(value, "manifest");
  const motion = ownDataField(value, "motion");
  const id = ownDataField(manifest, "id");
  const motionPath = ownDataField(manifest, "motion");
  const durationMs = ownDataField(motion, "durationMs");
  const fps = ownDataField(motion, "fps");
  const width = ownDataField(motion, "width");
  const height = ownDataField(motion, "height");
  const layers = ownDataField(motion, "layers");
  return typeof root !== "string" || !root
    || typeof id !== "string" || !id
    || typeof motionPath !== "string" || !motionPath
    || !isPositiveFiniteNumber(durationMs)
    || !isPositiveFiniteNumber(fps)
    || !isPositiveSafeInteger(width)
    || !isPositiveSafeInteger(height)
    || !Array.isArray(layers);
}

/** Read only own data descriptors at a hostile public boundary; accessors are never invoked. */
function ownDataField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
