import { join } from "node:path";
import { compileGpuSceneStaticPlan, type DerivedOutputPublication, type MotionPackage } from "@shellx-motion/core";
import { renderMotionGpuPreview, type GpuPreviewSessionOptions } from "@shellx-motion/renderer-browser";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import { createGpuPreviewVideoFrameProvider, createGovernedFfmpegRunner, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { cliGpuPreviewScene3dAnimationRefusal } from "./gpu-preview-scene3d-refusal.js";

type GpuPreviewCliResult = Record<string, unknown> & { ok: boolean; command: "preview" };

/** Trusted CLI-only capabilities; no preview decoder controls are command-line arguments. */
export interface GpuPreviewCliOptions {
  signal?: AbortSignal;
  callerId?: string;
  scratchRoot?: string;
  /** Deterministic test/embedding seam. Production uses the contained signal-aware runner below. */
  ffmpegRunner?: FfmpegRunner;
  /** CLI publication coordinator only; public callers retain renderer-owned output publication. */
  privateOutputPublication?: DerivedOutputPublication;
  /** CLI publication coordinator only; must equal the supplied private stage when present. */
  outputPath?: string;
}

/** Render the strict general WebGPU PNG preview and its receipt sidecar. */
export async function renderGpuPreviewCli(
  pkg: MotionPackage,
  atMs: number,
  outputDir: string,
  options: GpuPreviewCliOptions = {}
): Promise<GpuPreviewCliResult> {
  const scene3dAnimationRefusal = cliGpuPreviewScene3dAnimationRefusal(pkg.motion);
  if (scene3dAnimationRefusal) {
    return { ok: false, command: "preview", lane: "gpu", error: scene3dAnimationRefusal };
  }
  if (!options.privateOutputPublication || !options.outputPath) {
    return {
      ok: false,
      command: "preview",
      lane: "gpu",
      error: {
        code: "gpu_preview_publication_required",
        message: "GPU CLI preview requires the receipt-first paired output publication owned by its command dispatcher."
      }
    };
  }
  const sessionOptions = gpuPreviewSessionOptions(pkg, outputDir, options);
  const result = await renderMotionGpuPreview(pkg, withRendererPrivateOutputPublication({
    atMs, outDir: outputDir,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.callerId ? { callerId: options.callerId } : {}),
    ...(sessionOptions ? { sessionOptions } : {})
  }, options.privateOutputPublication));
  const receiptPath = join(outputDir, `${pkg.manifest.id}-gpu-preview.receipt.json`);
  if (!result.ok) {
    return { ok: false, command: "preview", lane: "gpu", error: result.error, ...(result.resources ? { resources: result.resources } : {}) };
  }
  // The command dispatcher owns the receipt-first public commit; this helper only returns private
  // renderer evidence and cannot be used as an artifact-before-receipt publication shortcut.
  return {
    ok: true,
    command: "preview",
    lane: "gpu",
    output: result.frame,
    outputPath: result.frame.path,
    receiptId: result.receipt.id,
    receiptPath,
    receipt: result.receipt
  };
}

export function gpuPreviewSessionOptions(pkg: MotionPackage, outputDir: string, options: GpuPreviewCliOptions): GpuPreviewSessionOptions | undefined {
  const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
  if (!staticPlan.ok || staticPlan.plan.maxima.maxVideoCount === 0) return undefined;
  return {
    openVideoProvider: async ({ pkg: providerPackage }) => createGpuPreviewVideoFrameProvider({
      pkg: providerPackage,
      scratchRoot: options.scratchRoot ?? outputDir,
      runner: async (command, signal) => options.ffmpegRunner
        ? await options.ffmpegRunner(command)
        : await createGovernedFfmpegRunner({ scratchRoot: options.scratchRoot ?? outputDir, operation: "preview.gpu.decode", signal, ...(options.callerId ? { callerId: options.callerId } : {}) })(command)
    })
  };
}

/** @deprecated Historical points-only name; it now uses the general GPU preview contract. */
export const renderGpuPointsPreviewCli = renderGpuPreviewCli;
