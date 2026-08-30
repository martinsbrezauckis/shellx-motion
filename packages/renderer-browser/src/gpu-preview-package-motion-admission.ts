import { motionScene3DAnimationStorePresent, type MotionPackage } from "@shellx-motion/core";
import { gltfPbrFinalEntrypointRefusal, type GltfPbrFinalEntrypointRefusal } from "./gltf-pbr-final-entrypoint-refusal";
import { gpuPreviewPackageMotionData } from "./gpu-preview-package-motion-data";

export type GpuPreviewPackageMotionAdmission =
  | { ok: true; sourceMotion: MotionPackage["motion"]; o6Present: boolean }
  | { ok: false; error: GltfPbrFinalEntrypointRefusal | { code: "gpu_unsupported_feature"; message: string } };

/**
 * Establishes the two package authorities shared by every GPU preview session without invoking
 * package Motion getters. Generic PBR refusal runs before ordinary Motion processing, but O6
 * retains its later descriptor-specific manifest fence.
 */
export function admitGpuPreviewPackageMotion(pkg: MotionPackage): GpuPreviewPackageMotionAdmission {
  const sourceMotion = gpuPreviewPackageMotionData(pkg);
  const o6Present = sourceMotion ? motionScene3DAnimationStorePresent(sourceMotion) : false;
  if (!o6Present) {
    const pbrRefusal = gltfPbrFinalEntrypointRefusal(pkg, "gpu-preview");
    if (pbrRefusal) return { ok: false, error: pbrRefusal };
  }
  if (!sourceMotion) {
    return {
      ok: false,
      error: {
        code: "gpu_unsupported_feature",
        message: "GPU preview requires package Motion as an own descriptor-safe data field before resource or output work."
      }
    };
  }
  return { ok: true, sourceMotion, o6Present };
}
