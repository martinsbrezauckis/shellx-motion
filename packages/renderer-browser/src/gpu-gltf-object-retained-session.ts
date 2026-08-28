import type { GltfObjectRetainedRenderFrameUpload, GltfObjectRetainedRenderStaticUpload } from "@shellx-motion/core/internal/scene-recipe";
import { GPU_ADAPTER_REQUEST_OPTIONS, openGpuRuntime, type GpuBrowserProcess, type GpuFinalBrowserLaunchContext } from "./gpu-browser-runtime";
import { finalizeGpuFrameReadback } from "./gpu-frame-readback-output";
import { GpuFrameAbortError, GpuFrameTimeoutError, raceGpuFrameOperation } from "./gpu-frame-renderer-operation";
import {
  prepareWebGpuPageGltfObjectRetained,
  readWebGpuPageGltfObjectRetainedMetrics,
  releaseWebGpuPageGltfObjectRetained,
  renderWebGpuPageGltfObjectRetainedFrame,
  type GpuPageGltfObjectRetainedFrameInput,
  type GpuPageGltfObjectRetainedMetrics,
  type GpuPageGltfObjectRetainedReleaseEvidence,
  type GpuPageGltfObjectRetainedStaticInput,
} from "./gpu-page-gltf-object-retained";
import { closeWebGpuPageSession } from "./gpu-page-session-close";
import { openWebGpuPageSession } from "./gpu-page-session";
import type { GpuRenderedFrame, GpuRuntimeEvidence, GpuRuntimeFailure } from "./gpu-runtime-types";

export const GLTF_OBJECT_RETAINED_OPERATION_TIMEOUT_MS = 30_000;
export const GLTF_OBJECT_RETAINED_MAX_OPERATION_TIMEOUT_MS = 60_000;

export type GpuGltfObjectRetainedRenderResult = { readonly ok: true; readonly frame: GpuRenderedFrame; readonly metrics: GpuPageGltfObjectRetainedMetrics } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Preview callers omit this. Final-only callers must supply pre-launch containment. */
export interface GpuGltfObjectRetainedSessionOpenOptions {
  readonly finalBrowser?: GpuFinalBrowserLaunchContext;
}

