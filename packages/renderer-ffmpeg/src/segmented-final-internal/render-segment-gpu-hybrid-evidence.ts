/** Strict, hybrid-only GPU checkpoint proof.  Legacy GPU schema stays separate. */
import {
  canonicalJson,
  canonicalJsonSha256,
  streamingFrameTimestampMs
} from "@shellx-motion/core";
import { gpuSegmentedHybridAdmissionIdentityProblem } from "@shellx-motion/renderer-browser";
import { gpuEnvironmentArenaEvidence } from "../gpu-final-receipt-provenance.js";
import {
  gpuHybridCapturePlanSha256,
  gpuHybridRangeLedgerSequenceSha256,
  gpuRangeFramePlanSequenceSha256,
  gpuRangeFrameSequenceSha256
} from "./render-segment-store-identity.js";
import { assertGpuSegmentIdentity } from "./render-segment-gpu-evidence.js";
import {
  RENDER_GPU_HYBRID_SEGMENTED_IDENTITY_SCHEMA,
  RENDER_GPU_HYBRID_SEGMENT_RANGE_PRODUCER_SCHEMA,
  RenderSegmentStoreError,
  type RenderSegmentGpuHybridIdentity,
  type RenderSegmentGpuHybridRangeProducerEvidence,
  type RenderSegmentRange,
  type RenderSegmentStorePackageFacts,
  type RenderSegmentStoreTimelineFacts
} from "./render-segment-store-types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE_RECEIPT_KEYS = [
  "gpu-pipeline-catalog", "gpu-static-plan", "gpu-static-plan-document", "gpu-static-plan-resources",
  "gpu-static-scene", "gpu-static-inputs", "gpu-adapter", "gpu-runtime", "gpu-containment",
  "gpu-hybrid-admission", "gpu-hybrid-capture-plan"
] as const;
const RANGE_RECEIPT_KEYS = [
  "gpu-resource-budget", "gpu-session-resources", "gpu-readback-transport",
  "gpu-frame-sequence", "gpu-frame-plan-sequence", "gpu-hybrid-range-ledger"
] as const;

export function assertGpuHybridSegmentIdentity(
  value: unknown,
  packageFacts: RenderSegmentStorePackageFacts,
  frameCount: number,
  code: "segment_plan_invalid" | "segment_entry_invalid" = "segment_plan_invalid"
): asserts value is RenderSegmentGpuHybridIdentity {
  if (!record(value) || !exactKeys(value, [
    "schema", "packageContentSha256", "pipelineCatalogSha256", "staticPlan", "staticScene", "hostVerdict", "hybrid",
    ...("videoStaging" in value ? ["videoStaging"] : [])
  ]) || value.schema !== RENDER_GPU_HYBRID_SEGMENTED_IDENTITY_SCHEMA) {
    fail(code, "Hybrid GPU segmented identity has an unknown, missing, or legacy wire field.");
  }
  const { hybrid, ...legacy } = value;
  assertGpuSegmentIdentity({ ...legacy, schema: "shellx-motion/gpu-segmented-identity@1" }, packageFacts, frameCount, code);
  assertHybridIdentity(hybrid, value as unknown as RenderSegmentGpuHybridIdentity, frameCount, code);
}

export function assertGpuHybridSegmentRangeProducerEvidence(input: {
  value: unknown;
  identity: RenderSegmentGpuHybridIdentity;
  packageFacts: RenderSegmentStorePackageFacts;
  range: RenderSegmentRange;
  timeline: RenderSegmentStoreTimelineFacts;
  frameHashes: readonly string[];
}): asserts input is typeof input & { value: RenderSegmentGpuHybridRangeProducerEvidence } {
  const { value, identity, packageFacts, range, timeline, frameHashes } = input;
  if (!record(value) || !exactKeys(value, [
    "schema", "frameLane", "identity", "frameSequenceSha256", "framePlanSequenceSha256", "framePlanFingerprints",
    "hybrid", "finalReceiptInputHashes", "warningUnion", "warningsOmitted",
    ...(identity.staticPlan.maxEnvironmentCount > 0 ? ["environmentArena"] : [])
  ]) || value.schema !== RENDER_GPU_HYBRID_SEGMENT_RANGE_PRODUCER_SCHEMA || value.frameLane !== "gpu") {
    fail("segment_entry_invalid", "Hybrid GPU checkpoints require their exact distinct range-evidence schema.");
  }
  assertGpuHybridSegmentIdentity(value.identity, packageFacts, identity.staticPlan.canonicalFrameCount, "segment_entry_invalid");
  if (canonicalJson(value.identity) !== canonicalJson(identity)) {
    fail("segment_entry_invalid", "Hybrid GPU range identity conflicts with the immutable pre-store admission.");
  }
  if (!Array.isArray(value.framePlanFingerprints) || value.framePlanFingerprints.length !== range.frameCount
    || value.framePlanFingerprints.some((fingerprint) => !sha(fingerprint))
    || !sha(value.frameSequenceSha256) || !sha(value.framePlanSequenceSha256)
    || value.frameSequenceSha256 !== gpuRangeFrameSequenceSha256({ range, timeline, frameHashes })
    || value.framePlanSequenceSha256 !== gpuRangeFramePlanSequenceSha256({ range, timeline, framePlanFingerprints: value.framePlanFingerprints })) {
    fail("segment_entry_invalid", "Hybrid GPU range frame or Core frame-plan sequence does not cover its canonical range.");
  }
  assertEnvironmentArena(value.environmentArena, identity, range);
  assertRangeHybrid(value.hybrid, identity, range, timeline);
  assertReceiptHashes(value.finalReceiptInputHashes, identity, value.frameSequenceSha256, value.framePlanSequenceSha256, (value.hybrid as { ledger: { sequenceSha256: string } }).ledger.sequenceSha256);
  assertWarnings(value.warningUnion, value.warningsOmitted);
}

