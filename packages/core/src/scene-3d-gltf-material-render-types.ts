import type { Scene3dGltfMaterialAssetDeclaration } from "./scene-3d-gltf-material-assets-types";
import type { GltfSourceFormat } from "./gltf-types";

export const SCENE_3D_GLTF_MATERIAL_RENDER_STATIC_SCHEMA = "shellx-motion/scene3d-gltf-material-render-static@1" as const;
export const SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_SCHEMA = "shellx-motion/scene3d-gltf-material-render-frame@1" as const;
export const SCENE_3D_GLTF_MATERIAL_RENDER_CLEANUP_SCHEMA = "shellx-motion/scene3d-gltf-material-render-cleanup@1" as const;
export const SCENE_3D_GLTF_MATERIAL_RENDER_VERTEX_ABI = "shellx-motion/browser-scene3d-pbr-vertex@1" as const;
/** Fixed Browser material subset; versioned independently from future HDR/OCIO work. */
export const SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI = "shellx-motion/browser-scene3d-gltf-pbr-sdr@1" as const;
export const SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_FORMAT = "rgba8unorm-srgb" as const;
export const SCENE_3D_GLTF_MATERIAL_RENDER_OUTPUT_TRANSFER = "linear-to-srgb-explicit" as const;
export const MAX_SCENE_3D_GLTF_MATERIAL_RENDER_PRIMITIVES = 16;
export const MAX_SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_STORAGE_BYTES = 48 * 1024 * 1024;
export const MAX_SCENE_3D_GLTF_MATERIAL_RENDER_RESOURCE_BYTES = 48 * 1024 * 1024;
export const MAX_SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_RESOURCE_BYTES = 64 * 1024 * 1024;
/** One fixed 1280x720 RGBA readback buffer is admitted before Browser allocation. */
export const MAX_SCENE_3D_GLTF_MATERIAL_RENDER_READBACK_BYTES = 4 * 1024 * 1024;

export interface Scene3dGltfMaterialRenderTexture {
  readonly resourceId: string;
  readonly textureIndices: readonly number[];
  readonly assetRef: string;
  readonly encodedSha256: string;
  readonly encodedByteLength: number;
  readonly decodedRgbaSha256: string;
  readonly decodedRgbaByteLength: number;
  readonly width: number;
  readonly height: number;
  /** Exact required full mip-chain allocation for the glTF default sampler contract. */
  readonly mipLevelCount: number;
  readonly mipmappedRgbaByteLength: number;
  /** A defensive copy of the verified, owned decoded RGBA snapshot is returned on every read. */
  readonly rgba: Buffer;
}

export interface Scene3dGltfMaterialRenderPrimitive {
  readonly id: string;
  readonly source: {
    readonly format: GltfSourceFormat;
    readonly sha256: string;
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly materialIndex: number;
    readonly positionAccessorIndex: number;
    readonly texCoord0AccessorIndex: number;
  };
  /** position.xyz, normal.xyz, texcoord0.xy; fixed WebGPU float32 vertex ABI. */
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly geometrySha256: string;
  readonly vertexBufferSha256: string;
  readonly vertexBufferByteLength: number;
  readonly indexBufferSha256: string;
  readonly indexBufferByteLength: number;
  readonly material: {
    readonly baseColorFactor: readonly [number, number, number, number];
    readonly metallicFactor: number;
    readonly roughnessFactor: number;
    readonly emissiveFactor: readonly [number, number, number];
    readonly textureResourceId: string;
    readonly textureIndex: number;
  };
  readonly fingerprint: string;
}

export interface Scene3dGltfMaterialRenderBudget {
  readonly primitiveCount: number;
  readonly textureCount: number;
  readonly vertexBufferBytes: number;
  readonly indexBufferBytes: number;
  /** One 256-byte, dynamic-offset-aligned PBR uniform allocation per primitive. */
  readonly uniformBufferBytes: number;
  readonly decodedTextureBytes: number;
  readonly mipmappedTextureBytes: number;
  readonly gpuResourceBytes: number;
  /** Fixed 1280x720 preview color/depth attachments; allocated once at prepare. */
  readonly renderTargetBytes: number;
  readonly depthTargetBytes: number;
  /** Transient MAP_READ buffer; it exists only between the final copy and terminal unmap/destroy. */
  readonly readbackBufferBytes: number;
  readonly frameGpuResourceBytes: number;
  /** Persistent frame resources plus the one admitted transient readback allocation. */
  readonly peakGpuResourceBytes: number;
  /** Exact retained decoded-RGBA snapshot high-water: verifier and planner share one ownership. */
  readonly preparationPeakRgbaSnapshotBytes: number;
  readonly cpuSnapshotBytes: number;
}

