import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import { isGpuSessionResources } from "@shellx-motion/renderer-browser";
import type { StreamingFinalGpuVideoStagingEvidence, StreamingFinalProducerEvidence } from "./streaming-final-adapter-types.js";
import { exactDirectHybridEvidence } from "./gpu-final-direct-hybrid-evidence.js";
import { gpuReadbackTransportIdentity } from "./gpu-readback-transport-evidence.js";
import { exactGpuBehaviorEvidence } from "./gpu-final-behavior-evidence.js";
import { readBoundedDataRecord } from "./bounded-data-snapshot.js";
import { gpuEnvironmentArenaEvidence } from "./gpu-environment-arena-evidence.js";

export { gpuFinalEffectModuleReceiptInputHashes } from "./gpu-final-effect-module-evidence.js";
export {
  gpuEnvironmentArenaEvidence,
  type GpuEnvironmentArenaEvidence,
  type GpuEnvironmentArenaInput,
  type GpuEnvironmentArenaRange
} from "./gpu-environment-arena-evidence.js";

const SHA256 = /^[a-f0-9]{64}$/;
type GpuFinalEvidence = Extract<StreamingFinalProducerEvidence, { frameLane: "gpu" }> ["evidence"];

/**
 * A GPU final receipt must bind its fixed page pipeline, immutable inputs,
 * per-frame high-water decision, selected adapter, and both canonical output
 * sequences. Cache and attested reuse remain unavailable until they consume
 * this same evidence in their identity contracts.
 */
export function gpuFinalReceiptInputHashes(producer: unknown): Record<string, string> | undefined {
  try {
    return gpuFinalReceiptInputHashesFromRecord(producer);
  } catch {
    return undefined;
  }
}

