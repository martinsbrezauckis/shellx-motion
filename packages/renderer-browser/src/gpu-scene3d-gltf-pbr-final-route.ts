import {
  hasScene3dGltfPbrFinalLocator,
  resolveScene3dGltfPbrFinalRoute,
  type Scene3dGltfPbrFinalRoute,
} from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import type { MotionPackage } from "@shellx-motion/core";
import { GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG } from "./gpu-page-scene3d-gltf-pbr-contract";

export type GpuScene3dGltfPbrFinalRouteResolution =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "present"; readonly route: Scene3dGltfPbrFinalRoute }>;

/**
 * The manifest marker is only a router hint. A present marker always reopens the package through
 * Core and binds this independently versioned Browser catalog before any GPU resource is opened.
 */
export async function resolveGpuScene3dGltfPbrFinalRoute(pkg: MotionPackage): Promise<GpuScene3dGltfPbrFinalRouteResolution> {
  if (!hasScene3dGltfPbrFinalLocator(pkg.manifest.data)) return Object.freeze({ kind: "absent" });
  return await resolveScene3dGltfPbrFinalRoute(pkg, GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256);
}

export function hasGpuScene3dGltfPbrFinalRouteMarker(pkg: MotionPackage): boolean {
  return hasScene3dGltfPbrFinalLocator(pkg.manifest.data);
}
