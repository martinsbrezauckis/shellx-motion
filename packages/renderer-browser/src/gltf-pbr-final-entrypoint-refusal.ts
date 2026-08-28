import { hasScene3dGltfPbrFinalLocator } from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import type { MotionPackage } from "@shellx-motion/core";

export type GltfPbrFinalUnsupportedEntrypoint = "browser-preview" | "gpu-preview";

export interface GltfPbrFinalEntrypointRefusal {
  readonly code: "gltf_pbr_final_direct_final_only";
  readonly message: string;
}

/**
 * Marker presence is enough to exclude generic rendering. Its records are untrusted until the
 * direct-final resolver reopens and cross-binds them, so no generic resource may be prepared.
 */
export function gltfPbrFinalEntrypointRefusal(
  pkg: MotionPackage,
  entrypoint: GltfPbrFinalUnsupportedEntrypoint,
): GltfPbrFinalEntrypointRefusal | undefined {
  if (!hasScene3dGltfPbrFinalLocator(pkg.manifest.data)) return undefined;
  return gltfPbrFinalPresentMarkerRefusal(entrypoint);
}

/** Creates the one generic-entrypoint refusal after a caller has safely established marker presence. */
export function gltfPbrFinalPresentMarkerRefusal(
  entrypoint: GltfPbrFinalUnsupportedEntrypoint,
): GltfPbrFinalEntrypointRefusal {
  return Object.freeze({
    code: "gltf_pbr_final_direct_final_only",
    message: `The marked glTF PBR package refuses ${entrypoint}; only the authenticated 1280x720 static GPU direct-final lane is admitted.`,
  });
}

export class GltfPbrFinalEntrypointError extends Error {
  readonly code = "gltf_pbr_final_direct_final_only" as const;

  constructor(refusal: GltfPbrFinalEntrypointRefusal) {
    super(refusal.message);
    this.name = "GltfPbrFinalEntrypointError";
  }
}
