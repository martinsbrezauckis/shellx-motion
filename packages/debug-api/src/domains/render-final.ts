/** Final-render command policy and typed handoff to the three render lanes. */
import { readFfmpegExportPreset, readImageSequenceExportPreset, readMotionExportPreset, readStillFrameExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { readBrowserWorkflowArg, parseBrowserWorkflow } from "./integration-browser-workflow.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { booleanArg, nonNegativeNumberArg, positiveIntegerArg, stringArg } from "./args.js";

export interface FinalRenderRequest {
  packageRoot: string;
  outputPath: string;
  framesDir?: string;
  receiptsRoot?: string;
  frameLane: "browser";
  preset: MotionExportPreset;
  atMs?: number;
  minUniqueFrameHashes?: number;
  workflow?: BrowserCaptureWorkflow;
  workflowPath?: string;
  qualityManifestPath?: string;
  dryRun: boolean;
}

export interface RenderFinalServices {
  receiptsRoot?: string;
  scratchRoot?: string;
  qualityInputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  readJson?: (path: string) => Promise<unknown>;
  executeStillFinalRender?: (request: FinalRenderRequest) => Promise<MotionDebugResult>;
  executeSequenceFinalRender?: (request: FinalRenderRequest) => Promise<MotionDebugResult>;
  executeFfmpegFinalRender?: (request: FinalRenderRequest) => Promise<MotionDebugResult>;
}

export async function dispatchRenderFinalCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderFinalServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.render.final") return null;
  const packageRoot = stringArg(args, "packageRoot");
  const outputPath = stringArg(args, "outputPath");
  const framesDir = stringArg(args, "framesDir") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const frameLane = stringArg(args, "frameLane") ?? "browser";
  const presetValue = stringArg(args, "preset") ?? "mp4-h264";
  const atMs = nonNegativeNumberArg(args, "atMs");
  const minUniqueFrameHashes = positiveIntegerArg(args, "minUniqueFrameHashes");
  const workflowArg = readBrowserWorkflowArg(args, "workflow");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
  const qualityManifestPath = stringArg(args, "qualityManifestPath") ?? stringArg(args, "manifestPath") ?? undefined;
  const dryRun = booleanArg(args, "dryRun") ?? false;
  if (!packageRoot) return invalidArgs("motion.render.final requires packageRoot.");
  if (!outputPath) return invalidArgs("motion.render.final requires outputPath.");
  // Lane naming is the single most common wrong-argument call: the Debug API rasterizes frames
  // through the browser lane only, while the CLI's separate --lane flag selects the delivery
  // lane (native | ffmpeg) and never accepts "browser". Name both in the error, not just the
  // rejected value.
  if (frameLane !== "browser") {
    return unsupportedEnumValue("frameLane", frameLane, ["browser"],
      "The Debug API renders frames through the browser lane. The CLI's --lane flag is a different argument (native | ffmpeg); pass --frame-lane for the rasterizer.");
  }
  const preset = readMotionExportPreset(presetValue);
  if (!preset) return unsupportedEnumValue("export preset", presetValue, "exportPreset");
  if (qualityManifestPath && !supportsQualityManifestPreset(preset)) {
    return invalidArgs("Final render quality manifest checks currently require a video, GIF, png-frame, or png-sequence export preset.");
  }
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (minUniqueFrameHashes === false) return invalidArgs("minUniqueFrameHashes must be a positive integer.");
  if (workflowArg === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  const readPaths = [workflowPath, qualityManifestPath].filter((path): path is string => Boolean(path));
  if (readPaths.length > 0 && !services.isPathInsideTrustedRoot) return capabilityUnavailable("Final render trusted-path validation is unavailable.");
  const trustedRoots = [packageRoot, services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? [])];
  for (const path of readPaths) {
    if (!await isInsideAnyRoot(path, trustedRoots, services.isPathInsideTrustedRoot!)) {
      const label = path === workflowPath ? "workflowPath" : "qualityManifestPath";
      return invalidArgs(`motion.render.final ${label} must be inside packageRoot or a trusted debug input root.`);
    }
  }
  if (workflowPath && !workflowArg && !services.readJson) return capabilityUnavailable("Browser workflow file reading is unavailable.");

  let workflow = workflowArg ?? undefined;
  if (!workflow && workflowPath) {
    try {
      const parsed = parseBrowserWorkflow(await services.readJson!(workflowPath));
      if (!parsed) return invalidArgs("Invalid browser workflow: expected shellx-motion/browser-workflow@1.");
      workflow = parsed;
    } catch (error) {
      return invalidArgs(`Invalid browser workflow: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const request: FinalRenderRequest = {
    packageRoot, outputPath, frameLane, preset, dryRun,
    ...(framesDir ? { framesDir } : {}),
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(atMs !== null ? { atMs } : {}),
    ...(minUniqueFrameHashes !== null ? { minUniqueFrameHashes } : {}),
    ...(workflow ? { workflow } : {}),
    ...(workflowPath ? { workflowPath } : {}),
    ...(qualityManifestPath ? { qualityManifestPath } : {})
  };
  if (readStillFrameExportPreset(preset)) {
    if (!services.executeStillFinalRender) return capabilityUnavailable("Still-frame final rendering is unavailable.");
    return services.executeStillFinalRender(request);
  }
  if (readImageSequenceExportPreset(preset)) {
    if (!services.executeSequenceFinalRender) return capabilityUnavailable("Image-sequence final rendering is unavailable.");
    return services.executeSequenceFinalRender(request);
  }
  if (!services.executeFfmpegFinalRender) return capabilityUnavailable("FFmpeg final rendering is unavailable.");
  return services.executeFfmpegFinalRender(request);
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

function supportsQualityManifestPreset(preset: MotionExportPreset): boolean {
  return Boolean(readFfmpegExportPreset(preset)) || preset === "png-frame" || preset === "png-sequence";
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
