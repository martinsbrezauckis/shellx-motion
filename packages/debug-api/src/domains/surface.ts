import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { nonNegativeNumberArg, stringArg } from "./args.js";
import { dispatchSurfacePackagePanelCommand, type SurfacePackagePanelServices } from "./surface-package-panels.js";
import { dispatchSurfaceExportCommand, type SurfaceExportServices } from "./surface-export.js";
import { dispatchSurfaceStoryboardCommand, type SurfaceStoryboardServices } from "./surface-storyboard.js";
import { dispatchSurfaceStateCommand, type SurfaceStateServices } from "./surface-state.js";

export interface SurfaceDomainServices extends SurfacePackagePanelServices, SurfaceExportServices, SurfaceStoryboardServices, SurfaceStateServices {}

export async function dispatchSurfaceCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: SurfaceDomainServices = {}
): Promise<MotionDebugResult | null> {
  const packagePanel = await dispatchSurfacePackagePanelCommand(command, args, services);
  if (packagePanel) return packagePanel;
  const exportSurface = await dispatchSurfaceExportCommand(command, args, services);
  if (exportSurface) return exportSurface;
  const storyboardSurface = await dispatchSurfaceStoryboardCommand(command, args, services);
  if (storyboardSurface) return storyboardSurface;
  const stateSurface = await dispatchSurfaceStateCommand(command, args, services);
  if (stateSurface) return stateSurface;
  if (command === "motion.open") {
    const panel = stringArg(args, "panel") ?? "preview";
    return { ok: true, visibleState: { panel }, warnings: [] };
  }

  if (command === "motion.select" || command === "motion.highlight") {
    const selection = selectionTarget(args);
    const durationMs = nonNegativeNumberArg(args, "durationMs");
    const packageId = stringArg(args, "packageId") ?? undefined;
    const motionId = stringArg(args, "motionId") ?? undefined;
    const operation = command === "motion.select" ? "select" : "highlight";
    if (!selection) return invalidArgs(`${command} requires layerId, trackId, markerId, sceneId, or targetId.`);
    if (durationMs === false) return invalidArgs("durationMs must be a non-negative number.");
    const response = {
      panel: "timeline",
      operation,
      selection,
      ...(packageId ? { packageId } : {}),
      ...(motionId ? { motionId } : {}),
      ...(durationMs !== null ? { durationMs } : {})
    };
    return {
      ok: true,
      visibleState: response,
      result: {
        ok: true,
        selection,
        ...(packageId ? { packageId } : {}),
        ...(motionId ? { motionId } : {}),
        ...(durationMs !== null ? { durationMs } : {})
      },
      warnings: []
    };
  }

  return null;
}

function selectionTarget(args: unknown): { kind: "layer" | "track" | "marker" | "scene" | "target"; id: string } | null {
  const candidates = [
    ["layer", stringArg(args, "layerId") ?? stringArg(args, "layer")],
    ["track", stringArg(args, "trackId") ?? stringArg(args, "track")],
    ["marker", stringArg(args, "markerId") ?? stringArg(args, "marker")],
    ["scene", stringArg(args, "sceneId") ?? stringArg(args, "scene")],
    ["target", stringArg(args, "targetId") ?? stringArg(args, "id")]
  ] as const;
  const found = candidates.find((candidate) => Boolean(candidate[1]));
  return found?.[1] ? { kind: found[0], id: found[1] } : null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
