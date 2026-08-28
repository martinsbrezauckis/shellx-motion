import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  HDR10_DEPTH_BYTES,
  HDR10_MAX_PEAK_GPU_BYTES,
  HDR10_MAX_READBACK_CHUNK_BYTES,
  HDR10_MAX_STATIC_GPU_BYTES,
  HDR10_RGBA16FLOAT_BYTES,
  HDR10_RGBA16FLOAT_BYTES_PER_ROW,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
} from "@shellx-motion/core/internal/scene3d-gltf-pbr-hdr10-final";
import { fingerprintGpuPipelineCatalog } from "./gpu-provenance";
import { renderWebGpuPageSessionScene3dGltfPbrHdr10Frame } from "./gpu-page-scene3d-gltf-pbr-hdr10-frame";
import { installWebGpuPageSessionScene3dGltfPbrHdr10Pipeline, GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_ABI } from "./gpu-page-scene3d-gltf-pbr-hdr10-pipeline";
import { readWebGpuPageSessionScene3dGltfPbrHdr10Frame } from "./gpu-page-scene3d-gltf-pbr-hdr10-readback";
import { prepareWebGpuPageSessionScene3dGltfPbrHdr10Resources, releaseWebGpuPageSessionScene3dGltfPbrHdr10Resources } from "./gpu-page-scene3d-gltf-pbr-hdr10-resources";
import { closeWebGpuPageSessionScene3dGltfPbrHdr10, openWebGpuPageSessionScene3dGltfPbrHdr10 } from "./gpu-page-scene3d-gltf-pbr-hdr10-session-page";

/** HDR-only catalog: neither the global page catalog nor the accepted SDR PBR catalog is amended. */
export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_CATALOG = fingerprintGpuPipelineCatalog([
  { id: "page.scene3d-gltf-pbr-hdr10.install", implementation: installWebGpuPageSessionScene3dGltfPbrHdr10Pipeline },
  { id: "page.scene3d-gltf-pbr-hdr10.open", implementation: openWebGpuPageSessionScene3dGltfPbrHdr10 },
  { id: "page.scene3d-gltf-pbr-hdr10.prepare", implementation: prepareWebGpuPageSessionScene3dGltfPbrHdr10Resources },
  { id: "page.scene3d-gltf-pbr-hdr10.render", implementation: renderWebGpuPageSessionScene3dGltfPbrHdr10Frame },
  { id: "page.scene3d-gltf-pbr-hdr10.readback", implementation: readWebGpuPageSessionScene3dGltfPbrHdr10Frame },
  { id: "page.scene3d-gltf-pbr-hdr10.release", implementation: releaseWebGpuPageSessionScene3dGltfPbrHdr10Resources },
  { id: "page.scene3d-gltf-pbr-hdr10.close", implementation: closeWebGpuPageSessionScene3dGltfPbrHdr10 },
]);

export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING = Object.freeze({
  schema: "shellx-motion/browser-scene3d-gltf-pbr-hdr10-resource-ceiling@1",
  fixedViewport: Object.freeze({ width: 1280, height: 720, rgba16floatBytesPerRow: HDR10_RGBA16FLOAT_BYTES_PER_ROW }),
  pbrAbi: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_ABI,
  targetFormat: "rgba16float", targetBytes: HDR10_RGBA16FLOAT_BYTES, depthBytes: HDR10_DEPTH_BYTES,
  readbackBytes: HDR10_RGBA16FLOAT_BYTES, maxReadbackChunkBytes: HDR10_MAX_READBACK_CHUNK_BYTES,
  maxStaticGpuBytes: HDR10_MAX_STATIC_GPU_BYTES, maxPeakGpuBytes: HDR10_MAX_PEAK_GPU_BYTES,
  alpha: "opaque-no-blend", containedPbrHdr10: SCENE3D_GLTF_PBR_HDR10_ADMISSION,
});
export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING_SHA256 = canonicalJsonSha256(GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING);
export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IMPLEMENTATION_SHA256 = canonicalJsonSha256({
  schema: "shellx-motion/browser-scene3d-gltf-pbr-hdr10-implementation@1", pbrAbi: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_ABI,
  catalogSha256: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_CATALOG.sha256, resourceCeilingSha256: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING_SHA256,
  admissionFingerprint: SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
});
export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IDENTITY = Object.freeze({
  abi: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_ABI,
  pipelineImplementationSha256: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IMPLEMENTATION_SHA256,
  resourceCeilingSha256: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING_SHA256,
});
