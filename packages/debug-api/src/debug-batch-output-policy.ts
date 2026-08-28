import { join } from "node:path";
import {
  audioWarningsForExportPreset,
  readFfmpegExportPreset,
  readImageSequenceExportPreset,
  resolveMotionExportPreset,
  type MotionExportPreset
} from "@shellx-motion/renderer-ffmpeg";

export function debugBatchOutputPath(renderRoot: string, packageId: string, preset: MotionExportPreset): string {
  const spec = resolveMotionExportPreset(preset);
  return readImageSequenceExportPreset(preset) ? join(renderRoot, packageId) : join(renderRoot, `${packageId}.${spec.extension}`);
}

export function supportsDebugBatchQualityManifestPreset(preset: MotionExportPreset): boolean {
  return Boolean(readFfmpegExportPreset(preset)) || preset === "png-frame" || preset === "png-sequence";
}

export function debugAudioWarningsForMotionExportPreset(preset: MotionExportPreset, audioInputCount: number): string[] {
  const ffmpegPreset = readFfmpegExportPreset(preset);
  if (ffmpegPreset) return audioWarningsForExportPreset(ffmpegPreset, audioInputCount);
  if (audioInputCount <= 0) return [];
  return [`Export preset ${preset} does not support audio; ${audioInputCount} requested audio ${audioInputCount === 1 ? "track" : "tracks"} will be ignored.`];
}

export function debugQualityCheckReceiptOutput(job: Record<string, unknown>): { qualityCheck?: { status: "passed" | "failed" } } {
  const qualityCheck = ownRecord(job.qualityCheck);
  return qualityCheck ? { qualityCheck: { status: qualityCheck.ok === true ? "passed" : "failed" } } : {};
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
