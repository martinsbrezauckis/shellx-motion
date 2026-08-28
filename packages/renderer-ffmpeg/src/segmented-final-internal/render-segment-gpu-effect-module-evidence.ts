/** Strict C2 module-bearing GPU identities and release-gated range checkpoints. */
import {
  canonicalJson,
  canonicalJsonSha256,
  createGpuEffectModuleBinding,
  gpuEffectModuleStaticDescriptorProblem,
  streamingFrameTimestampMs,
  type GpuEffectModuleStaticDescriptor
} from "@shellx-motion/core";
import {
  assertGpuSegmentIdentity,
  assertGpuSegmentRangeProducerEvidence
} from "./render-segment-gpu-evidence.js";
import {
  RENDER_GPU_EFFECT_MODULE_SEGMENTED_IDENTITY_SCHEMA,
  RENDER_GPU_EFFECT_MODULE_SEGMENT_RANGE_PRODUCER_SCHEMA,
  type RenderSegmentGpuEffectModuleIdentity,
  type RenderSegmentGpuEffectModuleRangeProducerEvidence,
  type RenderSegmentGpuEffectModuleRangeUseEvidence
} from "./render-segment-gpu-effect-module-types.js";
import type {
  RenderSegmentGpuStandardIdentity,
  RenderSegmentRange,
  RenderSegmentStorePackageFacts,
  RenderSegmentStoreTimelineFacts
} from "./render-segment-store-types.js";
import { RenderSegmentStoreError } from "./render-segment-store-types.js";

const SHA256 = /^[a-f0-9]{64}$/;

export function assertGpuEffectModuleSegmentIdentity(
  value: unknown,
  packageFacts: RenderSegmentStorePackageFacts,
  frameCount: number,
  code: "segment_plan_invalid" | "segment_entry_invalid" = "segment_plan_invalid"
): asserts value is RenderSegmentGpuEffectModuleIdentity {
  if (!record(value) || !exactKeys(value, [
    "schema", "packageContentSha256", "pipelineCatalogSha256", "staticPlan", "staticScene", "hostVerdict", "effectModules",
    ...("videoStaging" in value ? ["videoStaging"] : [])
  ]) || value.schema !== RENDER_GPU_EFFECT_MODULE_SEGMENTED_IDENTITY_SCHEMA) {
    fail(code, "Module-bearing GPU segmented identity has an unknown, missing, or legacy wire field.");
  }
  const { effectModules, ...legacy } = value;
  assertGpuSegmentIdentity({ ...legacy, schema: "shellx-motion/gpu-segmented-identity@1" }, packageFacts, frameCount, code);
  assertEffectModuleDescriptors(effectModules, code);
}

export function assertGpuEffectModuleSegmentRangeProducerEvidence(input: {
  value: unknown;
  identity: RenderSegmentGpuEffectModuleIdentity;
  packageFacts: RenderSegmentStorePackageFacts;
  range: RenderSegmentRange;
  timeline: RenderSegmentStoreTimelineFacts;
  frameHashes: readonly string[];
}): asserts input is typeof input & { value: RenderSegmentGpuEffectModuleRangeProducerEvidence } {
  const { value, identity, packageFacts, range, timeline, frameHashes } = input;
  if (!record(value) || !exactKeys(value, [
    "schema", "frameLane", "identity", "frameSequenceSha256", "framePlanSequenceSha256", "framePlanFingerprints",
    "effectModules", "finalReceiptInputHashes", "warningUnion", "warningsOmitted",
    ...(identity.staticPlan.maxEnvironmentCount > 0 ? ["environmentArena"] : [])
  ]) || value.schema !== RENDER_GPU_EFFECT_MODULE_SEGMENT_RANGE_PRODUCER_SCHEMA || value.frameLane !== "gpu") {
    fail("segment_entry_invalid", "Module-bearing GPU checkpoints require their exact released range-evidence schema.");
  }
  assertGpuEffectModuleSegmentIdentity(value.identity, packageFacts, identity.staticPlan.canonicalFrameCount, "segment_entry_invalid");
  if (canonicalJson(value.identity) !== canonicalJson(identity)) fail("segment_entry_invalid", "Module-bearing GPU range identity conflicts with immutable pre-store admission.");
  const { effectModules, ...legacy } = value;
  const { "gpu-effect-module-descriptors": _descriptors, "gpu-effect-module-range-use": _rangeUse, ...legacyHashes } = legacy.finalReceiptInputHashes;
  assertGpuSegmentRangeProducerEvidence({
    value: {
      ...legacy,
      schema: "shellx-motion/gpu-segment-range-producer@1",
      identity: legacyIdentity(identity),
      finalReceiptInputHashes: legacyHashes
    },
    identity: legacyIdentity(identity), packageFacts, range, timeline, frameHashes
  });
  assertEffectModuleRangeUse(effectModules, identity, range, timeline, value.framePlanFingerprints);
  const hashes = value.finalReceiptInputHashes;
  if (!record(hashes) || hashes["gpu-effect-module-descriptors"] !== identity.effectModules.descriptorSequenceSha256
    || hashes["gpu-effect-module-range-use"] !== canonicalJsonSha256(effectModules)) {
    fail("segment_entry_invalid", "Module-bearing GPU range receipt hashes do not bind descriptor or released lease evidence.");
  }
}

