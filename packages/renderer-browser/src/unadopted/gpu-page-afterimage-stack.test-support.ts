import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256,
  GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256
} from "../gpu-page-afterimage-stack-contract";

export function createGpuPageAfterimageStackFixture(input: {
  drawId?: string;
  width?: number;
  height?: number;
  echoes?: readonly { dxPx: number; dyPx: number; rgba8: readonly [number, number, number, number]; opacityQ16: number }[];
  amountQ16?: number;
} = {}) {
  const echoes = input.echoes ?? [{ dxPx: -4, dyPx: 3, rgba8: [255, 128, 0, 64] as const, opacityQ16: 32_768 }, { dxPx: 0, dyPx: -2, rgba8: [0, 32, 255, 255] as const, opacityQ16: 65_535 }];
  const staticDescriptor = {
    layerId: "subject-layer", drawId: input.drawId ?? "effect-module-draw-2", scopeGroupId: "subject-group", scopeGroupDrawId: "subject-group.group", moduleId: "motion.afterimage-stack", version: "1.0.0",
    manifestSha256: "a".repeat(64), manifestByteLength: 512, registryEntrySha256: "b".repeat(64), installationProvenanceSha256: "c".repeat(64),
    pipelineImplementationSha256: GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256, resourceCeilingSha256: GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256,
    intrinsic: "motion.afterimage-stack.v1" as const, rendererAbi: "shellx-motion/gpu-effect-module@1" as const, parameterSchema: "motion.afterimage-stack.parameters@1" as const,
    referenceFingerprint: "d".repeat(64), echoes, amountQ16: input.amountQ16 ?? 16_384, uniformBytes: 160 as const, textureLoadCount: echoes.length + 1, passCount: 1 as const, retainedTextureCount: 0 as const
  };
  const descriptorFingerprint = canonicalJsonSha256(staticDescriptor);
  const binding = { ...staticDescriptor, descriptorFingerprint };
  return { schema: "shellx-motion/gpu-page-afterimage-stack@1" as const, width: input.width ?? 9, height: input.height ?? 7, ...binding, bindingFingerprint: canonicalJsonSha256(binding) };
}
