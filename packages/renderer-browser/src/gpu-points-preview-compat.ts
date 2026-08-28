import { motionScene3DAnimationStorePresent, type MotionPackage } from "@shellx-motion/core";
import { gpuPreviewPackageMotionData } from "./gpu-preview-package-motion-data.js";
import { renderMotionGpuPreview } from "./gpu-points-preview.js";
import type { GpuPreviewFrame, GpuPreviewFrameOptions, GpuPreviewResult, GpuPreviewSession } from "./gpu-preview-session-types.js";
import type { GpuPreviewOneShotOptions } from "./gpu-preview-one-shot.js";

/**
 * Compatibility aliases retained for callers that adopted the v0.2 points preview API. They
 * retain the legacy general GPU scene contract and do not acquire the direct O6 authority.
 */
export function renderMotionGpuPointsPreview(pkg: MotionPackage, options: GpuPreviewOneShotOptions): Promise<GpuPreviewResult> {
  const motion = gpuPreviewPackageMotionData(pkg);
  if (!motion || motionScene3DAnimationStorePresent(motion)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: "gpu_unsupported_feature",
        message: "The historical renderMotionGpuPointsPreview compatibility alias does not admit document scene3dAnimation@1; only the direct @shellx-motion/renderer-browser renderMotionGpuPreview API is available."
      }
    });
  }
  return renderMotionGpuPreview(pkg, options);
}

export type GpuPointsPreviewFrameOptions = GpuPreviewFrameOptions;
export type GpuPointsPreviewFrame = GpuPreviewFrame;
export type GpuPointsPreviewResult = GpuPreviewResult;
export type GpuPointsPreviewSession = GpuPreviewSession;