function assertHybridIdentity(value: unknown, identity: RenderSegmentGpuHybridIdentity, frameCount: number, code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  if (!record(value) || !exactKeys(value, ["admission", "capturePlan"])) {
    fail(code, "Hybrid GPU identity must retain its Browser admission and Core request plan.");
  }
  const admission = value.admission;
  if (!record(admission) || !exactKeys(admission, ["schema", "staticPlanFingerprint", "descriptor", "sourceSnapshot", "captureContractSha256", "browser", "dynamicTexture", "policy", "bootstrap"])
    || admission.schema !== "shellx-motion/gpu-segmented-hybrid-admission@1" || admission.staticPlanFingerprint !== identity.staticPlan.fingerprint
    || gpuSegmentedHybridAdmissionIdentityProblem(admission as never) !== null
    || !record(admission.browser) || !exactKeys(admission.browser, ["name", "version", "executableSha256", "runtimePolicy"])
    || admission.browser.name !== "chromium" || admission.browser.version !== identity.hostVerdict.browser.version
    || admission.browser.executableSha256 !== identity.hostVerdict.browser.executableSha256
    || admission.browser.runtimePolicy !== "borrowed-precontained-chromium-data-only-no-network") {
    fail(code, "Hybrid GPU Browser admission does not bind exact source, browser, policy, and reserved texture facts.");
  }
  const plan = value.capturePlan;
  if (!record(plan) || !exactKeys(plan, ["schema", "entries", "sha256"]) || plan.schema !== "shellx-motion/gpu-hybrid-capture-plan@1"
    || !Array.isArray(plan.entries) || plan.entries.length < 1 || plan.entries.length > frameCount || !sha(plan.sha256)
    || !capturePlanEntries(plan.entries, frameCount) || plan.sha256 !== gpuHybridCapturePlanSha256(plan.entries as never)) {
    fail(code, "Hybrid GPU capture plan must be a bounded canonical Core request sequence.");
  }
  assertBootstrap(admission.bootstrap, plan.entries as never, code);
}

function assertRangeHybrid(value: unknown, identity: RenderSegmentGpuHybridIdentity, range: RenderSegmentRange, timeline: RenderSegmentStoreTimelineFacts): void {
  if (!record(value) || !exactKeys(value, ["ledger", "cleanup"])) fail("segment_entry_invalid", "Hybrid GPU range lacks its Browser ledger or cleanup evidence.");
  const expected = identity.hybrid.capturePlan.entries.filter((entry) => entry.index >= range.startFrame && entry.index < range.endFrameExclusive);
  assertLedger(value.ledger, identity, range, expected, "segment_entry_invalid");
  assertCleanup(value.cleanup, identity.hybrid.admission.dynamicTexture, expected.length, "segment_entry_invalid");
  const ledger = value.ledger as { entries: Array<Record<string, unknown>> };
  if (expected.some((entry) => entry.index === identity.hybrid.admission.bootstrap.index)) {
    const entry = ledger.entries.find((candidate) => candidate.index === identity.hybrid.admission.bootstrap.index);
    const { cleanup: _bootstrapCleanup, ...bootstrapEntry } = identity.hybrid.admission.bootstrap;
    if (!entry || canonicalJson(entry) !== canonicalJson(bootstrapEntry)) {
      fail("segment_entry_invalid", "Hybrid GPU range does not reproduce the frozen pre-store bootstrap pixels.");
    }
  }
  if (expected.some((entry) => streamingFrameTimestampMs(entry.index, timeline.fps, timeline.durationMs) !== entry.atMs)) {
    fail("segment_entry_invalid", "Hybrid GPU capture plan timestamps differ from the durable timeline cadence.");
  }
}

