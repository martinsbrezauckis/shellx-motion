import { GpuSceneResourceError } from "./gpu-scene-resources";

export function gpuPreviewResourceFailure(error: unknown): { code: string; message: string; layerId?: string } {
  if (error instanceof GpuSceneResourceError) return { code: error.code, message: error.message, ...(error.layerId ? { layerId: error.layerId } : {}) };
  return { code: "gpu_scene_resource_refused", message: error instanceof Error ? error.message : "GPU preview resources could not be prepared." };
}

export function gpuPreviewPlanFailure(failure: { code: string; message: string; layerId?: string }): { code: string; message: string; layerId?: string } {
  if (failure.message.includes("prepared exact decoded frame")) {
    return { code: "gpu_video_preview_unsupported", message: "GPU preview refuses video until bounded exact single-frame video staging is available.", ...(failure.layerId ? { layerId: failure.layerId } : {}) };
  }
  return failure;
}