export interface Scene3dGltfMaterialRenderStaticPlan {
  readonly schema: typeof SCENE_3D_GLTF_MATERIAL_RENDER_STATIC_SCHEMA;
  readonly source: { readonly format: GltfSourceFormat; readonly sha256: string };
  /** Present only after the immutable direct-final marker binds canonical source-lowered scene state. */
  readonly sceneStateSha256?: string;
  readonly sidecar: {
    readonly declaration: Scene3dGltfMaterialAssetDeclaration;
    readonly fingerprint: string;
  };
  readonly vertexAbi: typeof SCENE_3D_GLTF_MATERIAL_RENDER_VERTEX_ABI;
  /** Exact fixed SDR renderer contract, sealed into the static and frame fingerprints. */
  readonly pbr: {
    readonly abi: typeof SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI;
    readonly baseColorTextureFormat: typeof SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_FORMAT;
    readonly baseColorTextureTransfer: "srgb-to-linear-hardware";
    readonly factorSpace: "linear-gltf";
    readonly brdf: "ggx-smith-schlick-directional@1";
    readonly ambient: "bounded-diffuse@1";
    readonly directionalLight: {
      readonly direction: readonly [-0.4, -0.8, -0.4];
      readonly color: readonly [1, 1, 1];
      readonly intensity: 1;
      readonly ambientDiffuse: 0.15;
    };
    readonly outputTransfer: typeof SCENE_3D_GLTF_MATERIAL_RENDER_OUTPUT_TRANSFER;
  };
  /** glTF defaults because the admitted extractor refuses explicit sampler records. */
  readonly sampler: { readonly addressModeU: "repeat"; readonly addressModeV: "repeat"; readonly magFilter: "linear"; readonly minFilter: "linear"; readonly mipmapFilter: "linear"; readonly mipmaps: "required-generated" };
  readonly textures: readonly Omit<Scene3dGltfMaterialRenderTexture, "rgba">[];
  readonly primitives: readonly Scene3dGltfMaterialRenderPrimitive[];
  readonly budget: Scene3dGltfMaterialRenderBudget;
  readonly fingerprint: string;
}

export interface Scene3dGltfMaterialRenderFramePlan {
  readonly schema: typeof SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_SCHEMA;
  readonly staticFingerprint: string;
  /** Matches the static-plan binding for the immutable direct-final marker route. */
  readonly sceneStateSha256?: string;
  readonly pbrAbi: typeof SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI;
  /** Canonical fixed-frame camera, derived from the admitted textured scene only. */
  readonly camera: {
    readonly viewport: { readonly width: 1280; readonly height: 720 };
    readonly projection: "perspective@1";
    readonly fovDeg: 42;
    readonly near: number;
    readonly far: number;
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly viewProjection: readonly number[];
  };
  readonly primitiveBindings: readonly { readonly primitiveId: string; readonly primitiveFingerprint: string; readonly textureResourceId: string; readonly modelMatrix: readonly number[]; readonly pbrUniformByteLength: 256 }[];
  readonly resourceFingerprint: string;
  readonly cleanup: {
    readonly textureResourceIds: readonly string[];
    readonly primitiveIds: readonly string[];
    readonly renderTargetIds: readonly ["scene3d-gltf-pbr-frame-color", "scene3d-gltf-pbr-frame-depth"];
    readonly cpuSnapshotBytes: number;
    readonly gpuResourceBytes: number;
  };
  readonly renderer: {
    readonly target: "browser-webgpu";
    /** Produced by the authenticated import route; generic preview/native/segmented lanes still refuse it. */
    readonly status: "package-internal";
    readonly route: "browser.scene3d-gltf-pbr-package-internal@1";
  };
  readonly fingerprint: string;
}

export interface Scene3dGltfMaterialRenderPlan {
  readonly staticPlan: Scene3dGltfMaterialRenderStaticPlan;
  readonly framePlan: Scene3dGltfMaterialRenderFramePlan;
  readonly textures: readonly Scene3dGltfMaterialRenderTexture[];
}

/** Renderer-supplied terminal evidence; Core only validates it and never invents a cleanup claim. */
export interface Scene3dGltfMaterialRenderCleanupEvidence {
  readonly schema: typeof SCENE_3D_GLTF_MATERIAL_RENDER_CLEANUP_SCHEMA;
  readonly frameFingerprint: string;
  readonly destroyedTextureResourceIds: readonly string[];
  readonly destroyedVertexBufferPrimitiveIds: readonly string[];
  readonly destroyedIndexBufferPrimitiveIds: readonly string[];
  readonly destroyedUniformBufferPrimitiveIds: readonly string[];
  readonly destroyedRenderTargetIds: readonly string[];
  readonly releasedCpuSnapshotBytes: number;
  readonly remainingGpuResourceBytes: 0;
  readonly fingerprint: string;
}

export type Scene3dGltfMaterialBrowserRefusal = {
  readonly ok: false;
  readonly code: "browser_scene3d_gltf_material_package_internal_only";
  readonly message: string;
};
