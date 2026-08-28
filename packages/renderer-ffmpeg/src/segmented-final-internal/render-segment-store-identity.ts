import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonSha256, streamingFrameTimestampMs } from "@shellx-motion/core";
import {
  RENDER_SEGMENT_FRAME_SEQUENCE_SCHEMA,
  RENDER_SEGMENT_STORE_SCHEMA,
  RenderSegmentStoreError,
  type RenderSegmentCheckpoint,
  type RenderSegmentPlan,
  type RenderSegmentStoreIntermediateFacts,
  type RenderSegmentStoreManifest,
  type RenderSegmentStorePackageFacts,
  type RenderSegmentStoreProducerFacts,
  type RenderSegmentStoreTimelineFacts,
  type RenderSegmentStoreDeliveryFacts,
  type RenderSegmentStoreFrameLane,
  RENDER_GPU_SEGMENT_STORE_SCHEMA,
  RENDER_GPU_HYBRID_SEGMENT_STORE_SCHEMA,
  RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA,
  RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA
} from "./render-segment-store-types.js";

const GPU_HYBRID_CAPTURE_PLAN_SCHEMA = "shellx-motion/gpu-hybrid-capture-plan@1" as const;

export function planFingerprint(input: {
  plan: RenderSegmentPlan;
  package: RenderSegmentStorePackageFacts;
  frameLane: RenderSegmentStoreFrameLane;
  producer: RenderSegmentStoreProducerFacts;
  timeline: RenderSegmentStoreTimelineFacts;
  intermediate: RenderSegmentStoreIntermediateFacts;
  delivery?: RenderSegmentStoreDeliveryFacts;
}): string {
  return canonicalJsonSha256({
    schema: renderSegmentStoreSchema(input.frameLane, input.producer),
    plan: input.plan,
    package: input.package,
    frameLane: input.frameLane,
    producer: input.producer,
    timeline: input.timeline,
    intermediate: input.intermediate,
    ...(input.delivery ? { delivery: input.delivery } : {})
  });
}

/** Schema selection is immutable producer identity, never a caller flag. */
export function renderSegmentStoreSchema(
  frameLane: RenderSegmentStoreFrameLane,
  producer: RenderSegmentStoreProducerFacts
): typeof RENDER_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_HYBRID_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA {
  if (frameLane !== "gpu") return RENDER_SEGMENT_STORE_SCHEMA;
  if (producer.frameLane !== "gpu") {
    throw new RenderSegmentStoreError("segment_plan_invalid", "GPU segment stores require one immutable GPU producer identity.");
  }
  if (producer.identity.schema === "shellx-motion/gpu-hybrid-segmented-identity@1") return RENDER_GPU_HYBRID_SEGMENT_STORE_SCHEMA;
  if (producer.identity.schema === "shellx-motion/gpu-effect-module-segmented-identity@1") return RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA;
  if (producer.identity.schema === "shellx-motion/gpu-behavior-segmented-identity@1") return RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA;
  return RENDER_GPU_SEGMENT_STORE_SCHEMA;
}

/** Store only a deterministic relative artifact name; the absolute root is host-owned input, never evidence. */
export function segmentArtifactRelativePath(index: number, extension: string): string {
  return `segments/segment-${String(index + 1).padStart(6, "0")}${extension}`;
}

/** The sole owned incomplete target for a segment. It is never persisted in a manifest. */
export function temporarySegmentBasename(index: number, extension: string): string {
  return `.segment-${String(index + 1).padStart(6, "0")}${extension}.partial`;
}

export function segmentFrameSequenceSha256(entry: Pick<RenderSegmentCheckpoint, "range" | "frameHashes">): string {
  return canonicalJsonSha256({
    schema: RENDER_SEGMENT_FRAME_SEQUENCE_SCHEMA,
    range: entry.range,
    frameHashes: entry.frameHashes
  });
}

/**
 * GPU ranges retain raw-frame hashes rather than PNG artifacts.  Bind their
 * global canonical indexes and exact timestamps so an ordered durable prefix
 * cannot be replayed at a shifted cadence.
 */