export interface GpuGltfObjectRetainedRenderSession {
  readonly browserProcess: GpuBrowserProcess;
  readonly browserVersion: string;
  readonly runtimeEvidence: GpuRuntimeEvidence;
  render(frame: GltfObjectRetainedRenderFrameUpload, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<GpuGltfObjectRetainedRenderResult>;
  resourceMetrics(): Promise<GpuPageGltfObjectRetainedMetrics | null>;
  close(): Promise<GpuPageGltfObjectRetainedReleaseEvidence>;
}

export type GpuGltfObjectRetainedSessionOpenResult = { readonly ok: true; readonly session: GpuGltfObjectRetainedRenderSession } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Opens one hardware-attested page session and retains exact Core-issued imported geometry. */
export async function createGpuGltfObjectRetainedRenderSession(
  staticUpload: GltfObjectRetainedRenderStaticUpload,
  options: GpuGltfObjectRetainedSessionOpenOptions = {},
): Promise<GpuGltfObjectRetainedSessionOpenResult> {
  const pageInput = pageStaticInput(staticUpload);
  if (!pageInput) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "The imported-object retained static upload is outside its private renderer contract." } };
  const opened = await openGpuRuntime(options.finalBrowser ? { finalBrowser: options.finalBrowser } : {});
  if (!opened.ok) return opened;
  const page = opened.session.page;
  const initialized = await page.evaluate(openWebGpuPageSession, GPU_ADAPTER_REQUEST_OPTIONS).catch(() => ({ ok: false as const, failure: failed("The imported-object retained page could not initialize WebGPU.") }));
  if (!initialized.ok) { await opened.session.close(); return { ok: false, failure: initialized.failure }; }
  const prepared = await page.evaluate(prepareWebGpuPageGltfObjectRetained, pageInput).catch(() => ({ ok: false as const, failure: failed("The imported-object retained page could not prepare resources.") }));
  if (!prepared.ok) { await page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return { ok: false, failure: prepared.failure }; }
  const assessment = await opened.session.assessRender(initialized.runtime);
  if (!assessment.ok) { await page.evaluate(releaseWebGpuPageGltfObjectRetained).catch(() => undefined); await page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return assessment; }
  let closed = false, operating = false, release: GpuPageGltfObjectRetainedReleaseEvidence | null = null;
  const close = async (): Promise<GpuPageGltfObjectRetainedReleaseEvidence> => {
    if (release) return release;
    closed = true;
    release = await page.evaluate(releaseWebGpuPageGltfObjectRetained).catch(() => emptyRelease());
    await page.evaluate(closeWebGpuPageSession).catch(() => undefined);
    await opened.session.close();
    return release;
  };
  return { ok: true, session: {
    browserProcess: opened.session.browserProcess,
    browserVersion: opened.session.browserVersion,
    runtimeEvidence: assessment.evidence,
    async render(frame, options = {}) {
      const timeoutMs = options.timeoutMs ?? GLTF_OBJECT_RETAINED_OPERATION_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GLTF_OBJECT_RETAINED_MAX_OPERATION_TIMEOUT_MS) return { ok: false, failure: { code: "gpu_render_timeout", message: `Imported-object retained render timeout must be in 1..${GLTF_OBJECT_RETAINED_MAX_OPERATION_TIMEOUT_MS}ms.` } };
      if (closed) return { ok: false, failure: { code: "gpu_cancelled", message: "The imported-object retained render session is closed." } };
      if (operating) return { ok: false, failure: { code: "gpu_render_failed", message: "The imported-object retained render session accepts one ordered frame at a time." } };
      if (options.signal?.aborted) return { ok: false, failure: { code: "gpu_cancelled", message: "Imported-object retained rendering was cancelled before execution." } };
      operating = true;
      const startedAtNs = process.hrtime.bigint();
      try {
        const output = await raceGpuFrameOperation(page.evaluate(renderWebGpuPageGltfObjectRetainedFrame, frame as GpuPageGltfObjectRetainedFrameInput), timeoutMs, options.signal);
        if (!output.ok) return output;
        return { ok: true, frame: finalizeGpuFrameReadback({ paddedBase64: output.paddedBase64, width: output.width, height: output.height, bytesPerRow: output.bytesPerRow, evidence: assessment.evidence, textFit: [], frameStartedAtNs: startedAtNs }), metrics: output.metrics };
      } catch (error) {
        if (error instanceof GpuFrameAbortError || error instanceof GpuFrameTimeoutError) await close();
        return { ok: false, failure: { code: error instanceof GpuFrameAbortError ? "gpu_cancelled" : error instanceof GpuFrameTimeoutError ? "gpu_render_timeout" : "gpu_render_failed", message: error instanceof Error ? error.message : "Imported-object retained rendering failed." } };
      } finally { operating = false; }
    },
    async resourceMetrics() { return closed ? null : await page.evaluate(readWebGpuPageGltfObjectRetainedMetrics).catch(() => null); },
    close,
  } };
}

function pageStaticInput(value: GltfObjectRetainedRenderStaticUpload): GpuPageGltfObjectRetainedStaticInput | null {
  if (!value || value.schema !== "shellx-motion/private-gltf-object-retained-render-static-upload@1" || !hash(value.staticFingerprint) || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || !Array.isArray(value.geometries) || !Array.isArray(value.instanceSlots)) return null;
  const budget = value.budget;
  return {
    schema: "shellx-motion/private-gltf-object-retained-page-static@1",
    staticFingerprint: value.staticFingerprint,
    width: value.width,
    height: value.height,
    geometries: value.geometries,
    instanceSlots: value.instanceSlots,
    budget: { vertexBufferBytes: budget.vertexBufferBytes, indexBufferBytes: budget.indexBufferBytes, uniformBufferBytes: budget.uniformBufferBytes, renderTargetBytes: budget.renderTargetBytes, depthTargetBytes: budget.depthTargetBytes, readbackBufferBytes: budget.readbackBufferBytes, retainedGpuBytes: budget.retainedGpuBytes },
  };
}

function emptyRelease(): GpuPageGltfObjectRetainedReleaseEvidence { return { schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: false, destroyedVertexBuffers: 0, destroyedIndexBuffers: 0, destroyedUniformBuffers: 0, destroyedRenderTargets: 0, destroyedReadbackBuffers: 0, releasedGpuBytes: 0, remainingGpuBytes: 0 }; }
function failed(message: string): GpuRuntimeFailure { return { code: "gpu_render_failed", message }; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
