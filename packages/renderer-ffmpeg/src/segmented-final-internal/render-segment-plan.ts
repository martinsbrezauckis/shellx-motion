import { MOTION_DOCUMENT_LIMITS } from "@shellx-motion/core";
import {
  MAX_RENDER_SEGMENTS,
  RENDER_SEGMENT_PLAN_SCHEMA,
  RenderSegmentStoreError,
  type RenderSegmentPlan,
  type RenderSegmentRange
} from "./render-segment-store-types.js";

/** The existing global render ceiling also bounds persisted frame-hash checkpoint data. */
export const MAX_RENDER_SEGMENT_STORE_FRAMES = MOTION_DOCUMENT_LIMITS.maxFrames;

/** Create the one deterministic, non-overlapping, full-coverage partition accepted by the segment store. */
export function planRenderSegments(input: { frameCount: number; segmentFrames: number }): RenderSegmentPlan {
  assertPositiveSafeInteger(input.frameCount, "frameCount");
  assertPositiveSafeInteger(input.segmentFrames, "segmentFrames");
  if (input.frameCount > MAX_RENDER_SEGMENT_STORE_FRAMES) {
    throw new RenderSegmentStoreError(
      "segment_frame_budget_exceeded",
      `Segmented rendering accepts at most ${MAX_RENDER_SEGMENT_STORE_FRAMES} frames; received ${input.frameCount}.`
    );
  }
  const segmentCount = Math.ceil(input.frameCount / input.segmentFrames);
  if (segmentCount > MAX_RENDER_SEGMENTS) {
    throw new RenderSegmentStoreError(
      "segment_count_exceeded",
      `Segmented rendering accepts at most ${MAX_RENDER_SEGMENTS} segments; received ${segmentCount}.`
    );
  }
  const ranges: RenderSegmentRange[] = [];
  for (let startFrame = 0, index = 0; startFrame < input.frameCount; startFrame += input.segmentFrames, index += 1) {
    const endFrameExclusive = Math.min(input.frameCount, startFrame + input.segmentFrames);
    ranges.push({ index, startFrame, endFrameExclusive, frameCount: endFrameExclusive - startFrame });
  }
  return {
    schema: RENDER_SEGMENT_PLAN_SCHEMA,
    frameCount: input.frameCount,
    segmentFrames: input.segmentFrames,
    segmentCount,
    ranges
  };
}

/** Refuse forged, gapped, overlapping, reordered, or no-longer-budgeted plans before any I/O. */
export function assertRenderSegmentPlan(value: unknown): asserts value is RenderSegmentPlan {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "frameCount", "segmentFrames", "segmentCount", "ranges"]) || value.schema !== RENDER_SEGMENT_PLAN_SCHEMA) {
    throw new RenderSegmentStoreError("segment_plan_invalid", `Segment plan schema must equal ${RENDER_SEGMENT_PLAN_SCHEMA}.`);
  }
  const frameCount = value.frameCount;
  const segmentFrames = value.segmentFrames;
  if (!positiveSafeInteger(frameCount) || !positiveSafeInteger(segmentFrames)) {
    throw new RenderSegmentStoreError("segment_plan_invalid", "Segment plan frameCount and segmentFrames must be positive safe integers.");
  }
  const expected = planRenderSegments({ frameCount, segmentFrames });
  if (
    value.segmentCount !== expected.segmentCount
    || !Array.isArray(value.ranges)
    || value.ranges.length !== expected.ranges.length
    || value.ranges.some((range, index) => !sameRange(range, expected.ranges[index]))
  ) {
    throw new RenderSegmentStoreError("segment_plan_invalid", "Segment plan must be the canonical ordered full-coverage partition.");
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RenderSegmentStoreError("segment_plan_invalid", `${label} must be a positive safe integer.`);
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameRange(value: unknown, expected: RenderSegmentRange): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["index", "startFrame", "endFrameExclusive", "frameCount"])
    && value.index === expected.index
    && value.startFrame === expected.startFrame
    && value.endFrameExclusive === expected.endFrameExclusive
    && value.frameCount === expected.frameCount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
