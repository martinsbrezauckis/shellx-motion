import {
  canonicalJsonSha256,
  gpuEffectModuleResourceCeilingFingerprint,
  type GpuEffectModuleRendererIdentity
} from "@shellx-motion/core";
import { fingerprintGpuPipelineCatalog } from "./gpu-provenance";
import {
  closeWebGpuPageSessionAfterimageStackPipeline,
  installWebGpuPageSessionAfterimageStackPipeline,
  prepareWebGpuPageSessionAfterimageStackPass,
  readWebGpuPageSessionAfterimageStackMetrics,
  renderWebGpuPageSessionAfterimageStackPass
} from "./gpu-page-afterimage-stack";
import { renderWebGpuPageSessionAfterimageStackFrame } from "./gpu-page-afterimage-stack-frame";

/** Browser-only retained-session reservation; it is not the Core static resource ceiling. */
export const GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION = Object.freeze({
  schema: "shellx-motion/gpu-afterimage-stack-session-reservation@1",
  uniformBytes: 160,
  preReservedUniformBufferCount: 1,
  preReservedBindGroupCount: 1,
  persistentTextureCount: 0,
  passCount: 1,
  maxTextureLoadsPerPixel: 5
});

export const GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION_SHA256 = canonicalJsonSha256(GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION);

/** Core owns the static semantic ceiling carried by the immutable descriptor. */
export const GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256 = gpuEffectModuleResourceCeilingFingerprint();

/** Entries are exported for the later shared page catalog join, never from package data. */
export const GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_CATALOG = fingerprintGpuPipelineCatalog([
  { id: "page.afterimage-stack.close", implementation: closeWebGpuPageSessionAfterimageStackPipeline },
  { id: "page.afterimage-stack.install", implementation: installWebGpuPageSessionAfterimageStackPipeline },
  { id: "page.afterimage-stack.metrics", implementation: readWebGpuPageSessionAfterimageStackMetrics },
  { id: "page.afterimage-stack.prepare", implementation: prepareWebGpuPageSessionAfterimageStackPass },
  { id: "page.afterimage-stack.frame", implementation: renderWebGpuPageSessionAfterimageStackFrame },
  { id: "page.afterimage-stack.render", implementation: renderWebGpuPageSessionAfterimageStackPass }
]);

/** Current host code identity—not persisted installed-manifest state. */
export const GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256 = canonicalJsonSha256({
  schema: "shellx-motion/gpu-afterimage-stack-implementation@1",
  intrinsic: "motion.afterimage-stack.v1",
  rendererAbi: "shellx-motion/gpu-effect-module@1",
  parameterSchema: "motion.afterimage-stack.parameters@1",
  pageCatalogSha256: GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_CATALOG.sha256
});

/** The host supplies this current runtime identity to Core descriptor resolution. */
export const GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY: Readonly<GpuEffectModuleRendererIdentity> = Object.freeze({
  intrinsic: "motion.afterimage-stack.v1",
  rendererAbi: "shellx-motion/gpu-effect-module@1",
  parameterSchema: "motion.afterimage-stack.parameters@1",
  pipelineImplementationSha256: GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256
});
