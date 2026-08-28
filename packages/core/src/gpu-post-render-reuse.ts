/** Post-render-only GPU identity; it verifies a prior passed receipt/artifact and never plans a cache hit. */
import { createHash } from "node:crypto";
import { verifyAttestedArtifactHandle, type ArtifactReceiptAttestation, type AttestedArtifactHandle, type VerifiedAttestedArtifact } from "./artifact-handle";
import { canonicalJsonSha256 } from "./canonical-json";
import { assertGpuPostRenderEnvironmentArenaEvidence } from "./gpu-post-render-reuse-environment";
import type { OperationReceipt } from "./types";

export const GPU_POST_RENDER_REUSE_IDENTITY_SCHEMA = "shellx-motion/gpu-post-render-reuse-identity@1" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const PROCESS_CONTAINMENT_MODES = new Set(["windows-job-object", "unix-process-group"]);
const PROCESS_MEMORY_LIMITS = new Set(["job-commit", "rss-monitor"]);

/** Path-free durable result. It is evidence of one completed render, never a cache-plan promise. */
export interface GpuPostRenderReuseIdentity {
  schema: typeof GPU_POST_RENDER_REUSE_IDENTITY_SCHEMA;
  mode: "post-render-only";
  source: { receiptId: string; receiptSha256: string };
  artifact: { sha256: string; byteLength: number; authoritySha256: string };
  loadedInputsSha256: string;
  staticScene: { pipelineCatalogSha256: string; staticPlanFingerprint: string; documentFingerprint: string; resourceReferencesSha256: string; staticSceneSha256: string; resourceBudgetSha256: string };
  frameTransport: { transportSha256: string; frameSequenceSha256: string; framePlanSequenceSha256: string };
  runtime: { adapterFingerprint: string; runtimeProfileSha256: string; sessionResourcesSha256: string; containmentProfileSha256: string };
  video: { stagingLedgerSha256: string; pcmSha256: string } | null;
  quality: { closureSha256: string; exactSourceInputsSha256: string | null };
  identitySha256: string;
}

export interface GpuPostRenderReuseSource {
  receipt: OperationReceipt;
  sourceReceipt: ArtifactReceiptAttestation;
  artifact: AttestedArtifactHandle;
}

