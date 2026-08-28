/** Strict, internal-only GPU identity and ordered range-evidence checks. */
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import { gpuEnvironmentArenaEvidence } from "../gpu-final-receipt-provenance.js";
import {
  gpuRangeFramePlanSequenceSha256,
  gpuRangeFrameSequenceSha256
} from "./render-segment-store-identity.js";
import {
  RENDER_GPU_SEGMENTED_HOST_VERDICT_SCHEMA,
  RENDER_GPU_SEGMENTED_IDENTITY_SCHEMA,
  RENDER_GPU_SEGMENT_RANGE_PRODUCER_SCHEMA,
  RenderSegmentStoreError,
  type RenderSegmentCheckpoint,
  type RenderSegmentGpuHostVerdict,
  type RenderSegmentGpuIdentity,
  type RenderSegmentGpuStandardIdentity,
  type RenderSegmentGpuRangeProducerEvidence,
  type RenderSegmentRange,
  type RenderSegmentStorePackageFacts,
  type RenderSegmentStoreTimelineFacts
} from "./render-segment-store-types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE = new Set(["path", "override", "shellx-family"]);
const IMMUTABLE_RECEIPT_KEYS = [
  "gpu-pipeline-catalog",
  "gpu-static-plan",
  "gpu-static-plan-document",
  "gpu-static-plan-resources",
  "gpu-static-scene",
  "gpu-static-inputs",
  "gpu-adapter",
  "gpu-runtime",
  "gpu-containment"
] as const;
const RANGE_RECEIPT_KEYS = [
  "gpu-resource-budget",
  "gpu-session-resources",
  "gpu-readback-transport",
  "gpu-frame-sequence",
  "gpu-frame-plan-sequence"
] as const;

/** Reject an absent, partial, or weak GPU closure before a store is ever created. */
export function assertGpuSegmentIdentity(
  value: unknown,
  packageFacts: RenderSegmentStorePackageFacts,
  frameCount: number,
  code: "segment_plan_invalid" | "segment_entry_invalid" = "segment_plan_invalid"
): asserts value is RenderSegmentGpuStandardIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "packageContentSha256", "pipelineCatalogSha256", "staticPlan", "staticScene", "hostVerdict",
    ...("videoStaging" in value ? ["videoStaging"] : [])
  ]) || value.schema !== RENDER_GPU_SEGMENTED_IDENTITY_SCHEMA
    || !sha(value.packageContentSha256) || value.packageContentSha256 !== packageFacts.contentSha256
    || !sha(value.pipelineCatalogSha256)) {
    fail(code, "GPU segmented identity must bind this exact package content and fixed pipeline catalog.");
  }
  assertStaticPlan(value.staticPlan, frameCount, code);
  assertStaticScene(value.staticScene, code);
  assertGpuHostVerdict(value.hostVerdict, code);
  if (value.videoStaging !== undefined && (!isRecord(value.videoStaging)
    || !exactKeys(value.videoStaging, ["ledgerSha256", "pcmSha256"])
    || !sha(value.videoStaging.ledgerSha256) || !sha(value.videoStaging.pcmSha256))) {
    fail(code, "GPU segmented video staging identity must retain exact ledger and PCM hashes.");
  }
}

