/** Workspace-private C7A3f package lifecycle and separate output-only preview seam. */
export {
  materializeGltfObjectScenePackage,
  prepareGltfObjectScenePackageMaterialization,
  reopenGltfObjectScenePackageMaterializationOutput,
  reopenGltfObjectScenePackagePreviewInput,
  type GltfObjectScenePackageMaterializationApproval,
  type GltfObjectScenePackageMaterializationHost,
  type GltfObjectScenePackageMaterializationPreparation,
  type GltfObjectScenePackageMaterializationReceipt,
  type GltfObjectScenePackageMaterializationResult,
} from "../domains/gltf-object-scene-package-materialize-private/gltf-object-scene-package-materialize-private.js";
export {
  renderGltfObjectScenePackagePreviewAtUs,
  type GltfObjectScenePackagePreviewOptions,
  type GltfObjectScenePackagePreviewResult,
} from "./gltf-object-scene-package-preview.js";
