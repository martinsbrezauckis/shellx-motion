import { canonicalJson, gpuEffectModuleStaticDescriptorProblem } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import type { GpuEffectModuleFinalReceiptEvidence } from "@shellx-motion/renderer-browser";
import type { StreamingFinalProducerEvidence } from "./streaming-final-adapter-types.js";

const SHA256 = /^[a-f0-9]{64}$/;
type GpuFinalEvidence = Extract<StreamingFinalProducerEvidence, { frameLane: "gpu" }> ["evidence"];
type GpuStreamingEffectModuleEvidence = NonNullable<GpuFinalEvidence["effectModules"]>;
type GpuEffectModuleStaticDescriptor = NonNullable<NonNullable<GpuFinalEvidence["provenance"]["staticPlan"]>["effectModules"]>[number];

/**
 * C2-only receipt identity. This intentionally stays separate from legacy
 * GPU provenance so a module-free final retains its exact historical receipt
 * input map. The released evidence can only come from Browser after the outer
 * opaque lease completed; this leaf nevertheless validates every value before
 * FFmpeg projects any hashes into its receipt.
 */
export function gpuFinalEffectModuleReceiptInputHashes(
  producer: StreamingFinalProducerEvidence,
  released: GpuEffectModuleFinalReceiptEvidence | undefined
): Record<string, string> | undefined {
  if (producer.frameLane === "gpu-pbr") return released === undefined ? {} : undefined;
  if (producer.frameLane !== "gpu") return released === undefined ? {} : undefined;
  const evidence = producer.evidence;
  const staticPlan = evidence.provenance.staticPlan;
  const descriptors = staticPlan?.effectModules;
  const streaming = evidence.effectModules;
  if (!descriptors?.length) return streaming === undefined && released === undefined ? {} : undefined;
  if (!staticPlan || !streaming || !released || !validStreamingModuleEvidence(streaming, released, staticPlan, evidence.provenance.resourceBudget)) return undefined;
  const moduleCatalog = sha256Canonical({
    schema: "shellx-motion/gpu-effect-module-final-catalog@1",
    rendererPipelineCatalogSha256: evidence.provenance.pipelineCatalog?.sha256,
    staticPlanFingerprint: staticPlan.fingerprint,
    modules: released.beginUse.modules
  });
  const beginUse = sha256Canonical(released.beginUse);
  const applicationLedger = sha256Canonical({
    schema: released.schema,
    applications: released.applications,
    applicationSequenceSha256: released.applicationSequenceSha256
  });
  const resources = sha256Canonical(streaming.resources);
  const cleanup = sha256Canonical({ runtimeCleanup: streaming.runtimeCleanup, leaseRelease: streaming.leaseRelease, release: released.release });
  return Object.freeze({
    "gpu-effect-module-catalog": moduleCatalog,
    "gpu-effect-module-begin-use": beginUse,
    "gpu-effect-module-applications": applicationLedger,
    "gpu-effect-module-resources": resources,
    "gpu-effect-module-cleanup": cleanup
  });
}

function validStreamingModuleEvidence(
  streaming: GpuStreamingEffectModuleEvidence,
  released: GpuEffectModuleFinalReceiptEvidence,
  staticPlan: NonNullable<GpuFinalEvidence["provenance"]["staticPlan"]>,
  resourceBudget: GpuFinalEvidence["provenance"]["resourceBudget"]
): boolean {
  const descriptors = staticPlan.effectModules;
  if (!descriptors?.length
    || streaming.schema !== "shellx-motion/gpu-effect-module-streaming-use@1"
    || streaming.runtimeCleanup !== "complete"
    || streaming.leaseRelease !== "outer-host-owned-pending"
    || released.schema !== "shellx-motion/gpu-effect-module-final-use@1"
    || released.release !== "released"
    || released.applicationSequenceSha256 !== streaming.ledger.applicationSequenceSha256
    || canonicalJson(released.beginUse) !== canonicalJson(streaming.ledger.beginUse)
    || released.beginUse.staticPlanFingerprint !== staticPlan.fingerprint
    || released.beginUse.canonicalFrameCount !== staticPlan.canonicalFrameCount
    || released.beginUse.modules.length !== descriptors.length
    || !SHA256.test(released.applicationSequenceSha256)) return false;
  const summaries = new Map(released.beginUse.modules.map((module) => [module.layerId, module]));
  if (summaries.size !== descriptors.length || !descriptors.every((descriptor) => exactStaticModuleDescriptor(descriptor, summaries.get(descriptor.layerId)))) return false;
  const applications = streaming.ledger.applications;
  if (released.applications.length !== applications.length || !released.applications.every((application, index) => {
    const { release, ...ledgerApplication } = application;
    return release === "released" && canonicalJson(ledgerApplication) === canonicalJson(applications[index]);
  })) return false;
  if (!validModuleResourceHighWater(streaming.resources, applications.length)) return false;
  return validModuleBudget(resourceBudget, applications.length);
}

