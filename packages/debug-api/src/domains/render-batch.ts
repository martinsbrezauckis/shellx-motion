/** Batch-render command policy and typed handoff to row orchestration. */
import { readFfmpegExportPreset, readMotionExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { readBrowserWorkflowArg } from "./integration-browser-workflow.js";
import { booleanArg, objectArg, positiveIntegerArg, stringArg } from "./args.js";

export interface BatchRenderRequest {
  packageRoot: string;
  outDir: string;
  rowsPath?: string;
  rowIds: string[];
  qualityManifestPath?: string;
  preset: MotionExportPreset;
  forcePreset: boolean;
  dryRun: boolean;
  resume: boolean;
  minUniqueFrameHashes?: number;
  workflow?: BrowserCaptureWorkflow;
  workflowPath?: string;
}

export interface RenderBatchServices {
  scratchRoot?: string;
  qualityInputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  executeBatchPlan?: (request: BatchRenderRequest) => Promise<MotionDebugResult>;
  executeBatchRun?: (request: BatchRenderRequest) => Promise<MotionDebugResult>;
}

export async function dispatchRenderBatchCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderBatchServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.render.batch") return null;
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  const rowsPath = stringArg(args, "rowsPath") ?? undefined;
  const rowIdSelection = readRowIds(args);
  const qualityManifestPath = stringArg(args, "qualityManifestPath") ?? stringArg(args, "manifestPath") ?? undefined;
  const presetArg = stringArg(args, "preset");
  const presetValue = presetArg ?? "mp4-h264";
  const dryRun = booleanArg(args, "dryRun") ?? true;
  const resume = booleanArg(args, "resume") ?? false;
  const minUniqueFrameHashes = positiveIntegerArg(args, "minUniqueFrameHashes");
  const workflow = readBrowserWorkflowArg(args, "workflow");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.render.batch requires packageRoot.");
  if (!outDir) return invalidArgs("motion.render.batch requires outDir.");
  if (!rowIdSelection.ok) return invalidArgs(rowIdSelection.message);
  const preset = readMotionExportPreset(presetValue);
  if (!preset) return invalidArgs(`Unsupported export preset: ${presetValue}.`);
  if (qualityManifestPath && !supportsQualityManifestPreset(preset)) {
    return invalidArgs("Batch quality manifest checks currently require a video, GIF, png-frame, or png-sequence export preset.");
  }
  if (minUniqueFrameHashes === false) return invalidArgs("minUniqueFrameHashes must be a positive integer.");
  if (workflow === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  const readPaths = [rowsPath, workflowPath, qualityManifestPath].filter((path): path is string => Boolean(path));
  if (readPaths.length > 0 && !services.isPathInsideTrustedRoot) return capabilityUnavailable("Batch render trusted-path validation is unavailable.");
  const trustedRoots = [packageRoot, services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? [])];
  for (const path of readPaths) {
    if (!await isInsideAnyRoot(path, trustedRoots, services.isPathInsideTrustedRoot!)) {
      const label = path === rowsPath ? "rowsPath" : path === workflowPath ? "workflowPath" : "qualityManifestPath";
      return invalidArgs(`motion.render.batch ${label} must be inside packageRoot or a trusted debug input root.`);
    }
  }
  const request: BatchRenderRequest = {
    packageRoot, outDir, rowIds: rowIdSelection.rowIds, preset, forcePreset: Boolean(presetArg), dryRun, resume,
    ...(rowsPath ? { rowsPath } : {}),
    ...(qualityManifestPath ? { qualityManifestPath } : {}),
    ...(minUniqueFrameHashes !== null ? { minUniqueFrameHashes } : {}),
    ...(workflow ? { workflow } : {}),
    ...(workflowPath ? { workflowPath } : {})
  };
  if (dryRun) {
    if (!services.executeBatchPlan) return capabilityUnavailable("Batch render planning is unavailable.");
    return services.executeBatchPlan(request);
  }
  if (!services.executeBatchRun) return capabilityUnavailable("Batch render execution is unavailable.");
  return services.executeBatchRun(request);
}

async function isInsideAnyRoot(
  path: string,
  roots: string[],
  contains: (root: string, path: string) => Promise<boolean>
): Promise<boolean> {
  for (const root of roots) {
    if (await contains(root, path)) return true;
  }
  return false;
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
