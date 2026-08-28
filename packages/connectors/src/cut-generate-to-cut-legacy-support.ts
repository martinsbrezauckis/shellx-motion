import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashBuffer, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import type { ConnectorRequestedFinalFrameLane } from "./streaming-final";

/** Preserve the historical Cut Generate receipt hash; P2B intentionally does not migrate this route. */
export function legacyCutGenerateMotionHash(motion: unknown): string {
  const serialized = JSON.stringify(motion);
  return hashBuffer(Buffer.from(serialized, "utf8"));
}

export function cutGenerateArtifacts(input: { scriptPath?: string; packageDir: string; previewPath: string; previewOk: boolean; previewReceiptPath: string; renderRequired: boolean; renderDryRun: boolean; renderOk: boolean; renderOutputPath: string; renderReceiptPath: string; cutPlanPath: string; connectorReceiptPath: string; artifactHandlePath?: string }): ConnectorArtifact[] {
  const artifacts: ConnectorArtifact[] = [
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "preview_frame", path: input.previewPath, status: input.previewOk ? "available" : "planned", mediaType: "image/png" },
    { role: "preview_receipt", path: input.previewReceiptPath, status: "available" },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "cut_plan", path: input.cutPlanPath, status: "available", primary: !input.renderRequired },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
  if (input.scriptPath) artifacts.unshift({ role: "scripted_video", path: input.scriptPath, status: "available" });
  if (input.renderRequired) artifacts.splice(4, 0, { role: "rendered_media", path: input.renderOutputPath, status: !input.renderOk ? "failed" : input.renderDryRun ? "planned" : "available", mediaType: "video/mp4", primary: true });
  if (input.artifactHandlePath) artifacts.push({ role: "artifact_handle", path: input.artifactHandlePath, status: "available", mediaType: "application/vnd.shellx-motion.artifact-handle+json" });
  return artifacts;
}

export function createCutGenerateNotRequiredReceipt(input: { packageId: string; motionHash: string; createdAt: string; mode: string | null }): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `render-not-required-${hashBuffer(Buffer.from(`${input.packageId}:${input.mode ?? "none"}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "not_run",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: { required: false, reason: input.mode ? `Cut import mode ${input.mode} does not require rendered media.` : "Cut import planning found no applicable mode; rendered media was not run for the failed explicit handoff." },
    warnings: []
  };
}

export function cutGenerateNativeRenderable(pkg: MotionPackage): boolean {
  return pkg.motion.layers.every((layer) => layer.type === "text" || layer.type === "shape" || layer.type === "caption");
}

export function createCutGenerateConnectorReceipt(input: {
  packageId: string; createdAt: string; inputPath: string; inputHash: string; packageDir: string; previewOk: boolean; previewFailureFatal: boolean; previewReceiptPath: string; renderOk: boolean; renderReceiptPath: string; renderRequired: boolean; renderDryRun: boolean; renderFrameLane?: ConnectorRequestedFinalFrameLane; renderGpu?: Record<string, unknown>; renderOutputPath?: string; cutOk: boolean; cutMode: string | null; cutPlanPath: string; artifacts: ConnectorArtifact[]; warnings: string[]; operationHash: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `connector-cut-generate-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.cut_generate_to_cut",
    status: connectorReceiptStatus({ failed: input.previewFailureFatal || !input.cutOk || !input.renderOk, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: { script: input.inputHash, operation: input.operationHash },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      artifacts: input.artifacts,
      script: { path: input.inputPath },
      packageDir: input.packageDir,
      preview: { ok: input.previewOk, lane: "native", failureFatal: input.previewFailureFatal, receiptPath: input.previewReceiptPath },
      render: { ok: input.renderOk, required: input.renderRequired, dryRun: input.renderRequired ? input.renderDryRun : true, lane: "ffmpeg", frameLane: input.renderFrameLane, receiptPath: input.renderReceiptPath, ...(input.renderOutputPath ? { outputPath: input.renderOutputPath } : {}), ...(input.renderGpu ?? {}) },
      cut: { ok: input.cutOk, mode: input.cutMode, planPath: input.cutPlanPath }
    },
    warnings: input.warnings
  };
}

export async function writeCutGenerateJson(path: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
