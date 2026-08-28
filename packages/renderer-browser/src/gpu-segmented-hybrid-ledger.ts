import { canonicalJsonSha256, MOTION_DOCUMENT_LIMITS } from "@shellx-motion/core";
import {
  GPU_SEGMENTED_HYBRID_RANGE_LEDGER_SCHEMA,
  type GpuSegmentedHybridLedgerEntry,
  type GpuSegmentedHybridRangeLedger,
} from "./gpu-segmented-hybrid-types";

/** Matches the durable segmented delivery's global materialized-frame ceiling. */
export const MAX_GPU_SEGMENTED_HYBRID_CAPTURE_ENTRIES = MOTION_DOCUMENT_LIMITS.maxFrames;

/**
 * Bounded global-frame ordering ledger shared by direct and segmented hybrid
 * capture.  It retains scalar identities, never PNG or decoded RGBA bytes.
 */
export function createGpuHybridCaptureLedger(input: {
  readonly range: { readonly index: number; readonly startFrameIndex: number; readonly endFrameIndexExclusive: number };
  readonly expectedCaptureCount: number;
}): {
  observe(entry: GpuSegmentedHybridLedgerEntry): void;
  finish(): GpuSegmentedHybridRangeLedger;
} {
  if (!validRange(input.range) || !Number.isSafeInteger(input.expectedCaptureCount) || input.expectedCaptureCount < 0 || input.expectedCaptureCount > MAX_GPU_SEGMENTED_HYBRID_CAPTURE_ENTRIES || input.expectedCaptureCount > input.range.endFrameIndexExclusive - input.range.startFrameIndex) {
    throw new Error(`GPU segmented hybrid capture ledger must declare 0..${MAX_GPU_SEGMENTED_HYBRID_CAPTURE_ENTRIES} ordered entries.`);
  }
  const entries: GpuSegmentedHybridLedgerEntry[] = [];
  let previousIndex = -1;
  return {
    observe(entry) {
      if (!Number.isSafeInteger(entry.index) || entry.index <= previousIndex || !Number.isFinite(entry.atMs) || !Number.isSafeInteger(entry.atUs) || Math.round(entry.atMs * 1_000) !== entry.atUs || !isSha256(entry.requestFingerprint) || !safeTextureId(entry.resourceId) || !positiveDimension(entry.width) || !positiveDimension(entry.height) || !isSha256(entry.pngSha256) || !isSha256(entry.decodedRgbaSha256)) {
        throw new Error("GPU hybrid capture ledger entry is not an exact ordered texture observation.");
      }
      if (entries.length >= input.expectedCaptureCount) throw new Error("GPU hybrid capture ledger received more captures than its admitted range count.");
      previousIndex = entry.index;
      entries.push(Object.freeze({ ...entry }));
    },
    finish() {
      if (entries.length !== input.expectedCaptureCount) {
        throw new Error("GPU hybrid capture ledger did not complete its admitted exact request count.");
      }
      const frozenEntries = Object.freeze([...entries]);
      return Object.freeze({
        schema: GPU_SEGMENTED_HYBRID_RANGE_LEDGER_SCHEMA,
        rangeIndex: input.range.index,
        startFrameIndex: input.range.startFrameIndex,
        endFrameIndexExclusive: input.range.endFrameIndexExclusive,
        expectedCaptureCount: input.expectedCaptureCount,
        captureCount: frozenEntries.length,
        entries: frozenEntries,
        sequenceSha256: canonicalJsonSha256(frozenEntries)
      });
    }
  };
}

function validRange(value: { index: number; startFrameIndex: number; endFrameIndexExclusive: number }): boolean {
  return Number.isSafeInteger(value.index) && value.index >= 0
    && Number.isSafeInteger(value.startFrameIndex) && Number.isSafeInteger(value.endFrameIndexExclusive)
    && value.startFrameIndex >= 0 && value.endFrameIndexExclusive > value.startFrameIndex
    && value.endFrameIndexExclusive - value.startFrameIndex <= MAX_GPU_SEGMENTED_HYBRID_CAPTURE_ENTRIES;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function safeTextureId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function positiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4_096;
}
