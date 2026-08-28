import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend";
import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";
import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";
import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material";
import { installWebGpuPageSessionInstanceBuffers } from "./gpu-page-instance-buffers";
import { installWebGpuPageSessionParticleCompute } from "./gpu-page-particle-compute";
import { installWebGpuPageSessionParticleComputeV2 } from "./gpu-page-particle-compute-v2";
import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";
import { installWebGpuPageSessionChromaMatteCleanupPipeline } from "./gpu-page-chroma-matte-cleanup";
import {
  closeWebGpuPageSession,
  openWebGpuPageSession,
  renderWebGpuPageSessionFrame,
  uploadWebGpuPageSessionImages
} from "./gpu-page-session";
import { installWebGpuPageSessionScene3dPipeline } from "./gpu-page-scene3d";
import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";
import {
  prepareWebGpuPageSessionTextSurfaces,
  uploadWebGpuPageSessionFonts
} from "./gpu-page-text-session";
import { fingerprintGpuPipelineCatalog } from "./gpu-provenance";
import { GPU_PAGE_SERIALIZATION_RUNTIME } from "./gpu-page-serialization-runtime";
import { installGpuPageFrameTransport } from "./gpu-page-frame-transport";
import { reserveWebGpuPageSessionEnvironmentEnvelope, reserveWebGpuPageSessionFrameResources } from "./gpu-page-frame-reservation";
import { installWebGpuPageSessionResources } from "./gpu-page-session-resources";
import { readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resource-metrics";
import { replaceWebGpuPageSessionDynamicImages, reserveWebGpuPageSessionDynamicImages } from "./gpu-page-session-dynamic-images";

/**
 * The fixed functions Playwright serializes into every retained GPU page.
 * Package data is separately fingerprinted as static scene input, never
 * treated as executable GPU code.
 */
export const GPU_PAGE_PIPELINE_CATALOG = fingerprintGpuPipelineCatalog([
  { id: "page.adjustment", implementation: installWebGpuPageSessionAdjustmentPipeline },
  { id: "page.blend", implementation: installWebGpuPageSessionBlendPipeline },
  { id: "page.blur", implementation: installWebGpuPageSessionBlurPipeline },
  { id: "page.chroma-key", implementation: installWebGpuPageSessionChromaKeyPipeline },
  { id: "page.chroma-matte-cleanup", implementation: installWebGpuPageSessionChromaMatteCleanupPipeline },
  { id: "page.close", implementation: closeWebGpuPageSession },
  { id: "page.environment", implementation: installWebGpuPageSessionEnvironmentPipeline },
  { id: "page.frame-transport", implementation: installGpuPageFrameTransport },
  { id: "page.glow", implementation: installWebGpuPageSessionGlowPipeline },
  { id: "page.gradient", implementation: installWebGpuPageSessionGradientPipeline },
  { id: "page.instance-buffers", implementation: installWebGpuPageSessionInstanceBuffers },
  { id: "page.particle-compute", implementation: installWebGpuPageSessionParticleCompute },
  { id: "page.particle-compute-v2", implementation: installWebGpuPageSessionParticleComputeV2 },
  { id: "page.mask", implementation: installWebGpuPageSessionMaskPipeline },
  { id: "page.material", implementation: installWebGpuPageSessionMaterialPipeline },
  { id: "page.primitives", implementation: openWebGpuPageSession },
  { id: "page.render", implementation: renderWebGpuPageSessionFrame },
  { id: "page.reserve-frame", implementation: reserveWebGpuPageSessionFrameResources },
  { id: "page.reserve-environment-envelope", implementation: reserveWebGpuPageSessionEnvironmentEnvelope },
  { id: "page.reserve-dynamic-images", implementation: reserveWebGpuPageSessionDynamicImages },
  { id: "page.resource-metrics", implementation: readWebGpuPageSessionResourceMetrics },
  { id: "page.resources", implementation: installWebGpuPageSessionResources },
  { id: "page.scene3d", implementation: installWebGpuPageSessionScene3dPipeline },
  { id: "page.serialization-runtime", implementation: GPU_PAGE_SERIALIZATION_RUNTIME },
  { id: "page.styled-rectangle", implementation: installWebGpuPageSessionStyledRectanglePipeline },
  { id: "page.text-surfaces", implementation: prepareWebGpuPageSessionTextSurfaces },
  { id: "page.replace-dynamic-images", implementation: replaceWebGpuPageSessionDynamicImages },
  { id: "page.upload-fonts", implementation: uploadWebGpuPageSessionFonts },
  { id: "page.upload-images", implementation: uploadWebGpuPageSessionImages }
] satisfies ReadonlyArray<{ id: string; implementation: string | ((...args: never[]) => unknown) }>);
