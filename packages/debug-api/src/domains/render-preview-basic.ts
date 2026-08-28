/** Preview panel inspection and single-frame rendering. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { compileGpuSceneStaticPlan, hashBuffer, motionScene3DAnimationLaneRefusal, type MotionPackage } from "@shellx-motion/core";
import { renderMotionGpuPreview } from "@shellx-motion/renderer-browser";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { createDebugGpuPreviewSessionOptions, type DebugGpuPreviewVideoServices } from "../debug-gpu-preview-video-provider.js";
import { corePublicationUncertainty, normalizePublicationUncertainty } from "../publication-uncertainty.js";
import {
  parseBrowserWorkflow,
  readBrowserWorkflowArg,
  type BrowserFrameRenderer
} from "./integration-browser-workflow.js";
import { nonNegativeNumberArg, stringArg } from "./args.js";
import { isInsideAnyTrustedInputRoot } from "./trusted-input-path.js";

interface PreviewPanelView {
  counts: { layers: number; scenes: number; markers: number };
}

interface PreviewPanelState {
  panel: PreviewPanelView;
  playheadMs: number;
  hasSelectedRange: boolean;
  warnings: string[];
}

export interface RenderPreviewBasicServices {
  scratchRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  readPreviewPanel?: (pkg: MotionPackage) => Promise<PreviewPanelState>;
  browserFrameRenderer?: BrowserFrameRenderer;
  readJson?: (path: string) => Promise<unknown>;
  qualityInputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  /** Dispatch-owned video decoding authority. Never read from motion.preview.frame arguments. */
  gpuPreviewVideo?: DebugGpuPreviewVideoServices;
}

export async function dispatchRenderPreviewBasicCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderPreviewBasicServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.preview.panel") return panel(args, services);
  if (command === "motion.preview.frame") return frame(args, services);
  return null;
}

