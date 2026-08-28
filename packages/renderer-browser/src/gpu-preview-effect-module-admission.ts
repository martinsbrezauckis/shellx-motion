import type { PreparedGpuSceneResources } from "./gpu-scene-resources";
import { gpuPreviewResourceFailure } from "./gpu-preview-refusal";

type GpuPreviewAdmissionFailure = { code: string; message: string; layerId?: string };
type GpuPreviewResourcesAdmission = { ok: true; resources?: PreparedGpuSceneResources } | { ok: false; error: GpuPreviewAdmissionFailure };
type GpuPreviewReadyResources = { ok: true; resources: PreparedGpuSceneResources } | { ok: false; error: GpuPreviewAdmissionFailure };

export async function admitGpuPreviewEffectModuleResources(moduleBearing: boolean, packageHasVideo: boolean, prepare: () => Promise<PreparedGpuSceneResources>): Promise<GpuPreviewResourcesAdmission> {
  if (moduleBearing && packageHasVideo) return { ok: false, error: { code: "gpu_effect_module_video_unsupported", message: "GPU effect-module preview currently refuses video packages before decoder, scene-resource, or runtime opening." } };
  if (moduleBearing) return { ok: true };
  try {
    return { ok: true, resources: await prepare() };
  } catch (error) {
    return { ok: false, error: gpuPreviewResourceFailure(error) };
  }
}

export async function prepareGpuPreviewAdmittedSceneResources(resources: PreparedGpuSceneResources | undefined, prepare: () => Promise<PreparedGpuSceneResources>): Promise<GpuPreviewReadyResources> {
  if (resources) return { ok: true, resources };
  try {
    return { ok: true, resources: await prepare() };
  } catch (error) {
    return { ok: false, error: gpuPreviewResourceFailure(error) };
  }
}