/** Validate and bind one complete ordered GPU range before its checkpoint can succeed. */
export function assertGpuSegmentRangeProducerEvidence(input: {
  value: unknown;
  identity: Extract<RenderSegmentGpuIdentity, { schema: typeof RENDER_GPU_SEGMENTED_IDENTITY_SCHEMA }>;
  packageFacts: RenderSegmentStorePackageFacts;
  range: RenderSegmentRange;
  timeline: RenderSegmentStoreTimelineFacts;
  frameHashes: readonly string[];
}): asserts input is typeof input & { value: RenderSegmentGpuRangeProducerEvidence } {
  const { value, identity, packageFacts, range, timeline, frameHashes } = input;
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "frameLane", "identity", "frameSequenceSha256", "framePlanSequenceSha256", "framePlanFingerprints",
    "finalReceiptInputHashes", "warningUnion", "warningsOmitted",
    ...(identity.staticPlan.maxEnvironmentCount > 0 ? ["environmentArena"] : [])
  ]) || value.schema !== RENDER_GPU_SEGMENT_RANGE_PRODUCER_SCHEMA || value.frameLane !== "gpu") {
    fail("segment_entry_invalid", "GPU checkpoints require complete GPU range producer evidence.");
  }
  assertGpuSegmentIdentity(value.identity, packageFacts, identity.staticPlan.canonicalFrameCount, "segment_entry_invalid");
  if (canonicalJson(value.identity) !== canonicalJson(identity)) {
    fail("segment_entry_invalid", "GPU range identity conflicts with the immutable GPU segmented render identity.");
  }
  if (!Array.isArray(value.framePlanFingerprints) || value.framePlanFingerprints.length !== range.frameCount
    || value.framePlanFingerprints.some((fingerprint) => !sha(fingerprint))
    || !sha(value.frameSequenceSha256) || !sha(value.framePlanSequenceSha256)
    || value.frameSequenceSha256 !== gpuRangeFrameSequenceSha256({ range, timeline, frameHashes })
    || value.framePlanSequenceSha256 !== gpuRangeFramePlanSequenceSha256({ range, timeline, framePlanFingerprints: value.framePlanFingerprints })) {
    fail("segment_entry_invalid", "GPU range frame or plan sequence evidence does not cover its exact ordered canonical range.");
  }
  assertEnvironmentArena(value.environmentArena, identity, range);
  assertReceiptHashes(value.finalReceiptInputHashes, identity, value.frameSequenceSha256, value.framePlanSequenceSha256);
  const receiptHashes = value.finalReceiptInputHashes as Record<string, string>;
  if (identity.staticPlan.maxEnvironmentCount > 0
    && receiptHashes["gpu-environment-arena"] !== canonicalJsonSha256(value.environmentArena)) {
    fail("segment_entry_invalid", "GPU range environment arena hash does not bind its reconstructed reservation evidence.");
  }
  assertWarnings(value.warningUnion, value.warningsOmitted);
}

function assertStaticPlan(value: unknown, frameCount: number, code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  const maxEnvironmentCount = isRecord(value) ? value.maxEnvironmentCount : undefined;
  const validMaxEnvironmentCount = typeof maxEnvironmentCount === "number" && Number.isSafeInteger(maxEnvironmentCount)
    && maxEnvironmentCount >= 0 && maxEnvironmentCount <= 4;
  if (!isRecord(value) || !exactKeys(value, ["fingerprint", "documentFingerprint", "resourceReferencesSha256", "canonicalFrameCount", "maxEnvironmentCount"])
    || !sha(value.fingerprint) || !sha(value.documentFingerprint) || !sha(value.resourceReferencesSha256)
    || !Number.isSafeInteger(value.canonicalFrameCount) || value.canonicalFrameCount !== frameCount
    || !validMaxEnvironmentCount) {
    fail(code, "GPU segmented static-plan identity is missing or does not match the canonical frame count.");
  }
}

function assertStaticScene(value: unknown, code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  if (!isRecord(value) || !exactKeys(value, ["sha256", "inputHashesSha256"])
    || !sha(value.sha256) || !sha(value.inputHashesSha256)) {
    fail(code, "GPU segmented static-scene identity is invalid.");
  }
}

function assertGpuHostVerdict(value: unknown, code: "segment_plan_invalid" | "segment_entry_invalid"): asserts value is RenderSegmentGpuHostVerdict {
  if (!isRecord(value) || !exactKeys(value, ["schema", "platform", "browser", "launchProfileSha256", "runtimeEvidenceSha256", "adapterFingerprint", "containment", "session"])
    || value.schema !== RENDER_GPU_SEGMENTED_HOST_VERDICT_SCHEMA
    || (value.platform !== "linux" && value.platform !== "darwin" && value.platform !== "win32")
    || !sha(value.launchProfileSha256) || !sha(value.runtimeEvidenceSha256) || !sha(value.adapterFingerprint)
    || !browser(value.browser) || !containment(value.containment) || !hostSession(value.session)) {
    fail(code, "GPU segmented host verdict must bind trusted browser, adapter/runtime, and enforced containment facts.");
  }
}

