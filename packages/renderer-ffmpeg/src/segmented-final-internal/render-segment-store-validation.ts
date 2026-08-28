import { canonicalJson } from "@shellx-motion/core";
import { assertRenderSegmentPlan } from "./render-segment-plan.js";
import { planFingerprint, renderSegmentStoreSchema, segmentArtifactRelativePath, segmentFrameSequenceSha256 } from "./render-segment-store-identity.js";
import { assertGpuSegmentIdentity, assertGpuSegmentRangeProducerEvidence } from "./render-segment-gpu-evidence.js";
import { assertGpuHybridSegmentIdentity, assertGpuHybridSegmentRangeProducerEvidence } from "./render-segment-gpu-hybrid-evidence.js";
import { assertGpuEffectModuleSegmentIdentity, assertGpuEffectModuleSegmentRangeProducerEvidence } from "./render-segment-gpu-effect-module-evidence.js";
import { assertGpuBehaviorSegmentIdentity, assertGpuBehaviorStoreEntry } from "./render-segment-gpu-behavior-evidence.js";
import {
  RENDER_SEGMENT_FRAME_SEQUENCE_SCHEMA,
  RENDER_SEGMENT_DELIVERY_SCHEMA,
  RenderSegmentStoreError,
  type RenderSegmentStoreInput,
  type RenderSegmentCheckpoint,
  type RenderSegmentStoreManifest,
  type RenderSegmentStoreReadbackFacts
} from "./render-segment-store-types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXTENSION = /^\.[a-z0-9]{1,16}$/;

export function createRenderSegmentStoreManifest(input: RenderSegmentStoreInput): RenderSegmentStoreManifest {
  assertOpenInput(input);
  return {
    schema: renderSegmentStoreSchema(input.frameLane, input.producer),
    planFingerprint: planFingerprint(input),
    plan: clone(input.plan),
    package: clone(input.package),
    frameLane: input.frameLane,
    producer: clone(input.producer),
    timeline: clone(input.timeline),
    intermediate: clone(input.intermediate),
    ...(input.delivery ? { delivery: clone(input.delivery) } : {}),
    completed: []
  };
}

/** Validate a persisted manifest and bind it to the current exact render facts. */
export function assertManifestMatchesResumeInput(value: unknown, input: RenderSegmentStoreInput): asserts value is RenderSegmentStoreManifest {
  assertOpenInput(input);
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "planFingerprint", "plan", "package", "frameLane", "producer", "timeline", "intermediate", ...("delivery" in value ? ["delivery"] : []), "completed"])) {
    fail("segment_manifest_invalid", "Segment store manifest must be an exact canonical object.");
  }
  const expectedSchema = renderSegmentStoreSchema(input.frameLane, input.producer);
  if (value.schema !== expectedSchema) {
    fail("segment_store_schema_unsupported", `Segment store schema must equal ${expectedSchema}.`);
  }
  if (!Array.isArray(value.completed)) fail("segment_manifest_invalid", "Segment store manifest completed must be an array.");
  assertRenderSegmentPlan(value.plan);
  const expectedFingerprint = planFingerprint({
    plan: value.plan,
    package: value.package as RenderSegmentStoreInput["package"],
    frameLane: value.frameLane as RenderSegmentStoreInput["frameLane"],
    producer: value.producer as RenderSegmentStoreInput["producer"],
    timeline: value.timeline as RenderSegmentStoreInput["timeline"],
    intermediate: value.intermediate as RenderSegmentStoreInput["intermediate"],
    ...("delivery" in value ? { delivery: value.delivery as RenderSegmentStoreInput["delivery"] } : {})
  });
  if (!isSha256(value.planFingerprint) || value.planFingerprint !== expectedFingerprint) {
    fail("segment_manifest_invalid", "Segment store manifest plan fingerprint does not match its declared facts.");
  }
  const expected = createRenderSegmentStoreManifest(input);
  if (
    value.planFingerprint !== expected.planFingerprint
    || canonicalJson(value.plan) !== canonicalJson(expected.plan)
    || canonicalJson(value.package) !== canonicalJson(expected.package)
    || value.frameLane !== expected.frameLane
    || canonicalJson(value.producer) !== canonicalJson(expected.producer)
    || canonicalJson(value.timeline) !== canonicalJson(expected.timeline)
    || canonicalJson(value.intermediate) !== canonicalJson(expected.intermediate)
    || canonicalJson(value.delivery) !== canonicalJson(expected.delivery)
  ) {
    fail("segment_plan_mismatch", "Segment store plan or immutable render facts do not match this resume request.");
  }
}

