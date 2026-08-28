import { canonicalJson, canonicalJsonSha256, gpuSceneBehaviorFrameEvidenceSequences, type GpuSceneBehaviorFrameEvidenceFact } from "@shellx-motion/core";
import {
  assertGpuSegmentIdentity,
  assertGpuSegmentRangeProducerEvidence
} from "./render-segment-gpu-evidence.js";
import {
  RENDER_GPU_BEHAVIOR_SEGMENTED_IDENTITY_SCHEMA,
  MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES,
  RENDER_GPU_BEHAVIOR_SEGMENT_RANGE_PRODUCER_SCHEMA,
  renderSegmentGpuBehaviorRangeIdentity,
  type RenderSegmentGpuBehaviorIdentity,
  type RenderSegmentGpuBehaviorRangeProducerEvidence
} from "./render-segment-gpu-behavior-types.js";
import type {
  RenderSegmentGpuStandardIdentity,
  RenderSegmentRange,
  RenderSegmentStorePackageFacts,
  RenderSegmentStoreTimelineFacts
} from "./render-segment-store-types.js";
import { RenderSegmentStoreError } from "./render-segment-store-types.js";

const SHA256 = /^[a-f0-9]{64}$/;

export function assertGpuBehaviorSegmentIdentity(value: unknown, packageFacts: RenderSegmentStorePackageFacts, frameCount: number, code: "segment_plan_invalid" | "segment_entry_invalid" = "segment_plan_invalid"): asserts value is RenderSegmentGpuBehaviorIdentity {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES) {
    fail(code, `Behavior GPU segmented identity cannot retain more than ${MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES} Core frame facts.`);
  }
  if (!record(value) || !exactKeys(value, ["schema", "packageContentSha256", "pipelineCatalogSha256", "staticPlan", "staticScene", "hostVerdict", "behaviors", ...("videoStaging" in value ? ["videoStaging"] : [])])
    || value.schema !== RENDER_GPU_BEHAVIOR_SEGMENTED_IDENTITY_SCHEMA) {
    fail(code, "Behavior GPU segmented identity has an unknown, missing, or legacy wire field.");
  }
  const { behaviors, ...legacy } = value;
  assertGpuSegmentIdentity({ ...legacy, schema: "shellx-motion/gpu-segmented-identity@1" }, packageFacts, frameCount, code);
  assertBehaviorIdentity(behaviors, frameCount, code);
}

export function assertGpuBehaviorSegmentRangeProducerEvidence(input: {
  value: unknown;
  identity: RenderSegmentGpuBehaviorIdentity;
  packageFacts: RenderSegmentStorePackageFacts;
  range: RenderSegmentRange;
  timeline: RenderSegmentStoreTimelineFacts;
  frameHashes: readonly string[];
}): asserts input is typeof input & { value: RenderSegmentGpuBehaviorRangeProducerEvidence } {
  const { value, identity, packageFacts, range, timeline, frameHashes } = input;
  if (!record(value) || !exactKeys(value, ["schema", "frameLane", "identity", "frameSequenceSha256", "framePlanSequenceSha256", "framePlanFingerprints", "behaviors", "finalReceiptInputHashes", "warningUnion", "warningsOmitted", ...(identity.staticPlan.maxEnvironmentCount > 0 ? ["environmentArena"] : [])])
    || value.schema !== RENDER_GPU_BEHAVIOR_SEGMENT_RANGE_PRODUCER_SCHEMA || value.frameLane !== "gpu") {
    fail("segment_entry_invalid", "Behavior GPU checkpoints require their exact distinct range-evidence schema.");
  }
  assertGpuBehaviorSegmentIdentity(identity, packageFacts, identity.staticPlan.canonicalFrameCount, "segment_entry_invalid");
  if (canonicalJson(value.identity) !== canonicalJson(renderSegmentGpuBehaviorRangeIdentity(identity))) fail("segment_entry_invalid", "Behavior GPU range identity conflicts with immutable behavior admission.");
  const { behaviors, ...legacy } = value;
  const { "gpu-behavior-static-plan": _staticPlan, "gpu-behavior-base-static-plan": _baseStaticPlan, "gpu-behavior-static": _behaviorStatic, "gpu-behavior-source": _source, "gpu-behavior-frame-plan-sequence": _framePlans, "gpu-behavior-frame-budget-sequence": _frameBudgets, ...legacyHashes } = legacy.finalReceiptInputHashes;
  assertGpuSegmentRangeProducerEvidence({
    value: { ...legacy, schema: "shellx-motion/gpu-segment-range-producer@1", identity: legacyIdentity(identity), finalReceiptInputHashes: legacyHashes },
    identity: legacyIdentity(identity), packageFacts, range, timeline, frameHashes
  });
  if (!record(behaviors) || !exactKeys(behaviors, ["frames", "framePlanSequenceSha256", "frameBudgetSequenceSha256"])
    || !sha(behaviors.framePlanSequenceSha256) || !sha(behaviors.frameBudgetSequenceSha256)) {
    fail("segment_entry_invalid", "Behavior GPU range must bind complete ordered behavior frame identities and budgets.");
  }
  const expectedFrames = identity.behaviors.frames.slice(range.startFrame, range.endFrameExclusive);
  if (!Array.isArray(behaviors.frames) || canonicalJson(behaviors.frames) !== canonicalJson(expectedFrames)) {
    fail("segment_entry_invalid", "Behavior GPU range frames do not equal the immutable Core schedule slice for this canonical range.");
  }
  const sequences = gpuSceneBehaviorFrameEvidenceSequences(behaviors.frames as GpuSceneBehaviorFrameEvidenceFact[]);
  if (sequences.framePlanSequenceSha256 !== behaviors.framePlanSequenceSha256 || sequences.frameBudgetSequenceSha256 !== behaviors.frameBudgetSequenceSha256) {
    fail("segment_entry_invalid", "Behavior GPU range ordered plan or budget digest does not match its frame facts.");
  }
  const hashes = value.finalReceiptInputHashes;
  if (!record(hashes)
    || hashes["gpu-behavior-static-plan"] !== identity.behaviors.staticFingerprint
    || hashes["gpu-behavior-base-static-plan"] !== identity.behaviors.baseStaticFingerprint
    || hashes["gpu-behavior-static"] !== identity.behaviors.behaviorStaticFingerprint
    || hashes["gpu-behavior-source"] !== identity.behaviors.behaviorSourceSha256
    || hashes["gpu-behavior-frame-plan-sequence"] !== behaviors.framePlanSequenceSha256
    || hashes["gpu-behavior-frame-budget-sequence"] !== behaviors.frameBudgetSequenceSha256) {
    fail("segment_entry_invalid", "Behavior GPU range receipt hashes do not bind the Core behavior static or ordered frame identities.");
  }
}