async function panel(args: unknown, services: RenderPreviewBasicServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.preview.panel requires packageRoot.");
  if (!services.packageLoader || !services.readPreviewPanel) return capabilityUnavailable("Preview panel reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const loaded = await services.readPreviewPanel(pkg);
  return {
    ok: true,
    receiptId: `preview-panel-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify(loaded.panel), "utf8")).slice(0, 16)}`,
    visibleState: {
      panel: "preview", operation: "preview.panel", packageId: pkg.manifest.id, motionId: pkg.motion.id,
      durationMs: pkg.motion.durationMs, fps: pkg.motion.fps, width: pkg.motion.width, height: pkg.motion.height,
      playheadMs: loaded.playheadMs, layerCount: loaded.panel.counts.layers,
      sceneCount: loaded.panel.counts.scenes, markerCount: loaded.panel.counts.markers,
      hasSelectedRange: loaded.hasSelectedRange
    },
    result: { ok: true, ...loaded.panel }, warnings: loaded.warnings
  };
}

async function frame(args: unknown, services: RenderPreviewBasicServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? services.scratchRoot ?? ".scratch/debug-preview";
  const outputPath = stringArg(args, "outputPath") ?? join(outDir, `preview-${randomUUID()}.png`);
  const atMs = nonNegativeNumberArg(args, "atMs") ?? 0;
  const lane = stringArg(args, "lane") ?? "browser";
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.preview.frame requires packageRoot.");
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (lane !== "browser" && lane !== "gpu") return invalidArgs("motion.preview.frame lane must be browser or gpu.");
  if (lane === "gpu" && hasBrowserWorkflowInput(args)) {
    return invalidArgs("motion.preview.frame lane gpu does not accept browser workflow or workflowPath inputs.");
  }
  if (lane === "gpu") return gpuFrame({ packageRoot, outDir, outputPath, atMs, createdAt }, services);
  const workflowArg = readBrowserWorkflowArg(args, "workflow");
  if (workflowArg === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
  if (workflowPath) {
    if (!services.isPathInsideTrustedRoot) return capabilityUnavailable("Preview trusted-path validation is unavailable.");
    const roots = [packageRoot, services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? [])];
    if (!await isInsideAnyTrustedInputRoot(workflowPath, roots, services.isPathInsideTrustedRoot)) {
      return invalidArgs("motion.preview.frame workflowPath must be inside packageRoot or a trusted debug input root.");
    }
  }
  let workflow = workflowArg ?? undefined;
  if (!workflow && workflowPath) {
    if (!services.readJson) return capabilityUnavailable("Browser workflow JSON reading is unavailable.");
    try {
      const parsed = parseBrowserWorkflow(await services.readJson(workflowPath));
      if (!parsed) return invalidArgs("Invalid browser workflow: expected shellx-motion/browser-workflow@1.");
      workflow = parsed;
    } catch (error) {
      return invalidArgs(`Invalid browser workflow: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!services.packageLoader || !services.browserFrameRenderer) return capabilityUnavailable("Browser preview rendering is unavailable.");
  try {
    const pkg = await services.packageLoader(packageRoot);
    const preview = await services.browserFrameRenderer(pkg, {
      atMs, outDir, ...(outputPath ? { outputPath } : {}), ...(workflow ? { workflow } : {}),
      ...(createdAt ? { now: () => createdAt } : {})
    });
    return {
      ok: true, receiptId: preview.receipt.id,
      visibleState: { panel: "preview", operation: "preview.frame", packageId: pkg.manifest.id, atMs, outputPath: preview.output.path },
      result: { ok: true, lane: "browser", packageId: pkg.manifest.id, output: preview.output, receipt: preview.receipt },
      warnings: preview.receipt.warnings
    };
  } catch (error) {
    const uncertain = debugPreviewPublicationFailure(error);
    if (uncertain) return uncertain;
    return { ok: false, error: { code: "preview_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
  }
}

async function gpuFrame(
  input: { packageRoot: string; outDir: string; outputPath?: string; atMs: number; createdAt?: string },
  services: RenderPreviewBasicServices
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return capabilityUnavailable("GPU preview package loading is unavailable.");
  try {
    const pkg = await services.packageLoader(input.packageRoot);
    const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(pkg.motion, "gpu-static");
    if (scene3dAnimationRefusal) {
      return {
        ok: false,
        error: {
          code: scene3dAnimationRefusal.code,
          message: "Debug GPU preview does not admit document scene3dAnimation@1; the strict O6 lowerer is available only through the direct @shellx-motion/renderer-browser renderMotionGpuPreview API."
        },
        warnings: []
      };
    }
    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    const moduleBearing = pkg.motion.layers.some((layer) => Object.prototype.hasOwnProperty.call(layer, "effectModule"));
    const videoSession = staticPlan.ok && staticPlan.plan.maxima.maxVideoCount > 0
      ? createDebugGpuPreviewSessionOptions(services.gpuPreviewVideo ?? {})
      // Module resolution happens in the renderer through its opaque authority. Defer the video
      // check so a module-only document still reaches that fail-closed boundary before any host
      // resource or browser can open; if the resolved document needs video, the provider refuses.
      : moduleBearing
        ? createDebugGpuPreviewSessionOptions(services.gpuPreviewVideo ?? {}, { deferVideoCapabilityCheck: true })
        : undefined;
    if (videoSession && !videoSession.ok) return capabilityUnavailable(videoSession.message);
    const preview = await renderMotionGpuPreview(pkg, {
      atMs: input.atMs,
      outDir: input.outDir,
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
      ...(input.createdAt ? { now: () => input.createdAt! } : {}),
      ...(services.gpuPreviewVideo?.signal ? { signal: services.gpuPreviewVideo.signal } : {}),
      ...(videoSession?.ok ? { sessionOptions: videoSession.sessionOptions } : {})
    });
    if (!preview.ok) {
      return debugGpuPreviewFailure(preview.error) ?? { ok: false, error: preview.error, warnings: [] };
    }
    return {
      ok: true,
      receiptId: preview.receipt.id,
      visibleState: { panel: "preview", operation: "preview.gpu.frame", packageId: pkg.manifest.id, atMs: input.atMs, outputPath: preview.frame.path },
      result: { ok: true, lane: "gpu", packageId: pkg.manifest.id, output: preview.frame, receipt: preview.receipt },
      warnings: preview.receipt.warnings
    };
  } catch (error) {
    const uncertain = debugPreviewPublicationFailure(error);
    if (uncertain) return uncertain;
    return { ok: false, error: { code: "gpu_preview_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
  }
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

/** Browser renderer throws Core uncertainty; it becomes one canonical Debug failure envelope. */
export function debugPreviewPublicationFailure(error: unknown): MotionDebugResult | undefined {
  const uncertainty = corePublicationUncertainty(error);
  if (!uncertainty) return undefined;
  return {
    ok: false,
    error: {
      code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "publication_commit_uncertain",
      message: error instanceof Error ? error.message : "Publication commit may have completed.",
      detail: uncertainty
    },
    result: uncertainty,
    warnings: []
  };
}

/** Direct renderer result already carries the marker; normalize old singular aliases at Debug. */
export function debugGpuPreviewFailure(error: unknown): MotionDebugResult | undefined {
  const uncertainty = normalizePublicationUncertainty(error);
  if (!uncertainty) return undefined;
  const record = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : undefined;
  return {
    ok: false,
    error: {
      ...(record ?? {}),
      code: typeof record?.code === "string" ? record.code : "publication_commit_uncertain",
      message: typeof record?.message === "string" ? record.message : "Publication commit may have completed.",
      detail: uncertainty
    },
    result: uncertainty,
    warnings: []
  };
}

function hasBrowserWorkflowInput(args: unknown): boolean {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    && ("workflow" in args || "workflowPath" in args);
}
