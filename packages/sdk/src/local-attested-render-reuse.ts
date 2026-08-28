/** Local-SDK adapter for Debug's public v2 attested-reuse authority. */
import { loadMotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { dispatchDebugCommand, type MotionDebugResult } from "@shellx-motion/debug-api";
import { dirname, join, resolve } from "node:path";
import { localDebugContext } from "./local-debug-context";
import { LocalMotionSdkError } from "./local-result";
import type { LocalMotionSdkOptions } from "./local";
import type { MotionSdkRenderResponse } from "./types";

export interface LocalAttestedReuseRenderInput {
  packageRoot: string; outputPath: string; preset: string; artifactRoot?: string; receiptsRoot?: string;
  frameLane?: "browser" | "native"; workflowPath?: string; qualityManifestPath?: string; keepFrames?: boolean; segmented?: { segmentFrames: number; resume?: boolean }; reuseAttested?: boolean; idempotencyKey?: string;
  cutHandoff?: { target: "shellx-cut"; mode: "rendered_media" };
}

/** It deliberately never reads a legacy v1 descriptor. */
export async function renderPackageAttestedReuse(
  input: LocalAttestedReuseRenderInput,
  options: LocalMotionSdkOptions,
): Promise<MotionSdkRenderResponse> {
  if (input.keepFrames === true) throw new LocalMotionSdkError("invalid_request", "SDK render reuseAttested does not retain diagnostic frame directories.", false);
  if (input.idempotencyKey !== undefined) throw new LocalMotionSdkError("invalid_request", "SDK render reuseAttested derives its v2 key from current render inputs; omit idempotencyKey.", false);
  if (input.cutHandoff) throw new LocalMotionSdkError("invalid_request", "SDK render reuseAttested does not yet support Cut handoff publication.", false);
  if (input.artifactRoot !== undefined) throw new LocalMotionSdkError("invalid_request", "SDK render reuseAttested derives its root from outputPath; omit legacy artifactRoot.", false);
  const outputPath = resolve(input.outputPath);
  const pkg = await loadMotionPackage(input.packageRoot);
  const scratchRoot = join(dirname(outputPath), ".shellx-motion", "scratch", "sdk-attested-reuse");
  const context = localDebugContext("render_motion", options, scratchRoot, [
    pkg.root,
    ...(input.workflowPath ? [dirname(resolve(input.workflowPath))] : []),
    ...(input.qualityManifestPath ? [dirname(resolve(input.qualityManifestPath))] : []),
  ]);
  const debug = await dispatchDebugCommand("motion.render.final", {
    packageRoot: pkg.root,
    outputPath,
    preset: input.preset,
    reuseAttested: true,
    ...(input.frameLane ? { frameLane: input.frameLane } : {}),
    ...(input.receiptsRoot ? { receiptsRoot: resolve(input.receiptsRoot) } : {}),
    ...(input.workflowPath ? { workflowPath: resolve(input.workflowPath) } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: resolve(input.qualityManifestPath) } : {}),
  }, context);
  const result = successfulDebugResult(debug, "attested render reuse");
  const receipt = operationReceipt(result.receipt, "attested render reuse receipt");
  const artifact = result.artifact === undefined ? undefined : record(result.artifact, "attested render artifact") as MotionSdkRenderResponse["artifact"];
  const jobId = typeof (debug as unknown as Record<string, unknown>).jobId === "string"
    ? (debug as unknown as Record<string, string>).jobId : receipt.id;
  return {
    jobId,
    state: "succeeded",
    packageId: stringField(result, "packageId"),
    motionId: pkg.motion.id,
    preset: stringField(result, "preset"),
    outputPath: stringField(result, "outputPath"),
    receiptId: receipt.id,
    ...(artifact ? { artifact } : {}),
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === "string") : receipt.warnings,
  };
}

function successfulDebugResult(debug: MotionDebugResult, label: string): Record<string, unknown> {
  if (!debug.ok) throw new LocalMotionSdkError(debug.error.code, `${label} failed: ${debug.error.message}`, false, debug.error.detail);
  return record(debug.result, `${label} result`);
}

function operationReceipt(value: unknown, label: string): OperationReceipt {
  const receipt = record(value, label);
  if (receipt.schema !== "shellx-motion/receipt@1" || typeof receipt.id !== "string" || typeof receipt.operation !== "string"
    || !Array.isArray(receipt.warnings) || !receipt.warnings.every((warning) => typeof warning === "string")) throw new Error(`${label} is invalid.`);
  return receipt as unknown as OperationReceipt;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a string.`);
  return value;
}