function gpuFinalReceiptInputHashesFromRecord(producer: unknown): Record<string, string> | undefined {
  const producerRecord = readBoundedDataRecord(producer);
  if (!producerRecord) return undefined;
  if (producerRecord.frameLane === "gpu-pbr") return pbrReceiptInputHashes(producerRecord.evidence);
  if (producerRecord.frameLane === "browser" || producerRecord.frameLane === "native") return {};
  if (producerRecord.frameLane !== "gpu") return undefined;
  const evidenceRecord = readBoundedDataRecord(producerRecord.evidence);
  const provenanceRecord = evidenceRecord ? readBoundedDataRecord(evidenceRecord.provenance) : undefined;
  if (!evidenceRecord || !provenanceRecord) return undefined;
  const evidence = evidenceRecord as unknown as GpuFinalEvidence;
  const { pipelineCatalog, staticPlan, staticScene, resourceBudget } = provenanceRecord as unknown as GpuFinalEvidence["provenance"];
  const adapterFingerprint = evidence.gpu?.adapterFingerprint;
  const readbackTransport = staticPlan ? gpuReadbackTransportIdentity(evidence.readback, staticPlan.canonicalFrameCount) : undefined;
  if (!pipelineCatalog || !staticPlan || !staticScene || !resourceBudget || !adapterFingerprint
    || !evidence.sessionResources || !isGpuSessionResources(evidence.sessionResources, staticPlan.canonicalFrameCount)
    || !readbackTransport || !evidence.frameSequenceSha256 || !evidence.framePlanSequenceSha256) return undefined;
  if (resourceBudget.sha256 !== sha256Canonical({
    schema: resourceBudget.schema,
    expectedFrames: resourceBudget.expectedFrames,
    observedFrames: resourceBudget.observedFrames,
    maxima: resourceBudget.maxima
  })) return undefined;
  const environmentArena = gpuEnvironmentArenaEvidence({ staticPlan, resourceBudget, sessionResources: evidence.sessionResources });
  if (environmentArena === undefined) return undefined;
  const videoStaging = evidence.videoStaging;
  if ((evidence.video !== null && !videoStaging) || (videoStaging && !isGpuVideoStagingEvidence(videoStaging))) return undefined;
  const hybrid = exactDirectHybridEvidence(evidence.hybrid, staticPlan.canonicalFrameCount);
  if (evidence.hybrid !== null && !hybrid) return undefined;
  const behaviors = exactGpuBehaviorEvidence(evidence.behaviors);
  if (evidence.behaviors !== undefined && !behaviors) return undefined;
  const values = [
    pipelineCatalog.sha256,
    staticPlan.fingerprint,
    staticPlan.documentFingerprint,
    staticPlan.resourceReferencesSha256,
    staticScene.sha256,
    staticScene.inputHashesSha256,
    resourceBudget.sha256,
    adapterFingerprint,
    sha256Canonical(evidence.sessionResources),
    sha256Canonical(readbackTransport),
    evidence.frameSequenceSha256,
    evidence.framePlanSequenceSha256,
    ...(environmentArena ? [sha256Canonical(environmentArena)] : []),
    ...(videoStaging ? [sha256Canonical(videoStaging.ledger), videoStaging.pcmSha256] : []),
    ...(hybrid ? [hybrid.sourceBindingSha256, hybrid.captureFrameSequenceSha256, hybrid.exactCaptureLedgerSequenceSha256] : []),
    ...(behaviors ? [behaviors.staticFingerprint, behaviors.baseStaticFingerprint, behaviors.behaviorStaticFingerprint, behaviors.behaviorSourceSha256, behaviors.framePlanSequenceSha256, behaviors.frameBudgetSequenceSha256] : [])
  ];
  if (!values.every((value) => SHA256.test(value))) return undefined;
  return Object.freeze({
    "gpu-pipeline-catalog": pipelineCatalog.sha256,
    "gpu-static-plan": staticPlan.fingerprint,
    "gpu-static-plan-document": staticPlan.documentFingerprint,
    "gpu-static-plan-resources": staticPlan.resourceReferencesSha256,
    "gpu-static-scene": staticScene.sha256,
    "gpu-static-inputs": staticScene.inputHashesSha256,
    "gpu-resource-budget": resourceBudget.sha256,
    "gpu-adapter": adapterFingerprint,
    "gpu-runtime": sha256Canonical(evidence.gpu),
    "gpu-session-resources": sha256Canonical(evidence.sessionResources),
    "gpu-readback-transport": sha256Canonical(readbackTransport),
    "gpu-containment": sha256Canonical(evidence.processMonitoring),
    "gpu-frame-sequence": evidence.frameSequenceSha256,
    "gpu-frame-plan-sequence": evidence.framePlanSequenceSha256,
    ...(environmentArena ? { "gpu-environment-arena": sha256Canonical(environmentArena) } : {}),
    ...(videoStaging ? {
      "gpu-video-staging-ledger": sha256Canonical(videoStaging.ledger),
      "gpu-video-pcm": videoStaging.pcmSha256
    } : {}),
    ...(hybrid ? {
      "gpu-hybrid-source-binding": hybrid.sourceBindingSha256,
      "gpu-hybrid-capture-sequence": hybrid.captureFrameSequenceSha256,
      "gpu-hybrid-exact-capture-ledger": hybrid.exactCaptureLedgerSequenceSha256
    } : {}),
    ...(behaviors ? {
      "gpu-behavior-static-plan": behaviors.staticFingerprint,
      "gpu-behavior-base-static-plan": behaviors.baseStaticFingerprint,
      "gpu-behavior-static": behaviors.behaviorStaticFingerprint,
      "gpu-behavior-source": behaviors.behaviorSourceSha256,
      "gpu-behavior-frame-plan-sequence": behaviors.framePlanSequenceSha256,
      "gpu-behavior-frame-budget-sequence": behaviors.frameBudgetSequenceSha256
    } : {})
  });
}