export function deriveGpuPostRenderReuseIdentity(input: GpuPostRenderReuseSource): GpuPostRenderReuseIdentity {
  const receipt = input.receipt;
  const sourceReceipt = input.sourceReceipt;
  const artifact = input.artifact;
  if (receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== "render.final" || receipt.status !== "passed" || receipt.lane !== "ffmpeg") {
    throw new Error("GPU post-render reuse requires a passed host render.final FFmpeg receipt.");
  }
  if (sourceReceipt.role !== "render" || sourceReceipt.status !== "passed" || sourceReceipt.id !== receipt.id || sourceReceipt.operation !== receipt.operation || !isSha256(sourceReceipt.sha256)) {
    throw new Error("GPU post-render reuse requires the exact passed render receipt attestation.");
  }
  const artifactReceipt = artifact.receipts.find((entry) => entry.role === "render");
  if (!artifactReceipt || !sameAttestation(artifactReceipt, sourceReceipt)) {
    throw new Error("GPU post-render reuse artifact is not bound to the passed render receipt.");
  }
  if (!isSha256(artifact.sha256) || !positiveSafeInteger(artifact.byteLength) || !canonicalRelativePath(artifact.rootRelativePath)) {
    throw new Error("GPU post-render reuse artifact authority is invalid.");
  }

  const output = record(receipt.output, "GPU final receipt output");
  const outputSha256 = hash(output.sha256, "GPU final receipt output sha256");
  if (outputSha256 !== artifact.sha256 || typeof output.path !== "string" || !output.path) {
    throw new Error("GPU post-render reuse receipt output is not bound to its retained artifact.");
  }
  if (typeof output.preset !== "string" || output.preset !== artifact.preset) {
    throw new Error("GPU post-render reuse receipt preset is not bound to its retained artifact.");
  }

  const hashes = hashRecord(receipt.inputHashes, "GPU final receipt input hashes");
  const transport = record(output.frameTransport, "GPU final frame transport");
  if (transport.delivery !== "streamed" || transport.frameLane !== "gpu" || !positiveSafeInteger(transport.frameCount) || transport.retainedFrameCount !== 0) {
    throw new Error("GPU post-render reuse requires the strict streamed GPU frame transport.");
  }
  const producer = record(transport.producer, "GPU final producer");
  if (producer.frameLane !== "gpu") throw new Error("GPU post-render reuse producer lane is not GPU.");
  const evidence = record(producer.evidence, "GPU final producer evidence");
  if (evidence.schema !== "shellx-motion/gpu-streaming-producer@1") throw new Error("GPU post-render reuse producer evidence schema is invalid.");
  const loadedInputs = hashRecord(evidence.inputHashes, "GPU final loaded input hashes");
  if (Object.keys(loadedInputs).length === 0) throw new Error("GPU post-render reuse requires exact loaded input hashes.");

  const provenance = record(evidence.provenance, "GPU final provenance");
  const pipelineCatalog = record(provenance.pipelineCatalog, "GPU pipeline catalog");
  const staticPlan = record(provenance.staticPlan, "GPU static plan");
  const staticScene = record(provenance.staticScene, "GPU static scene");
  const resourceBudget = record(provenance.resourceBudget, "GPU resource budget");
  const pipelineCatalogSha256 = hash(pipelineCatalog.sha256, "GPU pipeline catalog sha256");
  const staticPlanFingerprint = hash(staticPlan.fingerprint, "GPU static plan fingerprint");
  const documentFingerprint = hash(staticPlan.documentFingerprint, "GPU static plan document fingerprint");
  const resourceReferencesSha256 = hash(staticPlan.resourceReferencesSha256, "GPU static plan resource hash");
  const staticSceneSha256 = hash(staticScene.sha256, "GPU static scene sha256");
  const resourceBudgetSha256 = hash(resourceBudget.sha256, "GPU resource budget sha256");
  const staticInputHashesSha256 = hash(staticScene.inputHashesSha256, "GPU static input hashes");
  if (pipelineCatalog.schema !== "shellx-motion/gpu-pipeline-catalog@1" || staticPlan.schema !== "shellx-motion/gpu-scene-static-plan@1"
    || staticScene.schema !== "shellx-motion/gpu-static-scene-fingerprint@1" || resourceBudget.schema !== "shellx-motion/gpu-resource-budget-evidence@1"
    || pipelineCatalogSha256 !== canonicalJsonSha256({ schema: pipelineCatalog.schema, entries: pipelineCatalog.entries })
    || resourceBudgetSha256 !== canonicalJsonSha256({ schema: resourceBudget.schema, expectedFrames: resourceBudget.expectedFrames, observedFrames: resourceBudget.observedFrames, maxima: resourceBudget.maxima })
    || staticScene.pipelineCatalogSha256 !== pipelineCatalogSha256
    || staticInputHashesSha256 !== canonicalJsonSha256(loadedInputs)
    || !positiveSafeInteger(staticPlan.canonicalFrameCount) || transport.frameCount !== staticPlan.canonicalFrameCount
    || resourceBudget.expectedFrames !== staticPlan.canonicalFrameCount || resourceBudget.observedFrames !== staticPlan.canonicalFrameCount) {
    throw new Error("GPU post-render reuse static scene or resource budget evidence is incomplete.");
  }
  assertHashBindings(hashes, {
    "gpu-pipeline-catalog": pipelineCatalogSha256,
    "gpu-static-plan": staticPlanFingerprint,
    "gpu-static-plan-document": documentFingerprint,
    "gpu-static-plan-resources": resourceReferencesSha256,
    "gpu-static-scene": staticSceneSha256,
    "gpu-static-inputs": staticInputHashesSha256,
    "gpu-resource-budget": resourceBudgetSha256,
  });

  const runtime = record(evidence.gpu, "GPU runtime evidence");
  const adapter = record(runtime.adapter, "GPU adapter profile");
  const limits = record(runtime.limits, "GPU adapter limits");
  const adapterFingerprint = hash(runtime.adapterFingerprint, "GPU adapter fingerprint");
  if (runtime.schema !== "shellx-motion/gpu-runtime-evidence@1" || runtime.backend !== "webgpu-browser" || !boundedText(runtime.browserSource)
    || !["enabled", "enabled_on", "enabled_readback"].includes(String(runtime.webgpuFeatureStatus)) || !validGpuAdapterProfile(adapter, limits, adapterFingerprint)) {
    throw new Error("GPU post-render reuse adapter runtime profile is incomplete.");
  }
  const sessionResources = record(evidence.sessionResources, "GPU persistent session resources");
  if (sessionResources.schema !== "shellx-motion/gpu-page-session-resources@1" || sessionResources.framesRendered !== staticPlan.canonicalFrameCount) {
    throw new Error("GPU post-render reuse persistent session resources are incomplete.");
  }
  assertGpuPostRenderEnvironmentArenaEvidence(staticPlan, resourceBudget, sessionResources, hashes);
  const monitoring = record(evidence.processMonitoring, "GPU process containment");
  const containment = record(monitoring.containment, "GPU process containment evidence");
  if (monitoring.mode !== "precontained-direct-chromium" || monitoring.watchedRoot !== "precontained-chromium-root"
    || monitoring.rssScope !== "precontained-chromium-tree" || monitoring.measurement !== "exact-precontained-chromium-root-pid"
    || monitoring.watchRegistered !== true || monitoring.encoderContainmentCoversChromium !== true
    || !positiveSafeInteger(monitoring.chromiumRootPid) || containment.status !== "enforced" || containment.killTree !== true
    || !PROCESS_CONTAINMENT_MODES.has(String(containment.mode)) || !PROCESS_MEMORY_LIMITS.has(String(containment.memoryLimit))
    || containment.rootPid !== monitoring.chromiumRootPid || !positiveSafeInteger(containment.maxProcessTreeRssBytes)) {
    throw new Error("GPU post-render reuse requires enforced Chromium and encoder containment evidence.");
  }
  const runtimeProfileSha256 = canonicalJsonSha256(runtime);
  const sessionResourcesSha256 = canonicalJsonSha256(sessionResources);
  const containmentProfileSha256 = canonicalJsonSha256(monitoring);
  assertHashBindings(hashes, {
    "gpu-adapter": adapterFingerprint,
    "gpu-runtime": runtimeProfileSha256,
    "gpu-session-resources": sessionResourcesSha256,
    "gpu-containment": containmentProfileSha256,
  });

  const frameSequenceSha256 = hash(evidence.frameSequenceSha256, "GPU frame sequence sha256");
  const framePlanSequenceSha256 = hash(evidence.framePlanSequenceSha256, "GPU frame-plan sequence sha256");
  const handoff = record(transport.encoderHandoff, "GPU encoder handoff");
  const handoffSequence = record(handoff.frameSequence, "GPU encoder frame sequence");
  if (handoff.delivery !== "streamed" || handoff.frameFormat !== "rgba" || handoffSequence.schema !== "shellx-motion/streamed-frame-sequence@1"
    || handoffSequence.sha256 !== frameSequenceSha256) {
    throw new Error("GPU post-render reuse frame transport does not bind the canonical RGBA frame sequence.");
  }
  assertHashBindings(hashes, {
    "gpu-frame-sequence": frameSequenceSha256,
    "gpu-frame-plan-sequence": framePlanSequenceSha256,
  });

  const video = readVideoEvidence(evidence, hashes);
  const quality = record(handoff.quality, "GPU delivered quality closure");
  const blankFrames = nonnegativeSafeInteger(quality.blankFrames, "GPU delivered quality blank frame count");
  const uniqueFrameHashes = positiveSafeIntegerField(quality.uniqueFrameHashes, "GPU delivered quality unique frame count");
  if (quality.frameCount !== staticPlan.canonicalFrameCount || blankFrames < 0 || uniqueFrameHashes < 1 || typeof quality.uniqueFrameHashesExact !== "boolean") {
    throw new Error("GPU post-render reuse quality closure is incomplete.");
  }
  const exactSourceInputsSha256 = hashes.qualityInputs ?? null;
  const qualityClosureSha256 = canonicalJsonSha256({ quality, exactSourceInputsSha256 });

  const identityWithoutDigest = {
    schema: GPU_POST_RENDER_REUSE_IDENTITY_SCHEMA,
    mode: "post-render-only" as const,
    source: { receiptId: receipt.id, receiptSha256: sourceReceipt.sha256 },
    artifact: {
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      authoritySha256: canonicalJsonSha256({ id: artifact.id, rootRelativePath: artifact.rootRelativePath, preset: artifact.preset, mediaType: artifact.mediaType }),
    },
    loadedInputsSha256: canonicalJsonSha256(loadedInputs),
    staticScene: { pipelineCatalogSha256, staticPlanFingerprint, documentFingerprint, resourceReferencesSha256, staticSceneSha256, resourceBudgetSha256 },
    frameTransport: {
      transportSha256: canonicalJsonSha256(transport),
      frameSequenceSha256,
      framePlanSequenceSha256,
    },
    runtime: { adapterFingerprint, runtimeProfileSha256, sessionResourcesSha256, containmentProfileSha256 },
    video,
    quality: { closureSha256: qualityClosureSha256, exactSourceInputsSha256 },
  };
  const identity = { ...identityWithoutDigest, identitySha256: canonicalJsonSha256(identityWithoutDigest) };
  validateGpuPostRenderReuseIdentity(identity);
  return Object.freeze(identity);
}