export function assertGpuBehaviorStoreEntry(value: unknown, identity: RenderSegmentGpuBehaviorIdentity, packageFacts: RenderSegmentStorePackageFacts, range: RenderSegmentRange, timeline: RenderSegmentStoreTimelineFacts, frameHashes: readonly string[]): void {
  assertGpuBehaviorSegmentRangeProducerEvidence({ value, identity, packageFacts, range, timeline, frameHashes });
}

function assertBehaviorIdentity(value: unknown, frameCount: number, code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  if (!record(value) || !exactKeys(value, ["staticFingerprint", "baseStaticFingerprint", "behaviorStaticFingerprint", "behaviorSourceSha256", "targetLayerIds", "staticBudget", "frames", "framePlanSequenceSha256", "frameBudgetSequenceSha256"])
    || !sha(value.staticFingerprint) || !sha(value.baseStaticFingerprint) || !sha(value.behaviorStaticFingerprint) || !sha(value.behaviorSourceSha256)
    || !Array.isArray(value.targetLayerIds) || value.targetLayerIds.length < 1 || value.targetLayerIds.length > 32
    || value.targetLayerIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    || [...value.targetLayerIds].some((id, index) => index > 0 && id <= value.targetLayerIds[index - 1]!)) {
    fail(code, "Behavior GPU identity must retain ordered Core behavior fingerprints and target ids.");
  }
  const budget = value.staticBudget;
  if (!record(budget) || !exactKeys(budget, ["baseResourceReferenceCount", "behaviorInputBytes", "bindingCount", "enabledBindingCount", "behaviorFrameWorkUnits"])
    || !Object.values(budget).every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    || budget.behaviorInputBytes < 1 || budget.bindingCount < 1 || budget.bindingCount > 32 || budget.enabledBindingCount > budget.bindingCount) {
    fail(code, "Behavior GPU identity budget is invalid.");
  }
  if (!Array.isArray(value.frames) || value.frames.length !== frameCount || value.frames.some((frame, index) => !record(frame) || !exactKeys(frame, ["index", "atMs", "atUs", "fingerprint", "budgetSha256"]) || frame.index !== index || !Number.isFinite(frame.atMs) || !Number.isSafeInteger(frame.atUs) || frame.atUs < 0 || !sha(frame.fingerprint) || !sha(frame.budgetSha256))
    || !sha(value.framePlanSequenceSha256) || !sha(value.frameBudgetSequenceSha256)) {
    fail(code, "Behavior GPU identity must retain every ordered Core frame fingerprint and budget fact.");
  }
  const sequences = gpuSceneBehaviorFrameEvidenceSequences(value.frames as GpuSceneBehaviorFrameEvidenceFact[]);
  if (sequences.framePlanSequenceSha256 !== value.framePlanSequenceSha256 || sequences.frameBudgetSequenceSha256 !== value.frameBudgetSequenceSha256) {
    fail(code, "Behavior GPU identity schedule digests do not match its Core frame facts.");
  }
}

function legacyIdentity(identity: RenderSegmentGpuBehaviorIdentity): RenderSegmentGpuStandardIdentity {
  const { behaviors: _behaviors, ...legacy } = identity;
  return { ...legacy, schema: "shellx-motion/gpu-segmented-identity@1" };
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: object, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(), expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function fail(code: "segment_plan_invalid" | "segment_entry_invalid", message: string): never { throw new RenderSegmentStoreError(code, message); }
