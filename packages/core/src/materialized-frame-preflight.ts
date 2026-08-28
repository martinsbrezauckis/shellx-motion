/**
 * Preflight for final-render paths that materialise an entire image sequence before delivery.
 *
 * This is deliberately a gate for the current implementation, not a claim that final rendering
 * streams frames to FFmpeg. Browser final render currently allocates one request per frame, keeps
 * one result per frame, and the browser session retains a cloned result for every distinct frame.
 * The encoder still starts only after that sequence exists on disk. A future bounded
 * producer-to-encoder handoff must replace that architecture.
 */
import type { MotionDocument } from "./types";
import { MOTION_DOCUMENT_LIMITS, localMotionJobPolicyFromEnvironment, type LocalMotionJobPolicy } from "./job-governor";
import { browserComplexityUpperFactor } from "./materialized-frame-preflight-calibration";
import { inspectMotionTrailBudget } from "./motion-trail-validation";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BROWSER_ADMISSION_FRACTION = 0.8;

/**
 * A real WSL browser-lane observation, retained as a deliberately conservative planning anchor.
 * It is not a portable measurement or a promise that a lower-complexity scene uses less memory.
 */
export const MATERIALIZED_BROWSER_REFERENCE = Object.freeze({
  frameCount: 450,
  width: 1_920,
  height: 1_080,
  environmentLayerCount: 2,
  maxMotionBlurSamples: 3,
  peakProcessTreeRssBytes: Math.round(5.07 * GIB)
});

/**
 * Further browser frame-pass high-watermarks from real 540-frame FHD renders. Together with the
 * base reference they derive a single upper-envelope visible-layer overhead, not magic profile
 * thresholds. The high-complexity CPU/browser case is deliberately conservative until a future
 * renderer architecture has its own acceptance evidence.
 */
export const MATERIALIZED_BROWSER_HIGH_WATERMARKS = Object.freeze([
  Object.freeze({ visibleLayerCount: 4_502, frameCount: 540, width: 1_920, height: 1_080, peakProcessTreeRssBytes: 13_119_938_560 }),
  Object.freeze({ visibleLayerCount: 14_002, frameCount: 540, width: 1_920, height: 1_080, peakProcessTreeRssBytes: 22_317_428_736 })
]);

export interface MaterializedFrameSequencePreflightOptions {
  /**
   * Host-owned policy evidence. This is never accepted from a package, CLI flag or Debug/MCP
   * argument. A supplied ceiling must stay inside the job governor's 64 MiB…1024 GiB bounds;
   * otherwise Core falls back to the existing trusted process policy from the environment.
   */
  jobPolicy?: Pick<LocalMotionJobPolicy, "maxProcessTreeRssBytes">;
  /**
   * An explicit host/operator cap for this materialised sequence. It can only make admission more
   * restrictive than the process RSS ceiling; raising that ceiling remains the existing trusted
   * `SHELLX_MOTION_MAX_JOB_RSS_BYTES` operator decision.
   */
  trustedMemoryBudgetBytes?: number;
  /** Test seam for the existing trusted environment policy. */
  env?: NodeJS.ProcessEnv;
}

export interface MaterializedFrameSequencePreflightInput {
  frameCount: number;
  width: number;
  height: number;
  frameLane: "browser" | "native";
  motion: Pick<MotionDocument, "layers">;
}