function assertEffectModuleDescriptors(value: unknown, code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  if (!record(value) || !exactKeys(value, ["schema", "descriptors", "descriptorSequenceSha256"])
    || value.schema !== "shellx-motion/gpu-segmented-effect-module-descriptors@1"
    || !Array.isArray(value.descriptors) || value.descriptors.length === 0 || !sha(value.descriptorSequenceSha256)
    || value.descriptorSequenceSha256 !== canonicalJsonSha256(value.descriptors)) {
    fail(code, "Module-bearing GPU identity lacks a canonical closed descriptor sequence.");
  }
  if (value.descriptors.some((descriptor) => gpuEffectModuleStaticDescriptorProblem(descriptor) !== null)
    || new Set(value.descriptors.map((descriptor) => descriptor.layerId)).size !== value.descriptors.length) {
    fail(code, "Module-bearing GPU identity has malformed or duplicate effect-module descriptors.");
  }
}

function assertEffectModuleRangeUse(
  value: unknown,
  identity: RenderSegmentGpuEffectModuleIdentity,
  range: RenderSegmentRange,
  timeline: RenderSegmentStoreTimelineFacts,
  framePlanFingerprints: unknown
): void {
  if (!record(value) || !exactKeys(value, ["schema", "pending", "released"])
    || value.schema !== "shellx-motion/gpu-effect-module-segment-range-use@1") {
    fail("segment_entry_invalid", "Module-bearing GPU range lacks pending Browser and released lease evidence.");
  }
  const pending = value.pending, released = value.released;
  if (!record(pending) || !exactKeys(pending, ["schema", "ledger", "resources", "runtimeCleanup", "leaseRelease"])
    || pending.schema !== "shellx-motion/gpu-effect-module-streaming-use@1"
    || pending.runtimeCleanup !== "complete" || pending.leaseRelease !== "outer-host-owned-pending") {
    fail("segment_entry_invalid", "Module-bearing GPU range did not close its Browser runtime before lease release.");
  }
  const ledger = pending.ledger;
  if (!record(ledger) || !exactKeys(ledger, ["schema", "beginUse", "applications", "applicationSequenceSha256", "release"])
    || ledger.schema !== "shellx-motion/gpu-effect-module-application-ledger@1" || ledger.release !== "pending"
    || !Array.isArray(ledger.applications) || !sha(ledger.applicationSequenceSha256)) {
    fail("segment_entry_invalid", "Module-bearing GPU pending Browser ledger is malformed.");
  }
  if (!record(released) || !exactKeys(released, ["schema", "beginUse", "applications", "applicationSequenceSha256", "release"])
    || released.schema !== "shellx-motion/gpu-effect-module-final-use@1" || released.release !== "released"
    || !Array.isArray(released.applications) || !sha(released.applicationSequenceSha256)
    || canonicalJson(ledger.beginUse) !== canonicalJson(released.beginUse)
    || ledger.applicationSequenceSha256 !== released.applicationSequenceSha256
    || ledger.applications.length !== released.applications.length
    || ledger.applicationSequenceSha256 !== canonicalJsonSha256({ schema: ledger.schema, applications: ledger.applications })) {
    fail("segment_entry_invalid", "Module-bearing GPU released lease evidence does not match the pending Browser ledger.");
  }
  const summary = ledger.beginUse;
  assertBeginUse(summary, identity);
  assertResources(pending.resources, ledger.applications.length);
  if (!Array.isArray(framePlanFingerprints)) fail("segment_entry_invalid", "Module-bearing GPU range frame-plan evidence is unavailable.");
  let previousIndex = range.startFrame - 1;
  for (const [offset, application] of ledger.applications.entries()) {
    if (!record(application) || !exactKeys(application, ["index", "atUs", "framePlanFingerprint", "layerId"])
      || !Number.isSafeInteger(application.index) || application.index <= previousIndex
      || application.index < range.startFrame || application.index >= range.endFrameExclusive
      || application.atUs !== Math.round(streamingFrameTimestampMs(application.index, timeline.fps, timeline.durationMs) * 1_000)
      || application.framePlanFingerprint !== framePlanFingerprints[application.index - range.startFrame]
      || !record(summary) || !Array.isArray(summary.modules) || !summary.modules.some((module) => record(module) && module.layerId === application.layerId)) {
      fail("segment_entry_invalid", "Module-bearing GPU application ledger has a shifted, forged, or unbound range entry.");
    }
    const releasedApplication = released.applications[offset];
    if (!record(releasedApplication) || releasedApplication.release !== "released"
      || canonicalJson(projectApplication(releasedApplication)) !== canonicalJson(application)) {
      fail("segment_entry_invalid", "Module-bearing GPU released application ledger is incomplete or reordered.");
    }
    previousIndex = application.index;
  }
}