/** Verify the persisted passed receipt and retained artifact before deriving the post-render identity. */
export async function verifyGpuPostRenderReuseIdentity(input: {
  root: string;
  artifact: AttestedArtifactHandle;
  expected?: GpuPostRenderReuseIdentity;
}): Promise<{ identity: GpuPostRenderReuseIdentity; artifact: VerifiedAttestedArtifact }> {
  const verified = await verifyAttestedArtifactHandle(input.root, input.artifact, { requiredReceiptRoles: ["render"], probe: false });
  const source = verified.receipts.find((entry) => entry.attestation.role === "render");
  if (!source || source.attestation.status !== "passed" || source.receipt.status !== "passed") {
    throw new Error("GPU post-render reuse accepts only a prior passed host-issued render receipt.");
  }
  const identity = deriveGpuPostRenderReuseIdentity({ receipt: source.receipt, sourceReceipt: source.attestation, artifact: verified.handle });
  if (input.expected && (input.expected.identitySha256 !== identity.identitySha256 || canonicalJsonSha256(input.expected) !== canonicalJsonSha256(identity))) {
    throw new Error("GPU post-render reuse identity does not match the retained receipt and artifact.");
  }
  return { identity, artifact: verified };
}

/** Validate a serialized identity before it is shown or retained by a host. It does not authorize reuse. */
export function validateGpuPostRenderReuseIdentity(value: unknown): asserts value is GpuPostRenderReuseIdentity {
  const identity = record(value, "GPU post-render reuse identity");
  exactKeys(identity, ["schema", "mode", "source", "artifact", "loadedInputsSha256", "staticScene", "frameTransport", "runtime", "video", "quality", "identitySha256"], "GPU post-render reuse identity");
  if (identity.schema !== GPU_POST_RENDER_REUSE_IDENTITY_SCHEMA || identity.mode !== "post-render-only") throw new Error("GPU post-render reuse identity schema is invalid.");
  const source = record(identity.source, "GPU post-render reuse identity source");
  exactKeys(source, ["receiptId", "receiptSha256"], "GPU post-render reuse identity source");
  if (!boundedText(source.receiptId) || !isSha256(source.receiptSha256)) throw new Error("GPU post-render reuse identity source is invalid.");
  const artifact = record(identity.artifact, "GPU post-render reuse identity artifact");
  exactKeys(artifact, ["sha256", "byteLength", "authoritySha256"], "GPU post-render reuse identity artifact");
  if (!isSha256(artifact.sha256) || !positiveSafeInteger(artifact.byteLength) || !isSha256(artifact.authoritySha256) || !isSha256(identity.loadedInputsSha256)) throw new Error("GPU post-render reuse identity artifact is invalid.");
  const staticScene = hashObject(identity.staticScene, ["pipelineCatalogSha256", "staticPlanFingerprint", "documentFingerprint", "resourceReferencesSha256", "staticSceneSha256", "resourceBudgetSha256"], "GPU post-render static scene");
  const frameTransport = hashObject(identity.frameTransport, ["transportSha256", "frameSequenceSha256", "framePlanSequenceSha256"], "GPU post-render frame transport");
  const runtime = hashObject(identity.runtime, ["adapterFingerprint", "runtimeProfileSha256", "sessionResourcesSha256", "containmentProfileSha256"], "GPU post-render runtime");
  const video = identity.video === null ? null : hashObject(identity.video, ["stagingLedgerSha256", "pcmSha256"], "GPU post-render video");
  const quality = record(identity.quality, "GPU post-render quality");
  exactKeys(quality, ["closureSha256", "exactSourceInputsSha256"], "GPU post-render quality");
  if (!isSha256(quality.closureSha256) || !(quality.exactSourceInputsSha256 === null || isSha256(quality.exactSourceInputsSha256))) throw new Error("GPU post-render quality identity is invalid.");
  if (!isSha256(identity.identitySha256)) throw new Error("GPU post-render identity digest is invalid.");
  const withoutDigest = {
    schema: GPU_POST_RENDER_REUSE_IDENTITY_SCHEMA,
    mode: "post-render-only" as const,
    source: { receiptId: source.receiptId, receiptSha256: source.receiptSha256 },
    artifact: { sha256: artifact.sha256, byteLength: artifact.byteLength, authoritySha256: artifact.authoritySha256 },
    loadedInputsSha256: identity.loadedInputsSha256,
    staticScene: {
      pipelineCatalogSha256: staticScene.pipelineCatalogSha256,
      staticPlanFingerprint: staticScene.staticPlanFingerprint,
      documentFingerprint: staticScene.documentFingerprint,
      resourceReferencesSha256: staticScene.resourceReferencesSha256,
      staticSceneSha256: staticScene.staticSceneSha256,
      resourceBudgetSha256: staticScene.resourceBudgetSha256,
    },
    frameTransport: {
      transportSha256: frameTransport.transportSha256,
      frameSequenceSha256: frameTransport.frameSequenceSha256,
      framePlanSequenceSha256: frameTransport.framePlanSequenceSha256,
    },
    runtime: {
      adapterFingerprint: runtime.adapterFingerprint,
      runtimeProfileSha256: runtime.runtimeProfileSha256,
      sessionResourcesSha256: runtime.sessionResourcesSha256,
      containmentProfileSha256: runtime.containmentProfileSha256,
    },
    video: video === null ? null : { stagingLedgerSha256: video.stagingLedgerSha256, pcmSha256: video.pcmSha256 },
    quality: { closureSha256: quality.closureSha256, exactSourceInputsSha256: quality.exactSourceInputsSha256 },
  };
  const identitySha256 = identity.identitySha256;
  if (identitySha256 !== canonicalJsonSha256(withoutDigest)) throw new Error("GPU post-render identity digest does not bind its contents.");
}

