import type { OperationReceipt } from "@shellx-motion/core";
import { redactAbortedFinalOutputEvidence, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugResult } from "./command-registry.js";

/** Normalize every aborted primary receipt, including the nested still-frame receipt, before return. */
export function debugRenderQualityManifestFailure(input: {
  lane: "ffmpeg" | "image-sequence" | "image";
  frameLane: string;
  preset: MotionExportPreset;
  outputPath: string;
  receipt: OperationReceipt;
  frameReceipt?: unknown;
  frames?: { dir: string; count: number };
  qualityManifestPath: string;
  qualityCheck: MotionDebugResult;
  extra?: Record<string, unknown>;
}): MotionDebugResult {
  const failure = input.qualityCheck.ok
    ? { code: "quality_check_failed", message: "Final render quality manifest check failed." }
    : { code: input.qualityCheck.error.code, message: input.qualityCheck.error.message };
  redactAbortedFinalOutputEvidence(input.receipt, failure);
  const frameReceipt = operationReceipt(input.frameReceipt);
  if (frameReceipt) redactAbortedFinalOutputEvidence(frameReceipt, failure);
  return {
    ok: false,
    error: {
      ...failure,
      detail: {
        lane: input.lane, frameLane: input.frameLane, preset: input.preset,
        outputPath: input.outputPath, receipt: input.receipt,
        ...(frameReceipt ? { frameReceipt } : input.frameReceipt !== undefined ? { frameReceipt: input.frameReceipt } : {}),
        ...(input.frames ? { frames: input.frames } : {}),
        qualityManifestPath: input.qualityManifestPath, qualityCheck: input.qualityCheck,
        ...(input.extra ?? {})
      }
    },
    warnings: input.receipt.warnings
  };
}

function operationReceipt(value: unknown): OperationReceipt | undefined {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return record?.schema === "shellx-motion/receipt@1" && typeof record.id === "string" && typeof record.lane === "string" ? value as OperationReceipt : undefined;
}