function assertBeginUse(value: unknown, identity: RenderSegmentGpuEffectModuleIdentity): void {
  if (!record(value) || !exactKeys(value, ["schema", "staticPlanFingerprint", "canonicalFrameCount", "modules"])
    || value.schema !== "shellx-motion/gpu-effect-module-begin-use@1"
    || value.staticPlanFingerprint !== identity.staticPlan.fingerprint
    || value.canonicalFrameCount !== identity.staticPlan.canonicalFrameCount
    || !Array.isArray(value.modules) || value.modules.length !== identity.effectModules.descriptors.length) {
    fail("segment_entry_invalid", "Module-bearing GPU lease does not bind the exact static plan and descriptor count.");
  }
  for (const descriptor of identity.effectModules.descriptors) {
    const module = value.modules.find((candidate) => record(candidate) && candidate.layerId === descriptor.layerId);
    const binding = createGpuEffectModuleBinding(descriptor);
    if (!record(module) || module.bindingFingerprint !== binding.bindingFingerprint
      || !Number.isSafeInteger(module.registryGeneration) || module.registryGeneration < 0
      || module.revocation !== "not-revoked-at-begin-use"
      || module.parameterValuesSha256 !== canonicalJsonSha256({ schema: descriptor.parameterSchema, amountQ16: descriptor.amountQ16, echoes: descriptor.echoes })
      || canonicalJson(projectModule(module)) !== canonicalJson(projectDescriptor(descriptor))) {
      fail("segment_entry_invalid", "Module-bearing GPU lease does not bind current registry generation, provenance, parameters, and closed binding.");
    }
  }
}

function assertResources(value: unknown, applications: number): void {
  if (!record(value) || !exactKeys(value, ["live", "terminal"])) fail("segment_entry_invalid", "Module-bearing GPU range resource evidence is malformed.");
  if (applications === 0) {
    if (value.live !== null || value.terminal !== null) fail("segment_entry_invalid", "Inactive module range retained fixed-pass resources.");
    return;
  }
  const live = value.live, terminal = value.terminal;
  if (!record(live) || !record(terminal)
    || live.uniformBufferSlots !== 1 || live.uniformBytes !== 160 || live.bindGroupSlots !== 1
    || live.passes !== applications || live.frames !== applications || live.lateAllocationRefusals !== 0 || live.persistentTextureCount !== 0
    || terminal.uniformBufferSlots !== 0 || terminal.uniformBytes !== 0 || terminal.bindGroupSlots !== 0
    || terminal.pipelineReleases !== 1 || terminal.preparedBindGroupReleases !== 1 || terminal.arenaUniformBufferDestructions !== 1) {
    fail("segment_entry_invalid", "Module-bearing GPU range lacks fixed-pass reservation and complete cleanup evidence.");
  }
}

function legacyIdentity(identity: RenderSegmentGpuEffectModuleIdentity): RenderSegmentGpuStandardIdentity {
  const { effectModules: _effectModules, ...legacy } = identity;
  return { ...legacy, schema: "shellx-motion/gpu-segmented-identity@1" };
}

function projectDescriptor(value: GpuEffectModuleStaticDescriptor): Record<string, unknown> {
  return { ...value };
}

function projectModule(value: Record<string, unknown>): Record<string, unknown> {
  const { bindingFingerprint, registryGeneration, revocation, parameterValuesSha256, ...descriptor } = value;
  return descriptor;
}

function projectApplication(value: Record<string, unknown>): Record<string, unknown> {
  return { index: value.index, atUs: value.atUs, framePlanFingerprint: value.framePlanFingerprint, layerId: value.layerId };
}

function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: object, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(), expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function fail(code: "segment_plan_invalid" | "segment_entry_invalid", message: string): never { throw new RenderSegmentStoreError(code, message); }