/** PBR keeps an independent receipt namespace so legacy GPU receipt maps stay byte-identical. */
function pbrReceiptInputHashes(value: unknown): Record<string, string> | undefined {
  const evidenceRecord = readBoundedDataRecord(value);
  if (!evidenceRecord) return undefined;
  const evidence = evidenceRecord as unknown as Extract<StreamingFinalProducerEvidence, { frameLane: "gpu-pbr" }> ["evidence"];
  const inputHashes = readBoundedDataRecord(evidence.inputHashes) as Readonly<Record<string, string>> | undefined;
  const runtime = readBoundedDataRecord(evidence.runtime);
  const readback = readBoundedDataRecord(evidence.readback);
  const cleanup = readBoundedDataRecord(evidence.cleanup);
  if (!inputHashes || !runtime || !readback || !cleanup) return undefined;
  const expectedInputKeys = [
    "scene3d-gltf-pbr-manifest", "scene3d-gltf-pbr-motion", "scene3d-gltf-pbr-source",
    "scene3d-gltf-pbr-sidecar", "scene3d-gltf-pbr-sidecar-receipt", "scene3d-gltf-pbr-declaration",
    "scene3d-gltf-pbr-static-plan", "scene3d-gltf-pbr-frame-plan", "scene3d-gltf-pbr-catalog", "scene3d-gltf-pbr-scene-state",
  ];
  const required = [
    evidence.routeFingerprint, evidence.catalogSha256, evidence.frameSequenceSha256, evidence.framePlanSequenceSha256,
    runtime.adapterFingerprint, evidence.fingerprint,
    inputHashes["scene3d-gltf-pbr-manifest"], inputHashes["scene3d-gltf-pbr-motion"],
    inputHashes["scene3d-gltf-pbr-source"], inputHashes["scene3d-gltf-pbr-sidecar"],
    inputHashes["scene3d-gltf-pbr-sidecar-receipt"], inputHashes["scene3d-gltf-pbr-declaration"],
    inputHashes["scene3d-gltf-pbr-static-plan"], inputHashes["scene3d-gltf-pbr-frame-plan"], evidence.sceneStateSha256,
  ];
  if (!required.every((value) => typeof value === "string" && SHA256.test(value))
    || !sameKeys(inputHashes, expectedInputKeys)
    || inputHashes["scene3d-gltf-pbr-catalog"] !== evidence.catalogSha256
    || inputHashes["scene3d-gltf-pbr-scene-state"] !== evidence.sceneStateSha256
    || evidence.fingerprint !== canonicalJsonSha256({ ...evidence, fingerprint: undefined })
    || evidence.framesRendered < 1 || evidence.retainedFrameCount !== 0 || evidence.sessionFrameCacheEntries !== 0
    || readback.reservedReadbackBufferBytes !== 1280 * 720 * 4 || readback.readbackBufferAllocations !== 1
    || readback.mapOperations !== evidence.framesRendered || !readback.released
    || cleanup.state !== "complete" || !cleanup.resourceReleased || !cleanup.readbackReleased || !cleanup.pageClosed) return undefined;
  return Object.freeze({
    "scene3d-gltf-pbr-route": evidence.routeFingerprint,
    "scene3d-gltf-pbr-manifest": inputHashes["scene3d-gltf-pbr-manifest"]!,
    "scene3d-gltf-pbr-motion": inputHashes["scene3d-gltf-pbr-motion"]!,
    "scene3d-gltf-pbr-source": inputHashes["scene3d-gltf-pbr-source"]!,
    "scene3d-gltf-pbr-sidecar": inputHashes["scene3d-gltf-pbr-sidecar"]!,
    "scene3d-gltf-pbr-sidecar-receipt": inputHashes["scene3d-gltf-pbr-sidecar-receipt"]!,
    "scene3d-gltf-pbr-declaration": inputHashes["scene3d-gltf-pbr-declaration"]!,
    "scene3d-gltf-pbr-static-plan": inputHashes["scene3d-gltf-pbr-static-plan"]!,
    "scene3d-gltf-pbr-frame-plan": inputHashes["scene3d-gltf-pbr-frame-plan"]!,
    "scene3d-gltf-pbr-catalog": evidence.catalogSha256,
    "scene3d-gltf-pbr-scene-state": evidence.sceneStateSha256,
    "scene3d-gltf-pbr-adapter": runtime.adapterFingerprint as string,
    "scene3d-gltf-pbr-frame-sequence": evidence.frameSequenceSha256!,
    "scene3d-gltf-pbr-frame-plan-sequence": evidence.framePlanSequenceSha256!,
    "scene3d-gltf-pbr-producer": evidence.fingerprint!,
  });
}

function sameKeys(value: Readonly<Record<string, string>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isGpuVideoStagingEvidence(value: StreamingFinalGpuVideoStagingEvidence): boolean {
  const ledger = value.ledger;
  const fields = [ledger.maxBytes, ledger.immutableSourceBytes, ledger.plannedRgbaBytes, ledger.plannedPcmBytes, ledger.totalBytes];
  return fields.every((field) => Number.isSafeInteger(field) && field >= 0)
    && ledger.totalBytes === ledger.immutableSourceBytes + ledger.plannedRgbaBytes + ledger.plannedPcmBytes
    && ledger.totalBytes <= ledger.maxBytes
    && SHA256.test(value.pcmSha256);
}
