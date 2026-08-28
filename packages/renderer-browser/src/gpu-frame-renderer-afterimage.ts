import type { InternalGpuEffectModuleBinding, InternalGpuFramePlan, GpuRuntimeFailure } from "./gpu-runtime-types";
import type { GpuPageSessionFrameOutput } from "./gpu-page-session-types";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import {
  closeWebGpuPageSessionAfterimageStackPipeline,
  installWebGpuPageSessionAfterimageStackPipeline,
  prepareWebGpuPageSessionAfterimageStackPass,
  readWebGpuPageSessionAfterimageStackMetrics
} from "./gpu-page-afterimage-stack";
import { GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY, GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256 } from "./gpu-page-afterimage-stack-contract";
import { renderWebGpuPageSessionAfterimageStackFrame } from "./gpu-page-afterimage-stack-frame";
import { createGpuPageFrameTransport } from "./gpu-page-frame-transport";
import { renderWebGpuPageSessionFrame } from "./gpu-page-session";

export interface GpuAfterimagePageEvaluator {
  evaluate(pageFunction: unknown, argument?: unknown): Promise<unknown>;
}

type GpuAfterimageDraw = Extract<InternalGpuFramePlan["draws"][number], { kind: "effectModule" }>;
type GpuAfterimageOperation = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

export async function prepareGpuAfterimageFrame(
  page: GpuAfterimagePageEvaluator,
  plan: InternalGpuFramePlan,
  draw: GpuAfterimageDraw,
  installed: boolean
): Promise<{ ok: true; installed: true } | { ok: false; failure: GpuRuntimeFailure; installed: boolean }> {
  if (!installed) {
    const result = await page.evaluate(installWebGpuPageSessionAfterimageStackPipeline, {
      pipelineImplementationSha256: GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY.pipelineImplementationSha256,
      resourceCeilingSha256: GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256
    }) as GpuAfterimageOperation;
    if (!result.ok) return { ...result, installed: false };
  }
  const { kind: _kind, id: _id, blendMode: _blendMode, effects: _effects, ...binding } = draw;
  const prepared = await page.evaluate(prepareWebGpuPageSessionAfterimageStackPass, {
    descriptor: { schema: "shellx-motion/gpu-page-afterimage-stack@1", width: plan.width, height: plan.height, ...binding },
    frameFingerprint: plan.fingerprint
  }) as GpuAfterimageOperation;
  return prepared.ok ? { ok: true, installed: true } : { ...prepared, installed: true };
}

export async function renderGpuFrameWithAfterimage(
  page: GpuAfterimagePageEvaluator,
  plan: InternalGpuFramePlan,
  moduleFrame: boolean
): Promise<GpuPageSessionFrameOutput> {
  return await page.evaluate(
    moduleFrame ? renderWebGpuPageSessionAfterimageStackFrame : renderWebGpuPageSessionFrame,
    createGpuPageFrameTransport(plan)
  ) as GpuPageSessionFrameOutput;
}

export async function mergeGpuAfterimageResourceMetrics(
  page: GpuAfterimagePageEvaluator,
  base: GpuPageSessionResourceMetrics | null,
  installed: boolean
): Promise<GpuPageSessionResourceMetrics | null> {
  if (!base || !installed) return base;
  const afterimage = await page.evaluate(readWebGpuPageSessionAfterimageStackMetrics) as Awaited<ReturnType<typeof readWebGpuPageSessionAfterimageStackMetrics>>;
  return afterimage ? Object.freeze({
    ...base,
    afterimageStackUniformBufferSlots: afterimage.uniformBufferSlots,
    afterimageStackUniformBytes: afterimage.uniformBytes,
    afterimageStackBindGroupSlots: afterimage.bindGroupSlots,
    afterimageStackPasses: afterimage.passes,
    afterimageStackFrames: afterimage.frames,
    afterimageStackLateAllocationRefusals: afterimage.lateAllocationRefusals,
    afterimageStackPersistentTextureCount: afterimage.persistentTextureCount
  }) : base;
}

export async function closeGpuAfterimageStack(
  page: GpuAfterimagePageEvaluator,
  installed: boolean
): Promise<Awaited<ReturnType<typeof closeWebGpuPageSessionAfterimageStackPipeline>> | null> {
  if (!installed) return null;
  return await page.evaluate(closeWebGpuPageSessionAfterimageStackPipeline) as Awaited<ReturnType<typeof closeWebGpuPageSessionAfterimageStackPipeline>>;
}

export function finalizeGpuAfterimageTerminalMetrics(
  beforeClose: GpuPageSessionResourceMetrics | null,
  dynamicImageTextureDestructions: number,
  hasDynamicImages: boolean,
  cleanup: Awaited<ReturnType<typeof closeWebGpuPageSessionAfterimageStackPipeline>> | null
): GpuPageSessionResourceMetrics | null {
  if (!beforeClose) return null;
  return Object.freeze({
    ...beforeClose,
    ...(hasDynamicImages ? { dynamicImageTextureDestructions: (beforeClose.dynamicImageTextureDestructions ?? 0) + dynamicImageTextureDestructions } : {}),
    ...(cleanup === null ? {} : {
      afterimageStackUniformBufferSlots: 0 as const,
      afterimageStackUniformBytes: 0 as const,
      afterimageStackBindGroupSlots: 0 as const,
      afterimageStackPipelineReleases: cleanup.releasedPipeline ? 1 as const : 0 as const,
      afterimageStackPreparedBindGroupReleases: cleanup.releasedPreparedPasses,
      afterimageStackArenaUniformBufferDestructions: cleanup.releasedUniformBuffers
    })
  });
}