function exactStaticModuleDescriptor(
  descriptor: GpuEffectModuleStaticDescriptor,
  summary: GpuEffectModuleFinalReceiptEvidence["beginUse"]["modules"][number] | undefined
): boolean {
  if (!summary) return false;
  const scalarHashes = [
    descriptor.manifestSha256, descriptor.registryEntrySha256, descriptor.installationProvenanceSha256,
    descriptor.pipelineImplementationSha256, descriptor.resourceCeilingSha256, descriptor.descriptorFingerprint,
    summary.bindingFingerprint, summary.parameterValuesSha256
  ];
  return gpuEffectModuleStaticDescriptorProblem(descriptor) === null
    && scalarHashes.every((value) => SHA256.test(value))
    && descriptor.layerId === summary.layerId
    && descriptor.drawId === summary.drawId
    && descriptor.scopeGroupId === summary.scopeGroupId
    && descriptor.scopeGroupDrawId === summary.scopeGroupDrawId
    && descriptor.moduleId === summary.moduleId
    && descriptor.version === summary.version
    && descriptor.manifestSha256 === summary.manifestSha256
    && descriptor.manifestByteLength === summary.manifestByteLength
    && descriptor.registryEntrySha256 === summary.registryEntrySha256
    && descriptor.installationProvenanceSha256 === summary.installationProvenanceSha256
    && descriptor.intrinsic === summary.intrinsic
    && descriptor.rendererAbi === summary.rendererAbi
    && descriptor.parameterSchema === summary.parameterSchema
    && descriptor.pipelineImplementationSha256 === summary.pipelineImplementationSha256
    && descriptor.resourceCeilingSha256 === summary.resourceCeilingSha256
    && descriptor.descriptorFingerprint === summary.descriptorFingerprint
    && descriptor.amountQ16 === summary.amountQ16
    && canonicalJson(descriptor.echoes) === canonicalJson(summary.echoes)
    && Number.isSafeInteger(summary.registryGeneration)
    && summary.registryGeneration >= 0
    && summary.revocation === "not-revoked-at-begin-use";
}

function validModuleResourceHighWater(
  resources: GpuStreamingEffectModuleEvidence["resources"],
  applicationCount: number
): boolean {
  if (applicationCount === 0) return resources.live === null && resources.terminal === null;
  const live = resources.live, terminal = resources.terminal;
  return live !== null
    && terminal !== null
    && live.uniformBufferSlots === 1
    && live.uniformBytes === 160
    && live.bindGroupSlots === 1
    && live.passes === applicationCount
    && live.frames === applicationCount
    && live.lateAllocationRefusals === 0
    && live.persistentTextureCount === 0
    && terminal.uniformBufferSlots === 0
    && terminal.uniformBytes === 0
    && terminal.bindGroupSlots === 0
    && terminal.pipelineReleases === 1
    && terminal.preparedBindGroupReleases === 1
    && terminal.arenaUniformBufferDestructions === 1;
}

function validModuleBudget(resourceBudget: GpuFinalEvidence["provenance"]["resourceBudget"], applicationCount: number): boolean {
  if (!resourceBudget) return false;
  const maxima = resourceBudget.maxima;
  if (applicationCount === 0) {
    return maxima.effectModuleCount === undefined
      && maxima.effectModuleUniformBytes === undefined
      && maxima.effectModuleTextureLoadCount === undefined
      && maxima.effectModulePassCount === undefined;
  }
  return maxima.effectModuleCount === 1
    && maxima.effectModuleUniformBytes === 160
    && typeof maxima.effectModuleTextureLoadCount === "number"
    && Number.isSafeInteger(maxima.effectModuleTextureLoadCount)
    && maxima.effectModuleTextureLoadCount >= 2
    && maxima.effectModuleTextureLoadCount <= 5
    && maxima.effectModulePassCount === 1;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
