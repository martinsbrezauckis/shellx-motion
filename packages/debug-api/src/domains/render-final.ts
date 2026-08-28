/** Final-render command policy and typed handoff to the three render lanes. */
import { readFfmpegExportPreset, readImageSequenceExportPreset, readMotionExportPreset, readStillFrameExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { readBrowserWorkflowArg, parseBrowserWorkflow } from "./integration-browser-workflow.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { booleanArg, nonNegativeNumberArg, ownDataArg, positiveIntegerArg, stringArg } from "./args.js";
import {
  admitConfiguredRenderInputFile,
  assertConfiguredRenderOutputDirectory,
  assertConfiguredRenderOutputFile,
  assertConfiguredRenderPackageRoot,
  type RenderRootPolicy
} from "./render-root-policy.js";

export interface FinalRenderRequest {
  packageRoot: string;
  outputPath: string;
  framesDir?: string;
  keepFrames?: boolean;
  receiptsRoot?: string;
  /** GPU final delivery is strict raw-RGBA FFmpeg video, direct or durably segmented. */
  frameLane: "browser" | "native" | "gpu";
  preset: MotionExportPreset;
  atMs?: number;
  minUniqueFrameHashes?: number;
  workflow?: BrowserCaptureWorkflow;
  workflowPath?: string;
  qualityManifestPath?: string;
  dryRun: boolean;
  /** Opt-in only: reuse a v2 content-bound final artifact at this exact output path. */
  reuseAttested: boolean;
  /** Closed high-level durable delivery selector; the store is always derived from outputPath. */
  segmented?: { segmentFrames: number; resume?: boolean };
}

export interface RenderFinalServices {
  receiptsRoot?: string;
  scratchRoot?: string;
  /** Retained for render-cache-plan compatibility; final/batch use renderRootPolicy instead. */
  qualityInputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  /** Render roots are host configuration, never derived from request fields. */
  renderRootPolicy?: RenderRootPolicy;
  readJson?: (path: string) => Promise<unknown>;
  /** Internal batch-only proof that this exact manifest is an already-retained closure. */
  retainedBatchQualityManifestPath?: string;
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
  const keepFrames = booleanArg(args, "keepFrames");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const frameLaneValue = stringArg(args, "frameLane") ?? "browser";
  const presetValue = stringArg(args, "preset") ?? "mp4-h264";
  const atMs = nonNegativeNumberArg(args, "atMs");
  const minUniqueFrameHashes = positiveIntegerArg(args, "minUniqueFrameHashes");
  const workflowArg = readBrowserWorkflowArg(args, "workflow");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
  const qualityManifestPath = stringArg(args, "qualityManifestPath") ?? stringArg(args, "manifestPath") ?? undefined;
  const dryRun = booleanArg(args, "dryRun") ?? false;
  const reuseAttested = booleanArg(args, "reuseAttested") ?? false;
  const segmented = segmentedArg(args);
  if (!packageRoot) return invalidArgs("motion.render.final requires packageRoot.");
  if (!outputPath) return invalidArgs("motion.render.final requires outputPath.");
  // `frameLane` is the rasterizer, not the CLI's separate delivery-lane `--lane` argument.
  // Each selected rasterizer is strict: unsupported content and unavailable hardware fail in the
  // selected lane rather than selecting browser/native after the caller has chosen GPU.
  if (frameLaneValue !== "browser" && frameLaneValue !== "native" && frameLaneValue !== "gpu") {
    return unsupportedEnumValue("frameLane", frameLaneValue, ["browser", "native", "gpu"],
      "frameLane selects the browser, native, or strict GPU rasterizer. GPU is available only for strict raw-RGBA FFmpeg final-video delivery and never falls back.");
  }
  const frameLane = frameLaneValue;
  const preset = readMotionExportPreset(presetValue);
  if (!preset) return unsupportedEnumValue("export preset", presetValue, "exportPreset");
  if (keepFrames === true && !readFfmpegExportPreset(preset)) {
    return invalidArgs("motion.render.final keepFrames requires a final-video FFmpeg preset.");
  }
  if (reuseAttested && dryRun) return invalidArgs("motion.render.final reuseAttested cannot be combined with dryRun.");
  if (reuseAttested && frameLane === "gpu") {
    return invalidArgs("GPU final rendering cannot use reuseAttested: its post-render identity is evidence only and never authorizes cache planning or reuse.");
  }
  if (reuseAttested && keepFrames === true) {
    return invalidArgs("motion.render.final reuseAttested does not retain diagnostic frame directories; omit keepFrames.");
  }
  if (reuseAttested && readImageSequenceExportPreset(preset)) {
    return invalidArgs("motion.render.final reuseAttested currently supports file-producing presets only, not png-sequence.");
  }
  if (segmented === false) return invalidArgs("segmented must be { segmentFrames: positive safe integer, resume?: boolean } with no additional properties.");
  if (segmented) {
    if (!readFfmpegExportPreset(preset)) return invalidArgs("Segmented final delivery requires a final-video FFmpeg preset.");
    if (keepFrames === true || framesDir) return invalidArgs("Segmented final delivery owns a derived durable checkpoint store and does not accept keepFrames or framesDir.");
    if (workflowArg || workflowPath) return invalidArgs("Segmented final delivery does not support browser workflows.");
    if (qualityManifestPath) return invalidArgs("Segmented final delivery does not support exact-source quality manifests.");
    if (reuseAttested) return invalidArgs("Segmented final delivery cannot be combined with reuseAttested.");
    if (atMs !== null) return invalidArgs("Segmented final delivery renders the full canonical video timeline and does not accept atMs.");
  }
  if (qualityManifestPath && !supportsQualityManifestPreset(preset)) {
    return invalidArgs("Final render quality manifest checks currently require a video, GIF, png-frame, or png-sequence export preset.");
  }
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (minUniqueFrameHashes === false) return invalidArgs("minUniqueFrameHashes must be a positive integer.");
  if (workflowArg === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  if (frameLane === "native" && (workflowArg || workflowPath)) {
    return invalidArgs("Browser workflows require frameLane browser; native final rendering never falls back to browser.");
  }
  if (frameLane === "gpu" && (workflowArg || workflowPath)) {
    return invalidArgs("GPU final rendering does not support browser workflows; it never falls back to browser materialization.");
  }
  if (frameLane === "gpu" && qualityManifestPath && services.retainedBatchQualityManifestPath !== qualityManifestPath) {
    return invalidArgs("GPU final rendering does not support exact-source quality manifests because they require materialized frames; it never falls back.");
  }
  try {
    const policy = services.renderRootPolicy ?? { enforce: false };
    await assertConfiguredRenderPackageRoot(packageRoot, policy, "motion.render.final packageRoot");
    await assertConfiguredRenderOutputFile(outputPath, policy, "motion.render.final outputPath");
    if (framesDir) await assertConfiguredRenderOutputDirectory(framesDir, policy, "motion.render.final framesDir");
    if (receiptsRoot) await assertConfiguredRenderOutputDirectory(receiptsRoot, policy, "motion.render.final receiptsRoot");
    if (workflowPath) await admitConfiguredRenderInputFile(workflowPath, policy, "motion.render.final workflowPath");
    if (qualityManifestPath) await admitConfiguredRenderInputFile(qualityManifestPath, policy, "motion.render.final qualityManifestPath");
  } catch (error) {
    return invalidArgs(error instanceof Error ? error.message : "motion.render.final render filesystem authority is unavailable.");
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
    packageRoot, outputPath, frameLane, preset, dryRun, reuseAttested,
    ...(framesDir ? { framesDir } : {}),
    ...(keepFrames !== null ? { keepFrames } : {}),
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(atMs !== null ? { atMs } : {}),
    ...(minUniqueFrameHashes !== null ? { minUniqueFrameHashes } : {}),
    ...(workflow ? { workflow } : {}),
    ...(workflowPath ? { workflowPath } : {}),
    ...(qualityManifestPath ? { qualityManifestPath } : {}),
    ...(segmented ? { segmented } : {})
  };
  if (readStillFrameExportPreset(preset)) {
    if (frameLane === "gpu") return invalidArgs("GPU final rendering supports streamed FFmpeg video only, not still-frame presets.");
    if (!services.executeStillFinalRender) return capabilityUnavailable("Still-frame final rendering is unavailable.");
    return services.executeStillFinalRender(request);
  }
  if (readImageSequenceExportPreset(preset)) {
    if (frameLane === "gpu") return invalidArgs("GPU final rendering supports streamed FFmpeg video only, not image-sequence presets.");
    if (!services.executeSequenceFinalRender) return capabilityUnavailable("Image-sequence final rendering is unavailable.");
    return services.executeSequenceFinalRender(request);
  }
  if (!services.executeFfmpegFinalRender) return capabilityUnavailable("FFmpeg final rendering is unavailable.");
  return services.executeFfmpegFinalRender(request);
}

function segmentedArg(args: unknown): { segmentFrames: number; resume?: boolean } | false | null {
  const entry = ownDataArg(args, "segmented");
  if (!entry || entry.value === undefined || entry.value === null) return null;
  if (typeof entry.value !== "object" || Array.isArray(entry.value)) return false;
  const value = entry.value as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length < 1 || keys.length > 2 || !keys.includes("segmentFrames") || keys.some((key) => key !== "segmentFrames" && key !== "resume")) return false;
  if (!Number.isSafeInteger(value.segmentFrames) || (value.segmentFrames as number) <= 0) return false;
  if (value.resume !== undefined && typeof value.resume !== "boolean") return false;
  return { segmentFrames: value.segmentFrames as number, ...(value.resume === true ? { resume: true } : {}) };
}

/** Shared legacy helper used by the cache-plan domain; render execution does not use it. */
export async function isInsideAnyRoot(
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
