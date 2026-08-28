import { readFile } from "node:fs/promises";
import { hashBuffer, type ExpandedMotionJob, type MotionDataRow } from "@shellx-motion/core";
import { readMotionExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BatchQualityInputEvidence } from "./batch-quality-manifest.js";
import type { BatchFrameLane } from "./gpu-batch-policy.js";

export function planBatchRenderPresets(jobs: ExpandedMotionJob[], fallbackPreset: MotionExportPreset, forcePreset: boolean): {
  ok: true;
  presets: MotionExportPreset[];
  uniquePresets: MotionExportPreset[];
} | {
  ok: false;
  rowId: string;
  preset: string;
} {
  const presets: MotionExportPreset[] = [];
  for (const job of jobs) {
    const rowPresetValue = forcePreset ? undefined : readBatchRowRenderPreset(job.row);
    if (!rowPresetValue) {
      presets.push(fallbackPreset);
      continue;
    }
    const rowPreset = readMotionExportPreset(rowPresetValue);
    if (!rowPreset) return { ok: false, rowId: job.row.id, preset: rowPresetValue };
    presets.push(rowPreset);
  }
  return { ok: true, presets, uniquePresets: uniqueMotionExportPresets(presets) };
}

export function batchPresetSummary(basePreset: MotionExportPreset, actualPresets: MotionExportPreset[]): { presets?: MotionExportPreset[] } {
  return actualPresets.length === 1 && actualPresets[0] === basePreset ? {} : { presets: actualPresets };
}

export function batchJobIdempotencyKey(input: {
  packageId: string;
  rowId: string;
  rowHash: string;
  manifest: unknown;
  motion: unknown;
  preset: MotionExportPreset;
  quality?: { minUniqueFrameHashes: number };
  qualityInputs?: BatchQualityInputEvidence;
  frameLane: BatchFrameLane;
  workflowIdempotencyHash?: string;
}): string {
  const digest = hashBuffer(Buffer.from(JSON.stringify({
    packageId: input.packageId,
    rowId: input.rowId,
    rowHash: input.rowHash,
    manifest: input.manifest,
    motion: input.motion,
    preset: input.preset,
    quality: input.quality,
    qualityInputs: input.qualityInputs,
    frameLane: input.frameLane,
    workflowIdempotencyHash: input.workflowIdempotencyHash
  }), "utf8")).slice(0, 24);
  return `${input.packageId}:${input.rowId}:${input.preset}:${digest}`;
}

export async function batchWorkflowIdempotencyHash(workflowPath: string): Promise<string> {
  return hashBuffer(await readFile(workflowPath));
}

function readBatchRowRenderPreset(row: MotionDataRow): string | undefined {
  const flatPreset = row.values["render.preset"];
  if (typeof flatPreset === "string" && flatPreset.trim()) return flatPreset.trim();
  const render = ownRecord(row.values.render);
  const preset = render?.preset;
  return typeof preset === "string" && preset.trim() ? preset.trim() : undefined;
}

function uniqueMotionExportPresets(presets: MotionExportPreset[]): MotionExportPreset[] {
  return presets.filter((preset, index) => presets.indexOf(preset) === index);
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
