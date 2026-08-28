import { parseGltfContainer, MAX_GLTF_SOURCE_BYTES } from "./gltf-container";
import { readVerifiedPackageAsset } from "./package-asset-read";
import { loadMotionPackage } from "./package";
import { prepareScene3dGltfMaterialRenderPlan } from "./scene-3d-gltf-material-render-plan";
import type { Scene3dGltfMaterialAssetDeclaration } from "./scene-3d-gltf-material-assets-types";
import type { Scene3dGltfMaterialRenderPlan } from "./scene-3d-gltf-material-render-types";
import type { ParsedGltfContainer } from "./gltf-types";
import type { MotionPackage } from "./types";

export { buildScene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-build";
export { scene3dGltfMaterialAssetManifestData } from "./scene-3d-gltf-material-assets-package";
export { validateScene3dGltfMaterialRenderCleanup } from "./scene-3d-gltf-material-render-cleanup";
export { SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION, type Scene3dGltfPbrDirectFinalAdmission } from "./scene-3d-gltf-material-assets-types";
export { admitGltfContainedPbrLowering, lowerAdmittedGltfContainedPbrToMotion, type GltfContainedPbrLoweringAuthority } from "./gltf-contained-pbr-lowering";

/**
 * Reopens a persisted glTF PBR sidecar using the package manifest identity read from disk.
 * Package IDs are never accepted from this route's caller.
 */
export async function prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage(
  packageRoot: string,
): Promise<Scene3dGltfMaterialRenderPlan> {
  const source = await openScene3dGltfMaterialAuthenticatedSource(packageRoot);
  return await prepareScene3dGltfMaterialRenderPlan({
    packageRoot: source.pkg.root,
    packageId: source.pkg.manifest.id,
    declaration: source.declaration,
    container: source.container,
  });
}

/** Reopens the package-owned glTF source once so marker routes can derive canonical scene state. */
export interface Scene3dGltfMaterialAuthenticatedSource {
  readonly pkg: MotionPackage;
  readonly declaration: Scene3dGltfMaterialAssetDeclaration;
  readonly container: ParsedGltfContainer;
}

export async function openScene3dGltfMaterialAuthenticatedSource(
  packageRoot: string,
): Promise<Scene3dGltfMaterialAuthenticatedSource> {
  const pkg = await loadMotionPackage(packageRoot);
  const adapter = record(record(pkg.manifest.data, "Motion package data").adapter, "Motion package glTF adapter metadata");
  if (adapter.id !== "adapter.gltf") throw new Error("Motion package does not declare the glTF adapter required for fixed PBR rendering.");
  const sourceRef = localRef(adapter.source, "Motion package glTF source");
  const sourceSha256 = sha(adapter.sourceSha256, "Motion package glTF sourceSha256");
  const format = adapterFormat(adapter.container);
  const declaration = adapter.scene3dMaterialAssets as Scene3dGltfMaterialAssetDeclaration;
  const source = await readVerifiedPackageAsset(pkg, sourceRef, {
    label: "Motion package glTF source",
    maxBytes: MAX_GLTF_SOURCE_BYTES,
  });
  if (source.sha256 !== sourceSha256) throw new Error("Motion package glTF source does not match its authenticated manifest identity.");
  const container = parseGltfContainer(source.bytes, format);
  if (container.sourceSha256 !== sourceSha256) throw new Error("Motion package glTF parser identity does not match its authenticated manifest identity.");
  return Object.freeze({ pkg, declaration, container });
}

function adapterFormat(value: unknown): "gltf" | "glb" {
  const container = record(value, "Motion package glTF container metadata");
  if (container.schema !== "shellx-motion/gltf-source@1" || (container.format !== "gltf" && container.format !== "glb")) {
    throw new Error("Motion package glTF container metadata is invalid.");
  }
  return container.format;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function localRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-z0-9][a-z0-9._-]{0,127}\/){0,7}[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe package-relative path.`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256.`);
  return value;
}