function hostSession(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["purpose", "emittedFrames", "cleanup"])
    && value.purpose === "pre-store-identity" && value.emittedFrames === 0 && value.cleanup === "complete";
}

function browser(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["source", "executableSha256", "version"])
    && SOURCE.has(value.source as string) && sha(value.executableSha256)
    && typeof value.version === "string" && value.version.trim().length > 0 && value.version.length <= 256;
}

function containment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const maxProcessTreeRssBytes = value.maxProcessTreeRssBytes;
  if (typeof maxProcessTreeRssBytes !== "number" || !Number.isSafeInteger(maxProcessTreeRssBytes)
    || maxProcessTreeRssBytes < 64 * 1024 * 1024 || maxProcessTreeRssBytes > 1024 * 1024 * 1024 * 1024) return false;
  if (value.mode === "unix-process-group") {
    return exactKeys(value, ["mode", "memoryLimit", "maxProcessTreeRssBytes"]) && value.memoryLimit === "rss-monitor";
  }
  const maxActiveProcesses = value.maxActiveProcesses;
  return value.mode === "windows-job-object" && exactKeys(value, ["mode", "memoryLimit", "maxProcessTreeRssBytes", "maxActiveProcesses", "launcherSha256"])
    && value.memoryLimit === "job-commit" && typeof maxActiveProcesses === "number" && Number.isSafeInteger(maxActiveProcesses) && maxActiveProcesses >= 1 && maxActiveProcesses <= 64
    && sha(value.launcherSha256);
}

function assertReceiptHashes(value: unknown, identity: RenderSegmentGpuIdentity, frameSequenceSha256: string, framePlanSequenceSha256: string): void {
  if (!isRecord(value)) fail("segment_entry_invalid", "GPU range receipt input hashes are missing.");
  const expected = {
    "gpu-pipeline-catalog": identity.pipelineCatalogSha256,
    "gpu-static-plan": identity.staticPlan.fingerprint,
    "gpu-static-plan-document": identity.staticPlan.documentFingerprint,
    "gpu-static-plan-resources": identity.staticPlan.resourceReferencesSha256,
    "gpu-static-scene": identity.staticScene.sha256,
    "gpu-static-inputs": identity.staticScene.inputHashesSha256,
    "gpu-adapter": identity.hostVerdict.adapterFingerprint,
    "gpu-runtime": identity.hostVerdict.runtimeEvidenceSha256,
    "gpu-frame-sequence": frameSequenceSha256,
    "gpu-frame-plan-sequence": framePlanSequenceSha256,
    ...(identity.videoStaging ? {
      "gpu-video-staging-ledger": identity.videoStaging.ledgerSha256,
      "gpu-video-pcm": identity.videoStaging.pcmSha256
    } : {})
  };
  const required = [
    ...IMMUTABLE_RECEIPT_KEYS,
    ...RANGE_RECEIPT_KEYS,
    ...(identity.staticPlan.maxEnvironmentCount > 0 ? ["gpu-environment-arena"] : []),
    ...(identity.videoStaging ? ["gpu-video-staging-ledger", "gpu-video-pcm"] : [])
  ];
  if (!exactKeys(value, required) || Object.values(value).some((hash) => !sha(hash))) {
    fail("segment_entry_invalid", "GPU range receipt input hashes must be a complete bounded final-receipt projection.");
  }
  for (const [key, hash] of Object.entries(expected)) {
    if (value[key] !== hash) fail("segment_entry_invalid", `GPU range receipt hash ${key} conflicts with immutable or ordered producer evidence.`);
  }
}