export interface MaterializedFrameSequencePreflight {
  schema: "shellx-motion/materialized-frame-preflight@1";
  status: "admitted" | "refused";
  /** The pipeline truth remains visible wherever this evidence is returned or receipted. */
  pipeline: {
    frameSequence: "materialized";
    encoderStreaming: false;
    limitation: "Frames are materialized before delivery; this preflight does not implement bounded producer-to-encoder streaming.";
  };
  frameLane: "browser" | "native";
  staticSafetyCeilings: {
    maxFrames: number;
    maxPixelFrames: number;
    enforced: true;
  };
  sequence: {
    frameCount: number;
    width: number;
    height: number;
    pixelFrames: number;
    uncompressedRgbaBytes: number;
    frameRequestCount: number;
    retainedFrameResultCount: number;
    retainedBrowserFrameCacheEntryCount: number;
  };
  complexity: {
    visibleLayerCount: number;
    visibleEnvironmentLayerCount: number;
    maxMotionBlurSamples: number;
    trail: ReturnType<typeof inspectMotionTrailBudget>;
  };
  budget: {
    processTreeRssCeilingBytes: number;
    admissionBytes: number;
    source: "trusted-host" | "trusted-environment" | "default-job-policy";
    admissionFraction: number;
  };
  estimate: {
    model: "calibrated-browser-rss-upper-envelope@1" | "materialized-frame-storage@1";
    bytes: number;
    /** The browser model starts from a measured high-cost scene and never discounts complexity. */
    conservative: boolean;
    calibration?: {
      frameCount: number;
      width: number;
      height: number;
      peakProcessTreeRssBytes: number;
      /** Observed peak minus the observed sequence's uncompressed RGBA materialisation bytes. */
      fixedProcessAndSessionFloorBytes: number;
      materializedRgbaBytes: number;
      /** Upper-envelope overhead derived from the recorded high-watermark observations. */
      perVisibleLayerOverheadBytes: number;
      observedHighWatermarks: typeof MATERIALIZED_BROWSER_HIGH_WATERMARKS;
      /** Conservative inference applied only above the reference's two environments / three samples. */
      aboveReferenceComplexityUpperFactor: number;
      visibleLayerCount?: number;
      environmentLayerCount?: number;
      maxMotionBlurSamples?: number;
    };
  };
  refusal?: MaterializedFrameSequencePreflightRefusal;
}

export interface MaterializedFrameSequencePreflightRefusal {
  code: "render_static_sequence_limit_exceeded" | "render_resource_preflight_exceeded";
  message: string;
  suggestedAction: string;
}

/**
 * The existing frame and pixel-frame ceilings are hard safety limits, not host-tunable policy.
 * Kept in Core so Debug/MCP/SDK can no longer skip the CLI-only guard.
 */
export function materializedFrameSequenceStaticRefusal(input: Pick<MaterializedFrameSequencePreflightInput, "frameCount" | "width" | "height">): MaterializedFrameSequencePreflightRefusal | undefined {
  if (!Number.isSafeInteger(input.frameCount) || input.frameCount < 1) {
    return {
      code: "render_static_sequence_limit_exceeded",
      message: "Frame sequence size is invalid.",
      suggestedAction: "Use a positive, finite duration and FPS."
    };
  }
  if (input.frameCount > MOTION_DOCUMENT_LIMITS.maxFrames) {
    return {
      code: "render_static_sequence_limit_exceeded",
      message: `Frame sequence requires ${input.frameCount} frames; the local safety limit is ${MOTION_DOCUMENT_LIMITS.maxFrames}. Split the motion or lower its duration/FPS.`,
      suggestedAction: "Split the render into shorter segments or lower duration/FPS; this absolute limit cannot be overridden."
    };
  }
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1) {
    return {
      code: "render_static_sequence_limit_exceeded",
      message: "Frame sequence dimensions are invalid.",
      suggestedAction: "Use positive, finite width and height values."
    };
  }
  const pixelFrames = input.frameCount * input.width * input.height;
  if (!Number.isSafeInteger(pixelFrames) || pixelFrames > MOTION_DOCUMENT_LIMITS.maxPixelFrames) {
    return {
      code: "render_static_sequence_limit_exceeded",
      message: `Frame sequence requires ${pixelFrames} pixel-frames; the local safety limit is ${MOTION_DOCUMENT_LIMITS.maxPixelFrames}. Split the motion or lower its resolution/duration/FPS.`,
      suggestedAction: "Split the render or lower resolution, duration or FPS; this absolute limit cannot be overridden."
    };
  }
  return undefined;
}

/**
 * Resolve and check the resource risk before callers allocate frame-request/result arrays, open a
 * browser session, create an output directory, or begin rasterisation.
 */
