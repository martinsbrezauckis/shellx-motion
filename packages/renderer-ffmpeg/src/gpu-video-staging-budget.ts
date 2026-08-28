export const MAX_GPU_VIDEO_STAGING_BYTES = 16 * 1024 * 1024 * 1024;
/** FFmpeg may choose a legal WAV extensible header; reserve a bounded header rather than assuming 44 bytes. */
const WAV_HEADER_MAX_BYTES = 4 * 1024;
const PCM_48KHZ_STEREO_S16_BYTES_PER_SECOND = 48_000 * 2 * 2;

export interface GpuVideoStagingBudgetEntry {
  sourceKey: string;
  sourceBytes: number;
  rgbaBytes: number;
  pcmDurationMs?: number;
}

export interface GpuVideoStagingLedger {
  maxBytes: number;
  immutableSourceBytes: number;
  plannedRgbaBytes: number;
  plannedPcmBytes: number;
  totalBytes: number;
}

/**
 * First aggregate gate for an operation that has not yet copied or probed a source. This is
 * deliberately separate from the final ledger: it makes a 16 GiB source-only refusal happen
 * before Motion writes any immutable snapshot or starts a parser process.
 */
export function planGpuVideoSourceSnapshotBudget(
  sources: readonly Pick<GpuVideoStagingBudgetEntry, "sourceKey" | "sourceBytes">[],
  maxBytes = MAX_GPU_VIDEO_STAGING_BYTES
): Pick<GpuVideoStagingLedger, "maxBytes" | "immutableSourceBytes"> {
  assertBudgetLimit(maxBytes);
  const deduplicated = immutableSourceBytesFor(sources);
  if (deduplicated > maxBytes) throw new Error(`GPU video staging exceeds its ${maxBytes}-byte aggregate operation budget.`);
  return { maxBytes, immutableSourceBytes: deduplicated };
}

/** Pure aggregate ledger: source snapshots charge once per immutable source, decoded outputs per use. */
export function planGpuVideoStagingBudget(
  entries: readonly GpuVideoStagingBudgetEntry[],
  maxBytes = MAX_GPU_VIDEO_STAGING_BYTES
): GpuVideoStagingLedger {
  assertBudgetLimit(maxBytes);
  const pcmDurations = new Map<string, number>();
  let plannedRgbaBytes = 0;
  for (const entry of entries) {
    assertNonNegativeByteCount(entry.rgbaBytes, "planned RGBA");
    plannedRgbaBytes = checkedAdd(plannedRgbaBytes, entry.rgbaBytes, "planned RGBA");
    if (entry.pcmDurationMs !== undefined) {
      plannedPcmBytesForDuration(entry.pcmDurationMs);
      pcmDurations.set(entry.sourceKey, Math.max(pcmDurations.get(entry.sourceKey) ?? 0, entry.pcmDurationMs));
    }
  }
  const immutableSourceBytes = immutableSourceBytesFor(entries);
  const plannedPcmBytes = [...pcmDurations.values()].reduce((sum, durationMs) => checkedAdd(sum, plannedPcmBytesForDuration(durationMs), "planned PCM"), 0);
  const totalBytes = checkedAdd(checkedAdd(immutableSourceBytes, plannedRgbaBytes, "GPU video staging"), plannedPcmBytes, "GPU video staging");
  if (totalBytes > maxBytes) throw new Error(`GPU video staging exceeds its ${maxBytes}-byte aggregate operation budget.`);
  return { maxBytes, immutableSourceBytes, plannedRgbaBytes, plannedPcmBytes, totalBytes };
}

function immutableSourceBytesFor(sources: readonly Pick<GpuVideoStagingBudgetEntry, "sourceKey" | "sourceBytes">[]): number {
  const deduplicated = new Map<string, number>();
  for (const source of sources) {
    if (!source.sourceKey) throw new Error("GPU video staging source key must not be empty.");
    assertByteCount(source.sourceBytes, "immutable source");
    const prior = deduplicated.get(source.sourceKey);
    if (prior !== undefined && prior !== source.sourceBytes) throw new Error("GPU video staging source key has inconsistent byte lengths.");
    deduplicated.set(source.sourceKey, source.sourceBytes);
  }
  return [...deduplicated.values()].reduce((sum, bytes) => checkedAdd(sum, bytes, "immutable source"), 0);
}

function assertBudgetLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GPU_VIDEO_STAGING_BYTES) {
    throw new Error(`GPU video staging budget must be an integer within 1..${MAX_GPU_VIDEO_STAGING_BYTES}.`);
  }
}

export function plannedPcmBytesForDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > Number.MAX_SAFE_INTEGER) throw new Error("GPU video PCM duration must be a positive finite number.");
  return checkedAdd(WAV_HEADER_MAX_BYTES, Math.ceil((durationMs / 1_000) * PCM_48KHZ_STEREO_S16_BYTES_PER_SECOND), "planned PCM");
}

function assertByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`GPU video ${label} byte count must be a positive safe integer.`);
}
function assertNonNegativeByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`GPU video ${label} byte count must be a non-negative safe integer.`);
}
function checkedAdd(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error(`GPU video ${label} byte count exceeds safe integer precision.`);
  return total;
}