/**
 * The retained arena is derived by the live range producer from its static plan, local budget,
 * and session counters. Reconstruct it here so a checkpoint cannot substitute an arbitrary
 * digest or move evidence from another range before the final ordered ledger is built.
 */
function assertEnvironmentArena(value: unknown, identity: RenderSegmentGpuIdentity, range: RenderSegmentRange): void {
  const authoredEnvironmentCount = identity.staticPlan.maxEnvironmentCount;
  if (authoredEnvironmentCount === 0) {
    if (value !== undefined) fail("segment_entry_invalid", "A no-environment GPU range cannot retain environment arena evidence.");
    return;
  }
  if (!isRecord(value)) fail("segment_entry_invalid", "Environment-bearing GPU ranges require a complete environment arena identity.");
  const resourceBudget = value.resourceBudget;
  const frameArena = value.frameArena;
  const uniforms = value.uniforms;
  if (!isRecord(resourceBudget) || !isRecord(frameArena) || !isRecord(uniforms)
    || typeof value.staticPlanFingerprint !== "string" || value.staticPlanFingerprint !== identity.staticPlan.fingerprint
    || value.canonicalFrameCount !== identity.staticPlan.canonicalFrameCount
    || value.maxEnvironmentCount !== authoredEnvironmentCount
    || !Number.isSafeInteger(value.environmentDrawsRendered)
    || !Number.isSafeInteger(value.environmentEnvelopeReservations)) {
    fail("segment_entry_invalid", "GPU range environment arena evidence conflicts with its immutable static plan.");
  }
  const rebuilt = gpuEnvironmentArenaEvidence({
    staticPlan: {
      fingerprint: identity.staticPlan.fingerprint,
      canonicalFrameCount: identity.staticPlan.canonicalFrameCount,
      maxima: { maxEnvironmentCount: authoredEnvironmentCount }
    },
    resourceBudget: {
      expectedFrames: range.frameCount,
      observedFrames: range.frameCount,
      maxima: {
        environmentCount: resourceBudget.maxEnvironmentDrawsPerFrame as number,
        environmentUniformBytes: resourceBudget.maxEnvironmentUniformBytesPerFrame as number
      }
    },
    sessionResources: {
      environmentUniformCapacitySlots: uniforms.capacitySlots as number,
      environmentUniformBytes: uniforms.bytes as number,
      environmentUniformHighWaterSlots: uniforms.highWaterSlots as number,
      environmentUniformHighWaterBytes: uniforms.highWaterBytes as number,
      environmentUniformLateAllocationRefusals: uniforms.lateAllocationRefusals as number,
      environmentDrawsRendered: value.environmentDrawsRendered as number,
      environmentEnvelopeReservations: value.environmentEnvelopeReservations as number,
      frameArenaReservations: frameArena.reservations as number,
      frameArenaLateAllocationRefusals: frameArena.lateAllocationRefusals as number,
      frameArenaReconfigurations: frameArena.reconfigurations as number,
      frameArenaBytes: frameArena.bytes as number,
      frameArenaHighWaterBytes: frameArena.highWaterBytes as number
    },
    range
  });
  if (!rebuilt || canonicalJson(rebuilt) !== canonicalJson(value)) {
    fail("segment_entry_invalid", "GPU range environment arena evidence is malformed or contradicts its exact reservation relation.");
  }
}

function assertWarnings(warningUnion: unknown, warningsOmitted: unknown): void {
  if (!Array.isArray(warningUnion) || warningUnion.length > 64
    || warningUnion.some((warning) => typeof warning !== "string" || warning.length > 400)
    || !Number.isSafeInteger(warningsOmitted) || (warningsOmitted as number) < 0) {
    fail("segment_entry_invalid", "GPU range producer warnings are invalid.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }

function fail(code: "segment_plan_invalid" | "segment_entry_invalid", message: string): never {
  throw new RenderSegmentStoreError(code, message);
}
