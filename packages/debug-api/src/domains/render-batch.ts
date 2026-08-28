/** Batch-render command policy and typed handoff to row orchestration. */
import { readFfmpegExportPreset, readMotionExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { readBrowserWorkflowArg } from "./integration-browser-workflow.js";
import { gpuBatchRequestRefusal } from "../gpu-batch-policy.js";
import { booleanArg, objectArg, positiveIntegerArg, stringArg } from "./args.js";
import {
  admitConfiguredRenderInputFile,
  admitConfiguredRenderPackageRoot,
  assertConfiguredRenderOutputDirectory,
  type AdmittedRenderInputRoot,
  type RenderRootPolicy
} from "./render-root-policy.js";

export interface BatchRenderRequest {
  packageRoot: string;
  outDir: string;
  rowsPath?: string;
  rowIds: string[];
  qualityManifestPath?: string;
  frameLane: "browser" | "native" | "gpu";
  keepFrames?: boolean;
  preset: MotionExportPreset;
  forcePreset: boolean;
  dryRun: boolean;
  resume: boolean;
  /** Authenticated host principal retained with batch receipt and resume identity; never command data. */
  callerId?: string;
  minUniqueFrameHashes?: number;
  workflow?: BrowserCaptureWorkflow;
  workflowPath?: string;
  /** Opaque host admission retained until the stable rows reader opens the file. */
  rowsInputRoot?: AdmittedRenderInputRoot;
  /** Opaque host admission retained while the package documents are opened. */
  packageInputRoot?: AdmittedRenderInputRoot;
}

export interface RenderBatchServices {
  /** Authenticated host principal; callers cannot nominate this in command arguments. */
  callerId?: string;
  /** Render roots are host configuration, never derived from request fields. */
  renderRootPolicy?: RenderRootPolicy;
  /** Test-only seam after rows admission and before the stable reader opens it. */
  batchRowsPathAfterAdmission?: (input: { root: string; rowsPath: string }) => Promise<void> | void;
  /** Host-owned GPU final capability; GPU batches refuse before planning or queueing when absent. */
  gpuFinalExecutionAvailable?: boolean;
  executeBatchPlan?: (request: BatchRenderRequest) => Promise<MotionDebugResult>;
  executeBatchRun?: (request: BatchRenderRequest) => Promise<MotionDebugResult>;
}

export async function dispatchRenderBatchCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderBatchServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.render.batch") return null;
  const callerId = services.callerId?.trim() || undefined;
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  const rowsPath = stringArg(args, "rowsPath") ?? undefined;
  const rowIdSelection = readRowIds(args);
  const qualityManifestPath = stringArg(args, "qualityManifestPath") ?? stringArg(args, "manifestPath") ?? undefined;
  const frameLaneValue = stringArg(args, "frameLane") ?? "browser";
  const presetArg = stringArg(args, "preset");
  const presetValue = presetArg ?? "mp4-h264";
  const keepFrames = booleanArg(args, "keepFrames");
  const dryRun = booleanArg(args, "dryRun") ?? true;
  const resume = booleanArg(args, "resume") ?? false;
  const minUniqueFrameHashes = positiveIntegerArg(args, "minUniqueFrameHashes");
  const workflow = readBrowserWorkflowArg(args, "workflow");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.render.batch requires packageRoot.");
  if (!outDir) return invalidArgs("motion.render.batch requires outDir.");
  if (frameLaneValue !== "browser" && frameLaneValue !== "native" && frameLaneValue !== "gpu") {
    return invalidArgs("frameLane must be browser, native, or gpu.");
  }
  const frameLane = frameLaneValue;
  if (frameLane === "gpu" && services.gpuFinalExecutionAvailable !== true) {
    return capabilityUnavailable("GPU batch rendering requires a host-owned GPU final capability before rows are planned or queued.");
  }
  if (!rowIdSelection.ok) return invalidArgs(rowIdSelection.message);
  const preset = readMotionExportPreset(presetValue);
  if (!preset) return invalidArgs(`Unsupported export preset: ${presetValue}.`);
  const gpuRefusal = gpuBatchRequestRefusal({ frameLane, resume, keepFrames: keepFrames === true, workflow: workflow || undefined, workflowPath, preset });
  if (gpuRefusal) return invalidArgs(gpuRefusal);
  if (qualityManifestPath && !supportsQualityManifestPreset(preset)) {
    return invalidArgs("Batch quality manifest checks currently require a video, GIF, png-frame, or png-sequence export preset.");
  }
  if (minUniqueFrameHashes === false) return invalidArgs("minUniqueFrameHashes must be a positive integer.");
  if (workflow === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  let rowsInputRoot: AdmittedRenderInputRoot | undefined;
  let packageInputRoot: AdmittedRenderInputRoot | undefined;
  try {
    const policy = services.renderRootPolicy ?? { enforce: false };
    packageInputRoot = await admitConfiguredRenderPackageRoot(packageRoot, policy, "motion.render.batch packageRoot");
    await assertConfiguredRenderOutputDirectory(outDir, policy, "motion.render.batch outDir");
    if (rowsPath) {
      rowsInputRoot = await admitConfiguredRenderInputFile(rowsPath, policy, "motion.render.batch rowsPath");
      if (rowsInputRoot) await services.batchRowsPathAfterAdmission?.({ root: rowsInputRoot.root, rowsPath });
    }
    if (workflowPath) await admitConfiguredRenderInputFile(workflowPath, policy, "motion.render.batch workflowPath");
    if (qualityManifestPath) await admitConfiguredRenderInputFile(qualityManifestPath, policy, "motion.render.batch qualityManifestPath");
  } catch (error) {
    return invalidArgs(error instanceof Error ? error.message : "motion.render.batch render filesystem authority is unavailable.");
  }
  const request: BatchRenderRequest = {
    packageRoot, outDir, rowIds: rowIdSelection.rowIds, frameLane, preset, forcePreset: Boolean(presetArg), dryRun, resume,
    ...(rowsPath ? { rowsPath } : {}),
    ...(qualityManifestPath ? { qualityManifestPath } : {}),
    ...(keepFrames !== null ? { keepFrames } : {}),
    ...(minUniqueFrameHashes !== null ? { minUniqueFrameHashes } : {}),
    ...(workflow ? { workflow } : {}),
    ...(workflowPath ? { workflowPath } : {}),
    ...(rowsInputRoot ? { rowsInputRoot } : {}),
    ...(packageInputRoot ? { packageInputRoot } : {}),
    ...(callerId ? { callerId } : {})
  };
  if (dryRun) {
    if (!services.executeBatchPlan) return capabilityUnavailable("Batch render planning is unavailable.");
    return services.executeBatchPlan(request);
  }
  if (!services.executeBatchRun) return capabilityUnavailable("Batch render execution is unavailable.");
  return services.executeBatchRun(request);
}

function readRowIds(args: unknown): { ok: true; rowIds: string[] } | { ok: false; message: string } {
  const record = objectArg(args);
  if (!record) return { ok: true, rowIds: [] };
  const rowIds: string[] = [];
  for (const key of ["rowId", "row"]) {
    if (!Object.hasOwn(record, key)) continue;
    const rowId = stringArg(args, key);
    if (rowId === null) return { ok: false, message: `${key} must be a string.` };
    rowIds.push(rowId);
  }
  if (Object.hasOwn(record, "rowIds")) {
    const values = record.rowIds;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      return { ok: false, message: "rowIds must be an array of strings." };
    }
    rowIds.push(...values);
  }
  return { ok: true, rowIds };
}

function supportsQualityManifestPreset(preset: MotionExportPreset): boolean {
  return Boolean(readFfmpegExportPreset(preset)) || preset === "png-frame" || preset === "png-sequence";
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