export function preflightMaterializedFrameSequence(
  input: MaterializedFrameSequencePreflightInput,
  options: MaterializedFrameSequencePreflightOptions = {}
): MaterializedFrameSequencePreflight {
  const staticRefusal = materializedFrameSequenceStaticRefusal(input);
  const pixelFrames = input.frameCount * input.width * input.height;
  const uncompressedRgbaBytes = safeBytes(pixelFrames, 4);
  const complexity = browserComplexity(input.motion);
  const environment = options.env ?? process.env;
  const environmentPolicy = localMotionJobPolicyFromEnvironment(environment);
  const trustedEnvironmentRssCeiling = trustedEnvironmentRssCeilingBytes(environment);
  const trustedHostRssCeiling = validRssCeiling(options.jobPolicy?.maxProcessTreeRssBytes)
    ? options.jobPolicy?.maxProcessTreeRssBytes
    : undefined;
  const override = options.trustedMemoryBudgetBytes ?? trustedEnvironmentBudget(options.env);
  const processTreeRssCeilingBytes = trustedHostRssCeiling ?? environmentPolicy.maxProcessTreeRssBytes;
  const trustedOverride = validTrustedBudget(override, processTreeRssCeilingBytes) ? override : undefined;
  const admissionBytes = trustedOverride ?? Math.floor(processTreeRssCeilingBytes * BROWSER_ADMISSION_FRACTION);
  const budgetSource: MaterializedFrameSequencePreflight["budget"]["source"] = trustedHostRssCeiling !== undefined
    || (options.trustedMemoryBudgetBytes !== undefined && trustedOverride !== undefined)
    ? "trusted-host"
    : trustedOverride !== undefined || trustedEnvironmentRssCeiling !== undefined
      ? "trusted-environment"
      : "default-job-policy";
  const estimate = input.frameLane === "browser"
    ? calibratedBrowserEstimate(pixelFrames, complexity)
    : { model: "materialized-frame-storage@1" as const, bytes: uncompressedRgbaBytes, conservative: true };

  const refusal = staticRefusal
    ?? (input.frameLane === "browser" && estimate.bytes > admissionBytes
      ? resourceRefusal(estimate.bytes, admissionBytes, processTreeRssCeilingBytes)
      : undefined);

  return {
    schema: "shellx-motion/materialized-frame-preflight@1",
    status: refusal ? "refused" : "admitted",
    pipeline: {
      frameSequence: "materialized",
      encoderStreaming: false,
      limitation: "Frames are materialized before delivery; this preflight does not implement bounded producer-to-encoder streaming."
    },
    frameLane: input.frameLane,
    staticSafetyCeilings: {
      maxFrames: MOTION_DOCUMENT_LIMITS.maxFrames,
      maxPixelFrames: MOTION_DOCUMENT_LIMITS.maxPixelFrames,
      enforced: true
    },
    sequence: {
      frameCount: input.frameCount,
      width: input.width,
      height: input.height,
      pixelFrames,
      uncompressedRgbaBytes,
      // Source-backed retention cardinality: browser allocates these before delivery; native loops.
      frameRequestCount: input.frameLane === "browser" ? input.frameCount : 0,
      retainedFrameResultCount: input.frameLane === "browser" ? input.frameCount : 0,
      retainedBrowserFrameCacheEntryCount: input.frameLane === "browser" ? input.frameCount : 0
    },
    complexity,
    budget: {
      processTreeRssCeilingBytes,
      admissionBytes,
      source: budgetSource,
      admissionFraction: trustedOverride === undefined ? BROWSER_ADMISSION_FRACTION : admissionBytes / processTreeRssCeilingBytes
    },
    estimate,
    ...(refusal ? { refusal } : {})
  };
}

function browserComplexity(motion: Pick<MotionDocument, "layers">): MaterializedFrameSequencePreflight["complexity"] {
  const visible = motion.layers.filter((layer) => layer.visible !== false);
  const visibleEnvironmentLayerCount = visible.filter((layer) => layer.type === "environment").length;
  const maxMotionBlurSamples = visible.reduce((maximum, layer) => Math.max(maximum, layer.effects?.motionBlur?.samples ?? 1), 1);
  return { visibleLayerCount: visible.length, visibleEnvironmentLayerCount, maxMotionBlurSamples, trail: inspectMotionTrailBudget(visible) };
}

