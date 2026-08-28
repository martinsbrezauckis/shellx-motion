import { loadMotionPackage, motionScene3DAnimationLaneRefusal, type MotionDocument } from "@shellx-motion/core";
import { dirname, resolve } from "node:path";
import { localDebugContext } from "./local-debug-context";
import { LocalMotionSdkError } from "./local-result";
import type { LocalMotionSdkOptions } from "./local.js";

/** The local SDK must refuse before creating a Debug context or output path. */
export function localGpuPreviewScene3dAnimationRefusal(motion: MotionDocument): LocalMotionSdkError | undefined {
  const refusal = motionScene3DAnimationLaneRefusal(motion, "gpu-static");
  return refusal && new LocalMotionSdkError(refusal.code, "Local SDK GPU preview does not admit document scene3dAnimation@1; the strict O6 lowerer is available only through the direct @shellx-motion/renderer-browser renderMotionGpuPreview API.", false);
}

/** Loads and settles local GPU preview refusal before a Debug context or output path exists. */
export async function prepareLocalPreviewAdmission(
  input: { packageRoot: string; outDir: string; lane?: "browser" | "gpu"; workflowPath?: string },
  options: LocalMotionSdkOptions,
) {
  const pkg = await loadMotionPackage(input.packageRoot);
  const refusal = input.lane === "gpu" ? localGpuPreviewScene3dAnimationRefusal(pkg.motion) : undefined;
  if (refusal) throw refusal;
  return {
    pkg,
    context: localDebugContext("render_motion", options, resolve(input.outDir), [pkg.root, ...(input.workflowPath ? [dirname(resolve(input.workflowPath))] : [])]),
  };
}