function assertLedger(value: unknown, identity: RenderSegmentGpuHybridIdentity, range: { index: number; startFrame: number; endFrameExclusive: number }, expected: readonly { index: number; atMs: number; atUs: number; requestFingerprint: string }[], code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  if (!record(value) || !exactKeys(value, ["schema", "rangeIndex", "startFrameIndex", "endFrameIndexExclusive", "expectedCaptureCount", "captureCount", "entries", "sequenceSha256"])
    || value.schema !== "shellx-motion/gpu-segmented-hybrid-range-ledger@1" || value.rangeIndex !== range.index
    || value.startFrameIndex !== range.startFrame || value.endFrameIndexExclusive !== range.endFrameExclusive
    || value.expectedCaptureCount !== expected.length || value.captureCount !== expected.length || !Array.isArray(value.entries)
    || value.entries.length !== expected.length || !sha(value.sequenceSha256)
    || value.sequenceSha256 !== gpuHybridRangeLedgerSequenceSha256(value.entries)) {
    fail(code, "Hybrid GPU ledger does not bind one exact ordered range transaction.");
  }
  for (const [offset, entry] of value.entries.entries()) {
    const plan = expected[offset];
    if (!record(entry) || !exactKeys(entry, ["index", "atMs", "atUs", "requestFingerprint", "resourceId", "width", "height", "pngSha256", "decodedRgbaSha256"])
      || !plan || canonicalJson(projectEntry(entry)) !== canonicalJson(plan)
      || entry.resourceId !== identity.hybrid.admission.dynamicTexture.id
      || entry.width !== identity.hybrid.admission.dynamicTexture.width || entry.height !== identity.hybrid.admission.dynamicTexture.height
      || !sha(entry.pngSha256) || !sha(entry.decodedRgbaSha256)) {
      fail(code, "Hybrid GPU ledger contains a shifted, forged, or dimension-mismatched capture entry.");
    }
  }
}

function assertCleanup(value: unknown, dynamic: unknown, expectedCaptureCount: number, code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  const active = expectedCaptureCount > 0;
  if (!record(value) || !exactKeys(value, ["captureContext", "scratch", "dynamicTexture"])
    || value.captureContext !== (active ? "closed" : "not-opened") || value.scratch !== (active ? "released" : "not-opened")
    || canonicalJson(value.dynamicTexture) !== canonicalJson(dynamicReservation(dynamic))) {
    fail(code, "Hybrid GPU capture cleanup did not close its borrowed context and exact private scratch child.");
  }
}

function assertBootstrap(value: unknown, entries: readonly { index: number; atMs: number; atUs: number; requestFingerprint: string }[], code: "segment_plan_invalid" | "segment_entry_invalid"): void {
  const first = entries[0];
  if (!record(value) || !first || !exactKeys(value, ["index", "atMs", "atUs", "requestFingerprint", "resourceId", "width", "height", "pngSha256", "decodedRgbaSha256", "cleanup"])
    || canonicalJson(projectEntry(value)) !== canonicalJson(first)
    || !sha(value.pngSha256) || !sha(value.decodedRgbaSha256)) {
    fail(code, "Hybrid GPU bootstrap does not bind the first Core request to exact observed pixels and texture dimensions.");
  }
}

function assertReceiptHashes(value: unknown, identity: RenderSegmentGpuHybridIdentity, frameSequenceSha256: string, framePlanSequenceSha256: string, rangeLedgerSha256: string): void {
  if (!record(value)) fail("segment_entry_invalid", "Hybrid GPU range receipt input hashes are missing.");
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
    "gpu-hybrid-admission": canonicalJsonSha256(identity.hybrid.admission),
    "gpu-hybrid-capture-plan": identity.hybrid.capturePlan.sha256,
    "gpu-hybrid-range-ledger": rangeLedgerSha256,
    ...(identity.videoStaging ? { "gpu-video-staging-ledger": identity.videoStaging.ledgerSha256, "gpu-video-pcm": identity.videoStaging.pcmSha256 } : {})
  };
  const required = [
    ...IMMUTABLE_RECEIPT_KEYS, ...RANGE_RECEIPT_KEYS,
    ...(identity.staticPlan.maxEnvironmentCount > 0 ? ["gpu-environment-arena"] : []),
    ...(identity.videoStaging ? ["gpu-video-staging-ledger", "gpu-video-pcm"] : [])
  ];
  if (!exactKeys(value, required) || Object.values(value).some((hash) => !sha(hash))) {
    fail("segment_entry_invalid", "Hybrid GPU receipt projection has an unknown, missing, or malformed digest.");
  }
  for (const [key, hash] of Object.entries(expected)) if (value[key] !== hash) {
    fail("segment_entry_invalid", `Hybrid GPU receipt digest ${key} conflicts with immutable or ordered evidence.`);
  }
}

