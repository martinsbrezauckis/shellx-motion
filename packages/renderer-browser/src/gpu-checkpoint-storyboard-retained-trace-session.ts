import type { Page } from "playwright-core";
import { GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_UPLOAD_BYTES, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES, renderWebGpuPageCheckpointStoryboardRetainedTrace, type GpuPageCheckpointStoryboardRetainedTraceOutput } from "./gpu-page-checkpoint-storyboard-retained-trace";
import { finalizeGpuFrameReadback } from "./gpu-frame-readback-output";
import { GpuFrameAbortError, GpuFrameTimeoutError, raceGpuFrameOperation } from "./gpu-frame-renderer-operation";
import { gpuCancellationFailure, type GpuRenderedFrame, type GpuRuntimeEvidence, type GpuRuntimeFailure } from "./gpu-runtime-types";
import type { GpuFrameRenderSession, GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";

/** Private fixed ABI bridge; only the retained-trace executor may construct this from Core bytes. */
export interface GpuCheckpointStoryboardRetainedTraceDraw {
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
  readonly rasterVertexInvocations: number;
  readonly vertexBytes: Uint8Array;
}

export type InternalGpuCheckpointStoryboardRetainedTraceResult =
  | { ok: true; frame: GpuRenderedFrame; cleanup: Extract<GpuPageCheckpointStoryboardRetainedTraceOutput, { ok: true }>['cleanup'] }
  | { ok: false; failure: GpuRuntimeFailure };

/** Not exported from the package root: the fixed B7 draw path has no general-plan entrypoint. */
export interface GpuCheckpointStoryboardRetainedTraceSession extends GpuFrameRenderSession {
  renderCheckpointStoryboardRetainedTrace(input: GpuCheckpointStoryboardRetainedTraceDraw, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<InternalGpuCheckpointStoryboardRetainedTraceResult>;
}

type OpenGpuFrameRenderSession = () => Promise<GpuFrameRenderSessionOpenResult>;

/** Shipping-private B7 allocation seam; callers only reach it through the retained-trace preview executor. */
export function createCheckpointStoryboardRetainedTraceRenderSessionFactory(openGpuFrameRenderSession: OpenGpuFrameRenderSession) {
  return async (): Promise<
    | { ok: true; session: GpuCheckpointStoryboardRetainedTraceSession }
    | { ok: false; failure: GpuRuntimeFailure }
  > => {
    const opened = await openGpuFrameRenderSession();
    return opened.ok ? { ok: true, session: opened.session as GpuCheckpointStoryboardRetainedTraceSession } : opened;
  };
}

export interface GpuCheckpointStoryboardRetainedTraceSessionAttachment {
  readonly session: GpuFrameRenderSession;
  readonly page: Page;
  readonly evidence: GpuRuntimeEvidence;
  readonly isClosed: () => boolean;
  readonly isOperating: () => boolean;
  readonly setOperating: (operating: boolean) => void;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
}

/** Adds the sealed B7 raster operation without widening the general frame-session surface. */
export function attachGpuCheckpointStoryboardRetainedTraceSession(context: GpuCheckpointStoryboardRetainedTraceSessionAttachment): GpuCheckpointStoryboardRetainedTraceSession {
  return Object.assign(context.session, {
    async renderCheckpointStoryboardRetainedTrace(input: GpuCheckpointStoryboardRetainedTraceDraw, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<InternalGpuCheckpointStoryboardRetainedTraceResult> {
      const timeoutMs = options.timeoutMs ?? context.defaultTimeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > context.maxTimeoutMs) return { ok: false, failure: { code: "gpu_render_timeout", message: `GPU frame timeout must be an integer in 1..${context.maxTimeoutMs}ms.` } };
      const expectedRasterVertexInvocations = input.sampleCount === 1 ? 6 : (input.sampleCount - 1) * 6;
      if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1 || !Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1 || input.sampleCount > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES || !Number.isSafeInteger(input.rasterVertexInvocations) || input.rasterVertexInvocations !== expectedRasterVertexInvocations || input.rasterVertexInvocations > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS || !(input.vertexBytes instanceof Uint8Array) || input.vertexBytes.byteLength !== input.sampleCount * GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES || input.vertexBytes.byteLength > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_UPLOAD_BYTES) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "The retained-trace draw does not match the fixed 20-byte, 64-sample/378-raster-vertex ABI." } };
      if (context.isOperating()) return { ok: false, failure: { code: "gpu_render_failed", message: "GPU frame session accepts exactly one ordered frame operation at a time." } };
      if (context.isClosed()) return { ok: false, failure: gpuCancellationFailure("The GPU frame session is closed.") };
      // The private executor owns the one terminal close, including cancellation and timeout.
      if (options.signal?.aborted) return { ok: false, failure: gpuCancellationFailure("GPU retained-trace rendering was cancelled before execution.") };
      context.setOperating(true);
      const frameStartedAtNs = process.hrtime.bigint();
      try {
        const output = await raceGpuFrameOperation(
          context.page.evaluate(renderWebGpuPageCheckpointStoryboardRetainedTrace, {
            width: input.width,
            height: input.height,
            sampleCount: input.sampleCount,
            rasterVertexInvocations: input.rasterVertexInvocations,
            vertexBytesBase64: Buffer.from(input.vertexBytes).toString("base64"),
          }),
          timeoutMs,
          options.signal,
        );
        if (!output.ok) return { ok: false, failure: output.failure };
        return {
          ok: true,
          frame: finalizeGpuFrameReadback({ paddedBase64: output.paddedBase64, width: input.width, height: input.height, bytesPerRow: output.bytesPerRow, evidence: context.evidence, textFit: [], frameStartedAtNs }),
          cleanup: output.cleanup,
        };
      } catch (error) {
        if (error instanceof GpuFrameAbortError) return { ok: false, failure: gpuCancellationFailure() };
        return { ok: false, failure: { code: error instanceof GpuFrameTimeoutError ? "gpu_render_timeout" : "gpu_render_failed", message: error instanceof GpuFrameTimeoutError ? error.message : "The retained-trace WebGPU raster operation failed." } };
      } finally {
        context.setOperating(false);
      }
    }
  });
}
