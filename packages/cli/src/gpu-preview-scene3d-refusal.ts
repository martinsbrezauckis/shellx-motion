import { activeScriptLayers, motionScene3DAnimationLaneRefusal, type MotionDocument } from "@shellx-motion/core";
import { activeScriptCliRefusal } from "./agent-script-cli-refusal";
import type { CliResult } from "./main.js";

/** CLI is intentionally outside O6's direct renderer-browser-only preview surface. */
export function cliGpuPreviewScene3dAnimationRefusal(motion: MotionDocument): { code: string; message: string } | undefined {
  const refusal = motionScene3DAnimationLaneRefusal(motion, "gpu-static");
  return refusal && { code: refusal.code, message: "CLI GPU preview does not admit document scene3dAnimation@1; the strict O6 lowerer is available only through the direct @shellx-motion/renderer-browser renderMotionGpuPreview API." };
}

/** All preview lanes settle their no-work document refusals before output setup. */
export function previewCommandAdmissionRefusal(motion: MotionDocument, lane: "native" | "browser" | "gpu"): CliResult | undefined {
  if (lane === "browser" && activeScriptLayers(motion).length > 0) return activeScriptCliRefusal("preview");
  const scene3dAnimationRefusal = lane === "gpu" ? cliGpuPreviewScene3dAnimationRefusal(motion) : undefined;
  return scene3dAnimationRefusal && { ok: false, command: "preview", lane: "gpu", error: scene3dAnimationRefusal };
}