/** Verify the sole valid completed shape: a contiguous prefix in canonical plan order. */
export function assertCompletedPrefix(manifest: RenderSegmentStoreManifest): void {
  if (manifest.completed.length > manifest.plan.ranges.length) {
    fail("segment_entry_invalid", "Segment store has more completed entries than its plan.");
  }
  let frameHashCount = 0;
  for (const [position, entry] of manifest.completed.entries()) {
    const expectedRange = manifest.plan.ranges[position];
    assertCheckpoint(entry, expectedRange, manifest);
    frameHashCount += entry.frameHashes.length;
  }
  if (frameHashCount > manifest.plan.frameCount) {
    fail("segment_entry_invalid", "Segment store completed frame hashes exceed the planned frame count.");
  }
}

export function assertReadback(readback: unknown, expected: RenderSegmentStoreManifest["timeline"], frameCount: number): asserts readback is RenderSegmentStoreReadbackFacts {
  if (!isRecord(readback) || !hasExactKeys(readback, ["verified", "frameCount", "width", "height", "fps", "durationMs"]) || readback.verified !== true) fail("segment_readback_invalid", "Segment readback must be explicitly verified.");
  if (
    readback.frameCount !== frameCount
    || readback.width !== expected.width
    || readback.height !== expected.height
    || !isFiniteNumber(readback.fps)
    || !sameFps(readback.fps, expected.fps)
    || !isFiniteNumber(readback.durationMs)
    || readback.durationMs < 0
  ) {
    fail("segment_readback_invalid", "Segment readback facts do not match the planned range and timeline.");
  }
}

function assertDelivery(value: unknown): asserts value is NonNullable<RenderSegmentStoreInput["delivery"]> {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "outputPathSha256", "preset", "audio", "quality", "forceSoftwareEncode", "verifyDeliveredColor"])) {
    fail("segment_plan_invalid", "Segmented final delivery facts must be an exact canonical object.");
  }
  if (value.schema !== RENDER_SEGMENT_DELIVERY_SCHEMA || !isSha256(value.outputPathSha256)) {
    fail("segment_plan_invalid", "Segmented final delivery facts have an invalid schema or output identity.");
  }
  if (value.preset !== "mp4-h264" && value.preset !== "webm-vp9-alpha") {
    fail("segment_plan_invalid", "Segmented final delivery preset is unsupported.");
  }
  if (!Array.isArray(value.audio) || value.audio.length > 64 || value.audio.some((item) => !isRecord(item) || !hasExactKeys(item, ["contentSha256", "controlsSha256"]) || !isSha256(item.contentSha256) || !isSha256(item.controlsSha256))) {
    fail("segment_plan_invalid", "Segmented final delivery audio facts must be bounded path-free hashes.");
  }
  if (!isRecord(value.quality) || !hasExactKeys(value.quality, ["minDurationMs", "minUniqueFrameHashes"])
    || !isFiniteNumber(value.quality.minDurationMs) || value.quality.minDurationMs < 0
    || !Number.isSafeInteger(value.quality.minUniqueFrameHashes) || value.quality.minUniqueFrameHashes < 0 || value.quality.minUniqueFrameHashes > 36_000) {
    fail("segment_plan_invalid", "Segmented final delivery quality facts are invalid.");
  }
  if (typeof value.forceSoftwareEncode !== "boolean" || typeof value.verifyDeliveredColor !== "boolean") {
    fail("segment_plan_invalid", "Segmented final delivery policy flags must be boolean.");
  }
}