function assertEnvironmentArena(value: unknown, identity: RenderSegmentGpuHybridIdentity, range: RenderSegmentRange): void {
  if (identity.staticPlan.maxEnvironmentCount === 0) {
    if (value !== undefined) fail("segment_entry_invalid", "Hybrid no-environment GPU range cannot retain an environment arena.");
    return;
  }
  if (!record(value) || !record(value.resourceBudget) || !record(value.frameArena) || !record(value.uniforms)) {
    fail("segment_entry_invalid", "Hybrid environment range requires complete arena evidence.");
  }
  const rebuilt = gpuEnvironmentArenaEvidence({
    staticPlan: { fingerprint: identity.staticPlan.fingerprint, canonicalFrameCount: identity.staticPlan.canonicalFrameCount, maxima: { maxEnvironmentCount: identity.staticPlan.maxEnvironmentCount } },
    resourceBudget: { expectedFrames: range.frameCount, observedFrames: range.frameCount, maxima: { environmentCount: value.resourceBudget.maxEnvironmentDrawsPerFrame as number, environmentUniformBytes: value.resourceBudget.maxEnvironmentUniformBytesPerFrame as number } },
    sessionResources: {
      environmentUniformCapacitySlots: value.uniforms.capacitySlots as number, environmentUniformBytes: value.uniforms.bytes as number,
      environmentUniformHighWaterSlots: value.uniforms.highWaterSlots as number, environmentUniformHighWaterBytes: value.uniforms.highWaterBytes as number,
      environmentUniformLateAllocationRefusals: value.uniforms.lateAllocationRefusals as number, environmentDrawsRendered: value.environmentDrawsRendered as number,
      environmentEnvelopeReservations: value.environmentEnvelopeReservations as number, frameArenaReservations: value.frameArena.reservations as number,
      frameArenaLateAllocationRefusals: value.frameArena.lateAllocationRefusals as number, frameArenaReconfigurations: value.frameArena.reconfigurations as number,
      frameArenaBytes: value.frameArena.bytes as number, frameArenaHighWaterBytes: value.frameArena.highWaterBytes as number
    },
    range
  });
  if (!rebuilt || canonicalJson(rebuilt) !== canonicalJson(value)) fail("segment_entry_invalid", "Hybrid environment arena conflicts with its range-local reservation relation.");
}

function dynamicTexture(value: unknown, sourceSha256: unknown, descriptorValue: unknown): boolean {
  return record(value) && record(descriptorValue) && exactKeys(value, ["id", "width", "height", "sourceSha256", "bytes"])
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id as string) && value.width === descriptorValue.width && value.height === descriptorValue.height
    && value.sourceSha256 === sourceSha256 && Number.isSafeInteger(value.bytes) && value.bytes === (value.width as number) * (value.height as number) * 4 && value.bytes > 0 && value.bytes <= 256 * 1024 * 1024;
}

function capturePlanEntries(entries: readonly unknown[], frameCount: number): boolean {
  let previous = -1;
  for (const entry of entries) {
    if (!record(entry) || !exactKeys(entry, ["index", "atMs", "atUs", "requestFingerprint"])
      || !Number.isSafeInteger(entry.index) || !Number.isFinite(entry.atMs) || !Number.isSafeInteger(entry.atUs)
      || !sha(entry.requestFingerprint)) return false;
    const index = entry.index as number;
    const atMs = entry.atMs as number;
    const atUs = entry.atUs as number;
    if (index <= previous || index < 0 || index >= frameCount || Math.round(atMs * 1_000) !== atUs) return false;
    previous = index;
  }
  return true;
}

function projectEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return { index: entry.index, atMs: entry.atMs, atUs: entry.atUs, requestFingerprint: entry.requestFingerprint };
}

function assertWarnings(value: unknown, omitted: unknown): void {
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || item.length > 400)
    || !Number.isSafeInteger(omitted) || (omitted as number) < 0) fail("segment_entry_invalid", "Hybrid GPU warnings are invalid.");
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: object, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function positiveDimension(value: unknown): boolean { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4_096; }
function dynamicReservation(value: unknown): unknown {
  if (!record(value)) return value;
  return { id: value.id, width: value.width, height: value.height, sourceSha256: value.sourceSha256 };
}
function fail(code: "segment_plan_invalid" | "segment_entry_invalid", message: string): never { throw new RenderSegmentStoreError(code, message); }
