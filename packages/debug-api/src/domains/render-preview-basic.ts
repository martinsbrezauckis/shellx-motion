/** Preview panel inspection and single-frame rendering. */
import { hashBuffer, type MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import {
  parseBrowserWorkflow,
  readBrowserWorkflowArg,
  type BrowserFrameRenderer
} from "./integration-browser-workflow.js";
import { nonNegativeNumberArg, stringArg } from "./args.js";

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
  const outputPath = stringArg(args, "outputPath") ?? undefined;
  const atMs = nonNegativeNumberArg(args, "atMs") ?? 0;
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.preview.frame requires packageRoot.");
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  const workflowArg = readBrowserWorkflowArg(args, "workflow");
  if (workflowArg === false) return invalidArgs("workflow must be a shellx-motion/browser-workflow@1 object.");
  const workflowPath = stringArg(args, "workflowPath") ?? undefined;
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
    return { ok: false, error: { code: "preview_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
  }
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