function assertCheckpoint(entry: unknown, expectedRange: RenderSegmentStoreManifest["plan"]["ranges"][number], manifest: RenderSegmentStoreManifest): asserts entry is RenderSegmentCheckpoint {
  if (!isRecord(entry) || !hasExactKeys(entry, ["index", "range", "frameSequence", "frameHashes", "blankFrameCount", "producer", "artifact", "readback"]) || entry.index !== expectedRange.index || canonicalJson(entry.range) !== canonicalJson(expectedRange)) {
    fail("segment_entry_invalid", "Segment checkpoints must be a contiguous canonical plan prefix.");
  }
  if (!isRecord(entry.frameSequence) || !hasExactKeys(entry.frameSequence, ["schema", "sha256"]) || entry.frameSequence.schema !== RENDER_SEGMENT_FRAME_SEQUENCE_SCHEMA || !isSha256(entry.frameSequence.sha256)) {
    fail("segment_entry_invalid", "Segment checkpoint frame-sequence evidence is invalid.");
  }
  if (!Array.isArray(entry.frameHashes) || entry.frameHashes.length !== expectedRange.frameCount || entry.frameHashes.some((hash) => !isSha256(hash))) {
    fail("segment_entry_invalid", "Segment checkpoint frame hashes must be ordered lowercase SHA-256 values for its exact range.");
  }
  if (!Number.isSafeInteger(entry.blankFrameCount) || entry.blankFrameCount < 0 || entry.blankFrameCount > expectedRange.frameCount) {
    fail("segment_entry_invalid", "Segment checkpoint blank-frame count must be bounded by its exact range.");
  }
  if (manifest.frameLane === "gpu" && manifest.producer.frameLane === "gpu") {
    if (manifest.producer.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1") {
      assertGpuHybridSegmentRangeProducerEvidence({
        value: entry.producer,
        identity: manifest.producer.identity,
        packageFacts: manifest.package,
        range: expectedRange,
        timeline: manifest.timeline,
        frameHashes: entry.frameHashes
      });
    } else if (manifest.producer.identity.schema === "shellx-motion/gpu-effect-module-segmented-identity@1") {
      assertGpuEffectModuleSegmentRangeProducerEvidence({
        value: entry.producer,
        identity: manifest.producer.identity,
        packageFacts: manifest.package,
        range: expectedRange,
        timeline: manifest.timeline,
        frameHashes: entry.frameHashes
      });
    } else if (manifest.producer.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1") {
      assertGpuBehaviorStoreEntry(entry.producer, manifest.producer.identity, manifest.package, expectedRange, manifest.timeline, entry.frameHashes);
    } else {
      assertGpuSegmentRangeProducerEvidence({
        value: entry.producer,
        identity: manifest.producer.identity,
        packageFacts: manifest.package,
        range: expectedRange,
        timeline: manifest.timeline,
        frameHashes: entry.frameHashes
      });
    }
  } else if (manifest.producer.frameLane !== "gpu") {
    assertLegacyProducerEvidence(entry.producer, manifest.producer);
  } else {
    fail("segment_entry_invalid", "Segment store frame lane and producer facts disagree.");
  }
  if (entry.frameSequence.sha256 !== segmentFrameSequenceSha256(entry as RenderSegmentCheckpoint)) {
    fail("segment_entry_invalid", "Segment checkpoint frame hashes do not match its frame-sequence evidence.");
  }
  if (!isRecord(entry.artifact) || !hasExactKeys(entry.artifact, ["path", "sha256", "byteLength"]) || entry.artifact.path !== segmentArtifactRelativePath(entry.index, manifest.intermediate.extension) || !isSha256(entry.artifact.sha256) || !positiveSafeInteger(entry.artifact.byteLength)) {
    fail("segment_entry_invalid", "Segment checkpoint artifact facts are invalid or use a non-deterministic path.");
  }
  assertReadback(entry.readback, manifest.timeline, expectedRange.frameCount);
}

function assertLegacyProducerEvidence(value: unknown, producer: Exclude<RenderSegmentStoreManifest["producer"], { frameLane: "gpu" }>): void {
  const frameLane = producer.frameLane;
  const expectedKeys = ["schema", "frameLane", ...(frameLane === "browser" ? ["scriptExecution"] : []), "warningUnion", "warningsOmitted"];
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys)
    || value.schema !== "shellx-motion/segment-range-producer@1"
    || value.frameLane !== frameLane
    || !Array.isArray(value.warningUnion)
    || value.warningUnion.length > 64
    || value.warningUnion.some((warning) => typeof warning !== "string" || warning.length > 400)
    || !Number.isSafeInteger(value.warningsOmitted)
    || value.warningsOmitted < 0) {
    fail("segment_entry_invalid", "Segment checkpoint producer evidence is invalid or does not match its frame lane.");
  }
  if (frameLane === "browser" && !isScriptExecutionEvidence(value.scriptExecution)) {
    fail("segment_entry_invalid", "Browser segment checkpoints require a bounded script-execution verdict.");
  }
  if (canonicalJson((value as { scriptExecution?: unknown }).scriptExecution)
    !== canonicalJson(frameLane === "browser" ? producer.scriptExecution : undefined)) {
    fail("segment_entry_invalid", "Segment checkpoint producer verdict does not match the immutable render plan.");
  }
}

function isScriptExecutionEvidence(value: unknown): boolean {
  if (!isRecord(value) || value.schema !== "shellx-motion/script-execution@1"
    || value.resolverVersion !== 1 || !Array.isArray(value.sources) || value.sources.length > 256) return false;
  if (value.detectedClass === "data-only") {
    return (value.requestedMode === "none" || value.requestedMode === "unrecognized" || value.requestedMode === "trusted-local-agent-authored")
      && value.activeMode === "data-only" && value.sources.length === 0
      && hasExactKeys(value, ["schema", "detectedClass", "requestedMode", "activeMode", "resolverVersion", "sources"]);
  }
  if (value.detectedClass !== "active-content" || value.requestedMode !== "trusted-local-agent-authored"
    || value.activeMode !== "trusted-local-agent-authored" || !isSha256(value.packageSnapshotSha256)
    || !safeText(value.attestationId, 128) || !hasExactKeys(value, [
      "schema", "detectedClass", "requestedMode", "activeMode", "resolverVersion",
      "packageSnapshotSha256", "attestationId", "sources", "entry"
    ])) return false;
  const sources = value.sources.filter(isActiveScriptSource);
  if (sources.length === 0 || sources.length !== value.sources.length || new Set(sources.map((source) => source.layerId)).size !== sources.length) return false;
  return isActiveScriptSource(value.entry) && sources.some((source) => canonicalJson(source) === canonicalJson(value.entry));
}