function readVideoEvidence(evidence: Record<string, unknown>, hashes: Record<string, string>): GpuPostRenderReuseIdentity["video"] {
  if (evidence.video === null) {
    if (evidence.videoStaging !== undefined || hashes["gpu-video-staging-ledger"] !== undefined || hashes["gpu-video-pcm"] !== undefined) {
      throw new Error("GPU post-render reuse video staging evidence conflicts with an absent video producer.");
    }
    return null;
  }
  const video = record(evidence.video, "GPU video producer evidence");
  if (video.schema !== "shellx-motion/gpu-video-frame-provider@1") throw new Error("GPU video producer evidence schema is invalid.");
  const staging = record(evidence.videoStaging, "GPU video staging evidence");
  const ledger = record(staging.ledger, "GPU video staging ledger");
  const pcmSha256 = hash(staging.pcmSha256, "GPU video PCM sha256");
  const maxBytes = nonnegativeSafeInteger(ledger.maxBytes, "GPU video staging max bytes");
  const immutableSourceBytes = nonnegativeSafeInteger(ledger.immutableSourceBytes, "GPU video staging immutable bytes");
  const plannedRgbaBytes = nonnegativeSafeInteger(ledger.plannedRgbaBytes, "GPU video staging RGBA bytes");
  const plannedPcmBytes = nonnegativeSafeInteger(ledger.plannedPcmBytes, "GPU video staging PCM bytes");
  const totalBytes = nonnegativeSafeInteger(ledger.totalBytes, "GPU video staging total bytes");
  if (totalBytes !== immutableSourceBytes + plannedRgbaBytes + plannedPcmBytes || totalBytes > maxBytes) {
    throw new Error("GPU video staging ledger exceeds its retained budget.");
  }
  const stagingLedgerSha256 = canonicalJsonSha256(ledger);
  assertHashBindings(hashes, { "gpu-video-staging-ledger": stagingLedgerSha256, "gpu-video-pcm": pcmSha256 });
  return { stagingLedgerSha256, pcmSha256 };
}

