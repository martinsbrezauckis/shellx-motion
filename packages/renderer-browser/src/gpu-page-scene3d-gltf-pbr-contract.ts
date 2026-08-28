import { canonicalJsonSha256 } from "@shellx-motion/core";
import { SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION } from "@shellx-motion/core/internal/scene3d-gltf-material";
import { fingerprintGpuPipelineCatalog } from "./gpu-provenance";
import { GPU_PAGE_SCENE3D_GLTF_PBR_SDR_ABI, installWebGpuPageSessionScene3dGltfPbrPipeline } from "./gpu-page-scene3d-gltf-pbr-pipeline";
import { renderWebGpuPageSessionScene3dGltfPbrFrame } from "./gpu-page-scene3d-gltf-pbr-frame";
import { readWebGpuPageSessionScene3dGltfPbrFrame } from "./gpu-page-scene3d-gltf-pbr-readback";
import {
  readWebGpuPageSessionScene3dGltfPbrStreamingFrame,
  releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback,
  reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback,
} from "./gpu-page-scene3d-gltf-pbr-streaming-readback";
import { closeWebGpuPageSessionScene3dGltfPbr, openWebGpuPageSessionScene3dGltfPbr } from "./gpu-page-scene3d-gltf-pbr-session";
import {
  prepareWebGpuPageSessionScene3dGltfPbrResources,
  readWebGpuPageSessionScene3dGltfPbrResourceMetrics,
  releaseWebGpuPageSessionScene3dGltfPbrResources,
} from "./gpu-page-scene3d-gltf-pbr-resources";

/** Isolated catalog: legacy `GPU_PAGE_PIPELINE_CATALOG` remains byte-for-byte unchanged. */
export const GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG = fingerprintGpuPipelineCatalog([
  { id: "page.scene3d-gltf-pbr.install", implementation: installWebGpuPageSessionScene3dGltfPbrPipeline },
  { id: "page.scene3d-gltf-pbr.open", implementation: openWebGpuPageSessionScene3dGltfPbr },
  { id: "page.scene3d-gltf-pbr.metrics", implementation: readWebGpuPageSessionScene3dGltfPbrResourceMetrics },
  { id: "page.scene3d-gltf-pbr.prepare", implementation: prepareWebGpuPageSessionScene3dGltfPbrResources },
  { id: "page.scene3d-gltf-pbr.render", implementation: renderWebGpuPageSessionScene3dGltfPbrFrame },
  { id: "page.scene3d-gltf-pbr.readback", implementation: readWebGpuPageSessionScene3dGltfPbrFrame },
  { id: "page.scene3d-gltf-pbr.streaming-readback.reserve", implementation: reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback },
  { id: "page.scene3d-gltf-pbr.streaming-readback.read", implementation: readWebGpuPageSessionScene3dGltfPbrStreamingFrame },
  { id: "page.scene3d-gltf-pbr.streaming-readback.release", implementation: releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback },
  { id: "page.scene3d-gltf-pbr.release", implementation: releaseWebGpuPageSessionScene3dGltfPbrResources },
  { id: "page.scene3d-gltf-pbr.close", implementation: closeWebGpuPageSessionScene3dGltfPbr },
]);

/** Exact pre-allocation caps carried beside, rather than silently inferred from, the shader. */
export const GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING = Object.freeze({
  schema: "shellx-motion/browser-scene3d-gltf-pbr-sdr-resource-ceiling@1",
  maxPrimitives: 16,
  maxTextures: 16,
  maxDecodedTextureBytesEach: 16 * 1024 * 1024,
  maxGpuResourceBytes: 48 * 1024 * 1024,
  maxReadbackBytes: 4 * 1024 * 1024,
  fixedViewport: { width: 1280, height: 720, bytesPerRow: 5120 },
  vertexAbi: "shellx-motion/browser-scene3d-pbr-vertex@1",
  pbrAbi: GPU_PAGE_SCENE3D_GLTF_PBR_SDR_ABI,
  baseColorTextureFormat: "rgba8unorm-srgb",
  targetFormat: "rgba8unorm",
  outputTransfer: "linear-to-srgb-explicit",
  /** Canonical source truth for the separately versioned PBR-only route, not the legacy GPU card. */
  containedPbrImport: SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION,
});

export const GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING_SHA256 = canonicalJsonSha256(GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING);

/** This identifies the fixed shader/catalog ABI—not a mutable package asset. */
export const GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IMPLEMENTATION_SHA256 = canonicalJsonSha256({
  schema: "shellx-motion/browser-scene3d-gltf-pbr-sdr-implementation@1",
  pbrAbi: GPU_PAGE_SCENE3D_GLTF_PBR_SDR_ABI,
  pageCatalogSha256: GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256,
  resourceCeilingSha256: GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING_SHA256,
});

export const GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY = Object.freeze({
  abi: GPU_PAGE_SCENE3D_GLTF_PBR_SDR_ABI,
  pipelineImplementationSha256: GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IMPLEMENTATION_SHA256,
  resourceCeilingSha256: GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING_SHA256,
});