function isActiveScriptSource(value: unknown): value is { layerId: string; layerType: "web" | "html" | "canvas"; path: string; sha256: string; bytes: number } {
  return isRecord(value) && hasExactKeys(value, ["layerId", "layerType", "path", "sha256", "bytes"])
    && safeText(value.layerId, 256)
    && (value.layerType === "web" || value.layerType === "html" || value.layerType === "canvas")
    && safePackagePath(value.path) && isSha256(value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0;
}

function safePackagePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
    && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..");
}

function safeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertOpenInput(input: RenderSegmentStoreInput): void {
  assertRenderSegmentPlan(input.plan);
  if (typeof input.verifyReadback !== "function") {
    fail("segment_plan_invalid", "Segment stores require a readback verifier before any checkpoint can be created or resumed.");
  }
  if (!isRecord(input.package) || !hasExactKeys(input.package, ["id", "manifestSha256", "contentSha256"]) || !PACKAGE_ID.test(input.package.id) || !isSha256(input.package.manifestSha256) || !isSha256(input.package.contentSha256)) {
    fail("segment_plan_invalid", "Segment store package facts must contain a safe id plus manifest and complete-content lowercase SHA-256 values.");
  }
  if (input.frameLane !== "browser" && input.frameLane !== "native" && input.frameLane !== "gpu") fail("segment_plan_invalid", "Segment store frame lane must be browser, native, or internal GPU.");
  assertProducerFacts(input.producer, input.frameLane, input.package, input.plan.frameCount);
  if (
    !isRecord(input.timeline)
    || !hasExactKeys(input.timeline, ["motionSha256", "durationMs", "fps", "width", "height"])
    || !isSha256(input.timeline.motionSha256)
    || !positiveSafeInteger(input.timeline.width)
    || !positiveSafeInteger(input.timeline.height)
    || !isFiniteNumber(input.timeline.durationMs)
    || input.timeline.durationMs <= 0
    || !isFiniteNumber(input.timeline.fps)
    || input.timeline.fps <= 0
  ) {
    fail("segment_plan_invalid", "Segment store timeline facts are invalid.");
  }
  if (
    !isRecord(input.intermediate)
    || !hasExactKeys(input.intermediate, ["container", "codec", "extension"])
    || !nonEmptyString(input.intermediate.container)
    || !nonEmptyString(input.intermediate.codec)
    || !EXTENSION.test(input.intermediate.extension)
  ) {
    fail("segment_plan_invalid", "Segment store intermediate facts require a deterministic lowercase extension.");
  }
  if (input.delivery !== undefined) assertDelivery(input.delivery);
}

function assertProducerFacts(
  value: unknown,
  frameLane: RenderSegmentStoreManifest["frameLane"],
  packageFacts: RenderSegmentStoreInput["package"],
  frameCount: number
): void {
  const expectedKeys = frameLane === "browser" ? ["frameLane", "scriptExecution"] : frameLane === "gpu" ? ["frameLane", "identity"] : ["frameLane"];
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys) || value.frameLane !== frameLane) {
    fail("segment_plan_invalid", "Segment store producer facts must exactly match the selected frame lane.");
  }
  if (frameLane === "browser" && !isScriptExecutionEvidence(value.scriptExecution)) {
    fail("segment_plan_invalid", "Browser segment stores require a current host-owned script verdict.");
  }
  if (frameLane === "gpu") {
    if (isRecord(value.identity) && value.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1") {
      assertGpuHybridSegmentIdentity(value.identity, packageFacts, frameCount, "segment_plan_invalid");
    } else if (isRecord(value.identity) && value.identity.schema === "shellx-motion/gpu-effect-module-segmented-identity@1") {
      assertGpuEffectModuleSegmentIdentity(value.identity, packageFacts, frameCount, "segment_plan_invalid");
    } else if (isRecord(value.identity) && value.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1") {
      assertGpuBehaviorSegmentIdentity(value.identity, packageFacts, frameCount, "segment_plan_invalid");
    } else {
      assertGpuSegmentIdentity(value.identity, packageFacts, frameCount, "segment_plan_invalid");
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** FFprobe reports rational cadence; retain its observation while allowing only representation drift. */
function sameFps(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(0.0001, expected * 0.00001);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function fail(code: ConstructorParameters<typeof RenderSegmentStoreError>[0], message: string): never {
  throw new RenderSegmentStoreError(code, message);
}
