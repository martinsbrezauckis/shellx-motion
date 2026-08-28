/** Failed materialized final renders retain truthful receipt and frame-transport evidence. */
import type { ReceiptActor } from "@shellx-motion/core";
import { redactAbortedFinalOutputEvidence, type EncodeResult, type FinalVideoFrameTransportPlan } from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugResult } from "./command-registry.js";
import type { FinalFramePass } from "./render-final-frame-lane.js";

export async function materializedFinalEncodeFailure(input: {
  encoded: Extract<EncodeResult, { ok: false }>;
  framePass: FinalFramePass;
  receiptsRoot?: string;
  actor?: ReceiptActor;
  persistReceipt(root: string, receipt: NonNullable<Extract<EncodeResult, { ok: false }>["receipt"]>, actor?: ReceiptActor): Promise<string>;
  frameLane: "browser" | "native";
  preset: string;
  packageId: string;
  outputPath: string;
  transport: FinalVideoFrameTransportPlan;
  warnings: string[];
}): Promise<MotionDebugResult> {
  const { encoded, framePass, receiptsRoot, actor, persistReceipt, frameLane, preset, packageId, outputPath, transport, warnings } = input;
  const failedReceipt = encoded.receipt;
  if (failedReceipt) {
    redactAbortedFinalOutputEvidence(failedReceipt, encoded.error);
    framePass.applyTo(failedReceipt);
    failedReceipt.output = { ...record(failedReceipt.output), frameTransportPlan: transport };
  }
  const failedReceiptPath = failedReceipt && receiptsRoot
    ? await persistReceipt(receiptsRoot, failedReceipt, actor)
    : undefined;
  return {
    ok: false,
    error: encoded.error,
    ...(failedReceipt ? {
      result: {
        lane: "ffmpeg",
        frameLane,
        preset,
        packageId,
        outputPath,
        output: failedReceipt.output,
        receipt: failedReceipt,
        ...(failedReceiptPath ? { receiptPath: failedReceiptPath } : {}),
        frameTransport: transport,
      }
    } : {}),
    warnings: failedReceipt ? failedReceipt.warnings : [...warnings, ...framePass.warnings],
  };
}

export function abortedQualityCheckEvidence(qualityCheck: Extract<MotionDebugResult, { ok: false }>): MotionDebugResult {
  return { ok: false, error: qualityCheck.error, warnings: qualityCheck.warnings };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