function assertHashBindings(hashes: Record<string, string>, required: Record<string, string>): void {
  for (const [key, expected] of Object.entries(required)) {
    if (hashes[key] !== expected) throw new Error(`GPU post-render reuse receipt does not bind ${key}.`);
  }
}

function hashRecord(value: unknown, label: string): Record<string, string> {
  const result = record(value, label);
  const output: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(result)) {
    if (!boundedText(key) || !isSha256(candidate)) throw new Error(`${label} contains an invalid hash.`);
    output[key] = candidate;
  }
  return output;
}

function hashObject(value: unknown, keys: string[], label: string): Record<string, string> {
  const result = record(value, label);
  exactKeys(result, keys, label);
  const output: Record<string, string> = {};
  for (const key of keys) output[key] = hash(result[key], `${label} ${key}`);
  return output;
}

function validGpuAdapterProfile(adapter: Record<string, unknown>, limits: Record<string, unknown>, fingerprint: string): boolean {
  exactKeys(adapter, ["cdpVendorId", "cdpDeviceId", "cdpVendor", "cdpDevice", "vendor", "device", "architecture", "description"], "GPU adapter profile"); exactKeys(limits, ["maxTextureDimension2D", "maxBufferSize", "maxStorageBufferBindingSize"], "GPU adapter limits");
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  return positiveSafeInteger(adapter.cdpVendorId) && positiveSafeInteger(adapter.cdpDeviceId) && text(adapter.cdpVendor) && text(adapter.cdpDevice) && text(adapter.vendor) && typeof adapter.device === "string" && (adapter.architecture === null || typeof adapter.architecture === "string") && (adapter.description === null || typeof adapter.description === "string") && (text(adapter.device) || text(adapter.architecture) || text(adapter.description)) && positiveSafeInteger(limits.maxTextureDimension2D) && positiveSafeInteger(limits.maxBufferSize) && positiveSafeInteger(limits.maxStorageBufferBindingSize) && fingerprint === createHash("sha256").update(JSON.stringify({ page: { vendor: adapter.vendor, device: adapter.device, architecture: adapter.architecture, description: adapter.description }, cdp: { vendorId: adapter.cdpVendorId, deviceId: adapter.cdpDeviceId, vendor: adapter.cdpVendor, device: adapter.cdpDevice } })).digest("hex");
}

function sameAttestation(left: ArtifactReceiptAttestation, right: ArtifactReceiptAttestation): boolean {
  return left.role === right.role && left.id === right.id && left.operation === right.operation
    && left.status === right.status && left.rootRelativePath === right.rootRelativePath && left.sha256 === right.sha256;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} must be a plain object.`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label} must contain only enumerable data fields.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function hash(value: unknown, label: string): string {
  if (!isSha256(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isSha256(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function positiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function positiveSafeIntegerField(value: unknown, label: string): number {
  if (!positiveSafeInteger(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}
function boundedText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0"); }
function canonicalRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value)
    && !value.split("/").some((part) => !part || part === "." || part === "..");
}