function calibratedBrowserEstimate(pixelFrames: number, complexity: MaterializedFrameSequencePreflight["complexity"]): MaterializedFrameSequencePreflight["estimate"] {
  const reference = MATERIALIZED_BROWSER_REFERENCE;
  const referenceMaterializedRgbaBytes = safeBytes(reference.frameCount * reference.width * reference.height, 4);
  // A pure pixel-frame scale would falsely send short renders toward zero RSS. Preserve the
  // measured process/session floor, then add the current sequence's materialised RGBA cost. The
  // base reference remains exact at its own dimensions. The high-watermark envelope applies from
  // every visible layer beyond the reference scene, so adjoining counts cannot jump across a
  // magic profile boundary.
  const fixedProcessAndSessionFloorBytes = Math.max(0, reference.peakProcessTreeRssBytes - referenceMaterializedRgbaBytes);
  const materializedRgbaBytes = safeBytes(pixelFrames, 4);
  const referenceVisibleLayerCount = reference.environmentLayerCount;
  const perVisibleLayerOverheadBytes = Math.max(...MATERIALIZED_BROWSER_HIGH_WATERMARKS.map((observation) => {
    const observationRgbaBytes = safeBytes(observation.frameCount * observation.width * observation.height, 4);
    const additionalLayers = Math.max(1, observation.visibleLayerCount - referenceVisibleLayerCount);
    return Math.ceil(Math.max(0, observation.peakProcessTreeRssBytes - fixedProcessAndSessionFloorBytes - observationRgbaBytes) / additionalLayers);
  }));
  const additionalLayers = Math.max(0, complexity.visibleLayerCount - referenceVisibleLayerCount);
  const aboveReferenceComplexityUpperFactor = browserComplexityUpperFactor(reference, complexity);
  const unadjustedBytes = safeAdd(
    safeAdd(fixedProcessAndSessionFloorBytes, materializedRgbaBytes),
    safeBytes(additionalLayers, perVisibleLayerOverheadBytes)
  );
  return {
    model: "calibrated-browser-rss-upper-envelope@1",
    bytes: safeScale(unadjustedBytes, aboveReferenceComplexityUpperFactor),
    conservative: true,
    calibration: {
      ...reference,
      fixedProcessAndSessionFloorBytes,
      materializedRgbaBytes: referenceMaterializedRgbaBytes,
      perVisibleLayerOverheadBytes,
      observedHighWatermarks: MATERIALIZED_BROWSER_HIGH_WATERMARKS,
      aboveReferenceComplexityUpperFactor
    }
  };
}

function resourceRefusal(estimateBytes: number, admissionBytes: number, processTreeRssCeilingBytes: number): MaterializedFrameSequencePreflightRefusal {
  return {
    code: "render_resource_preflight_exceeded",
    message: `Materialized browser frame sequence is conservatively estimated at ${formatBytes(estimateBytes)}; the resolved admission budget is ${formatBytes(admissionBytes)} (from a ${formatBytes(processTreeRssCeilingBytes)} process-tree RSS ceiling).`,
    suggestedAction: "Split the render into shorter segments, then lower resolution/FPS or reduce environment and motion-blur complexity. A trusted host operator may deliberately adjust SHELLX_MOTION_MAX_JOB_RSS_BYTES or SHELLX_MOTION_MAX_MATERIALIZED_SEQUENCE_BYTES. This path still materializes frames; it is not bounded producer-to-encoder streaming."
  };
}

function trustedEnvironmentBudget(env: NodeJS.ProcessEnv | undefined): number | undefined {
  const raw = (env ?? process.env).SHELLX_MOTION_MAX_MATERIALIZED_SEQUENCE_BYTES;
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function trustedEnvironmentRssCeilingBytes(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SHELLX_MOTION_MAX_JOB_RSS_BYTES;
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return validRssCeiling(value) ? value : undefined;
}

function validTrustedBudget(value: number | undefined, ceiling: number): value is number {
  return Boolean(value && Number.isSafeInteger(value) && value >= 64 * MIB && value <= ceiling);
}

function validRssCeiling(value: number | undefined): value is number {
  return Boolean(value && Number.isSafeInteger(value) && value >= 64 * MIB && value <= 1024 * GIB);
}

function safeBytes(value: number, multiplier = 1): number {
  const bytes = value * multiplier;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : Number.MAX_SAFE_INTEGER;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : Number.MAX_SAFE_INTEGER;
}

function safeScale(value: number, factor: number): number {
  const scaled = Math.ceil(value * factor);
  return Number.isSafeInteger(scaled) && scaled >= 0 ? scaled : Number.MAX_SAFE_INTEGER;
}

function formatBytes(bytes: number): string {
  return `${Number((bytes / GIB).toFixed(2))} GiB`;
}
