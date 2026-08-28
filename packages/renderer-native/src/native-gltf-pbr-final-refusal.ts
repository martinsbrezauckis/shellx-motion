import { hasScene3dGltfPbrFinalLocator } from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import type { MotionPackage } from "@shellx-motion/core";

/** The native raster lane must not flatten a package selected for fixed PBR direct final. */
export class NativeGltfPbrFinalRouteRefusal extends Error {
  readonly code = "gltf_pbr_final_direct_final_only" as const;

  constructor() {
    super("The marked glTF PBR package refuses native preview; only the authenticated 1280x720 static GPU direct-final lane is admitted.");
    this.name = "NativeGltfPbrFinalRouteRefusal";
  }
}

export function assertNativeGltfPbrFinalRefusal(pkg: MotionPackage): void {
  if (hasScene3dGltfPbrFinalLocator(pkg.manifest.data)) throw new NativeGltfPbrFinalRouteRefusal();
}