export function gpuRangeFrameSequenceSha256(input: {
  range: RenderSegmentCheckpoint["range"];
  timeline: Pick<RenderSegmentStoreTimelineFacts, "fps" | "durationMs">;
  frameHashes: readonly string[];
}): string {
  return canonicalJsonSha256({
    schema: "shellx-motion/gpu-segment-range-frame-sequence@1",
    range: input.range,
    frames: input.frameHashes.map((sha256, offset) => ({
      index: input.range.startFrame + offset,
      atMs: streamingFrameTimestampMs(input.range.startFrame + offset, input.timeline.fps, input.timeline.durationMs),
      sha256
    }))
  });
}

/** Equivalent ordered Core frame-plan evidence for one GPU range. */
export function gpuRangeFramePlanSequenceSha256(input: {
  range: RenderSegmentCheckpoint["range"];
  timeline: Pick<RenderSegmentStoreTimelineFacts, "fps" | "durationMs">;
  framePlanFingerprints: readonly string[];
}): string {
  return canonicalJsonSha256({
    schema: "shellx-motion/gpu-segment-range-plan-sequence@1",
    range: input.range,
    frames: input.framePlanFingerprints.map((fingerprint, offset) => ({
      index: input.range.startFrame + offset,
      atMs: streamingFrameTimestampMs(input.range.startFrame + offset, input.timeline.fps, input.timeline.durationMs),
      fingerprint
    }))
  });
}

/** Immutable Core-request plan retained before a hybrid durable store can open. */
export function gpuHybridCapturePlanSha256(entries: readonly {
  index: number;
  atMs: number;
  atUs: number;
  requestFingerprint: string;
}[]): string {
  return canonicalJsonSha256({ schema: GPU_HYBRID_CAPTURE_PLAN_SCHEMA, entries });
}

/** Browser defines each range ledger digest as the canonical ordered entry array. */
export function gpuHybridRangeLedgerSequenceSha256(entries: readonly unknown[]): string {
  return canonicalJsonSha256(entries);
}

/**
 * Byte-for-byte reconstruction of core's streamed-frame-sequence identity. Segment hashes are
 * deliberately not folded here: ordered global frame hashes are the source evidence used by the
 * existing streaming accumulator, so this preserves its receipt identity across a resume.
 */
export function fullStreamedFrameSequenceSha256(manifest: Pick<RenderSegmentStoreManifest, "plan" | "timeline" | "completed">): string {
  const frameHashCount = manifest.completed.reduce((total, entry) => total + entry.frameHashes.length, 0);
  if (manifest.completed.length !== manifest.plan.ranges.length || frameHashCount !== manifest.plan.frameCount) {
    throw new RenderSegmentStoreError("segment_entry_invalid", "A full streamed-frame identity requires every canonical segment and frame hash.");
  }
  const identity = createHash("sha256");
  identity.update(JSON.stringify({
    schema: "shellx-motion/streamed-frame-sequence@1",
    frameCount: manifest.plan.frameCount,
    durationMs: manifest.timeline.durationMs,
    fps: manifest.timeline.fps,
    width: manifest.timeline.width,
    height: manifest.timeline.height
  }));
  identity.update("\n");
  for (const entry of manifest.completed) {
    for (const [offset, sha256] of entry.frameHashes.entries()) {
      const index = entry.range.startFrame + offset;
      identity.update(`${index}:${streamingFrameTimestampMs(index, manifest.timeline.fps, manifest.timeline.durationMs)}:${sha256}\n`);
    }
  }
  return identity.digest("hex");
}

/** Exact, bounded-by-plan source for a later final adapter's resumed unique-frame evidence. */
export function completedFrameHashSummary(manifest: Pick<RenderSegmentStoreManifest, "completed">): {
  frameCount: number;
  uniqueFrameHashes: number;
} {
  const hashes = manifest.completed.flatMap((entry) => entry.frameHashes);
  return { frameCount: hashes.length, uniqueFrameHashes: new Set(hashes).size };
}

export function canonicalManifestText(manifest: RenderSegmentStoreManifest): string {
  return `${canonicalJson(manifest)}\n`;
}
